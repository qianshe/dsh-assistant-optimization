# dsh-assistant-optimization

> 一个面向 [DSH](https://github.com/deepseek-ai/deepseek-harness) web profile 的插件：让模型输出更好读，让你的 prompt 更好写。

**[English](./README.md)**

## 功能

四项能力，开箱即用。官方渲染从不被替换——插件遮蔽 DSH 组件后把渲染委托回去，所以 Markdown、工具卡片、图片、表格的行为与原版完全一致。

| | 能力 | 做什么 |
|---|---|---|
| 💭 | **推理折叠** | 把误渲染进正文的推理过程折叠进原生 "Think" 区块 |
| 📊 | **Mermaid 图表** | 把 mermaid 代码块渲染成可交互 SVG（缩放 / 拖拽 / 触摸） |
| ✎ | **编辑 Diff 数值** | 在折叠态 Write、Edit 行上显示 `+10/-2`，无需展开 |
| ✨ | **Prompt 增强** | 一键把粗糙草稿改写成更清晰的指令 |
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

请求进行中显示旋转进度环与「增强中」，完成后变绿对勾；失败时图标闪红、原因写进 tooltip，且**草稿绝不会被清空**。tooltip 还会报告上次调用实际收到了多少上下文——改写不理想时这是第一个该看的地方。

### 语义搜索（`context_search`）

面向**模糊或不清晰**搜索的宿主端工具：知道某个功能"做什么"、但不知道落在哪些文件或符号上时，传一句自然语言描述，即可拿到**两段式结果——先是完整的文件列表（每文件带行范围），然后是每个文件该行范围内的完整代码**（两级字节预算内，超出部分用 read 补；列表与详情分成两个独立部分，不交替穿插）。内部跑一个 agentic 搜索循环（repo map → ripgrep/read/tree 受限命令 → 回答），基于 fast-context 思路、由 Windsurf key 驱动。返回内容就是上下文本身——没有 grep keywords、没有 config 行；`include_content: false` 可退化为纯文件列表。

**key 门控——核心设计。** 工具与其一句提示词引导**只在能解析到 Windsurf key 时才注册**。没有 key 时两者都不注册，模型因此永远不会被告知一个它调不了的工具。注入的引导刻意只有两句话（用途 + 何时该用它 + 最小调用形态），无背景、无示例——因为这段文字在每一轮都要付成本。

key 按以下顺序解析（取第一个命中）：

1. `WINDSURF_API_KEY` 环境变量
2. **手动填写**——设置 → 通用 → **Windsurf API Key**（存到 `~/.dsh/dsao-windsurf-key`，权限 `0600`），或 `PUT /api/dsao/windsurf-key`
3. **本地自动读取**——已登录的 Windsurf/Devin 编辑器的 `state.vscdb`（经 Node 内置 `node:sqlite` 读取；先拷贝快照，绝不锁住正在使用的库）

`DSAO_FC_AUTO_KEY=0` 关闭第 3 项。手动 key 的变更在下次 `dsh web` 重启后生效（工具注册发生在 profile 启动时）。key 除 4+4 预览外绝不回显。

> 非官方协议提示：搜索循环与本地 key 读取会触及 Windsurf/Devin 端点与应用数据，见 `lib/fast-context/NOTICE.md`。

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

## 配置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| Thinking Tag Markers | `["</thinking>"]` | 分割推理与正文的标记。支持多个。存储在 `localStorage` 的 `dsao:thinking-markers` 键下。在 **设置 → 通用** 编辑。 |
| Windsurf API Key | — | `context_search` 的凭据。优先级：`WINDSURF_API_KEY` 环境变量 → 手动填写（**设置 → 通用 → Windsurf API Key**，存 `~/.dsh/dsao-windsurf-key`）→ 本地 Windsurf/Devin 自动读取。无 key 时该工具不注册。`DSAO_FC_AUTO_KEY=0` 关闭自动读取。 |

## 技术原理

每项能力都是遮蔽一个 DSH 渲染 slot 后委托回官方渲染器——不替换任何产品 UI。

- **推理折叠**包装助手消息渲染器，把 `text` 块按配置标记拆成交替的 `reasoning` + `text` 块，其余交还 DSH。
- **编辑 Diff 数值**包装文件改动工具行，基于 DSH 自己的 diff 模型注入 `+N/-N` 徽标；出错的编辑没有徽标。
- **Prompt 增强**在输入框锚定一个按钮，暴露一条仅限 loopback 的路由（`POST /api/dsao/prompt-enhance`），用当前模型结合草稿和项目/会话上下文（作为私有参考）做一次调用，结果经正常输入路径写回，所以撤销依然可用。
- **语义搜索**注册一个宿主端工具（`context_search`）加一句提示词段，**且两者都只在能解析到 Windsurf key 时**（环境变量 → 手动文件 → 本地自动读取）才注册。工具在 `lib/fast-context/` 内跑 agentic 循环（repo map → ripgrep/read/tree 受限命令 → 回答）；当 Windsurf 侧中途失败时，自动降级到本地部署模型。结果格式化在 `content-embed.js`：输出分两个独立部分——先完整文件列表（每文件带行范围），后各文件行范围内的完整代码（无行级硬上限，两级字节预算：总量 / 每文件，env 可调；预算截断时尾部出 marker 提示用 read 补）。格式化时从磁盘重读，缓存命中也是新鲜内容；文件缺失、二进制、预算耗尽都退化为 marker 行，绝不使搜索本身失败。prompt-enhance 路由对该工具钉死 `include_content: false`（其改写策略不允许把代码带进 prompt）。

slot key、优先级、参考提取契约与失败状态码映射见 [`docs/technical-reference.md`](./docs/technical-reference.md)。

### 文件结构

~~~
├── cordis.patch.yml   # composition 层：插入插件行
├── lib/
│   ├── index.js       # Host 半体：prompt-enhance 路由 + windsurf-key 路由 + 工具注册
│   ├── client.js      # 实际发布的浏览器产物（__ModuleLoader__.load）
│   └── fast-context/  # 语义搜索工具（MIT 移植，见 NOTICE.md）
│       ├── tool.js        # key 门控注册 + 最小提示词段
│       ├── key-source.js  # 环境变量 → 手动文件 → 本地自动读取
│       ├── core.js        # 搜索循环（brain 抽象 + A→B 降级）
│       ├── windsurf.js    # Windsurf Devstral 协议（brain A）
│       ├── brain-llm.js   # 本地部署模型（brain B）
│       ├── executor.js    # 受限命令（rg/readfile/tree/ls/glob）
│       ├── extract-key.js # 本地 state.vscdb 读取（node:sqlite）
│       ├── content-embed.js # 结果格式化：显式文件列表 + 预算内嵌入代码
│       └── …              # protocol / path-safety / repair / cache / shared
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
│   ├── host-prompt-enhance.test.mjs
│   ├── fast-context-gate.test.mjs
│   └── content-embed.test.mjs
└── docs/
    ├── design.md
    └── technical-reference.md  # DSH slot 与工具调用渲染技术参考
~~~

`lib/client.js` 是实际发布的产物：同一批模块以 `window.__ModuleLoader__.load()` 形式组装。改行为时 `src/` 与 `lib/` 两处都要改。

## 开发

```bash
node test/diff-stats.test.mjs          # diff 计数与出错抑制
node test/ensure-badge.test.mjs        # DOM 收敛，含 运行中 → 出错 的转换
node test/context.test.mjs             # 参考提取与各项排除
node test/prompt-enhance.test.mjs      # 按钮落位与清理
node test/host-prompt-enhance.test.mjs # inject 契约、路由守卫、模型调用
node test/fast-context-gate.test.mjs   # key 门控：无 key ⇒ 无工具、无提示词
node test/content-embed.test.mjs       # 结果格式化：预算嵌入、marker 回退、无噪声行
node test/host-prompt-enhance.test.mjs # inject 契约、路由守卫、模型调用
node --check lib/client.js             # 产物语法检查
```

测试从 `lib/client.js` / `lib/index.js` 取出真实模块，而非另写一份实现。

## 要求

- DSH (DeepSeek Harness) web profile
- 仅 mermaid 图表需要网络，且只在出现图表时从 CDN 加载

## 许可证

MIT
