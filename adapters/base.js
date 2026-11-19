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
  FileLock,
} from '../state.js';
import {
  parseMemory,
  renderMemory,
  mergeMemory,
  markSuperseded,
  listPending,
  proposePending,
  findPending,
  removePending,
} from '../memory-store.js';
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

  /** 同一 scope 的记忆写入串行化；短时争抢重试，长时间占用才报忙。 */
  async #memoryLock(scope) {
    for (let i = 0; i < 6; i += 1) {
      const lock = await FileLock.acquire(path.join(this.paths.stateDir, `memory-${scope}.lock`), {
        ttlMs: 10000,
      });
      if (lock) return lock;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new MemoryError('E_MEMORY_BUSY', '另一个记忆写入正在进行，请稍后重试');
  }

  async #backupMemory(file, raw) {
    const dir = path.join(path.dirname(file), '.backup');
    await fsp.mkdir(dir, { recursive: true });
    const base = path.basename(file);
    const name = `${base}.${Date.now()}.bak`;
    await fsp.writeFile(path.join(dir, name), raw, 'utf8');
    const names = (await fsp.readdir(dir)).filter((n) => n.startsWith(base)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - 3))) {
      await fsp.unlink(path.join(dir, n)).catch(() => {});
    }
  }

  /**
   * 写入 = 读取 → 解析 → 合并 → 重渲染 → 原子替换。
   * 不再整文件覆盖：同哈希去重，同键不同值标 conflict。
   * 结构损坏时拒写并隔离，不用坏文件冲掉旧记忆。
   */
  async writeSharedMemory(scope, content, { confirmed = false, confirmationId = null, cwd } = {}) {
    if (!confirmed) {
      throw new MemoryError('E_CONFIRM_REQUIRED', '共享记忆写入需要用户确认（confirmed:true）');
    }
    const text = String(content ?? '').trim();
    if (!text) throw new MemoryError('E_EMPTY_MEMORY', '内容为空');
    const file = this.sharedFile(scope, cwd);

    const lock = await this.#memoryLock(scope);
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const raw = await readText(file);
      const doc = parseMemory(raw, { scope });
      if (doc.parseErrors.length && !doc.legacy) {
        const q = path.join(this.paths.stateDir, 'memory-quarantine', `${scope}-${Date.now()}.md`);
        await fsp.mkdir(path.dirname(q), { recursive: true });
        await fsp.writeFile(q, raw, 'utf8');
        throw new MemoryError('E_MEMORY_PARSE', `共享记忆结构损坏，已备份到 ${q}`, { quarantine: q });
      }

      const merged = mergeMemory(doc.entries, text, { source: confirmationId ? 'cli' : 'accept' });
      const revision = (doc.revision || 0) + 1;
      const md = renderMemory(merged.entries, { scope, revision });
      const max = this.config.memory?.maxChars ?? 20000;
      if (md.length > max) {
        throw new MemoryError('E_MEMORY_TOO_LONG', `长度 ${md.length} > ${max}`);
      }
      if (raw.trim()) await this.#backupMemory(file, raw);

      const r = await writeTextAtomic(file, md);
      return {
        ...r,
        path: file,
        scope,
        revision,
        entries: merged.entries.length,
        added: merged.added,
        duplicated: merged.duplicated,
        conflicts: merged.conflicts,
      };
    } finally {
      await lock.release();
    }
  }

  /** 模型/用户可以提议，但不会直接落盘；写入必须经 accept。 */
  async proposeSharedMemory(scope, content, { reason = '' } = {}) {
    if (scope !== 'global' && scope !== 'project') throw new MemoryError('E_BAD_SCOPE', `scope=${scope}`);
    const r = await proposePending(this.paths, { scope, text: content, reason });
    return { ...r, scope, needsConfirmation: !r.duplicated };
  }

  async listPendingMemory() {
    return listPending(this.paths);
  }

  /** 消费队列：把提案合并进共享层，成功后从 pending 移除。 */
  async acceptPendingMemory(id) {
    const item = await findPending(this.paths, id);
    if (!item) throw new MemoryError('E_PENDING_NOT_FOUND', `找不到提案 ${id}`);
    const r = await this.writeSharedMemory(item.scope, item.text, {
      confirmed: true,
      confirmationId: `accept:${item.id}`,
    });
    await removePending(this.paths, item);
    return { ...r, accepted: item.id };
  }

  async rejectPendingMemory(id, { reason = '' } = {}) {
    const item = await findPending(this.paths, id);
    if (!item) throw new MemoryError('E_PENDING_NOT_FOUND', `找不到提案 ${id}`);
    await removePending(this.paths, item, { rejected: true, reason });
    return { rejected: item.id, reason };
  }

  /** 裁决冲突：保留 keepId，另一条标 superseded（不删行）。 */
  async resolveConflict(scope, keepId, dropId, { cwd } = {}) {
    const file = this.sharedFile(scope, cwd);
    const lock = await this.#memoryLock(scope);
    try {
      const raw = await readText(file);
      const doc = parseMemory(raw, { scope });
      if (!doc.entries.some((e) => e.id === keepId)) throw new MemoryError('E_MEMORY_ID', `不存在 ${keepId}`);
      const entries = markSuperseded(doc.entries, dropId, keepId).map((e) =>
        e.id === keepId && e.status.startsWith('conflict') ? { ...e, status: 'active' } : e,
      );
      const revision = (doc.revision || 0) + 1;
      await this.#backupMemory(file, raw);
      await writeTextAtomic(file, renderMemory(entries, { scope, revision }));
      return { scope, kept: keepId, superseded: dropId, revision };
    } finally {
      await lock.release();
    }
  }

  /** 显式升级：project 条目提到 global，原条目标 superseded。 */
  async promoteMemory(id, { to = 'global', reason = '', cwd } = {}) {
    if (to !== 'global') throw new MemoryError('E_BAD_SCOPE', `to=${to}`);
    const srcFile = this.sharedFile('project', cwd);
    const raw = await readText(srcFile);
    const doc = parseMemory(raw, { scope: 'project' });
    const entry = doc.entries.find((e) => e.id === id);
    if (!entry) throw new MemoryError('E_MEMORY_ID', `不存在 ${id}`);
    const written = await this.writeSharedMemory('global', entry.text, {
      confirmed: true,
      confirmationId: `promote:${id}`,
    });
    const lock = await this.#memoryLock('project');
    try {
      const entries = markSuperseded(doc.entries, id, 'global');
      await this.#backupMemory(srcFile, raw);
      await writeTextAtomic(srcFile, renderMemory(entries, { scope: 'project', revision: (doc.revision || 0) + 1 }));
    } finally {
      await lock.release();
    }
    return { promoted: id, to, reason, global: written };
  }

  /* ---------------------------------------------------------------- 元信息 */

  /** 当前模型 ID：优先 Codex 配置里的 model（config.toml 由用户维护，插件只读不写）。 */
  async currentModelId() {
    return this.model;
  }
}
