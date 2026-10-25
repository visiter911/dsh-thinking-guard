/**
 * Let me → I'll 改写测试。
 *
 * 重点：确定性多样化（同句同结果、整段不塌）、只动思考通道、
 * 块结束文本必须写回改写后的内容。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { I_STYLES, WE_STYLES, LetMeRewrite, hashText, intentInfo, letmeStream, rewriteSentence, stripFillers } from '../letme.js'

const start = (index, blockType) => ({ type: 'block-start', index, blockType })
const text = (index, value) => ({ type: 'text-delta', index, text: value })
const think = (index, value) => ({ type: 'reasoning-delta', index, text: value })
const end = (index, block) => ({ type: 'block-end', index, block })

function run(chunks) {
  const w = new LetMeRewrite()
  const out = []
  for (const c of chunks) out.push(...w.push(c))
  out.push(...w.flush())
  return { chunks: out, stats: w.stats }
}

test('基本改写：Let me → I\'ll 系列', () => {
  const out = rewriteSentence("Let me check the parser first.")
  assert.match(out, /^(I'll|I will|I'm going to|I should|I need to|Now I'll) check the parser first\.$/)
  assert.ok(!/let me/i.test(out))
})

test('确定性：同一句永远同一个结果', () => {
  const a = rewriteSentence('Let me verify the bridge status.')
  const b = rewriteSentence('Let me verify the bridge status.')
  assert.equal(a, b)
  assert.equal(hashText('abc'), hashText('abc'))
})

test('多样化：不同句子不会全塌成同一句式', () => {
  const sentences = [
    'Let me check the parser.',
    'Let me verify the bridge.',
    'Let me read the config.',
    'Let me measure the window.',
    'Let me compute the overlap.',
  ]
  const styles = new Set(sentences.map((s) => rewriteSentence(s).split(' ')[0]))
  assert.ok(styles.size >= 2, `句式应当有变化，实际只有 ${[...styles].join(',')}`)
})

test('只改开口：句子中间的 let me 不动', () => {
  const s = 'The rule eats the word let me from the body.'
  assert.equal(rewriteSentence(s), s)
})

test('中文：让我 → 我来/我先', () => {
  const out = rewriteSentence('让我先看一下这个文件。')
  assert.match(out, /^(我来|我先|我得|我需要|接下来我)先看一下这个文件。$/)
})

test('只动思考通道，正文不受影响', () => {
  const body = 'Let me check.'
  const { chunks } = run([
    start(1, 'text'),
    text(1, body),
    end(1, { type: 'text', text: body }),
  ])
  const joined = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(joined, body)
})

test('block-end 的 text 必须是改写后的内容', () => {
  const original = 'Let me check the parser first.'
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, original),
    end(0, { type: 'reasoning', text: original }),
  ])
  const closing = chunks.find((c) => c.type === 'block-end')
  assert.ok(closing, '必须有 block-end')
  assert.ok(!/let me/i.test(closing.block.text), '落盘文本里不应再有 let me')
  assert.match(closing.block.text, /^(I'll|I will|I'm going to|I should|I need to|Now I'll)/)
})

test('按句改写：一句一句话出来，不整块延迟', () => {
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, 'The parser has a bug. '),
    think(0, 'The config file is fine. '),
    end(0, { type: 'reasoning', text: 'The parser has a bug. The config file is fine. ' }),
  ])
  const deltas = chunks.filter((c) => c.type === 'reasoning-delta')
  assert.ok(deltas.length >= 2, '应当按句分批发出')
})

test('letmeStream：异步流正确收尾', async () => {
  const original = 'Let me check the parser first.'
  async function* source() {
    yield start(0, 'reasoning')
    yield think(0, original)
    yield end(0, { type: 'reasoning', text: original })
  }
  const out = []
  for await (const c of letmeStream(source())) out.push(c)
  const closing = out.find((c) => c.type === 'block-end')
  assert.ok(!/let me/i.test(closing.block.text))
})

test('池子里包含 I should / We should 等多样化句式', () => {
  assert.ok(I_STYLES.includes('I should'))
  assert.ok(I_STYLES.includes('I need to'))
  assert.ok(WE_STYLES.includes('We should'))
  assert.ok(WE_STYLES.includes("We'll"))
})

test("let's 用复数第一人称，不会变成 I'll", () => {
  for (const s of ["Let's verify the bridge.", "Let's check the config.", "Let's measure it."]) {
    const out = rewriteSentence(s)
    assert.ok(!/^I'll/.test(out), `${s} → ${out}`)
    assert.match(out, /^(We'll|We should|We need to|We're going to)/)
  }
})

test('多样化：足够多的句子能覆盖到 should 类句式', () => {
  const sentences = Array.from({ length: 40 }, (_, i) => `Let me check variant number ${i}.`)
  const openers = new Set(sentences.map((s) => rewriteSentence(s).split(' ')[0]))
  assert.ok(openers.size >= 4, `句式应当更分散，实际 ${[...openers].join(',')}`)
  assert.ok([...openers].some((o) => /I$|We$/.test(o) || o === 'I' || o === 'We'), '应包含 should/need 类')
})

test('正文块里的 Let me 一个字都不改（含正文块先开始、思考块后结束的顺序）', () => {
  const body = 'Let me check. 这是正文，Let me 不该被动。'
  const thinkText = 'Let me verify the parser.'
  const { chunks } = run([
    start(1, 'text'),
    text(1, body),
    start(0, 'reasoning'),
    think(0, thinkText),
    end(1, { type: 'text', text: body }),
    end(0, { type: 'reasoning', text: thinkText }),
  ])
  const textOut = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(textOut, body, '正文必须逐字节保留')
  const textEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(textEnd.block.text, body, '正文 block-end 也不能改')
  const reasonOut = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(!/let me/i.test(reasonOut), '思考仍要改写')
})

test('语气词：句首 Hmm / Uh / Um 去掉', () => {
  assert.equal(stripFillers('Hmm, let me check.'), 'Let me check.')
  assert.equal(stripFillers('Uh, the parser is wrong.'), 'The parser is wrong.')
  assert.equal(stripFillers('Umm... 我觉得可以。'), '我觉得可以。')
  assert.equal(stripFillers('Hmm.'), '')
})

test('语气词：中文句首「嗯/呃/唔」去掉，后面接开口改写', () => {
  const out = rewriteSentence('嗯，让我先看看这个文件。')
  assert.ok(!/^嗯/.test(out), out)
  assert.match(out, /^(我来|我先|我得|我需要|接下来我)先看看这个文件。$/)
})

test('语气词：句中的 hmm 不动（例如在讨论这个词本身）', () => {
  assert.equal(stripFillers('The word hmm appears here.'), 'The word hmm appears here.')
  assert.equal(stripFillers('We removed hmm from the body.'), 'We removed hmm from the body.')
})

test('语气词：整句只有语气词时丢弃，不发空 delta', () => {
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, 'Hmm. '),
    end(0, { type: 'reasoning', text: 'Hmm. ' }),
  ])
  const deltas = chunks.filter((c) => c.type === 'reasoning-delta')
  assert.equal(deltas.length, 0, '不应发出空内容')
  assert.ok(stats.dropped >= 1)
  const closing = chunks.find((c) => c.type === 'block-end')
  assert.equal(closing.block.text, '', '收尾文本也不应保留语气词')
})


test('意图聚合：连续意图只保留最后一条完整的', () => {
  const { chunks, stats } = run([
    start(0, 'reasoning'),
    think(0, "I'll inspect the parser. I'll inspect the parser config file. The config lives in two places."),
    end(0, { type: 'reasoning', text: '' }),
  ])
  const out = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(!out.includes('I\'ll inspect the parser.'), `首条短意图应被剔除：${out}`)
  assert.ok(out.includes('I\'ll inspect the parser config file.'), '应保留最后一条完整意图')
  assert.ok(out.includes('The config lives in two places.'), '普通句子不受影响')
  assert.ok(stats.dropped >= 1)
})

test('意图聚合：泛指短句直接剔除', () => {
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, "I'll check it. The parser has a bug."),
    end(0, { type: 'reasoning', text: '' }),
  ])
  const out = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(!out.includes('I\'ll check it.'), `泛指应被剔除：${out}`)
  assert.ok(out.includes('The parser has a bug.'))
})

test('意图聚合：只有一条意图时保留，不误删', () => {
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, "I'll read the config file now. It has three sections."),
    end(0, { type: 'reasoning', text: '' }),
  ])
  const out = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(out.includes("I'll read the config file now."))
})

test('意图聚合：中文连续意图同样只留最后一条', () => {
  const { chunks } = run([
    start(0, 'reasoning'),
    think(0, '我来看看这段代码。我来看看这段代码在适配器里的调用路径。'),
    end(0, { type: 'reasoning', text: '' }),
  ])
  const out = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(!out.includes('我来看看这段代码。'), `首条应被剔除：${out}`)
  assert.ok(out.includes('我来看看这段代码在适配器里的调用路径。'))
})

test('intentInfo：能识别意图句与泛指', () => {
  assert.equal(intentInfo("I'll check it.").generic, true)
  assert.equal(intentInfo("I'll inspect the parser config file.").complete, true)
  assert.equal(intentInfo('The parser has a bug.'), undefined)
  assert.equal(intentInfo('这是一段有实质内容的普通句子，后面还有更多细节需要说明。'), undefined)
})


test('子开关：filler 关掉时语气词不被剔除', () => {
  const w = new LetMeRewrite({ filler: false, intent: false })
  const out = []
  out.push(...w.push(start(0, 'reasoning')))
  out.push(...w.push(think(0, 'Hmm, the parser has a bug. ')))
  out.push(...w.push(end(0, { type: 'reasoning', text: 'Hmm, the parser has a bug. ' })))
  const joined = out.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(joined.includes('Hmm'), 'filler 关掉时应保留语气词')
})

test('子开关：intent 关掉时连续意图全部保留', () => {
  const w = new LetMeRewrite({ filler: true, intent: false })
  const body = "I'll inspect the parser. I'll inspect the parser config file."
  const out = []
  out.push(...w.push(start(0, 'reasoning')))
  out.push(...w.push(think(0, body)))
  out.push(...w.push(end(0, { type: 'reasoning', text: body })))
  const joined = out.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(joined.includes("I'll inspect the parser."), 'intent 关掉时不应剔除')
  assert.ok(joined.includes('config file'))
})

