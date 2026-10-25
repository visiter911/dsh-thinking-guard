/**
 * 思考块自动封装的测试。
 *
 * 口径：
 *   1. 本轮已有思考块 → 不介入
 *   2. 以 # 起手 → 正文
 *   3. 开头像进度汇报 → 继续缓冲：块内结束=正文；出现 # 按前缀长短处理；
 *      超过 400 字符仍无 # → 思考
 *   4. 其它 → 按思考流式发出，出现行首 # 就切
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPTURE_LIMIT,
  SHORT_PREFIX,
  WrapRepair,
  classifyPrefix,
  reportScore,
  wrapStream,
} from '../wrap.js'

const start = (index, blockType) => ({ type: 'block-start', index, blockType })
const text = (index, value) => ({ type: 'text-delta', index, text: value })
const think = (index, value) => ({ type: 'reasoning-delta', index, text: value })
const end = (index, block) => ({ type: 'block-end', index, block })

function run(chunks) {
  const wrap = new WrapRepair()
  const out = []
  for (const chunk of chunks) out.push(...wrap.push(chunk))
  out.push(...wrap.flush())
  return { chunks: out, stats: wrap.stats }
}

/** 极简 assembler：按首次 block-start 顺序，首个 block-end 定型。 */
function assemble(chunks) {
  const order = []
  const partials = new Map()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') {
      if (!partials.has(chunk.index)) {
        order.push(chunk.index)
        partials.set(chunk.index, { type: chunk.blockType, text: '' })
      }
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      let partial = partials.get(chunk.index)
      if (partial === undefined) {
        partial = { type, text: '' }
        partials.set(chunk.index, partial)
        order.push(chunk.index)
      }
      partial.text += chunk.text
    } else if (chunk.type === 'block-end') {
      const partial = partials.get(chunk.index)
      if (partial !== undefined) {
        partial.text = chunk.block.text ?? partial.text
        partial.type = chunk.block.type ?? partial.type
      }
    }
  }
  return order.map((index) => partials.get(index)).filter((b) => b.text !== '')
}

test('进度汇报（短）：判为正文，不被藏进思考', () => {
  const body = '12 个客户端测试全部通过。我来检查训练。'
  const input = [start(0, 'text'), text(0, body), end(0, { type: 'text', text: body })]
  const { chunks, stats } = run(input)
  assert.equal(stats.wrapped, 0)
  assert.equal(stats.held, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[0].text, body)
})

test('汇报式开头但超过上限仍无 #：提前定案为思考', () => {
  const filler = '部署脚本已经跑完，日志里没有报错，接下来要把这些记录同步到仓库里。'.repeat(50)
  const body = '已完成部署。' + filler
  assert.ok(body.length > CAPTURE_LIMIT)
  const { chunks, stats } = run([start(0, 'text'), text(0, body), end(0, { type: 'text', text: body })])
  assert.equal(stats.wrapped, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks[0].type, 'reasoning')
})

test('非汇报开头 + 后面跟 tool call：折叠成思考', () => {
  const body = '让我先确认一下协议，再决定怎么改。'
  const { chunks, stats } = run([
    start(0, 'text'),
    text(0, body),
    end(0, { type: 'text', text: body }),
    start(1, 'tool-call'),
    { type: 'tool-call-delta', index: 1, id: 'c1', name: 'pwsh', argumentsDelta: '{}' },
    end(1, { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }),
  ])
  assert.equal(stats.wrapped, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks[0].type, 'reasoning')
  assert.equal(blocks[0].text, body)
})

test('关键保证：非汇报开头 + 直接收尾 → 最终正文不被吃', () => {
  const body = '让我先确认一下协议，再决定怎么改。'
  const { chunks, stats } = run([
    start(0, 'text'),
    text(0, body),
    end(0, { type: 'text', text: body }),
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(stats.wrapped, 0)
  const blocks = assemble(chunks)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[0].text, body)
})

test('汇报式开头 + 出现 # 且前缀短：整块正文', () => {
  const prefix = '所有工作已完成。以下是我查到的结果。\n\n'
  const rest = '## 核心发现\n\n正文内容。'
  const body = prefix + rest
  assert.ok(prefix.length <= SHORT_PREFIX)
  const { chunks, stats } = run([start(0, 'text'), text(0, body), end(0, { type: 'text', text: body })])
  assert.equal(stats.split, 0)
  const blocks = assemble(chunks)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[0].text, body)
})

