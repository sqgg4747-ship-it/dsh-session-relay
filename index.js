/**
 * dsh-session-relay —— 跨会话消息 v2（列会话 / 发消息 / 精确等待）
 *
 * ═══ 源码依据（全部实读 asar，不是猜测）═══
 *
 * ① 邻接检查只在 `subagents.sendMessage` 一处：
 *      dsh-subagent/lib/index.js:1661 `authorizeLineage()`
 *    Agent 层 `send/steer/followup/inject`（dsh-agent-loop/lib/index.js:800-814）
 *    **无 sender 参数、无 parent 校验、无 registry 查询**。
 *
 * ② `agents.get(id)`（dsh-agent/lib/index.js:596）= `store.get(id)?.agent`，
 *    store 是扁平 Map，**无权限判断**。
 *
 * ③ 消息用 DSH 原生 agent-message 形状（dsh-subagent `agentMessageSource`）：
 *      { kind:'agent-message', form:'relay', senderSessionId }
 *
 * ④ 消息工厂（dsh-llm `createMessage`）只做：
 *      deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))
 *    → 「优先 import 官方工厂、失败降级手工构造」两条路结构等价。
 *
 * ⑤ inbox 写入 = `session.append("agent/inbox/spliced")`（append-only），自带两道保护：
 *      projection 未注册 → `current()` throw；message.id 重复 → throw。
 *
 * ⑥ **等待判据（v2 新增，实测得出）**：
 *      `session.events` **不存在**（v1 的假设是错的）；
 *      `session.seq` 存在且单调递增（实测探针 session.seq = 127）；
 *      `agent.status` ∈ {'idle','running'}。
 *    → 精准等待 = 「seq 增长」且「status 回到 idle」。
 *
 * ═══ v2 稳定性加固（针对长期任务）═══
 *   · **去重**：同 target + 同文本，`dedupMs`（默认 60s）内重复 → 不重发，返回原 messageId
 *     （防 agent 重试造成重复注入 —— 生态里 8 个同类插件都做了这件）
 *   · **限流**：同 target 60s 内最多 `rateLimit` 条（默认 30），超出硬拒
 *   · **拒归档 / 拒 subagent 会话**：这两类目标要么 UI 不可操作，要么注定失败
 *   · **精准等待**：`session_wait` 轮询 `session.seq`，替代盲目 sleep
 *   · 只 inject ['tools']，不硬依赖 agents；不碰 preset / patch / package.json
 *
 * ═══ 已知边界（诚实声明）═══
 *   · resume 后的 header 只有 7 个键（agentPreset/createdAt/cwd/delegationDepth/id/isSeeded/version），
 *     **没有 title / origin / archived** → 守卫在字段缺失时按"不拦截"处理（fail-open），
 *     所以归档/subagent 拦截只在 header 带这些字段时生效。
 *   · 去重与限流状态在内存里，宿主重启即清空（可接受：重启后不会立刻重复）。
 *   · 不做隐式 resume：目标不在线就报错，避免悄悄启动会话。
 */

import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 插件自身目录 —— 用来把白名单定位到「与 index.js 同目录」，
 * 而不是硬编码某个绝对路径。否则换台机器/换个安装位置就找不到文件，
 * 插件会 fail-closed，表现为「装上了但一个字都发不出去」。
 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-session-relay'
export const inject = ['tools']

const MODES = ['followup', 'steer', 'inject']
const DEFAULT_MAX_CHARS = 8000
const DEFAULT_DEDUP_MS = 60_000
/**
 * 每分钟每目标的**尝试**上限（注意：失败尝试也计数 —— 否则目标持续拒收时没有刹车）。
 * 10 太低：正常重试几次就会撞上自己的限流。30 在"刹住死循环"和"不误伤"之间。
 */
const DEFAULT_RATE_LIMIT = 30
const RATE_WINDOW_MS = 60_000
const WAIT_POLL_MS = 250
const WAIT_MAX_MS = 180_000

/**
 * ⚠️ 去重表与发送记录**不再是模块级常量**，改为在 apply() 里 new 出来（每个实例一份）。
 *
 * 为什么：ESM 按 URL 缓存 —— `import()` 同一路径返回同一个模块对象，
 * 所以模块级状态会**跨重新安装存活**。后果：卸载再装（热重载）后，新实例看见旧实例
 * 留下的去重条目 → 60s 内发同一句被判 duplicate，**消息被静默吞掉**（审计 P3）。
 * 做成 per-instance 后，重新安装即是一张干净的表。
 *
 * 这里只保留类型注释，实例由 apply() 创建并传给 pruneSendLog。
 */

let _factory
let _factoryTriedAt = 0
const FACTORY_RETRY_MS = 60_000
/**
 * 懒加载官方工厂。
 * ⚠️ 失败后不能永久放弃：宿主升级/补装依赖后应当能自愈（审计 F06）。
 *    所以按时间退避重试，而不是一个布尔永久锁死。
 */
async function getFactory() {
  if (_factory) return _factory
  const now = Date.now()
  if (_factoryTriedAt !== 0 && now - _factoryTriedAt < FACTORY_RETRY_MS) return null
  _factoryTriedAt = now
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    _factory = typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null
  } catch {
    _factory = null
  }
  return _factory
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const k of Object.keys(o)) deepFreeze(o[k])
  }
  return o
}

async function buildMessage({ senderId, text }) {
  const content = [
    { type: 'text', text: `Agent ${senderId} sent a message: ` },
    { type: 'text', text },
  ]
  const source = { kind: 'agent-message', form: 'relay', senderSessionId: senderId }
  const manual = () => ({
    message: deepFreeze(structuredClone({ role: 'user', content, source, id: randomUUID() })),
    via: 'manual',
  })

  // ⚠️ 官方工厂"能 import 到"才是常态，所以这条路是线上主路径，必须容错：
  //    ① factory 自己抛 → 降级 manual（旧代码没 try，直接报"投递失败"）
  //    ② factory 返回 null/无 id → 也降级，否则后面读 message.id 抛 TypeError，
  //       而消息其实已经投递成功 → 去重占位永远卡在 pending（审计 F02/F07/F08）。
  const factory = await getFactory()
  if (factory) {
    try {
      const built = factory({ content, source })
      if (built && typeof built === 'object' && typeof built.id === 'string' && built.id !== '') {
        return { message: built, via: 'createUserMessage' }
      }
    } catch {
      /* 落到 manual */
    }
  }
  return manual()
}

/**
 * 硬白名单：只有 allowed-targets.json 里 targets 列出的会话才允许写入。
 *
 * 为什么不用纯 Config / 纯 confirm 参数：
 *   - Config 在 profile patch 里，改一次要动架构；
 *   - confirm 是个布尔参数，调用方（也就是我）随手就能传 true —— 实际已经因此犯过三次错。
 *   - 所以用**落盘文件**做真值源：加入一个目标 = 一次有痕迹的文件编辑，用户可随时 audit。
 *
 * 每次调用都按 mtime 重新读，改文件即刻生效（不需要重载插件）。
 */
