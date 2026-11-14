/**
 * state.js — 程序侧硬状态。
 *
 * 四件事，全部是「数据结构校验」，不是软检查：
 *  1) ID 由程序分配（模型给 {status, text, ref_id?}，给 id 直接拒）。
 *  2) 状态迁移白名单（done 不可回退 todo，dropped 只进不出）。
 *  3) 差分白名单（同状态改文本 = 偷改历史，拒）。
 *  4) 实体 Jaccard：条目与原始轨迹的接地检查（≥ 0.6）。
 *
 * 另外提供：原子写、文件锁（并发 SessionEnd）、journal（崩溃恢复）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATUS = Object.freeze({
  TODO: 'todo',
  DONE: 'done',
  DECISION: 'decision',
  DROPPED: 'dropped',
});
export const STATUS_VALUES = new Set(Object.values(STATUS));

/** 状态迁移白名单。新增状态必须同时改这里，否则一律拒。 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  todo: Object.freeze(['todo', 'done', 'dropped']),
  done: Object.freeze(['done', 'dropped']),
  decision: Object.freeze(['decision', 'dropped']),
  dropped: Object.freeze(['dropped']),
});

export const DEFAULT_LIMITS = Object.freeze({
  entityJaccardMin: 0.6, // 整篇日志实体不得塌缩
  entryJaccardMin: 0.5, // 状态推进时措辞不得整体重写
  groundingJaccardMin: 0.6, // 新条目必须能从原始轨迹里找到实体依据
  droppedRatioLimit: 0.3, // 一轮批量 drop 上限
  maxItems: 200,
});

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const numOf = (id) => Number(String(id).replace(/[^\d]/g, '')) || 0;
export const negNumOf = (line) => {
  const m = /^\s*\[N(\d+)\]/.exec(String(line ?? ''));
  return m ? Number(m[1]) : 0;
};

export class MemoryError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'MemoryError';
    this.code = code;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ 路径 */

export function defaultPaths({ home = process.env.HOME || process.env.USERPROFILE, cwd = process.cwd() } = {}) {
  const root = home || cwd;
  const base = path.join(root, '.codex', 'memory');
  return {
    base,
    worklogDir: path.join(base, 'worklogs'),
    stateDir: path.join(base, 'state'),
    spillDir: path.join(base, 'spill'),
    globalMemoryFile: path.join(base, 'global.md'),
    cwd,
  };
}

export const projectMemoryFile = (cwd) => path.join(cwd || process.cwd(), '.codex', 'memory', 'project.md');

/** Codex 的 session_id 可能被 resume/fork 复用或派生，这里只做文件系统安全化，不做唯一性假设。 */
export function normalizeSessionId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.includes('..') || s.includes('/') || s.includes('\\')) return `s_${sha256(s).slice(0, 16)}`;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(s)) return s;
  return `s_${sha256(s).slice(0, 16)}`;
}

/* ------------------------------------------------------------------ 模型输出 */

/**
 * 解析模型产出。接受两种形状：
 *   [{status,text,ref_id?}, ...]                        （DSH 兼容）
 *   {ops:[...], negations:["...", ...]}
 * 模型只要带了 id/ids 字段 -> 直接拒（ID 由程序分配）。
 */
