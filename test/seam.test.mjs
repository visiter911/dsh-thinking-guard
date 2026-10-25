/**
 * 走道缝合的测试。
 *
 * 样本全部来自真实会话落盘数据（session-759b2019, seq 23061）——
 * 不自己编形态，避免「按想象写正则」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { SeamRepair, joinsAsSentence, tailLooksOpen } from '../seam.js'

/** 跑一遍转换器，返回 { chunks, stats }。 */
function run(chunks) {
  const repair = new SeamRepair()
  const out = []
  for (const chunk of chunks) out.push(...repair.push(chunk))
  out.push(...repair.flush())
  return { chunks: out, stats: repair.stats }
}

const start = (index, blockType) => ({ type: 'block-start', index, blockType })
const text = (index, value) => ({ type: 'text-delta', index, text: value })
const think = (index, value) => ({ type: 'reasoning-delta', index, text: value })
const end = (index, block) => ({ type: 'block-end', index, block })

/** 真实样本：思考尾部断在反引号里的 ` thinking，正文紧接着闭掉它。 */
const LEAK_TAIL = 'Then design:\n- A repair pass that runs on the stream, detecting:\n  a) malformed reasoning blocks: e.g. ` thinking...'
const LEAK_HEAD = '` or `<analysis>`, stray closing tags, unbalanced tags, reasoning content that arrives on the text channel wrapped in tags.\n\nThis is a big task. I should first investigate the harness source'
const LEAK_MARKER = '\n\nSearch for DSML in the checkout.</think>先弄清真实协议，再动代码。'

test('真实样本：思考接到真标记为止，标记之后仍是正文', () => {
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, LEAK_TAIL),
    start(1, 'text'),
    text(1, LEAK_HEAD),
    text(1, LEAK_MARKER),
    end(1, { type: 'text', text: LEAK_HEAD + LEAK_MARKER }),
    end(0, { type: 'reasoning', text: LEAK_TAIL }),
  ])

  assert.equal(stats.folded, 1)

  const starts = chunks.filter((c) => c.type === 'block-start')
  assert.deepEqual(starts, [start(0, 'reasoning'), start(1, 'text')])

  const reasoningText = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const textText = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

  // 被误判的那半截进了思考
  assert.ok(reasoningText.includes('stray closing tags'), '正文前段应并入思考')
  assert.ok(reasoningText.includes('Search for DSML in the checkout.'), '标记之前的思考应收全')
  // 标记之后的真答案仍是正文
  assert.equal(textText, '先弄清真实协议，再动代码。')
  // 标记本身被消费掉，不留在任何通道里
  assert.ok(!reasoningText.includes('</think>'))
  assert.ok(!textText.includes('</think>'))
})

test('关键：并入思考的内容必须补进 block-end，否则历史里会丢失', () => {
  const original = 'Bridge is up but instances is empty. Let me scan for `'
  const folded = '` / `'
  const marked = `${folded}</think> and measure lengths.`
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, original),
    start(1, 'text'),
    text(1, marked),
    end(1, { type: 'text', text: marked }),
    end(0, { type: 'reasoning', text: original }),
  ])
  const reasoningEnd = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal(reasoningEnd.length, 1)
  assert.equal(reasoningEnd[0].block.text, original + folded, 'block-end 必须带上并入的部分')
  // 标记之后仍是正文，且不丢
  const textText = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(textText, ' and measure lengths.')
})

test('没有真正结束标记时：整块并入思考，不会凭空开正文块', () => {
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, LEAK_TAIL),
    start(1, 'text'),
    text(1, LEAK_HEAD),
    end(1, { type: 'text', text: LEAK_HEAD }),
  ])
  const starts = chunks.filter((c) => c.type === 'block-start')
  assert.deepEqual(starts, [start(0, 'reasoning')])
  assert.equal(chunks.filter((c) => c.type === 'block-end').length, 0)
})

