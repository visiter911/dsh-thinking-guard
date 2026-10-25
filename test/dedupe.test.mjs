/**
 * 重复块消解的测试。
 *
 * 样本来自 session-example 的真实落盘：思考块与正文块逐字节相同（1523 字符）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DuplicateText, dedupeStream } from '../dedupe.js'

const start = (index, blockType) => ({ type: 'block-start', index, blockType })
const text = (index, value) => ({ type: 'text-delta', index, text: value })
const think = (index, value) => ({ type: 'reasoning-delta', index, text: value })
const end = (index, block) => ({ type: 'block-end', index, block })

function run(chunks) {
  const d = new DuplicateText()
  const out = []
  for (const c of chunks) out.push(...d.push(c))
  out.push(...d.flush())
  return { chunks: out, stats: d.stats }
}

function assemble(chunks) {
  const order = []
  const partials = new Map()
  for (const c of chunks) {
    if (c.type === 'block-start') {
      if (!partials.has(c.index)) {
        order.push(c.index)
        partials.set(c.index, { type: c.blockType, text: '' })
      }
    } else if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
      const type = c.type === 'text-delta' ? 'text' : 'reasoning'
      let p = partials.get(c.index)
      if (p === undefined) {
        p = { type, text: '' }
        partials.set(c.index, p)
        order.push(c.index)
      }
      p.text += c.text
    } else if (c.type === 'block-end') {
      const p = partials.get(c.index)
      if (p) {
        p.text = c.block.text ?? p.text
        p.type = c.block.type ?? p.type
      }
    }
  }
  return order.map((i) => partials.get(i)).filter((b) => b.text !== '')
}

test('真实样本：正文与思考逐字节相同 → 丢弃正文，只留思考块', () => {
  const body = '<thinking>Confirmed: current state has all 32 mirrored pairs in place.</thinking>'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
  ])
  assert.equal(stats.dropped, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'reasoning')
  assert.equal(blocks[0].text, body)
})

test('正文与思考不同 → 原样放行', () => {
  const thinkText = '<thinking>Confirmed: all pairs are in place.</thinking>'
  const body2 = '改好了，一共修了三处。'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, thinkText),
    end(0, { type: 'reasoning', text: thinkText }),
    start(1, 'text'),
    text(1, body2),
    end(1, { type: 'text', text: body2 }),
  ])
  assert.equal(stats.dropped, 0)
  const blocks = assemble(chunks)
  assert.equal(blocks[1].text, '改好了，一共修了三处。')
})

test('共享很长的前缀但最后分叉 → 照抄部分切掉，结论保留', () => {
  const common = 'Bridge is up with wsClients=1 but instances is empty. '.repeat(20)
  const thinkText = common + 'So I should restart the bridge.'
  const body = common + '结论：需要重启桥接进程。'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, thinkText),
    end(0, { type: 'reasoning', text: thinkText }),
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
  ])
  // 照抄的那段包成第二个思考块，正文只留结论
  const blocks = assemble(chunks)
  const kept = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  assert.ok(kept.includes('结论：需要重启桥接进程。'), `结论不能丢：${kept}`)
  assert.ok(kept.length < 100, '照抄的开头不应留在正文')
  assert.equal(blocks.filter((b) => b.type === 'reasoning').length, 1, '重复部分应被丢弃，不产生第二个思考块')
})

test('正文只是思考的前缀（更短）也算重复', () => {
  const thinkText = '一句话的思考，后面还有内容。'
  const body = '一句话的思考'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, thinkText),
    end(0, { type: 'reasoning', text: thinkText }),
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
  ])
  assert.equal(stats.dropped, 1)
  assert.equal(assemble(chunks).length, 1)
})

test('没有思考块时不做任何事', () => {
  const body = '普通正文'
  const input = [start(0, 'text'), text(0, body), end(0, { type: 'text', text: body })]
  const { chunks, stats } = run(input)
  assert.equal(stats.dropped, 0)
  assert.deepEqual(chunks, input)
})

test('多个正文块：只处理和思考块相邻的那一个', () => {
  const thinkText = 'A'.repeat(40)
  const dup = thinkText
  const next = 'B'.repeat(20)
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, thinkText),
    end(0, { type: 'reasoning', text: thinkText }),
    start(1, 'text'),
    text(1, dup),
    end(1, { type: 'text', text: dup }),
    start(2, 'text'),
    text(2, next),
    end(2, { type: 'text', text: next }),
  ])
  assert.equal(stats.dropped, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].text, next)
})

test('dedupeStream：异步流正确收尾', async () => {
  const body = '<thinking>x</thinking>'
  async function* source() {
    yield start(0, 'reasoning')
    yield think(0, body)
    yield end(0, { type: 'reasoning', text: body })
    yield start(1, 'text')
    yield text(1, body)
    yield end(1, { type: 'text', text: body })
  }
  const out = []
  for await (const c of dedupeStream(source())) out.push(c)
  assert.equal(assemble(out).length, 1)
})

test('含 DSML 的重复正文：不能删，否则调用会丢', () => {
  const body = 'Let me run it. <｜DSML｜ calls><｜DSML｜ invoke name="run_code"></｜DSML｜ invoke></｜DSML｜ calls>'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, body),
    end(0, { type: 'reasoning', text: body }),
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
  ])
  assert.equal(stats.dropped, 0, '不能删')
  const joined = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(joined.includes('DSML'))
})

test('正文比思考更长且以完整思考开头：只保留多出来的部分', () => {
  const thinkText = 'Bridge unreachable again — it died between calls.'
  const extra = ' 桥在回合之间又被清掉了。先查一下安装位置。'
  const body = thinkText + extra
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, thinkText),
    end(0, { type: 'reasoning', text: thinkText }),
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
  ])
  assert.equal(stats.dropped, 1)
  const outText = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(outText, extra, '重复的思考前缀必须被丢掉')
})

test('改写版正文（词句被替换）也要识别为重复', () => {
  const reasoning = 'Now I can see all three remaining issues clearly. Line 95 rP_le_rmax: I wrote haq a < q but hea e <= a and heq e < q so the correct derivation is from hea and heq we get a >= e and e < q which does not give a < q. Actually I need the reverse order because the argument should be haq a < q and where does it come from. It should be from heq and hea, no. e < q and e <= a gives nothing about a versus q.'
  const body = 'Now I can see all three remaining issues clearly. Line 95 rP_le_rmax: I wrote haq a < q but hea e <= a and heq e < q so the correct derivation is from hea and heq we get a >= e and e < q which does not give a < q! Actually for rP_eq_rmax I need a < q the hypothesis of threshold_value. Where does a < q come from. In Pp_mem_F4 F6 contexts C_mem_F4 had heq e < q and hea e <= a so a < q is not derivable but wait the threshold gives e < q and if e <= a then a could exceed q.'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, reasoning),
    end(0, { type: 'reasoning', text: reasoning }),
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
  ])
  assert.ok(stats.dropped >= 1, '应判为重复')
  const outText = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(outText, '', '整块都是重复，正文不应保留任何内容')
  const reasonings = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal(reasonings.length, 1, '不应产生第二个思考块')
})

test('真正的中文答复不会被误删', () => {
  const reasoning = 'The parser fails because the adapter maps reasoning_content into the thinking channel. We should check the adapter code and fix the mapping.'
  const answer = '问题在适配器：它把 reasoning_content 直接当成思考通道的输入。我把映射改成了先比较内容再决定通道。'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, reasoning),
    end(0, { type: 'reasoning', text: reasoning }),
    start(1, 'text'),
    text(1, answer),
    end(1, { type: 'text', text: answer }),
  ])
  assert.equal(stats.dropped, 0)
  const outText = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(outText, answer)
})






test('丢弃重复正文时，后面的工具调用必须原样保留', () => {
  const thinkText = 'The bridge died again. I should relaunch it and then check the pid.'
  const dup = thinkText
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, thinkText),
    end(0, { type: 'reasoning', text: thinkText }),
    start(1, 'text'),
    text(1, dup),
    end(1, { type: 'text', text: dup }),
    start(2, 'tool-call'),
    { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'pwsh', argumentsDelta: '{"command":"x"}' },
    end(2, { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"x"}' }),
  ])
  assert.ok(stats.dropped >= 1, '重复正文应被丢弃')
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(textOut, '')
  const call = chunks.find((c) => c.type === 'tool-call-delta')
  assert.ok(call, '工具调用必须保留')
  assert.equal(call.name, 'pwsh')
})


