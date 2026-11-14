import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseRollout,
  extractRecentTurns,
  readTranscriptTail,
  buildTraceBlock,
  normalizeRecord,
} from '../raw-trace.js';

const line = (obj) => JSON.stringify(obj);

test('raw-trace：三种 rollout 记录都能识别', () => {
  const text = [
    line({ timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] } }),
    line({ timestamp: 't2', type: 'event_msg', payload: { type: 'agent_message', message: '收到' } }),
    line({ timestamp: 't3', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } }),
    line({ timestamp: 't4', type: 'response_item', payload: { type: 'function_call_output', output: 'a.txt' } }),
  ].join('\n');

  const turns = parseRollout(text);
  assert.equal(turns.length, 4);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[2].role, 'tool');
  assert.equal(turns[2].tool, 'shell');
  assert.equal(turns[3].role, 'tool_result');
});

test('raw-trace：坏行跳过，不影响其它行', () => {
  const text = ['{broken', line({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'ok' } })].join('\n');
  const turns = parseRollout(text);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'ok');
});

test('raw-trace：只取尾部且丢掉被截断的首行', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trace-')), 'rollout.jsonl');
  fs.writeFileSync(file, 'first-line-aaaaaaaaaa\nsecond\nthird\n', 'utf8');
  assert.equal(await readTranscriptTail(file, { bytes: 20 }), 'second\nthird\n');
});

test('raw-trace：最近 n 轮 + 块裁剪', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `轮次 ${i}` }));
  const text = turns
    .map((t) => line({ type: 'response_item', payload: { type: 'message', role: t.role, content: t.text } }))
    .join('\n');
  const recent = extractRecentTurns(text, { n: 3 });
  assert.deepEqual(recent.map((t) => t.text), ['轮次 7', '轮次 8', '轮次 9']);

  const block = buildTraceBlock(recent, { maxChars: 60, perTurnChars: 20 });
  assert.ok(block.length <= 60, `len=${block.length}`);
});

test('raw-trace：顶层 role/content 兜底', () => {
  const t = normalizeRecord({ role: 'assistant', content: [{ text: '裸结构' }] });
  assert.equal(t.text, '裸结构');
  assert.equal(normalizeRecord({ foo: 'bar' }), null);
});