export function parseModelOutput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new MemoryError('E_SUMMARY_EMPTY', 'summary is empty');
  }
  let body = raw.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();

  let parsed;
  const objStart = body.indexOf('{');
  const arrStart = body.indexOf('[');
  const useObj = objStart >= 0 && (arrStart < 0 || objStart < arrStart);
  if (useObj) {
    const end = body.lastIndexOf('}');
    if (end <= objStart) throw new MemoryError('E_SUMMARY_UNPARSEABLE', 'no JSON object');
    try {
      parsed = JSON.parse(body.slice(objStart, end + 1));
    } catch (e) {
      throw new MemoryError('E_SUMMARY_UNPARSEABLE', e.message);
    }
  } else {
    const end = body.lastIndexOf(']');
    if (arrStart < 0 || end <= arrStart) throw new MemoryError('E_SUMMARY_UNPARSEABLE', 'no JSON array');
    try {
      parsed = JSON.parse(body.slice(arrStart, end + 1));
    } catch (e) {
      throw new MemoryError('E_SUMMARY_UNPARSEABLE', e.message);
    }
  }

  const opsRaw = Array.isArray(parsed) ? parsed : parsed.ops ?? parsed.items ?? parsed.entries;
  const negRaw = Array.isArray(parsed) ? [] : parsed.negations ?? [];
  if (!Array.isArray(opsRaw)) throw new MemoryError('E_SUMMARY_UNPARSEABLE', 'ops 必须是数组');
  if (opsRaw.length > DEFAULT_LIMITS.maxItems * 4) throw new MemoryError('E_TOO_MANY_OPS', `ops=${opsRaw.length}`);

  const ops = opsRaw.map((raw0, i) => {
    if (!raw0 || typeof raw0 !== 'object' || Array.isArray(raw0)) {
      throw new MemoryError('E_OP_NOT_OBJECT', `entry #${i}`);
    }
    if ('id' in raw0 || 'ids' in raw0 || 'entry_id' in raw0) {
      throw new MemoryError('E_ID_FIELD_FORBIDDEN', `entry #${i} 自带 id，ID 由程序分配`);
    }
    const status = String(raw0.status ?? '').trim().toLowerCase();
    if (!STATUS_VALUES.has(status)) {
      throw new MemoryError('E_BAD_STATUS', `entry #${i} status=${raw0.status}`);
    }
    const text = norm(raw0.text);
    if (!text) throw new MemoryError('E_EMPTY_TEXT', `entry #${i}`);

    const op = { status, text };
    if (raw0.ref_id !== undefined && raw0.ref_id !== null && raw0.ref_id !== '') {
      const ref = raw0.ref_id;
      if (typeof ref !== 'string') {
        throw new MemoryError('E_REF_MALFORMED', `entry #${i} ref_id 必须是单个字符串`);
      }
      if (!/^L[1-9]\d*$/.test(ref.trim())) {
        // 覆盖 "L1+L2" / "L1,L2" / "L1 L2" 这类两合一写法
        throw new MemoryError('E_REF_MALFORMED', `entry #${i} ref_id=${ref}`);
      }
      op.ref_id = ref.trim();
    }
    return op;
  });

  const negations = (Array.isArray(negRaw) ? negRaw : []).map((n, i) => {
    if (typeof n !== 'string') throw new MemoryError('E_BAD_NEGATION', `negation #${i}`);
    const t = norm(n);
    if (!t) throw new MemoryError('E_BAD_NEGATION', `negation #${i} 为空`);
    if (t.length > 500) throw new MemoryError('E_BAD_NEGATION', `negation #${i} 超长`);
    return t;
  });

  if (!ops.length && !negations.length) throw new MemoryError('E_SUMMARY_EMPTY', '没有可固化条目');
  return { ops, negations };
}

/**
 * 程序分配 ID。ref_id 命中旧条目 -> 沿用；否则发新号。
 * 新条目不允许一出生就是终态（done/dropped）。
 */
export function assignIds(ops, prevItems = []) {
  const known = new Map(prevItems.map((e) => [e.id, e]));
  let max = prevItems.reduce((m, e) => Math.max(m, numOf(e.id)), 0);
  const used = new Set();

  return ops.map((op, i) => {
    if (op.ref_id) {
      if (!known.has(op.ref_id)) {
        throw new MemoryError('E_REF_UNKNOWN', `entry #${i} ref_id=${op.ref_id} 不存在`);
      }
      if (used.has(op.ref_id)) {
        throw new MemoryError('E_DUP_REF', `entry #${i} ref_id=${op.ref_id} 重复引用`);
      }
      used.add(op.ref_id);
      return { id: op.ref_id, status: op.status, text: norm(op.text) || norm(known.get(op.ref_id).text) };
    }
    if (op.status === STATUS.DONE || op.status === STATUS.DROPPED) {
      throw new MemoryError('E_NEW_ITEM_TERMINAL', `entry #${i} 新条目不能直接 ${op.status}`);
    }
    max += 1;
    return { id: `L${max}`, status: op.status, text: norm(op.text) };
  });
}

export function assertIdSequence(items = []) {
  const errors = [];
  const seen = new Set();
  items.forEach((it, i) => {
    const m = /^L([1-9]\d*)$/.exec(String(it?.id));
    if (!m) errors.push(`E_ID_FORMAT:${it?.id}`);
    else if (Number(m[1]) !== i + 1) errors.push(`E_ID_SEQUENCE:${it.id}@${i + 1}`);
    if (seen.has(it?.id)) errors.push(`E_ID_DUP:${it?.id}`);
    seen.add(it?.id);
  });
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ 实体 / Jaccard */

const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'not', 'are', 'was', 'but', 'from', 'you', 'can',
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '对', '从',
  '被', '把', '让', '使', '等', '一个', '我们', '你', '我', '它', '这', '那', '有',
  '不', '要', '会', '可以', '需要', '然后', '因为', '所以', '但是', '如果', '已经',
]);

