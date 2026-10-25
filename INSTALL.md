# 安装说明

适用：DeepSeek Harness 桌面版 / `dsh` CLI（插件会挂到 profile 的 bundle 上）。

## 1. 放到插件目录

把整个 `dsh-thinking-guard` 文件夹放到：

```
~/.dsh/plugins-src/dsh-thinking-guard
```

Windows 上即 `C:\Users\<你的用户名>\.dsh\plugins-src\dsh-thinking-guard`。

## 2. 在 profile 里注册

编辑 `~/.dsh/profiles/desktop/package.json`，在 `dependencies` 里加一行（路径按实际位置改）：

```json
{
  "dependencies": {
    "dsh-thinking-guard": "link:../../plugins-src/dsh-thinking-guard"
  }
}
```

再在同一个文件的 `dsh.profile.bundles` 数组里加上包名：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-thinking-guard"
      ]
    }
  }
}
```

## 3. 安装依赖

```
cd ~/.dsh/profiles/desktop
pnpm install
```

## 4. 重启 DSH

宿主侧改动需要重启才生效；客户端部分（composer 里的「规则」按钮）重启后出现。

## 5. 验证

1. 打开设置 → 模型 → 任一供应商卡片，应能看到「思考块回传」开关
2. composer 底栏应出现「规则」按钮，点开是七条规则
3. 规则面板底部会显示「最近一次生效时间」——发出一次请求后那行时间会刷新，说明插件确实挂上了

## 默认状态

**所有顶层规则默认关闭**，插件是纯透传。按需打开即可，互不依赖：

| 规则 | 建议 |
|---|---|
| 思考缝合 | 上游把思考拦腰截断时开 |
| 思考封装 | 思考写进正文时开 |
| 工具调用还原 | 正文/思考里出现 `<｜DSML｜` 标记时开 |
| 重复正文去重 | 正文整段复述思考时开 |
| 开口改写 | 想去掉 `Let me…`、语气词、重复短意图时开 |

## 卸载

从 `dsh.profile.bundles` 里删掉包名，再 `pnpm install`，重启即可。
只做临时停用的话，在该 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: thinking-guard
  disabled: true
```

## 自测

```
npm test
```

会用 Node 内置的 test runner 跑 115 条用例（不依赖网络）。

## 版本说明

- **0.2.1**：宽匹配（`summary` / `details` / `reasoning` 等结束标记）、`</thinking>` 在正文中也能正确切分、只读 `options` 不再抛错、DSML 工具调用合成 ID 全局唯一（避免 PTC 子调用撞车）
- **0.2.0**：规则默认全关、面板显示「已生效」时间、会话 key 兼容三种写法
