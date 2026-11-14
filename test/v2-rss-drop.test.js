/**
 * V2 证伪：引擎清理后进程 RSS 必须真实下降。
 *
 * 测量走 OS 真值（win32 WorkingSet64 / linux VmRSS / darwin vmmap footprint），
 * 不用 top。假引擎进程常驻 256MB，收到 unload 才释放 —— 这样断言的是
 * 「测量链路 + keep_alive:0 卸载语义」，换成真 Ollama 后同一套断言即可证伪。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CodexCleaner } from '../codex-cleaner.js';
import { OllamaAdapter } from '../adapters/ollama.js';
import { readRssBytes } from '../rss.js';
import { tempRoot, makePaths, writeTranscript, SAMPLE_TURNS } from './helpers/fixtures.js';
import { startFakeOllama } from './helpers/fake-ollama.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, 'helpers', 'fake-engine.mjs');
const MB = 1024 * 1024;

function spawnEngine() {
  const child = fork(ENGINE, { execArgv: ['--expose-gc'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake engine 未就绪')), 20000);
    child.on('message', (m) => {
      if (m && m.ready) {
        clearTimeout(timer);
        resolve(m);
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`fake engine 退出 ${code}`));
    });
  });
  return { child, ready };
}

const engineConfig = (fake, pid) => ({
  provider: 'ollama',
  model: 'fake:7b',
  endpoint: fake.url,
  pid,
});

test('V2：Ollama keep_alive:0 后引擎进程 RSS 真实下降', async (t) => {
  const root = tempRoot('codex-v2-');
  const paths = makePaths(root);
  const transcript = writeTranscript(path.join(root, 'rollout.jsonl'), SAMPLE_TURNS);

  const { child, ready } = spawnEngine();
  await ready;
  t.after(() => child.kill());

  const fake = await startFakeOllama({
    model: 'fake:7b',
    unloadLatencyMs: 120,
    onUnload: () => child.send('unload'),
  });
  t.after(async () => {
    await fake.close();
  });
  child.on('message', (m) => {
    if (m && m.freed) fake.setLoaded(false);
  });

  const before = await readRssBytes(child.pid);
  assert.ok(before && before > 180 * MB, `基线不足: ${before}`);

  const engine = engineConfig(fake, child.pid);
  const adapter = new OllamaAdapter({ paths, engine });
  const cleaner = new CodexCleaner({
    adapter,
    paths,
    config: {
      summarize: { enabled: false },
      cleanup: {
        enabled: true,
        verifyRss: true,
        rssDropRatio: 0.5,
        rssMinDropBytes: 64 * MB,
        waitMs: 15000,
        pollMs: 200,
      },
      engine,
    },
  });

  const out = await cleaner.onSessionEnd({ session_id: 'v2', transcript_path: transcript, cwd: root });

  assert.equal(out.status, 'ok', JSON.stringify(out));
  assert.equal(out.engine.result.code, 'UNLOADED');
  assert.ok(out.engine.result.dropped >= 100 * MB, `dropped=${out.engine.result.dropped}`);

  const after = await readRssBytes(child.pid);
  assert.ok(after !== null, '清理后仍应能测到进程');
  assert.ok(before - after >= 100 * MB, `RSS 未真实下降: before=${before} after=${after}`);
  assert.equal(fake.state.unloadCalls, 1);
});

test('V2b：/api/ps 仍报常驻 -> 清理失败，日志不提交', async (t) => {
  const root = tempRoot('codex-v2b-');
  const paths = makePaths(root);
  const transcript = writeTranscript(path.join(root, 'rollout.jsonl'), SAMPLE_TURNS);

  const { child, ready } = spawnEngine();
  await ready;
  t.after(() => child.kill());

  const fake = await startFakeOllama({ model: 'fake:7b', stubborn: true });
  t.after(async () => {
    await fake.close();
  });

  const engine = engineConfig(fake, child.pid);
  const adapter = new OllamaAdapter({ paths, engine });
  const cleaner = new CodexCleaner({
    adapter,
    paths,
    config: {
      summarize: { enabled: false },
      cleanup: { enabled: true, verifyRss: false, waitMs: 1200, pollMs: 200 },
      engine,
    },
  });

  const out = await cleaner.onSessionEnd({ session_id: 'v2b', transcript_path: transcript, cwd: root });

  assert.equal(out.status, 'cleanup_failed');
  assert.equal(out.engine.code, 'STILL_LOADED');
  assert.ok(fake.state.unloadCalls >= 1);
  assert.equal(await adapter.readWorklog('v2b'), '', '清理失败不得提交日志');
});
