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
| `settings.general.item` | list | 设置页通用设置项（单条偏好） | `thinking-tags` 等 |
| `settings.section` | list | 设置页独立分区：导航一项 = 一整页 | `general`(0)、`models`(10)、`plugins`(15)、`agent-presets`(20)、`archive-cleanup`(30) |
| `conversation.details.tool` | single | 工具详情面板 | — |

---

## 11. 归档会话清理（archive-cleanup）

### 11.1 为什么需要

dsh 0.1.2 的「归档」是**持久显示过滤器**，不是删除：`workspaceRegistry` 持有一个 `archivedSessionIds` 集合，Web 侧栏把它同时从分组树、扁平列表和搜索结果里减掉（`dsh-client-ui-workspace` 的 `deriveGroups` / `deriveFlat` / `deriveSearchResults`）。归档既不释放磁盘，也没有任何取消归档入口；持久层同样没有删除 API（官方 README 写作 "pruning stored sessions is out-of-band backend maintenance"）。用户侧表现为：会话看不见、找不回、磁盘也不降。

### 11.2 三层结构

| 层 | 位置 | 职责 |
|---|---|---|
| Host 纯逻辑 | `lib/archive-cleanup.js` | `scan()` / `remove()` / `restore()`，全部能力探测，不碰 HTTP |
| Host 路由 | `lib/index.js` → `archivesRoute(ctx)` | `/api/dsao/archives`：GET 盘点、POST `delete`（需 `confirm:true`）/`restore`，loopback 围栏与既有 `/api/dsao/*` 同款 |
| Client 面板 | `src/modules/archive-cleanup.js` → `dsao/archive-cleanup` | 注册为 `settings.section` id `archive-cleanup`（order 30，设置导航独立一项「归档会话」；一整页而非通用页的一行），标题取客户端 `sessions.list` 快照 |

### 11.3 为什么可以不停宿主

「必须停宿主」只成立于**跨进程手改文件**：`dsh-storage-json` 的 `single` 布局内存权威、每次写整体重写 `<unit>.json`、无跨进程锁。在 host 进程内则走 owner service 自己的串行域写链（`global.set` / `table.update`），内存与磁盘同步移动，`domain/changed` 还会让 workspace follow 流重发 `archived` 增量——已打开的 GUI 无需刷新即更新。

### 11.4 用到的 API 与两处私有

| 用途 | 入口 | 性质 |
|---|---|---|
| 归档名单读取 | `registry.archivedSessionIds`、`registry.list()` | 公开 |
| 工作区记账摘除 | `Workspace.detachSession(id)`（幂等，自走写链） | 公开 |
| 正文定位 | `sessionPersistence.list()` → `locate(meta)` | 公开（`list()` 有两种已发布形态：裸 header 数组、`SessionPersistenceSnapshot` 信封数组 `{ header, revision, sizeBytes }`；两者都读） |
| 运行态真值 / 强制中止 | `ctx.agents.get(id).status`（与宿主列表 summary 同源）、`agent.cancel({kind:'user'})`（同 `session/cancel` 远端所用） | 公开 |
| 归档名单写回 | `registry.state` + `registry.setState()`（经 `enqueueOperation` 串行） | **私有方法**，`setState` 就是它自己 `archiveSession` 用的那条 `global.set` 链 |
| 投影缓存行 | `ctx.sessionProjectionCache.table.delete(id)` | **私有字段**，运行时可达 |
| 客户端列表行摘除 | `ctx.emit('api-session/removed', id)`（dsh-api-remotes 对全部 emit 模式事件做 `ctx.on` 监听并转发；客户端 `applyMutation` 的 `kind:'remove'` 把 id 从 `summaries` 过滤掉） | 公开事件契约 |

私有入口不可用时**降级不猜**：`scan()` 报 `capabilities.archivePrune=false`，面板直接显示"当前宿主未暴露归档名单写入口"。另一条看似可行的路已实测不通：`ctx.storageDomain.open(spec)` 对已打开的 unit 抛 `already-open`，所以插件无法自开 `workspace` 域绕开 registry。

### 11.5 守卫与顺序