test('正常回答：思考已说完，正文不许被动', () => {
  const tail = 'So conclusion: the plugin is fully gone from the load graph. The screenshot content is the model own output, not a plugin artifact'
  const head = '查完了，三条线都干净：'
  const input = [
    start(0, 'reasoning'),
    think(0, tail),
    start(1, 'text'),
    text(1, head),
    end(1, { type: 'text', text: head }),
    end(0, { type: 'reasoning', text: tail }),
  ]
  const { chunks, stats } = run(input)

  assert.equal(stats.folded, 0)
  assert.deepEqual(chunks, input, '应当逐 chunk 原样返回')
})

test('拉丁词被劈开：接回去', () => {
  const { stats, chunks } = run([
    start(0, 'reasoning'),
    think(0, 'I need to read the thin'),
    start(1, 'text'),
    text(1, 'king about this protocol carefully.'),
    end(1, { type: 'text', text: 'king about this protocol carefully.' }),
  ])
  assert.equal(stats.folded, 1)
  assert.equal(stats.reasons['split-word'], 1)
  assert.equal(chunks.filter((c) => c.type === 'block-start').length, 1)
})

test('尾部停在逗号：接回去', () => {
  const { stats } = run([
    start(0, 'reasoning'),
    think(0, '先确认协议，然后'),
    start(1, 'text'),
    text(1, '，再决定要不要改。'),
  ])
  assert.equal(stats.folded, 1)
})

test('思考里没有块 / 正文在前：完全不介入', () => {
  const input = [
    start(0, 'text'),
    text(0, '直接就是正文，前面没有思考块。'),
    end(0, { type: 'text', text: '直接就是正文，前面没有思考块。' }),
  ]
  const { chunks, stats } = run(input)
  assert.equal(stats.folded, 0)
  assert.deepEqual(chunks, input)
})

test('正文以结构标记开头：不并', () => {
  const { stats } = run([
    start(0, 'reasoning'),
    think(0, 'Let me plan the edits'),
    start(1, 'text'),
    text(1, '## 改动清单\n\n- 第一项'),
  ])
  assert.equal(stats.folded, 0)
})

test('正文另起一段（思考以换行结束）：不并', () => {
  const { stats } = run([
    start(0, 'reasoning'),
    think(0, 'That is the plan.\n'),
    start(1, 'text'),
    text(1, '现在开始执行。'),
  ])
  assert.equal(stats.folded, 0)
})

test('正文块很短就结束：仍按接缝裁决', () => {
  const { stats } = run([
    start(0, 'reasoning'),
    think(0, 'the answer is in the thin'),
    start(1, 'text'),
    text(1, 'king'),
    end(1, { type: 'text', text: 'king' }),
  ])
  assert.equal(stats.folded, 1)
})

test('流在 pending 中途断掉：原样放行，不丢内容', () => {
  const input = [
    start(0, 'reasoning'),
    think(0, 'because the file is'),
    start(1, 'text'),
    text(1, 'X'),
  ]
  const { chunks } = run(input)
  // 没攒够就不裁决，flush 时把 block-start + delta 原样补回
  assert.equal(chunks.filter((c) => c.type === 'block-start').length, 2)
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'X'))
})

test('joinsAsSentence：连接词收尾算接缝', () => {
  assert.equal(joinsAsSentence('blah and', 'more text').join, true)
  assert.equal(joinsAsSentence('blah and', 'But this starts a new sentence').join, false)
})

test('tailLooksOpen：句号结尾且无未闭合结构 = 关闭', () => {
  assert.equal(tailLooksOpen('All done.'), false)
  assert.equal(tailLooksOpen('e.g. ` thinking...'), true)
  assert.equal(tailLooksOpen('stop here,'), true)
})

test('含 DSML 工具标记的正文：不并进思考', () => {
  const tail = 'Let me scan for `'
  const body = '` / `</think>` and call <｜DSML｜ calls><｜DSML｜ invoke name="x"></｜DSML｜ invoke></｜DSML｜ calls>'
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, tail),
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
  ])
  const joinedText = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(joinedText.includes('DSML'), 'DSML 必须留在正文')
})