test('汇报式开头 + 出现 # 且前缀长：从 # 处切开', () => {
  const prefix = '已完成部署，下面把这次改动的来龙去脉说清楚，免得以后忘记为什么这么改。'.repeat(4) + '\n\n'
  const rest = '## 改动\n\n内容。'
  assert.ok(prefix.length > SHORT_PREFIX)
  const body = prefix + rest
  const { chunks, stats } = run([start(0, 'text'), text(0, body), end(0, { type: 'text', text: body })])
  assert.equal(stats.split, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks[0].type, 'reasoning')
  assert.equal(blocks[0].text, prefix)
  assert.equal(blocks[1].type, 'text')
  assert.equal(blocks[1].text, rest)
})

test('不像汇报、块内没有 #、后面跟 tool call：整块思考', () => {
  const body = '让我先确认一下协议，再决定怎么改。'
  const { chunks, stats } = run([
    start(0, 'text'),
    text(0, body),
    end(0, { type: 'text', text: body }),
    start(1, 'tool-call'),
    end(1, { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }),
  ])
  assert.equal(stats.wrapped, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks[0].type, 'reasoning')
  assert.equal(blocks[0].text, body)
})

test('显式标记：本轮已有思考块时，标记内部追加进同一个思考块', () => {
  const thinkText = '原本就在思考。'
  const body = '<thinking>补充推理。</thinking>已定位并激活 NVLINK 页。'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, thinkText),
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
    end(0, { type: 'reasoning', text: thinkText }),
  ])
  assert.equal(stats.spans, 1)
  const blocks = assemble(chunks)
  const reasoning = blocks.filter((b) => b.type === 'reasoning')
  assert.equal(reasoning.length, 1, '不能新开第二个思考块')
  assert.equal(reasoning[0].text, thinkText + '补充推理。')
  const texts = blocks.filter((b) => b.type === 'text')
  assert.equal(texts.length, 1)
  assert.equal(texts[0].text, '已定位并激活 NVLINK 页。')
})

test('显式标记：本轮没有思考块时，标记内部整段变思考', () => {
  const body = '<thinking>Good, NVLINK doc opened.</thinking> 现在读取 CN5。'
  const { chunks, stats } = run([
    start(0, 'text'),
    text(0, body),
    end(0, { type: 'text', text: body }),
  ])
  assert.equal(stats.spans, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks[0].type, 'reasoning')
  assert.equal(blocks[0].text, 'Good, NVLINK doc opened.')
  assert.equal(blocks[1].type, 'text')
  assert.equal(blocks[1].text, ' 现在读取 CN5。')
})

test('显式标记跨 chunk：仍能切准', () => {
  const { chunks, stats } = run([
    start(0, 'text'),
    text(0, '前置<thin'),
    text(0, 'king>内部</thin'),
    text(0, 'king>后置'),
    end(0, { type: 'text', text: '前置<thinking>内部</thinking>后置' }),
  ])
  assert.equal(stats.spans, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[0].text, '前置')
  assert.equal(blocks[1].type, 'reasoning')
  assert.equal(blocks[1].text, '内部')
  assert.equal(blocks[2].type, 'text')
  assert.equal(blocks[2].text, '后置')
})

test('显式标记：没有闭合时其后全部按思考处理', () => {
  const body = '<thinking>一直在想，没有收尾。'
  const { chunks } = run([
    start(0, 'text'),
    text(0, body),
    end(0, { type: 'text', text: body }),
  ])
  const blocks = assemble(chunks)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'reasoning')
})

