/**
 * adapters/base.js — Codex 版 adapter 契约。
 *
 * 与 DSH 版最大的差别：这里没有 destroyEngine()/rebuildSession()。
 * 清理动作必须走「外部引擎 HTTP API」，会话重建只能靠 SessionStart 注入，
 * 所以 adapter 只需要：读 transcript、调模型总结、清本地引擎、读写日志。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  MemoryError,
  defaultPaths,
  projectMemoryFile,
  readText,
  writeTextAtomic,
} from '../state.js';
import { readTrace } from '../raw-trace.js';
import { readNativeMemory } from '../native-memory.js';

export class CodexAdapter {
  constructor(config = {}) {
    this.config = config || {};
    this.paths = this.config.paths || defaultPaths({ home: this.config.home, cwd: this.config.cwd });
    this.model = this.config.engine?.model || process.env.CODEX_MODEL || null;
  }

  /* ---------------------------------------------------------- transcript */

  /** 读 transcript 最近 n 轮（默认实现：JSONL 尾部解析，不调模型）。 */
  async readRecentTurns(transcriptPath, n = 5) {
    const r = await readTrace({
      transcriptPath,
      turns: n,
      bytes: this.config.trace?.tailBytes ?? 262144,
      maxChars: this.config.trace?.maxChars ?? 4000,
      perTurnChars: this.config.trace?.perTurnChars ?? 700,
    });
    return r.turns;
  }

  /* ---------------------------------------------------------------- 模型 */

  /** 调模型做总结。子类必须实现（本地推理 HTTP API）。 */
  async summarize(_prompt, _opts = {}) {
    throw new MemoryError('E_NOT_IMPLEMENTED', `${this.constructor.name}.summarize 未实现`);
  }

  /* ------------------------------------------------------------ 引擎清理 */

  /* ------------------------------------------------------------ 引擎探测 */

  /**
   * 探测引擎状态。子类必须实现；未实现 = unknown = 不清理（fail-closed）。
   * 返回 {ok, loaded?, state?, owned?, endpoint?, model?, pid?}
   */
  async probeEngine(_opts = {}) {
    return { ok: false, code: 'E_PROBE_NOT_IMPLEMENTED' };
  }

  /** 清理本地推理引擎。子类必须实现；返回 {ok, code, ...}。
   *  注意：业务代码不得直接调用，只能经 engine-gate。 */
  async cleanupLocalEngine(_opts = {}) {
    throw new MemoryError('E_NOT_IMPLEMENTED', `${this.constructor.name}.cleanupLocalEngine 未实现`);
  }

  /* -------------------------------------------------------------- 工作日志 */

  worklogFile(sessionId) {
    return path.join(this.paths.worklogDir, `${sessionId}.md`);
  }

  async readWorklog(sessionId) {
    return readText(this.worklogFile(sessionId));
  }

  async writeWorklog(sessionId, content) {
    const r = await writeTextAtomic(this.worklogFile(sessionId), content);
    return { ...r, path: this.worklogFile(sessionId) };
  }

  /* -------------------------------------------------------------- 共享日志 */

  sharedFile(scope, cwd) {
    if (scope === 'global') return this.paths.globalMemoryFile;
    if (scope === 'project') return projectMemoryFile(cwd || this.paths.cwd);
    throw new MemoryError('E_BAD_SCOPE', `scope=${scope}`);
  }

  async readSharedMemory(scope, { cwd } = {}) {
    return readText(this.sharedFile(scope, cwd));
  }

  /** 宿主原生记忆：只读导入，永不写入。 */
  async readNativeMemory() {
    return readNativeMemory({
      home: this.config.home,
      maxChars: this.config.inject?.sharedChars ?? 1200,
    });
  }

  /**
   * 确认机制：没有 confirmed:true 一律拒写。
   * 共享日志是跨会话长期记忆，模型不能自己往里写。
   */
  async writeSharedMemory(scope, content, { confirmed = false, confirmationId = null, cwd } = {}) {
    if (!confirmed) {
      throw new MemoryError('E_CONFIRM_REQUIRED', '共享记忆写入需要用户确认（confirmed:true）');
    }
    const text = String(content ?? '').trim();
    if (!text) throw new MemoryError('E_EMPTY_MEMORY', '内容为空');
    const max = this.config.memory?.maxChars ?? 4000;
    if (text.length > max) throw new MemoryError('E_MEMORY_TOO_LONG', `长度 ${text.length} > ${max}`);

    const file = this.sharedFile(scope, cwd);
    const header = `<!-- shared:${scope} updated=${new Date().toISOString()} confirm=${confirmationId || 'cli'} -->\n`;
    const r = await writeTextAtomic(file, `${header}${text}\n`);
    return { ...r, path: file, scope };
  }

  /** 模型只能提议：落到 pending，等用户确认。 */
  async proposeSharedMemory(scope, content, { cwd, reason = '' } = {}) {
    const dir = path.join(this.paths.stateDir, 'pending');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${scope}-${Date.now()}.md`);
    const body = [
      `<!-- propose scope=${scope} at=${new Date().toISOString()} -->`,
      reason ? `<!-- reason: ${reason} -->` : '',
      String(content ?? '').trim(),
      '',
    ]
      .filter(Boolean)
      .join('\n');
    await fsp.writeFile(file, body, 'utf8');
    return { path: file, scope, needsConfirmation: true };
  }

  /* ---------------------------------------------------------------- 元信息 */

  /** 当前模型 ID：优先 Codex 配置里的 model（config.toml 由用户维护，插件只读不写）。 */
  async currentModelId() {
    return this.model;
  }
}
