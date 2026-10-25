/**
 * 思考开口改写：Let me X → I'll X。
 *
 * 位置：链路**最后**一道。结构性问题（重复、标记、接缝）都修完之后，
 * 才对思考文本做风格改写。
 *
 * 原则：
 *   - **只动思考通道**：`text-delta` 一律原样透传，正文块一个字都不碰；
 *     块收尾只在 `block.type === 'reasoning'` 时改写
 *   - **确定性多样化**：按句子内容哈希选句式，同一句永远得到同一个结果，
 *     但整段不会全塌成 "I'll"
 *   - 只替换开口，不动后面的内容
 *   - 按 index 分别缓冲：思考块可能比正文块晚结束，不能只记住"当前块"
 */

/** 单数第一人称候选句式（let me）。 */
export const I_STYLES = [
  "I'll",
  "I'll",
  'I will',
  "I'm going to",
  'I should',
  'I need to',
  'Now I\'ll',
]

/** 复数第一人称候选句式（let's）。 */
export const WE_STYLES = ['We\'ll', 'We should', 'We need to', "We're going to"]

/** 中文候选句式。 */
export const ZH_STYLES = ['我来', '我先', '我得', '我需要', '接下来我']

/** 句子边界：用于按句改写，兼顾流式。 */
const SENTENCE_END = /[.!?。！？\n]/

/** 一行超过这个长度还没句子边界，就先发出去。 */
const MAX_BUFFER = 400

/** 稳定的字符串哈希（FNV-1a），用于确定性选句式。 */
export function hashText(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function pick(styles, seed) {
  return styles[seed % styles.length]
}

/** 句首含义为零的语气词。中英文都只收「删掉不损失信息」的。 */
const FILLERS = /^(?:\s*(?:hmm+|hmmm+|hm+|uh+|uhm+|um+|umm+|er|erm|ah|eh|嗯+|呃+|唔+|唉+)[\s,，.。!！?？~～]*)+/i

/**
 * 去掉句首语气词，并把被削掉后露出来的首字母大写。
 *
 * 只动句首：句中/词中的 `hmm`（例如讨论这个词本身）一个字都不碰。
 */
export function stripFillers(sentence) {
  const text = String(sentence ?? '')
  if (text === '') return text
  const stripped = text.replace(FILLERS, '')
  if (stripped === text) return text
  if (stripped === '') return ''
  // 语气词后面接的如果是小写字母，补上大写，避免 "Uh, the" → "the"
  const first = stripped[0]
  if (first >= 'a' && first <= 'z') return stripped[0].toUpperCase() + stripped.slice(1)
  return stripped
}

/**
 * 改写单个句子里的开口。
 * @param {string} sentence
 * @returns {string}
 */
export function rewriteSentence(sentence, options = {}) {
  if (typeof sentence !== 'string' || sentence === '') return sentence
  const useFiller = options.filler !== false
  // 先削语气词，再改开口——否则 "嗯，让我看看" 里的「让我」不在句首
  let out = useFiller ? stripFillers(sentence) : sentence
  if (out === '') return ''
  const seed = hashText(out)

  // let's 用复数第一人称，let me 用单数——语义不同，池子也不同
  out = out.replace(/\blet's\b/gi, (match, offset) => {
    if (offset > 8) return match
    const style = pick(WE_STYLES, seed + offset)
    const lower = match[0] === match[0].toLowerCase()
    return lower ? style.toLowerCase() : style
  })

  out = out.replace(/\blet me\b/gi, (match, offset) => {
    if (offset > 8) return match // 只改开口：允许前置空白和引号
    const style = pick(I_STYLES, seed + offset)
    const lower = match[0] === match[0].toLowerCase()
    return lower ? style.toLowerCase() : style
  })

  // 中文：句首 6 字之内
  out = out.replace(/让我/g, (match, offset) => {
    if (offset > 6) return match
    return pick(ZH_STYLES, seed + offset)
  })

  return out
}

/**
 * 意图句判定：以意图开口起头、句子很短、句末有标点。
 *
 * 这类句子往往只是「我要去做 X」的宣称，紧接着才写真正要做的事，
 * 密度很低；连续出现时只保留最后一条完整的。
 */