- 候选只来自归档名单：未归档 id → `refused: not-archived`（**force 也不能越过这条授权边界**，被拒者连 cancel 都不发生）；常驻会话按 agent 真身细分：`running`（`ctx.agents.get(id).status === 'running'`，与宿主列表 summary 同一真值源）与 `attached`（常驻但空闲）——上一版把两者混叫 `live-session`，正是"空闲常驻被误标运行中、删不掉"的根源。
- **强制删除（force）**：面板「强制模式」开启后 `forceDeletableIds`（常驻的归档会话）才可勾选；删除前先 `agent.cancel({kind:'user'})`（不带 `keepInbox`，排队输入一并丢弃——留着会在 settle 后重跑并复活正文），再轮询 status 直到离开 running（默认 8s 超时）。等不到即拒绝 `not-settled`，**绝不在活写入者下面 unlink**——JSONL 后端按批 `open(path,'a')`，未静默的 writer 下次 flush 会重建半截文件。无 agents 注册表（旧宿主）→ 逐条 `no-agent-control`，scan 报 `capabilities.force=false`，面板不显示开关。
- 客户端自保护：`current`（本标签页正在看的会话）在任何模式下都不可勾选、也不会被「全选可删」选中——设置对话框就挂在这个会话里。
- 清单形态守卫：`sessionPersistence.list()` 的返回值有两种已发布形态——老后端返回裸 header，新后端返回 `SessionPersistenceSnapshot` 信封（id/cwd 在 `.header` 里）。两种都解出来用。**只认裸 header 是本次故障的根因**：在当前宿主上映射表恒为空 → 每次删除都"找不到目标"→ 一个字节没删，却把归档条目当成"正文本就没有"摘掉 → 重启后会话带着完整文件重新出现在「未分组」。因此"有条目但一条都映射不到 id"被当作**形态不认识**：`scan()` 直接抛错、`remove()` 整批抛错（路由转成 500 显示为错误横幅），归档集合一个字都不写。注意这与 `list()` 返回空数组（`shape='empty'`）严格区分——后者才是真的"正文已不存在"，允许只清记账。
- 布局守卫：`locate()` 结果必须是 `<...>/<session-id>/session(.vN)?.jsonl[.zstd]`（文件名形状 + 目录名等于该 id 或其路径段编码形式），否则 `errors: unexpected-layout` 且**一个字节都不动**；没有 `locate()` 报 `locate-unavailable`，定位不到报 `no-location`。删除时会 unlink 会话目录里的**全部代际文件**（`session.jsonl[.zstd]` 和 `session.vN.jsonl[.zstd]`），避免旧代际文件在重启后被当作最新正文而复活。
- 删除单位是**会话目录**：`fs.rm(dirPath, { recursive: true, force: true })`。后端把该目录声明为 session-owned，且"目录内版本号最大的代际"即会话正文——按文件精确保留只会漏删未来代际与其它旁路产物。递归的作用域由上面三道校验限定（路径只来自 `locate()`、文件名形状、目录名==id 编码），并且**永不触及 `<项目>` 这一层**，所以误删半径最大就是一个会话目录。目录已被手工清空时按 `absent` 报告（记账仍可清），大小与最后写入时间取自该目录实际内容（`readdir` + `stat` 汇总），不是 `locate()` 单文件。
- 写入顺序：（force：cancel → settle）→ membership → 正文 → 投影行 → **`api-session/removed` 广播** → 归档名单。中途崩溃的最坏结果是"仍在归档名单但文件已无"（隐形、可重试），而不是反过来"侧栏可见却没有正文"。removed 广播放在归档名单摘除之前：客户端摘行的瞬间，隐藏该行的过滤器还在，行不会闪现到未分组；没有这一步，客户端会话列表店会永远保留幽灵行——归档过滤器又被本次操作摘掉，幽灵随即浮出到未分组，且最后一位为 true 的会话永远显示「运行中」（无代理可停、无可续跑）。广播仅在会话真正消失时发出（`log === 'removed' | 'absent'`）；transcript 被保留或删除失败的会话仍可加载，不广播。
- 投影缓存行是 fold 捷径（"may be stale but never wrong"），删不掉也不影响正确性。

