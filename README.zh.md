# dsh-assistant-optimization

> 一个面向 [DSH](https://github.com/deepseek-ai/deepseek-harness) web profile 的插件：让模型输出更好读，让你的 prompt 更好写。

**[English](./README.md)**

## 功能

六项能力，开箱即用。官方渲染从不被替换——插件遮蔽 DSH 组件后把渲染委托回去，所以 Markdown、工具卡片、图片、表格的行为与原版完全一致。

| | 能力 | 做什么 |
|---|---|---|
| 💭 | **推理折叠** | 把误渲染进正文的推理过程折叠进原生 "Think" 区块 |
| 📊 | **Mermaid 图表** | 把 mermaid 代码块渲染成可交互 SVG（缩放 / 拖拽 / 触摸） |
| ✎ | **编辑 Diff 数值** | 在折叠态 Write、Edit 行上显示 `+10/-2`，无需展开 |
| ✨ | **Prompt 增强** | 一键把粗糙草稿改写成更清晰的指令 |
| ▶ | **断点续发** | 手动中断或会话出错后，发送键变为播放键——悬停显示提示，单击从断点续跑，使用当前选中的模型。输入文字或开始新一轮对话会立即恢复正常发送键。 |
| 📁 | **回合过程折叠** | 回合结束后，过程内容（思考、工具调用、中间正文）自动收起为一行「已完成 · 时长」，总结回复保持展开；运行中不折叠 |
| 🛰️ | **语义搜索** | `context_search`：用模糊描述定位代码（Windsurf 驱动） |

### 推理折叠

部分模型（走 OpenAI 兼容接口、没有独立 `reasoning_content` 通道的）会把推理过程直接输出到正文：

~~~
用户想要了解 X，我应该先解释 Y……
</thinking>

这是对你问题的回答……
~~~

DSH 会把整段当作一块正文渲染。本插件在可配置的标记处拆开，推理部分折叠进原生 "Think" 区块，正文保持可见。在 **设置 → 通用 → Thinking Tag Markers** 里管理标记。

### Mermaid 图表

mermaid 代码块就地渲染为交互式 SVG。右上角按钮缩放与复位，滚轮缩放，鼠标或触摸拖拽平移。

### 编辑 Diff 数值

Write、Edit 行在文件路径后带上 `+N`（新增） / `-N`（删除）徽标，无需展开即可看到。编辑失败没有 diff，因此不显示徽标。

### Prompt 增强

发送按钮左侧有一个星形按钮，用输入框里当前已选的模型把粗糙草稿改写成更清晰的指令。只发一次普通 chat 请求——不创建会话，不写日志——草稿原地替换，按 Ctrl/Cmd+Z 可撤销。

请求进行中显示旋转进度环与「增强中」，完成后变绿对勾；失败时图标闪红、原因写进 tooltip，且**草稿绝不会被清空**。tooltip 使用与 DSH 原生按钮统一的 CSS 样式，还会报告上次调用实际收到了多少上下文——改写不理想时这是第一个该看的地方。

### 断点续发

当会话异常停止——用户点了**停止**或会话出错——发送按钮变为 ▶ 播放键。悬停时显示与 DSH 原生按钮统一的提示（「断点续发」）。

- **单击续跑**：通过宿主路由发送续跑信号，agent 从中断处继续，使用输入框中当前选中的模型。
- **即时恢复**：在草稿中输入文字、或 agent 开始运行时，立即恢复正常发送/停止按钮——不会卡在播放图标。
- **判定逻辑**：直接读 `session.chat.timeline` 中最后一轮已关闭 turn 的 `turn/end` 原因。只有 `aborted`（用户停止）和 `error`（会话出错）触发播放键；正常完成和 max-tokens 不触发。
- **空标记行**：续跑标记进入对话流时，插件将空白气泡 + 复制按钮替换为一条低调的「已从中断处继续」提示。
- **实现方式**：CSS 叠加——通过 `data-dsao-resume` 属性隐藏官方按钮 SVG 并注入播放 SVG，不干扰 React 重渲染周期。

### 回合过程折叠

回合运行中不做任何改动——原生的 "Deep diving…" 状态行 + 计时就是"运行中"显示。回合结束（结论落定）的瞬间，该回合的过程内容——思考行、工具调用、中间正文——自动收起为一行折叠头：**已完成 · 时长**（出错/停止的回合显示已出错/已停止）。保持可见的：你的提问、总结性回复、以及它的操作行（复制等）。点折叠头可展开看全过程，再点收起。展开/收起选择只保存在内存里，刷新页面后默认收起。

折叠计划完全由会话快照计算：轮次分组走 `chat.locations`，完成判定走 `turn/end` 原因，总结性回复由官方 `turn-tail` 节点的 `closing` 指针定位，时长取自轮次起止时间戳（与原生计时同一数字）。在 **设置 → 通用 → Turn Folding** 里开关。

### 语义搜索（`context_search`）

面向**模糊或不清晰**搜索的宿主端工具：传一句自然语言描述，即可拿到匹配文件、行范围与代码。内部跑一个 agentic 搜索循环，基于 fast-context 思路、由 Windsurf key 驱动。

**key 门控——核心设计。** 工具与其一句提示词引导**只在能解析到 Windsurf key 时才注册**。没有 key 时两者都不注册，模型因此永远不会被告知一个它调不了的工具。

key 按以下顺序解析（取第一个命中）：`WINDSURF_API_KEY` 环境变量 → 手动填写（**设置 → 通用 → Windsurf API Key**，存 `~/.dsh/dsao-windsurf-key`，权限 `0600`）→ 本地自动读取已登录的 Windsurf/Devin 编辑器 `state.vscdb`。`DSAO_FC_AUTO_KEY=0` 关闭自动读取。非官方协议提示见 `lib/fast-context/NOTICE.md`。

## 安装

```bash
dsh plugin --profile web add github:qianshe/dsh-assistant-optimization
dsh web
```

打开 http://127.0.0.1:3080 ，插件自动生效。安装、更新、卸载后都需要重启。

| | |
|---|---|
| 从本地源码 | `dsh plugin --profile web add .` |
| 更新 | `dsh plugin --profile web update dsh-assistant-optimization` |
| 卸载 | `dsh plugin --profile web remove dsh-assistant-optimization` |

## 配置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| Thinking Tag Markers | `["</thinking>"]` | 分割推理与正文的标记。支持多个。在 **设置 → 通用** 编辑。 |
| Turn Folding | 开 | 已完成回合的过程自动收起为一行「已完成 · 时长」。在 **设置 → 通用** 编辑。 |
| Windsurf API Key | — | `context_search` 的凭据。解析顺序见上。无 key 时该工具不注册。 |

## 要求

- DSH (DeepSeek Harness) web profile
- 仅 mermaid 图表需要网络，且只在出现图表时从 CDN 加载

## 开发

```bash
node test/diff-stats.test.mjs
node test/ensure-badge.test.mjs
node test/context.test.mjs
node test/prompt-enhance.test.mjs
node test/host-prompt-enhance.test.mjs
node test/resume-gate.test.mjs
node test/resume-route.test.mjs
node test/resume-continuity.test.mjs
node test/turn-fold.test.mjs
node test/fast-context-gate.test.mjs
node test/content-embed.test.mjs
node --check lib/client.js
```

测试从 `lib/client.js` / `lib/index.js` 取出真实模块。slot key、优先级、参考提取契约、失败状态码映射与完整文件结构见 [`docs/technical-reference.md`](./docs/technical-reference.md)。

## 许可证

MIT
