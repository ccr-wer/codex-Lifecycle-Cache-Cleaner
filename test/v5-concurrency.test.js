/**
 * V5 证伪：并发 SessionEnd -> 文件锁生效，只有一个进程真正执行。
 * 两个子进程同时处理同一 session，engine 清理只能发生一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { tempRoot, makePaths, writeTranscript, SAMPLE_TURNS } from './helpers/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'helpers', 'child-session-end.mjs');
const NODE = process.execPath;

function runChild(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CHILD], {
      env: { ...process.env, MEM_CFG: JSON.stringify(env) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`子进程超时: ${stderr.slice(0, 500)}`));
    }, 30000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`子进程退出 ${code}: ${stderr.slice(0, 500)}`));
      else resolve();
    });
  });
}

test('V5：两个 SessionEnd 同时跑 -> 一个 ok 一个 busy，清理只发生一次', async () => {
  const root = tempRoot('codex-v5-');
  const paths = makePaths(root);
  const transcript = writeTranscript(path.join(root, 'rollout.jsonl'), SAMPLE_TURNS);
  const countFile = path.join(root, 'cleanup-count.txt');
  const cfgBase = {
    root,
    paths,
    transcript,
    sid: 'v5',
    countFile,
    delay: 1500,
    config: {
      summarize: { enabled: false },
      cleanup: { enabled: true, verifyRss: false },
      lock: { ttlMs: 120000 },
    },
  };

  const outA = path.join(root, 'out-a.json');
  const outB = path.join(root, 'out-b.json');

  await Promise.all([
    runChild({ ...cfgBase, outFile: outA }),
    runChild({ ...cfgBase, outFile: outB }),
  ]);

  const a = JSON.parse(fs.readFileSync(outA, 'utf8'));
  const b = JSON.parse(fs.readFileSync(outB, 'utf8'));
  const statuses = [a.status, b.status].sort();

  assert.deepEqual(statuses, ['busy', 'ok'], JSON.stringify([a, b]));
  const busy = a.status === 'busy' ? a : b;
  assert.match(busy.systemMessage, /busy/i);

  const lines = fs.readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `清理次数应为 1，实际 ${lines.length}`);
});
