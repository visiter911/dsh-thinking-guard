# Changelog

本文件记录所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.2] - 2026-10-25

### Added
- 子代理默认继承父会话规则：父会话关掉的项，子代理也关；子会话自己声明过的键优先。

## [0.2.1] - 2026-10-25

### Fixed
- 结束标记集合补全（`summary` / `details` / `reasoning`），并处理只存在于 `block-end` 的内容。
- 正文中的 `</thinking>` 现在在标记处切分，答复不再被整段并进思考。
- 「思考块回传」关闭时不再给只读的 `options` 赋值，避免整轮 `Cannot assign to read only property`。
- DSML 合成工具调用的 ID 改为全局唯一，避免 PTC 子调用 ID 重复导致会话日志损坏。

## [0.2.0] - 2026-10-24

### Changed
- 所有顶层规则默认关闭，插件默认纯透传。
- 规则面板底部显示最近一次实际生效的时间。
- 会话配置 key 兼容 `session-` 前缀 / 裸 UUID 两种写法。

### Added
- 「工具调用还原」「重复正文去重」「语气词剔除」「短意图剔除」四个独立开关。

## [0.1.0] - 2026-10-23

### Added
- 首版：composer 规则面板、思考缝合、思考封装、开口改写、供应商级「思考块回传」。