/**
 * 白名单默认位置 = **插件自身目录**下的 allowed-targets.json。
 * ⚠️ 不能写死绝对路径：换台机器/换个安装位置就找不到文件，
 *    而策略是 fail-closed → 表现为「装上了但一个字都发不出去」。
 *    需要换位置时用 config.allowFile 覆盖。
 */
const ALLOW_FILE = join(PLUGIN_DIR, 'allowed-targets.json')
/** 由 apply() 从 config.allowFile 覆盖（便于换路径 / 测试指向临时文件；默认用真实文件） */
let _allowFilePath = ''
let _allowCache = { key: '', targets: null, denied: null, error: null }

function readAllowlist() {
  const file = _allowFilePath || ALLOW_FILE
  const empty = (missing) => ({
    key: '',
    targets: new Set(),
    denied: new Set(),
    missing,
    file,
    error: null,
  })
  try {
    const st = statSync(file)
    const key = file + '|' + String(st.mtimeMs)
    if (_allowCache.key === key) return _allowCache
    // ⚠️ 必须剥 BOM：Windows 记事本"UTF-8"默认带 BOM，会导致 JSON.parse 报
    //    `Unexpected token '﻿'`，用户完全看不出是编码问题（可移植性审计 #5）。
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    // 空文件/纯空白 = 空名单（还没填），不是"损坏"。
    if (raw.trim() === '') {
      _allowCache = empty(false)
      _allowCache.key = key
      _allowCache.file = file
      return _allowCache
    }
    const j = JSON.parse(raw)
    const targets = new Set(
      Array.isArray(j && j.targets) ? j.targets.map((t) => String(t && t.id ? t.id : t)) : [],
    )
    const denied = new Set(
      Array.isArray(j && j.denied) ? j.denied.map((t) => String(t && t.id ? t.id : t)) : [],
    )
    _allowCache = { key, targets, denied, missing: false, file, error: null }
    return _allowCache
  } catch (e) {
    const code = e && e.code
    // ⚠️ 「文件不存在」≠「文件损坏」：不存在意味着**还没配置**（首装常态），
    //    此时返回空名单 —— 效果仍是全拒（安全等价），但工具本身可用、错误可读、
    //    用户能照着指引把文件建起来。若当成 fatal error，全新安装就变成"坏包"
    //    （可移植性审计 S2）。
    if (code === 'ENOENT') return empty(true)
    _allowCache = {
      key: '',
      targets: null,
      denied: null,
      missing: false,
      file,
      error: String((e && e.message) || e),
    }
    return _allowCache
  }
}

function serviceOf(ctx) {
  const svc = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (!svc || typeof svc.get !== 'function' || typeof svc.list !== 'function') {
    throw new Error('agents 服务不可用：无法读取会话注册表')
  }
  return svc
}

/**
 * session.seq 的安全读取。
 * 实测：seq 是「下一个待分配的序号」—— 若 seq=133，则最后一条事件是 eventAt(132)。
 */
function seqOf(agent) {
  try {
    const s = agent && agent.session
    if (!s) return null
    const v = s.seq
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}

/** 读最后一条事件的 {type, seq, data}；读不到返回 null（绝不 throw） */
function lastEventOf(agent) {
  try {
    const s = agent && agent.session
    if (!s || typeof s.eventAt !== 'function') return null
    const cur = s.seq
    if (typeof cur !== 'number' || cur <= 1) return null
    const ev = s.eventAt(cur - 1)
    if (!ev) return null
    return { type: ev.type, seq: ev.seq, data: ev.data }
  } catch {
    return null
  }
}

/** 读 header；读不到返回 {}（绝不 throw） */
function headerOf(agent) {
  try {
    return (agent && agent.session && agent.session.header) || {}
  } catch {
    return {}
  }
}

/** 是非 null 对象 */
function isObj(v) {
  return v !== null && typeof v === 'object'
}

/**
 * 安全转字符串：JSON.stringify 遇到循环引用会 throw，
 * 而 header.origin 的形态不受我们控制（审计 A29）。这里永不 throw。
 */
function safeStr(v) {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    const s = JSON.stringify(v)
    return s === undefined ? String(v) : s.length > 120 ? s.slice(0, 120) + '…' : s
  } catch {
    return '[unserializable ' + typeof v + ']'
  }
}

/** 从 content blocks 取纯文本；图片折叠成 [图片]，读不到返回 '' */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const out = []
  for (const b of blocks) {
    if (!isObj(b)) continue
    if (b.type === 'text') out.push(b.text || '')
    else if (b.type === 'image') out.push('[图片]')
  }
  return out.join('')
}

/** 从 turn/end 事件里提取一个精简的「这轮怎么结束的」 */
function turnEndSummary(ev) {
  if (!ev || ev.type !== 'turn/end') return null
  const d = ev.data || {}
  const r = d.reason || {}
  const out = { turn: d.turn, kind: r.kind }
  if (r.kind === 'error' && r.error) {
    out.error = { message: r.error.message, code: r.error.code }
  }
  if (r.kind === 'aborted' && r.reason) out.aborted = r.reason
  return out
}

function view(a) {
  const h = headerOf(a)
  return {
    id: a.id,
    // ⚠️ header 里**没有 title、没有 archived**（实测只有 7 个键），这两个字段取不到就是空，
    //    不能假装有（旧版 session_list 的"标题"永远是空的，归档判断也是死代码）。
    preset: typeof h.agentPreset === 'string' ? h.agentPreset : '',
    origin: h.origin === undefined ? null : h.origin,
    status: typeof a.status === 'string' ? a.status : '',
    seq: seqOf(a),
  }
}

/**
 * 清理过期状态。
 * ⚠️ 去重条目的 TTL 必须由 dedupMs 推导，不能用固定常量：
 *    若固定 5 分钟而 dedupMs 配成 10 分钟，条目会在生效期内被删掉 → 配置静默失效（审计 P1-5）。
 *    同时保留一个下限，避免 dedupMs=0 时条目永不过期导致内存增长。
 */
/**
 * 清理过期状态。实例级状态由 apply() 传入（见上方说明：模块级会被 ESM 缓存跨重装带过来）。
 * ⚠️ 去重条目的 TTL 必须由 dedupMs 推导，不能用固定常量：
 *    若固定 5 分钟而 dedupMs 配成 10 分钟，条目会在生效期内被删掉 → 配置静默失效。
 * ⚠️ prune 也必须受 dedupOn 约束：dedupMs=0 的实例不该去清别人的条目（跨实例 TTL 被缩短）。
 */
function pruneSendLog(state, now, dedupMs) {
  const { sendLog, dedupTable, dedupOn } = state
  while (sendLog.length > 0 && now - sendLog[0].at > RATE_WINDOW_MS) sendLog.shift()
  if (!dedupOn) return
  const ttl = Math.max(Number.isFinite(dedupMs) ? dedupMs : 0, 60_000)
  for (const [k, v] of dedupTable) {
    if (now - v.at > ttl) dedupTable.delete(k)
  }
}

