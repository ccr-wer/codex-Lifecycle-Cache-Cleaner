#!/usr/bin/env node
/**
 * Codex hook: PreCompact
 *
 * 重要：PreCompact 只是「压缩前通知」，不能阻止压缩。
 * 这里只做廉价微固化（轨迹 append）+ 写水位，绝不调模型、绝不清理引擎。
 */
import { runHook } from './hook-runner.js';

await runHook('pre-compact');
