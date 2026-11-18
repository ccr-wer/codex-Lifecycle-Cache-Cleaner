# codex-memory-cleaner

Codex 本地部署版的「可校验记忆固化 + 本地推理清理」。纯 JS、无框架依赖，只用 lifecycle hook 与引擎 HTTP API。

与进程内插件版（DSH）的区别：这里没有 `destroyEngine()` / `rebuildSession()`。清理只能让引擎 HTTP 卸载模型，上下文只能靠 `SessionStart` 的 `additionalContext` 注入。因此**不做**在线重建，也**不**在线改 `n_ctx` / `model_context_window`。

## 快速开始

```bash
git clone <repo> ~/.codex/memory-cleaner && cd ~/.codex/memory-cleaner
node --version      # 需要 >= 20.11
npm test            # 37 例，约 5s
```

1. 复制 `config.example.json` 到 `~/.codex/memory/config.json`，至少填 `engine.model`，并把 `engine.owned` 设为 `true`——否则闸门永远判 `foreign`，只审计、不清理。
2. 按「注册（未验证）」把四个 hook 挂上。
3. 跑一次会话后查看 `state/engine-audit.jsonl`，确认判定符合预期。

## 目录结构

```
codex-memory-cleaner/
├── codex-cleaner.js   # 事务编排：SessionEnd / SessionStart / PreCompact / PostToolUse
├── engine-gate.js     # 清理唯一出口：探测 → 归属 → 放行/拒绝 → 执行 → 验证 → 审计
├── state.js           # ID 分配 / 迁移·差分白名单 / 实体 Jaccard / 锁 / journal
├── worklog.js         # 日志解析·渲染·锚点注入、总结 prompt
├── raw-trace.js       # 廉价微固化：rollout JSONL 尾部解析（不调模型）
├── native-memory.js   # 只读导入 ~/.codex/memories
├── rss.js             # 真实内存测量（VmRSS / footprint / WorkingSet64）
├── adapters/          # base 契约 + ollama / llamacpp / lmstudio
├── hooks/             # 四个入口 + hook-runner + 注册示例
└── test/              # v1–v6、worklog、raw-trace、engine-gate、session-start
```

## 工作方式

### SessionEnd 事务（顺序不可调换）

```
读旧日志 → 轨迹 append → 总结 + L5 校验 → staging → 闸门 → 清理(HTTP+RSS)
        → 提交 worklog → journal.done
```

- 清理失败 → 不提交，`state/staging/<sid>.md` 留待下次续跑（V3/V6）。
- 摘要超长 / L5 被拒 → 只落轨迹，本轮不清理（V1）。
- 全程持文件锁，并发 SessionEnd 只有一个能跑（V5）。

### 引擎闸门

| 探测结果 | 引擎写次数 | 审计码 |
|---|---|---|
| `owned_idle` | 1 | `engine_cleaned` / `engine_cleanup_failed` |
| `owned_busy` | 0 | `engine_busy` |
| `foreign`（本机有引擎，但不属于本插件） | 0 | `engine_foreign` |
| `absent`（没部署/没加载） | 0 | `engine_absent` |
| `unknown`（探测缺失/异常） | 0 | `engine_unknown` |

- 归属只认显式声明（`engine.owned: true` 或适配器自证），**不做同名模型推断**；登记在 `state/engine-registry.json`，清理时只做校验。
- 每次判定写 `state/engine-audit.jsonl`，`unknown` 也写——否则线上只能看到「什么都没发生」。
- 只有 `engine-gate.js` 能调 `cleanupLocalEngine`（测试 I6 静态扫描）。
- 拒绝清理时返回 `ok:true, skipped:true`，日志流水线照常提交。

### 工作日志

```markdown
<!--meta {"v":1,"sessionId":"thr_123","revision":3,"negationCount":2,"traceHashes":["ab12cd34"]} -->
# Worklog · thr_123

## goal
实现清理插件

## entries
- L1 [todo] 实现 adapters/ollama.js 的 keep_alive:0 卸载
- L2 [done] 落盘日志到 worklogs/<sessionId>.md

## negations
- [N1] 不能在线改 model_context_window

## 原始轨迹
### 2026-11-14T09:00:00Z [user]
...
```

- `entries` 只有 `todo / done / decision / dropped`，迁移白名单写死在 `state.js`。
- `negations` 只增不减；行数少于 `meta.negationCount` → `E_LOG_SHRINK`，整轮中止。
- `原始轨迹` 按内容 hash 去重，重复读到同一段不会重复追加。

## 注册（本机未验证）

