# codex-memory-cleaner

Codex 本地部署版的「可校验记忆固化 + 本地推理清理」插件。
纯 JS、跨平台、不依赖任何框架；只用 Codex lifecycle hook + 本地推理 HTTP API。

> 和 DSH（进程内插件）版最大的差别：这里**没有** `destroyEngine()` 和 `rebuildSession()`。
> 清理只能通过 HTTP 让引擎卸载模型；会话上下文只能靠 `SessionStart` 的 `systemMessage` 注入锚点。
> 因此本插件**不做**在线重建，也**不做** `n_ctx` / `model_context_window` 的在线修改。

---

## 1. 目录结构

```
codex-memory-cleaner/
├── package.json
├── README.md
├── config.example.json
├── state.js                 # ID 分配 / 迁移白名单 / 差分白名单 / 实体 Jaccard / 锁 / journal
├── worklog.js               # 工作日志解析·渲染·锚点注入、总结 prompt
├── raw-trace.js             # 廉价微固化：rollout JSONL 尾部解析（不调模型）
├── codex-cleaner.js         # 事务编排：SessionEnd / SessionStart / PreCompact / PostToolUse
├── rss.js                   # OS 真实内存测量（VmRSS / vmmap footprint / WorkingSet64）
├── adapters/
│   ├── base.js              # CodexAdapter 契约（读写日志、共享记忆确认机制）
│   ├── ollama.js            # keep_alive:0 + /api/ps + RSS 复核
│   ├── llamacpp.js          # slot erase / --clear-idle 提示
│   ├── lmstudio.js          # 无卸载接口 -> 明确失败，不虚报
│   └── index.js             # provider 注册表
├── hooks/
│   ├── hook-runner.js       # 统一入口（读 stdin JSON -> 输出一行 JSON）
│   ├── session-start.js
│   ├── session-end.js
│   ├── pre-compact.js
│   ├── post-tool-use.js
│   ├── hooks.json           # 注册示例（JSON 形态）
│   └── config.toml.example  # 注册示例（config.toml 形态）
└── test/
    ├── v1-summary-too-long.test.js
    ├── v2-rss-drop.test.js
    ├── v3-cleanup-failure.test.js
    ├── v4-adversarial.test.js
    ├── v5-concurrency.test.js
    ├── v6-crash-recovery.test.js
    ├── worklog.test.js
    ├── raw-trace.test.js
    └── helpers/{fixtures,fake-ollama,fake-engine,child-session-end}
```

---

## 2. 五个硬结构（Codex 形态）

| 结构 | DSH 版 | 本插件 |
| --- | --- | --- |
| 双闸门 | 入口 guard + 计划水位 | `PostToolUse` 后置落盘 + `PreCompact` 水位（**都是降级版**） |
| ID 分配 | 程序分配 | 同：模型只能给 `{status,text,ref_id?}`，带 `id` 直接拒 |
| 否定信息 | `## negations` append-only | 同，且 `negationCount` 做防截断水位 |
| L5 校验 | 迁移白名单+差分白名单+Jaccard | 同（`state.js:validateItems`），另加接地 Jaccard |
| 廉价微固化 | 每轮 append 轨迹 | `SessionEnd`/`PreCompact` 直接读 transcript 尾部 append，不调模型 |

### 2.1 SessionEnd 事务顺序（不可调换）

```
读旧日志 → 廉价轨迹 append → 模型总结 + L5 校验 → 写暂存稿(staging)
        → 清理本地引擎（HTTP + RSS 复核） → 提交日志(worklog) → journal.done
```

- 清理失败 → **不提交**，暂存稿留在 `state/staging/<sid>.md`，下次 SessionEnd 续跑（V3/V6）。
- 摘要超长 / L5 被拒 → 只落原始轨迹，**本轮不清理引擎**（V1）。
- 全程持文件锁 → 并发 SessionEnd 只有一个能跑（V5）。

### 2.2 工作日志格式

```markdown
<!--meta {"v":1,"sessionId":"thr_123","revision":3,"negationCount":2,"traceHashes":["ab12cd34"],"precompact":1,...} -->
# Worklog · thr_123

## goal
实现 codex 清理插件

## entries
- L1 [todo] 实现 adapters/ollama.js 的 keep_alive:0 卸载
- L2 [done] 落盘日志到 worklogs/<sessionId>.md

## negations
- [N1] 不能在线改 model_context_window
- [N2] L3: reason: 放弃 llama.cpp slot API

## 原始轨迹
### 2026-11-14T09:00:00Z [user]
...
```

- `## entries`：只有 `todo / done / decision / dropped` 四种状态，迁移白名单写死在 `state.js`。
- `## negations`：程序只追加；文件里的否定行少于 `meta.negationCount` → `E_LOG_SHRINK`，整轮中止。
- `## 原始轨迹`：按内容 hash 去重，同一段 transcript 重复读到不会重复追加。

---

## 3. 安装与 hook 注册

### 3.1 放到固定位置

