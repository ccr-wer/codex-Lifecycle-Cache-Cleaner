import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { CodexCleaner } from '../codex-cleaner.js';
import { parseWorklog } from '../worklog.js';
import { tempRoot, makePaths, writeTranscript, SAMPLE_TURNS, GROUNDED_SUMMARY, StubAdapter } from './helpers/fixtures.js';

test('V1：总结超长 -> 不清理引擎、不落条目，只落原始轨迹', async () => {
  const root = tempRoot('codex-v1-');
  const paths = makePaths(root);
  const transcript = writeTranscript(path.join(root, 'rollout.jsonl'), SAMPLE_TURNS);

  const longSummary = JSON.stringify({ ops: [{ status: 'todo', text: 'x'.repeat(9000) }], negations: [] });
  const adapter = new StubAdapter({ root, config: { paths }, summary: longSummary });
  const cleaner = new CodexCleaner({
    adapter,
    paths,
    config: { summarize: { enabled: true, maxTokens: 100, maxChars: 4000 }, cleanup: { enabled: true } },
  });

  const out = await cleaner.onSessionEnd({ session_id: 'v1', transcript_path: transcript, cwd: root });

  assert.equal(out.status, 'ok');
  assert.equal(out.verdict, 'rejected');
  assert.deepEqual(out.summary.reasons, ['E_SUMMARY_TOO_LONG']);
  assert.equal(adapter.calls.cleanup.length, 0, '超长摘要不得触发引擎清理');
  assert.equal(out.engine.skipped, true);

  const log = await adapter.readWorklog('v1');
  assert.match(log, /## 原始轨迹/);
  assert.ok(!log.includes('xxxxxxxxxx'), '摘要内容不得落盘');
  assert.equal(parseWorklog(log).items.length, 0);
});

test('V1b：长度合规且接地的摘要 -> 正常固化并清理', async () => {
  const root = tempRoot('codex-v1b-');
  const paths = makePaths(root);
  const transcript = writeTranscript(path.join(root, 'rollout.jsonl'), SAMPLE_TURNS);

  const adapter = new StubAdapter({ root, config: { paths }, summary: GROUNDED_SUMMARY });
  const cleaner = new CodexCleaner({
    adapter,
    paths,
    config: { summarize: { enabled: true, maxChars: 4000 }, cleanup: { enabled: true } },
  });

  const out = await cleaner.onSessionEnd({ session_id: 'v1b', transcript_path: transcript, cwd: root });

  assert.equal(out.status, 'ok', JSON.stringify(out));
  assert.equal(out.verdict, 'ok');
  assert.equal(adapter.calls.cleanup.length, 1);
  assert.equal(out.engine.result.code, 'STUB_OK');

  const doc = parseWorklog(await adapter.readWorklog('v1b'));
  assert.equal(doc.parseErrors.length, 0, doc.parseErrors.join(','));
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].id, 'L1');
  assert.equal(doc.items[0].status, 'todo');
  assert.ok(doc.negations.some((n) => n.startsWith('[N1]')), doc.negations.join('|'));
});
