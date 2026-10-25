/**
 * 走道缝合（seam repair）——把被上游切成两截的思考接回成**一个完整块**。
 *
 * 背景：模型在自己的思考里吐出字面的思考标记（例如 "` thinking…"），
 * 服务端的通道分离器把它当成「思考结束」，于是同一段思考的后半截以
 * `content` 字段下发，看起来像一个正文块。
 *
 * 口径（用户定）：
 *   这不是正文块，是一个被误判成「结束」的特殊 token。
 *   所以**不新开块、不改判、不合并两个块**——思考块自始至终只有一个。
 *   那个标记要让它看起来像一个普通文本 token，不能让它结束思考块。
 *
 * 做法：
 *   - 判定成立后，后续 text delta 继续喂给**同一个仍然打开的思考块**（原 index）
 *   - 上游 text 块的 block-start / block-end 整个丢掉，块总数不变
 *   - 块内出现的字面标记就地转义成普通文本（插入零宽空格，肉眼仍是原样，
 *     但不再匹配标记模式、不会被当成 HTML 标签），也就不会再有下一次误判
 *
 * 判据只认「接缝处有机械性断裂」的证据，不猜语义：
 *   1. 尾部最后一行有未闭合的反引号 / 括号，正文紧接着闭掉它
 *   2. 拉丁词被从中间劈开
 *   3. 尾部停在逗号 / 分号 / 冒号 / 破折号上
 *   4. 尾部停在连接词上
 */

/** 字面的思考结束标记：模型真正用来结束思考的那个 token。 */
const CLOSERS = /<\/\s*(?:think|thinking|analysis|summary|reasoning)\s*>|<｜\s*[^｜]{0,24}(?:think|thinking|analysis|summary|reasoning)[^｜]{0,24}｜>/gi

/** 工具调用的文本标记（全角与半角都算）。含这个的一段一律不并进思考。 */
const DSML = /<[｜|]\s*DSML\s*[｜|]/i

/**
 * 找真正用于收口的结束标记：被反引号/引号包住的是**文本里提到的**，不算。
 * @returns {number} 起始位置，-1 表示没有
 */
function findCloser(text) {
  CLOSERS.lastIndex = 0
  let m
  while ((m = CLOSERS.exec(text)) !== null) {
    const before = text[m.index - 1] ?? ''
    const after = text[m.index + m[0].length] ?? ''
    // 只认**成对**包裹：单个反引号前缀太宽，会把真标记也跳过
    if ((before === '`' && after === '`') || (before === '"' && after === '"')) continue
    return m.index
  }
  return -1
}

/** 折叠时向后滞留的字符数，防止标记被 chunk 边界劈开。 */
const MARKER_HOLDBACK = 24

/** 攒够这么多字符就裁决，兼顾首字延迟。 */
const DECIDE_CHARS = 12

/** 回答/结构开场：正文以这些开头就不可能是思考的续写。 */
const ANSWER_OPENER = /^(?:#{1,6}\s|[-*+•]\s|\d+[.)]\s|>\s|\|\s|我|已|好|下面|结论|完成|以上|这是|根据|综上|总之|总结|结果|答案|现在|首先|其次|最后|另外|此外|因此|Let me write|Here is|Here's|I'll|I've|Done|The answer)/

/** 可以「接着上文」的开头。 */
const CONTINUATION_HEAD = /^[`)\]）】」》"'’，,;；:：、]|^(?:or|and|but|so|because|which|that|with|from|to|of|in|for|as|then|while|if|when|the|a|an)\b/i

/** 尾部停在连接词上。 */
const TAIL_CONJUNCTION = /(?:^|[\s(])(?:and|or|but|so|because|with|to|the|a|an|of|in|for|as|then|while|if|when)$/i

function countChar(text, ch) {
  let n = 0
  for (const c of text) if (c === ch) n += 1
  return n
}

/** 这一行里有没有未闭合的括号类。 */
function hasOpenBracket(line) {
  const pairs = [['(', ')'], ['[', ']'], ['（', '）'], ['【', '】'], ['「', '」']]
  for (const [open, close] of pairs) {
    if (countChar(line, open) > countChar(line, close)) return true
  }
  return false
}

function lastLine(text) {
  const cut = text.lastIndexOf('\n')
  return cut < 0 ? text : text.slice(cut + 1)
}

/**
 * 思考尾部看起来「没说完」吗？——进入观察状态的门槛，不是裁决。
 * 门槛放宽只会多缓冲十几个字符，不会误改。
 */
export function tailLooksOpen(tail) {
  const text = String(tail ?? '')
  if (text.trim() === '') return false
  const line = lastLine(text)
  if (countChar(line, '`') % 2 === 1) return true
  if (hasOpenBracket(line)) return true
  const trimmed = text.replace(/\s+$/, '')
  if (/[,，;；:：、\-–—]$/.test(trimmed)) return true
  if (!/[。！？.!?…]$/.test(trimmed)) return true
  return false
}

/**
 * 接缝能不能拼成一句话。
 * @returns {{join: boolean, why?: string}}
 */
export function joinsAsSentence(tail, head) {
  const t = String(tail ?? '')
  const raw = String(head ?? '')
  if (raw.trim() === '') return { join: false, why: 'empty-head' }

  const h = raw.replace(/^\s+/, '')
  if (ANSWER_OPENER.test(h)) return { join: false, why: 'answer-opener' }
  // 正文另起一段（尾部以换行结束）不算接缝
  if (/\n[ \t]*$/.test(t)) return { join: false, why: 'paragraph-break' }

  const line = lastLine(t)
  const trimmed = t.replace(/\s+$/, '')
  const lastTailChar = trimmed.slice(-1)

  const danglingTick = countChar(line, '`') % 2 === 1
  const danglingBracket = hasOpenBracket(line)
  if ((danglingTick || danglingBracket) && CONTINUATION_HEAD.test(h)) {
    return { join: true, why: danglingTick ? 'dangling-backtick' : 'dangling-bracket' }
  }

  // 以闭合类标点开头的，永远不可能是新句子
  if (/^[，,、；;：:。.）)\]】」》"']/.test(h)) {
    return { join: true, why: 'closer-head' }
  }

  if (/[a-z]$/.test(lastTailChar) && /^[a-z]/.test(h)) {
    return { join: true, why: 'split-word' }
  }

  // 大写开头通常意味着这是新句子，不是上文续写
  const headContinues = !/^[A-Z]/.test(h)

  if (/[,，;；:：\-–—]$/.test(lastTailChar) && headContinues) {
    return { join: true, why: 'clause-continuation' }
  }

  if (TAIL_CONJUNCTION.test(trimmed) && headContinues) {
    return { join: true, why: 'dangling-conjunction' }
  }

  return { join: false, why: 'no-mechanical-seam' }
}