> ⚠️ 实测 `~/.codex/hooks.json` 与 `~/.codex/hooks/hooks.json` 都未触发全局 hook，`codex debug prompt-input` 疑似不跑 hook。
> 下面的形态来自宿主 schema 与存量文档，字段名（`timeout` / `timeout_sec`）与文件位置**未经活体验证**，请先小步试跑再全量挂。

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node \"$HOME/.codex/memory-cleaner/hooks/session-start.js\"", "timeout": 30 }] }],
    "SessionEnd":   [{ "matcher": "", "hooks": [{ "type": "command", "command": "node \"$HOME/.codex/memory-cleaner/hooks/session-end.js\"", "timeout": 120 }] }],
    "PreCompact":   [{ "matcher": "", "hooks": [{ "type": "command", "command": "node \"$HOME/.codex/memory-cleaner/hooks/pre-compact.js\"", "timeout": 30 }] }],
    "PostToolUse":  [{ "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": "node \"$HOME/.codex/memory-cleaner/hooks/post-tool-use.js\"", "timeout": 30 }] }]
  }
}
```

- Windows 把 `$HOME` 换成绝对路径，例如 `node "C:/Users/you/.codex/memory-cleaner/hooks/session-end.js"`。
- 输出必须走 stdout 的 JSON：`SessionStart` 用 `hookSpecificOutput.additionalContext`，其余事件用 `systemMessage`；直接 `print` / `console.log` 文本不生效。
- 另一种形态（`config.toml`）见 `hooks/config.toml.example`。

## 配置

`~/.codex/memory/config.json`（全局）或 `<cwd>/.codex/memory/config.json`（项目，覆盖全局）：

```json
{
  "engine": { "provider": "ollama", "model": "qwen2.5-coder:7b", "endpoint": "http://127.0.0.1:11434", "pid": null, "owned": true },
  "cleanup": { "enabled": true, "verifyRss": true, "waitMs": 15000, "pollMs": 300 },
  "summarize": { "enabled": true, "maxTokens": 900, "maxChars": 8000 },
  "trace": { "turns": 6, "maxChars": 4000 },
  "spill": { "thresholdBytes": 32768 },
  "inject": { "maxChars": 4000 }
}
```

- `engine.pid` 填了才做 RSS 复核（否则只看 `/api/ps`）。
- 环境变量：`CODEX_MEMORY_PROVIDER` / `CODEX_MEMORY_MODEL` / `CODEX_MEMORY_ENDPOINT` / `CODEX_MEMORY_ENGINE_PID`、`CODEX_MEMORY_DISABLE_CLEANUP=1`、`CODEX_MEMORY_DISABLE_SUMMARY=1`。
- 查看状态：`node hooks/hook-runner.js status`。

### 共享记忆（写入必须确认）

```bash
node hooks/hook-runner.js confirm-memory --scope project --file ./draft.md
node hooks/hook-runner.js confirm-memory --scope global  --file ./profile.md
```

全局层 `~/.codex/memory/global.md`，工作区层 `<cwd>/.codex/memory/project.md`。`writeSharedMemory` 没有 `confirmed:true` 一律抛 `E_CONFIRM_REQUIRED`，不存在自动写入路径。宿主原生 `~/.codex/memories` 只读导入（scope=`native`），**永不写回**。

## 测试

```bash
npm test        # 等价于 node --test test/*.test.js
```

本机 Node v24.16.0 / Windows：`tests 37 / pass 37 / fail 0`，约 5s。

| 用例 | 断言 |
|---|---|
| V1 | 摘要 9000 字符 > maxChars → `rejected`，清理 0 次，日志无摘要 |
| V2 | 假引擎常驻 256MB，`keep_alive:0` 后真实内存下降 ≥100MB（实测 293 → 37MB） |
| V2b | `/api/ps` 仍常驻 → `STILL_LOADED`，日志不提交 |
| V3 | 清理抛错 → `cleanup_failed`，暂存稿保留，恢复后重试续跑 |
| V4 | 自带 id / 断号 / 状态翻转 / 两合一 / 同状态改文本 —— 全拒，清理 0 次 |
| V5 | 两个 SessionEnd 并发 → 一个 `ok` 一个 `busy`，清理计数 = 1 |
| V6 | stage 后崩溃 → 续跑 `attempt=2`，条目只落一次 |
| V7 | I1–I6：`absent`/`foreign`/`unknown` 引擎写 0，审计码可区分 |
| V8 | SessionStart 只输出 `additionalContext`；原生记忆只读导入 |

V2 用假引擎 + 假 Ollama，证伪的是**测量链路与卸载语义**；换真 Ollama 时把 `engine.endpoint` / `engine.pid` 指过去，同一套断言仍然有效。

## 局限与不能做的事

1. **PreCompact 能否阻止压缩：未确认。** schema 只有 `continue / stopReason / suppressOutput / systemMessage`，没有 `decision`。插件不依赖它：压缩前落轨迹与水位，压缩后用 `SessionStart` 找补。
2. **hook 注册未验证**（见上节）：字段名与文件位置以目标版本为准。
3. **PostToolUse 撤不回已进入上下文的输出。** 只能落盘备份并回一条 `[tool output spilled: <path>]`；也没有全局拦截（`PreToolUse` 时还不知道输出多大）。
4. **不能在线改 `model_context_window` / `n_ctx`，不能重建会话。** 锚点进上下文之后会不会被压缩掉，插件管不了。
5. **KV Cache 不可压缩。** 只有「保留」或「丢弃」，代价是下次请求冷启动变慢。
6. **卸载是异步的。** 返回 200 ≠ 内存已还，`/api/ps` 与 RSS 都过才算 `ok`；只看到 200 就报成功是假释放。
7. **`session_id` 不全局唯一。** `resume` / `fork` 会复用或派生；插件做文件系统安全化、`state/index.json` 记录、内容 hash 去重，fork 父子关系只能尽力推断。
8. **引擎能力有限。** LM Studio 无稳定卸载接口（返回 `UNSUPPORTED`）；llama.cpp 只清 slot / 提示 `--clear-idle`，不做进程 kill。
9. **总结质量无法保证。** L5 只保证结构与实体接地；被拒时保留原始轨迹，宁可少一条也不写错一条。
10. **没有 transcript 就没有日志。** 只写水位/空锚点，不凭空「回忆」。

## 设计取舍

- **接地按「最匹配的一轮」算 Jaccard**：整篇 trace 求值会把正常摘要判死（条目往往只对应一两轮），逐轮取最大值语义是「至少被某一轮支持」。
- **摘要异常不清理**：宁可多占一轮内存，也不接受「日志不可信还把引擎清了」。

## License

MIT，见 [LICENSE](./LICENSE)。
