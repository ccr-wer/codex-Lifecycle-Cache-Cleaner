#!/usr/bin/env node
/**
 * Codex hook: SessionStart
 * payload: {session_id, transcript_path, cwd, hook_event_name:"SessionStart", source:"startup|resume|compact|fork"}
 * 输出: {"systemMessage": "...锚点..."}  <- 只有这个字段能进上下文
 */
import { runHook } from './hook-runner.js';

await runHook('session-start');
