/**
 * 重复块消解。
 *
 * 现象：同一段文本同时出现在 reasoning 和 text 两个块里，界面上就是
 * 「思考面板一份 + 正文一份」。上游（部分 OpenAI 兼容代理）在模型把
 * `<thinking>` 写进 content 时，会既把它当 reasoning_content 又保留原
 * content，于是两块字节完全相同。
 *
 * 处置：**正文块与紧邻的思考块逐字节相同时，丢掉正文块。**
 * 这不会丢失任何信息——那段文本已经完整地显示在思考面板里了。
 *
 * 实现是增量的：
 *   - 正文块开头先与思考块做前缀比较
 *   - 一旦分叉，立刻把缓存原样放行，后续 delta 直接透传
 *   - 直到块结束都没分叉（说明是前缀 / 完全相同），才丢弃
 *
 * 因此正常正文只多等「第一个不同的字符」——通常就是第一个字。
 */

/** 工具调用的文本标记：含它的正文块绝不能删（否则调用会连同正文一起消失）。 */
const DSML = /<[｜|]\s*DSML\s*[｜|]/i

/** 缓冲到这么多字符就做一次相似度判定（再长就不再等）。 */
const PROBE_CHARS = 1200

/** 开头逐字重合一超过这个长度，就认为正文在复述思考。 */
const MIN_REPEAT = 120

/** 词集重合度阈值：超过就认为正文是思考的改写版。 */
const OVERLAP = 0.8

/** 取词：英文 3 字以上、中文 2 字以上。 */
function words(text) {
  return text.toLowerCase().match(/[a-z]{3,}|[\u4e00-\u9fa5]{2,}/g) ?? []
}

/** 正文的词有多少比例在思考里出现过。 */
function overlapWith(text, reference) {
  const a = new Set(words(text))
  if (a.size === 0) return 0
  const b = new Set(words(reference))
  let hit = 0
  for (const w of a) if (b.has(w)) hit += 1
  return hit / a.size
}

/** 是否含中日韩字符：用来区分「正文」和「继续思考」。 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
function hasCjk(text) {
  return CJK_RE.test(text)
}

/** 公共前缀长度。 */
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1
  return i
}

/**
 * 正文照抄了思考开头的长度。
 *
 * 改写版通常连开头都逐字照抄，所以「公共前缀」是最可靠的信号；
 * 单纯看词集重合会误伤用相同术语写的正常答复。
 *
 * @returns {number} 需要从正文开头丢弃的字符数
 */
function redundantPrefix(text, reasoning) {
  if (reasoning === null || reasoning === '' || text === '') return 0
  const lcp = commonPrefix(text, reasoning)
  if (lcp >= MIN_REPEAT) return lcp
  return 0
}

/**
 * 流转换器。
 *
 * 状态机：
 *   idle        —— 透传
 *   comparing   —— 正文块开头，正在与上一个思考块比较
 *   passthrough —— 已分叉，透传
 *   dropping    —— 已确认重复，整块丢弃
 */
export class DuplicateText {
  constructor() {
    this.mode = 'idle'
    this.index = -1
    this.buf = ''
    this.reasoning = null
    this.stats = { dropped: 0, chars: 0, pass: 0 }
    /** 本正文块实际发出去的文本：block-end 要用它覆盖，否则历史里仍是原文 */
    this.outText = ''
    /** 整块已并入思考：对应的正文块收尾要丢掉 */
    this.swallowed = false
  }

  push(chunk) {
    switch (chunk.type) {
      case 'block-start': return this.onBlockStart(chunk)
      case 'text-delta': return this.onTextDelta(chunk)
      case 'block-end': return this.onBlockEnd(chunk)
      case 'reasoning-delta':
        if (this.reasoning !== null) this.reasoning += chunk.text
        else this.reasoning = chunk.text
        return [chunk]
      default:
        return [...this.settle(), chunk]
    }
  }

  flush() {
    return this.settle()
  }

  onBlockStart(chunk) {
    const carried = this.settle()
    if (chunk.blockType === 'reasoning') {
      this.reasoning = ''
      return [...carried, chunk]
    }
    if (chunk.blockType !== 'text' || this.mode !== 'idle') {
      return [...carried, chunk]
    }
    // 没有可比的思考块：无从判断，直接透传
    if (this.reasoning === null || this.reasoning === '') {
      return [...carried, chunk]
    }
    this.mode = 'comparing'
    this.index = chunk.index
    this.buf = ''
    this.outText = ''
    /** 整块已并入思考：对应的正文块收尾要丢掉 */
    this.swallowed = false
    return carried
  }

