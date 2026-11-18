#!/usr/bin/env node
/**
 * hooks/hook-runner.js — Codex hook 的统一入口。
 *
 * 铁律（Codex 版最容易翻车的地方）：
 *  - SessionStart 的上下文注入只能走 hookSpecificOutput.additionalContext；
 *    systemMessage 只当「给用户看的提示」，不承担注入。
 *  - hook 进程永远 exit 0：固化失败也不能把用户的会话搞崩，错误写 state/hook-errors.log。
 *  - stdout 只许出现一行 JSON，调试信息走 stderr 或日志文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { CodexCleaner, mergeConfig } from '../codex-cleaner.js';
import { defaultPaths, readJsonSync } from '../state.js';
import { createAdapter } from '../adapters/index.js';

export const EVENT_HANDLERS = Object.freeze({
  'session-start': 'onSessionStart',
  'session-end': 'onSessionEnd',
  'pre-compact': 'onPreCompact',
  'post-tool-use': 'onPostToolUse',
});

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _unparsed: raw };
  }
}

export function loadConfig({ cwd = process.cwd(), home = os.homedir(), env = process.env } = {}) {
  let cfg = {};
  for (const file of [
    path.join(home, '.codex', 'memory', 'config.json'),
    path.join(cwd, '.codex', 'memory', 'config.json'),
  ]) {
    const j = readJsonSync(file, null);
    if (j) cfg = mergeConfig(cfg, j);
  }

  const engine = { ...(cfg.engine || {}) };
  if (env.CODEX_MEMORY_PROVIDER) engine.provider = env.CODEX_MEMORY_PROVIDER;
  if (env.CODEX_MEMORY_MODEL) engine.model = env.CODEX_MEMORY_MODEL;
  if (env.CODEX_MEMORY_ENDPOINT) engine.endpoint = env.CODEX_MEMORY_ENDPOINT;
  if (env.CODEX_MEMORY_ENGINE_PID) engine.pid = Number(env.CODEX_MEMORY_ENGINE_PID);
  cfg.engine = engine;

  if (env.CODEX_MEMORY_DISABLE_CLEANUP === '1') {
    cfg.cleanup = { ...(cfg.cleanup || {}), enabled: false };
  }
  if (env.CODEX_MEMORY_DISABLE_SUMMARY === '1') {
    cfg.summarize = { ...(cfg.summarize || {}), enabled: false };
  }

  return { ...cfg, home, cwd };
}

export function buildCleaner(config) {
  const paths = config.paths || defaultPaths({ home: config.home, cwd: config.cwd });
  const adapter = createAdapter({ ...config, paths });
  const cleaner = new CodexCleaner({ adapter, config, paths });
  return { cleaner, adapter, paths };
}

function appendErrorLog(paths, event, err) {
  try {
    const file = path.join(paths.stateDir, 'hook-errors.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${new Date().toISOString()} ${event} ${err?.stack || err?.message || err}\n`,
      'utf8',
    );
  } catch {
    /* 日志写不进去也不能影响 hook 退出 */
  }
}

/**
 * 把 cleaner 结果转成宿主 hook 的 wire 格式。
 * A 方案：SessionStart 只输出 hookSpecificOutput.additionalContext，
 * 其他事件仍用 systemMessage（用户可见提示，不承担上下文注入）。
 */
export function toWireOutput(event, out) {
  if (!out) return {};
  if (event === 'session-start' && typeof out.additionalContext === 'string') {
    return {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: out.additionalContext },
    };
  }
  const { additionalContext, ...rest } = out;
  return rest;
}

export async function runHook(event, { argv = process.argv.slice(2) } = {}) {
  const handler = EVENT_HANDLERS[event];
  if (!handler) throw new Error(`unknown hook event: ${event}`);

  const payloadArgIdx = argv.indexOf('--payload');
  const payload = payloadArgIdx >= 0 ? JSON.parse(argv[payloadArgIdx + 1] || '{}') : await readStdin();
  const cwd = payload.cwd || process.cwd();
  const config = loadConfig({ cwd });

  let paths = null;
  try {
    const built = buildCleaner(config);
    paths = built.paths;
    const out = await built.cleaner[handler](payload);
    if (process.env.CODEX_MEMORY_DEBUG === '1') {
      process.stderr.write(`[codex-memory] ${event} ${JSON.stringify(out?.status)}\n`);
    }
    process.stdout.write(`${JSON.stringify(toWireOutput(event, out))}\n`);
    return out;
  } catch (err) {
    const fallbackPaths = paths || defaultPaths({ home: config.home, cwd });
    appendErrorLog(fallbackPaths, event, err);
    const out = {
      hook: event,
      status: 'error',
      systemMessage: `[memory] hook ${event} 执行失败：${String(err?.message || err).slice(0, 300)}`,
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return out;
  }
}

/* --------------------------------------------------------------- CLI 子命令 */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      out[k] = next && !next.startsWith('--') ? (i += 1, next) : true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function cmdStatus(argv) {
  const args = parseArgs(argv);
  const cwd = args.cwd || process.cwd();
  const config = loadConfig({ cwd });
  const { paths } = buildCleaner(config);
  const journalDir = path.join(paths.stateDir, 'journal');
  const journals = [];
  try {
    for (const name of fs.readdirSync(journalDir)) {
      if (!name.endsWith('.json')) continue;
      const j = readJsonSync(path.join(journalDir, name), null);
      if (j) journals.push({ session: j.session_id, status: j.status, attempt: j.attempt, error: j.last_error });
    }
  } catch {
    /* 没有 journal 目录就是还没跑过 */
  }
  const out = {
    node: process.version,
    platform: process.platform,
    paths,
    config: {
      engine: config.engine,
      cleanup: config.cleanup,
      summarize: config.summarize,
    },
    journals,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

async function cmdConfirmMemory(argv) {
  const args = parseArgs(argv);
  const scope = args.scope === 'global' ? 'global' : 'project';
  const file = args.file;
  if (!file || file === true) {
    process.stderr.write('usage: confirm-memory --scope project|global --file <path> [--cwd <dir>]\n');
    process.exit(2);
  }
  const config = loadConfig({ cwd: args.cwd || process.cwd() });
  const { adapter } = buildCleaner(config);
  const content = fs.readFileSync(file, 'utf8');
  const r = await adapter.writeSharedMemory(scope, content, {
    confirmed: true,
    confirmationId: `cli:${Date.now()}`,
    cwd: args.cwd || process.cwd(),
  });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
}

async function main(argv) {
  const [event, ...rest] = argv;
  if (event === 'status') return cmdStatus(rest);
  if (event === 'confirm-memory') return cmdConfirmMemory(rest);
  if (EVENT_HANDLERS[event]) return runHook(event, { argv: rest });

  process.stderr.write(
    `usage: hook-runner <session-start|session-end|pre-compact|post-tool-use|status|confirm-memory>\n`,
  );
  process.exit(2);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[codex-memory] fatal: ${err?.message || err}\n`);
    process.stdout.write(`${JSON.stringify({ status: 'error', systemMessage: `[memory] ${err?.message || err}` })}\n`);
    process.exitCode = 0; // hook 永不非零退出
  });
}
