/**
 * dsh-thinking-guard — 宿主半边。
 *
 * 两件事：
 *   1. 会话级规则配置的存储 + 路由（所有规则的唯一事实来源）
 *   2. `llm/stream` 上的修复层：目前只有「走道缝合」一条（见 seam.js）
 *
 * 修复层的第一原则：**只在能证明是机械断裂的地方动手**，判据不成立就原样放行。
 *
 * 规则清单只有**一个事实来源**：本文件的 RULE_DEFS。
 * 客户端每次 `GET /state` 拿到的就是它，UI 不写死任何条目。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { repairStream } from './seam.js'
import { wrapStream } from './wrap.js'
import { dedupeStream } from './dedupe.js'
import { letmeStream } from './letme.js'
import { dsmlSplitStream } from './dsml-split.js'

export const name = 'thinking-guard'
export const inject = ['webServer', 'llm', 'sessions']

const API_PREFIX = '/dsh-thinking-guard'
const BODY_LIMIT = 64 * 1024

/** 官方供应商：思考块必须回传。 */
const OFFICIAL_PROVIDER = /^deepseek/i

/**
 * 供应商归一化键。
 *
 * 设置页里官方供应商的 route id 是 `deepseek-official`，请求层的
 * `options.provider` 可能是 `deepseek-account` / `deepseek` —— 它们共享同一套
 * 服务端要求，所以归成一个桶，避免「界面改了不生效」。
 */
export function providerKey(providerId) {
  const id = typeof providerId === 'string' ? providerId : ''
  return OFFICIAL_PROVIDER.test(id) ? 'deepseek' : id
}

/** 去掉 assistant 消息里的 reasoning 块；若整条消息只剩思考，则原样保留。 */
export function withoutReasoning(messages) {
  let changed = false
  const next = messages.map((message) => {
    if (message === null || typeof message !== 'object' || message.role !== 'assistant') return message
    if (!Array.isArray(message.content)) return message
    const content = message.content.filter((block) => block?.type !== 'reasoning')
    if (content.length === message.content.length) return message
    if (content.length === 0) return message // 不留空消息，避免把请求打成非法
    changed = true
    return { ...message, content }
  })
  return changed ? next : messages
}

/**
 * 规则清单：唯一事实来源。
 *
 * 每一项的字段：
 *   key       稳定标识，会写进状态文件，定了就不能改名
 *   zh / en   显示名
 *   zhHint / enHint  一行说明，显示在名字下方
 *   default   缺省值；新会话以及「恢复默认」都取这个
 *
 * 往里加一条，菜单自动多一行，徽章自动计数，无需改客户端。
 */
export const RULE_DEFS = [
  {
    key: 'seamRepair',
    zh: '思考缝合',
    en: 'Seam repair',
    zhHint: '被误判成结束的思考，接回同一个思考块',
    enHint: 'Fold a falsely-ended thought back into the same block',
    default: false,
  },
  {
    key: 'wrapThinking',
    zh: '思考封装',
    en: 'Wrap thinking',
    zhHint: '写进正文的思考，缓冲 20 token 后整块封装',
    enHint: 'Wrap thinking written into the reply, after a 20-token sample',
    default: false,
  },
  {
    key: 'letmeRewrite',
    zh: '开口改写',
    en: 'Opener rewrite',
    zhHint: "Let me X → I'll X（展开可单独开关子项）",
    enHint: 'Let me X → I\'ll X (expand for sub-switches)',
    default: false,
  },
  {
    key: 'dsmlSplit',
    zh: '工具调用还原',
    en: 'Restore DSML calls',
    zhHint: '把正文/思考里的 DSML 标记还原成真正的工具调用',
    enHint: 'Turn DSML markup in text back into real tool calls',
    default: false,
  },
  {
    key: 'dedupeText',
    zh: '重复正文去重',
    en: 'Drop duplicated reply',
    zhHint: '正文与思考重复时，丢弃重复的正文',
    enHint: 'Drop reply text that duplicates the reasoning',
    default: false,
  },
  {
    key: 'fillerStrip',
    parent: 'letmeRewrite',
    zh: '语气词剔除',
    en: 'Strip fillers',
    zhHint: 'Hmm / Uh / 嗯 这类无意义语气词',
    enHint: 'Drop meaningless openers like Hmm / Uh',
    default: true,
  },
  {
    key: 'intentPrune',
    parent: 'letmeRewrite',
    zh: '短意图剔除',
    en: 'Prune short intents',
    zhHint: '连续意图只留最后一条完整的',
    enHint: 'Keep only the last complete intent in a run',
    default: true,
  },
]

