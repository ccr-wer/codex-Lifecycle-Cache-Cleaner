/**
 * worklog.js — 工作日志的解析 / 渲染 / 锚点注入。
 *
 * 格式固定四段（顺序不可变，parser 依赖这个顺序）：
 *   # Worklog · <session_id>
 *   ## goal
 *   ## entries      - L1 [todo] ...
 *   ## negations    - [N1] ...
 *   ## 原始轨迹     （廉价微固化直接 append，不调模型）
 *
 * 顶部 <!--meta {...} --> 存 revision / negationCount / traceHashes。
 * negationCount 是防截断水位：文件里否定行少于它 -> E_LOG_SHRINK。
 */
import { STATUS_VALUES, negNumOf, assertIdSequence, MemoryError } from './state.js';

export const WORKLOG_SCHEMA = 1;

export function emptyWorklog(sessionId = '') {
  return {
    sessionId,
    goal: '',
    items: [],
    negations: [],
    rawTrace: '',
    meta: {
      v: WORKLOG_SCHEMA,
      sessionId,
      revision: 0,
      negationCount: 0,
      traceHashes: [],
      precompact: 0,
      watermarks: [],
      forkedFrom: null,
      updatedAt: null,
    },
    parseErrors: [],
  };
}

const META_RE = /<!--meta\s+(\{[\s\S]*?\})\s*-->/;
const ENTRY_RE = /^([A-Za-z]*\d+)\s+\[(\w+)\]\s*([\s\S]*)$/;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

export function renderWorklog(doc) {
  const meta = {
    v: WORKLOG_SCHEMA,
    sessionId: doc.sessionId || doc.meta?.sessionId || '',
    revision: Number(doc.meta?.revision || 0),
    negationCount: doc.negations.length,
    traceHashes: doc.meta?.traceHashes || [],
    precompact: Number(doc.meta?.precompact || 0),
    watermarks: doc.meta?.watermarks || [],
    forkedFrom: doc.meta?.forkedFrom || null,
    updatedAt: new Date().toISOString(),
  };
  const lines = [
    `<!--meta ${JSON.stringify(meta)} -->`,
    `# Worklog · ${doc.sessionId || '(unknown)'}`,
    '',
    '## goal',
    doc.goal?.trim() ? doc.goal.trim() : '-',
    '',
    '## entries',
  ];
  if (!doc.items.length) lines.push('- (none)');
  else for (const it of doc.items) lines.push(`- ${it.id} [${it.status}] ${it.text}`);

  lines.push('', '## negations');
  if (!doc.negations.length) lines.push('- (none)');
  else for (const n of doc.negations) lines.push(`- ${n}`);

  lines.push('', '## 原始轨迹');
  if (doc.rawTrace?.trim()) lines.push(doc.rawTrace.replace(/\s+$/, ''));

  return `${lines.join('\n')}\n`;
}

export function parseWorklog(md) {
  const doc = emptyWorklog('');
  if (!md || !md.trim()) return doc;

  const metaMatch = META_RE.exec(md);
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]);
      doc.meta = { ...doc.meta, ...meta };
      doc.sessionId = meta.sessionId || doc.sessionId;
    } catch {
      doc.parseErrors.push('E_META_UNPARSEABLE');
    }
  } else {
    doc.parseErrors.push('E_META_MISSING');
  }

  const title = /^#\s+Worklog\s+·\s*(.+)$/m.exec(md);
  if (!doc.sessionId && title) doc.sessionId = title[1].trim();

  const sections = {};
  let current = null;
  for (const line of md.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1].trim();
      if (!(current in sections)) sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }

  const goalLines = (sections.goal || []).map((l) => l.replace(/^-\s*/, '')).filter(Boolean);
  doc.goal = goalLines.join(' ').trim();

  for (const rawLine of sections.entries || []) {
    if (!rawLine.startsWith('- ')) continue;
    const body = rawLine.slice(2).trim();
    if (!body || body === '(none)') continue;
    const m = ENTRY_RE.exec(body);
    if (!m) {
      doc.parseErrors.push(`E_ENTRY_UNPARSEABLE:${clip(body, 40)}`);
      continue;
    }
    const status = m[2].toLowerCase();
    if (!STATUS_VALUES.has(status)) doc.parseErrors.push(`E_BAD_STATUS:${m[1]}:${status}`);
    doc.items.push({ id: m[1], status, text: norm(m[3]) });
  }

  for (const rawLine of sections.negations || []) {
    if (!rawLine.startsWith('- ')) continue;
    const body = rawLine.slice(2).trim();
    if (!body || body === '(none)') continue;
    doc.negations.push(body);
  }

  doc.rawTrace = (sections['原始轨迹'] || []).join('\n').replace(/\s+$/, '');

  // 结构性校验：ID 连续 + 否定信息不缩水
  const seq = assertIdSequence(doc.items);
  if (!seq.ok) doc.parseErrors.push(...seq.errors);
  if (Number.isFinite(doc.meta.negationCount) && doc.negations.length < Number(doc.meta.negationCount)) {
    doc.parseErrors.push('E_LOG_SHRINK:negations');
  }
  const dupNeg = new Set();
  for (const n of doc.negations) {
    const id = negNumOf(n);
    if (dupNeg.has(id)) doc.parseErrors.push(`E_NEG_DUP:N${id}`);
    dupNeg.add(id);
  }

  return doc;
}

