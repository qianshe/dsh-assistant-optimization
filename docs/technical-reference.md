# DSH 客户端插件技术参考

> 本文档基于 `dsh-assistant-optimization` 插件的开发和调试过程，整理 DSH 客户端插件体系的核心机制，作为后续开发新能力的技术参考。

---

## 1. DSH 客户端架构概览

```
DSH 进程 (Node.js)
├── Host 半体 — 服务端能力（文件、网络、命令、RPC handler）
│   └── 通过 harness.handle(method, handler) 注册 JSON RPC
│
└── Web GUI (浏览器)
    └── Agent 会话 Client 半体
        ├── Cordis 插件系统
        │   ├── Service 层（slots, harness, locale, session…）
        │   ├── Event 层（node change, session lifecycle…）
        │   └── Slot 渲染层（<SlotOutlet> 组合渲染）
        └── React 渲染器 (scoped-slots.tsx)
```

**关键架构决策**：Cordis 是"能力组合"系统，而非传统 MVC。每个功能是一个插件（plugin），插件注册到 **Slot**（插槽），Slot 在运行时按优先级排序渲染。

---

## 2. Slot 系统（核心）

### 2.1 什么是 Slot

Slot 是 DSH 的声明式 UI 扩展点。类似 React 插槽 / Web Component 的 `<slot>`，但更强大：

- **命名**：`name` 是完整的 slot 标识（如 `conversation.chat.node`）
- **种类**：`kind` 可选 `single` / `keyed` / `list` / `chain`
- **作用域**：`scope` 可选 `root` / `session`（session-scoped 的 slot 只在会话生命周期内存在）
- **优先级（priority）**：同一 slot 的多个 occupant 按 priority 升序排序，**低 priority 胜出渲染**

### 2.2 Slot 种类

| 种类 | 说明 | 常用场景 |
|------|------|----------|
| `single` | 单 occupant，优先级最低的渲染 | 简单覆盖 |
| `keyed` | 按 key 分组的多个 occupant，每个 key 最低优先级渲染 | 消息节点类型（assistant-step、tool-call）、工具视图（write/edit/bash） |
| `list` | 按 id 排序的列表，所有 id 都渲染 | 设置页面项、侧边栏项 |
| `chain` | 链式选择，selector 匹配则渲染 | 复杂路由 |

### 2.3 Slot 注册

```js
ctx.slots.register({
  name: 'slot.name',       // 完整的 slot 路径
  key: 'entry-key',        // keyed 时必填
  id: 'list-id',           // list 时必填
  priority: 0,             // 默认 0；低优先胜出
  locale: 'conversation',  // 国际化命名空间
  children: {              // 声明子 slot（可选）
    'child.slot': { kind: 'keyed', scope: 'session' },
  },
}, ComponentFunction)
```

### 2.4 优先级规则（最重要）

```
priority: -1  <  priority: 0  <  priority: 1
  胜出            失败            失败
```

**关键**：`keyed` slot 中，每个 key 的所有 occupant 按 priority 升序排序，**最低的渲染**。所以 `priority: -1` 会 shadow 官方的 `priority: 0`。

### 2.5 安全注入（slots.inject）

```js
ctx.slots.inject('target.slot', function () {
  return ctx.slots.register({ … }, Component)
})
```

`slots.inject` 确保在 slot 声明存在后才注册，disposer 随注入者的上下文生命周期自动清理。

---

## 3. 消息节点渲染管线（conversation.chat.node）

这是整个会话消息渲染的核心 slot。

### 3.1 Slot 结构

```
conversation.chat.node (keyed slot, scope: session)
  children:
    tool.call.toolview (keyed slot, scope: session)
```

### 3.2 注册的 key（官方 + 插件）

| key | 官方 priority | 插件 priority | 说明 |
|-----|--------------|--------------|------|
| `assistant-step` | 0 | -1（插件 wrapper） | 助手消息（文本 + 推理 + 工具调用） |
| `tool-call` | 0 | -1（插件 wrapper） | 工具调用树（旧版方式，现已弃用） |
| 其他 | 0 | — | 用户消息、系统消息等 |

### 3.3 渲染流程

