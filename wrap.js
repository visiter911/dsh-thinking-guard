/**
 * 思考块自动封装。
 *
 * 目标（用户定）：**中间的过程汇报被折叠可以接受，但结尾的正文绝不能被吃**。
 *
 * 判定顺序（越靠前越硬）：
 *
 *   0. **显式标记优先**：正文里有 `<thinking>…</thinking>` 时，标记内部一律是思考，
 *      标记之外照旧是正文。这条**不受「本轮已有思考块」限制**——边界是模型自己
 *      给的，比任何启发式都硬。已有打开的思考块就追加进去，不新开块。
 *
 *   1. 本轮已有思考块 → 后面按定义是正文，不介入（思考块后不会连着第二个思考块）
 *   2. 以 `#` 起手 → 正文
 *   3. 开头像进度汇报（`reportScore >= 3`）→ 正文
 *   4. 其余：块结束后延迟一拍
 *        - 后面跟 tool call → 回合中段的思考 → 折叠
 *        - 直接收尾 → 最终答复 → 正文
 *   5. 缓冲中出现行首 `#`：汇报式导语+短前缀 → 整块正文；否则从 `#` 处切开
 *
 * 长度上限 1500 字符：超过就提前定案为思考，避免把长回复一直扣住。
 */

import { hasDsmlCall, parseDsml } from './dsml.js'

