/**
 * codex-cleaner.js — Codex 生命周期钩子里的「固化 + 清理」事务。
 *
 * 事务顺序（不可调换）：
 *   读旧日志 -> 廉价微固化(轨迹) -> 模型总结 + L5 -> 暂存 -> 清理本地引擎 -> 提交
 *
 * 三条硬约束：
 *  1) 提交发生在清理之后：清理失败 -> 日志不提交（不留半成品），暂存稿留待续跑。
 *  2) 摘要在异常状态（超长 / L5 被拒 / 模型失败）时，本轮不清理引擎。
 *  3) 全程持文件锁：并发 SessionEnd 只有一个能跑。
 */
import path from 'node:path';
import fsp from 'node:fs/promises';

import {
  Journal,
  FileLock,
  MemoryError,
  normalizeSessionId,
  defaultPaths,
  validateItems,
  assignIds,
  parseModelOutput,
  mergeNegations,
  sha256,
  readText,
  writeTextAtomic,
  readJson,
} from './state.js';
import { parseWorklog, renderWorklog, buildSummaryPrompt, renderAnchors, appendTrace } from './worklog.js';
import { readTrace } from './raw-trace.js';
import { EngineGate } from './engine-gate.js';

export const DEFAULT_CONFIG = Object.freeze({
  engine: {
    provider: 'ollama',
    model: null,
    endpoint: 'http://127.0.0.1:11434',
    pid: null,
    timeoutMs: 60000,
    keepAlive: '5m',
  },
  summarize: { enabled: true, maxTokens: 900, maxChars: 8000, timeoutMs: 60000 },
  trace: { turns: 6, maxChars: 4000, perTurnChars: 700, tailBytes: 262144 },
  cleanup: {
    enabled: true,
    verifyRss: true,
    rssDropRatio: 0.2,
    rssMinDropBytes: 64 * 1024 * 1024,
    waitMs: 15000,
    pollMs: 300,
  },
  spill: { thresholdBytes: 32768 },
  inject: { maxChars: 4000, negations: 12, openItems: 25, doneItems: 5, sharedChars: 800, memoryChars: 1200, memoryEntryChars: 300 },
  limits: {
    entityJaccardMin: 0.6,
    entryJaccardMin: 0.5,
    groundingJaccardMin: 0.6,
    droppedRatioLimit: 0.3,
    maxItems: 200,
  },
  memory: { maxChars: 20000 },
  worklog: { maxChars: 400000 },
  lock: { ttlMs: 120000 },
  faults: [],
});

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function mergeConfig(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? mergeConfig(base[k], v) : v;
  }
  return out;
}

const clip = (s, n) => (String(s).length <= n ? String(s) : `${String(s).slice(0, n - 1)}…`);

export class CodexCleaner {
  constructor({ adapter, config = {}, paths = null } = {}) {
    if (!adapter) throw new MemoryError('E_ADAPTER_REQUIRED', 'adapter 必填');
    this.adapter = adapter;
    this.config = mergeConfig(DEFAULT_CONFIG, config);
    this.paths = paths || config.paths || adapter.paths || defaultPaths({ home: config.home, cwd: config.cwd });
    this.faults = new Set(this.config.faults || []);
    this.gate = new EngineGate({ adapter, config: this.config, paths: this.paths });
    this.logs = [];
    this.config.log = this.config.log || ((m) => this.logs.push(m));
  }

