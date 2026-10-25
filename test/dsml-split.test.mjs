/**
 * DSML 切分测试。样本取自真实泄漏：
 *   思考块里混进了调用标记的尾段（开头被切掉的那种残缺也不能崩）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DsmlSplit, dsmlSplitStream } from '../dsml-split.js'

const start = (index, blockType) => ({ type: 'block-start', index, blockType })
const text = (index, value) => ({ type: 'text-delta', index, text: value })
const think = (index, value) => ({ type: 'reasoning-delta', index, text: value })
const end = (index, block) => ({ type: 'block-end', index, block })

function run(chunks) {
  const s = new DsmlSplit()
  const out = []
  for (const c of chunks) out.push(...s.push(c))
  out.push(...s.flush())
  return { chunks: out, stats: s.stats }
}

const CALL = '<｜DSML｜ calls><｜DSML｜ invoke name="run_code">'
  + '<｜DSML｜ parameter name="code" string="true">const x = 1</｜DSML｜ parameter>'
  + '</｜DSML｜ invoke></｜DSML｜ calls>'

test('思考块里的调用：前缀留思考，标记变 tool-call', () => {
  const body = 'I should verify. ' + CALL
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
  ])
  assert.equal(stats.split, 1)
  assert.equal(stats.calls, 1)

  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(reasoning, 'I should verify. ')

  const delta = chunks.find((c) => c.type === 'tool-call-delta')
  assert.ok(delta, '必须有 tool-call')
  assert.equal(delta.name, 'run_code')
  assert.equal(JSON.parse(delta.argumentsDelta).code, 'const x = 1')

  const closing = chunks.find((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal(closing.block.text.trim(), 'I should verify.', '思考块只保留前缀')

  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!textOut.includes('DSML'), '正文不应残留 markup')
})

test('正文块里的调用：前缀变思考？不——保持正文，只切出 tool-call', () => {
  const body = 'Let me run it. ' + CALL
  const { chunks } = run([
    start(0, 'text'),
    text(0, body),
    end(0, { type: 'text', text: body }),
  ])
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(textOut, 'Let me run it. ', '正文前缀保持正文')
  assert.ok(chunks.some((c) => c.type === 'tool-call-delta'))
})

test('标记残缺（只有尾段）：解析不出就原样吐回，不吞内容', () => {
  const body = 'I will run it.</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>'
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(reasoning, body, '内容必须完整保留')
})

test('没有标记：逐 chunk 原样放行', () => {
  const body = '普通思考内容。'
  const input = [
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
  ]
  const { chunks, stats } = run(input)
  assert.equal(stats.split, 0)
  assert.deepEqual(chunks, input)
})

test('标记跨 chunk 也能认出来', () => {
  const body = '前</｜DSML｜ invoke></｜DSML｜ calls>'
  const call = CALL
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, 'prefix ' + call.slice(0, 12)),
    think(0, call.slice(12)),
    end(0, { type: 'reasoning', text: 'prefix ' + call }),
  ])
  assert.ok(chunks.some((c) => c.type === 'tool-call-delta'))
  void body
})

test('dsmlSplitStream：异步流正确收尾', async () => {
  const body = 'p ' + CALL
  async function* source() {
    yield start(0, 'reasoning')
    yield think(0, body)
    yield end(0, { type: 'reasoning', text: body })
  }
  const out = []
  for await (const c of dsmlSplitStream(source())) out.push(c)
  assert.ok(out.some((c) => c.type === 'tool-call-delta'))
})


test('已经有结构化调用时：不补发合成调用（避免执行两次）', () => {
  const body = 'thinking ' + CALL
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
    start(1, 'tool-call'),
    { type: 'tool-call-delta', index: 1, id: 'real', name: 'run_code', argumentsDelta: '{"code":"const x = 1"}' },
    end(1, { type: 'tool-call', id: 'real', name: 'run_code', arguments: '{"code":"const x = 1"}' }),
  ])
  const synth = chunks.filter((c) => c.type === 'tool-call-delta' && c.id.startsWith('call_dsml_'))
  assert.equal(synth.length, 0, '不应补发')
  assert.ok(stats.dropped >= 1)
  // 思考里的 markup 仍需切掉，不能留在思考里
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(!reasoning.includes('DSML'))
})

test('没有结构化调用时：合成调用会在收尾前补发', () => {
  const body = 'thinking ' + CALL
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const synth = chunks.filter((c) => c.type === 'tool-call-delta' && c.id.startsWith('call_dsml_'))
  assert.equal(synth.length, 1)
  // 必须出现在 finish 之前
  const finishAt = chunks.findIndex((c) => c.type === 'finish')
  const callAt = chunks.findIndex((c) => c.type === 'tool-call-delta')
  assert.ok(callAt < finishAt, '调用必须在 finish 之前')
})

test('思考块里的 </thinking>：在那里收口，后面转为正文', () => {
  const body = 'First: launch + wait.</thinking> 桥又在每个回合结束时被杀掉。本轮内一次做完。'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
  ])
  assert.equal(stats.closedTag, 1)
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(reasoning, 'First: launch + wait.')
  assert.ok(!reasoning.includes('</thinking>'), '思考里不能残留标记')
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(textOut.includes('桥又在每个回合结束时被杀掉'))
  // 思考块与正文块都要有结束，且不能重复
  const ends = chunks.filter((c) => c.type === 'block-end')
  assert.equal(ends.length, 2, `结束块应当正好两个，实际 ${ends.length}`)
})

test('思考块里 </thinking> + DSML：先收口，再切出调用', () => {
  const body = 'plan.</thinking> 答复开头。' + CALL
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(stats.closedTag, 1)
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(reasoning, 'plan.')
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(textOut.includes('答复开头'))
  assert.ok(!textOut.includes('DSML'))
  assert.ok(chunks.some((c) => c.type === 'tool-call-delta'))
})

test('文本里「提到」的思考结束标记不算收口（反引号/引号包住的）', () => {
  const body = 'We treat `</thinking>` as a literal here, then keep going. Still thinking.'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
  ])
  assert.equal(stats.closedTag, 0, '不能被字面串切断')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(reasoning, body)
  assert.equal(chunks.filter((c) => c.type === 'text-delta').length, 0)
})

test('真正的收口标记仍然生效（不带引号）', () => {
  const body = 'plan done.</thinking> 后面的正文。'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
  ])
  assert.equal(stats.closedTag, 1)
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(reasoning, 'plan done.')
})

test('宽匹配：块内容只有一个 </summary> 残标记时不能原样漏出', () => {
  const body = '</summary>'
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
  ])
  const all = chunks.filter((c) => c.type === 'reasoning-delta' || c.type === 'text-delta')
    .map((c) => c.text).join('')
  assert.ok(!all.includes('</summary>'), `标记不应出现在内容里：${all}`)
})

test('宽匹配：内容只在 block-end 里（无 delta）也要处理', () => {
  const body = 'thinking prose</summary>答复'
  const { chunks } = run([
    start(0, 'reasoning'),
    end(0, { type: 'reasoning', text: body }),
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!(reasoning + textOut).includes('</summary>'), '标记必须被吃掉')
  assert.ok((reasoning + textOut).includes('thinking prose'))
})