  onTextDelta(chunk) {
    // 已经放行（可能切掉了照抄部分）：继续累计实际发出的内容
    if (this.mode === 'passthrough' && chunk.index === this.index) {
      this.outText += chunk.text
      return [chunk]
    }
    // 已确认重复：整块吞掉
    if (this.mode === 'dropping') {
      if (chunk.index === this.index) return []
      return [chunk]
    }
    if (this.mode !== 'comparing' || chunk.index !== this.index) return [chunk]
    this.buf += chunk.text

    // 还是思考的前缀：继续攒
    if (this.reasoning.startsWith(this.buf)) return []

    // 正文以**完整思考**开头（思考只是它的前缀，正文更长）：
    // 丢掉重复的那一段，只保留多出来的内容。
    if (this.reasoning !== '' && this.buf.startsWith(this.reasoning)) {
      const rest = this.buf.slice(this.reasoning.length)
      this.buf = ''
      this.mode = 'passthrough'
      this.outText = rest
      this.stats.dropped += 1
      this.stats.chars += this.reasoning.length
      if (rest === '') return []
      return [
        { type: 'block-start', index: this.index, blockType: 'text' },
        { type: 'text-delta', index: this.index, text: rest },
      ]
    }

    // 正文照抄了思考的开头（改写版的典型特征）：
    // 照抄的部分直接丢掉；尾巴若是正文（中文）才保留，工具调用不受影响照常透传。
    const redundant = redundantPrefix(this.buf, this.reasoning)
    if (redundant > 0) {
      const rest = this.buf.slice(redundant)
      this.stats.dropped += 1
      this.stats.chars += redundant
      this.buf = ''
      this.mode = 'passthrough'
      // 尾巴还是英文思考：整块都是重复，全部丢掉
      if (!hasCjk(rest)) {
        this.outText = ''
        this.swallowed = true
        return []
      }
      // 尾巴是正文：只保留尾巴
      this.outText = rest
      return [
        { type: 'block-start', index: this.index, blockType: 'text' },
        { type: 'text-delta', index: this.index, text: rest },
      ]
    }

    // 还没攒够样本、思考又足够长：先别急着放行，可能是改写版
    if (this.buf.length < PROBE_CHARS && (this.reasoning?.length ?? 0) >= PROBE_CHARS) return []

    // 真分叉：这就是正常正文，把扣下的部分原样放行
    const released = this.buf
    this.outText = released
    this.buf = ''
    this.mode = 'passthrough'
    this.stats.pass += 1
    return [
      { type: 'block-start', index: this.index, blockType: 'text' },
      { type: 'text-delta', index: this.index, text: released },
    ]
  }

  onBlockEnd(chunk) {
    // 已确认重复：连结束块一起丢
    if (this.mode === 'dropping' && chunk.index === this.index) {
      this.mode = 'idle'
      this.buf = ''
      return []
    }
    // 别的块结束不影响我们正在比较的这个正文块（思考块的 end 往往就夹在中间）
    if (chunk.index !== this.index) return [chunk]

    if (this.mode === 'comparing') {
      // 含工具调用标记：不能丢，否则调用连同正文一起消失
      if (DSML.test(this.buf)) {
        const out = [
          { type: 'block-start', index: this.index, blockType: 'text' },
          { type: 'text-delta', index: this.index, text: this.buf },
        ]
        this.buf = ''
        this.mode = 'idle'
        return [...out, chunk]
      }
      // 整块是思考的前缀 → 重复
      const isPrefix = this.reasoning !== null && this.reasoning !== ''
        && this.reasoning.startsWith(this.buf)
      // 或者是思考的改写版：词集重合度足够高
      if (isPrefix) {
        this.stats.dropped += 1
        this.stats.chars += this.buf.length
        this.buf = ''
        this.mode = 'idle'
        return []
      }
      const redundant = redundantPrefix(this.buf, this.reasoning)
      if (redundant > 0) {
        const copied = this.buf.slice(0, redundant)
        const rest = this.buf.slice(redundant)
        this.stats.dropped += 1
        this.stats.chars += redundant
        this.buf = ''
        this.mode = 'idle'
        // 尾巴还是英文思考：整块丢掉
        if (!hasCjk(rest)) return []
        // 尾巴是正文：只保留尾巴
        return [
          { type: 'block-start', index: this.index, blockType: 'text' },
          { type: 'text-delta', index: this.index, text: rest },
          { ...chunk, block: { ...chunk.block, text: rest } },
        ]
      }
      // 不是重复：原样放行
      this.outText = this.buf
      const out = [
        { type: 'block-start', index: this.index, blockType: 'text' },
        { type: 'text-delta', index: this.index, text: this.buf },
      ]
      this.buf = ''
      this.mode = 'idle'
      this.stats.pass += 1
      return [...out, chunk]
    }
    if (this.swallowed && chunk.index === this.index) {
      this.swallowed = false
      this.mode = 'idle'
      return []
    }
    if (this.mode === 'passthrough') {
      this.mode = 'idle'
      // 我们可能已经切掉了照抄的开头：用实际发出的文本覆盖，否则历史里还是全文
      return [{ ...chunk, block: { ...chunk.block, text: this.outText } }]
    }
    return [...this.settle(), chunk]
  }

  /** 把一段内容包成一个思考块（用独立 index，避免与正文块撞车）。 */
  asReasoning(text) {
    const index = 1_000_000 + (this.index % 1000) * 10 + 800
    return [
      { type: 'block-start', index, blockType: 'reasoning' },
      { type: 'reasoning-delta', index, text },
      { type: 'block-end', index, block: { type: 'reasoning', text } },
    ]
  }

  settle() {
    if (this.mode === 'comparing') {
      const out = [
        { type: 'block-start', index: this.index, blockType: 'text' },
        ...(this.buf === '' ? [] : [{ type: 'text-delta', index: this.index, text: this.buf }]),
      ]
      this.buf = ''
      this.mode = 'idle'
      return out
    }
    if (this.mode === 'passthrough') this.mode = 'idle'
    return []
  }
}

/** 把整条流跑一遍。 */
export function dedupeStream(source, onDone) {
  const dedupe = new DuplicateText()
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of source) {
          for (const out of dedupe.push(chunk)) yield out
        }
        for (const out of dedupe.flush()) yield out
      } finally {
        onDone?.(dedupe.stats)
      }
    },
  }
}



















