/**
 * 思考块回传（provider 级）的测试。
 *
 * 语义：
 *   - 官方供应商（deepseek*）缺省回传，因为服务端要求多轮工具调用带 reasoning_content
 *   - 其它供应商缺省不回传
 *   - 任何供应商都可以被显式覆盖，并且持久化
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, providerKey, withoutReasoning } from '../index.js'

async function boot(file) {
  const dir = file === undefined ? await mkdtemp(path.join(tmpdir(), 'thinking-guard-')) : undefined
  const stateFile = file ?? path.join(dir, 'thinking-guard.json')
  let handler = null
  const ctx = {
    effect: (fn) => fn(),
    on: () => () => {},
    webServer: { register: (options) => { handler = options.handler } },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, { stateFile })
  return { handler, file: stateFile }
}

function response() {
  const res = {
    headersSent: false,
    status: 0,
    body: '',
    writeHead(status) { res.status = status; res.headersSent = true; return res },
    end(text) { if (typeof text === 'string') res.body += text },
  }
  return res
}

async function call(handler, method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = { method, url, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
  const res = response()
  await handler(req, res)
  return { status: res.status, json: JSON.parse(res.body || 'null') }
}

test('官方供应商缺省回传', async () => {
  const { handler } = await boot()
  const { json } = await call(handler, 'GET', '/dsh-thinking-guard/provider?providerId=deepseek-account')
  assert.equal(json.ok, true)
  assert.equal(json.official, true)
  assert.equal(json.replayThinking, true)
  assert.equal(json.overridden, false)
})

test('第三方供应商缺省不回传', async () => {
  const { handler } = await boot()
  const { json } = await call(handler, 'GET', '/dsh-thinking-guard/provider?providerId=example-provider')
  assert.equal(json.official, false)
  assert.equal(json.replayThinking, false)
})

test('覆盖值可写、可持久化、可清除', async () => {
  const { handler, file } = await boot()

  const put = await call(handler, 'PUT', '/dsh-thinking-guard/provider', {
    providerId: 'example-provider',
    replayThinking: true,
  })
  assert.equal(put.json.replayThinking, true)
  assert.equal(put.json.overridden, true)

  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.providers['example-provider'].replayThinking, true)

  // 重新装一次（模拟重启），状态要从文件读回来
  const again = await boot(file)
  const reread = await call(again.handler, 'GET', '/dsh-thinking-guard/provider?providerId=example-provider')
  assert.equal(reread.json.replayThinking, true)
  assert.equal(reread.json.overridden, true)

  const cleared = await call(again.handler, 'DELETE', '/dsh-thinking-guard/provider?providerId=example-provider')
  assert.equal(cleared.json.replayThinking, false)
  assert.equal(cleared.json.overridden, false)
})

test('官方供应商也可以被显式关掉', async () => {
  const { handler } = await boot()
  const put = await call(handler, 'PUT', '/dsh-thinking-guard/provider', {
    providerId: 'deepseek-account',
    replayThinking: false,
  })
  assert.equal(put.json.replayThinking, false)
  assert.equal(put.json.overridden, true)
})

test('官方供应商的不同 route id 归一到同一个桶', async () => {
  const { handler } = await boot()
  // 设置页里点的是 deepseek-official
  await call(handler, 'PUT', '/dsh-thinking-guard/provider', {
    providerId: 'deepseek-official',
    replayThinking: false,
  })
  // 请求层用的是 deepseek-account —— 必须读到同一个覆盖
  const fromStream = await call(handler, 'GET', '/dsh-thinking-guard/provider?providerId=deepseek-account')
  assert.equal(fromStream.json.replayThinking, false)
  assert.equal(fromStream.json.overridden, true)

  assert.equal(providerKey('deepseek-official'), 'deepseek')
  assert.equal(providerKey('deepseek-account'), 'deepseek')
  assert.equal(providerKey('example-provider'), 'example-provider')
})

test('非法入参被拒', async () => {
  const { handler } = await boot()
  const noId = await call(handler, 'PUT', '/dsh-thinking-guard/provider', { replayThinking: true })
  assert.equal(noId.status, 400)
  const badValue = await call(handler, 'PUT', '/dsh-thinking-guard/provider', {
    providerId: 'example-provider',
    replayThinking: 'yes',
  })
  assert.equal(badValue.status, 400)
})

test('withoutReasoning：只裁 assistant 的 reasoning 块', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '想一想' },
        { type: 'text', text: '答案' },
        { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' },
      ],
    },
  ]
  const out = withoutReasoning(messages)
  assert.equal(out[1].content.some((b) => b.type === 'reasoning'), false)
  assert.equal(out[1].content.length, 2)
  assert.equal(out[0], messages[0], '其它角色原样返回')
})

test('withoutReasoning：整条只有思考时保持原样，不产出空消息', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'reasoning', text: '只有思考' }] }]
  const out = withoutReasoning(messages)
  assert.deepEqual(out, messages)
})

test('withoutReasoning：没有可裁内容时返回同一个数组引用', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }]
  assert.equal(withoutReasoning(messages), messages)
})


