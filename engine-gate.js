/**
 * engine-gate.js — 引擎清理的唯一出口。
 *
 * 所有清理路径必须经过这里：探测 → 归属判定 → 放行/拒绝 → 执行 → 验证 → 审计。
 * 除本文件外，业务代码不得直接调用 adapter.cleanupLocalEngine（可用 grep 验证）。
 *
 * 硬规则：
 *  - 探测缺失 / 探测异常 -> unknown -> 不清理（fail-closed）。
 *  - absent（没装/没加载）-> 不清理，但审计码必须与 foreign 区分。
 *  - 归属只认「显式登记」：适配器自证 owned，或本插件登记过的 endpoint+model+pid。
 *    禁止「同名模型即同一实例」这类启发式。
 *  - 每次判定都写审计（含 unknown / foreign / absent），否则线上看不到「什么都没发生」。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { readJson, writeJsonAtomic } from './state.js';

export const ENGINE_STATE = Object.freeze({
  OWNED_IDLE: 'owned_idle',
  OWNED_BUSY: 'owned_busy',
  FOREIGN: 'foreign',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
});

/** 只有 owned_idle 允许清理；owned_busy 说明引擎正在推理，动它就是误伤。 */
export const CLEANABLE_STATES = new Set([ENGINE_STATE.OWNED_IDLE]);

export const AUDIT = Object.freeze({
  CLEANED: 'engine_cleaned',
  CLEANUP_FAILED: 'engine_cleanup_failed',
  ABSENT: 'engine_absent',
  FOREIGN: 'engine_foreign',
  BUSY: 'engine_busy',
  UNKNOWN: 'engine_unknown',
});

export class EngineGate {
  constructor({ adapter, config, paths } = {}) {
    if (!adapter) throw new Error('engine-gate: adapter required');
    this.adapter = adapter;
    this.config = config || {};
    this.paths = paths || adapter.paths;
    this.lastProbe = null;
  }

  registryFile() {
    return path.join(this.paths.stateDir, 'engine-registry.json');
  }

  auditFile() {
    return path.join(this.paths.stateDir, 'engine-audit.jsonl');
  }

  async #registry() {
    return (await readJson(this.registryFile(), null)) || { version: 1, entries: [] };
  }

  /** 建立时登记：只接受显式归属声明，不做同名推断。 */
  async registerOwnership(probe, { source = 'config' } = {}) {
    const reg = await this.#registry();
    const entry = {
      endpoint: probe.endpoint || this.config.engine?.endpoint || null,
      model: probe.model || this.config.engine?.model || null,
      pid: probe.pid ?? this.config.engine?.pid ?? null,
      source,
      registeredAt: new Date().toISOString(),
    };
    const same = (reg.entries || []).some(
      (e) => e.endpoint === entry.endpoint && e.model === entry.model && e.pid === entry.pid,
    );
    if (!same) {
      reg.entries = [...(reg.entries || []), entry].slice(-20);
      await writeJsonAtomic(this.registryFile(), reg);
    }
    return entry;
  }

  async #matchRegistry(probe) {
    const reg = await this.#registry();
    const ep = probe.endpoint || this.config.engine?.endpoint || null;
    const model = probe.model || this.config.engine?.model || null;
    return (
      (reg.entries || []).find(
        (e) =>
          e.endpoint === ep &&
          (!e.model || !model || e.model === model) &&
          (!e.pid || !probe.pid || e.pid === probe.pid),
      ) || null
    );
  }

  /** 探测。适配器没实现 -> unknown；抛错 -> unknown。 */
  async probe() {
    const fn = this.adapter.probeEngine;
    if (typeof fn !== 'function') {
      return { ok: false, state: ENGINE_STATE.UNKNOWN, code: 'E_PROBE_NOT_IMPLEMENTED' };
    }
    try {
      const r = await fn.call(this.adapter, {
        endpoint: this.config.engine?.endpoint,
        model: this.config.engine?.model,
        pid: this.config.engine?.pid,
      });
      if (!r || r.ok !== true) {
        return { ok: false, state: ENGINE_STATE.UNKNOWN, code: (r && r.code) || 'E_PROBE_FAILED', detail: r };
      }
      const state = r.state || (r.loaded ? ENGINE_STATE.FOREIGN : ENGINE_STATE.ABSENT);
      return { ok: true, ...r, state };
    } catch (e) {
      return { ok: false, state: ENGINE_STATE.UNKNOWN, code: e.code || 'E_PROBE_FAILED', error: String(e.message || e) };
    }
  }

  async evaluate() {
    const p = await this.probe();
    this.lastProbe = p;

    if (!p.ok) return { decision: 'deny', state: ENGINE_STATE.UNKNOWN, auditCode: AUDIT.UNKNOWN, probe: p };
    if (p.state === ENGINE_STATE.ABSENT) return { decision: 'deny', state: p.state, auditCode: AUDIT.ABSENT, probe: p };
    if (p.state === ENGINE_STATE.OWNED_BUSY) return { decision: 'deny', state: p.state, auditCode: AUDIT.BUSY, probe: p };

    const declared = this.config.engine?.owned;
    let owned = p.owned === true || p.state === ENGINE_STATE.OWNED_IDLE;
    if (!owned && declared === true) owned = true; // 显式归属声明（非同名启发）
    if (!owned && declared === undefined) owned = Boolean(await this.#matchRegistry(p));
    if (!owned) return { decision: 'deny', state: ENGINE_STATE.FOREIGN, auditCode: AUDIT.FOREIGN, probe: p };

    if (declared === true) await this.registerOwnership(p);
    return {
      decision: 'allow',
      state: p.state === ENGINE_STATE.OWNED_BUSY ? p.state : ENGINE_STATE.OWNED_IDLE,
      auditCode: null,
      probe: p,
    };
  }

  async #audit(record) {
    try {
      const file = this.auditFile();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
    } catch {
      /* 审计写不进去也不能影响主流程 */
    }
  }

  /** 唯一允许触达引擎的入口。 */
  async run({ trigger = 'unknown' } = {}) {
    const verdict = await this.evaluate();
    const base = { trigger, state: verdict.state, probe: verdict.probe, cleanup: null };

    if (verdict.decision !== 'allow') {
      await this.#audit({ ...base, event: 'deny', auditCode: verdict.auditCode });
      return { ...base, ok: true, skipped: true, auditCode: verdict.auditCode };
    }

    let cleanup;
    try {
      cleanup = await this.adapter.cleanupLocalEngine({
        provider: this.config.engine?.provider,
        model: this.config.engine?.model,
        endpoint: this.config.engine?.endpoint,
        pid: this.config.engine?.pid,
        verifyRss: this.config.cleanup?.verifyRss,
        waitMs: this.config.cleanup?.waitMs,
        pollMs: this.config.cleanup?.pollMs,
        rssDropRatio: this.config.cleanup?.rssDropRatio,
        rssMinDropBytes: this.config.cleanup?.rssMinDropBytes,
      });
    } catch (e) {
      cleanup = { ok: false, code: e.code || 'E_CLEANUP_FAILED', error: String(e.message || e) };
    }

    const ok = Boolean(cleanup && cleanup.ok);
    const auditCode = ok ? AUDIT.CLEANED : AUDIT.CLEANUP_FAILED;
    await this.#audit({ ...base, event: ok ? 'cleaned' : 'failed', auditCode, cleanup });
    return { ...base, ok, skipped: false, auditCode, cleanup };
  }
}
