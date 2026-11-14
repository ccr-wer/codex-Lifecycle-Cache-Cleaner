/**
 * V4 证伪：四种对抗日志必须被拒。
 *   1) ID 重编号（模型自带 id / 文件里 ID 断号）
 *   2) 状态翻转（done -> todo）
 *   3) 两合一（L2 消失，内容并进 L1）
 *   4) 同状态改文本（偷改历史）
 *
 * 每一条都断言：模型条目没有落盘、引擎没有被清理。
 * （原始轨迹仍会追加 —— 那是宿主数据，不是模型产出。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { CodexCleaner } from '../codex-cleaner.js';
import { parseWorklog, renderWorklog } from '../worklog.js';
import { tempRoot, makePaths, writeTranscript, SAMPLE_TURNS, StubAdapter } from './helpers/fixtures.js';

const L1_TEXT = '实现 adapters/ollama.js 的 keep_alive:0 卸载';
const L2_TEXT = '落盘日志到 worklogs/<sessionId>.md';

function seedDoc(sessionId, items = null) {
  return {
    sessionId,
    goal: '实现 codex 清理插件',
    items: items || [
      { id: 'L1', status: 'todo', text: L1_TEXT },
      { id: 'L2', status: 'done', text: L2_TEXT },
    ],
    negations: ['[N1] 不能在线改 model_context_window'],
    rawTrace: '',
    meta: { v: 1, revision: 1, negationCount: 1, traceHashes: [], precompact: 0, watermarks: [] },
  };
}

async function setup(prefix, sessionId, { items = null } = {}) {
  const root = tempRoot(prefix);
  const paths = makePaths(root);
  const transcript = writeTranscript(path.join(root, 'rollout.jsonl'), SAMPLE_TURNS);
  const adapter = new StubAdapter({ root, config: { paths } });
  await adapter.writeWorklog(sessionId, renderWorklog(seedDoc(sessionId, items)));
  const cleaner = new CodexCleaner({
    adapter,
    paths,
    config: { summarize: { enabled: true, maxChars: 8000 }, cleanup: { enabled: true } },
  });
  return { root, paths, transcript, adapter, cleaner, sessionId };
}

function assertRejected(env, out, reasonFragment) {
  assert.equal(out.status, 'ok', JSON.stringify(out));
  assert.equal(out.verdict, 'rejected', JSON.stringify(out.summary));
  assert.ok(
    out.summary.reasons.some((r) => r.startsWith(reasonFragment)),
    `期望 ${reasonFragment}，实际 ${out.summary.reasons.join('|')}`,
  );
  assert.equal(env.adapter.calls.cleanup.length, 0, '被拒的对抗日志不得触发清理');
}

test('V4-a：模型自带 id（ID 重编号）-> E_ID_FIELD_FORBIDDEN', async () => {
  const env = await setup('codex-v4a-', 'v4a');
  env.adapter.summary = JSON.stringify({
    ops: [
      { id: 'L1', status: 'todo', text: L1_TEXT },
      { id: 'L2', status: 'done', text: L2_TEXT },
    ],
    negations: [],
  });

  const out = await env.cleaner.onSessionEnd({
    session_id: env.sessionId,
    transcript_path: env.transcript,
    cwd: env.root,
  });

  assertRejected(env, out, 'E_ID_FIELD_FORBIDDEN');
  const doc = parseWorklog(await env.adapter.readWorklog(env.sessionId));
  assert.deepEqual(doc.items.map((i) => i.id), ['L1', 'L2']);
  assert.deepEqual(doc.negations, ['[N1] 不能在线改 model_context_window']);
});

test('V4-a2：日志文件 ID 断号 -> log_tampered，直接中止', async () => {
  const env = await setup('codex-v4a2-', 'v4a2', {
    items: [
      { id: 'L1', status: 'todo', text: L1_TEXT },
      { id: 'L3', status: 'done', text: L2_TEXT },
    ],
  });

  const out = await env.cleaner.onSessionEnd({
    session_id: env.sessionId,
    transcript_path: env.transcript,
    cwd: env.root,
  });

  assert.equal(out.status, 'log_tampered');
  assert.ok(out.reasons.some((r) => r.startsWith('E_ID_SEQUENCE')), out.reasons.join('|'));
  assert.equal(env.adapter.calls.cleanup.length, 0);
  assert.equal(env.adapter.calls.summarize.length, 0, '日志坏掉时不该再调模型');
});

test('V4-b：状态翻转 done -> todo -> illegal_transition', async () => {
  const env = await setup('codex-v4b-', 'v4b');
  env.adapter.summary = JSON.stringify({
    ops: [
      { status: 'todo', ref_id: 'L1', text: L1_TEXT },
      { status: 'todo', ref_id: 'L2', text: L2_TEXT },
    ],
    negations: [],
  });

  const out = await env.cleaner.onSessionEnd({
    session_id: env.sessionId,
    transcript_path: env.transcript,
    cwd: env.root,
  });

  assertRejected(env, out, 'illegal_transition:L2:done->todo');
  const doc = parseWorklog(await env.adapter.readWorklog(env.sessionId));
  assert.equal(doc.items.find((i) => i.id === 'L2').status, 'done');
});

test('V4-c：两合一（L2 消失）-> entry_vanished', async () => {
  const env = await setup('codex-v4c-', 'v4c');
  env.adapter.summary = JSON.stringify({
    ops: [{ status: 'todo', ref_id: 'L1', text: `${L1_TEXT} 并且 ${L2_TEXT}` }],
    negations: [],
  });

  const out = await env.cleaner.onSessionEnd({
    session_id: env.sessionId,
    transcript_path: env.transcript,
    cwd: env.root,
  });

  assertRejected(env, out, 'entry_vanished:L2');
  const doc = parseWorklog(await env.adapter.readWorklog(env.sessionId));
  assert.equal(doc.items.length, 2);
  assert.equal(doc.items[0].text, L1_TEXT);
});

test('V4-d：同状态改文本 -> diff_not_allowed', async () => {
  const env = await setup('codex-v4d-', 'v4d');
  env.adapter.summary = JSON.stringify({
    ops: [
      { status: 'todo', ref_id: 'L1', text: '改用 llama.cpp server 的 slot erase' },
      { status: 'done', ref_id: 'L2', text: L2_TEXT },
    ],
    negations: [],
  });

  const out = await env.cleaner.onSessionEnd({
    session_id: env.sessionId,
    transcript_path: env.transcript,
    cwd: env.root,
  });

  assertRejected(env, out, 'diff_not_allowed:L1');
  const doc = parseWorklog(await env.adapter.readWorklog(env.sessionId));
  assert.equal(doc.items[0].text, L1_TEXT);
});
