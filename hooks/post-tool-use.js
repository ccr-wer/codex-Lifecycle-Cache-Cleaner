#!/usr/bin/env node
/**
 * Codex hook: PostToolUse
 *
 * 这是「降级版 overflow_guard」：不能阻止输出进入上下文，只能在超阈值时落盘备份。
 * 输出里的 [tool output spilled: <path>] 只是提醒模型「别再重复调这个工具，去读文件」。
 */
import { runHook } from './hook-runner.js';

await runHook('post-tool-use');