/** DSH 主目录：优先 DSH_HOME，否则 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(homedir(), '.dsh')
}

function statePath() {
  return path.join(dshHome(), 'thinking-guard.json')
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 会话级配置的读写。一个 JSON 文件，键是 sessionId。 */
class Store {
  constructor(config, ctx) {
    this.ctx = ctx
    this.config = config ?? {}
    this.file = typeof this.config.stateFile === 'string' && this.config.stateFile !== ''
      ? this.config.stateFile
      : statePath()
    /** 同步读用的内存副本：`llm/stream` 是同步决策点，不能 await。 */
    this.cache = this.empty()
    /** 各会话最近一次真正生效的规则，只存内存，不落盘 */
    this.applied = new Map()
  }

  /** 启动时载入一次；之后每次写盘都同步更新内存副本。 */
  async load() {
    this.cache = await this.read()
    return this.cache
  }

  /** 同步版 rulesFor，供流钩子使用。 */
  rulesForSync(sessionId) {
    return this.rulesFor(sessionId, this.cache)
  }

  /** 记下最近一次真正应用到请求上的规则，供面板核对。 */
  noteApplied(sessionId, rules) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    this.applied.set(sessionId, { at: Date.now(), rules: { ...rules } })
  }

  appliedFor(sessionId) {
    return (typeof sessionId === 'string' && this.applied.get(sessionId)) || null
  }

  /**
   * 某个供应商的「思考块回传」设置。
   *
   * 缺省按供应商身份定：官方（deepseek*）必须回传，否则多轮工具调用会因为
   * 缺少 reasoning_content 被服务端拒绝；其它供应商默认不回传。
   */
  providerConfig(providerId) {
    const id = typeof providerId === 'string' ? providerId : ''
    const key = providerKey(id)
    const official = OFFICIAL_PROVIDER.test(id)
    const stored = this.cache.providers?.[key]?.replayThinking
    return {
      providerId: id,
      key,
      official,
      replayThinking: typeof stored === 'boolean' ? stored : official,
      overridden: typeof stored === 'boolean',
    }
  }

  /** 写某个供应商的覆盖值。 */
  async writeProvider(providerId, replayThinking) {
    if (typeof providerId !== 'string' || providerId === '') {
      throw new Error('providerId 不能为空')
    }
    if (typeof replayThinking !== 'boolean') {
      throw new Error('replayThinking 必须是布尔值')
    }
    const state = await this.read()
    const key = providerKey(providerId)
    const providers = { ...state.providers }
    providers[key] = { ...(providers[key] ?? {}), replayThinking }
    const written = { ...state, providers }
    await this.write(written)
    this.cache = written
    return this.providerConfig(providerId)
  }

  /** 抹掉某供应商的覆盖，回到按身份推导的缺省。 */
  async clearProvider(providerId) {
    const state = await this.read()
    const key = providerKey(providerId)
    if (state.providers?.[key] === undefined) return this.providerConfig(providerId)
    const providers = { ...state.providers }
    delete providers[key]
    const written = { ...state, providers }
    await this.write(written)
    this.cache = written
    return this.providerConfig(providerId)
  }

  empty() {
    return { version: 1, sessions: {}, providers: {} }
  }

  async read() {
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return this.empty()
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 文件坏了：当作空配置，不阻塞 UI（下次写入会覆盖）
      return this.empty()
    }
    if (parsed === null || typeof parsed !== 'object') return this.empty()
    const sessions = parsed.sessions
    const providers = parsed.providers
    return {
      version: 1,
      sessions: sessions !== null && typeof sessions === 'object' ? sessions : {},
      providers: providers !== null && typeof providers === 'object' ? providers : {},
    }
  }

  /** tmp + rename，避免读到半截文件。 */
  async write(state) {
    await mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, this.file)
  }

  /** 缺省值：直接由 RULE_DEFS 推导，不另存一份。 */
  defaults() {
    const out = {}
    for (const def of RULE_DEFS) out[def.key] = def.default === true
    return out
  }

  /** 某会话的生效规则：缺省 ← 会话覆盖。未知会话 = 缺省。 */
  /** 同一个会话可能有三种写法：带前缀、裸 uuid、其它形态。逐一尝试。 */
  lookup(state, sessionId) {
    const keys = [sessionId]
    if (sessionId.startsWith('session-')) keys.push(sessionId.slice('session-'.length))
    else keys.push(`session-${sessionId}`)
    for (const key of keys) {
      const entry = state.sessions?.[key]
      if (entry !== null && entry !== undefined && typeof entry === 'object') {
        return { key, entry }
      }
    }
    return undefined
  }

  rulesFor(sessionId, state) {
    return this.resolve(sessionId, state, 0)
  }

  /**
   * 解析某会话的生效规则。
   *
   * 子代理默认**继承父会话**解析出来的结果（父会话关掉的那条，子代理也是关的）；
   * 子会话自己显式写过的键优先。
   */
  resolve(sessionId, state, depth) {
    const base = this.defaults()
    if (typeof sessionId !== 'string' || sessionId === '') return base

    const parentId = depth < 8 ? this.parentOf(sessionId) : undefined
    const inherited = parentId !== undefined && parentId !== sessionId
      ? this.resolve(parentId, state, depth + 1)
      : base

    const rules = { ...inherited }
    const hit = this.lookup(state, sessionId)
    if (hit !== undefined) {
      for (const def of RULE_DEFS) {
        if (typeof hit.entry[def.key] === 'boolean') rules[def.key] = hit.entry[def.key]
      }
    }
    return rules
  }

  /** 子代理会话的父会话 id；不是子代理就返回 undefined。 */
  parentOf(sessionId) {
    const sessions = this.ctx?.sessions
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined
    try {
      const header = sessions.get(sessionId)?.header
      if (header?.origin !== 'subagent') return undefined
      const parent = header.parentSession
      return typeof parent === 'string' && parent !== '' ? parent : undefined
    } catch {
      return undefined
    }
  }

  count(rules) {
    // 子项不单独计入徽章，避免「开了父项显示 3 条」这种歧义
    let n = 0
    for (const def of RULE_DEFS) {
      if (def.parent === undefined && rules[def.key] === true) n += 1
    }
    return n
  }

  snapshot(sessionId, state) {
    const rules = this.rulesFor(sessionId, state)
    const defaults = this.defaults()
    const known = typeof sessionId === 'string' && sessionId !== ''
    const overrides = known && state.sessions[sessionId] !== undefined
      ? { ...state.sessions[sessionId] }
      : {}
    let overridden = false
    for (const def of RULE_DEFS) {
      if (rules[def.key] !== (defaults[def.key] === true)) overridden = true
    }
    return {
      ok: true,
      version: 1,
      sessionId: known ? sessionId : '',
      defs: RULE_DEFS,
      rules,
      defaults,
      overrides,
      enabledCount: this.count(rules),
        applied: this.appliedFor(sessionId),
      overridden,
      path: this.file,
    }
  }

  /** 写入会话覆盖。未知键忽略（不报错），没有可写键时原样返回。 */
  async writeRules(sessionId, patch) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('sessionId 不能为空')
    }
    const state = await this.read()
    const known = new Set(RULE_DEFS.map((def) => def.key))
    const next = {}
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (known.has(key) && typeof value === 'boolean') next[key] = value
    }
    if (Object.keys(next).length === 0) return this.snapshot(sessionId, state)
    const sessions = { ...state.sessions }
    sessions[sessionId] = { ...(sessions[sessionId] ?? {}), ...next }
    const written = { ...state, sessions }
    await this.write(written)
    this.cache = written
    return this.snapshot(sessionId, written)
  }

  /** 抹掉某会话的覆盖，回到缺省。 */
  async clearSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('sessionId 不能为空')
    }
    const state = await this.read()
    if (state.sessions[sessionId] === undefined) return this.snapshot(sessionId, state)
    const sessions = { ...state.sessions }
    delete sessions[sessionId]
    const written = { ...state, sessions }
    await this.write(written)
    this.cache = written
    return this.snapshot(sessionId, written)
  }
}