function reasoningDelta(index, text) {
  return { type: 'reasoning-delta', index, text }
}

/**
 * 流转换器：push(chunk) 返回要输出的 chunk 列表。
 *
 * 状态机：
 *   idle    —— 透传
 *   pending —— 正文块已开始，攒几个字符判断接缝
 *   folding —— 判定成立，正文并回同一个思考块
 */
export class SeamRepair {
  constructor() {
    this.mode = 'idle'
    this.reasoningIndex = null
    this.reasoningClosed = false
    this.tail = ''
    this.textIndex = -1
    this.buf = []
    this.bufText = ''
    this.textFolded = false
    /** 折叠时向后滞留的字符（防止结束标记被 chunk 边界劈开）。 */
    this.foldHold = ''
    /** 已经并进思考块的文本，收尾时要补进 block-end 的 text。 */
    this.foldedText = ''
    this.stats = { folded: 0, chars: 0, reasons: {} }
  }

  note(reason, chars) {
    this.stats.folded += 1
    this.stats.chars += chars
    this.stats.reasons[reason] = (this.stats.reasons[reason] ?? 0) + 1
  }

  push(chunk) {
    switch (chunk.type) {
      case 'block-start': return this.onBlockStart(chunk)
      case 'text-delta': return this.onTextDelta(chunk)
      case 'reasoning-delta': return this.onReasoningDelta(chunk)
      case 'block-end': return this.onBlockEnd(chunk)
      default: return [...this.settle(), chunk]
    }
  }

  /** 流结束。 */
  flush() {
    return this.settle()
  }

  onBlockStart(chunk) {
    if (chunk.blockType === 'reasoning') {
      const carried = this.settle()
      this.reasoningIndex = chunk.index
      this.reasoningClosed = false
      this.tail = ''
      return [...carried, chunk]
    }
    if (
      chunk.blockType === 'text'
      && this.mode === 'idle'
      && this.reasoningIndex !== null
      && !this.reasoningClosed
      && tailLooksOpen(this.tail)
    ) {
      this.mode = 'pending'
      this.textIndex = chunk.index
      this.buf = []
      this.bufText = ''
      this.textFolded = false
      // block-start 扣下：判定不成立时原样吐出，成立时整块丢弃
      return []
    }
    return [...this.settle(), chunk]
  }

  onTextDelta(chunk) {
    if (this.mode === 'pending' && chunk.index === this.textIndex) {
      this.buf.push(chunk)
      this.bufText += chunk.text
      if (this.bufText.length >= DECIDE_CHARS) return this.decide()
      return []
    }
    if (this.mode === 'folding' && chunk.index === this.textIndex) {
      return this.foldMore(chunk.text)
    }
    return [chunk]
  }

  onReasoningDelta(chunk) {
    if (chunk.index === this.reasoningIndex) this.tail = keepTail(this.tail + chunk.text)
    return [chunk]
  }

