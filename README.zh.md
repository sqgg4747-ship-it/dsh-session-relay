# dsh-session-relay

[English](README.md) | 中文

DSH（DeepSeek Harness）插件。用于在会话之间投递消息、等待目标轮次结束、读取目标会话的事件流。

读取与写入两个方向均经过落盘准入清单（`allowed-targets.json`）校验；文件缺失或 JSON 无法解析时一律拒绝（fail-closed），`denied` 优先于 `targets`。

## 安装

运行环境：Node 20+，DSH `>=0.2.1-rc.3 <0.3.0`。以下三种安装方式效果一致：

```bash
dsh plugin --profile <profile> add dsh-session-relay
dsh plugin --profile <profile> add https://github.com/sqgg4747-ship-it/dsh-session-relay
```

第三种方式无需终端操作：将安装要求发送给任意 Agent，由其在指定的 profile 中完成安装并创建准入清单。

插件仅在 `dsh.profile.bundles` 中登记包名后才会挂载，`dsh plugin add` 会自动写入该项。缺失该登记时仅输出一行 `skipping profile bundle`，包仍存在但不会生效。

卸载：执行 `dsh plugin --profile <profile> remove dsh-session-relay`。手工清理需处理 `dependencies`、`dsh.profile.bundles`、`node_modules/dsh-session-relay` 三处。entry id 为 `session-relay`，以包名 `dsh-session-relay` 写入 `disabled` 不会禁用任何条目。

## 首次使用

准入清单未创建时，四个工具均不可用。

```bash
cd <profile>/node_modules/dsh-session-relay
cp allowed-targets.json.example allowed-targets.json
```

```json
{
  "targets": [{ "id": "session-5c1e0a72-...", "reason": "用户点名过这个会话" }],
  "denied": []
}
```

默认路径位于包目录内，重装或升级时会随包一并被替换。长期使用应将 `allowFile` 指向 `node_modules` 之外的路径。

## 快速上手

```js
session_say({ sessionId: '<B>', text: '执行测试', mode: 'followup', confirm: true })
// { ok: true, messageId: '...', seqAtSend: 128 }
session_wait({ sessionId: '<B>', sinceSeq: 128, timeoutMs: 120000 })
// { turnEnd: { turn: 4, kind: 'completed' }, status: 'idle' }
session_read({ sessionId: '<B>', sinceSeq: 128, kinds: 'reasoning,tool' })
// [ { seq: 129, kind: 'reasoning', text: '...' } ]
```

`seqAtSend` 可直接作为后续 `wait` 与 `read` 的 `sinceSeq`。

`mode` 的三种取值语义如下：`followup` 创建独立的新轮次，不打断目标；`steer` 插入目标当前轮次的下一个 step；`inject` 仅补充上下文，不唤醒目标，因此不会产生可等待的轮次。

## 四个工具

**session_list** — 无参数。列出顶层会话，标注可写 / 禁止 / 未授权，最多 30 条，可写项排在前面。

**session_say**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 是 | 目标会话 id |
| `text` | 是 | 正文。控制字符与双向文本控制符会被移除 |
| `mode` | 否 | 默认 `followup`，其他取值直接拒绝 |
| `confirm` | 看情况 | 本进程内首次向该目标写入时必须为 `true` |

正常返回 `{ ok, messageId, seqAtSend, via, archivedCheck }`。去重窗口内重复提交返回 `duplicate: true`，上一条消息仍在投递中返回 `pending`，触发限流返回 `rateLimited: true` 与 `retryAfterMs`。以上三种情况均以返回值形式出现，不抛出错误。

**session_wait**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 是 | 目标会话 id |
| `sinceSeq` | 否 | 默认取当前 seq，通常传入 `seqAtSend` |
| `timeoutMs` | 否 | 默认 60000，上限 180000；`0` 表示仅查询一次，不等待 |

目标空闲时返回 `turnEnd = { turn, kind }`，`kind` 取值为 `completed` / `error` / `aborted` / `interrupted`。未等到空闲时可能返回 `gone`、`timedOut`、`queuedOnly`、`aborted`、`pollError`、`alreadyIdle`。仅判断 `turnEnd` 是否存在会将部分失败识别为成功。

**session_read**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 是 | 目标会话 id |
| `sinceSeq` | 否 | 开区间起点；省略时从末尾向前取 `limit` 条 |
| `kinds` | 否 | 逗号分隔：`reasoning` `text` `tool` `tool-result` `turn-end` `user` `all` |
| `limit` | 否 | 默认 100，上限 500 |

返回 `[{ seq, time, kind, text }]`，`tool-call` 条目包含完整参数。

## 配置

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `enabledPresets` | `[]` | 限定的 **当前** preset；为空时不限制。当前值取自最后一条 `agent-preset/selected` 事件，不使用创建时的 header 快照 |
| `allowFile` | `index.js` 同目录的 `allowed-targets.json` | 准入清单文件路径 |
| `maxChars` | 8000 | 正文上限，按 UTF-16 码元计 |
| `allowSelf` | `false` | 允许会话向自身写入 |
| `dedupMs` | 60000 | 去重窗口；`0` 关闭去重 |
| `rateLimit` | 30 | 每目标每 60 秒的尝试上限，失败同样计数 |
| `allowedTargets` | `[]` | 内存准入清单；非空时仅允许写入其中目标 |
| `requireConfirmForNewTarget` | `true` | 首次向某目标写入时必须携带 `confirm` |

插件未导出 Config schema。键名拼写错误不会报错，将按默认值运行。

## 限制

- 不提供隐式 resume；目标会话不在线时直接返回错误。
- 仅支持文本，不支持图片与附件。
- 一对一串行投递，不提供并行 fan-out；多目标需由调用方循环处理。
- 去重与限流状态仅保存在内存，进程重启后清空。
- 投递与前置校验为非原子操作，报错时消息可能已入队；重试逻辑需按「可能重复」设计。
- `workspaceRegistry` 不可用时，归档检查为 fail-open，仅在返回中标注 `archivedCheck: unavailable`。
- `session.eventAt` 已标记 deprecated，后续将替换为 `snapshotEvents`。错误文案为中文，非中文环境需注意。

## 排障

- `skipping profile bundle`：`dsh.profile.bundles` 中缺少该包名。重新执行 `dsh plugin add`，或手动补登条目。
- 所有调用返回未授权错误：首先确认准入清单文件存在且可解析；文件缺失与 JSON 损坏的报错文案相同。
- `ERR_MODULE_NOT_FOUND`：包不在 DSH 的模块解析路径内。使用 `dsh plugin add` 重新安装，并保持安装目录不变。
- `tool "session_say" is already registered`：同一插件注册了两次。移除其中一份后重启宿主。

MIT，见 [LICENSE](LICENSE)。