test('以 # 起手：正文，原样放行', () => {
  const body = '## 改动清单\n\n- 第一项'
  const input = [start(0, 'text'), text(0, body), end(0, { type: 'text', text: body })]
  const { chunks, stats } = run(input)
  assert.equal(stats.wrapped, 0)
  assert.deepEqual(chunks, input)
})

test('本轮已有思考块：其后的正文不再封装', () => {
  const thinkText = '让我先确认一下协议。'
  const body = '查完了，三条线都干净。'
  const input = [
    start(0, 'reasoning'),
    think(0, thinkText),
    end(0, { type: 'reasoning', text: thinkText }),
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
  ]
  const { chunks, stats } = run(input)
  assert.equal(stats.wrapped, 0)
  assert.deepEqual(chunks, input)
})

test('思考流里出现 #：切分，切点之前全部归思考', () => {
  const prefix = '让我先看看实现，然后再决定。\n\n'
  const rest = '# 结论\n\n改好了。'
  const body = prefix + rest
  const { chunks, stats } = run([start(0, 'text'), text(0, body), end(0, { type: 'text', text: body })])
  assert.equal(stats.split, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks[0].type, 'reasoning')
  assert.equal(blocks[0].text, prefix)
  assert.equal(blocks[1].type, 'text')
  assert.equal(blocks[1].text, rest)
})

test('切分点跨 chunk 也能识别', () => {
  const { chunks, stats } = run([
    start(0, 'text'),
    text(0, '让我想一下。\n'),
    text(0, '# 标题\n正文'),
    end(0, { type: 'text', text: '让我想一下。\n# 标题\n正文' }),
  ])
  assert.equal(stats.split, 1)
  const blocks = assemble(chunks)
  assert.equal(blocks[0].type, 'reasoning')
  assert.equal(blocks[1].type, 'text')
})

test('空块：当正文收尾，不造空思考块', () => {
  const input = [start(0, 'text'), text(0, '   '), end(0, { type: 'text', text: '   ' })]
  const { chunks, stats } = run(input)
  assert.equal(stats.wrapped, 0)
  const blocks = assemble(chunks)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
})

test('思考块与工具调用块完全不受影响', () => {
  const input = [
    start(0, 'reasoning'),
    think(0, '正常思考'),
    end(0, { type: 'reasoning', text: '正常思考' }),
    start(1, 'tool-call'),
    { type: 'tool-call-delta', index: 1, id: 'c1', name: 'pwsh', argumentsDelta: '{}' },
    end(1, { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }),
  ]
  const { chunks, stats } = run(input)
  assert.equal(stats.wrapped, 0)
  assert.deepEqual(chunks, input)
})

test('classifyPrefix：只有 # 起手才算正文', () => {
  assert.equal(classifyPrefix('# 标题'), 'content')
  assert.equal(classifyPrefix('查完了。'), 'thinking')
  assert.equal(classifyPrefix(''), 'content')
})

test('reportScore：汇报高、思考低', () => {
  assert.ok(reportScore('12 个客户端测试全部通过。我来检查训练。') >= 3)
  assert.ok(reportScore('第一个检查点已保存。') >= 3)
  assert.ok(reportScore('Let me check the parser first.') < 3)
  assert.ok(reportScore('嗯，让我先想想。') < 3)
  assert.ok(reportScore('- 第一项\n- 第二项') < 3)
})

test('wrapStream：异步流里最终正文不被吃', async () => {
  const body = 'Hmm, wait. Let me look at the stream code again to be sure about the block indices and shapes.'
  async function* source() {
    yield start(0, 'text')
    yield text(0, body)
    yield end(0, { type: 'text', text: body })
  }
  const out = []
  for await (const chunk of wrapStream(source())) out.push(chunk)
  const blocks = assemble(out)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[0].text, body)
})