async function handle(req, res, store) {
  const send = (status, payload) => {
    if (res.headersSent) {
      res.end()
      return
    }
    const json = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(json)
  }

  let url
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    send(400, { ok: false, error: '路径不合法' })
    return
  }
  const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
  const querySession = url.searchParams.get('sessionId') ?? ''
  const queryProvider = url.searchParams.get('providerId') ?? ''

  // 设置页可能在启动载入完成前就查询；读一次小文件，保证口径一致。
  await store.load()

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (route === '/provider') {
      try {
        const config = store.providerConfig(queryProvider)
        send(200, req.method === 'HEAD' ? {} : { ok: true, ...config })
      } catch (error) {
        send(500, { ok: false, error: errorText(error) })
      }
      return
    }
    if (route !== '/state' && route !== '/') {
      send(404, { ok: false, error: '未知路径' })
      return
    }
    try {
      const state = await store.read()
      send(200, req.method === 'HEAD' ? {} : store.snapshot(querySession, state))
    } catch (error) {
      send(500, { ok: false, error: errorText(error) })
    }
    return
  }

  if (req.method === 'DELETE') {
    if (route === '/provider') {
      try {
        send(200, { ok: true, ...(await store.clearProvider(queryProvider)) })
      } catch (error) {
        send(400, { ok: false, error: errorText(error) })
      }
      return
    }
    if (route !== '/rules' && route !== '/state') {
      send(404, { ok: false, error: '未知路径' })
      return
    }
    try {
      send(200, await store.clearSession(querySession))
    } catch (error) {
      send(400, { ok: false, error: errorText(error) })
    }
    return
  }

  if (req.method !== 'PUT' && req.method !== 'POST') {
    send(405, { ok: false, error: '方法不允许' })
    return
  }
  if (route !== '/rules' && route !== '/provider') {
    send(404, { ok: false, error: '未知路径' })
    return
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) {
      send(413, { ok: false, error: '请求体过大' })
      return
    }
    chunks.push(chunk)
  }

  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    send(400, { ok: false, error: '请求体不是合法 JSON' })
    return
  }
  if (body === null || typeof body !== 'object') {
    send(400, { ok: false, error: '请求体必须是对象' })
    return
  }

  if (route === '/provider') {
    const providerId = typeof body.providerId === 'string' && body.providerId !== ''
      ? body.providerId
      : queryProvider
    try {
      send(200, { ok: true, ...(await store.writeProvider(providerId, body.replayThinking)) })
    } catch (error) {
      send(400, { ok: false, error: errorText(error) })
    }
    return
  }

  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== ''
    ? body.sessionId
    : querySession
  try {
    send(200, await store.writeRules(sessionId, body.rules))
  } catch (error) {
    send(400, { ok: false, error: errorText(error) })
  }
}