```
ChatConversationViewNode
  └─ renderSlot('conversation.chat.node', owner, { entryKey: kind })
       ├─ key = 'assistant-step' → priority -1 胜出 → 插件 wrapper
       │    └─ 插件 wrapper 渲染官方 priority 0 组件
       │         └─ 内部渲染 text / reasoning / tool-call 等 blocks
       │
       ├─ key = 'tool-call' → priority -1 胜出 → 插件 wrapper（旧版）
       │    └─ 内部渲染 ToolCallTree
       │         └─ renderSlot('tool.call.toolview', owner, { entryKey: toolName })
       │              ├─ key = 'write'  → FileMutationRow
       │              ├─ key = 'edit'   → FileMutationRow
       │              ├─ key = 'read'   → ReadRow
       │              ├─ key = 'bash'   → BashRow
       │              └─ 其他 → GenericToolCard (fallback)
       │
       └─ 其他 key → 官方渲染
```

### 3.4 重要：新式工具调用路由

**DSH 新架构下，`tool-call` 节点不再经过 `conversation.chat.node` 的 keyed slot**，而是作为 `assistant-step` 节点内部的 `tool.call.toolview` 子 slot 渲染。这意味着：

- **拦截 `tool-call` key（旧版 wrapper）在新版消息中可能不生效**——因为工具调用已嵌入 assistant-step 内部
- 正确拦截工具视图的方式是**注册到 `tool.call.toolview` 子 slot**（如 `dsao-1` 动态插件所做）

---

## 4. 工具调用视图（tool.call.toolview）

### 4.1 Slot 属性

```
tool.call.toolview (keyed, scope: session)
  OwnerProps: ToolCallViewProps
    - callId: string
    - toolName: string
    - block: ToolCallBlock
    - openFile: (path: string) => void
    - cwd: string
    - inspect: () => void
```

### 4.2 已注册的 key

| key | 组件 | 插件来源 |
|-----|------|---------|
| `write` | `FileMutationRow` | `file-mutation-toolview` |
| `edit` | `FileMutationRow` | `file-mutation-toolview` |
| `read` | `ReadRow` | `read-toolview` |
| `bash` | `BashRow` | `bash-toolview` |
| `search` | `SearchRow` | `search-toolview` |
| `web` | `WebRow` | `web-toolview` |
| `todo` | `TodoRow` | `todo-toolview` |
| `ask_question` | `AskQuestionRow` | `ask-question-toolview` |

### 4.3 ToolCallBlock 数据结构

```typescript
// 运行中（未完成）
interface RunningCall {
  name: string
  callId: string
  callView: { card: 'diff', diffs: Hunk[] } | { card: 'text', text: string }
  argsRaw: string
  subCalls: ToolCallBlock[]
}

// 已结束（有结果）
interface SettledCall {
  call: { name: string, argsRaw: string }
  callId: string
  resultView: { card: 'diff', diffs: Hunk[] } | { card: 'text', text: string }
  subCalls: ToolCallBlock[]
}

// Hunk (diff 块)
interface Hunk {
  path: string
  oldText: string | null
  newText: string
}
```

### 4.4 FileMutationRow 渲染结构

```
FileMutationRow
  └─ ToolRow
       └─ DisclosureRow (CSS: .row, data-disclosure-row, data-expandable)
            ├─ leading: IconEditOutline16
            ├─ title: "Write" | "Edit"
            ├─ collapsedContent: button.fileLink → "path/to/file.txt"
            │     └─ flex: 1 1 auto; min-width: 0; overflow: hidden;
            │        text-overflow: ellipsis; white-space: nowrap;
            └─ children (展开时): DiffBlock
                 └─ hunk lines (diff)
                 └─ footer: "└ +A -R · N file(s)"
```

---

## 5. 文件编辑 Diff 徽章（我们的实现）

### 5.1 方案演进

| 版本 | 注册点 | 优先级 | 问题 |
|------|--------|--------|------|
| **v1 (debug-1)** | `conversation.chat.node` key `tool-call` | `priority: 1` | ❌ priority 1 > 0，从不渲染 |
| **v1 (debug-2/3)** | `conversation.chat.node` key `tool-call` | `priority: -1` | ❌ 声明 children 与官方冲突 |
| **v1 (debug-4)** | `tool.call.toolview` key `write/edit` | `priority: -1` | ❌ 卡死（MutationObserver 自触发） |
| **v3** | `tool.call.toolview` key `write/edit` | `priority: -1` | ⚠️ 稳定但出错的调用也显示徽章 |
| **v4 (final)** | `tool.call.toolview` key `write/edit` | `priority: -1` | ✅ 稳定 + 幂等 + 出错抑制 |

### 5.2 最终方案