const EN_INTENT = /^(?:I'll|I will|I'm going to|I should|I need to|Now I'll|We'll|We should|We need to|We're going to)\b/i
const ZH_INTENT = /^(?:我来|我先|我得|我需要|接下来我)/

/** 泛指：动作部分没有具体对象。 */
const EN_GENERIC_ACTION = /^\s*(?:it|this|that|them|things?|around|again|more|now|the same|see|look)?\s*[.!?,]?\s*$/i
const ZH_GENERIC_ACTION = /^\s*(?:一下|看看|看看这个|确认一下|这里|这个|那里)?\s*[。！？，]?\s*$/

/** 意图句最长长度（超过就认为它在陈述实质内容，不动）。 */
const INTENT_MAX_EN = 60
const INTENT_MAX_ZH = 30

/** 把意图句拆成「开口」和「动作」。 */
function splitIntent(sentence) {
  const text = String(sentence ?? '').trim()
  const match = EN_INTENT.exec(text) ?? ZH_INTENT.exec(text)
  if (match === null) return undefined
  return { opener: match[0], action: text.slice(match[0].length).trim() }
}

/** 是不是「泛指到没有信息」的意图。 */
function isGenericIntent(parts) {
  if (parts === undefined) return false
  const action = parts.action.replace(/[.!?。！？]+$/, '').trim()
  if (action === '') return true
  if (EN_GENERIC_ACTION.test(action) || ZH_GENERIC_ACTION.test(action)) return true
  const words = action.split(/\s+/).filter(Boolean).length
  const cjk = (action.match(/[\u4e00-\u9fa5]/g) ?? []).length
  if (words > 0 && cjk === 0) return words <= 2
  return cjk > 0 && cjk <= 4
}

/**
 * 是不是一条可剔除的短意图句。
 * @param {string} sentence
 * @returns {{generic: boolean, complete: boolean} | undefined}
 */
export function intentInfo(sentence) {
  const text = String(sentence ?? '').trim()
  if (text === '') return undefined
  const parts = splitIntent(text)
  if (parts === undefined) return undefined
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length
  const limit = cjk > 0 ? INTENT_MAX_ZH : INTENT_MAX_EN
  if (text.length > limit) return undefined
  const action = parts.action.replace(/[.!?。！？]+$/, '').trim()
  const generic = isGenericIntent(parts)
  const complete = !generic && action.length > 0
  return { generic, complete }
}

/** 按句末标点切句，保留标点。 */
export function splitSentences(text) {
  const value = String(text ?? '')
  if (value === '') return []
  const out = []
  let start = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '.' || ch === '!' || ch === '?' || ch === '。' || ch === '！' || ch === '？' || ch === '\n') {
      out.push(value.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < value.length) out.push(value.slice(start))
  return out.filter((s) => s !== '')
}

/** 一个思考块的改写状态。 */
class BlockState {
  constructor() {
    this.buf = ''
    this.out = ''
    /** 连续意图句的暂存：只保留最后一条完整的。 */
    this.intents = []
  }
}

/**
 * 流转换器：只处理思考通道。
 *
 * 按句子缓冲：攒到句末标点（或超过 MAX_BUFFER）就改写并发出，
 * 这样既能看到完整开口，又不会整块延迟。
 */
export class LetMeRewrite {
  constructor(options = {}) {
    /** @type {Map<number, BlockState>} */
    this.blocks = new Map()
    /** 子开关：语气词剔除、短意图剔除 */
    this.filler = options.filler !== false
    this.intent = options.intent !== false
    this.stats = { rewritten: 0, chars: 0, dropped: 0 }
  }

  push(chunk) {
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'reasoning') {
          this.blocks.set(chunk.index, new BlockState())
        }
        return [chunk]
      case 'reasoning-delta':
        return this.onReasoning(chunk)
      case 'block-end':
        return this.onBlockEnd(chunk)
      default:
        return [chunk]
    }
  }

  flush() {
    const out = []
    for (const [index, state] of this.blocks) {
      if (state.buf !== '') out.push(...this.emit(index, state, state.buf))
      state.buf = ''
      for (const kept of this.drainIntents(state)) {
        out.push(...this.emitText(index, state, kept))
      }
    }
    return out
  }

  onReasoning(chunk) {
    const state = this.blocks.get(chunk.index)
    if (state === undefined) return [chunk] // 没有登记的思考块：原样放行
    state.buf += chunk.text
    const cut = this.lastBoundary(state.buf)
    if (cut <= 0) return []
    const head = state.buf.slice(0, cut)
    state.buf = state.buf.slice(cut)
    return this.emit(chunk.index, state, head)
  }

  /** 最后一段可安全发出的位置。 */
  lastBoundary(text) {
    if (text.length >= MAX_BUFFER) {
      const idx = text.lastIndexOf('\n')
      return idx > 0 ? idx + 1 : MAX_BUFFER
    }
    let cut = -1
    for (let i = 0; i < text.length; i += 1) {
      if (SENTENCE_END.test(text[i])) cut = i + 1
    }
    return cut
  }

  emit(index, state, text) {
    if (text === '') return []
    const out = []
    for (const sentence of splitSentences(text)) {
      out.push(...this.handleSentence(index, state, sentence))
    }
    return out
  }

  /** 逐句处理：改写 → 判意图 → 决定立刻发还是暂存。 */
  handleSentence(index, state, sentence) {
    const rewritten = rewriteSentence(sentence, { filler: this.filler })
    // 整句只有语气词：直接丢掉，不发空 delta
    if (rewritten === '') {
      this.stats.dropped += 1
      return []
    }
    // 块开头只剩空白（语气词被削掉后的残渣）也不发；
    // 但块里已经有内容时，段落分隔的空白要保留
    if (rewritten.trim() === '' && state.out.trim() === '') {
      this.stats.dropped += 1
      return []
    }
    if (rewritten !== sentence) {
      this.stats.rewritten += 1
      this.stats.chars += sentence.length
    }
    return this.route(index, state, rewritten)
  }

  /**
   * 意图聚合：连续意图句只保留最后一条完整的，其余剔除。
   *
   * 遇到非意图句时，先把攒着的意图放出来（只留最后一条），再发这一句。
   */
  route(index, state, sentence) {
    // 子开关关掉时不做意图聚合，直接发
    if (this.intent !== true) return this.emitText(index, state, sentence)
    const info = intentInfo(sentence)
    if (info === undefined) {
      const out = []
      for (const kept of this.drainIntents(state)) out.push(...this.emitText(index, state, kept))
      out.push(...this.emitText(index, state, sentence))
      return out
    }
    // 泛指到没有信息（"I'll check it."）：直接丢
    if (info.generic === true) {
      this.stats.dropped += 1
      return []
    }
    state.intents.push(sentence)
    return []
  }

  /** 放出一段连续意图：留最后一条完整的，其余剔除。 */
  drainIntents(state) {
    const run = state.intents
    state.intents = []
    if (run.length === 0) return []
    let keepIndex = run.length - 1
    for (let i = run.length - 1; i >= 0; i -= 1) {
      const info = intentInfo(run[i])
      if (info !== undefined && info.complete === true) {
        keepIndex = i
        break
      }
    }
    for (let i = 0; i < run.length; i += 1) {
      if (i !== keepIndex) this.stats.dropped += 1
    }
    return [run[keepIndex]]
  }

  emitText(index, state, text) {
    if (text === '') return []
    state.out += text
    return [{ type: 'reasoning-delta', index, text }]
  }

  onBlockEnd(chunk) {
    // 正文块（或非思考块）一律原样放行
    if (chunk.block?.type !== 'reasoning') return [chunk]

    const state = this.blocks.get(chunk.index)
    if (state === undefined) return [chunk]
    this.blocks.delete(chunk.index)

    const out = []
    if (state.buf !== '') {
      out.push(...this.emit(chunk.index, state, state.buf))
      state.buf = ''
    }
    for (const kept of this.drainIntents(state)) {
      out.push(...this.emitText(chunk.index, state, kept))
    }
    // block-end 的 text 是落盘真相：一律用改写后的累积文本覆盖。
    // 整块只有语气词时这里就是空串——不能退回去用原始文本。
    const text = state.out.trim() === '' ? '' : state.out
    out.push({ ...chunk, block: { ...chunk.block, text } })
    return out
  }
}

/** 把整条流跑一遍。 */
export function letmeStream(source, options, onDone) {
  const letme = new LetMeRewrite(options)
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of source) {
          for (const out of letme.push(chunk)) yield out
        }
        for (const out of letme.flush()) yield out
      } finally {
        onDone?.(letme.stats)
      }
    },
  }
}