test('含 DSML 的块：头之前进思考，markup 变成真正的 tool-call', () => {
  const body = 'Native status shows one doc. Let me switch.'
    + '<｜DSML｜ calls><｜DSML｜ invoke name="run_code">'
    + '<｜DSML｜ parameter name="code" string="true">const x = 1</｜DSML｜ parameter>'
    + '</｜DSML｜ invoke></｜DSML｜ calls>'
  const { chunks, stats } = run([
    start(0, 'text'),
    text(0, body),
    end(0, { type: 'text', text: body }),
  ])
  assert.equal(stats.dsml, 1)

  // 头之前的内容成为思考块
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(reasoning, 'Native status shows one doc. Let me switch.')

  // markup 变成结构化 tool-call
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0].name, 'run_code')
  assert.equal(JSON.parse(deltas[0].argumentsDelta).code, 'const x = 1')

  const start2 = chunks.find((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  assert.ok(start2, '必须有 tool-call 块开始')
  const end2 = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.ok(end2, '必须有 tool-call 块结束')

  // 正文里不再残留 markup
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!textOut.includes('DSML'), `正文不应残留 markup：${textOut}`)
})


test('连续两个正文块：第二个也必须被判定，不能被当成「忙」放行', () => {
  const answer = '桥在回合之间又被清掉了。'
  const thinking = 'Bridge unreachable again — it died between calls. Wait, maybe the harness kills the tree at turn end. ' .repeat(20)
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, 'previous thinking'),
    end(0, { type: 'reasoning', text: 'previous thinking' }),
    start(1, 'text'),
    text(1, answer),
    start(2, 'text'),
    text(2, thinking),
    end(2, { type: 'text', text: thinking }),
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(stats.wrapped, 1, '第二个正文块应当被判为思考')
  const blocks = assemble(chunks)
  const textOut = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  assert.equal(textOut, answer, '正文只应保留那句中文答复')
  assert.ok(blocks.some((b) => b.type === 'reasoning' && b.text.includes('Bridge unreachable again')))
})


test('没有 block-start 的正文块（只有 delta）：也要探测', () => {
  const body = '<thinking>Many errors again. Notable: rP_le_cos fails at line 58. Let me analyze.'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, 'previous thinking'),
    end(0, { type: 'reasoning', text: 'previous thinking' }),
    start(1, 'tool-call'),
    { type: 'tool-call-delta', index: 1, id: 'x', name: 'x', argumentsDelta: '{}' },
    end(1, { type: 'tool-call', id: 'x', name: 'x', arguments: '{}' }),
    // 注意：这里故意不发 block-start
    text(2, body),
    end(2, { type: 'text', text: body }),
  ])
  assert.equal(stats.spans, 1, '标记应当被识别')
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!textOut.includes('<thinking>'), `正文不应残留标记：${textOut}`)
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(reasoning.includes('Many errors again'))
})

test('只有 block-end、没有 delta 的正文块：同样要判定', () => {
  const body = '<thinking>Many errors again. The lemma fails at line 58. Let me analyze it.'
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, 'previous'),
    end(0, { type: 'reasoning', text: 'previous' }),
    start(1, 'tool-call'),
    { type: 'tool-call-delta', index: 1, id: 'x', name: 'x', argumentsDelta: '{}' },
    end(1, { type: 'tool-call', id: 'x', name: 'x', arguments: '{}' }),
    end(2, { type: 'text', text: body }),
  ])
  assert.equal(stats.spans, 1, '标记必须被识别')
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!textOut.includes('<thinking>'), `正文不能残留标记：${textOut}`)
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(reasoning.includes('Many errors again'), '内容应改判为思考')
})

test('正文里的 </thinking>：之前归思考，之后按正文发出且不再被吃', () => {
  const body = 'Let me check the lemma. It needs h3.\n</thinking>\n三个问题都定位了：sin_lt_sin 要严格 e < a。逐条修正：'
  const { chunks, stats } = run([
    start(0, 'text'),
    text(0, body),
    end(0, { type: 'text', text: body }),
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(!textOut.includes('</thinking>'), '正文不能残留标记')
  assert.ok(textOut.includes('三个问题都定位了'), `答复必须留在正文：${textOut}`)
  assert.ok(reasoning.includes('Let me check the lemma'))
  assert.ok(!reasoning.includes('三个问题都定位了'), '答复不能被吃进思考')
})

