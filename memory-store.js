/**
 * memory-store.js — 共享记忆的条目层：解析 / 渲染 / 消重 / 冲突 / 提案队列。
 *
 * 设计原则（与方案一致）：
 *  - 只增不删：旧值标 superseded 保留，不做物理删除；
 *  - 消重只做确定性判断：同哈希 = 重复；同键不同值 = 冲突（并存、留给人裁决）；
 *  - 解析失败就拒写，绝不拿坏文件覆盖好数据；
 *  - 提案队列（pending）必须有消费者，否则就是断头路。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const MEMORY_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  CONFLICT: 'conflict',
});

const META_RE = /<!--memory\s+([\s\S]*?)-->/;
const ENTRY_RE = /^-\s+\[(M\d+)\]\s+\[(active|superseded(?: by [^\]]+)?|conflict(?: with [^\]]+)?)\]\s+(.*)$/;

export function normalizeMemoryText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。．.!！?？;；,，]+$/u, '');
}

export function memoryHash(text) {
  return crypto.createHash('sha256').update(normalizeMemoryText(text), 'utf8').digest('hex').slice(0, 16);
}

/** 只认确定形态的键值对；匹配不到就返回 null（不做语义猜测）。 */
export function extractKey(text) {
  const s = normalizeMemoryText(text);
  const ascii = /(?:^|[\s,；;])([A-Za-z][\w.-]{0,30})\s*[:=]\s*([^\s,，；;]{1,64})/.exec(s);
  if (ascii) return { key: ascii[1].toLowerCase(), value: ascii[2] };
  const cjk = /(?:^|[\s,；;])([\u4e00-\u9fa5]{1,8})\s*[:：=]\s*([^\s,，。;；]{1,32})/.exec(s);
  if (cjk) return { key: cjk[1], value: cjk[2] };
  return null;
}

const kvOf = (text) => {
  const kv = extractKey(text);
  return kv ? { key: kv.key, value: kv.value } : { key: null, value: null };
};