```
注册点: tool.call.toolview → key 'write' / 'edit', priority -1
组件: 叶子层（不声明 children→无需 renderSlot）
      包装官方 FileMutationRow（display:contents wrapper）
      挂 MutationObserver 检测文件链接出现后插入徽章

MutationObserver 收敛保证（核心）：
  1. ensureBadge 幂等：fileLink.nextElementSibling 已是徽章
     且 title 签名一致 → 0 DOM 改动早退
  2. 不观察 characterData（只观察 childList + subtree）
  3. 只有徽章缺失或数值变化时才有一次删除+插入操作，之后收敛到稳态
```

### 5.3 行数来源与出错抑制

行数取自 block 的 diff 渲染意图，必须与官方 `diffCardModel` 完全一致：

```js
// 官方 dsh-client-ui-tool/lib/client.js
function diffCardModel(block) {
  if (!("kind" in block)) {                                    // 运行中
    const call = block.callView?.card === "diff" ? block.callView : null
    ...
  }
  const result = block.resultView?.card === "diff" ? block.resultView : null   // 已结算：只读 resultView
  ...
}
```

关键契约（官方 `file-mutation-row.d.ts` 明确写出）：

> An errored mutation has no diff card, so ToolRow surfaces the model-facing
> error text through its Output section and its first line in the collapsed
> summary instead.

因此已结算的调用**不能**回退到 `callView`——`callView` 描述的是"打算改什么"，编辑失败时它依然存在，把它当结果会渲染出不存在的变更。

```js
function diffView(block) {
  if ('kind' in block) {
    if (block.isError) return null      // 出错 → 无 diff card
    return block.resultView || null     // 不回退 callView
  }
  return block.callView || null         // 运行中：callView 是唯一来源
}
```

### 5.4 陷阱：运行中→出错 的残留徽章

出错的行在 DOM 上是**另一种结构**。官方 `ToolRow` 只在 `failureLine === null` 时渲染 `button.fileLink`：

```js
// 官方 ToolRow
const failureLine = state === "error" ? errorSummary ?? null : null;
const fileLink = filePath !== void 0 && onOpenFile !== void 0 && failureLine === null;
// fileLink ? <button className={fileLink}> : <span className={summary errorSummary}>
```

流式期间调用尚未出错，`fileLink` 存在，徽章被注入。调用转为出错后 React 把 `button.fileLink` 换成 `span.errorSummary`——但徽章是 React 不认识的额外节点，**不会被这次 re-render 移除**。

如果 `ensureBadge` 先查 fileLink、查不到就早退，残留徽章就再没有人清除。这正是"实时流里出错的 edit 仍有 +/-，切走再回来就没有了"的原因：切换会话触发整棵子树重新挂载，新 DOM 从一开始就没有徽章。

修正：**清理必须先于 fileLink 查找**。

```js
function ensureBadge(container, block) {
  if (!container || !container.querySelectorAll) return
  var stats = block ? diffStats(block) : null
  var link = container.querySelector('[class*="fileLink"]')
  var olds = container.querySelectorAll('[data-dsao-diff-badge]')

  if (!stats || !link || !link.parentNode) {   // 无 diff 或已无 fileLink → 清残留
    for (var k = 0; k < olds.length; k++) {
      if (olds[k].parentNode) olds[k].parentNode.removeChild(olds[k])
    }
    return
  }
  ...
}
```

一般规律：**往官方渲染的 DOM 注入额外节点时，注入路径与清理路径必须独立**。清理不能依赖注入时的锚点仍然存在，因为官方组件可以在状态转换时把那个锚点整个换掉。

### 5.5 徽章样式

```css
[data-dsao-diff-badge] {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  margin-left: 6px;
  flex: none;
  white-space: nowrap;
  font-size: 12px;
  line-height: 24px;
  font-weight: 600;
}
/* 加号：绿色  var(--dsw-alias-state-success-primary, #16a34a) */
/* 减号：红色  var(--dsw-alias-state-error-primary, #dc2626) */
```

---

## 6. 推理标签折叠（Thinking Tag / Reasoning Fold）

### 6.1 方案

