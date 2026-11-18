/**
 * 跨平台单元测试（C1–C8）。
 * 平台一律作为参数注入，不在测试里读 process.platform，
 * 这样 Linux CI 也能验证 win32 / darwin 分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SAMPLER_KIND,
  pickSamplerKind,
  makeSampler,
  sampleMemory,
  waitForRssDrop,
  parseProcPss,
  parseProcStatus,
  parseWinRss,
} from '../rss.js';
import { canonicalEndpoint } from '../endpoint.js';
import { defaultPaths, renameWithRetry } from '../state.js';

test('C1 选型：平台 -> 采样口径，未知平台返回 null', () => {
  assert.equal(pickSamplerKind({ platform: 'win32' }), SAMPLER_KIND.WIN_RSS);
  assert.equal(pickSamplerKind({ platform: 'linux' }), SAMPLER_KIND.PROC_RSS);
  assert.equal(pickSamplerKind({ platform: 'darwin' }), SAMPLER_KIND.FOOTPRINT);
  assert.equal(pickSamplerKind({ platform: 'freebsd' }), null);
  assert.equal(
    pickSamplerKind({ platform: 'linux', hasNvidia: true }),
    SAMPLER_KIND.NVIDIA,
    '有 NVIDIA 时优先显存口径',
  );
});

test('C2 PROC_RSS：优先 Pss，缺失时回退 VmRSS，进程消失返回 gone', async () => {
  assert.equal(parseProcPss('Pss: 2048 kB\n'), 2048 * 1024);
  assert.equal(parseProcStatus('VmRSS:\t4096 kB\n'), 4096 * 1024);

  const readText = async (file) => {
    if (file.endsWith('smaps_rollup')) return { ok: true, text: 'Pss: 1024 kB\n' };
    return { ok: true, text: 'VmRSS: 9999 kB\n' };
  };
  const s1 = makeSampler({ kind: SAMPLER_KIND.PROC_RSS, pid: 42, platform: 'linux', readText });
  assert.deepEqual(await s1(), { ok: true, bytes: 1024 * 1024, kind: 'proc_rss' });

  // Pss 行缺失（只有 VmRSS）-> 回退，不许报 null
  const readTextFallback = async (file) => {
    if (file.endsWith('smaps_rollup')) return { ok: true, text: 'Rss: 1 kB\n' };
    return { ok: true, text: 'VmRSS: 8192 kB\n' };
  };
  const s2 = makeSampler({ kind: SAMPLER_KIND.PROC_RSS, pid: 42, platform: 'linux', readText: readTextFallback });
  assert.equal((await s2()).bytes, 8192 * 1024);

  // 两个文件都 ENOENT -> 进程已退出
  const goneRead = async () => ({ ok: false, text: '', code: 'ENOENT' });
  const s3 = makeSampler({ kind: SAMPLER_KIND.PROC_RSS, pid: 42, platform: 'linux', readText: goneRead });
  assert.deepEqual(await s3(), { ok: true, bytes: 0, gone: true, kind: 'proc_rss' });

  // 权限不足 -> 明确失败，不许当成 gone
  const denied = async () => ({ ok: false, text: '', code: 'EACCES' });
  const s4 = makeSampler({ kind: SAMPLER_KIND.PROC_RSS, pid: 42, platform: 'linux', readText: denied });
  const r4 = await s4();
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'EACCES');
});

test('C3 WIN_RSS：千分位必须先去逗号，空输出视为进程消失', async () => {
  assert.equal(parseWinRss('1,234,567 K'), 1234567 * 1024);
  assert.equal(parseWinRss('524288000'), 524288000);
  assert.equal(parseWinRss(''), null);

  const exec = async () => ({ ok: true, out: '1,234,567 K\r\n', err: '' });
  const s = makeSampler({ kind: SAMPLER_KIND.WIN_RSS, pid: 7, platform: 'win32', exec });
  assert.equal((await s()).bytes, 1234567 * 1024);

  const execGone = async () => ({ ok: true, out: '', err: '' });
  const s2 = makeSampler({ kind: SAMPLER_KIND.WIN_RSS, pid: 7, platform: 'win32', exec: execGone });
  assert.deepEqual(await s2(), { ok: true, bytes: 0, gone: true, kind: 'win_rss' });
});

test('C4 平台与口径不匹配：抛 E_SAMPLER_PLATFORM，不静默降级', async () => {
  assert.throws(
    () => makeSampler({ kind: SAMPLER_KIND.WIN_RSS, pid: 1, platform: 'linux' }),
    (e) => e.code === 'E_SAMPLER_PLATFORM',
  );
  assert.throws(
    () => makeSampler({ kind: SAMPLER_KIND.PROC_RSS, pid: 1, platform: 'win32' }),
    (e) => e.code === 'E_SAMPLER_PLATFORM',
  );
  assert.throws(
    () => makeSampler({ kind: SAMPLER_KIND.FOOTPRINT, pid: 1, platform: 'linux' }),
    (e) => e.code === 'E_SAMPLER_PLATFORM',
  );

  const r = await sampleMemory(1, { platform: 'linux', kind: SAMPLER_KIND.WIN_RSS });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_SAMPLER_PLATFORM');
});

test('C5 endpoint 别名归一：localhost / 尾斜杠 / 默认端口', () => {
  assert.equal(canonicalEndpoint('http://localhost:11434/'), 'http://127.0.0.1:11434');
  assert.equal(canonicalEndpoint('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(canonicalEndpoint('https://example.com:443/v1/'), 'https://example.com/v1');
  assert.equal(canonicalEndpoint(''), '');
});

test('C6 endpoint 大小写不敏感（Windows/macOS 语义）', () => {
  assert.equal(
    canonicalEndpoint('HTTP://LOCALHOST:11434'),
    canonicalEndpoint('http://127.0.0.1:11434'),
  );
  assert.notEqual(
    canonicalEndpoint('http://127.0.0.1:11434'),
    canonicalEndpoint('http://127.0.0.1:11435'),
  );
});

test('C7 rename 重试：瞬时错误重试成功 / 真实错误一次就抛 / 用尽抛出', async () => {
  const delays = [];
  const sleepFn = (ms) => delays.push(ms);

  // 瞬时 EPERM 两次后成功
  let calls = 0;
  const flaky = {
    rename: async () => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return undefined;
    },
  };
  const ok = await renameWithRetry('a', 'b', { fsImpl: flaky, sleepFn, retries: 5, delayMs: 10 });
  assert.deepEqual(ok, { ok: true, attempts: 3 });
  assert.deepEqual(delays, [10, 20]);

  // ENOENT 不是瞬时错误，一次就抛
  let calls2 = 0;
  const missing = {
    rename: async () => {
      calls2 += 1;
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    },
  };
  await assert.rejects(
    () => renameWithRetry('a', 'b', { fsImpl: missing, sleepFn, retries: 5 }),
    (e) => e.code === 'ENOENT',
  );
  assert.equal(calls2, 1, 'ENOENT 不该重试');

  // 一直 EPERM -> 用尽后抛，次数 = retries + 1
  let calls3 = 0;
  const stuck = {
    rename: async () => {
      calls3 += 1;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    },
  };
  await assert.rejects(
    () => renameWithRetry('a', 'b', { fsImpl: stuck, sleepFn, retries: 3, delayMs: 1 }),
    (e) => e.code === 'EBUSY',
  );
  assert.equal(calls3, 4);
});

test('C8 采样失败必须 unverifiable，不许当成进程已退出', async () => {
  const failing = async () => ({ ok: false, code: 'EACCES' });
  const r = await waitForRssDrop({
    pid: 1,
    before: 300 * 1024 * 1024,
    pollMs: 1,
    timeoutMs: 50,
    sample: failing,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unverifiable');

  const gone = async () => ({ ok: true, bytes: 0, gone: true });
  const r2 = await waitForRssDrop({ pid: 1, before: 300 * 1024 * 1024, pollMs: 1, timeoutMs: 50, sample: gone });
  assert.equal(r2.ok, true);
  assert.equal(r2.reason, 'process_gone');
});

test('C9 defaultPaths：取不到 home 时抛 E_NO_HOME，不回退 cwd', () => {
  assert.throws(() => defaultPaths({ home: '' }), (e) => e.code === 'E_NO_HOME');
  const p = defaultPaths({ home: 'C:\\Users\\x', cwd: 'C:\\w' });
  assert.ok(p.stateDir.endsWith('state'));
});
