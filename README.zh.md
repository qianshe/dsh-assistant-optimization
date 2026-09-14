# dsh-assistant-optimization

> 一个面向 [DSH](https://github.com/deepseek-ai/deepseek-harness) web profile 的插件：让模型输出更好读，让你的 prompt 更好写。

**[English](./README.md)**

## 功能

八项能力，开箱即用。官方渲染从不被替换——插件遮蔽 DSH 组件后把渲染委托回去，所以 Markdown、工具卡片、图片、表格的行为与原版完全一致。

| | 能力 | 做什么 |
|---|---|---|
| 💭 | **推理折叠** | 把误渲染进正文的推理过程折叠进原生 "Think" 区块 |
| 📊 | **Mermaid 图表** | 把 mermaid 代码块渲染成可交互 SVG（缩放 / 拖拽 / 触摸） |
| ✎ | **工具调用分组** | 连续工具调用收成一行「# bash · N 个工具」；中间夹思考行不打断分组——跨思考行合并，折叠态思考行随组收起、展开态与成员同款缩进 |
| ✨ | **Prompt 增强** | 一键把粗糙草稿改写成更清晰的指令 |
| ▶ | **断点续发** | 手动中断或会话出错后，发送键变为播放键——悬停显示提示，单击从断点续跑，使用当前选中的模型。输入文字或开始新一轮对话会立即恢复正常发送键。 |
| 📁 | **回合过程折叠** | 回合结束后，过程内容（思考、工具调用、中间正文）自动收起为一行「已完成 · 时长」，总结回复保持展开；运行中不折叠。中断续跑的多段回合归并为一个组，运行中插话随组收起并显示「· N 条插话」；插件接管内置转写模式避免双重折叠 |
| 🛰️ | **语义搜索** | `context_search`：用模糊描述定位代码（Windsurf 驱动） |
| 🧹 | **归档会话清理** | 把归档藏起来的会话列出来、按勾选释放磁盘，也能取消归档——一键完成，不用停宿主，不用手改 JSON |

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

### 编辑 Diff 数值（已退役）

dsh 0.1.2+ 的官方 Write、Edit 行原生渲染 diff 统计，插件自己的徽标自 v1.8.0 起退役。模块保留以兼容旧版 host，但在当前版本上不再注册任何内容。

### Prompt 增强

发送按钮左侧有一个星形按钮，用输入框里当前已选的模型把粗糙草稿改写成更清晰的指令。只发一次普通 chat 请求——不创建会话，不写日志——草稿原地替换，按 Ctrl/Cmd+Z 可撤销。

请求进行中显示旋转进度环与「增强中」，完成后变绿对勾；失败时图标闪红、原因写进 tooltip，且**草稿绝不会被清空**。tooltip 使用与 DSH 原生按钮统一的 CSS 样式，还会报告上次调用实际收到了多少上下文——改写不理想时这是第一个该看的地方。

### 断点续发

当会话异常停止——用户点了**停止**或会话出错——发送按钮变为 ▶ 播放键。悬停时显示与 DSH 原生按钮统一的提示（「断点续发」）。

- **单击续跑**：通过宿主路由发送续跑信号，agent 从中断处继续，使用输入框中当前选中的模型。
- **即时恢复**：在草稿中输入文字、或 agent 开始运行时，立即恢复正常发送/停止按钮——不会卡在播放图标。
- **判定逻辑**：直接读 `session.chat.timeline` 中最后一轮已关闭 turn 的 `turn/end` 原因。`aborted`（用户停止）、`error`（会话出错）、`max-tokens`（截断）与 `interrupted`（dsh-session 崩溃修复合成的终态）触发播放键——与宿主路由的 `RESUME_TERMINAL_KINDS` 同集；正常完成及其他终态不触发。`running` 位只有在时间线佐证（存在 open turn）时才拦截：时间线全闭 + running=true 是陈旧位（宿主崩溃残留），此时落到终态判定，让崩溃过的会话能被 ▶ 唤醒，而不是永远卡在「运行中不可操作」。
- **空标记行**：续跑标记进入对话流时，插件将空白气泡 + 复制按钮替换为一条低调的「已从中断处继续」提示。
- **实现方式**：CSS 叠加——通过 `data-dsao-resume` 属性隐藏官方按钮 SVG 并注入播放 SVG，不干扰 React 重渲染周期。

### 回合过程折叠

**覆盖官方折叠。** dsh 0.1.2+ 自带回合过程折叠（设置 → 对话显示 → Compact）。本插件现在会接管该设置：这里开启回合折叠时，官方模式被强制为 Normal，只有插件自己的折叠（时长 + 插话计数、断点链合并）生效；这里关闭则交还给官方 Compact。两边任意切换都会重新对齐。

回合运行中不做任何改动——原生的 "Deep diving…" 状态行 + 计时就是"运行中"显示。回合结束（结论落定）的瞬间，该回合的过程内容——思考行、工具调用、中间正文——自动收起为一行折叠头：**已完成 · 时长**（出错/停止的回合显示已出错/已停止）。运行中插入的插话（steering）随组收起，折叠头会显示「· N 条插话」。保持可见的：你的提问、总结性回复、以及它的操作行（复制等）。点折叠头可展开看全过程，再点收起。展开/收起选择只保存在内存里，刷新页面后默认收起。

折叠计划完全由会话快照计算：轮次分组走 `chat.locations`，完成判定走 `turn/end` 原因，总结性回复由官方 `turn-tail` 节点的 `closing` 指针定位，时长取自轮次起止时间戳（与原生计时同一数字）。在 **设置 → 通用 → Turn Folding** 里开关。

### 语义搜索（`context_search`）

面向**模糊或不清晰**搜索的宿主端工具：传一句自然语言描述，即可拿到匹配文件、行范围与代码。内部跑一个 agentic 搜索循环，基于 fast-context 思路、由 Windsurf key 驱动。

**key 门控——核心设计。** 工具与其一句提示词引导**只在能解析到 Windsurf key 时才注册**。没有 key 时两者都不注册，模型因此永远不会被告知一个它调不了的工具。

key 按以下顺序解析（取第一个命中）：`WINDSURF_API_KEY` 环境变量 → 手动填写（**设置 → 通用 → Windsurf API Key**，存 `~/.dsh/dsao-windsurf-key`，权限 `0600`）→ 本地自动读取已登录的 Windsurf/Devin 编辑器 `state.vscdb`。`DSAO_FC_AUTO_KEY=0` 关闭自动读取。非官方协议提示见 `lib/fast-context/NOTICE.md`。

### 归档会话清理

dsh 0.1.2 里「归档」只是隐藏：归档集合是一个显示过滤器，被归档的会话会同时从分组列表、扁平列表**和**搜索里消失，而它的会话正文、投影缓存行、工作区记账一分不少地留在 `~/.dsh` 下。整个 GUI 没有任何「取消归档」入口，持久层也没有删除 API——官方 README 把它写成「带外维护（out-of-band backend maintenance）」。于是磁盘上出现一片既看不见、也找不回、更没法清的死角。

**设置 → 归档会话** —— 设置导航里的独立分区（不塞在通用设置下面：这是一整页操作流程，不是一条偏好开关）—— 会扫描归档名单，逐条给出：标题（取自客户端会话列表）、所属项目、正文路径、大小、最后写入时间。然后可以：

- **删除已选** —— 解除全部正文代际文件（JSONL 后端会在同一目录保留 `session.jsonl[.zstd]` 与 `session.vN.jsonl[.zstd]`；只删当前代际的话，重启后旧代际会重新成为最新正文，会话又从「未分组」里冒出来）、删除投影缓存行、把工作区记账里的该会话摘掉、广播 `api-session/removed` 让所有已打开的 GUI 立即摘掉侧栏行（不再残留到「未分组」、不再挂着陈旧的「运行中」状态点）、最后清掉归档条目。两步确认：第一次点击让按钮进入待确认态，第二次才真删。**不可逆**——正文就是那段历史的唯一副本，所以每行同时提供**导出**链接（复用官方 `session.export` 路由），可以先拿走 ZIP 再删。
- **取消归档已选** —— 只把 id 写回归档名单之外。文件一字不动，侧栏里立刻回来。这就是官方缺的那个「取消归档」。
- **全选可删** —— 只选中守卫允许的那些。
- **强制模式**（开关，仅在宿主暴露 agents 注册表时出现）—— 解锁仍然**常驻**的归档会话：运行中的先走官方停止键同一个 `agent.cancel`（排队输入一并丢弃），等它静默（settle）之后才删除。等不到静默的会话直接拒绝（`not-settled`）而**不会在其活写入者下面 unlink**——JSONL 后端按批打开正文文件，未静默的 writer 下次 flush 会重建半截文件。当前正在查看的会话在任何模式下都不可勾选。

这里碰不到任何你没归档的会话：候选列表完全由归档名单驱动，未归档的 id 会被拒（`not-archived`）——**force 也越不过这条授权边界**，被拒的会话连 cancel 都不会发生。常驻会话必须开强制模式才会出现在候选里，并按宿主的真值源细分为 `running`（代理正在执行）与 `attached`（常驻但空闲）——上一版把两者混叫 `live-session` 一律拦下，正是"空闲常驻被误标运行中、删不掉"的根源。路径不符合 `<root>/<项目>/<session-id>/session(.vN)?.jsonl[.zstd]` 已记载布局的正文一律不动。删除会 unlink 目录里的全部正文代际文件（`session.jsonl[.zstd]` 与任何 `session.vN.jsonl[.zstd]`），会话目录仅在删完为空时才移除——整个功能没有递归删除。

**不用停宿主**就能做。在 host 外面改 `~/.dsh/storages/workspace.json` 是不安全的：JSON 的 `single` 布局内存权威、每次写整体重写、且无跨进程锁；但在 host 进程内，这些事实是通过各 owner service 自己的串行写链拿到的，内存与磁盘同步移动，workspace 的 follow 流会重发归档集合——已经打开的 GUI 标签页不用刷新就更新。两处需要碰私有字段（归档名单没有公开的可写入口，投影缓存 table 是服务内部句柄）：两者都是调用时探测，拿不到就如实降级报告，不猜路径、不崩。

这一页只用宿主自己的 `--dsw-alias-*` 设计令牌说话——不写死任何颜色，所以浅色/深色主题都跟着外壳走；四种状态全部建模：扫描中的骨架行、明确的空态、可重试的错误横幅、以及"只有零拒绝零失败才用成功语气"的结果条。交互态（`hover`、`focus-visible`、`disabled`、表头 sticky、`prefers-reduced-motion`）放在一段带 id 的作用域样式里而不是 inline style——因为这些状态 inline 表达不了。规则与理由见 [`docs/technical-reference.md`](./docs/technical-reference.md) §11.7。

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
node test/turn-fold-sync.test.mjs
node scripts/repro-switch-back.cjs
node scripts/lib-sync-check.cjs
node scripts/build-client.cjs verify
node --check lib/client.js
```

测试从 `lib/client.js` / `lib/index.js` 取出真实模块。 `lib/client.js` 是构建产物：改 `src/` 后运行 `node scripts/build-client.cjs build` 重新生成，不要手改。slot key、优先级、参考提取契约、失败状态码映射与完整文件结构见 [`docs/technical-reference.md`](./docs/technical-reference.md)。

## 许可证

MIT
