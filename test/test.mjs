/**
 * 宿主半边的冒烟测试。
 *
 * 不启动 DSH：用假的 ctx 接住 webServer.register，再用假的 req/res 驱动
 * 真实的 handler —— 测的就是浏览器将来打的那几条请求。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RULE_DEFS, apply } from '../index.js'

/** 装一次插件，返回 { handler, file, hooks }。 */
async function boot(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'thinking-guard-'))
  const file = path.join(dir, 'thinking-guard.json')
  let handler = null
  const hooks = new Map()
  /** 假 sessions 服务：id → header */
  const table = options.sessions ?? new Map()
  const ctx = {
    effect: (fn) => fn(),
    on: (event, fn) => {
      hooks.set(event, fn)
      return () => hooks.delete(event)
    },
    webServer: { register: (options) => { handler = options.handler } },
    sessions: {
      get: (id) => (table.has(id) ? { header: table.get(id) } : undefined),
    },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, { stateFile: file })
  assert.equal(typeof handler, 'function', 'handler 没挂上')
  return { handler, file, hooks }
}

/** 造一个假请求。 */
function request(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 造一个假响应，等到 handler 结束再取结果。 */
function response() {
  const res = {
    headersSent: false,
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
      res.headersSent = true
      return res
    },
    end(text) {
      if (typeof text === 'string') res.body += text
    },
  }
  return res
}

async function call(handler, method, url, body) {
  const res = response()
  await handler(request(method, url, body), res)
  return { status: res.status, json: JSON.parse(res.body || 'null'), headers: res.headers }
}

test('GET /state：无会话时返回空规则与 0', async () => {
  const { handler } = await boot()
  const { status, json } = await call(handler, 'GET', '/dsh-thinking-guard/state')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.sessionId, '')
  // 唯一事实来源：宿主下发 defs，客户端不写死
  assert.deepEqual(json.defs.map((d) => d.key), ['seamRepair', 'wrapThinking', 'letmeRewrite', 'dsmlSplit', 'dedupeText', 'fillerStrip', 'intentPrune'])
  assert.deepEqual(json.rules, { seamRepair: false, wrapThinking: false, letmeRewrite: false, dsmlSplit: false, dedupeText: false, fillerStrip: true, intentPrune: true })
  assert.equal(json.enabledCount, 0)
  assert.equal(json.overridden, false)
})

test('GET /state：回显会话 id', async () => {
  const { handler } = await boot()
  const { json } = await call(handler, 'GET', '/dsh-thinking-guard/state?sessionId=session-abc')
  assert.equal(json.sessionId, 'session-abc')
})

test('GET /state：未知路径 404', async () => {
  const { handler } = await boot()
  const { status, json } = await call(handler, 'GET', '/dsh-thinking-guard/nope')
  assert.equal(status, 404)
  assert.equal(json.ok, false)
})

test('PUT /rules：未知键被忽略，不落盘垃圾', async () => {
  const { handler, file } = await boot()
  const { status, json } = await call(handler, 'PUT', '/dsh-thinking-guard/rules', {
    sessionId: 'session-abc',
    rules: { madeUpRule: true },
  })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  const saved = JSON.parse(await readFile(file, 'utf8').catch(() => '{"sessions":{}}'))
  assert.deepEqual(saved.sessions, {})
})

test('PUT /rules：缺 sessionId 时报错而不是写进空键', async () => {
  const { handler } = await boot()
  const { status, json } = await call(handler, 'PUT', '/dsh-thinking-guard/rules', { rules: {} })
  assert.equal(status, 400)
  assert.equal(json.ok, false)
  assert.match(json.error, /sessionId/)
})

test('DELETE /rules：没有覆盖时也返回正常快照', async () => {
  const { handler } = await boot()
  const { status, json } = await call(handler, 'DELETE', '/dsh-thinking-guard/rules?sessionId=session-abc')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.sessionId, 'session-abc')
})

test('POST 与 PUT 等价，PATCH 拒绝', async () => {
  const { handler } = await boot()
  const posted = await call(handler, 'POST', '/dsh-thinking-guard/rules', { sessionId: 's1' })
  assert.equal(posted.status, 200)
  const patched = await call(handler, 'PATCH', '/dsh-thinking-guard/rules', {})
  assert.equal(patched.status, 405)
})