export function nextMemoryId(entries) {
  let max = 0;
  for (const e of entries || []) {
    const n = Number(String(e.id || '').replace(/[^\d]/g, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `M${max + 1}`;
}

/** 容错解析：坏行进 parseErrors，不抛；旧格式（无 meta）整篇视为一条 legacy 记忆。 */
export function parseMemory(text, { scope = 'project' } = {}) {
  const raw = String(text ?? '');
  const doc = { scope, v: 1, revision: 0, entries: [], parseErrors: [], legacy: false };
  if (!raw.trim()) return doc;

  const meta = META_RE.exec(raw);
  if (meta) {
    try {
      const m = JSON.parse(meta[1]);
      doc.v = Number(m.v) || 1;
      doc.revision = Number(m.revision) || 0;
    } catch {
      doc.parseErrors.push('E_MEMORY_META');
    }
  } else {
    doc.legacy = true;
    doc.entries.push({ id: 'M1', status: MEMORY_STATUS.ACTIVE, text: raw.trim(), legacy: true, ...kvOf(raw) });
    return doc;
  }

  for (const line of raw.split('\n')) {
    const s = line.replace(/\r$/, '').trim();
    if (!s || s.startsWith('#') || s.startsWith('<!--')) continue;
    if (!s.startsWith('- ')) {
      doc.parseErrors.push(`E_MEMORY_LINE:${s.slice(0, 40)}`);
      continue;
    }
    const m = ENTRY_RE.exec(s);
    if (!m) {
      doc.parseErrors.push(`E_MEMORY_ENTRY:${s.slice(0, 40)}`);
      continue;
    }
    const body = m[3].trim();
    doc.entries.push({
      id: m[1],
      status: m[2],
      text: body,
      ...kvOf(body),
      hash: memoryHash(body),
      legacy: false,
    });
  }
  return doc;
}

export function renderMemory(entries, { scope = 'project', revision = 0 } = {}) {
  const meta = JSON.stringify({ v: 1, scope, revision, count: entries.length });
  const lines = [`<!--memory ${meta} -->`, `# Memory · ${scope}`, ''];
  for (const e of entries) {
    const text = String(e.text || '').replace(/-->/g, '—>').replace(/\s+/g, ' ').trim();
    lines.push(`- [${e.id}] [${e.status}] ${text}`);
  }
  return `${lines.join('\n')}\n`;
}

function statusOf(e) {
  return String(e.status || '').split(' ')[0];
}

/**
 * 合并：返回 {entries, added, duplicated, conflicts, candidates}。
 * incoming 可以是一段文本（按行拆）或字符串数组。
 */
export function mergeMemory(entries, incoming, { source = 'cli' } = {}) {
  const list = (Array.isArray(incoming) ? incoming : String(incoming ?? '').split(/\r?\n/))
    .map((s) => String(s).replace(/^\s*-\s*(?:\[[^\]]*\]\s*)?/, '').trim())
    .filter((s) => s && !s.startsWith('#') && !s.startsWith('<!--'));

  const out = (entries || []).map((e) => ({ ...e }));
  let added = 0;
  let duplicated = 0;
  let conflicts = 0;

  for (const text of list) {
    const hash = memoryHash(text);
    const { key, value } = kvOf(text);
    if (out.some((e) => statusOf(e) === MEMORY_STATUS.ACTIVE && memoryHash(e.text) === hash)) {
      duplicated += 1;
      continue;
    }
    const clash = key
      ? out.find((e) => statusOf(e) === MEMORY_STATUS.ACTIVE && e.key === key && e.value !== value)
      : null;
    if (clash) {
      const id = nextMemoryId(out);
      clash.status = `conflict with ${id}`;
      out.push({ id, status: `conflict with ${clash.id}`, text, key, value, hash, source });
      added += 1;
      conflicts += 1;
    } else {
      out.push({ id: nextMemoryId(out), status: MEMORY_STATUS.ACTIVE, text, key, value, hash, source });
      added += 1;
    }
  }
  return { entries: out, added, duplicated, conflicts, candidates: list.length };
}

export function markSuperseded(entries, id, byId) {
  return (entries || []).map((e) =>
    e.id === id && statusOf(e) !== MEMORY_STATUS.SUPERSEDED ? { ...e, status: `superseded by ${byId}` } : e,
  );
}

/* -------------------------------------------------------------- 提案队列 */

export const pendingDir = (paths) => path.join(paths.stateDir, 'pending');
const rejectedDir = (paths) => path.join(paths.stateDir, 'pending', 'rejected');

export async function listPending(paths) {
  const dir = pendingDir(paths);
  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const items = [];
  for (const name of names.sort()) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      items.push({ ...j, file: path.join(dir, name) });
    } catch {
      /* 坏提案文件跳过，不影响其它 */
    }
  }
  return items;
}

export async function proposePending(paths, { scope = 'project', text, reason = '', hash = null } = {}) {
  const dir = pendingDir(paths);
  await fsp.mkdir(dir, { recursive: true });
  const h = hash || memoryHash(text);
  const existing = await listPending(paths);
  if (existing.some((e) => e.hash === h)) return { duplicated: true, hash: h, path: null };
  const at = new Date().toISOString();
  const id = `P${Date.now().toString(36)}${h.slice(0, 4)}`;
  const file = path.join(dir, `${id}-${h.slice(0, 8)}.json`);
  const body = JSON.stringify({ id, scope, text: String(text), reason, hash: h, createdAt: at }, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, file);
  return { duplicated: false, id, hash: h, path: file };
}

export async function findPending(paths, id) {
  const items = await listPending(paths);
  return items.find((e) => e.id === id || e.file.endsWith(`${id}.json`)) || null;
}

export async function removePending(paths, item, { rejected = false, reason = '' } = {}) {
  if (!item?.file) return false;
  if (!rejected) {
    await fsp.unlink(item.file).catch(() => {});
    return true;
  }
  await fsp.mkdir(rejectedDir(paths), { recursive: true });
  const dest = path.join(rejectedDir(paths), path.basename(item.file));
  await fsp.rename(item.file, dest).catch(async () => {
    await fsp.unlink(item.file).catch(() => {});
  });
  if (reason) {
    await fsp.writeFile(`${dest}.reason.txt`, String(reason), 'utf8').catch(() => {});
  }
  return true;
}
