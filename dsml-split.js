/**
 * 文本通道清理：把两样东西从「不该在的地方」挪出来。
 *
 * 1. **思考结束标记**：模型有时把 `</thinking>` 写在思考块内部，
 *    后面跟着真正的答复。看到标记就该收口——标记之前归思考，
 *    之后转为正文。否则思考块里会留着这个标记，看起来像「没结束」。
 *
 * 2. **DSML 工具调用标记**：模型把调用写成文本。标记之前的内容留在
 *    原通道，标记解析成结构化 tool-call，之后的内容按正文处理。
 *
 * 顺序上先认思考结束标记，再在本轮剩下的正文里找 DSML。
 *
 * 必须放在链路**最前面**：后面各步看到的应该是干净的流。
 */

import { parseDsml } from './dsml.js'

/** 合成调用 ID 的唯一前缀：跨轮不能重复，否则 PTC 子调用会撞车。 */
let CALL_SEQ = 0
function uniqueId() {
  CALL_SEQ += 1
  const stamp = Date.now().toString(36)
  const seq = CALL_SEQ.toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${stamp}${seq}${rand}`
}

/** 合成 index 基数（与其它模块一致）。 */
const SPLIT_BASE = 1_000_000

/** 向前滞留的字符数：保证标记不会被 chunk 边界劈开。 */
const HOLD = 24

/** 任意 DSML 开标记。 */
const ANY = /<\s*[｜|]\s*DSML\s*[｜|]/i

/** 内容只在 block-end 里时，用来判断要不要处理 */
const MARKER_ANY = /<\/?\s*(?:think|thinking|analysis|summary|reasoning|details)\s*>/i

/** 思考结束标记。 */
const CLOSER = /<\/\s*(?:think|thinking|analysis|summary|reasoning|details)\s*>/gi

/**
 * 找真正用于收口的结束标记。
 *
 * 文本里**提到的**标记（例如 `` `</thinking>` ``、`"</thinking>"`）只是字面串，
 * 不是结构标记——否则讨论这个词的思考会被从中间切断。
 *
 * @returns {number} 标记起始位置，-1 表示没有
 */
export function findCloser(text) {
  const value = String(text ?? '')
  CLOSER.lastIndex = 0
  let m
  while ((m = CLOSER.exec(value)) !== null) {
    const before = value[m.index - 1] ?? ''
    const after = value[m.index + m[0].length] ?? ''
    const quotedPair = (before === '`' && after === '`')
      || (before === '"' && after === '"')
      || (before === "'" && after === "'")
      || (before === '「' && after === '」')
    if (quotedPair) continue
    return m.index
  }
  return -1
}

/**
 * 状态机：
 *   idle  —— 透传
 *   scan  —— 当前块里找标记
 *   hold  —— 已认到 DSML，攒到块结束再解析
 */
export class DsmlSplit {
  constructor() {
    this.mode = 'idle'
    this.index = -1
    this.blockType = ''
    this.outIndex = -1
    this.closed = false
    this.buf = ''
    this.emitted = ''
    this.pending = []
    this.sawRealCall = false
    this.scannedEnd = false
    this.stats = { split: 0, calls: 0, dropped: 0, closedTag: 0 }
  }

  push(chunk) {
    if (chunk.type === 'tool-call-delta'
      || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
      this.sawRealCall = true
    }

    switch (chunk.type) {
      case 'block-start': return this.onBlockStart(chunk)
      case 'text-delta':
      case 'reasoning-delta': return this.onDelta(chunk)
      case 'block-end': return this.onBlockEnd(chunk)
      case 'usage':
      case 'finish': return [...this.settle(), ...this.flushPending(), chunk]
      default: return [...this.settle(), chunk]
    }
  }

  flush() {
    return [...this.settle(), ...this.flushPending()]
  }

  onBlockStart(chunk) {
    const carried = this.settle()
    if (chunk.blockType === 'text' || chunk.blockType === 'reasoning') {
      this.mode = 'scan'
      this.index = chunk.index
      this.outIndex = chunk.index
      this.blockType = chunk.blockType
      this.closed = false
      this.buf = ''
      this.emitted = ''
      this.scannedEnd = false
    }
    return [...carried, chunk]
  }

  onDelta(chunk) {
    if (this.mode === 'idle' || chunk.index !== this.index) return [chunk]
    if (this.mode === 'hold') {
      this.buf += chunk.text
      return []
    }

    this.buf += chunk.text
    const out = []

    // 正文块里出现结束标记：只把标记本身剥掉，通道改判交给封装
    if (this.blockType === 'text') {
      const at = findCloser(this.buf)
      if (at >= 0) {
        const matched = /<\/\s*(?:think|thinking|analysis|summary|reasoning|details)\s*>/i.exec(this.buf.slice(at))
        const head = this.buf.slice(0, at)
        const rest = this.buf.slice(at + (matched?.[0].length ?? 0))
        this.buf = ''
        if (head !== '') out.push(...this.emitText(head))
        this.stats.closedTag += 1
        if (rest !== '') {
          this.buf = rest
          return out
        }
        return out
      }
    }

    // 第一优先：思考结束标记
    if (this.blockType === 'reasoning') {
      const at = findCloser(this.buf)
      if (at >= 0) {
        const matched = /<\/\s*(?:think|thinking|analysis|summary)\s*>/i.exec(this.buf.slice(at))
        const head = this.buf.slice(0, at)
        const rest = this.buf.slice(at + (matched?.[0].length ?? 0))
        this.buf = ''
        if (head !== '') out.push(...this.emitText(head))
        out.push(...this.closeReasoning())
        out.push(...this.startText())
        this.stats.closedTag += 1
        if (rest !== '') out.push(...this.onDelta({ type: 'text-delta', index: this.index, text: rest }))
        return out
      }
    }

    // 第二优先：DSML 标记
    const hit = ANY.exec(this.buf)
    if (hit === null) {
      if (this.buf.length > HOLD) {
        const emit = this.buf.slice(0, this.buf.length - HOLD)
        this.buf = this.buf.slice(-HOLD)
        return this.emitText(emit)
      }
      return []
    }

    if (hit.index > 0) {
      const before = this.buf.slice(0, hit.index)
      out.push(...this.emitText(before))
      this.buf = this.buf.slice(hit.index)
    }
    this.mode = 'hold'
    return out
  }

  /** 按当前通道发出。 */
  emitText(text) {
    if (text === '') return []
    this.emitted += text
    return [{
      type: this.blockType === 'reasoning' ? 'reasoning-delta' : 'text-delta',
      index: this.outIndex,
      text,
    }]
  }

  /** 主动收口思考块。 */
  closeReasoning() {
    this.closed = true
    const out = [{
      type: 'block-end',
      index: this.outIndex,
      block: { type: 'reasoning', text: this.emitted },
    }]
    this.emitted = ''
    return out
  }

  /** 标记之后转为正文块。 */
  startText() {
    this.blockType = 'text'
    this.outIndex = SPLIT_BASE + (this.index % 1000) * 10 + 900
    this.emitted = ''
    this.mode = 'scan'
    return [{ type: 'block-start', index: this.outIndex, blockType: 'text' }]
  }

  onBlockEnd(chunk) {
    // 内容只在 block-end 里（没有 delta）：也要走一遍标记处理，
    // 否则 `</summary>` 这种残标记会原样漏出去。
    if (!this.scannedEnd
      && this.mode === 'scan'
      && this.index === chunk.index
      && this.buf === ''
      && typeof chunk.block?.text === 'string'
      && chunk.block.text !== ''
      && MARKER_ANY.test(chunk.block.text)) {
      this.scannedEnd = true
      const type = this.blockType === 'reasoning' ? 'reasoning-delta' : 'text-delta'
      const head = this.onDelta({ type, index: chunk.index, text: chunk.block.text })
      return [...head, ...this.onBlockEnd(chunk)]
    }
    if (chunk.index !== this.index) return [...this.settle(), chunk]

    if (this.mode === 'scan') {
      const rest = this.buf
      this.buf = ''
      const out = rest === '' ? [] : this.emitText(rest)
      const wasClosed = this.closed
      this.mode = 'idle'
      this.closed = false
      if (wasClosed === true) {
        // 我们已经自己收过口了：关闭当前块，丢掉上游原来的结束
        out.push({
          type: 'block-end',
          index: this.outIndex,
          block: { type: this.blockType, text: this.emitted },
        })
        this.emitted = ''
        return out
      }
      return [...out, chunk]
    }

    // hold：解析 DSML
    const text = this.buf
    this.buf = ''
    const parsed = parseDsml(text)
    this.mode = 'idle'

    if (parsed === undefined || parsed.calls.length === 0) {
      const out = text === '' ? [] : this.emitText(text)
      if (this.closed === true) {
        out.push({
          type: 'block-end',
          index: this.outIndex,
          block: { type: this.blockType, text: this.emitted },
        })
        this.emitted = ''
        this.closed = false
        return out
      }
      return [...out, chunk]
    }

    const out = []
    if (parsed.prefix !== '') out.push(...this.emitText(parsed.prefix))

    let k = 0
    for (const call of parsed.calls) {
      const idx = SPLIT_BASE + (this.index % 1000) * 10 + k
      const id = `call_dsml_${uniqueId()}_${k}`
      this.pending.push({ type: 'block-start', index: idx, blockType: 'tool-call' })
      this.pending.push({ type: 'tool-call-delta', index: idx, id, name: call.name, argumentsDelta: call.arguments })
      this.pending.push({ type: 'block-end', index: idx, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } })
      k += 1
    }
    this.stats.calls += parsed.calls.length

    if (parsed.suffix !== '') {
      const idx = SPLIT_BASE + (this.index % 1000) * 10 + 500
      out.push({ type: 'block-start', index: idx, blockType: 'text' })
      out.push({ type: 'text-delta', index: idx, text: parsed.suffix })
      out.push({ type: 'block-end', index: idx, block: { type: 'text', text: parsed.suffix } })
    }

    const body = this.emitted
    this.emitted = ''
    if (this.closed === true) {
      if (this.blockType === 'text' && body !== '') {
        out.push({ type: 'block-end', index: this.outIndex, block: { type: 'text', text: body } })
      }
      this.closed = false
    } else {
      out.push({ ...chunk, block: { ...chunk.block, text: body } })
    }
    this.stats.split += 1
    return out
  }

  /** 补发合成调用：只有模型没发结构化调用时才补，避免执行两次。 */
  flushPending() {
    if (this.pending.length === 0) return []
    const out = this.sawRealCall ? [] : this.pending
    if (this.sawRealCall) this.stats.dropped += this.pending.length / 3
    this.pending = []
    return out
  }

  settle() {
    if (this.mode === 'scan' && this.buf !== '') {
      const out = this.emitText(this.buf)
      this.buf = ''
      return out
    }
    return []
  }
}

/** 把整条流跑一遍。 */
export function dsmlSplitStream(source, onDone) {
  const split = new DsmlSplit()
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of source) {
          for (const out of split.push(chunk)) yield out
        }
        for (const out of split.flush()) yield out
      } finally {
        onDone?.(split.stats)
      }
    },
  }
}