/** 实体集合：拉丁标识/路径、数字、CJK 片段。用于抓「措辞保留、事实被删」。 */
export function extractEntities(text) {
  const out = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_./-]{2,}/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w)) out.add(w);
  }
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) out.add(m[0]);
  for (const m of s.matchAll(/[\u4e00-\u9fff]{2,6}/g)) {
    if (!STOP.has(m[0])) out.add(m[0]);
  }
  return out;
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a || []);
  const B = b instanceof Set ? b : new Set(b || []);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const docEntities = (doc) =>
  extractEntities([doc?.goal, ...(doc?.items || []).map((e) => e.text), ...(doc?.negations || [])].join('\n'));

/* ------------------------------------------------------------------ L5 校验 */

/**
 * @returns {{ok:boolean, reasons:string[], grounded:boolean}}
 */
export function validateItems({ prev, next, sourceText = '', sourceTurns = null, limits = {} }) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const reasons = [];
  const prevItems = prev?.items || [];
  const nextItems = next?.items || [];
  const prevMap = new Map(prevItems.map((e) => [e.id, e]));
  const nextMap = new Map(nextItems.map((e) => [e.id, e]));

  // 0) ID 必须是 L1..Ln 连续（重编号攻击在这里被拦）
  const seq = assertIdSequence(nextItems);
  if (!seq.ok) reasons.push(...seq.errors);

  // 1) 条目不得消失（两合一攻击在这里被拦）
  for (const p of prevItems) if (!nextMap.has(p.id)) reasons.push(`entry_vanished:${p.id}`);

  // 2) 状态迁移白名单 + 差分白名单
  for (const [id, p] of prevMap) {
    const n = nextMap.get(id);
    if (!n) continue;
    if (n.status !== p.status) {
      const allowed = ALLOWED_TRANSITIONS[p.status] || [];
      if (!allowed.includes(n.status)) {
        reasons.push(`illegal_transition:${id}:${p.status}->${n.status}`);
      } else if (jaccard(extractEntities(p.text), extractEntities(n.text)) < L.entryJaccardMin) {
        reasons.push(`entry_rewritten:${id}`);
      }
    } else if (norm(p.text) !== norm(n.text)) {
      // 同状态改文本 = 偷改历史
      reasons.push(`diff_not_allowed:${id}`);
    }
    if (p.status !== STATUS.DROPPED && n.status === STATUS.DROPPED && !/reason\s*[:：]/i.test(n.text)) {
      reasons.push(`dropped_without_reason:${id}`);
    }
  }

  // 3) 新条目必须接地：与「最匹配的一轮原文」的实体 Jaccard ≥ 0.6
  const turns = (Array.isArray(sourceTurns) && sourceTurns.length
    ? sourceTurns
    : sourceText
      ? [sourceText]
      : []
  )
    .map((t) => String(t || ''))
    .filter((t) => t.trim());
  const grounded = turns.length > 0;
  if (grounded) {
    const turnEntities = turns.map((t) => extractEntities(t));
    for (const n of nextItems) {
      if (prevMap.has(n.id)) continue;
      const ent = extractEntities(n.text);
      let best = 0;
      for (const te of turnEntities) best = Math.max(best, jaccard(ent, te));
      if (best < L.groundingJaccardMin) reasons.push(`entry_ungrounded:${n.id}:${best.toFixed(2)}`);
    }
  }

  // 4) 整篇实体塌缩 + 批量 drop
  if (prevItems.length) {
    if (jaccard(docEntities(prev), docEntities(next)) < L.entityJaccardMin) reasons.push('entity_collapse');
    let newlyDropped = 0;
    for (const p of prevItems) {
      const n = nextMap.get(p.id);
      if (n && p.status !== STATUS.DROPPED && n.status === STATUS.DROPPED) newlyDropped += 1;
    }
    if (newlyDropped / prevItems.length > L.droppedRatioLimit) reasons.push('negation_collapse');
  }

  if (nextItems.length > L.maxItems) reasons.push('too_many_items');

  return { ok: reasons.length === 0, reasons, grounded };
}