export function apply(ctx, config) {
  const store = new Store(config, ctx)
  // 流钩子是同步决策点，先把状态载入内存；失败也不影响透传。
  void store.load().catch((error) => {
    ctx.logger?.warn?.('[thinking-guard] 读取状态失败，规则按缺省处理: %s', errorText(error))
  })

  if (typeof ctx.webServer?.register !== 'function') {
    ctx.logger?.warn?.('[thinking-guard] webServer 不可用，规则面板无法读写配置')
  } else {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        // 必须把 promise 返回出去：否则调用方无从等待，异常也成了悬空的。
        return handle(req, res, store).catch((error) => {
          ctx.logger?.warn?.('[thinking-guard] 请求处理失败: %s', errorText(error))
          try {
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: errorText(error) }))
            } else {
              res.end()
            }
          } catch {
            /* 连接已断，忽略 */
          }
        })
      },
    }), 'thinking-guard: 会话规则 API')

    ctx.logger?.info?.('[thinking-guard] 会话规则 API 已挂载于 %s', API_PREFIX)
  }

  // —— 修复层：走道缝合 ——
  //
  // 只做一件事：把上游误判成「思考结束」的那半截接回同一个思考块。
  // 判据不成立时逐个 chunk 原样放行，不做任何缓冲以外的改动。
  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : ''
    const rules = store.rulesForSync(sessionId)
    store.noteApplied(sessionId, rules)

    // —— 思考块回传 ——
    // 关掉时，把历史里 assistant 消息的 reasoning 块裁掉再发给上游。
    // 官方供应商缺省为开：服务端要求多轮工具调用带 reasoning_content。
    if (config?.enabled !== false) {
      const provider = typeof options?.provider === 'string' ? options.provider : ''
      if (store.providerConfig(provider).replayThinking === false && Array.isArray(options?.messages)) {
        // options 是只读对象：不能给它赋值，只能就地改数组内容
        try {
          const kept = withoutReasoning(options.messages)
          const list = options.messages
          list.length = 0
          for (const item of kept) list.push(item)
        } catch (error) {
          ctx.logger?.warn?.('[thinking-guard] 裁剪历史思考失败（已忽略）: %s', error?.message ?? error)
        }
      }
    }

    if (config?.enabled === false) return next()

    // 两个转换器按顺序串，**封装在上游**（直接吃模型原始流）：
    //   封装 —— 先缓冲 20 token，判断整块是思考还是正文
    //   缝合 —— 再处理「本来就在思考、被切断」的半截
    // 这样封装的采样看到的是原始文本，不会被缝合的缓冲截断。
    let stream = next()

    // 顺序很重要：
    //   DSML 切分 —— 最先。不管标记落在正文还是思考里，先还原成结构化 tool-call，
    //                后面各步才看到干净的流
    //   去重 —— 其次，否则封装会先把重复块切开，去重就认不出来了
    //   封装 —— 处理显式标记、整段写进正文的思考
    //   缝合 —— 处理「本来就在思考、被切断」的半截
    if (config?.dsmlSplit !== false && rules.dsmlSplit === true) {
      stream = dsmlSplitStream(stream, (stats) => {
        if (stats.split === 0) return
        ctx.logger?.warn?.('[thinking-guard] 从文本还原工具调用 %d 处 / %d 个', stats.split, stats.calls)
      })
    }

    if (config?.dedupeText !== false && rules.dedupeText === true) {
      stream = dedupeStream(stream, (stats) => {
        if (stats.dropped === 0) return
        ctx.logger?.warn?.(
          '[thinking-guard] 丢弃重复正文 %d 处 / %d 字符',
          stats.dropped,
          stats.chars,
        )
      })
    }

    if (rules.wrapThinking === true) {
      stream = wrapStream(stream, (stats) => {
        if (stats.wrapped === 0 && stats.spans === 0 && stats.dsml === 0) return
        ctx.logger?.info?.(
          '[thinking-guard] 封装 %d 处 / 标记段 %d 处 / DSML %d 处',
          stats.wrapped,
          stats.spans,
          stats.dsml,
        )
      })
    }

    if (rules.seamRepair === true) {
      stream = repairStream(stream, (stats) => {
        if (stats.folded === 0) return
        ctx.logger?.info?.(
          '[thinking-guard] 缝合 %d 处 / %d 字符（%s）',
          stats.folded,
          stats.chars,
          Object.keys(stats.reasons).join(','),
        )
      })
    }

    // 最后一道：开口改写。必须放在结构修完之后——它只动思考文本，
    // 前面任何一步若还藏着结构问题，改写过的内容会被块的收尾文本覆盖。
    if (rules.letmeRewrite === true) {
      // 子开关：父项关了则全部不生效
      const options = {
        filler: rules.fillerStrip !== false,
        intent: rules.intentPrune !== false,
      }
      stream = letmeStream(stream, options, (stats) => {
        if (stats.rewritten === 0 && stats.dropped === 0) return
        ctx.logger?.info?.(
          '[thinking-guard] 开口改写 %d 处 / 剔除 %d 处',
          stats.rewritten,
          stats.dropped,
        )
      })
    }

    return stream
  }), 'thinking-guard: 去重 / 封装 / 缝合 / 开口改写')
}











