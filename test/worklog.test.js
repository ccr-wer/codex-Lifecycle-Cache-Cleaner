import test from 'node:test';
import assert from 'node:assert/strict';

import { renderWorklog, parseWorklog, appendTrace, renderAnchors } from '../worklog.js';
import { assignIds, validateItems, parseModelOutput, jaccard, extractEntities } from '../state.js';

const doc = () => ({
  sessionId: 'w1',
  goal: '实现 codex 插件',
  items: [
    { id: 'L1', status: 'todo', text: '实现 adapters/ollama.js keep_alive:0' },
    { id: 'L2', status: 'done', text: '落盘到 worklogs/<sessionId>.md' },
  ],
  negations: ['[N1] 不能在线改 model_context_window'],
  rawTrace: '### t [user]\nhello',
  meta: { v: 1, revision: 3, negationCount: 1, traceHashes: ['abc123'], precompact: 2, watermarks: [] },
});

test('worklog：渲染/解析往返不丢信息', () => {
  const back = parseWorklog(renderWorklog(doc()));
  assert.deepEqual(back.parseErrors, []);
  assert.equal(back.items.length, 2);
  assert.equal(back.items[0].id, 'L1');
  assert.equal(back.items[1].status, 'done');
  assert.deepEqual(back.negations, ['[N1] 不能在线改 model_context_window']);
  assert.match(back.rawTrace, /hello/);
  assert.equal(back.meta.revision, 3);
  assert.equal(back.meta.precompact, 2);
});

test('worklog：否定信息被截断 -> E_LOG_SHRINK', () => {
  const md = renderWorklog(doc()).replace('- [N1] 不能在线改 model_context_window\n', '');
  const back = parseWorklog(md);
  assert.ok(back.parseErrors.includes('E_LOG_SHRINK:negations'), back.parseErrors.join(','));
});

test('worklog：ID 断号 -> E_ID_SEQUENCE', () => {
  const md = renderWorklog(doc()).replace('- L2 [done]', '- L5 [done]');
  const back = parseWorklog(md);
  assert.ok(back.parseErrors.some((e) => e.startsWith('E_ID_SEQUENCE')), back.parseErrors.join(','));
});

test('worklog：同一轨迹 hash 不重复 append', () => {
  const d = doc();
  const first = appendTrace(d, '### x\n内容', 'hash-1');
  const second = appendTrace(d, '### x\n内容', 'hash-1');
  assert.equal(first.appended, true);
  assert.equal(second.appended, false);
  assert.equal(d.meta.traceHashes.filter((h) => h === 'hash-1').length, 1);
  assert.equal(d.rawTrace.match(/hash-1|内容/g).length, 1);
});

test('worklog：anchors 先否定后条目，且受 maxChars 约束', () => {
  const d = doc();
  d.items.push({ id: 'L3', status: 'todo', text: 'x'.repeat(500) });
  const out = renderAnchors({
    doc: d,
    shared: { project: '用 pnpm', global: '中文回答' },
    sessionId: 'w1',
    worklogPath: '/tmp/w1.md',
    limits: { maxChars: 600 },
  });
  assert.ok(out.indexOf('## 否定信息') < out.indexOf('## 未完成条目'));
  assert.ok(out.length <= 600, `len=${out.length}`);
  assert.match(out, /不能在线改 model_context_window/);
});

test('state：模型自带 id 直接拒', () => {
  assert.throws(() => parseModelOutput(JSON.stringify([{ id: 'L1', status: 'todo', text: 'x' }])), /E_ID_FIELD_FORBIDDEN/);
});

test('state：两合一 ref_id 直接拒', () => {
  assert.throws(
    () => parseModelOutput(JSON.stringify({ ops: [{ status: 'todo', ref_id: 'L1+L2', text: 'x' }] })),
    /E_REF_MALFORMED/,
  );
});

test('state：ID 由程序分配，ref_id 命中则沿用', () => {
  const prev = [{ id: 'L4', status: 'todo', text: 'a' }];
  const out = assignIds(
    [
      { status: 'todo', ref_id: 'L4', text: 'a' },
      { status: 'todo', text: 'b' },
    ],
    prev,
  );
  assert.deepEqual(out.map((i) => i.id), ['L4', 'L5']);
});

test('state：新条目不能一出生就是 done', () => {
  assert.throws(() => assignIds([{ status: 'done', text: 'x' }], []), /E_NEW_ITEM_TERMINAL/);
});

test('state：实体 Jaccard 接地检查能拦住凭空捏造', () => {
  const prev = { items: [], goal: '' };
  const sourceText = '实现 adapters/ollama.js 的 keep_alive:0 卸载，落盘 worklogs/<sessionId>.md';
  const good = validateItems({
    prev,
    next: { items: [{ id: 'L1', status: 'todo', text: '实现 adapters/ollama.js 的 keep_alive:0 卸载' }] },
    sourceText,
  });
  const bad = validateItems({
    prev,
    next: { items: [{ id: 'L1', status: 'todo', text: '把整个项目改写成 Rust 并删除测试' }] },
    sourceText,
  });
  assert.equal(good.ok, true, good.reasons.join('|'));
  assert.ok(bad.reasons.some((r) => r.startsWith('entry_ungrounded')), bad.reasons.join('|'));
});

test('state：jaccard 边界', () => {
  assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.ok(extractEntities('adapters/ollama.js keep_alive:0').size >= 2);
});
