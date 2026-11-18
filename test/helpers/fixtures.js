/**
 * 测试共用：临时目录、transcript 构造、stub adapter。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodexAdapter } from '../../adapters/base.js';
import { defaultPaths } from '../../state.js';

export function tempRoot(prefix = 'codex-mem-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makePaths(root) {
  return defaultPaths({ home: root, cwd: root });
}

/**
 * 写一个 Codex 风格的 rollout JSONL。
 * turns: [{role:'user'|'assistant', text, ts?}]
 */
export function writeTranscript(file, turns, { startAt = Date.parse('2026-11-14T09:00:00Z') } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = turns.map((t, i) =>
    JSON.stringify({
      timestamp: t.ts || new Date(startAt + i * 60_000).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: t.role,
        content: [{ type: t.role === 'user' ? 'input_text' : 'output_text', text: t.text }],
      },
    }),
  );
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

export const SAMPLE_TURNS = [
  { role: 'user', text: '实现 codex 清理插件，落盘到 worklogs/<sessionId>.md，调用 adapters/ollama.js 的 keep_alive:0。' },
  { role: 'assistant', text: '已完成 SessionEnd 事务：先写 worklogs/<sessionId>.md，再调 adapters/ollama.js 的 keep_alive:0 卸载模型。' },
  { role: 'user', text: '确认 PreCompact 只写水位，不阻止压缩。' },
];

export const GROUNDED_SUMMARY = JSON.stringify({
  ops: [
    {
      status: 'todo',
      text: '落盘到 worklogs/<sessionId>.md，调用 adapters/ollama.js 的 keep_alive:0。',
    },
  ],
  negations: ['PreCompact 只写水位，不阻止压缩'],
});

export class StubAdapter extends CodexAdapter {
  constructor({ root, config = {}, summary = null, summarizeError = null, cleanup = null, probe = null } = {}) {
    const paths = config.paths || makePaths(root || tempRoot('codex-stub-'));
    super({ ...config, paths });
    this.paths = paths;
    this.summary = summary;
    this.summarizeError = summarizeError;
    this.cleanupImpl = cleanup;
    this.probeImpl = probe;
    this.calls = { summarize: [], cleanup: [] };
  }

  async summarize(prompt, opts = {}) {
    this.calls.summarize.push({ prompt, opts });
    if (this.summarizeError) throw this.summarizeError;
    return this.summary ?? GROUNDED_SUMMARY;
  }

  /** 测试专用：适配器自证归属，绕过真实引擎探测。 */
  async probeEngine() {
    if (this.probeImpl) return this.probeImpl();
    return { ok: true, loaded: true, owned: true, state: 'owned_idle', endpoint: 'stub://local', model: 'stub' };
  }

  async cleanupLocalEngine(args = {}) {
    this.calls.cleanup.push(args);
    if (!this.cleanupImpl) return { ok: true, code: 'STUB_OK', provider: 'stub' };
    return this.cleanupImpl(args);
  }
}
