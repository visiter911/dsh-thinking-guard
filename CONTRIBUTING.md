# 贡献指南

## 开发

```bash
git clone https://github.com/visiter911/dsh-thinking-guard.git
cd dsh-thinking-guard
npm test          # 118 条用例，不需要网络
```

- 运行时要求 Node ≥ 22（用到内置 `node:test` 与 `node:zlib` 的 zstd API）
- 没有构建步骤，源码即产物
- 装进 DSH 的方式见 [INSTALL.md](INSTALL.md)

## 代码结构

| 文件 | 职责 |
|---|---|
| `index.js` | 宿主侧：规则存储、HTTP 路由、`llm/stream` 钩子串接 |
| `client.js` | 渲染侧：composer 规则面板、供应商卡片里的「思考块回传」 |
| `wrap.js` | 思考封装：正文里的整段思考改判 |
| `seam.js` | 思考缝合：被误判成结束的半截思考接回同一块 |
| `dedupe.js` | 重复正文去重 |
| `dsml.js` / `dsml-split.js` | DSML 标记解析与切分 |
| `letme.js` | 开口改写、语气词剔除、短意图剔除 |

## 改动约定

1. **正文块一律不改**：除 `dedupe`（去重）与 `dsml-split`（剥标记）外，任何规则都不得改动正文内容
2. **块结束要同步**：`block-end.block.text` 会覆盖累积文本，凡是拼接过内容的转换器必须同时改写它
3. **合成 index 用 `1_000_000 +`**：避免与上游块 index 撞车
4. **合成工具调用 ID 必须全局唯一**：PTC 用它派生 `subCallId`，重复会让会话日志判为损坏
5. 新增规则时同时更新 `RULE_DEFS`、`README.md` 与测试

## 提交

- 提交信息用祈使句，首行不超过 72 字符
- PR 请附带 `npm test` 结果
- 行为变化请更新 `CHANGELOG.md`