```bash
# 任选一个位置，下面以 ~/.codex/memory-cleaner 为例
git clone <repo> ~/.codex/memory-cleaner   # 或直接拷贝目录
node --version   # 需要 >= 20.11（用了 fetch / AbortSignal.timeout）
```

### 3.2 hooks.json 形态

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node \"$HOME/.codex/memory-cleaner/hooks/session-start.js\"", "timeout": 30 }] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node \"$HOME/.codex/memory-cleaner/hooks/session-end.js\"", "timeout": 120 }] }
    ],
    "PreCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node \"$HOME/.codex/memory-cleaner/hooks/pre-compact.js\"", "timeout": 30 }] }
    ],
    "PostToolUse": [
      { "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": "node \"$HOME/.codex/memory-cleaner/hooks/post-tool-use.js\"", "timeout": 30 }] }
    ]
  }
}
```

Windows 把 `$HOME` 换成绝对路径，例如
`node "C:/Users/you/.codex/memory-cleaner/hooks/session-end.js"`。

### 3.3 config.toml 形态

```toml
# ~/.codex/config.toml
# 注意：字段名随 Codex 版本可能不同，以你本机 `codex --help` / hooks 文档为准。
# 下面是「一个命令 + 超时」的最小形态。

[hooks.SessionStart]
command = "node C:/Users/you/.codex/memory-cleaner/hooks/session-start.js"
timeout_sec = 30

[hooks.SessionEnd]
command = "node C:/Users/you/.codex/memory-cleaner/hooks/session-end.js"
timeout_sec = 120

[hooks.PreCompact]
command = "node C:/Users/you/.codex/memory-cleaner/hooks/pre-compact.js"
timeout_sec = 30

[hooks.PostToolUse]
matcher = "mcp__.*"
command = "node C:/Users/you/.codex/memory-cleaner/hooks/post-tool-use.js"
timeout_sec = 30

