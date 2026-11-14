#!/usr/bin/env node
/**
 * Codex hook: SessionEnd
 * payload: {session_id, transcript_path, cwd, hook_event_name:"SessionEnd", reason}
 *
 * 这里做三件事（顺序固定）：固化工作日志 -> 清理本地推理引擎 -> 提交日志。
 * 清理失败就不提交，暂存稿留给下一次 SessionEnd 续跑。
 */
import { runHook } from './hook-runner.js';

await runHook('session-end');