/** 追加轨迹块；同一 hash 只追加一次（resume/fork 会重复读到同一段 transcript）。 */
export function appendTrace(doc, block, hash, { maxHashes = 60 } = {}) {
  if (!block || !block.trim()) return { appended: false, reason: 'empty' };
  const hashes = doc.meta.traceHashes || [];
  if (hash && hashes.includes(hash)) return { appended: false, reason: 'duplicate', hash };
  doc.rawTrace = [doc.rawTrace?.trimEnd(), block.trim()].filter(Boolean).join('\n\n');
  doc.meta.traceHashes = [...hashes, hash].filter(Boolean).slice(-maxHashes);
  return { appended: true, hash };
}

/**
 * SessionStart 注入体。顺序即优先级：否定信息在最前，注入被截断时先牺牲轨迹摘要。
 */
export function renderAnchors({
  doc,
  parentDoc = null,
  parentId = null,
  shared = {},
  source = 'startup',
  sessionId = '',
  worklogPath = '',
  limits = {},
}) {
  const L = { maxChars: 4000, negations: 12, openItems: 25, doneItems: 5, sharedChars: 800, ...limits };
  const lines = [];
  lines.push(`[codex-memory] session=${sessionId} source=${source}${parentId ? ` parent=${parentId}` : ''}`);
  if (parentId) lines.push(`本会话由 fork/resume 派生，以下锚点包含父会话 ${parentId} 的未完成项。`);

  const negs = (doc.negations || []).slice(-L.negations);
  const parentNegs = parentDoc ? (parentDoc.negations || []).slice(-L.negations) : [];
  const allNegs = [...new Set([...parentNegs, ...negs])];
  if (allNegs.length) {
    lines.push('', '## 否定信息（程序只追加，禁止改写/删除）');
    for (const n of allNegs) lines.push(`- ${n}`);
  }

  const pickItems = (d) => (d?.items || []).filter((i) => i.status === 'todo' || i.status === 'decision');
  const open = [...new Map([...pickItems(parentDoc), ...pickItems(doc)].map((i) => [i.id, i])).values()];
  if (open.length) {
    lines.push('', `## 未完成条目（${open.length}）`);
    for (const it of open.slice(0, L.openItems)) lines.push(`- ${it.id} [${it.status}] ${clip(it.text, 400)}`);
  }

  const done = (doc.items || []).filter((i) => i.status === 'done').slice(-L.doneItems);
  if (done.length) {
    lines.push('', '## 最近完成');
    for (const it of done) lines.push(`- ${it.id} ${clip(it.text, 200)}`);
  }

  if (doc.meta?.precompact) {
    const w = (doc.meta.watermarks || []).slice(-1)[0];
    lines.push('', `## 压缩水位 W${doc.meta.precompact}${w?.at ? ` @ ${w.at}` : ''}（PreCompact 只留锚点，不阻止压缩）`);
  }

  for (const [scope, label] of [['project', '项目习惯'], ['global', '用户偏好']]) {
    const text = (shared?.[scope] || '').trim();
    if (!text) continue;
    lines.push('', `## 共享记忆 · ${label}`);
    lines.push(clip(text, L.sharedChars));
  }

  lines.push('', `日志：${worklogPath || '(未落盘)'}`);
  lines.push('续做前先读该文件；negations 段只读。');

  let out = lines.join('\n');
  if (out.length > L.maxChars) out = `${out.slice(0, L.maxChars - 32)}\n…[anchors truncated]`;
  return out;
}

/** 构造总结 prompt：模型只被允许产出 {status,text,ref_id?} 与 negations。 */
export function buildSummaryPrompt(prev, traceBlock, { maxItems = 60 } = {}) {
  const prevText = prev?.items?.length
    ? prev.items.map((i) => `- ${i.id} [${i.status}] ${i.text}`).join('\n')
    : '- (空，这是第一次固化)';
  const negText = prev?.negations?.length ? prev.negations.map((n) => `- ${n}`).join('\n') : '- (none)';

  return [
    '你是会话状态转录器，不是润色器。把当前工作状态转录成 JSON。',
    '',
    '输出形状（只允许这个形状）：',
    '{"ops":[{"status":"todo|done|decision|dropped","text":"...","ref_id":"可选，指向上一条 L 号"}],"negations":["新增的否定信息"]}',
    '',
    '硬规则：',
    '1. 不要输出 id 字段，ID 由程序分配；要继续某条旧条目，用 ref_id 指回它。',
    '2. 上面每一条旧条目都必须出现一次，除非标成 dropped 并在 text 里写 "reason: ..."。',
    '3. status 只能前进：todo->done/dropped，done->dropped，decision->dropped。禁止回退，禁止新条目一出生就是 done。',
    '4. 状态不变的条目，text 必须与旧版逐字一致。',
    '5. 否定/否决信息不得合并、改写或省略。',
    '6. 只输出 JSON，不要解释、不要 markdown 围栏。',
    `7. 条目总数不超过 ${maxItems}；每条 text 控制在 300 字以内。`,
    '',
    '=== 上一版工作日志 ===',
    prevText,
    '',
    '=== 上一版否定信息 ===',
    negText,
    '',
    '=== 最近原始轨迹（只用于提取事实，不要复述）===',
    traceBlock || '(无)',
  ].join('\n');
}

export function traceSection(md) {
  return parseWorklog(md).rawTrace;
}

export function ensureWorklogDoc(doc) {
  if (!doc || !Array.isArray(doc.items)) throw new MemoryError('E_BAD_DOC', 'worklog doc 结构不对');
  return doc;
}