  onBlockEnd(chunk) {
    if (chunk.block?.type === 'reasoning' && chunk.index === this.reasoningIndex) {
      const carried = this.settle()
      this.reasoningClosed = true
      // block-end 里的 text 会覆盖累积内容：把并进去的部分补上，
      // 否则落盘的历史里这段内容会凭空消失，模型下一轮看到的是残缺上下文。
      const patch = this.foldedText !== ''
        ? { ...chunk, block: { ...chunk.block, text: `${chunk.block.text ?? ''}${this.foldedText}` } }
        : chunk
      this.foldedText = ''
      return [...carried, patch]
    }
    if (chunk.index === this.textIndex && (this.mode === 'pending' || this.mode === 'folding')) {
      const out = []
      // 块在上游已经结束了，就用现有字符裁决，不能因为「没攒够」直接放行
      if (this.mode === 'pending') out.push(...this.decide())
      if (this.mode === 'folding') {
        // 直到块结束都没出现真正的结束标记：整块都是思考
        if (this.foldHold !== '') {
          out.push(reasoningDelta(this.reasoningIndex, this.foldHold))
          this.foldHold = ''
        }
        this.mode = 'idle'
        this.textFolded = false
        // 它的结束不该让思考块结束
        return out
      }
      this.mode = 'idle'
      return [...out, chunk]
    }
    return [...this.settle(), chunk]
  }

  /** 裁决：接缝成立则并入思考块，否则原样放行。 */
  decide() {
    // 含工具调用标记：绝不并进思考
    if (DSML.test(this.bufText)) {
      const buffered = this.buf
      this.buf = []
      this.bufText = ''
      this.mode = 'idle'
      return [{ type: 'block-start', index: this.textIndex, blockType: 'text' }, ...buffered]
    }
    const verdict = joinsAsSentence(this.tail, this.bufText)
    const buffered = this.buf
    const text = this.bufText
    this.buf = []
    this.bufText = ''

    if (!verdict.join) {
      this.mode = 'idle'
      this.textFolded = false
      // 原样吐出：把扣下的 block-start 补回来，后续 block-end 正常通过
      return [{ type: 'block-start', index: this.textIndex, blockType: 'text' }, ...buffered]
    }

    this.mode = 'folding'
    this.textFolded = true
    this.note(verdict.why, text.length)
    return this.foldMore(text)
  }

  /**
   * 折叠正文。
   *
   * 撞到真正的结束标记就地收尾：**标记之前归思考，标记之后恢复为正文**
   * ——那个 token 是模型自己生成在正确位置上的，必须尊重它。
   */
  foldMore(text) {
    const combined = this.foldHold + text
    const at = findCloser(combined)

    if (at >= 0) {
      const rest0 = combined.slice(at)
      CLOSERS.lastIndex = 0
      const matched = CLOSERS.exec(rest0)
      const head = combined.slice(0, at)
      const rest = combined.slice(at + (matched?.[0].length ?? 0))
      this.foldHold = ''
      this.mode = 'passthrough'
      this.textFolded = false
      const out = []
      if (head !== '') {
        this.foldedText += head
        out.push(reasoningDelta(this.reasoningIndex, head))
      }
      // 正文块从标记之后重新开始，用的仍是它自己的 index
      out.push({ type: 'block-start', index: this.textIndex, blockType: 'text' })
      if (rest !== '') out.push({ type: 'text-delta', index: this.textIndex, text: rest })
      return out
    }

    if (combined.length > MARKER_HOLDBACK) {
      const emit = combined.slice(0, combined.length - MARKER_HOLDBACK)
      this.foldHold = combined.slice(-MARKER_HOLDBACK)
      if (emit !== '') this.foldedText += emit
      return emit === '' ? [] : [reasoningDelta(this.reasoningIndex, emit)]
    }
    this.foldHold = combined
    return []
  }

  /** 把悬着的东西结清：pending 先裁决再放行；folding 冲出滞留字符。 */
  settle() {
    if (this.mode === 'pending') {
      const out = this.decide()
      this.mode = 'idle'
      return out
    }
    if (this.mode === 'folding') {
      const rest = this.foldHold
      this.foldHold = ''
      this.mode = 'idle'
      return rest === '' ? [] : [reasoningDelta(this.reasoningIndex, rest)]
    }
    return []
  }
}

function keepTail(text) {
  const LIMIT = 400
  return text.length <= LIMIT ? text : text.slice(-LIMIT)
}

/** 把整条流跑一遍，返回转换后的流。 */
export function repairStream(source, onDone) {
  const repair = new SeamRepair()
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of source) {
          for (const out of repair.push(chunk)) yield out
        }
        for (const out of repair.flush()) yield out
      } finally {
        // 消费方提前取消时也会走到这里，统计照样能落日志
        onDone?.(repair.stats)
      }
    },
  }
}




