/**
 * DSML 解析测试。样本取自真实泄漏（截图里的 run_code 调用）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { hasDsmlCall, parseDsml } from '../dsml.js'

const SAMPLE = [
  'Let me try. 当前 EDA 只打开了 PCB 页。',
  '<｜DSML｜ calls>',
  '<｜DSML｜ invoke name="run_code">',
  '<｜DSML｜ parameter name="code" string="true">const x = 1; console.log(x)</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="description" string="true">Switch EDA to NVLINK schematic page</｜DSML｜ parameter>',
  '</｜DSML｜ invoke>',
  '</｜DSML｜ calls>',
  '之后的正文。',
].join('')

test('识别调用头', () => {
  assert.equal(hasDsmlCall(SAMPLE), true)
  assert.equal(hasDsmlCall('普通文本'), false)
})

test('解析出 name 与参数', () => {
  const parsed = parseDsml(SAMPLE)
  assert.ok(parsed, '应当解析成功')
  assert.equal(parsed.calls.length, 1)
  assert.equal(parsed.calls[0].name, 'run_code')
  const args = JSON.parse(parsed.calls[0].arguments)
  assert.equal(args.code, 'const x = 1; console.log(x)')
  assert.equal(args.description, 'Switch EDA to NVLINK schematic page')
})

test('前缀与后缀都被切出来', () => {
  const parsed = parseDsml(SAMPLE)
  assert.equal(parsed.prefix, 'Let me try. 当前 EDA 只打开了 PCB 页。')
  assert.equal(parsed.suffix, '之后的正文。')
})

test('多个 invoke 都能解析', () => {
  const text = [
    '<｜DSML｜ calls>',
    '<｜DSML｜ invoke name="a"><｜DSML｜ parameter name="p" string="true">1</｜DSML｜ parameter></｜DSML｜ invoke>',
    '<｜DSML｜ invoke name="b"><｜DSML｜ parameter name="q" string="true">2</｜DSML｜ parameter></｜DSML｜ invoke>',
    '</｜DSML｜ calls>',
  ].join('')
  const parsed = parseDsml(text)
  assert.equal(parsed.calls.length, 2)
  assert.deepEqual(parsed.calls.map((c) => c.name), ['a', 'b'])
})

test('半角竖线也认', () => {
  const text = '<|DSML| calls><|DSML| invoke name="x"><|DSML| parameter name="k" string="true">v</|DSML| parameter></|DSML| invoke></|DSML| calls>'
  const parsed = parseDsml(text)
  assert.equal(parsed.calls.length, 1)
  assert.equal(JSON.parse(parsed.calls[0].arguments).k, 'v')
})

test('没有闭合标记也能拿到调用', () => {
  const text = '<｜DSML｜ calls><｜DSML｜ invoke name="x"><｜DSML｜ parameter name="k" string="true">v</｜DSML｜ parameter>'
  const parsed = parseDsml(text)
  assert.equal(parsed.calls.length, 1)
})

test('不是 string="true" 的参数按 JSON 解析', () => {
  const text = '<｜DSML｜ calls><｜DSML｜ invoke name="x"><｜DSML｜ parameter name="n">42</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>'
  const parsed = parseDsml(text)
  assert.equal(JSON.parse(parsed.calls[0].arguments).n, 42)
})

