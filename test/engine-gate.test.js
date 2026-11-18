/**
 * engine-gate 不变量测试（I1–I6）。
 * 所有断言都指向「引擎写次数」与「审计码」，不允许用 skip 绕过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineGate, ENGINE_STATE, AUDIT } from '../engine-gate.js';
import { CodexCleaner } from '../codex-cleaner.js';
import { tempRoot, makePaths, writeTranscript, SAMPLE_TURNS, StubAdapter } from './helpers/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

function makeGate(probeImpl, { owned = false } = {}) {
  const root = tempRoot('codex-gate-');
  const paths = makePaths(root);
  const calls = [];
  const adapter = {
    paths,
    probeEngine: async () => {
      calls.push('probe');
      return probeImpl();
    },
    cleanupLocalEngine: async () => {
      calls.push('cleanup');
      return { ok: true, code: 'STUB_OK' };
    },
  };
  const config = {
    engine: { provider: 'stub', model: 'm', endpoint: 'stub://x', owned },
    cleanup: { enabled: true },
  };
  return { gate: new EngineGate({ adapter, config, paths }), calls, paths, adapter, config };
}

function auditLines(paths) {
  const file = path.join(paths.stateDir, 'engine-audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('I1：清理前必有一次探测，且顺序是 probe -> cleanup', async () => {
  const { gate, calls } = makeGate(() => ({ ok: true, loaded: true, owned: true }), { owned: true });
  const r = await gate.run({ trigger: 'test' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['probe', 'cleanup']);
  assert.equal(r.auditCode, AUDIT.CLEANED);
});

test('I2：absent -> 引擎写次数 = 0，审计码 engine_absent', async () => {
  const { gate, calls, paths } = makeGate(() => ({ ok: true, loaded: false }), { owned: true });
  const r = await gate.run({ trigger: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.state, ENGINE_STATE.ABSENT);
  assert.equal(r.auditCode, AUDIT.ABSENT);
  assert.equal(calls.filter((c) => c === 'cleanup').length, 0);
  const lines = auditLines(paths);
  assert.equal(lines.at(-1).auditCode, 'engine_absent');
});

test('I3：探测失败/未实现 -> unknown -> 引擎写次数 = 0，且留痕', async () => {
  const { gate, calls, paths } = makeGate(() => {
    throw Object.assign(new Error('probe boom'), { code: 'E_PROBE_FAILED' });
  });
  const r = await gate.run({ trigger: 'test' });
  assert.equal(r.skipped, true);
  assert.equal(r.state, ENGINE_STATE.UNKNOWN);
  assert.equal(r.auditCode, AUDIT.UNKNOWN);
  assert.equal(calls.filter((c) => c === 'cleanup').length, 0);
  assert.equal(auditLines(paths).at(-1).auditCode, 'engine_unknown');
});

test('I4：无归属证据（foreign）-> 引擎写次数 = 0', async () => {
  const { gate, calls, paths } = makeGate(() => ({ ok: true, loaded: true, models: ['m'] }), { owned: false });
  const r = await gate.run({ trigger: 'test' });
  assert.equal(r.skipped, true);
  assert.equal(r.state, ENGINE_STATE.FOREIGN);
  assert.equal(r.auditCode, AUDIT.FOREIGN);
  assert.equal(calls.filter((c) => c === 'cleanup').length, 0);
  assert.equal(auditLines(paths).at(-1).auditCode, 'engine_foreign');
});

test('I5：absent 时日志流水线仍完整走完', async () => {
  const root = tempRoot('codex-gate-i5-');
  const paths = makePaths(root);
  const transcript = writeTranscript(path.join(root, 'rollout.jsonl'), SAMPLE_TURNS);
  const adapter = new StubAdapter({
    root,
    config: { paths },
    probe: async () => ({ ok: true, loaded: false }),
  });
  const cleaner = new CodexCleaner({
    adapter,
    paths,
    config: { summarize: { enabled: false }, cleanup: { enabled: true } },
  });

  const out = await cleaner.onSessionEnd({ session_id: 'i5', transcript_path: transcript, cwd: root });

  assert.equal(out.status, 'ok', JSON.stringify(out));
  assert.equal(out.engine.skipped, true);
  assert.equal(out.engine.code, AUDIT.ABSENT);
  assert.equal(adapter.calls.cleanup.length, 0);
  const log = await adapter.readWorklog('i5');
  assert.match(log, /## 原始轨迹/);
});

test('I6：业务代码里只有 engine-gate 能触达 cleanupLocalEngine', () => {
  const files = fs.readdirSync(REPO).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    if (f === 'engine-gate.js') continue;
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    if (/\.cleanupLocalEngine\s*\(/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `违规调用点: ${offenders.join(',')}`);
});