```
注册点: conversation.chat.node → key 'assistant-step', priority -1
组件: WrappedAssistantStep
  ┌─ 获取官方 assistant-step 组件（priority 0 occupant）
  ├─ 从 localStorage 读取用户配置的标记列表（默认 ["</think>"]）
  ├─ 遍历 node.data.blocks
  │   ├─ text 块 → splitText(markers) → 分割为 reasoning + text 交替块
  │   │   └─ 分割点前的文本 → kind: "reasoning"
  │   │   └─ 分割点后的文本 → kind: "text"
  │   └─ 非 text 块 → 原样保留
  └─ 调用官方组件渲染修改后的 blocks
      官方 DSH 遇到 kind: "reasoning" 块 → 自动渲染为折叠的 ReasoningRow
```

### 6.2 数据流

```
用户设置
  │  localStorage.setItem('dsao:thinking-markers', [...])
  │  window.dispatchEvent(new Event('dsao:markers-changed'))
  ▼
Settings页面 (TagsSetting)
  │  slot: settings.general.item, id: 'thinking-tags'
  ▼
WrappedAssistantStep
  │  React.useState(loadMarkers())
  ├─ 初始渲染时读取 localStorage
  └─ 监听 'dsao:markers-changed' 事件同步更新
  ▼
transformBlocks(blocks, markers)
  │  text 块 → splitText(text, markers)
  │    └─ 遍历文本找到第一个标记位置
  │    └─ 标记前 → { kind: 'reasoning', text: '...' }
  │    └─ 标记后 → { kind: 'text', text: '...' }
  ▼
官方 assistant-step 组件
  └─ kind: 'reasoning' → ReasoningRow 折叠
  └─ kind: 'text' → 正常 Markdown 渲染
```

### 6.3 Host RPC（thinking-tags）

```js
// Host 半体（src/host.js）
harness.handle('thinking-tags/get', async () => ({ markers }))
harness.handle('thinking-tags/add', async (args) => { /* 添加标记 */ })
harness.handle('thinking-tags/remove', async (args) => { /* 移除标记 */ })
```

**注意**：当前静态插件（`lib/client.js`）在 Client 端用 localStorage 存储标记，未使用 Host RPC。这导致标记只在当前浏览器页面有效，不会跨设备同步。Host RPC 是为未来扩展预留的。

---

## 7. 动态插件 vs 静态插件对比

| 维度 | 动态插件（cordis_define） | 静态插件（lib/client.js） |
|------|--------------------------|--------------------------|
| 生命周期 | 当前会话，重启后丢失 | 随 dsh web 启动自动加载 |
| 注册方式 | `cordis_define` + `cordis_run` | `__ModuleLoader__.load` bundle |
| 代码形态 | 纯 JS 函数体字符串（无 module 系统） | `__ModuleLoader__.load` 注册 module |
| 调试速度 | 极快（无需重启） | 需重启 dsh web |
| 适用阶段 | 开发调试 | 发布部署 |

### 7.1 动态插件注意事项

1. **函数体是纯 JS**：无 TypeScript / JSX / import / require
2. **React 用全局 `React.createElement`**，不能用 JSX
3. **`ctx.get('serviceName')`** 读取可选服务，需检查 undefined
4. **`slots.inject`** 确保 slot 声明存在后才注册
5. **`slots.register` 的 disposer** 自动由插件上下文管理
6. **MutationObserver 必须幂等**，避免自触发反馈环

### 7.2 静态插件构建

```bash
# 打包
dsh plugin build --profile web D:\myProject\tools\dsh-assistant-optimization
# 安装
dsh plugin --profile web add .
# 更新
dsh plugin --profile web update dsh-assistant-optimization
```

---

## 8. 开发新能力的工作流

### 8.1 第一步：确定 Slot 位置

```js
// 查询所有可用 slot
cordis_inspect_query('client', 'Slot', 'listSubTree')
// 查询特定 slot 的注册协议
cordis_inspect_query('client', 'Slot', 'listSubTree', { root: 'conversation.chat.node' })
// 查询服务
cordis_inspect_query('host', 'Service', 'listService')
```

### 8.2 第二步：选择注册策略

- **拦截已有组件的渲染** → 同 slot 同 key，`priority: -1`
- **添加新的 UI 项** → 合适的 list slot（如 `settings.general.item`）
- **添加新的工具视图** → `tool.call.toolview`，工具名作为 key
- **从 Client 调用 Host 能力** → `harness.handle` + `host.call`

### 8.3 第三步：动态插件开发