  #log(msg) {
    this.logs.push({ at: new Date().toISOString(), msg });
    if (typeof this.config.onLog === 'function') this.config.onLog(msg);
  }

  /** 测试用故障注入：只在显式开启时生效，用于验证崩溃恢复。 */
  async #faultPoint(name) {
    if (!this.faults.has(name)) return;
    if (process.env.CODEX_MEMORY_ALLOW_FAULT !== '1') {
      throw new MemoryError('E_FAULT_NOT_ALLOWED', '故障注入需 CODEX_MEMORY_ALLOW_FAULT=1');
    }
    if (typeof this.config.onFault === 'function') await this.config.onFault(name);
    process.exit(70);
  }

  journalFile(sessionId) {
    return path.join(this.paths.stateDir, 'journal', `${sessionId}.json`);
  }

  stagingFile(sessionId) {
    return path.join(this.paths.stateDir, 'staging', `${sessionId}.md`);
  }

  indexPath() {
    return path.join(this.paths.stateDir, 'index.json');
  }

  lockFile(sessionId) {
    return path.join(this.paths.stateDir, 'locks', `${sessionId}.lock`);
  }

  async #readTrace(transcriptPath) {
    return readTrace({
      transcriptPath,
      turns: this.config.trace.turns,
      bytes: this.config.trace.tailBytes,
      maxChars: this.config.trace.maxChars,
      perTurnChars: this.config.trace.perTurnChars,
    });
  }

  #deriveGoal(turns = []) {
    const first = turns.find((t) => t.role === 'user');
    return first ? clip(String(first.text).replace(/\s+/g, ' ').trim(), 160) : '';
  }

  /* ============================================================ SessionEnd */

  async onSessionEnd(payload = {}) {
    const sid = normalizeSessionId(payload.session_id ?? payload.sessionId);
    if (!sid) {
      return { hook: 'SessionEnd', status: 'error', systemMessage: '[memory] payload 缺少 session_id，跳过固化' };
    }
    const transcriptPath = payload.transcript_path || payload.transcriptPath || null;
    const cwd = payload.cwd || this.paths.cwd || process.cwd();

    const lock = await FileLock.acquire(this.lockFile(sid), { ttlMs: this.config.lock.ttlMs });
    if (!lock) {
      return {
        hook: 'SessionEnd',
        status: 'busy',
        systemMessage: '[memory] 另一个 SessionEnd 正在处理本会话（busy），本次跳过。',
      };
    }
    try {
      return await this.#solidify({ sid, transcriptPath, cwd });
    } catch (err) {
      this.#log(`SessionEnd failed: ${err?.message || err}`);
      return {
        hook: 'SessionEnd',
        status: 'error',
        systemMessage: `[memory] 固化失败（${err.code || 'ERROR'}）：${clip(err.message || String(err), 300)}`,
        error: err.message || String(err),
      };
    } finally {
      await lock.release();
    }
  }

  async #solidify({ sid, transcriptPath, cwd }) {
    const journal = new Journal(this.journalFile(sid));
    const j = await journal.load();
    const trace = await this.#readTrace(transcriptPath);
    const transcriptSha = trace.hash;

    // 幂等：同一 transcript 尾部已经固化过
    if (j.status === 'done' && j.transcript_sha && transcriptSha && j.transcript_sha === transcriptSha) {
      return {
        hook: 'SessionEnd',
        status: 'noop',
        systemMessage: '[memory] 该会话本轮已固化且轨迹未变化，跳过。',
      };
    }

    // 崩溃恢复：暂存稿在、校验和一致 -> 直接续跑到清理 + 提交
    let reusable = null;
    const stagedStep = j.steps?.stage;
    if (stagedStep?.path && stagedStep.sha && j.status !== 'done') {
      const stagedText = await readText(stagedStep.path);
      if (stagedText && sha256(stagedText) === stagedStep.sha) {
        reusable = { text: stagedText, sha: stagedStep.sha, path: stagedStep.path };
      } else {
        this.#log(`stage 校验和不匹配，丢弃暂存稿：${stagedStep.path}`);
      }
    }

    await journal.begin({ sessionId: sid, transcriptPath, transcriptSha });

    if (reusable) {
      const doc = parseWorklog(reusable.text);
      return this.#cleanupAndCommit({
        sid,
        journal,
        doc,
        md: reusable.text,
        stagedSha: reusable.sha,
        summary: { state: 'resumed', reasons: [] },
        prevItemCount: doc.items.length,
        prevNegCount: doc.negations.length,
        resumed: true,
        transcriptPath,
        cwd,
      });
    }

    /* -------------------------------------------------- 1. 读旧日志 */

    const prevMd = await this.adapter.readWorklog(sid);
    const prev = parseWorklog(prevMd);
    if (prev.parseErrors.length) {
      await journal.fail('log_tampered', prev.parseErrors.join('|'));
      return {
        hook: 'SessionEnd',
        status: 'log_tampered',
        systemMessage: `[memory] 工作日志结构校验失败，已拒绝固化与清理：${prev.parseErrors.slice(0, 4).join(', ')}`,
        reasons: prev.parseErrors,
      };
    }

    /* --------------------------------------- 2. 廉价微固化（默认路径） */

    const append = appendTrace(prev, trace.block, trace.hash);
    await journal.mark('consolidate', {
      appended: append.appended,
      reason: append.reason || null,
      turns: trace.turns.length,
      hash: trace.hash,
    });

    const turnText = trace.turns.map((t) => `[${t.role}${t.tool ? `:${t.tool}` : ''}] ${t.text}`).join('\n');

    /* ------------------------------------------- 3. 模型总结 + L5 */

    let items = prev.items.map((i) => ({ ...i }));
    let negations = [...prev.negations];
    let summary = { state: 'skipped', reasons: [] };

    if (this.config.summarize.enabled) {
      if (!turnText.trim()) {
        summary = { state: 'skipped', reasons: ['NO_TRANSCRIPT'] };
      } else {
        try {
          const prompt = buildSummaryPrompt(prev, trace.block, { maxItems: this.config.limits.maxItems });
          const raw = await this.adapter.summarize(prompt, {
            maxTokens: this.config.summarize.maxTokens,
            timeoutMs: this.config.summarize.timeoutMs,
          });

          if (typeof raw !== 'string' || !raw.trim()) {
            summary = { state: 'degraded', reasons: ['E_SUMMARY_EMPTY'] };
          } else if (raw.length > this.config.summarize.maxChars) {
            // V1：超长 -> 丢弃摘要，本轮不清理
            summary = { state: 'rejected', reasons: ['E_SUMMARY_TOO_LONG'], chars: raw.length };
          } else {
            const parsed = parseModelOutput(raw);
            const assigned = assignIds(parsed.ops, prev.items);
            const verdict = validateItems({
              prev,
              next: { items: assigned },
              sourceText: turnText,
              sourceTurns: trace.turns.map((t) => t.text),
              limits: this.config.limits,
            });
            if (!verdict.ok) {
              summary = { state: 'rejected', reasons: verdict.reasons };
            } else {
              items = assigned;
              negations = mergeNegations({
                prevNegations: prev.negations,
                prevItems: prev.items,
                nextItems: assigned,
                modelNegations: parsed.negations,
              });
              summary = { state: 'ok', ops: assigned.length };
            }
          }
        } catch (err) {
          summary =
            err instanceof MemoryError
              ? { state: 'rejected', reasons: [err.code], error: err.message }
              : { state: 'degraded', reasons: [err.code || 'E_SUMMARIZE_FAILED'], error: String(err.message || err) };
        }
      }
    }
    await journal.mark('summarize', summary);

    /* ------------------------------------------------------ 4. 暂存 */

    const nextDoc = {
      sessionId: sid,
      goal: prev.goal || this.#deriveGoal(trace.turns),
      items,
      negations,
      rawTrace: prev.rawTrace,
      meta: {
        ...prev.meta,
        sessionId: sid,
        revision: Number(prev.meta.revision || 0) + 1,
        negationCount: negations.length,
        traceHashes: prev.meta.traceHashes || [],
      },
    };
    const md = renderWorklog(nextDoc);
    if (md.length > this.config.worklog.maxChars) {
      await journal.fail('log_too_large', `worklog=${md.length} > ${this.config.worklog.maxChars}`);
      return {
        hook: 'SessionEnd',
        status: 'log_too_large',
        systemMessage: `[memory] 日志超过上限（${md.length} 字符），已中止固化与清理。`,
      };
    }

    const stagedPath = this.stagingFile(sid);
    const staged = await writeTextAtomic(stagedPath, md);
    await journal.mark('stage', {
      path: stagedPath,
      sha: staged.sha,
      bytes: staged.bytes,
      verdict: summary.state,
    });
    await this.#faultPoint('stage');

    return this.#cleanupAndCommit({
      sid,
      journal,
      doc: nextDoc,
      md,
      stagedSha: staged.sha,
      summary,
      prevItemCount: prev.items.length,
      prevNegCount: prev.negations.length,
      resumed: false,
      transcriptPath,
      cwd,
    });
  }

  /* ------------------------------------------------ 5/6. 清理 + 提交 */

  async #cleanupAndCommit({
    sid,
    journal,
    doc,
    md,
    stagedSha,
    summary,
    prevItemCount,
    prevNegCount,
    resumed,
    transcriptPath,
    cwd,
  }) {
    // resumed 也要走清理：续跑的目的就是把上次没跑完的清理补上
    const cleanupAllowed =
      this.config.cleanup.enabled &&
      ['ok', 'skipped', 'resumed'].includes(summary.state);

    let engine = { ok: true, skipped: true, code: 'CLEANUP_DISABLED' };
    if (this.config.cleanup.enabled) {
      if (!cleanupAllowed) {
        engine = { ok: true, skipped: true, code: `SKIPPED_SUMMARY_${String(summary.state).toUpperCase()}` };
      } else {
        // 唯一出口：探测 -> 归属 -> 放行/拒绝 -> 执行 -> 验证 -> 审计
        const g = await this.gate.run({ trigger: 'session_end' });
        engine = g.skipped
          ? { ok: true, skipped: true, code: g.auditCode, auditCode: g.auditCode, state: g.state, probe: g.probe }
          : {
              ok: g.ok,
              code: (g.cleanup && g.cleanup.code) || g.auditCode,
              auditCode: g.auditCode,
              state: g.state,
              result: g.cleanup,
            };
      }
      await journal.mark('cleanup', engine);

      if (!engine.ok) {
        await journal.fail('cleanup_failed', engine.code, { staged_path: this.stagingFile(sid) });
        return {
          hook: 'SessionEnd',
          status: 'cleanup_failed',
          verdict: summary.state,
          engine,
          systemMessage: `[memory] 本地引擎清理失败（${engine.code}）${engine.error ? `：${clip(engine.error, 160)}` : ''}。日志已暂存未提交，下次 SessionEnd 会续跑。`,
        };
      }
    }

    /* ------------------------------------------------------- 提交 */

    const written = await this.adapter.writeWorklog(sid, md);
    const readback = await this.adapter.readWorklog(sid);
    if (sha256(readback) !== stagedSha) {
      await journal.fail('commit_verify_failed', 'readback sha 不一致');
      return {
        hook: 'SessionEnd',
        status: 'commit_verify_failed',
        systemMessage: '[memory] 日志回读校验失败，已中止提交（不会留下半成品日志）。',
      };
    }
    await journal.mark('commit', { sha: stagedSha, path: written.path || this.adapter.worklogFile(sid) });
    await journal.finish({
      summary: summary.state,
      items: doc.items.length,
      negations: doc.negations.length,
    });
    await this.#noteSession(sid, { transcriptPath, cwd, source: 'SessionEnd' });

    const added = doc.items.length - prevItemCount;
    const addedNeg = doc.negations.length - prevNegCount;
    const bits = [`已固化 ${doc.items.length} 条（+${added}）`];
    if (addedNeg > 0) bits.push(`否定 +${addedNeg}`);
    if (summary.state === 'rejected') bits.push(`摘要被拒(${summary.reasons.slice(0, 2).join(',')})，仅落原始轨迹`);
    if (summary.state === 'degraded') bits.push('摘要失败，已降级为原始轨迹');
    if (summary.state === 'resumed') bits.push('已从中断续跑');
    if (engine.skipped) bits.push(`未清理引擎(${engine.code})`);
    else {
      const dropped = engine.result?.dropped;
      bits.push(`引擎已清理(${this.config.engine.provider}${dropped ? `，释放 ${(dropped / 1048576).toFixed(0)}MB` : ''})`);
    }

    return {
      hook: 'SessionEnd',
      status: 'ok',
      verdict: summary.state,
      summary,
      engine,
      items: doc.items.length,
      negations: doc.negations.length,
      resumed,
      logPath: written.path || this.adapter.worklogFile(sid),
      systemMessage: `[memory] ${bits.join(' · ')}`,
    };
  }

  /* ========================================================== SessionStart */

  async onSessionStart(payload = {}) {
    const sid = normalizeSessionId(payload.session_id ?? payload.sessionId);
    if (!sid) return { hook: 'SessionStart', status: 'error', systemMessage: '' };
    const source = String(payload.source || 'startup');
    const cwd = payload.cwd || this.paths.cwd || process.cwd();

    const doc = parseWorklog(await this.adapter.readWorklog(sid));
    let parentDoc = null;
    let parentId = null;
    if (!doc.items.length && !doc.negations.length) {
      parentId = await this.#lineage(sid, payload);
      if (parentId) parentDoc = parseWorklog(await this.adapter.readWorklog(parentId));
    }

    const shared = {
      global: await this.adapter.readSharedMemory('global'),
      project: await this.adapter.readSharedMemory('project', { cwd }),
      native: '',
    };
    try {
      const native = await this.adapter.readNativeMemory?.();
      if (native?.available) shared.native = native.text;
    } catch {
      /* 原生记忆只读且尽力而为，读不到不影响注入 */
    }

    await this.#noteSession(sid, { transcriptPath: payload.transcript_path, cwd, source, parentId });

    const systemMessage = renderAnchors({
      doc,
      parentDoc,
      parentId,
      shared,
      source,
      sessionId: sid,
      worklogPath: this.adapter.worklogFile(sid),
      limits: this.config.inject,
    });

    return {
      hook: 'SessionStart',
      status: 'ok',
      source,
      chars: systemMessage.length,
      items: doc.items.length,
      negations: doc.negations.length,
      // A 方案：只走 SessionStart 专属的 additionalContext，不用 systemMessage
      additionalContext: systemMessage,
    };
  }

  /* ============================================================ PreCompact */

  async onPreCompact(payload = {}) {
    const sid = normalizeSessionId(payload.session_id ?? payload.sessionId);
    if (!sid) return { hook: 'PreCompact', status: 'error', systemMessage: '[memory] 缺少 session_id' };

    const lock = await FileLock.acquire(this.lockFile(sid), { ttlMs: this.config.lock.ttlMs });
    if (!lock) {
      return { hook: 'PreCompact', status: 'busy', systemMessage: '[memory] 会话正在固化中，跳过本次水位。' };
    }
    try {
      const doc = parseWorklog(await this.adapter.readWorklog(sid));
      if (doc.parseErrors.length) {
        return {
          hook: 'PreCompact',
          status: 'log_tampered',
          systemMessage: `[memory] 日志结构校验失败，未写水位：${doc.parseErrors.slice(0, 3).join(', ')}`,
        };
      }

      const trace = await this.#readTrace(payload.transcript_path);
      const append = appendTrace(doc, trace.block, trace.hash);
      doc.meta.precompact = Number(doc.meta.precompact || 0) + 1;
      doc.meta.revision = Number(doc.meta.revision || 0) + 1;
      doc.meta.watermarks = [
        ...(doc.meta.watermarks || []),
        { at: new Date().toISOString(), w: doc.meta.precompact, hash: trace.hash, turns: trace.turns.length },
      ].slice(-20);

      const md = renderWorklog(doc);
      const written = await this.adapter.writeWorklog(sid, md);

      const journal = new Journal(this.journalFile(sid));
      await journal.load();
      await journal.mark('precompact', { w: doc.meta.precompact, hash: trace.hash, appended: append.appended });

      return {
        hook: 'PreCompact',
        status: 'ok',
        watermark: doc.meta.precompact,
        appended: append.appended,
        path: written.path,
        systemMessage: `[memory] PreCompact 水位 W${doc.meta.precompact} 已固化：${written.path}。注意：这不能阻止 Codex 压缩，只是压缩后还能找回的锚点。`,
      };
    } catch (err) {
      return {
        hook: 'PreCompact',
        status: 'error',
        systemMessage: `[memory] 写水位失败：${clip(err.message || String(err), 200)}`,
      };
    } finally {
      await lock.release();
    }
  }

  /* ========================================================== PostToolUse */

  async onPostToolUse(payload = {}) {
    const sid = normalizeSessionId(payload.session_id ?? payload.sessionId) || 'unknown';
    const tool = payload.tool_name || payload.tool || 'tool';
    const output = payload.tool_response ?? payload.tool_output ?? payload.output ?? '';
    const asText = typeof output === 'string' ? output : JSON.stringify(output ?? '');
    const bytes = Buffer.byteLength(asText, 'utf8');
    const threshold = Number(this.config.spill.thresholdBytes ?? 32768);

    if (bytes <= threshold) return { hook: 'PostToolUse', status: 'ok', spilled: false, bytes };

    const dir = path.join(this.paths.spillDir, sid);
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTool = String(tool).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || 'tool';
    const file = path.join(dir, `${stamp}-${safeTool}.txt`);
    const body = [
      `# tool=${tool}`,
      `# session=${sid}`,
      `# bytes=${bytes}`,
      `# captured=${new Date().toISOString()}`,
      '',
      asText,
    ].join('\n');
    await fsp.writeFile(file, body, 'utf8');

    return {
      hook: 'PostToolUse',
      status: 'ok',
      spilled: true,
      bytes,
      path: file,
      // 注意：这里只能落盘备份。PostToolUse 拿不回已经进上下文的 token。
      systemMessage: `[tool output spilled: ${file}] ${bytes} bytes。原始输出已进入上下文，PostToolUse 只能备份，无法撤回。`,
    };
  }

  /* ============================================================== 会话索引 */

  async #noteSession(sid, { transcriptPath = null, cwd = null, source = null, parentId = null } = {}) {
    try {
      const file = this.indexPath();
      const index = (await readJson(file, null)) || { version: 1, sessions: {} };
      const now = new Date().toISOString();
      const entry = index.sessions[sid] || { firstSeen: now, sources: [] };
      entry.lastSeen = now;
      if (transcriptPath) entry.transcript = transcriptPath;
      if (cwd) entry.cwd = cwd;
      if (parentId) entry.parent = parentId;
      if (source && !entry.sources.includes(source)) entry.sources = [...entry.sources, source].slice(-10);
      index.sessions[sid] = entry;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(index, null, 2), 'utf8');
    } catch (err) {
      this.#log(`index 更新失败：${err.message}`);
    }
  }

  async #lineage(sid, payload) {
    const hint = payload.parent_session_id || payload.parentSessionId;
    if (hint) return normalizeSessionId(hint);
    const index = await readJson(this.indexPath(), { sessions: {} });
    const entry = index?.sessions?.[sid];
    if (entry?.parent) return entry.parent;
    if (String(payload.source || '') === 'fork') {
      const sameTranscript = Object.entries(index?.sessions || {}).find(
        ([k, v]) => k !== sid && payload.transcript_path && v.transcript === payload.transcript_path,
      );
      if (sameTranscript) return sameTranscript[0];
    }
    return null;
  }
}
