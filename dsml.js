/**
 * DSML 工具调用标记解析。
 *
 * 模型有时把工具调用写成正文里的标记，而不是走结构化字段：
 *
 *   <｜DSML｜ calls>
 *     <｜DSML｜ invoke name="run_code">
 *       <｜DSML｜ parameter name="code" string="true">...</｜DSML｜ parameter>
 *       <｜DSML｜ parameter name="description" string="true">...</｜DSML｜ parameter>
 *     </｜DSML｜ invoke>
 *   </｜DSML｜ calls>
 *
 * 注意闭合标记是 `</｜DSML｜ xxx>`——斜杠在 `<` 后面，别写成 `<｜DSML｜ /xxx>`。
 * 全角 `｜` 与半角 `|` 两种写法都认。
 */

/** 开标记前缀：`<` 后紧跟竖线。 */
const OPEN = String.raw`<\s*[｜|]\s*DSML\s*[｜|]\s*`
/** 闭标记前缀：`</` 后紧跟竖线。 */
const CLOSE = String.raw`<\/\s*[｜|]\s*DSML\s*[｜|]\s*`

const HEAD = new RegExp(`${OPEN}calls\\s*>`, 'i')
const INVOKE = new RegExp(`${OPEN}invoke\\s+name="([^"]*)"\\s*>`, 'gi')
const INVOKE_END = new RegExp(`${CLOSE}invoke\\s*>`, 'i')
const PARAM = new RegExp(
  `${OPEN}parameter\\s+name="([^"]*)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)${CLOSE}parameter\\s*>`,
  'gi',
)
const CALLS_END = new RegExp(`${CLOSE}calls\\s*>`, 'i')
const ANY = new RegExp(OPEN, 'i')

/** `string="true"` 表示原样字符串，否则按 JSON 解析。 */
function coerce(text, isString) {
  if (isString) return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** 文本里是否有 DSML 调用头。 */
export function hasDsmlCall(text) {
  return HEAD.test(String(text ?? ''))
}

/** 文本里是否出现过任何 DSML 标记。 */
export function hasAnyDsml(text) {
  return ANY.test(String(text ?? ''))
}

/**
 * 解析第一段调用。
 *
 * @param {string} text
 * @returns {{ calls: Array<{name: string, arguments: string}>, prefix: string, suffix: string } | undefined}
 */
export function parseDsml(text) {
  const value = String(text ?? '')
  const head = HEAD.exec(value)
  if (head === null) return undefined

  const prefix = value.slice(0, head.index)
  const afterHead = value.slice(head.index + head[0].length)
  const tail = CALLS_END.exec(afterHead)
  const body = tail === null ? afterHead : afterHead.slice(0, tail.index)
  const suffix = tail === null ? '' : afterHead.slice(tail.index + tail[0].length)

  const calls = []
  INVOKE.lastIndex = 0
  let match
  while ((match = INVOKE.exec(body)) !== null) {
    const name = match[1]
    const rest = body.slice(match.index + match[0].length)
    const end = INVOKE_END.exec(rest)
    const inner = end === null ? rest : rest.slice(0, end.index)

    const params = {}
    PARAM.lastIndex = 0
    let param
    while ((param = PARAM.exec(inner)) !== null) {
      params[param[1]] = coerce(param[3], param[2] === 'true')
    }
    calls.push({ name, arguments: JSON.stringify(params) })
  }

  return { calls, prefix, suffix }
}