/** 否定信息：程序只追加。模型提供的 negation 也只能追加。 */
export function mergeNegations({ prevNegations = [], prevItems = [], nextItems = [], modelNegations = [] } = {}) {
  const out = [...prevNegations];
  let k = out.reduce((m, n) => Math.max(m, negNumOf(n)), 0);
  const seen = new Set(out.map((x) => norm(x)));
  const prevMap = new Map(prevItems.map((e) => [e.id, e]));

  for (const n of modelNegations) {
    const line = `[N${k + 1}] ${norm(n)}`;
    if (seen.has(norm(line))) continue;
    k += 1;
    seen.add(norm(line));
    out.push(line);
  }
  for (const it of nextItems) {
    const p = prevMap.get(it.id);
    if (!p || p.status === STATUS.DROPPED || it.status !== STATUS.DROPPED) continue;
    const line = `[N${k + 1}] ${it.id}: ${it.text}`;
    k += 1;
    out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ 原子文件 */

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const shortHash = (text) => sha256(text).slice(0, 12);

export async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readJsonSync(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** tmp -> fsync -> rename。中途崩了最多丢 tmp，不会留半个正式文件。 */
export async function writeTextAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
  return { bytes: Buffer.byteLength(text), sha: sha256(text) };
}

export async function writeJsonAtomic(file, obj) {
  return writeTextAtomic(file, JSON.stringify(obj, null, 2));
}

/* ------------------------------------------------------------------ 并发锁 */

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 文件锁：O_EXCL 创建，天然原子。
 * 持有者进程死了或超过 TTL 视为 stale，可抢占一次。
 */
export class FileLock {
  constructor(file, token) {
    this.file = file;
    this.token = token;
    this.released = false;
  }

  static async acquire(file, { ttlMs = 120000, now = Date.now() } = {}) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const token = `${process.pid}-${now}-${crypto.randomBytes(4).toString('hex')}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fh = await fsp.open(file, 'wx');
        try {
          await fh.writeFile(JSON.stringify({ pid: process.pid, token, at: now }), 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
        return new FileLock(file, token);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const holder = await readJson(file, null);
        const stale = !holder || now - Number(holder.at || 0) > ttlMs || !isPidAlive(holder.pid);
        if (!stale) return null;
        await fsp.unlink(file).catch(() => {});
      }
    }
    return null;
  }

  async release() {
    if (this.released) return;
    this.released = true;
    const holder = await readJson(this.file, null);
    if (holder && holder.token !== this.token) return;
    await fsp.unlink(this.file).catch(() => {});
  }
}

/* ------------------------------------------------------------------ journal */

export const JOURNAL_STEPS = Object.freeze(['consolidate', 'summarize', 'stage', 'cleanup', 'commit']);

/**
 * 崩溃恢复用 journal：每一步都落盘。
 * status: idle | in_progress | done | cleanup_failed | rejected | log_tampered | error
 */
export class Journal {
  constructor(file) {
    this.file = file;
    this.data = null;
  }

  async load() {
    this.data = (await readJson(this.file, null)) || {
      session_id: null,
      transcript_path: null,
      transcript_sha: null,
      attempt: 0,
      status: 'idle',
      steps: {},
      errors: [],
      created_at: new Date().toISOString(),
      updated_at: null,
    };
    return this.data;
  }

  get status() {
    return this.data?.status ?? 'idle';
  }

  step(name) {
    return this.data?.steps?.[name] ?? null;
  }

  async save() {
    this.data.updated_at = new Date().toISOString();
    await writeJsonAtomic(this.file, this.data);
  }

  /** 续跑时不清空 steps：stage 之后崩了要能直接复用暂存稿。 */
  async begin({ sessionId, transcriptPath, transcriptSha }) {
    this.data.session_id = sessionId;
    this.data.transcript_path = transcriptPath ?? null;
    this.data.transcript_sha = transcriptSha ?? null;
    this.data.attempt = Number(this.data.attempt || 0) + 1;
    this.data.status = 'in_progress';
    this.data.last_error = null;
    await this.save();
  }

  async mark(name, data = {}) {
    this.data.steps = this.data.steps || {};
    this.data.steps[name] = { at: new Date().toISOString(), ...data };
    await this.save();
  }

  async fail(status, error, extra = {}) {
    this.data.status = status;
    this.data.last_error = typeof error === 'string' ? error : String(error?.message ?? error);
    this.data.errors = [...(this.data.errors || []), this.data.last_error].slice(-20);
    Object.assign(this.data, extra);
    await this.save();
  }

  async finish(extra = {}) {
    this.data.status = 'done';
    this.data.finished_at = new Date().toISOString();
    Object.assign(this.data, extra);
    await this.save();
  }
}