```js
// 1. 定义
cordis_define({
  plugin: { kind: 'new', idPrefix: 'mypl' },
  name: 'my-feature',
  purpose: '描述',
  code: {
    client: 'function apply(ctx) { /* 纯 JS */ } return { apply }',
    host: 'function apply(ctx) { /* 纯 JS */ } return { apply }',
  },
})
// 2. 运行
cordis_run({ pluginId, packageId, mode: 'run' })
// 3. 验证 → 如果失败，读取诊断
cordis_inspect_self({ pluginId, packageId })
// 4. 修复 → 定义新 Package
cordis_define({ plugin: { kind: 'existing', pluginId }, name, code, purpose })
// 5. 更新
cordis_run({ pluginId, packageId, mode: 'update' })
```

### 8.4 第四步：固化为静态插件

```bash
# 1. 将动态插件代码手工整合到 src/modules/ 下对应模块
# 2. 同步更新 lib/client.js 中的内联代码
# 3. 运行 dsh plugin build 验证
# 4. 重启 dsh web 确认生效
```

---

## 9. 常见陷阱

### 9.1 Slot 儿童声明冲突

```
❌ 插件在 conversaton.chat.node 注册 key 'tool-call' 时声明 children
   → 官方已声明 children: { 'tool.call.toolview' }
   → slots.register 抛出: "slot 'tool.call.toolview' already declared by ..."

✅ 叶子层组件：不声明 children，只渲染官方组件 + 附加 DOM 操作
```

### 9.2 renderSlot 缺失

```
❌ 在 conversation.chat.node 注册 key 'tool-call' 时不声明 children
   → 渲染机器不注入 renderSlot 到该组件 props
   → 官方 ToolCallTree 内部调用 props.renderSlot(...) 崩溃

✅ 叶子层组件仅在 tool.call.toolview 注册，不需要 renderSlot
```

### 9.3 优先级方向

```
❌ priority: 1 → 永远不会渲染（官方 priority 0 胜出）
✅ priority: -1 → 胜出渲染（最低优先胜出）
```

### 9.4 MutationObserver 自触发

```
❌ observer 回调修改 DOM → 产生新的 childList 记录 → 递归触发 → 无限循环卡死
✅ 幂等回调：检查 DOM 是否已满足 → 零改动早退 → 收敛到稳态
```

### 9.5 注入的 DOM 节点在状态转换后残留

```
❌ 清理逻辑依赖注入时的锚点（如 fileLink）仍然存在
   → 官方组件在 running → error 转换时把锚点换成另一个元素
   → 早退，残留节点永远清不掉（切换会话重新挂载后才"自愈"）
✅ 清理路径独立于注入路径：先清理，再决定是否注入
```

### 9.6 已结算调用回退读 callView

```
❌ resultView || callView
   → 出错的调用 resultView 为 null，但 callView 仍描述意图中的操作
   → 渲染出实际并未发生的变更
✅ 已结算只读 resultView，并先查 isError（与官方 diffCardModel 一致）
```

### 9.7 动态插件重启丢失

```
❌ 依赖动态插件持久化功能
✅ 功能验证通过后立即固化为静态插件（lib/client.js）
```

### 9.8 测试另写一份实现

```
❌ 测试里复制一遍 diffStats/ensureBadge 逻辑
   → 产物改了测试还绿
✅ 从 lib/client.js 中提取真实模块工厂求值（test/load-module.mjs）
```

---

## 10. 已知 Slot 注册表

| slot 名称 | kind | 用途 | 常用 key |
|-----------|------|------|----------|
| `conversation.chat.node` | keyed | 消息节点渲染 | `assistant-step`, `tool-call` |
| `tool.call.toolview` | keyed | 工具视图 | `write`, `edit`, `read`, `bash`, `search`, `web`, `todo` |
| `settings.general.item` | list | 设置页通用设置项 | `thinking-tags` 等 |
| `conversation.details.tool` | single | 工具详情面板 | — |

---

## 附录：关键 DSH 源码参考

```
packages/client/ui-slots/src/index.ts       — Slot 核心实现
packages/client/web-react/src/scoped-slots.tsx — Slot React 渲染器
packages/client/ui-tool/src/client/apply.ts  — 工具视图注册入口
packages/client/ui-tool/src/client/tool/ToolCallTree.tsx  — 工具调用树
packages/client/ui-tool/src/client/tool/toolviews/file-mutation-row.tsx  — 文件编辑行
packages/client/ui-tool/src/client/tool/components/ToolRow.tsx  — 工具行组件
packages/client/ui-primitives/src/DisclosureRow.tsx  — 折叠行基组件
```