# 插件不能在线改这个值，只能提示你自己调：
model_context_window = 256000
```

> ⚠️ hook 的输出必须走 stdout 的 JSON `systemMessage` 字段。直接 `print` / `console.log` 文本不会进入上下文，
> 这是 Codex 版最常见的「看起来跑了但没生效」原因。

### 3.4 插件配置

`~/.codex/memory/config.json`（全局）或 `<cwd>/.codex/memory/config.json`（项目）覆盖默认值：

```json
{
  "engine": {
    "provider": "ollama",
    "model": "qwen2.5-coder:7b",
    "endpoint": "http://127.0.0.1:11434",
    "pid": null
  },
  "cleanup": { "enabled": true, "verifyRss": true, "waitMs": 15000, "pollMs": 300 },
  "summarize": { "enabled": true, "maxTokens": 900, "maxChars": 8000 },
  "trace": { "turns": 6, "maxChars": 4000 },
  "spill": { "thresholdBytes": 32768 },
  "inject": { "maxChars": 4000 }
}
```

- `engine.pid`：本地引擎进程号。填了才会做 RSS 复核（不填只看 `/api/ps`）。
- 环境变量覆盖：`CODEX_MEMORY_PROVIDER` / `CODEX_MEMORY_MODEL` / `CODEX_MEMORY_ENDPOINT` /
  `CODEX_MEMORY_ENGINE_PID` / `CODEX_MEMORY_DISABLE_CLEANUP=1` / `CODEX_MEMORY_DISABLE_SUMMARY=1`。
- 查看状态：`node hooks/hook-runner.js status`。

### 3.5 共享记忆（写入必须确认）

```bash
# 1) 模型只能「提议」，落到 state/pending/
# 2) 用户确认后才写进共享层
node hooks/hook-runner.js confirm-memory --scope project --file ./draft.md
node hooks/hook-runner.js confirm-memory --scope global  --file ./profile.md
```

- 全局层：`~/.codex/memory/global.md`
- 工作区层：`<cwd>/.codex/memory/project.md`
- `writeSharedMemory` 没有 `confirmed:true` 一律抛 `E_CONFIRM_REQUIRED`；不存在自动写入路径。

---

## 4. 测试

```bash
cd codex-memory-cleaner
npm test
# 等价于 node --test test/*.test.js
```

单独跑某一条：

```bash
node --test test/v2-rss-drop.test.js
node --test test/v4-adversarial.test.js
```

### 预期结果（本机 Node v24.16.0 / Windows 实测）

```
ℹ tests 28
ℹ pass 28
ℹ fail 0
```

| 用例 | 断言的是什么 | 结果 |
| --- | --- | --- |
| V1 | 总结 9000 字符 > maxChars → `verdict=rejected`，`cleanup` 调用 0 次，日志里没有摘要文本 | 通过 |
| V2 | 假引擎进程常驻 256MB，`keep_alive:0` 后 **WorkingSet64/VmRSS/footprint 真实下降 ≥100MB**（实测 293MB → 37MB） | 通过 |
| V2b | `/api/ps` 仍报常驻 → `STILL_LOADED`，日志不提交 | 通过 |
| V3 | 清理 API 抛错 → `cleanup_failed`，正式日志为空，暂存稿保留；重试续跑成功 | 通过 |
| V4 a/b/c/d | ID 重编号（模型自带 id、文件断号）、状态翻转、两合一、同状态改文本 —— 四种全拒，且清理 0 次 | 通过 |
| V5 | 两个子进程同时 SessionEnd → 一个 `ok` 一个 `busy`，清理计数 = 1 | 通过 |
| V6 | stage 后崩溃（exit 70）→ 重启续跑，`attempt=2`、条目只落一次、轨迹不重复追加 | 通过 |

V2 用的是「假引擎进程 + 假 Ollama」，证伪的是**测量链路 + 卸载语义**。
换成真 Ollama 时把 `engine.endpoint` / `engine.pid` 指过去即可，同一套断言仍然有效。

---

## 5. Codex 版的固有局限（必须知道）

1. **PreCompact 不能阻止压缩。**
   它只是「压缩前通知」。插件能做的是在压缩发生前把轨迹和水位写进 worklog，
   压缩之后靠 `SessionStart` 注入锚点找回。压缩本身照样发生，token 该涨还是涨。

2. **PostToolUse 不能撤回已经进入上下文的输出。**
   这是降级版 `overflow_guard`：只能在 tool result 超过阈值时落盘备份，并回一条
   `[tool output spilled: <path>]` 提醒模型别再重复调用。
   原始输出**那时已经在上下文里了**，插件没有任何办法把它拿回来。

3. **不能在运行时修改 `model_context_window`。**
   它是 Codex `config.toml` 的静态配置。插件只能在 `SessionStart` 的锚点里提示你调，
   不能在线改，也不能像 DSH 版那样启动时反推 + 在线重建 `n_ctx`。

4. **不能重建会话，只能注入锚点。**
   `summarize()` 产出的是「新会话的上下文锚点」，不是压缩后的缓存表示；
   锚点进上下文之后会不会被压缩掉，插件管不了。

5. **KV Cache 不可压缩，只能清理。**
   引擎层面只有「保留」或「丢弃」。清理 = 让本地引擎卸载模型（HTTP），
   代价是下一次请求要重新加载权重（冷启动变慢）。

6. **`session_id` 不是全局唯一。**
   Codex 的 `resume` / `fork` 会复用或派生 session_id。插件做了三件事兜底：
   文件系统安全化、`state/index.json` 记录 transcript/cwd/来源、
   同一段轨迹按内容 hash 去重。但 fork 的父子关系只能尽力推断（`parent_session_id` 或同 transcript）。

7. **本地引擎卸载是异步的。**
   `keep_alive:0` 返回 200 ≠ 内存已经还了。插件会轮询 `/api/ps`，再轮询 RSS，
   两者都过才算 `ok`。只看到 200 就报成功是假释放。

8. **模型总结质量无法保证。**
   L5 只能保证「结构没被偷偷改」和「新条目能在原文找到实体依据」，
   不能保证总结写得对。摘要被拒时日志保留原始轨迹，宁可少一条也不写错一条。

---

## 6. Codex 版无法做的事（清单）

- ❌ 进程内 `destroyEngine()` / `rebuildSession()` —— 没有进程内句柄，只有 HTTP。
- ❌ 在线重建会话 / 在线改 `n_ctx` / 在线改 `model_context_window`。
- ❌ 阻止自动压缩（PreCompact 只是通知）。
- ❌ 撤回已进入上下文的 tool 输出（PostToolUse 只能落盘）。
- ❌ 全局拦截工具输出（只有 `PreToolUse` 能拦，但那时还不知道输出多大）。
- ❌ 压缩 KV Cache 或「保留一部分缓存」。
- ❌ 让 LM Studio 通过 HTTP 卸载模型（没有稳定接口，插件明确返回 `UNSUPPORTED`）。
- ❌ 杀掉 llama.cpp server 回收进程内存（插件不做进程 kill，只清 slot / 提示 `--clear-idle`）。
- ❌ 保证 `session_id` 唯一、保证 fork 的父子关系一定正确。
- ❌ 在没有 transcript 的情况下凭上下文「回忆」出工作日志（没有 transcript 就只写水位/空锚点）。

---

## 7. 设计取舍备忘

- **提交在清理之后**：清理失败时日志不落地 → 不会出现「日志说清理了、实际没清」。
  代价是清理失败那一轮要重跑，暂存稿就是为此保留的。
- **摘要异常不清理**：摘要超长/被拒/模型失败时本轮跳过清理。
  宁可多占一轮内存，也不接受「日志不可信还把引擎清了」。
- **接地检查按「最匹配的一轮」算 Jaccard**：整篇 trace 求 Jaccard 会把正常摘要判死
  （条目只对应其中一两轮）。逐轮取最大值仍然是 Jaccard，但语义是「至少被某一轮支持」。
- **fail-closed**：日志结构坏了（ID 断号、否定缩水）直接中止，不调模型、不清理。
