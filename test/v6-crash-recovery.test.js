/**
 * V6 证伪：SessionEnd 在 stage 之后崩溃 -> 重启能续跑，且不重复固化。
 *
 * 崩溃点用 config.faults=['stage'] 注入（需 CODEX_MEMORY_ALLOW_FAULT=1），
 * 模拟的是「暂存稿已落盘、清理还没跑、进程被杀」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CodexCleaner } from '../codex-cleaner.js';
import { readJson } from '../state.js';
import { parseWorklog } from '../worklog.js';
import {
  tempRoot,
  makePaths,
  writeTranscript,
  SAMPLE_TURNS,
  GROUNDED_SUMMARY,
  StubAdapter,
} from './helpers/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'helpers', 'child-session-end.mjs');
const NODE = process.execPath;

function crashRun(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CHILD], {
      env: { ...process.env, MEM_CFG: JSON.stringify(env), CODEX_MEMORY_ALLOW_FAULT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`崩溃子进程超时: ${stderr.slice(0, 500)}`));
    }, 30000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test('V6：stage 后崩溃 -> 重启续跑，条目只落一次', async () => {
  const root = tempRoot('codex-v6-');
  const paths = makePaths(root);
  const transcript = writeTranscript(path.join(root, 'rollout.jsonl'), SAMPLE_TURNS);
  const countFile = path.join(root, 'cleanup-count.txt');

  const config = {
    summarize: { enabled: true, maxChars: 8000 },
    cleanup: { enabled: true, verifyRss: false },
    faults: ['stage'],
  };

  const code = await crashRun({
    root,
    paths,
    transcript,
    sid: 'v6',
    countFile,
    delay: 0,
    summary: GROUNDED_SUMMARY,
    config,
    outFile: path.join(root, 'out-crash.json'),
  });

  assert.equal(code, 70, '故障注入应让子进程在 stage 后退出');

  // 崩溃后：日志未提交，但 journal 记录了 stage
  assert.equal(fs.existsSync(path.join(paths.worklogDir, 'v6.md')), false, '崩溃时不得提交日志');
  const journal = await readJson(path.join(paths.stateDir, 'journal', 'v6.json'), null);
  assert.ok(journal, 'journal 必须存在');
  assert.equal(journal.status, 'in_progress');
  assert.ok(journal.steps?.stage?.sha, 'stage 步骤必须落盘');
  assert.ok(journal.steps?.stage?.path);
  assert.equal(fs.existsSync(countFile), false, '崩溃发生在清理之前');

  // 重启：应识别 stage 并续跑
  const adapter = new StubAdapter({
    root,
    config: { paths },
    summary: GROUNDED_SUMMARY,
    cleanup: async () => {
      fs.appendFileSync(countFile, `${process.pid}\n`, 'utf8');
      return { ok: true, code: 'STUB_OK', provider: 'stub' };
    },
  });
  const cleaner = new CodexCleaner({ adapter, paths, config: { ...config, faults: [] } });

  const out = await cleaner.onSessionEnd({ session_id: 'v6', transcript_path: transcript, cwd: root });

  assert.equal(out.status, 'ok', JSON.stringify(out));
  assert.equal(out.resumed, true);
  assert.equal(out.verdict, 'resumed');
  assert.equal(adapter.calls.summarize.length, 0, '续跑不应重复调模型');
  assert.equal(adapter.calls.cleanup.length, 1);

  const doc = parseWorklog(await adapter.readWorklog('v6'));
  assert.equal(doc.parseErrors.length, 0, doc.parseErrors.join(','));
  assert.equal(doc.items.length, 1);
  assert.equal(doc.meta.traceHashes.length, 1, '同一段轨迹不能重复追加');

  const journalAfter = await readJson(path.join(paths.stateDir, 'journal', 'v6.json'), null);
  assert.equal(journalAfter.status, 'done');
  assert.equal(journalAfter.attempt, 2);
  assert.equal(fs.readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean).length, 1);
});
