/**
 * 测试用子进程：跑一次完整 SessionEnd。
 * 用于 V5（并发抢锁）和 V6（stage 后崩溃）。
 */
import fs from 'node:fs';

import { CodexCleaner } from '../../codex-cleaner.js';
import { StubAdapter } from './fixtures.js';

const cfg = JSON.parse(process.env.MEM_CFG || '{}');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adapter = new StubAdapter({
  root: cfg.root,
  config: { ...(cfg.config || {}), paths: cfg.paths },
  summary: cfg.summary ?? null,
  cleanup: async () => {
    fs.appendFileSync(cfg.countFile, `${process.pid}\n`, 'utf8');
    await sleep(Number(cfg.delay || 0));
    return { ok: true, code: 'STUB_OK', provider: 'stub' };
  },
});

const cleaner = new CodexCleaner({ adapter, config: cfg.config || {}, paths: cfg.paths });
const out = await cleaner.onSessionEnd({
  session_id: cfg.sid,
  transcript_path: cfg.transcript,
  cwd: cfg.root,
});

fs.writeFileSync(cfg.outFile, JSON.stringify(out), 'utf8');