test('加一条规则后：会话隔离、计数正确、可恢复默认', async () => {
  const { handler, file } = await boot()

  // 模拟以后往 RULE_DEFS 里加一条
  RULE_DEFS.push({ key: 'demoRule', zh: '演示', en: 'Demo', default: false })

  const before = await call(handler, 'GET', '/dsh-thinking-guard/state?sessionId=sA')
  // 内置两条缺省都开，新增的 demoRule 缺省为关
  assert.equal(before.json.enabledCount, 0, '缺省全关')
  assert.deepEqual(before.json.defs.map((d) => d.key), ['seamRepair', 'wrapThinking', 'letmeRewrite', 'dsmlSplit', 'dedupeText', 'fillerStrip', 'intentPrune', 'demoRule'])

  const opened = await call(handler, 'PUT', '/dsh-thinking-guard/rules', {
    sessionId: 'sA',
    rules: { demoRule: true },
  })
  assert.equal(opened.json.enabledCount, 1)
  assert.equal(opened.json.overridden, true)

  // 另一个会话不受影响
  const other = await call(handler, 'GET', '/dsh-thinking-guard/state?sessionId=sB')
  assert.equal(other.json.enabledCount, 0)

  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.sessions.sA.demoRule, true)
  assert.equal(saved.sessions.sB, undefined)

  const cleared = await call(handler, 'DELETE', '/dsh-thinking-guard/rules?sessionId=sA')
  assert.equal(cleared.json.enabledCount, 0)
  assert.equal(cleared.json.overridden, false)

  RULE_DEFS.length = 7
})

test('坏掉的 JSON 文件不会把接口打挂', async () => {
  const { handler, file } = await boot()
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '{ this is not json', 'utf8')
  const { status, json } = await call(handler, 'GET', '/dsh-thinking-guard/state')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
})

test('响应头带 no-store 与 nosniff', async () => {
  const { handler } = await boot()
  const { headers } = await call(handler, 'GET', '/dsh-thinking-guard/state')
  assert.equal(headers['cache-control'], 'no-store')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.match(headers['content-type'], /application\/json/)
})





test('子代理默认继承父会话的规则', async () => {
  const parent = 'session-parent'
  const child = 'session-child'
  const sessions = new Map([[child, { origin: 'subagent', parentSession: parent }]])
  const { handler } = await boot({ sessions })
  // 父会话：打开封装 + 去重，关掉缝合
  await call(handler, 'PUT', '/dsh-thinking-guard/rules', {
    sessionId: parent,
    rules: { wrapThinking: true, dedupeText: true, seamRepair: false },
  })
  const view = await call(handler, 'GET', `/dsh-thinking-guard/state?sessionId=${child}`)
  assert.equal(view.json.rules.wrapThinking, true, '应继承父会话的开启')
  assert.equal(view.json.rules.dedupeText, true, '应继承父会话的开启')
  assert.equal(view.json.rules.seamRepair, false, '父会话关掉的，子代理也应关闭')
})

test('子代理自己声明过的键优先于继承', async () => {
  const parent = 'session-parent'
  const child = 'session-child'
  const sessions = new Map([[child, { origin: 'subagent', parentSession: parent }]])
  const { handler } = await boot({ sessions })
  await call(handler, 'PUT', '/dsh-thinking-guard/rules', {
    sessionId: parent,
    rules: { wrapThinking: true },
  })
  await call(handler, 'PUT', '/dsh-thinking-guard/rules', {
    sessionId: child,
    rules: { wrapThinking: false },
  })
  const view = await call(handler, 'GET', `/dsh-thinking-guard/state?sessionId=${child}`)
  assert.equal(view.json.rules.wrapThinking, false, '子代理显式关闭应生效')
})

test('普通会话不继承（没有父会话时用缺省）', async () => {
  const other = 'session-other'
  const { handler } = await boot({ sessions: new Map() })
  await call(handler, 'PUT', '/dsh-thinking-guard/rules', {
    sessionId: 'session-parent',
    rules: { wrapThinking: true },
  })
  const view = await call(handler, 'GET', `/dsh-thinking-guard/state?sessionId=${other}`)
  assert.equal(view.json.rules.wrapThinking, false, '缺省全关')
})

