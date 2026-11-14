/**
 * V3 证伪：清理 API 失败 -> 不提交半成品日志。
 *
 * 事务顺序是「暂存 -> 清理 -> 提交」，清理失败时暂存稿留在 state/staging/ 等续跑，
 * 正式日志（worklogs/<sid>.md）一个字节都不写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CodexCleaner } from '../codex-cleaner.js';
import { readJson, readText } from '../state.js';
import { parseWorklog } from '../worklog.js';
import { tempRoot, makePaths, writeTranscript, SAMPLE_TURNS, StubAdapter } from './helpers/fixtures.js';

test('V3：Ollama API 调用失败 -> 不提交日志，恢复后能续跑', async () => {
  const root = tempRoot('codex-v3-');
  const paths = makePaths(root);
  const transcript = writeTranscript(path.join(root, 'rollout.jsonl'), SAMPLE_TURNS);

  let mode = 'fail';
  const adapter = new StubAdapter({
    root,
    config: { paths },
    cleanup: async () => {
      if (mode === 'fail') {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:11434');
        err.code = 'E_CLEANUP_HTTP';
        throw err;
      }
      return { ok: true, code: 'STUB_OK', provider: 'stub' };
    },
  });

  const cleaner = new CodexCleaner({
    adapter,
    paths,
    config: { summarize: { enabled: false }, cleanup: { enabled: true } },
  });

  const first = await cleaner.onSessionEnd({ session_id: 'v3', transcript_path: transcript, cwd: root });

  assert.equal(first.status, 'cleanup_failed');
  assert.equal(first.engine.code, 'E_CLEANUP_HTTP');
  assert.equal(await adapter.readWorklog('v3'), '', '正式日志不得出现');

  const journalFile = path.join(paths.stateDir, 'journal', 'v3.json');
  const journal = await readJson(journalFile, null);
  assert.ok(journal, 'journal 必须落盘');
  assert.equal(journal.status, 'cleanup_failed');
  assert.ok(journal.steps?.stage?.sha, '暂存稿 sha 必须记录');

  const stagedPath = path.join(paths.stateDir, 'staging', 'v3.md');
  assert.ok(fs.existsSync(stagedPath), '暂存稿必须保留以便续跑');
  assert.ok((await readText(stagedPath)).length > 0);

  // 引擎恢复后重试：续跑暂存稿，不重复固化
  mode = 'ok';
  const second = await cleaner.onSessionEnd({ session_id: 'v3', transcript_path: transcript, cwd: root });

  assert.equal(second.status, 'ok', JSON.stringify(second));
  assert.equal(second.resumed, true);
  assert.equal(second.verdict, 'resumed');
  assert.equal(adapter.calls.cleanup.length, 2);

  const doc = parseWorklog(await adapter.readWorklog('v3'));
  assert.equal(doc.parseErrors.length, 0, doc.parseErrors.join(','));
  assert.match(doc.rawTrace, /\[user\]/);
  // 原始轨迹不能因为续跑被追加两遍
  assert.equal(doc.meta.traceHashes.length, 1);
});
