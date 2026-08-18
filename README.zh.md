# dsh-assistant-optimization

> 一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件：把模型误渲染进正文的 thinking/reasoning 内容折叠成可展开区块，并把 mermaid 代码块渲染为可交互的 SVG 图表。

**[English](./README.md)**

## 解决什么问题

部分模型（尤其是走 OpenAI 兼容接口、没有独立 `reasoning_content` 通道的）会把推理过程直接输出到正文里：

```
用户想要了解 X，我应该先解释 Y……
</thinking>
这是对你问题的回答……
```

DSH 会把整段当作普通正文渲染，推理内容和真正回答混在一起，很难读。

## 功能

1. **折叠推理内容** — 在可配置的标记处（默认 ``）把文本拆开，标记前的内容变成 DSH 原生的可折叠 "Think" 区块（ReasoningRow），标记后是正常正文。
2. **Mermaid 图表** — `` ```mermaid `` 代码块渲染为交互式 SVG，支持缩放、拖拽、触摸。
3. **设置页** — 在 **设置 → 通用** 里管理分割标记。

所有原始渲染（Markdown、工具调用、图片、表格）都由 DSH 官方渲染器完成，插件只做文本拆分。

## 安装

### 通过 `dsh plugin` 安装（推荐）

```bash
dsh plugin --profile web add github:qianshe/dsh-assistant-optimization
```

重启 web profile：

```bash
dsh web
```

打开 http://127.0.0.1:3080 ，插件自动生效。

### 从本地源码安装

```bash
git clone https://github.com/qianshe/dsh-assistant-optimization.git
cd dsh-assistant-optimization
dsh plugin --profile web add .
```

### 更新

```bash
dsh plugin --profile web update dsh-assistant-optimization
```

### 卸载

```bash
dsh plugin --profile web remove dsh-assistant-optimization
```

卸载后重启 profile 即可。

## 使用

安装后无需额外操作，插件自动工作。

- **推理折叠** — 模型输出 ``（或你自定义的标记）后，标记前的推理文本会被折叠为 "Think" 可展开区块。点击展开/收起。
- **Mermaid** — 对话中的 `` ```mermaid `` 代码块会自动渲染为 SVG 图表。右上角有缩放按钮，滚轮缩放、鼠标/触摸拖拽平移。
- **自定义标记** — 进入 **设置 → 通用 → Thinking Tag Markers**，添加或删除分割标记（不同模型用的标签可能不同）。

### 配置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| Markers | `["`](lib/client.js) | 分割推理与正文的标记。标记前的文本变成折叠区块。支持多个。 |

## 技术原理

### 渲染层包装

插件在 `conversation.chat.node` slot 注册了 `priority: -1` 的组件，覆盖官方渲染器（`priority: 0`）。渲染时：

1. 通过 `slots.entries()` 找到官方渲染器
2. 检查消息的 `data.blocks` 是否包含 `text` 块
3. 按 markers 拆分为交替的 `reasoning` + `text` 块
4. 用修改后的 blocks 调用官方渲染器

官方渲染器处理一切——ReasoningRow 折叠、Markdown 渲染、工具调用卡片、图片画廊——插件只做字符串拆分。

### 文件结构

```
├── cordis.patch.yml   # composition 层：插入插件行
├── lib/
│   ├── index.js       # Host 入口（no-op）
│   └── client.js      # 浏览器端插件（__ModuleLoader__.load 包装）
├── package.json       # dsh.bundle + dsh.client 元数据
├── src/               # 动态插件源码（开发调试用）
│   ├── host.js
│   └── client.js
└── docs/
    └── design.md      # 设计文档
```

## 要求

- DSH (DeepSeek Harness) web profile
- 网络（仅 mermaid 图表需要——从 CDN 加载 mermaid.js）

## 许可证

MIT
