#!/usr/bin/env node
/**
 * Codex hook: SessionStart
 * payload: {session_id, transcript_path, cwd, hook_event_name:"SessionStart", source:"startup|resume|compact|fork"}
 * 输出: {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
 *       <- 只有 additionalContext 会进入模型上下文（本轮已按 A 方案确认）
 */
import { runHook } from './hook-runner.js';

await runHook('session-start');
