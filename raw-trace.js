/**
 * raw-trace.js — 廉价微固化：直接读 Codex rollout JSONL 尾部，不调模型。
 *
 * 只依赖 transcript 文件本身：Codex 的 `~/.codex/sessions/**.jsonl` 里
 * 既有 response_item（message / function_call），也有 event_msg（agent_message）。
 * 解析失败的行走跳过策略 —— transcript 是宿主写的，不能因为一行坏了就整段丢。
 */
import fsp from 'node:fs/promises';
import { sha256 } from './state.js';

export async function readTranscriptTail(file, { bytes = 256 * 1024 } = {}) {
  if (!file) return '';
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const st = await fh.stat();
      const start = Math.max(0, st.size - bytes);
      const len = st.size - start;
      if (len <= 0) return '';
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      let text = buf.toString('utf8');
      if (start > 0) {
        // 丢掉被截断的首行
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      return text;
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

const textOfContent = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (typeof b === 'string') parts.push(b);
    else if (typeof b.text === 'string') parts.push(b.text);
    else if (typeof b.content === 'string') parts.push(b.content);
  }
  return parts.join('\n');
};

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\r/g, '').trim();
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

/** 把一条 rollout 记录归一化成 {ts, role, text, tool?}；认不出来就返回 null。 */
export function normalizeRecord(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const ts = obj.timestamp || obj.ts || obj.time || null;
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;
  const ptype = payload.type || obj.type;

  if (ptype === 'function_call' || ptype === 'tool_call') {
    const args = payload.arguments ?? payload.input ?? '';
    return {
      ts,
      role: 'tool',
      tool: payload.name || payload.tool || 'tool',
      text: clip(typeof args === 'string' ? args : JSON.stringify(args), 400),
    };
  }
  if (ptype === 'function_call_output' || ptype === 'tool_output') {
    return { ts, role: 'tool_result', text: clip(textOfContent(payload.output) || payload.output, 400) };
  }
  if (ptype === 'message' || ptype === 'user_message' || ptype === 'agent_message') {
    const role = payload.role || (ptype === 'user_message' ? 'user' : 'assistant');
    const text = textOfContent(payload.content) || payload.message || payload.text || '';
    if (!String(text).trim()) return null;
    return { ts, role: role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : role, text: String(text) };
  }
  // 兜底：有些版本直接把 role/content 放在顶层
  if (payload.role && (payload.content || payload.text)) {
    return {
      ts,
      role: payload.role,
      text: textOfContent(payload.content) || String(payload.text || ''),
    };
  }
  return null;
}

export function parseRollout(text) {
  const turns = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    const t = normalizeRecord(obj);
    if (t && String(t.text || '').trim()) turns.push(t);
  }
  return turns;
}

/** 最近 n 条 turn（含工具调用），保留原始顺序。 */
export function extractRecentTurns(text, { n = 6 } = {}) {
  const all = parseRollout(text);
  return all.slice(-Math.max(1, n));
}

/** 渲染成可直接 append 的 markdown 块。 */
export function buildTraceBlock(turns, { maxChars = 4000, perTurnChars = 700 } = {}) {
  if (!turns?.length) return '';
  const head = `<!--trace turns=${turns.length} at=${new Date().toISOString()} -->`;
  const body = turns
    .map((t) => {
      const tag = `${t.role}${t.tool ? `:${t.tool}` : ''}`;
      return `### ${t.ts || ''} [${tag}]\n${clip(t.text, perTurnChars)}`;
    })
    .join('\n\n');
  const out = `${head}\n${body}`;
  return out.length <= maxChars ? out : `${out.slice(0, Math.max(0, maxChars - 1))}…`;
}

export const traceHash = (text) => sha256(String(text || '')).slice(0, 12);

/**
 * SessionStart/SessionEnd 共用的读取封装。
 * hash 只覆盖「轮次内容」，不覆盖渲染时间戳 —— 否则 resume/fork 重读同一段
 * transcript 会算出不同 hash，去重就失效了。
 */
export async function readTrace({ transcriptPath, turns = 6, bytes = 262144, maxChars = 4000, perTurnChars = 700 }) {
  const tail = await readTranscriptTail(transcriptPath, { bytes });
  if (!tail) return { tail: '', turns: [], block: '', hash: null, chars: 0 };
  const recent = extractRecentTurns(tail, { n: turns });
  const block = buildTraceBlock(recent, { maxChars, perTurnChars });
  const fingerprint = recent.map((t) => `${t.role}|${t.tool || ''}|${t.text}`).join('\n');
  return {
    tail,
    turns: recent,
    block,
    hash: fingerprint ? traceHash(fingerprint) : null,
    chars: block.length,
  };
}