export function apply(ctx, config) {
  // 白名单文件路径可由 config.allowFile 覆盖（默认真实文件）。
  if (config && typeof config.allowFile === 'string' && config.allowFile !== '') {
    _allowFilePath = config.allowFile
  }
  const maxChars =
    config && Number.isFinite(config.maxChars) && config.maxChars > 0
      ? Math.trunc(config.maxChars)
      : DEFAULT_MAX_CHARS
  const allowSelf = !!(config && config.allowSelf === true)
  const dedupMs =
    config && Number.isFinite(config.dedupMs) && config.dedupMs >= 0
      ? Math.trunc(config.dedupMs)
      : DEFAULT_DEDUP_MS
  const rateLimit =
    config && Number.isFinite(config.rateLimit) && config.rateLimit > 0
      ? Math.trunc(config.rateLimit)
      : DEFAULT_RATE_LIMIT

  /**
   * 目标准入：只有用户明确点名过的会话才允许写入，防止"从列表里随手挑一个"就发。
   *
   * 设计前提：调用方拿到的是"能看见的会话列表"，不是"有权写入的会话列表"。
   * 宿主不提供这层判断 —— agents.get 无权限检查，agent 层也没有发送者概念 ——
   * 所以"列表里出现"和"我有权往里写"必须由本插件分开。
   *
   * 两道闸：
   *  ① allowedTargets 非空 → 硬白名单，不在名单里一律拒（默认空 = 不启用）
   *  ② requireConfirmForNewTarget（默认 true）→ 本进程内第一次给某个会话发消息，
   *     必须显式带 confirm:true。强制"新目标 = 一次有意识的动作"，而不是列表里顺手挑。
   */
  const allowedTargets = Array.isArray(config && config.allowedTargets)
    ? config.allowedTargets.map(String).filter((s) => s !== '')
    : []
  const requireConfirmForNewTarget = !(config && config.requireConfirmForNewTarget === false)
  /** 本进程内已确认过的目标 */
  const vouchedTargets = new Set()

  // ── 实例级状态（不要提到模块级，理由见文件上方注释）──
  /** 去重表：键 → { id, at, pending } */
  const dedupTable = new Map()
  /** 发送/尝试记录：[{ target, id, at }]，滑动窗口限流用 */
  const sendLog = []

  /**
   * 只允许这些 preset 的会话使用本插件（默认只有创造模式 cordis）。
   *
   * 为什么在插件内部做、而不是在 preset 里加减插件：
   *   preset 的 config 是**整块替换、永不深合并**，要在 preset-cordis 里加一个插件，
   *   就得把它的全部插件重述一遍 —— 漏一个就少一批工具，风险远大于收益。
   *   所以做成"工具到处都在、但只在允许的 preset 里能用"。
   *
   * 判据来自 `agent.session.header.agentPreset`（resume 后 header 只剩 7 个键，
   * agentPreset 仍在其中，实测可用）。
   *
   * ⚠️ 默认必须是 `[]`（不限制），不能是 `['cordis']`：
   *    DSH 发行版的**默认 preset 是 `standard`**（asar dsh-web-app/cordis.patch.yml:594），
   *    若默认只认 `cordis`，别人装完开新会话 → 四个工具**全部**报"只在 cordis 模式下可用"
   *    → 表现为"装了完全不能用"。要收紧请在 config 里显式写 enabledPresets。
   */
  const enabledPresets = Array.isArray(config && config.enabledPresets)
    ? config.enabledPresets.map(String).filter((s) => s !== '')
    : []

  function requirePreset(exec) {
    const h = headerOf(exec && exec.agent)
    const preset = typeof h.agentPreset === 'string' ? h.agentPreset : ''
    if (enabledPresets.length === 0) return preset // 空列表 = 不限制
    if (!enabledPresets.includes(preset)) {
      throw new Error(
        `本插件只在 ${enabledPresets.join(' / ')} 模式下可用，当前会话是「${preset || '未知'}」。\n` +
          '（工具在别的模式里也会出现，但会被这里拒绝。）',
      )
    }
    return preset
  }

  // ── 工具 1：session_list ──────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'session_list',
        description:
          '列出本机所有在线会话（id / preset / 状态 / seq）。seq 是会话当前序号，配合 session_wait 用来精确等待。',
        // ⚠️ 必须是原生 JSON Schema：ctx.tools.register 不编译作者方言（只有 defineTool 才编译）
        // 无参工具也补全 required:[] + additionalProperties:false，与其余三个工具形态一致
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        output: {
          schema: { type: 'array' },
          render(_args, value) {
            const rows = Array.isArray(value) ? value : []
            if (rows.length === 0) return [{ type: 'text', text: '（当前没有在线会话）' }]
            const lines = rows.map(
              (r) =>
                `- ${r.allowed ? '【可写】' : r.denied ? '【禁止】' : '【未授权】'} ${r.id}\n` +
                `  preset=${r.preset || '(空)'}  status=${r.status || '?'}  seq=${r.seq ?? '?'}` +
                (r.origin ? `  origin=${r.origin}` : ''),
            )
            return [{ type: 'text', text: `在线会话 ${rows.length} 个：\n${lines.join('\n')}` }]
          },
        },
        async execute(_args, exec) {
          requirePreset(exec)
          // 给每一行标注"是否在白名单里"：这样我自己一眼能看到哪些能写、哪些绝对不能碰，
          // 不用再去猜"这个会话是不是用户点名过的"。
          const allow = readAllowlist()
          const svc = serviceOf(ctx)
          // 优先用 roots()：只列顶层会话，不含 subagent（它们的 id 还不带 session- 前缀）。
          let agents
          try {
            agents = typeof svc.roots === 'function' ? svc.roots() : svc.list()
          } catch {
            agents = svc.list()
          }
          const rows = agents.map((a) => {
            const v = view(a)
            v.allowed = !!(allow.targets && allow.targets.has(a.id))
            v.denied = !!(allow.denied && allow.denied.has(a.id))
            return v
          })
          // 可写的排前面，然后按 seq 从大到小（越活跃越靠前）
          rows.sort((x, y) => {
            const ax = x.allowed ? 0 : x.denied ? 2 : 1
            const ay = y.allowed ? 0 : y.denied ? 2 : 1
            if (ax !== ay) return ax - ay
            return (y.seq || 0) - (x.seq || 0)
          })
          return rows.slice(0, 30)
        },
      }),
    'dsh-session-relay: session_list',
  )

  // ── 工具 2：session_say ───────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'session_say',
        description:
          '给指定会话发一条消息。mode=followup(默认，排独立新轮) / steer(插入当前轮的下一个 step) / inject(只补上下文不唤醒)。自动去重与限流。',
        // ⚠️ 原生 JSON Schema（register 不编译作者方言）
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: '目标会话 id' },
            text: { type: 'string', description: '消息正文' },
            mode: {
              type: 'string',
              enum: ['followup', 'steer', 'inject'],
              description: 'followup（默认）| steer | inject',
            },
            confirm: {
              type: 'boolean',
              description:
                '首次向某个会话发消息时必须置 true。用于防止从会话列表里"顺手挑一个"就发 —— 列表里出现不等于有权写入。',
            },
          },
          required: ['sessionId', 'text'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render(_args, value) {
            const v = value || {}
            // ⚠️ pending 必须渲染成"没发"，不能落到下面的"已投递"分支
            if (v.rateLimited) {
              return [
                {
                  type: 'text',
                  text:
                    `⛔ 未发送（限流）→ ${v.sessionId}\n` +
                    `${v.windowMs / 1000}s 内已尝试 ${v.attemptsInWindow} 次（上限 ${v.rateLimit}）\n` +
                    `建议 ${Math.ceil((v.retryAfterMs || 0) / 1000)}s 后重试。`,
                },
              ]
            }
            if (v.pending) {
              return [
                {
                  type: 'text',
                  text:
                    `⏳ 未发送（同一文本的上一条仍在投递中）→ ${v.sessionId}\n` +
                    `距上次 ${v.ageMs}ms（去重窗口 ${v.dedupMs}ms）\n` +
                    `这条**没有发出去**；稍后重试即可（shouldRetry=true）。`,
                },
              ]
            }
            if (v.duplicate) {
              return [
                {
                  type: 'text',
                  text: `未重发（重复消息）→ ${v.sessionId}\n原 messageId=${v.messageId}  距上次 ${v.ageMs}ms（去重窗口 ${v.dedupMs}ms）`,
                },
              ]
            }
            return [
              {
                type: 'text',
                text:
                  `已投递 → ${v.sessionId}\n` +
                  `mode=${v.mode}  messageId=${v.messageId}  via=${v.via}\n` +
                  `发送时状态=${v.statusAtSend}  seq=${v.seqAtSend ?? '?'}\n` +
                  `来源标记：从 ${v.senderSessionId} 发出（agent-message / relay）`,
              },
            ]
          },
        },
        async execute(args, exec) {
          const svc = serviceOf(ctx)
          requirePreset(exec)
          const sender = exec && exec.agent
          if (!sender || typeof sender.id !== 'string' || sender.id === '') {
            throw new Error('无法确定发送者：exec.agent 缺失')
          }
          const myId = sender.id

          // ⚠️ 必须是 string：`String(["t1"])` = "t1" 会让数组参数"看起来合法"并真的投递（审计 A09）。
          //    sessionId 还会原样回显进错误信息，10KB 的串会污染上下文（审计 A05），故统一限长。
          if (args && args.sessionId !== undefined && typeof args.sessionId !== 'string') {
            throw new Error(
              `sessionId 必须是字符串，收到 ${Array.isArray(args.sessionId) ? 'array' : typeof args.sessionId}`,
            )
          }
          const sessionId = String((args && args.sessionId) || '').trim()
          if (sessionId === '') throw new Error('sessionId 不能为空')
          if (sessionId.length > 200) {
            throw new Error(`sessionId 过长（${sessionId.length} 字符）：${sessionId.slice(0, 40)}…`)
          }
          // ══ 第一道闸：硬白名单（fail-closed）══
          // 这是防止"给用户没要求过的会话发消息"的**唯一真闸**。
          // 调用方拿到的是"能看见的会话列表"，不是"有权写入的会话列表"——这两者必须分开。
          const allow = readAllowlist()
          if (allow.error || !allow.targets) {
            throw new Error(
              `无法读取目标白名单：${ALLOW_FILE}\n` +
                `原因：${allow.error || '格式不符'}\n` +
                '白名单不可用，已拒绝所有发送（fail-closed）。\n\n' +
                '修复办法：\n' +
                `  1) 把同目录的 allowed-targets.json.example 复制成 allowed-targets.json\n` +
                `  2) 在 targets 数组里填【你明确点名的】会话 id（形如 session-<uuid>）\n` +
                `  3) 保存即可生效（按文件 mtime 重读，不需要重载插件）\n` +
                '  4) 也可以用 config.allowFile 指向别的路径',
            )
          }
          if (allow.denied && allow.denied.has(sessionId)) {
            throw new Error(
              `目标在 denied 名单里，永久拒绝：${sessionId}\n` +
                '（该会话曾被抓自写入过测试消息，用户未点名。）',
            )
          }
          if (!allow.targets.has(sessionId)) {
            throw new Error(
              `目标不在白名单：${sessionId}\n` +
                `只有 ${ALLOW_FILE} 的 targets 里列出的会话才允许写入。\n` +
                '加入一个目标需要一次有痕迹的文件编辑，且必须由用户明确点名。\n' +
                '（会话出现在 session_list 里 ≠ 有权写入。）',
            )
          }

          if (sessionId === myId && !allowSelf) {
            throw new Error('不能给自己发消息（Config.allowSelf=false）')
          }

          const rawText = String((args && args.text) || '')
          // 过滤控制字符与双向文本控制符：
          //   \u0000-\u0008 \u000B \u000C \u000E-\u001F \u007F  普通控制符
          //   \u200B-\u200F  \u202A-\u202E  \u2066-\u2069          零宽 / 双向覆盖（可伪装成系统指令，审计 B11）
          // 保留 \t \n \r（正常排版需要）。
          const text = rawText.replace(
            /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,
            '',
          )
          if (text.trim() === '') throw new Error('消息正文为空（或过滤控制字符后为空）')
          if (text.length > maxChars) {
            // ⚠️ text.length 是 UTF-16 码元数，emoji 会算 2。文案要说准，不能写"字"（审计 A15）。
            throw new Error(
              `消息过长：${text.length} 个 UTF-16 码元 > 上限 ${maxChars}（约 ${Math.ceil(maxChars / 2)} 个 emoji 就满），请拆分后再发`,
            )
          }

          const target = svc.get(sessionId)
          if (!target) {
            throw new Error(
              `目标会话不在线：${sessionId}\n` +
                '请先在 DSH 里打开该会话再发。（本工具刻意不自动 resume，避免隐式启动会话）',
            )
          }

          const h = headerOf(target)
          // 归档的真值源在 workspaceRegistry，header 里根本没有 archived 字段（实测 7 个键）。
          // 旧写法 `h.archived === true` 是死代码，永远不会触发。
          //
          // ⚠️ 拿不到真值源时**不能假装查过了**：这里把它变成显式状态，
          //    结果里会带 archivedCheck: 'checked' | 'unavailable'，调用方能看出这次没验成（审计 A26/G10）。
          let archivedCheck = 'unavailable'
          try {
            const reg = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
            if (reg && Array.isArray(reg.archivedSessionIds)) {
              archivedCheck = 'checked'
              const sid = (target.session && target.session.id) || sessionId
              if (reg.archivedSessionIds.includes(sid) || reg.archivedSessionIds.includes(sessionId)) {
                throw new Error(`目标会话已归档：${sessionId}`)
              }
            }
          } catch (e) {
            if (e && typeof e.message === 'string' && e.message.startsWith('目标会话已归档')) throw e
            archivedCheck = 'unavailable'
          }

          // ── 目标准入（防"从列表里顺手挑一个"）──
          if (allowedTargets.length > 0 && !allowedTargets.includes(sessionId)) {
            throw new Error(
              `目标不在 allowedTargets 白名单内：${sessionId}\n` +
                `当前白名单 ${allowedTargets.length} 项。列表里出现不等于有权写入。`,
            )
          }
          // ⚠️ 这里只检查、不登记：登记必须放到所有校验通过之后。
          //    否则 confirm:true + 非法 mode 失败一次就把该目标"消费"掉了，
          //    之后不带 confirm 的合法请求会被直接放行（审计 G12）。
          const needsVouch = requireConfirmForNewTarget && !vouchedTargets.has(sessionId)
          if (needsVouch && !(args && args.confirm === true)) {
            throw new Error(
              `首次向 ${sessionId} 发消息需要确认。\n` +
                `请带 confirm:true 重发 —— 这是为了拦住"从 session_list 里顺手挑一个就发"的行为。\n` +
                `（会话列表里出现 ≠ 有权写入；只应发往用户明确点名的会话。）`,
            )
          }
          // origin 的形态不止字符串一种（同文件 view() 已按"可能任意值"处理）：
          // 'subagent' | {kind:'subagent'} 都可能；delegationDepth>0 作为兜底判据（审计 P1-7）。
          const isSubagentOrigin =
            h.origin === 'subagent' ||
            (h.origin && typeof h.origin === 'object' && h.origin.kind === 'subagent') ||
            (typeof h.delegationDepth === 'number' && h.delegationDepth > 0)
          if (isSubagentOrigin) {
            throw new Error(
              `目标是 subagent 会话（origin=${safeStr(h.origin)}，delegationDepth=${safeStr(h.delegationDepth)}），` +
                `UI 无法对它操作，投递无意义：${sessionId}`,
            )
          }

          // mode 必须严格白名单：非法值若静默降级为 followup，
          // 调用方以为插话(steer)实际开了新一轮，行为完全不同（审计 P1-6）。
          const rawMode = args && args.mode
          if (rawMode !== undefined && rawMode !== null && !MODES.includes(String(rawMode))) {
            throw new Error(
              `非法 mode：${safeStr(rawMode)}。只接受 ${MODES.join(' / ')}（不传则默认 followup）。`,
            )
          }
          const mode = rawMode === undefined || rawMode === null ? 'followup' : String(rawMode)
          if (typeof target[mode] !== 'function') {
            throw new Error(
              `目标会话不支持 ${mode}()：它可能不是标准 ReactLoopAgent。已中止，未写入任何内容。`,
            )
          }

          const now = Date.now()
          // ⚠️ dedupMs=0 表示"关闭去重"：那就完全不读写表（旧版仍写，导致跨实例误挡 + 内存）。
          const dedupOn = dedupMs > 0
          pruneSendLog({ sendLog, dedupTable, dedupOn }, now, dedupMs)

          // 去重：同 sender + 同 target + 同 mode + 同文本
          // ⚠️ mode 必须进键：inject(补背景不唤醒) 与 followup(排新一轮) 常共用同一句「继续」，
          //    漏掉 mode 会让第二条被判定重复而静默丢弃（审计 P0）。
          // ⚠️ senderId 必须进键：否则 A 发给 C 的一句「继续」会吞掉 B 发给 C 的同文
          //    （跨发送者误伤，多 agent 编排时是常态）。
          // ⚠️ 文本存**哈希不存原文**：200 条 100KB 文本曾让堆涨 41MB（审计 E09）。
          const textHash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
          const dk = `${myId}\u0000${sessionId}\u0000${mode}\u0000${textHash}`
          const prev = dedupOn ? dedupTable.get(dk) : undefined
          if (prev && now - prev.at < dedupMs) {
            // ⚠️ pending 分支不能报 ok:true：上一条仍在投递中，若它随后失败，
            //    这里早已告诉调用方"成功"，调用方不会重发 → 静默丢失（审计 P1-2）。
            if (prev.pending === true) {
              return {
                ok: false,
                pending: true,
                shouldRetry: true,
                sessionId,
                messageId: null,
                ageMs: now - prev.at,
                dedupMs,
                note: '同一文本的上一条仍在投递中，本次未发送；稍后重试即可。',
              }
            }
            return {
              ok: true,
              duplicate: true,
              pending: false,
              sessionId,
              messageId: prev.id,
              ageMs: now - prev.at,
              dedupMs,
            }
          }

          // 限流：同 target 60s 窗口
          const recent = sendLog.filter((x) => x.target === sessionId)
          if (recent.length >= rateLimit) {
            // ⚠️ 不能 throw：模型看到工具错误最常见的反应是"再试一次"→ 继续被拒 → 烧轮次。
            //    返回结构化结果让它能算出等多久（审计 P2）。
            const oldest = recent.length > 0 ? recent[0].at : now
            const retryAfterMs = Math.max(0, RATE_WINDOW_MS - (now - oldest))
            return {
              ok: false,
              rateLimited: true,
              sessionId,
              messageId: null,
              attemptsInWindow: recent.length,
              rateLimit,
              windowMs: RATE_WINDOW_MS,
              retryAfterMs,
              note: `该目标在 ${RATE_WINDOW_MS / 1000}s 内已尝试 ${recent.length} 次（上限 ${rateLimit}），本次未发送。`,
            }
          }

          // ★★ 同步占位，堵住并发窗口 ★★
          // 检查与写入之间若存在 await，两个并发调用会同时通过检查（已实测复现）。
          // 因此在任何 await 之前先占位；失败则撤销，成功则把真实 id 写回。
          // 到这里所有校验都过了，才可以登记"已确认目标"（否则失败会误消费 confirm）。
          if (needsVouch) vouchedTargets.add(sessionId)
          const reservation = randomUUID()
          if (dedupOn) dedupTable.set(dk, { id: reservation, at: now, pending: true })
          const logEntry = { target: sessionId, id: reservation, at: now }
          sendLog.push(logEntry)

          const statusAtSend = typeof target.status === 'string' ? target.status : ''
          const seqAtSend = seqOf(target)

          let message
          try {
            message = await buildMessage({ senderId: myId, text })
            // target[mode] 可能是异步实现：不 await 的话 reject 会变成 unhandledRejection，
            // 而工具会报 ok:true（审计 E11）。同步实现 await 一个 undefined 无害。
            await target[mode](message.message)
          } catch (err) {
            // 只撤销**去重**占位：同文本应当允许重试。
            // ⚠️ 但**保留 sendLog 那条**：失败也必须计入限流窗口，
            //    否则目标持续拒收时会话可以无限重试、完全没有刹车（审计 E06）。
            // ⚠️ 归属校验：若本条占位已被 TTL 清掉、另一调用写了新占位，
            //    无条件 delete 会误删别人的 pending 保护（审计 L710）。
            if (dedupOn && (dedupTable.get(dk) || {}).id === reservation) dedupTable.delete(dk)
            // ⚠️ 本次调用新增的 confirm 信任必须回滚：
            //    否则"带 confirm 但投递失败一次"就永久免确认了，闸被削弱（审计 P5）。
            if (needsVouch) vouchedTargets.delete(sessionId)
            // 错误文案不能断言"未写入"：append 可能已经成功，抛错发生在之后（审计 P2）
            throw new Error(
              `投递失败：${err && err.message ? err.message : String(err)}\n` +
                '注意：消息可能已经进入目标队列（inbox 写入与后续步骤不是原子的），' +
                '重发前请先用 session_wait 或读日志确认，避免重复。',
            )
          }

          // 成功：把占位换成真实 messageId
          // ⚠️ at 必须用「此刻」而不是 await 前取的 now：
          //    慢投递（耗时 > dedupMs）时用旧时间戳写入，条目一落库就过期 → 去重被静默绕过（审计）。
          if (dedupOn) dedupTable.set(dk, { id: message.message.id, at: Date.now(), pending: false })
          logEntry.id = message.message.id

          return {
            ok: true,
            sessionId,
            mode,
            messageId: message.message.id,
            senderSessionId: myId,
            via: message.via,
            statusAtSend,
            seqAtSend,
            // 'checked' = 真值源可用且已验过；'unavailable' = 没验成（不代表没归档）
            archivedCheck,
          }
        },
      }),
    'dsh-session-relay: session_say',
  )

  // ── 工具 3：session_wait ──────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'session_wait',
        description:
          '等待目标会话产出新事件并回到空闲（读 session.seq + 最后一条 turn/end）。先 session_say 拿到 seqAtSend，再 session_wait(sinceSeq=seqAtSend)。inject 模式不会唤醒目标，等不到回执。',
        // ⚠️ 原生 JSON Schema（register 不编译作者方言）
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: '目标会话 id' },
            sinceSeq: {
              type: 'number',
              description: '基准序号（用 session_say 返回的 seqAtSend；省略则取调用瞬间的 seq）',
            },
            timeoutMs: { type: 'number', description: '超时毫秒，默认 60000，上限 180000' },
          },
          required: ['sessionId'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render(_args, value) {
            const v = value || {}
            // ⚠️ 每个分支都渲染成它真实的含义。曾经 pending/gone 没有 render，
            //    结果"一条没发"被渲染成"已投递"、"目标下线"被渲染成"✅ 本轮结束"——比抛错更危险。
            if (v.gone) {
              return [
                {
                  type: 'text',
                  text: `⚠️ 目标已下线（等待 ${v.waitedMs}ms / 轮询 ${v.polls} 次）\n${v.note || ''}`,
                },
              ]
            }
            if (v.aborted) {
              return [
                {
                  type: 'text',
                  text: `⏹ 已中止（等待 ${v.waitedMs}ms / 轮询 ${v.polls} 次）\n${v.note || ''}`,
                },
              ]
            }
            if (v.pollError) {
              return [
                {
                  type: 'text',
                  text: `⚠️ 等待中读取注册表出错（已轮询 ${v.polls} 次）\n${v.note || ''}`,
                },
              ]
            }
            if (v.queuedOnly) {
              return [
                {
                  type: 'text',
                  text:
                    `📥 已入队，但目标未被唤醒（等待 ${v.waitedMs}ms / 轮询 ${v.polls} 次）\n` +
                    `seq: ${v.seqBefore} → ${v.seqAfter}   status=${v.status}\n` +
                    `${v.note || ''}`,
                },
              ]
            }
            if (v.timedOut) {
              return [
                {
                  type: 'text',
                  text:
                    `⏱ 等待超时（${v.waitedMs}ms / 轮询 ${v.polls} 次）\n` +
                    `seq: ${v.seqBefore} → ${v.seqAfter}   status=${v.status}\n` +
                    `最后事件: ${v.lastEvent ? v.lastEvent.type + ' (seq ' + v.lastEvent.seq + ')' : '无'}\n` +
                    `${v.note || ''}`,
                },
              ]
            }
            const te = v.turnEnd
            let tail = `seq: ${v.seqBefore} → ${v.seqAfter}   status=${v.status}`
            if (te) {
              if (te.kind === 'completed') tail += `\n轮次 turn=${te.turn}  ✅ completed`
              else if (te.kind === 'error')
                tail += `\n轮次 turn=${te.turn}  ❌ error: ${te.error ? te.error.code + ' / ' + te.error.message : '(无详情)'}`
              // ⚠️ 必须用 safeStr：reason 若有循环引用，裸 JSON.stringify 会 throw，
              //    导致整个 render 失败、模型只看到工具错误（审计 L820）。
              else tail += `\n轮次 turn=${te.turn}  ⚠️ ${te.kind}${te.aborted ? ' / ' + safeStr(te.aborted) : ''}`
            }
            if (v.alreadyIdle) {
              return [{ type: 'text', text: `💤 它本来就空闲（未等待）\n${tail}${v.note ? '\n' + v.note : ''}` }]
            }
            // ⚠️ headline 必须跟 turnEnd.kind 走：曾出现「✅ 本轮结束」配「❌ error: E_BOOM」的自相矛盾，
            //    模型只看 headline 就会误判目标成功做完（审计 P1）。
            if (te && te.kind === 'error') {
              return [
                {
                  type: 'text',
                  text: `❌ 本轮以错误结束（等待 ${v.waitedMs}ms / 轮询 ${v.polls} 次）\n${tail}`,
                },
              ]
            }
            if (te && te.kind === 'aborted') {
              return [
                {
                  type: 'text',
                  text: `⏹ 本轮被中止（等待 ${v.waitedMs}ms / 轮询 ${v.polls} 次）\n${tail}`,
                },
              ]
            }
            if (te && te.kind === 'interrupted') {
              return [
                {
                  type: 'text',
                  text: `⚠️ 本轮被中断（等待 ${v.waitedMs}ms / 轮询 ${v.polls} 次）\n${tail}`,
                },
              ]
            }
            return [
              {
                type: 'text',
                text: `✅ 本轮结束（等待 ${v.waitedMs}ms / 轮询 ${v.polls} 次）\n${tail}`,
              },
            ]
          },
        },
        async execute(args, exec) {
          const svc = serviceOf(ctx)
          /** 用户中止信号：工具层明确"取消不放弃已开始的 body"，所以循环必须自己看它。
           *  旧版完全不看 → 按停止后仍空转最长 180s，表现为"暂停也暂停不了"（审计 P0）。*/
          const signal = exec && exec.signal
          const aborted = () => !!(signal && signal.aborted)
          requirePreset(exec)
          if (args && args.sessionId !== undefined && typeof args.sessionId !== 'string') {
            throw new Error(
              `sessionId 必须是字符串，收到 ${Array.isArray(args.sessionId) ? 'array' : typeof args.sessionId}`,
            )
          }
          const sessionId = String((args && args.sessionId) || '').trim()
          if (sessionId === '') throw new Error('sessionId 不能为空')
          if (sessionId.length > 200) {
            throw new Error(`sessionId 过长（${sessionId.length} 字符）：${sessionId.slice(0, 40)}…`)
          }
          // ⚠️ 开头这次 get 也要包：注册表抖动时给一条能看懂的错，
          //    而不是把 raw 的 "registry flaked" 直接甩给调用方（审计 D23 的同一类问题）。
          let target
          try {
            target = svc.get(sessionId)
          } catch (e) {
            throw new Error(`读取注册表失败：${String((e && e.message) || e)}`)
          }
          if (!target) throw new Error(`目标会话不在线：${sessionId}`)

          const seqNow = seqOf(target)
          // ⚠️ 必须用 typeof 判类型：`Number(null)` = 0 且 `isFinite(0)` = true，
          //    若模型把"省略参数"序列化成 null，会被当成 sinceSeq=0 → `seq>0` 永真 →
          //    250ms 后拿几分钟前的旧 turnEnd 报"本轮结束"（审计 P1-4）。
          // ⚠️ 必须同时要求「整数且 >= 0」：
          //    只判 typeof+isFinite 时，sinceSeq=-1 会让 s > -1 立刻成立 → 误报 ok:true（什么都没发生）；
          //    sinceSeq=1.5 会让 eventAt(1.5) 全部 miss → 静默空等满超时（审计实测确证）。
          const rawSince = args && args.sinceSeq
          const hasSince =
            typeof rawSince === 'number' && Number.isInteger(rawSince) && rawSince >= 0
          const sinceSeq = hasSince ? rawSince : seqNow
          if (sinceSeq === null || seqNow === null) {
            throw new Error('无法读取 session.seq：目标会话可能不是标准 ReactLoopAgent')
          }
          // sinceSeq 指向未来 → "seq > sinceSeq" 永远不会成立，会静默空等满超时（审计 D02）。
          // 明确报出来，比让它白等好。
          if (sinceSeq > seqNow) {
            throw new Error(
              `sinceSeq=${sinceSeq} 大于当前 seq=${seqNow}：这个条件永远不会成立。\n` +
                '请用 session_say 返回的 seqAtSend，或省略 sinceSeq。',
            )
          }

          /**
           * 窗口 (from, to) 内是否出现过「非 inbox 事件」——即目标真的开始处理了。
           * ⚠️ 下界必须是 `from` 而不是 `from + 1`：session.seq 是"下一个待分配序号"，
           *    我们的 inbox 事件正好落在 sinceSeq 那一格，紧随其后的真实事件也常落在同一格附近。
           *    写成 from+1 会跳过一次 → 概率性空等满超时（审计 D03/D04）。
           * ⚠️ 判据是「任意非 inbox 事件」，不是「turn/start」：
           *    steer 插进当前轮不会开新 turn/start，硬要求它必然超时（审计 D03b）。
           */
          const sawRealEvent = (agent, from, to) => {
            try {
              const s2 = agent && agent.session
              if (!s2 || typeof s2.eventAt !== 'function') return false
              const lo = Math.max(from, to - 300) // 只看最近 300 条，避免大间隔时扫太长
              for (let i = lo; i < to; i++) {
                const ev = s2.eventAt(i)
                if (ev && ev.type !== 'agent/inbox/spliced') return true
              }
              return to - lo >= 300 // 间隔过大时无法确证，放行以免永久等待
            } catch {
              return false
            }
          }

          // 省略 sinceSeq（或显式等于当前 seq）且它此刻已空闲 → 直接返回。
          // ⚠️ 不能只在 !hasSince 时判：文档推荐的用法正是 sinceSeq=seqAtSend，
          //    而 seqAtSend 恰好等于当前 seq 时会被挡住 → 空等（审计 D01）。
          {
            const l0 = lastEventOf(target)
            if (
              typeof target.status === 'string' &&
              target.status === 'idle' &&
              seqNow === sinceSeq
            ) {
              return {
                ok: true,
                alreadyIdle: true,
                note: '它此刻本来就是空闲的（没有可等的新事件）',
                sessionId,
                waitedMs: 0,
                polls: 0,
                seqBefore: seqNow,
                seqAfter: seqNow,
                status: 'idle',
                turnEnd: turnEndSummary(l0),
              }
            }
          }

          // timeoutMs：显式给 0 = 只检查一次不等待；负数/非数字 = 用默认 60s。
          // （旧版把 0 静默当成 60s，表现为"我明明说了 0 却卡了 2 分半"，审计 D22）
          // ⚠️ 负数必须走默认而不是被 Math.max(0,..) 夹成 0：夹成 0 会让 -1 变成"只查一次"，
          //    与注释语义相反，调用方以为给了个"很久"却立刻返回（审计 P4）。
          let timeout = 60_000
          if (args && args.timeoutMs !== undefined && args.timeoutMs !== null) {
            const n = Number(args.timeoutMs)
            if (Number.isFinite(n)) {
              timeout = n > 0 ? Math.min(Math.trunc(n), WAIT_MAX_MS) : n === 0 ? 0 : 60_000
            }
          }

          const t0 = Date.now()
          let polls = 0
          while (Date.now() - t0 < timeout || polls === 0) {
            // 用户中止（按停止 / 工具取消）→ 立刻退出，不等满超时。
            if (aborted()) {
              return {
                ok: false,
                aborted: true,
                sessionId,
                waitedMs: Date.now() - t0,
                polls,
                seqBefore: sinceSeq,
                seqAfter: seqOf(svc.get(sessionId)),
                status: '',
                note: '被调用方中止（exec.signal.aborted）。',
              }
            }
            await new Promise((r) => setTimeout(r, WAIT_POLL_MS))
            polls++
            // ⚠️ 每轮重新 get：目标可能被 resume/关闭/重载，旧引用会 seq 冻结、status 卡住，
            //    导致白等到超时且超时文案误诊（审计 P1-8）。
            // ⚠️ get 必须包 try：注册表抖动时不能让裸错冒泡，否则丢掉 waitedMs/polls 等诊断
            //    信息，调用方只看到 "registry flaked"（审计 D23）。
            let cur
            try {
              cur = svc.get(sessionId)
            } catch (e) {
              return {
                ok: false,
                pollError: true,
                sessionId,
                waitedMs: Date.now() - t0,
                polls,
                seqBefore: sinceSeq,
                seqAfter: null,
                status: '',
                note: `等待期间读取注册表出错（第 ${polls} 次轮询）：${String((e && e.message) || e)}`,
              }
            }
            if (!cur) {
              return {
                ok: false,
                gone: true,
                timedOut: false,
                sessionId,
                waitedMs: Date.now() - t0,
                polls,
                seqBefore: sinceSeq,
                seqAfter: null,
                status: '',
                note: '目标会话在等待期间下线了（被关闭 / 归档 / 重载）。',
              }
            }
            const s = seqOf(cur)
            const st = typeof cur.status === 'string' ? cur.status : ''
            const last = lastEventOf(cur)
            // 判据：seq 增长 + 已 idle + 确实出现过处理事件。
            // ⚠️ 不再要求「最后一条必须是 turn/end」：目标可能以 inbox 收尾或以别的类型收尾，
            //    把它当必要条件会让「本来就做完了」也永远等不到（审计 D12/D16/D18）。
            if (s !== null && s > sinceSeq && st === 'idle' && sawRealEvent(cur, sinceSeq, s)) {
              return {
                ok: true,
                sessionId,
                waitedMs: Date.now() - t0,
                polls,
                seqBefore: sinceSeq,
                seqAfter: s,
                status: st,
                turnEnd: turnEndSummary(last),
              }
            }
          }
          // 超时：区分两种性质完全不同的情况
          // get 可能抖，包起来；拿不到就用最后一次轮询已知的 seq 兜底
          let endTarget
          try {
            endTarget = svc.get(sessionId)
          } catch {
            endTarget = undefined
          }
          const endSeq = endTarget ? seqOf(endTarget) : null
          const endLast = endTarget ? lastEventOf(endTarget) : null
          // seq 只增长了 inbox 事件 → 消息已入队但目标没被唤醒（inject 模式必然如此）
          const queuedOnly =
            endSeq !== null &&
            endSeq > sinceSeq &&
            endTarget &&
            typeof endTarget.status === 'string' &&
            endTarget.status === 'idle' &&
            !sawRealEvent(endTarget, sinceSeq, endSeq)
          return {
            ok: false,
            timedOut: !queuedOnly,
            queuedOnly,
            sessionId,
            waitedMs: Date.now() - t0,
            polls,
            seqBefore: sinceSeq,
            seqAfter: endSeq,
            status: endTarget && typeof endTarget.status === 'string' ? endTarget.status : '',
            lastEvent: endLast ? { type: endLast.type, seq: endLast.seq } : null,
            note: queuedOnly
              ? '消息已入队，但目标没有苏醒（inject 模式不会唤醒目标）——这不代表它处理完了。'
              : '没有等到完成的迹象：可能消息没被消费，或目标卡在长任务里。',
          }
        },
      }),
    'dsh-session-relay: session_wait',
  )

  // ── 工具 4：session_read（读思考链 / 工具调用）────────────────────────
  // 这是"观察另一个会话怎么想、调了什么"的正式入口。
  // 同样受白名单约束：读也要在 allowed-targets.json 里，避免"乱读"。
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'session_read',
        description:
          '读取指定会话的思考链与动作：reasoning（它的思考）/ text（输出）/ tool-call（工具+完整参数）/ tool-result（结果）/ turn-end（这轮怎么结束）。用于实时观察另一个会话。只读，不改任何东西。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: '目标会话 id' },
            sinceSeq: { type: 'number', description: '起始序号（不含）；省略则从最早开始（受 limit 限制）' },
            kinds: { type: 'string', description: '过滤：reasoning | text | tool | all（默认 all）' },
            limit: { type: 'number', description: '最多返回多少条，默认 100，上限 500' },
          },
          required: ['sessionId'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'array' },
          render(_args, value) {
            const rows = Array.isArray(value) ? value : []
            if (rows.length === 0) return [{ type: 'text', text: '（该区间没有可读事件）' }]
            const lines = rows.map((r) => {
              const tag =
                r.kind === 'reasoning'
                  ? '思考'
                  : r.kind === 'tool-call'
                    ? '调用'
                    : r.kind === 'tool-result'
                      ? '结果'
                      : r.kind === 'turn-end'
                        ? '结束'
                        : '输出'
              return `[seq ${r.seq}] ${tag}: ${String(r.text || '').replace(/\n/g, ' ⏎ ')}`
            })
            return [{ type: 'text', text: `共 ${rows.length} 条：\n${lines.join('\n')}` }]
          },
        },
        async execute(args, exec) {
          const svc = serviceOf(ctx)
          requirePreset(exec)
          if (args && args.sessionId !== undefined && typeof args.sessionId !== 'string') {
            throw new Error('sessionId 必须是字符串')
          }
          const sessionId = String((args && args.sessionId) || '').trim()
          if (sessionId === '') throw new Error('sessionId 不能为空')

          // 读也要过白名单，避免"乱读"用户没点名的会话
          const allow = readAllowlist()
          if (allow.error || !allow.targets) {
            throw new Error(
              `无法读取目标白名单：${ALLOW_FILE}\n原因：${allow.error || '格式不符'}\n` +
                '把 allowed-targets.json.example 复制成 allowed-targets.json 并填好 targets 即可。',
            )
          }
          // denied 优先，与 session_say 保持一致：否则同一个 id 同时进两名单时「可读不可写」，
          // 会让"永久拒绝"的语义漏掉一半（审计：读写权限不对称）。
          if (allow.denied && allow.denied.has(sessionId)) {
            throw new Error(`目标在 denied 名单里，拒绝读取：${sessionId}`)
          }
          if (!allow.targets.has(sessionId)) {
            throw new Error(
              `目标不在白名单，拒绝读取：${sessionId}\n` +
                '（读也一样：只能读用户点名过的会话。）',
            )
          }

          let target
          try {
            target = svc.get(sessionId)
          } catch (e) {
            throw new Error(`读取注册表失败：${String((e && e.message) || e)}`)
          }
          if (!target) throw new Error(`目标会话不在线：${sessionId}`)
          const s = target.session
          if (!s || typeof s.seq !== 'number' || typeof s.eventAt !== 'function') {
            throw new Error('无法读取该会话的事件流（session.seq / eventAt 不可用）')
          }
          const end = s.seq
          const limit = Math.min(
            Math.max(1, Math.trunc(Number(args && args.limit) || 100)),
            500,
          )
          // ⚠️ sinceSeq 语义是**不含**（文档与 session_wait 一致）：给了 S 就从 S+1 开始读。
          //    旧版 from=sinceSeq 会把调用方已看过的条目再吐一遍（审计 P2）。
          const rawS = args && args.sinceSeq
          const hasS = typeof rawS === 'number' && Number.isInteger(rawS) && rawS >= 0
          const from = hasS
            ? Math.max(0, Math.min(rawS + 1, end))
            : Math.max(0, end - limit)
          // ⚠️ 支持逗号分隔多值（"reasoning,text"）。旧版只做全等匹配，
          //    传多值会静默返回空 —— 调用方以为"这段时间没东西"，实际是过滤条件写错。
          const kindsRaw = String((args && args.kinds) || 'all')
            .toLowerCase()
            .trim()
          const kindSet = new Set(
            kindsRaw
              .split(',')
              .map((x) => x.trim())
              .filter((x) => x !== ''),
          )
          const wantAll = kindSet.size === 0 || kindSet.has('all')

          const out = []
          for (let i = from; i < end; i++) {
            if (out.length >= limit) break
            let ev
            try {
              ev = s.eventAt(i)
            } catch {
              continue
            }
            if (!ev) continue
            const d = ev.data || {}
            const push = (kind, text) => {
              if (
                !wantAll &&
                !kindSet.has(kind) &&
                !(kindSet.has('tool') && (kind === 'tool-call' || kind === 'tool-result'))
              ) {
                return
              }
              out.push({ seq: ev.seq, time: ev.time, kind, text })
            }
            if (ev.type === 'assistant/message') {
              const parts = []
              for (const rec of d.stream || []) {
                if (isObj(rec) && rec.type === 'reasoning-chunks') parts.push(...(rec.texts || []))
              }
              const reasoning = parts.join('').trim()
              if (reasoning) push('reasoning', reasoning)
              const txt = textOfBlocks((d.message || {}).content).trim()
              if (txt) push('text', txt)
            } else if (ev.type === 'tool/call') {
              push('tool-call', `${d.name}(${String(d.arguments || '')})`)
            } else if (ev.type === 'tool/result') {
              const m = d.message || {}
              push('tool-result', `${m.isError ? '[ERROR] ' : ''}${textOfBlocks(m.content)}`)
            } else if (ev.type === 'turn/end') {
              const r = d.reason || {}
              push('turn-end', `turn=${d.turn} → ${r.kind}${r.error ? ': ' + r.error.message : ''}`)
            } else if (ev.type === 'user/message') {
              const src = (d.source || {}).kind
              push('user', `(${src}) ${textOfBlocks(d.content)}`)
            }
          }
          return out
        },
      }),
    'dsh-session-relay: session_read',
  )
}