/** 合成调用 ID 的唯一前缀：跨轮不能重复，否则 PTC 子调用会撞车。 */
let CALL_SEQ = 0
function uniqueId() {
  CALL_SEQ += 1
  const stamp = Date.now().toString(36)
  const seq = CALL_SEQ.toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${stamp}${seq}${rand}`
}

/** 缓冲上限。 */
export const CAPTURE_LIMIT = 1500

/** 前缀短于此长度时，汇报式导语 + `#` 不切分。 */
export const SHORT_PREFIX = 120

/** 评分需要的最少字符。 */
const PROBE_CHARS = 40

/** 扫描 holdback。 */
const HOLDBACK = 8

/** 标记扫描 holdback：容纳 `</thinking>` 与少量前瞻。 */
const MARKER_HOLD = 13

const HEADING = /(^|\n)(#{1,6})(?=\s|$|[^#\s])/
const OPEN = /<thinking>|<think>/i
const CLOSE = /<\/thinking\s*>|<\/think\s*>/i

const SPLIT_BASE = 1_000_000

const REPORT_VERBS = /(?:已|完成|通过|修好|改好|保存|新增|删除|更新|测试|跑通|搞定|成功|失败|结果|共\s*\d+|如下|见下|检查|部署|重启|生成|写入)/
const REPORT_LEAD = /^(?:现在|接下来|然后|下面|我(?:来|先|已)|我们|另外|顺便|同时|最终|目前|当(?:前|下))/
const META_CUES = /(?:let me|hmm+|wait\b|i need to|the user|i should|让我|我想|我需要|嗯|等一下|我来想)/i
const SUBJECT = /(?:我|我们|咱|你|您|他|她|它|这|那|该|其)|\b(?:I|we|you|he|she|it|they|let me|the user)\b/i

function openingClause(head) {
  const match = /^[^。！？：:，,；;\n]{0,60}/.exec(head)
  return match === null ? head : match[0]
}

export function countTokens(text) {
  const value = String(text ?? '')
  if (value === '') return 0
  const words = value.trim().split(/\s+/).filter(Boolean).length
  const cjk = (value.match(/[\u4e00-\u9fa5]/g) ?? []).length
  return words + Math.ceil(cjk / 1.5)
}

/** 只看第一个字符的硬证据（不含标记，标记由调用方先行处理）。 */
export function classifyPrefix(text) {
  const head = String(text ?? '').replace(/^\s+/, '')
  if (head === '') return 'content'
  if (/^#{1,6}(\s|$|[^#\s])/.test(head)) return 'content'
  return 'thinking'
}

/** 多因素评分：开头有多像「进度汇报」。 */
export function reportScore(text) {
  const head = String(text ?? '').replace(/^\s+/, '')
  if (head === '') return 0
  const clause = openingClause(head)
  let score = 0
  if (!SUBJECT.test(clause)) score += 3
  if (REPORT_VERBS.test(head)) score += 2
  if (REPORT_LEAD.test(head)) score += 2
  if (/[。！？!?]\s*$/.test(head) && head.length <= 80) score += 1
  if ((head.match(/[\u4e00-\u9fa5]/g) ?? []).length >= 6) score += 1
  if (META_CUES.test(clause)) score -= 4
  if (/^\s*(?:[-*+•]\s|\d+[.)]\s|```|\||>)/.test(head)) score -= 2
  return score
}

const reasonDelta = (index, text) => ({ type: 'reasoning-delta', index, text })
const textDelta = (index, text) => ({ type: 'text-delta', index, text })
const textStart = (index) => ({ type: 'block-start', index, blockType: 'text' })
const reasonStart = (index) => ({ type: 'block-start', index, blockType: 'reasoning' })
const blockEnd = (index, block) => ({ type: 'block-end', index, block })

/** 工具调用的文本标记：认出来后不再整块搬动，而是按段切分并解析。 */
const DSML = /<[｜|]\s*DSML\s*[｜|]/i

/** 思考结束标记：正文里出现它就说明前面的都是思考，后面才是答复。 */
const CLOSER = /<\/\s*(?:think|thinking|analysis|summary)\s*>/i

const isToolCall = (chunk) => chunk.type === 'tool-call-delta'
  || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')

/**
 * 状态机：
 *   idle      —— 透传
 *   probe     —— 块开头，先找显式标记，再评分
 *   marker    —— 正在 `<thinking>` 内部
 *   hold      —— 继续缓冲，等 `#` / 等块结束 / 等超过上限
 *   deferred  —— 块已结束，等下一拍判断后面是不是 tool call
 *   reasoning —— 已定案为思考
 *   content   —— 已定案为正文
 */
export class WrapRepair {
  constructor(options = {}) {
    this.cap = Number.isFinite(options.cap) ? options.cap : CAPTURE_LIMIT
    this.mode = 'idle'
    this.index = -1
    this.outTextIndex = -1
    this.textStarted = false
    this.buf = ''
    this.chunks = []
    this.carry = ''
    this.reasoningText = ''
    this.contentText = ''
    this.splitIndex = -1
    this.pendingEnd = null
    this.sawReasoning = false
    this.reasoningIndex = -1
    this.reasoningOpen = false
    this.ownReason = false
    this.reasonOut = -1
    this.touched = false
    this.markerBuf = ''
    this.markerText = ''
    this.reasoningExtra = ''
    this.touched = false
    this.stats = { wrapped: 0, chars: 0, split: 0, held: 0, deferred: 0, spans: 0, dsml: 0 }
  }

  push(chunk) {
    if (this.mode === 'deferred') {
      const settled = isToolCall(chunk) ? this.commitReasoning() : this.commitContent()
      return [...settled, ...this.push(chunk)]
    }

    switch (chunk.type) {
      case 'block-start': return this.onBlockStart(chunk)
      case 'text-delta': return this.onTextDelta(chunk)
      case 'block-end': return this.onBlockEnd(chunk)
      default: return [...this.settle(), chunk]
    }
  }

  flush() {
    if (this.mode === 'deferred') return this.commitContent()
    return this.settle()
  }

  onBlockStart(chunk) {
    const carried = this.settle()
    if (chunk.blockType === 'reasoning') {
      this.sawReasoning = true
      this.reasoningIndex = chunk.index
      this.reasoningOpen = true
      return [...carried, chunk]
    }
    if (chunk.blockType !== 'text' || this.mode !== 'idle') return [...carried, chunk]
    this.mode = 'probe'
    this.index = chunk.index
    this.outTextIndex = chunk.index
    this.textStarted = false
    this.buf = ''
    this.chunks = []
    this.splitIndex = -1
    this.pendingEnd = null
    this.ownReason = false
    this.reasonOut = -1
    this.touched = false
    this.markerBuf = ''
    return carried
  }

  onTextDelta(chunk) {
    // 上游有时不发 block-start（只有 delta + block-end）。
    // 这种情况下也要开始探测，否则整块正文会被原样放行。
    if (this.mode === 'idle') {
      this.mode = 'probe'
      this.index = chunk.index
      this.outTextIndex = chunk.index
      this.buf = ''
      this.chunks = []
      this.reasonOut = -1
      this.pendingEnd = null
    }
    if (chunk.index !== this.index) return [chunk]

    if (this.mode === 'dsml') {
      this.buf += chunk.text
      return []
    }

    if (this.mode === 'probe') {
      this.buf += chunk.text
      this.chunks.push(chunk)
      const head = this.buf.replace(/^\s+/, '')
      if (head === '') return []

      const open = OPEN.exec(this.buf)
      const close = CLOSER.exec(this.buf)
      // 先看谁在前面：开头标记优先（<thinking>…</thinking> 是一个整体）
      if (open !== null && (close === null || open.index < close.index)) {
        return this.startMarker(open.index, open[0].length)
      }
      // 只有结束标记：之前是思考，之后是答复
      if (close !== null) return this.splitAtCloser(close.index, close[0].length)
      // 结尾可能是标记的前半截，先等等
      const tail = this.buf.slice(-10).toLowerCase()
      if (tail !== '' && ('<thinking>'.startsWith(tail) || '<think>'.startsWith(tail))) return []


      if (classifyPrefix(this.buf) === 'content') return this.commitContent()
      const complete = this.buf.length >= PROBE_CHARS || /[。！？\n]/.test(this.buf.slice(0, PROBE_CHARS))
      if (!complete) return []
      if (reportScore(this.buf) >= 3) {
        this.mode = 'hold'
        this.reportLike = true
        this.stats.held += 1
        return this.holdCheck()
      }
      this.mode = 'hold'
      this.reportLike = false
      return this.holdCheck()
    }

    if (this.mode === 'marker') {
      this.markerBuf += chunk.text
      return this.markerScan()
    }

    if (this.mode === 'hold') {
      this.buf += chunk.text
      return this.holdCheck()
    }

    if (this.mode === 'reasoning') return this.scan(chunk.text)
    if (this.mode === 'content' && this.splitIndex >= 0) {
      this.contentText += chunk.text
      return [textDelta(this.splitIndex, chunk.text)]
    }
    return [chunk]
  }

  /**
   * 解析攒下的 DSML 段并就地切分：
   *   头之前 → 思考；markup → 真正的 tool-call；尾之后 → 正文。
   */
  emitDsml() {
    const text = this.buf
    this.buf = ''
    const parsed = parseDsml(text)
    if (parsed === undefined || parsed.calls.length === 0) {
      // 解析不出来：原样当正文，绝不丢内容
      this.mode = 'content'
      const out = [textStart(this.outTextIndex)]
      if (text !== '') out.push(textDelta(this.outTextIndex, text))
      this.contentText += text
      this.textStarted = true
      return out
    }
    this.mode = 'idle'
    const out = []
    if (parsed.prefix !== '') {
      out.push(reasonStart(this.index))
      out.push(reasonDelta(this.index, parsed.prefix))
      out.push(blockEnd(this.index, { type: 'reasoning', text: parsed.prefix }))
    }
    let k = 0
    for (const call of parsed.calls) {
      const idx = SPLIT_BASE + (this.index % 1000) + k
      const id = `call_dsml_${uniqueId()}_${k}`
      out.push({ type: 'block-start', index: idx, blockType: 'tool-call' })
      out.push({ type: 'tool-call-delta', index: idx, id, name: call.name, argumentsDelta: call.arguments })
      out.push(blockEnd(idx, { type: 'tool-call', id, name: call.name, arguments: call.arguments }))
      k += 1
    }
    if (parsed.suffix !== '') {
      const idx = SPLIT_BASE + (this.index % 1000) + 500
      out.push({ type: 'block-start', index: idx, blockType: 'text' })
      out.push({ type: 'text-delta', index: idx, text: parsed.suffix })
      out.push(blockEnd(idx, { type: 'text', text: parsed.suffix }))
    }
    this.stats.dsml += 1
    return out
  }
  /**
   * 正文里遇到思考结束标记：标记之前改判为思考，之后按正文发出并停止判定。
   */
  splitAtCloser(at, length) {
    const full = this.buf
    const head = full.slice(0, at)
    const rest = full.slice(at + length)
    this.buf = ''
    this.chunks = []
    const out = []
    if (head.trim() !== '') {
      this.reasonOut = SPLIT_BASE + (this.index % 1000) + 700
      this.reasoningText = head
      out.push(reasonStart(this.reasonOut))
      out.push(reasonDelta(this.reasonOut, head))
      out.push(blockEnd(this.reasonOut, { type: 'reasoning', text: head }))
      this.reasonOut = -1
      this.stats.wrapped += 1
    }
    // 标记之后就是答复：原样作为正文发出，不再参与判定
    this.mode = 'content'
    this.textStarted = true
    this.contentText = rest
    this.pendingEnd = null
    out.push(textStart(this.index))
    if (rest !== '') out.push(textDelta(this.index, rest))
    this.stats.split += 1
    return out
  }
  /** 进入标记内部：确定思考块目标，标记之前的内容先作为正文本发出去。 */
  startMarker(tagStart, tagLength) {
    if (hasDsmlCall(this.buf)) { this.mode = 'dsml'; return [] }
    this.touched = true
    const before = this.buf.slice(0, tagStart)
    const rest = this.buf.slice(tagStart + tagLength)
    this.buf = ''
    this.chunks = []
    const out = []
    if (before !== '') out.push(...this.emitText(before))

    this.stats.spans += 1
    // 标记之前已经发过正文：先把它收口，标记之后另起一块。
    // 注意：一旦正文占用了 this.index，思考块就**不能**再用它（assembler 同一个
    // index 只认第一次 block-start），必须换合成 index。
    const hadText = this.textStarted === true
    if (hadText === true) {
      out.push(blockEnd(this.outTextIndex, { type: 'text', text: this.contentText }))
      this.contentText = ''
      this.textStarted = false
      this.outTextIndex = SPLIT_BASE + ((this.index + 1) % 1000)
    }
    if (this.reasoningOpen === true && this.reasoningIndex >= 0) {
      // 复用已经打开的思考块
    } else if (hadText !== true) {
      // 正文还没开始：用正文块的 index 当思考块，尾随正文换合成 index
      this.reasoningIndex = this.index
      this.reasoningOpen = true
      this.ownReason = true
      this.outTextIndex = SPLIT_BASE + (this.index % 1000)
      this.textStarted = false
      out.push(reasonStart(this.reasoningIndex))
    } else {
      this.reasoningIndex = SPLIT_BASE + (this.index % 1000)
      this.reasoningOpen = true
      this.ownReason = true
      out.push(reasonStart(this.reasoningIndex))
    }

    this.mode = 'marker'
    this.markerBuf = rest
    out.push(...this.markerScan())
    return out
  }

  /** 标记内部：找闭标记，找到就切回正文。 */
  markerScan() {
    const close = CLOSE.exec(this.markerBuf)
    if (close === null) {
      if (this.markerBuf.length > MARKER_HOLD) {
        const emit = this.markerBuf.slice(0, this.markerBuf.length - MARKER_HOLD)
        this.markerBuf = this.markerBuf.slice(-MARKER_HOLD)
        this.stats.chars += emit.length
        this.markerText += emit
        this.reasoningExtra += emit
        return [reasonDelta(this.reasoningIndex, emit)]
      }
      return []
    }
    const span = this.markerBuf.slice(0, close.index)
    const after = this.markerBuf.slice(close.index + close[0].length)
    this.markerBuf = ''
    const out = []
    if (span !== '') {
      this.stats.chars += span.length
      this.markerText += span
      this.reasoningExtra += span
      out.push(reasonDelta(this.reasoningIndex, span))
    }
    this.mode = 'content'
    if (after !== '') out.push(...this.emitText(after))
    return out
  }

  emitText(text) {
    if (text === '') return []
    const out = []
    if (this.textStarted !== true) {
      out.push(textStart(this.outTextIndex))
      this.textStarted = true
    }
    this.contentText += text
    out.push(textDelta(this.outTextIndex, text))
    return out
  }

  holdCheck() {
    if (DSML.test(this.buf)) {
      this.mode = 'dsml'
      return []
    }
    const hit = HEADING.exec(this.buf)
    if (hit !== null) {
      const cut = hit.index + (hit[1] === '\n' ? 1 : 0)
      if (this.reportLike === true && cut <= SHORT_PREFIX) return this.commitContent()
      return this.splitAt(cut)
    }
    if (this.buf.length >= this.cap) return this.commitReasoning()
    return []
  }

  onBlockEnd(chunk) {
    // 上游有时只发 block-end，正文全放在 chunk.block.text 里（没有 delta）。
    // 这种块也必须走一遍判定，否则会整段原样漏出去。
    if (this.mode === 'idle'
      && chunk.block?.type === 'text'
      && typeof chunk.block.text === 'string'
      && chunk.block.text !== '') {
      const head = this.onTextDelta({ type: 'text-delta', index: chunk.index, text: chunk.block.text })
      return [...head, ...this.onBlockEnd({ ...chunk, block: { ...chunk.block } })]
    }

    if (chunk.index !== this.index) {
      const carried = this.settle()
      if (chunk.block?.type === 'reasoning' && chunk.index === this.reasoningIndex) {
        // block-end 里的 text 会覆盖累积内容：把追加进去的部分补上，
        // 否则我们并回思考的那一段会被上游抹掉。
        const patch = this.reasoningExtra !== ''
          ? { ...chunk, block: { ...chunk.block, text: `${chunk.block.text ?? ''}${this.reasoningExtra}` } }
          : chunk
        this.reasoningExtra = ''
        this.reasoningOpen = false
        this.ownReason = false
    this.reasonOut = -1
        return [...carried, patch]
      }
      return [...carried, chunk]
    }

    if (this.mode === 'probe') {
      if (this.buf.replace(/^\s+/, '') === '') {
        const out = [textStart(this.outTextIndex)]
        if (this.buf !== '') out.push(textDelta(this.outTextIndex, this.buf))
        this.buf = ''
        this.chunks = []
        this.mode = 'idle'
        return [...out, chunk]
      }

      if (classifyPrefix(this.buf) === 'content') {
        const out = this.commitContent()
        return [...out, chunk]
      }
      this.mode = 'hold'
    }

    if (this.mode === 'hold') {
      this.pendingEnd = chunk
      this.mode = 'deferred'
      this.stats.deferred += 1
      return []
    }

    if (this.mode === 'dsml') return this.emitDsml()

    if (this.mode === 'marker') {
      const out = []
      if (this.markerBuf !== '') {
        this.stats.chars += this.markerBuf.length
        out.push(reasonDelta(this.reasoningIndex, this.markerBuf))
        this.markerText += this.markerBuf
        this.reasoningExtra += this.markerBuf
        this.markerBuf = ''
      }
      if (this.ownReason === true) {
        out.push(blockEnd(this.reasoningIndex, { type: 'reasoning', text: this.markerText }))
        this.ownReason = false
    this.reasonOut = -1
        this.reasoningOpen = false
      }
      if (this.textStarted === true && this.outTextIndex !== this.index) {
        out.push(blockEnd(this.outTextIndex, { type: 'text', text: this.contentText }))
      }
      this.mode = 'idle'
      return out
    }

    if (this.mode === 'reasoning') return this.closeReasoning()

    if (this.mode === 'content') {
      if (this.ownReason === true) {
        const out = []
        if (this.textStarted === true && this.outTextIndex !== this.index) {
          out.push(blockEnd(this.outTextIndex, { type: 'text', text: this.contentText }))
        }
        this.mode = 'idle'
        return out
      }
      if (this.splitIndex >= 0) {
        const out = [blockEnd(this.splitIndex, { type: 'text', text: this.contentText })]
        this.splitIndex = -1
        this.mode = 'idle'
        return out
      }
      this.mode = 'idle'
      const done = this.touched === true
        ? { ...chunk, block: { ...chunk.block, type: 'text', text: this.contentText } }
        : chunk
      return [...this.settle(), done]
    }

    this.mode = 'idle'
    return [...this.settle(), chunk]
  }

  commitContent() {
    const text = this.buf
    this.buf = ''
    this.chunks = []
    const end = this.pendingEnd
    this.pendingEnd = null
    this.mode = 'content'
    const out = [textStart(this.outTextIndex)]
    if (text !== '') out.push(textDelta(this.outTextIndex, text))
    this.contentText += text
    this.textStarted = true
    if (end !== null) {
      out.push(end)
      this.mode = 'idle'
    }
    return out
  }

  commitReasoning() {
    if (hasDsmlCall(this.buf)) { this.mode = 'dsml'; return [] }
    const text = this.buf
    this.buf = ''
    this.chunks = []
    this.pendingEnd = null
    this.mode = 'reasoning'
    this.sawReasoning = true
    this.stats.wrapped += 1
    // 用独立 index：正文块的 index 可能已被上游占用，复用会导致内容被塞回正文块
    this.reasonOut = SPLIT_BASE + (this.index % 1000) + 700
    const out = [reasonStart(this.reasonOut)]
    out.push(...this.scan(text))
    return out
  }

  splitAt(cut) {
    if (hasDsmlCall(this.buf)) { this.mode = 'dsml'; return [] }
    const head = this.buf.slice(0, cut)
    const rest = this.buf.slice(cut)
    this.buf = ''
    this.chunks = []
    const out = []
    this.reasoningText += head
    out.push(reasonStart(this.index))
    if (head !== '') out.push(reasonDelta(this.index, head))
    out.push(blockEnd(this.index, { type: 'reasoning', text: this.reasoningText }))
    this.splitIndex = SPLIT_BASE + (this.index % 1000)
    this.mode = 'content'
    this.stats.split += 1
    this.contentText = rest
    out.push(textStart(this.splitIndex))
    if (rest !== '') out.push(textDelta(this.splitIndex, rest))
    return out
  }

  scan(text) {
    this.carry += text
    const hit = HEADING.exec(this.carry)
    if (hit !== null) {
      this.buf = this.carry
      this.carry = ''
      return this.splitAt(hit.index + (hit[1] === '\n' ? 1 : 0))
    }
    if (this.carry.length > HOLDBACK) {
      const emit = this.carry.slice(0, this.carry.length - HOLDBACK)
      this.carry = this.carry.slice(-HOLDBACK)
      this.reasoningText += emit
      return [reasonDelta(this.reasonOut >= 0 ? this.reasonOut : this.index, emit)]
    }
    return []
  }

  closeReasoning() {
    const out = []
    if (this.carry !== '') {
      this.reasoningText += this.carry
      out.push(reasonDelta(this.reasonOut >= 0 ? this.reasonOut : this.index, this.carry))
      this.carry = ''
    }
    out.push(blockEnd(this.reasonOut >= 0 ? this.reasonOut : this.index, { type: 'reasoning', text: this.reasoningText }))
    this.reasonOut = -1
    this.mode = 'idle'
    return out
  }

  settle() {
    if (this.mode === 'hold' || this.mode === 'probe') {
      const out = this.commitContent()
      // 结算完毕后必须回到 idle：否则紧接着的下一块会被误判成「忙」而不做任何判定
      this.mode = 'idle'
      return out
    }
    if (this.mode === 'reasoning') return this.closeReasoning()
    if (this.mode === 'marker') {
      const out = []
      if (this.markerBuf !== '') {
        out.push(reasonDelta(this.reasoningIndex, this.markerBuf))
        this.markerText += this.markerBuf
        this.reasoningExtra += this.markerBuf
        this.markerBuf = ''
      }
      if (this.ownReason === true) {
        out.push(blockEnd(this.reasoningIndex, { type: 'reasoning', text: this.markerText }))
        this.ownReason = false
    this.reasonOut = -1
        this.reasoningOpen = false
      }
      this.mode = 'idle'
      return out
    }
    return []
  }
}

export function wrapStream(source, onDone) {
  const wrap = new WrapRepair()
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of source) {
          for (const out of wrap.push(chunk)) yield out
        }
        for (const out of wrap.flush()) yield out
      } finally {
        onDone?.(wrap.stats)
      }
    },
  }
}



