### 11.6 测试

- `test/archive-cleanup.test.mjs`：解析与守卫、盘点视图（running/attached 分离、目录总大小与 `files`）、force 全路径（cancel→settle→删、idle 免 cancel、不静默拒删、不越归档边界、无注册表降级）、写入顺序（detach → readdir/stat → 递归 `rm` 会话目录 → 投影行 → 广播 → 归档名单）、**两种 `list()` 形态各跑一遍**、**形态不认识时整批拒绝且不写归档**、整目录清除（含非正文旁路产物）、kept/failed 不摘除归档、布局守卫、降级报告、路由装配（403/405/400/503 + emit 断言）。
- `test/archive-cleanup-panel.test.mjs`：用 `test/load-module.mjs` 从 **lib/client.js 产物**里取真实模块，配 hook 形测试 React 驱动，断言渲染树、两步确认、强制模式解锁与 `force:true` 载荷、当前会话自锁、fetch 载荷与错误文案。
- `test/archive-cleanup-integration.test.mjs`：临时目录按 JSONL 布局播种 + 真 `node:fs` + 真 HTTP server，断言会话目录（含多代际、嵌套 `subagents/` 产物）真的整体消失、项目目录与兄弟会话原样保留其内容、未归档/运行中的正文不动、快照形态的 `list()` 同样能定位到目标，以及形态不认识时"零删除 + 归档集合不写"；force 端到端（cancel 事件、settle 后清除、记账清零）。

### 11.7 样式规约（借 ui-ux-pro-max 复核后定下）

| 规则 | 原因 |
|---|---|
| 颜色只用宿主 `--dsw-alias-*` 令牌，**禁止字面色值** | 每个别名在 `dsh-client-ui-theme` 里都有浅/深两值；写死 hex 会在另一套主题下悄悄坏掉（第一版就踩了：armed 态硬编码 `#5b2323`） |
| 只用**确实存在**的令牌名 | 第一版引用了不存在的 `--dsw-alias-interactive-bg-base`，按钮底色实际是透明。可用令牌从主题包里枚举，不靠记忆 |
| 交互态用 class，不用 inline style | `:hover / :active / :disabled / :focus-visible / position:sticky / prefers-reduced-motion / accent-color` 只有 CSS 能表达；注入方式与插件其他模块一致（`<style id="dsao-archive-cleanup-css">`，每文档一次） |
| 语义色分工 | 危险 `state-error-primary` + `interactive-bg-hover-danger`；警告 `state-warn-label`；成功 `state-success-primary`；选中行 `interactive-bg-active`、行 hover `interactive-bg-hover`、表头 `label-caption` |
| 层级与密度 | 页标题 15/500 → 统计 chip 12（数值 `label-primary` 加粗）→ 控件 13（高 28、圆角 6）→ 表格 12（行高 ~30、`border-l2` 分隔、表头 sticky）；数字列 `font-variant-numeric: tabular-nums` 右对齐 |
| 四态必须建模 | loading（3 行骨架，`prefers-reduced-motion` 下不动）、empty（"没有归档会话，无需清理"并撤掉删除按钮）、error（`role="alert"` 横幅 + 重试）、result（`role="status"`；只有全绿才用 ok 语气，出现拒绝/失败/未写入自动降级为 warn） |
| 可达性 | 每个 checkbox 带 `aria-label` 且被 `<label for>` 关联（标题即点击区）；`th scope="col"`；容器 `aria-busy`；焦点环 `outline:2px solid brand-primary` + `offset:2px`；禁用项 `cursor:not-allowed` + 45% 透明 |
| 破坏性动作 | 两步确认；armed 态换底色并把"释放 X MB，不可恢复"写进按钮文案；选择变化或 8s 超时自动解除（不留悬挂的待确认态） |

`test/archive-cleanup-panel.test.mjs` 把前四条做成了断言（扫描 CSS：不得出现 `#hex`、`rgba(`、非 `--dsw-alias-` 变量；必须含 hover / focus-visible / disabled / sticky / reduced-motion / accent-color / tabular-nums），所以样式回退会直接红。

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