# dsh-thinking-guard

[![CI](https://github.com/visiter911/dsh-thinking-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/visiter911/dsh-thinking-guard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

DeepSeek Harness 插件：把跑偏的**思考块**收回思考通道。

模型的思考有时会跑到正文里、被拦腰截断、或者把工具调用写成文本标记。这个插件在
`llm/stream` 上加一层可开关的修复流水线，把内容放回它该在的通道——**默认全部关闭，
纯透传**，你要哪条再打开哪条。

- 顶部 composer 的「规则」面板，按会话独立配置
- 子代理默认继承父会话规则
- 供应商卡片里的「思考块回传」开关（官方 DeepSeek 系默认开，第三方默认关）
- 118 条测试，零网络依赖

## 快速开始

```bash
# 1. 放进插件目录
git clone https://github.com/visiter911/dsh-thinking-guard.git \
  ~/.dsh/plugins-src/dsh-thinking-guard

# 2. profile 里登记（详见 INSTALL.md）
#    profiles/desktop/package.json → dependencies + dsh.profile.bundles

# 3. 安装并重启 DSH
cd ~/.dsh/profiles/desktop && pnpm install
```

完整步骤、验证方法与卸载方式见 **[INSTALL.md](INSTALL.md)**。

## 规则一览

| 规则 | 缺省 | 作用 |
|---|---|---|
| 思考缝合 `seamRepair` | 关 | 被误判成结束的半截思考，接回同一个思考块 |
| 思考封装 `wrapThinking` | 关 | 整段写进正文的思考，改判成思考块 |
| 工具调用还原 `dsmlSplit` | 关 | 正文/思考里的 DSML 标记还原成结构化 tool-call |
| 重复正文去重 `dedupeText` | 关 | 正文复述思考时丢弃重复部分 |
| 开口改写 `letmeRewrite` | 关 | `Let me X` → `I'll X`，含两个子开关 |

## 架构

```
llm/stream 钩子（同步）
   ↓ 命中开关的转换器按顺序串接
dsml-split → dedupe → wrap → seam → letme
   ↓
原样透传未命中的 chunk
```

每个转换器都是「不命中就原样放行」的纯函数式状态机，块结束时会同步改写
`block-end.block.text`（它才是一致性的真相来源）。

---

# 详细说明

## 现有规则

| key | 名称 | 缺省 | 作用 |
|---|---|---|---|
| `seamRepair` | 思考缝合 | 开 | 被上游误判成「思考结束」的半截思考，接回**同一个**思考块 |
| `wrapThinking` | 思考封装 | 开 | 整段写进正文的思考，缓冲 20 token 后改判成思考块 |
| `letmeRewrite` | 开口改写 | **关** | 父开关：`Let me X` → `I'll X`；展开后有子开关 |
| `fillerStrip` | 语气词剔除（子） | 开 | `Hmm` / `Uh` / `嗯` 等句首语气词 |
| `intentPrune` | 短意图剔除（子） | 开 | 连续意图只保留最后一条完整的 |

子开关只在父项打开时生效；父项关闭时子开关变灰。徽章只统计顶层规则。

## 思考封装（wrap.js）

**现象**：模型把思考直接写进了 `content` 通道，界面上就是一大段「我在想…」的正文。

**做法**：本轮没有思考块时，正文块先缓冲，不急着决定；等到**下一拍**看后面跟的是什么。

**判据（中间可以折叠，最终正文绝不能被吃）**：

| 情况 | 结果 |
|---|---|
| 本轮已有思考块 | 不介入（思考块后只可能是正文） |
| 以 `#` 起手 | 正文，原样放行 |
| 开头像进度汇报（`reportScore >= 3`） | 正文 |
| 其余情况，块后**跟着 tool call** | 回合中段的思考 → 折叠 |
| 其余情况，块后**直接收尾** | 最终答复 → 保持正文 |
| 缓冲中出现行首 `#` | 汇报式导语+短前缀 → 整块正文；否则从 `#` 处切开 |
| 缓冲超过 1500 字符 | 提前定案为思考，避免把长回复一直扣住 |
| 正文里有 `<thinking>…</thinking>` | **标记内部一律归思考**（这条不受「已有思考块」限制） |

「延迟一拍」是这条规则的核心：块结束时先扣住内容，等下一个 chunk——
是 tool call 就说明这只是中段思考，否则说明这就是最终答复。

切开时正文块需要一个**新的 index**（原文块已被改判成思考），用
`1_000_000 + 原 index` 占位，避开真实序号。代价：该消息的 `replayState`
块数对不上，replay 元数据会退化（assistant 消息仍能正常回放，只是走兜底路径）。

空块不封装，避免造出空思考块。

代价：不以 `#` 开头、且本轮没有思考块的回答会被移进思考面板。觉得太激进
可以按会话关掉这条规则。

## 处理顺序

```
模型流 → 去重 → 封装 → 缝合 → 开口改写 → 输出
```

顺序不能换：

- **去重必须最先**：否则封装会先把重复块切开，去重就认不出「逐字节相同」了
- **封装在中**：它的采样要看到原始文本，不能被缝合的缓冲截断
- **缝合**：处理封装之后仍然存在的接缝
- **开口改写最后**：它只动思考文本；前面若还有结构问题，改写的内容会被块的收尾文本覆盖

## 开口改写（letme.js）

只处理**思考通道**，正文一个字都不碰。按句子缓冲（句末标点或 400 字符），
攒够一句就改写并发出，不做整块延迟。

- `Let me X` → `I'll` / `I will` / `I'm going to` / `I should` / `I need to` / `Now I'll`（单数第一人称）
- `Let's X` → `We'll` / `We should` / `We need to` / `We're going to`（复数，语义不同不混用）
- `让我 X` → `我来` / `我先` / `我得` / `我需要` / `接下来我`
- 按**句子内容哈希**选句式：同一句永远同一个结果，整段自然分散，不会全塌成一句
- 只改开口（英文前 8 字符、中文前 6 字符），句中的 let me 不动
- `block-end` 的 `text` 写成改写后的累积文本，否则会被原始文本覆盖

### 语气词剔除

句首含义为零的语气词直接删掉，删完把露出来的首字母大写：

| 语言 | 剔除 |
|---|---|
| 英文 | `Hmm` `Hmmm` `Hm` `Uh` `Uhm` `Um` `Umm` `Er` `Erm` `Ah` `Eh` |
| 中文 | `嗯` `呃` `唔` `唉` |

- 只削**句首**：句中的 `hmm`（比如正在讨论这个词）一个字都不动
- 整块只有语气词时，块收尾文本写成空串，不残留 `" "`
- 先削语气词再改开口——否则「嗯，让我看看」里的「让我」不在句首，改不到

### 短意图聚合

以意图开口起头、句子很短（英 ≤60 / 中 ≤30 字符）的句子视为**意图句**：

- **泛指的直接删**：动作部分没有具体对象，如 `I'll check it.` / `我来看看。`
- **连续意图只留最后一条完整的**：遇到非意图句或块结束时结算，
  从后往前找第一条「有具体动作」的，其余剔除
- 非意图句不受影响，顺序不变（先放出攒着的意图，再发当前句）

## 思考块回传（供应商级）

设置 → 模型 → 供应商卡片里的开关。控制**请求历史里 assistant 消息的 reasoning 块是否回传**。

- 官方供应商（provider id 以 `deepseek` 开头）：缺省**开**。服务端要求多轮工具调用
  携带 `reasoning_content`，关掉会导致 400。
- 其它供应商：缺省**关**。
- 任何供应商都可以显式覆盖，覆盖值持久化在 `~/.dsh/thinking-guard.json` 的 `providers` 下。

实现位置：`llm/stream` 的 `options.messages`。开关为关时，在调用 `next()` 之前
把 assistant 消息里的 `reasoning` 块裁掉（整条只剩思考时保持原样，避免产出空消息）。

## 思考缝合（seam.js）

**现象**：模型在自己的思考里吐出字面的思考标记（例如 `` ` thinking ``），
服务端的通道分离器把它当成结束标记，于是同一段思考的后半截以 `content`
字段下发，看起来像一个正文块；后面还可能跟一个字面的 `</think>`。

**判定**：只认接缝处的机械断裂，不猜语义。

1. 尾部最后一行有未闭合的反引号 / 括号，正文紧接着闭掉它
2. 拉丁词被从中间劈开
3. 尾部停在逗号 / 分号 / 冒号 / 破折号上
4. 尾部停在连接词上

任一条成立，且正文不是以标题 / 列表 / 答案开场词开头 → 认定是同一段思考。

**处置**：

- 后续 text delta 继续喂给**同一个仍然打开的思考块**（原 index）
- 折叠到**真正的结束标记**为止：`</think>` 这类 token 是模型自己生成在正确位置上的，
  标记之前归思考，标记之后恢复为正文（用正文块自己的 index），标记本身消费掉
- 直到块结束都没出现结束标记时：整块并入思考，上游正文块的 `block-start` /
  `block-end` 一起丢掉，不凭空开一个正文块
- 思考块自始至终是一个整块，后面模型真正的思考块照常接得上

判据不成立时逐 chunk 原样放行。

## 结构

```
index.js       宿主：RULE_DEFS（唯一事实来源）+ 状态文件 + /dsh-thinking-guard 路由
client.js      客户端：conversation.input.left 胶囊 + 面板壳
```

状态文件：`~/.dsh/thinking-guard.json`

```json
{
  "version": 1,
  "sessions": {
    "session-xxxx": { "someRule": true }
  }
}
```

键是 sessionId，所以每个会话一份配置，互不影响；没有条目的会话走 `RULE_DEFS` 的 `default`。

## 子代理继承

subagent 的子会话**默认继承父会话的规则**：

- 父会话开着的规则，子代理跟着生效
- 父会话显式关掉的规则，子代理也是关的
- 子会话自己写过的键优先（在子会话里单独改过，就以它为准）
- 最多向上追溯 8 层，越界或没有父会话时回落到缺省值

父会话关系来自 `session.header`：`origin === 'subagent'` 时取 `parentSession`。
普通会话（`origin` 不是 subagent）不继承，直接用自己的配置或缺省值。


## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dsh-thinking-guard/state?sessionId=…` | 取本会话生效规则 + 规则清单 `defs` |
| PUT | `/dsh-thinking-guard/rules` | 写本会话覆盖，body `{ sessionId, rules: { key: bool } }` |
| DELETE | `/dsh-thinking-guard/rules?sessionId=…` | 抹掉本会话覆盖，回到缺省 |

未知的 key 会被忽略而不是报错，避免旧前端写坏状态。

## 加一条规则

只改 `index.js` 的 `RULE_DEFS`：

```js
export const RULE_DEFS = [
  { key: 'openerRewrite', zh: '开口改写', en: 'Rewrite openers', zhHint: '…', enHint: '…', default: false },
]
```

界面、徽章计数、「恢复默认」全部自动跟上 —— 客户端不写死条目。
这也正是上一版出问题的根源：界面和判定各写一份口径，迟早会漂移。

## 停用

在 profile 的 `cordis.patch.yml` 加：

```yaml
- id: thinking-guard
  disabled: true
```

`disabled` 是加载器级开关，客户端半边也不会加载，胶囊随之消失。

## 安装

1. profile `package.json` 的 `dependencies` 加
   `"dsh-thinking-guard": "link:../../plugins-src/dsh-thinking-guard"`
2. `dsh.profile.bundles` 加 `"dsh-thinking-guard"`
3. 在 profile 目录跑 `pnpm install`
4. 重启 DSH





