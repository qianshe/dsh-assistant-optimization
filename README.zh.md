# dsh-assistant-optimization

> 一个面向 [DSH](https://github.com/deepseek-ai/deepseek-harness) web profile 的插件：把误渲染进正文的推理内容折叠起来、把 mermaid 渲染成可交互 SVG、在折叠态工具行上显示文件编辑行数、用你已选的模型改写输入框草稿。

**[English](./README.md)**

## 功能

**折叠推理内容** — 部分模型（走 OpenAI 兼容接口、没有独立 `reasoning_content` 通道的）会把推理过程直接输出到正文：

```
用户想要了解 X，我应该先解释 Y……
</think>
这是对你问题的回答……
```

DSH 会把整段当作一块正文渲染。本插件在可配置的标记处拆开，推理部分折叠进 DSH 原生的 "Think" 区块，正文保持可见。

**Mermaid 图表** — `` ```mermaid `` 代码块渲染为交互式 SVG，支持缩放、拖拽、触摸。

**文件编辑 Diff 数值** — Write、Edit 行在文件路径后带上 `+10/-2`，无需展开即可看到。编辑失败没有 diff，因此不显示徽标。

**Prompt 增强** — 发送按钮左侧的星形按钮，用输入框里当前已选的模型把粗糙草稿改写成更清晰的指令。只发一次普通 chat 请求：不创建会话，不写日志。

**设置页** — 在 **设置 → 通用** 里管理分割标记。

官方渲染从不被替换。插件遮蔽官方组件后把渲染委托回去，所以 Markdown、工具卡片、图片、表格的行为与原版完全一致。

## 安装

```bash
dsh plugin --profile web add github:qianshe/dsh-assistant-optimization
dsh web
```

打开 http://127.0.0.1:3080 ，插件自动生效。安装、更新、卸载后都需要重启——两个半体都在 profile 启动时加载。

| | |
|---|---|
| 从本地源码 | `dsh plugin --profile web add .` |
| 更新 | `dsh plugin --profile web update dsh-assistant-optimization` |
| 卸载 | `dsh plugin --profile web remove dsh-assistant-optimization` |

## 使用

开箱即用，无需配置。

**推理折叠** — 模型输出 `</think>`（或你自定义的标记）后，标记前的文本折叠为 "Think" 可展开区块。

**Mermaid** — 右上角按钮缩放与复位，滚轮缩放，鼠标或触摸拖拽平移。

**Diff 数值** — `+N` 绿色表示新增行，`-N` 红色表示删除行。编辑出错时不显示。

**自定义标记** — **设置 → 通用 → Thinking Tag Markers** 可增删分割标记，不同模型用的标签不同。

**Prompt 增强** — 随手写个草稿，点星形按钮。草稿被原地替换，按 Ctrl/Cmd+Z 可撤销。草稿为空或正在提交时按钮禁用；请求进行中显示旋转进度环与「增强中」标签，完成后变绿对勾。失败时图标闪红、原因写进 tooltip，且**草稿绝不会被清空**。tooltip 还会报告上次调用实际收到了多少上下文——改写不理想时这是第一个该看的地方：

```
上次上下文：project 74 / instructions 237 (README.md) / summary 0 / asks 663 / results 420
```

### 配置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| Markers | `["</think>"]` | 分割推理与正文的标记。支持多个。存储在 `localStorage` 的 `dsao:thinking-markers` 键下。 |

## 技术原理

三个层级，每一层都是遮蔽或扩展一个查询过的 slot，而不是替换产品 UI。

### 消息层 —— 推理折叠

在 `conversation.chat.node` 的 `assistant-step` key 上以 `priority: -1` 注册，遮蔽官方渲染器（`priority: 0`）。包装组件通过 `slots.entries()` 找到该渲染器，把 `text` 块按配置的标记拆成交替的 `reasoning` + `text` 块，再用修改后的 blocks 调用官方渲染器。其余一切——ReasoningRow 折叠、Markdown、工具卡片、图片画廊——仍归官方渲染器负责。

### 工具行层 —— Diff 徽标

在 `tool.call.toolview` 的 `write` / `edit` 两个 key 上以 `priority: -1` 注册，遮蔽官方 `FileMutationRow`。这是叶子层 slot，因此包装组件不声明 children，也无需调用 `renderSlot`。

官方行渲染在 `display: contents` 容器内，徽标通过 `MutationObserver` 注入产出的 DOM。两条性质保证了它的安全：

- **幂等注入。** 当徽标已在正确位置且数值一致时，`ensureBadge` 不触碰 DOM 直接返回。缺了这一条，observer 会自触发形成渲染死循环，展开工具行时页面直接卡死。
- **清理先于锚点查找。** 官方行只在调用未失败时渲染文件链接按钮，出错的调用会把它换成错误摘要。徽标是 React 不拥有的节点，那次替换会让它变成孤儿——所以清理逻辑先执行，且从不依赖锚点仍然存在。

行数遵循官方 `diffCardModel` 契约：已结算的调用只读 `resultView`。出错的文件修改没有 diff card，因此**不会**回退去读它的 `callView`。

### 输入框层 —— Prompt 增强

`conversation.input.right` 确实存在，但它渲染在模型选择器和上下文计量之**前**，而按钮该待的位置是发送按钮的正左边——那里没有 slot。所以注册项只在该位置渲染一个隐藏锚点，向上找到装着发送按钮的 `.trailing` 容器，把一个原生 DOM 按钮插到 primary 按钮组（空闲时只有发送；运行中可中断时额外出现停止按钮）的**第一个**之前，这样按钮只会占据工具行最右侧的开头位置，绝不会夹在停止与发送之间把停止按钮挤开，落位纪律与 diff 徽标相同。

Host 半体声明 `inject: ['webServer']`，并注册一条仅限 loopback 的路由 `POST /api/dsao/prompt-enhance`。组合树里的行序**不保证服务可用性**：用 `ctx.get` 探测 `webServer` 会让插件在服务就绪前挂载，从而静默跳过注册。它通过 `ctx.agentDefaultModel.currentSelection()` 读取当前模型，发起一次 `ctx.llm.stream()`——不带工具、不带 `sessionId`、不创建会话、不写日志。返回文本经公开的 `inputActions.setDraft()` 落地，走输入状态机的正常写入路径，所以浏览器撤销依然可用。

#### 改写时模型看到什么

草稿是唯一真源。其余全部是**私有参考**：仅用于消解草稿指向何物的非输出上下文，按 broadest → most specific 排列——因为 DSH 声明 more specific instructions take precedence，且模型对靠后内容印象更强。

| 部分 | 来源 |
|---|---|
| 项目标识 | workspace title + path |
| 指令纲要 | 项目级 `AGENTS.md` 及其 `.local` 覆盖层，压成标题与规则名 |
| 会话摘要 | DSH 自己的 `CompactionSummaryNode.summary` |
| 近期用户提问 | user 回合尾巴——请求了什么 |
| 近期执行结果 | 每回合的结论回复——完成了什么 |

后两者是一对：提问记录意图，结果记录既成事实，「接着改」这类草稿缺一不可解析。

三处排除，都是为了让参考里不含任何会被改写误当作事实复述的内容：

- **全局 `~/.dsh/AGENTS.md`。** 它讲的是 agent 通用行为，不是本项目事实。DSH 用 display path 标识它。
- **规则正文。** 只提取标题与规则**名**——增强器需要的是「有哪些约束」的地图，而规则本身已经直接约束 agent。
- **agent 回复里的代码块、表格行，以及含独立数值的句子。** 瞬时字面量就住在那里。整句丢弃而非就地编辑：占位符可能被原样抄进输出，而抹掉数字会留下残句。内联反引号内容保留（脱掉反引号），因为 `ensureBadge` 或 `lib/client.js` 属于身份——那正是改写应当能够指名的东西。

`.local` 覆盖层与其共享文件并存，而非被当作重复品：它是个人的、通常被 gitignore 的那一层，DSH 两份都注入，只有去空白后内容一致时才折叠。每个目录只有一个**族**胜出——AGENTS 胜过 CLAUDE——而胜出的族会同时贡献共享文件与覆盖层。

当对话窗口已把指令上下文滚出快照，或项目根本没有指令文件时，Host 会自己按顺序读取：`AGENTS.md`、`CLAUDE.md`、`README.md`。

失败一律上报，绝不静默：服务缺失返回 503，草稿为空或超长返回 400/413，模型调用失败或无输出返回 502。响应体不是 JSON 时按状态码加正文片段上报，而不是抛出解析错误。

### 文件结构

```
├── cordis.patch.yml   # composition 层：插入插件行
├── lib/
│   ├── index.js       # Host 半体：prompt-enhance 路由
│   └── client.js      # 实际发布的浏览器产物（__ModuleLoader__.load）
├── package.json       # dsh.bundle + dsh.client 元数据
├── src/               # 模块化源码（开发参考）
│   ├── client.js      # apply() —— slot 注册
│   ├── host.js
│   └── modules/
│       ├── markers.js         # 标记存储
│       ├── text-split.js      # splitText + transformBlocks
│       ├── tool-diff.js       # diffStats + ensureBadge
│       ├── wrapper.js         # 遮蔽组件
│       ├── context.js         # 私有参考提取
│       ├── prompt-enhance.js  # 输入框按钮 + 落位
│       ├── mermaid.js         # SVG 渲染 + 缩放拖拽
│       └── settings.js        # 设置行组件
├── test/
│   ├── load-module.mjs        # 单独取出并求值一个产物模块
│   ├── dom-stub.mjs           # 最小 DOM + ToolRow 夹具
│   ├── diff-stats.test.mjs
│   ├── ensure-badge.test.mjs
│   ├── context.test.mjs
│   ├── prompt-enhance.test.mjs
│   └── host-prompt-enhance.test.mjs
└── docs/
    ├── design.md
    └── technical-reference.md  # DSH slot 与工具调用渲染技术参考
```

`lib/client.js` 是实际发布的产物：同一批模块以 `window.__ModuleLoader__.load()` 形式组装。改行为时两处都要改。

## 开发

```bash
node test/diff-stats.test.mjs          # diff 计数与出错抑制
node test/ensure-badge.test.mjs        # DOM 收敛，含 运行中 → 出错 的转换
node test/context.test.mjs             # 参考提取与各项排除
node test/prompt-enhance.test.mjs      # 按钮落位与清理
node test/host-prompt-enhance.test.mjs # inject 契约、路由守卫、模型调用
node --check lib/client.js             # 产物语法检查
```

客户端测试从 `lib/client.js` 取出真实模块，Host 测试直接 import `lib/index.js`，测的都是实际发布的代码而非另写一份实现。其中几项专门钉住那些「看似合理的改动会静默破坏」的契约：全局指令文件永不泄漏、`webServer` 注入声明必须保留而其余服务必须保持可选、以及增强器提示词不得每遇到一次失败就长出一条新规则。

## 要求

- DSH (DeepSeek Harness) web profile
- 仅 mermaid 图表需要网络，且只在出现图表时从 CDN 加载

## 许可证

MIT
