# 工具组（tool-group）性能分析报告

> 任务：排查工具组功能是否存在持续的计算/刷新，导致不必要的资源占用。
> 范围：`src/modules/tool-group.js`，关联 `lib/client.js`、`src/client.js` 的调用链。
> 结论日期：2026-07-09
> 后续：按 §6.3 的方向已实施"增量/脏检查"优化（§8），两版均已改动并通过测试。

---

## 结论（TL;DR）

1. **模块自身不存在"页面空闲时仍不断计算/刷新"的机制。** 没有 `setInterval`、`requestAnimationFrame`、轮询或数据订阅（对 `lib/client.js` 全量 grep：0 处 `setInterval`/`requestAnimationFrame`）；唯一的计算触发源是挂在 `document.body` 上的 `MutationObserver`，**DOM 完全静止时回调不会触发，即零扫描**；唯一的自触发定时器（src 版 `confirmTimer`，160ms 一次性）可证明收敛，不会自我延续成循环。
2. **存在两类真实的资源消耗点：**
   - **活动回合期间**：每次扫描都是对 `document.body` 的**全量 O(N) 重算**（无脏检查、无增量、无按组 diff），防抖只作用于触发（80ms）而不适用于计算本身——长会话 + 高频流式更新时，每 80ms 就要重查全量工具行。
   - **`data-state` 属性触发是"全文档级"的**：属性过滤器为 `attributeFilter: ['data-state', ...]` 且挂在 `document.body` 上，**文档中任意元素**（不限于聊天流）的 `data-state` 变化都会触发一次全 body 重扫。若存在周期性改写 `data-state` 的无关 UI（任务卡进度、状态脉冲等），就会出现"聊天空闲但扫描持续"的现象——这是"不断计算"唯一可行的代码路径，值得运行时实测确认。
3. **关键事实：生产运行的是 `lib/client.js` 内嵌的旧版实现，与 `src/modules/tool-group.js` 是两代不同代码**（`package.json` 的 `./client` 指向 `lib/client.js`；测试基建 `test/load-module.mjs` 明确从 `lib/client.js` 取"exact code that ships"）。`lib` 版是 turn-status 方案（无 hysteresis、无 `confirmTimer`，且每次扫描额外做 2 次全文档 `querySelector`），`src` 版是更新的 hysteresis 方案但**尚未打包进 lib**（`package.json` 无任何 `scripts`，lib 为手工组装）。以下分析两版分别给出行号，生产行为以 lib 版为准。

---

## 0. 调用链与生命周期（先厘清"谁在跑、跑几次"）

| 事实 | 位置 |
|---|---|
| 生产入口导出 `./client → lib/client.js` | `package.json:16-18` |
| 测试从 `lib/client.js` 抽取模块，"tests exercise the exact code that ships" | `test/load-module.mjs:1-2` |
| 主入口注册：`ctx.effect(function () { return toolGroup.startToolGroupObserver(); })` | `lib/client.js:2062`（开发镜像 `src/client.js:89`） |
| `ctx.effect` 语义：回调在 `apply()` 时**执行一次**；返回的函数被收集为 disposable，**fiber 卸载（插件卸载）时按逆序调用** | `@deepseek-ai/cordis/lib/index.js:1168-1249`（DSH checkout） |

推论：正常生命周期下**observer 全页唯一**，卸载时 `obs.disconnect()` + 清定时器可靠执行。**多 observer 叠加只可能来自"apply 被重复执行而旧 fiber 未 dispose"**（如宿主重复 apply、开发态 HMR），代码层面未看到该路径，运行时未验证。

---

## 1. 数据计算 / UI 更新由什么触发

### 1.1 触发源清单（两版一致的部分）

| # | 触发源 | 位置（src / lib） | 说明 |
|---|---|---|---|
| T1 | 初始扫描 | src `:705` / lib `:777` | `startToolGroupObserver()` 内一次性 `scanToolGroups(document.body)`，每次 apply 执行一次 |
| T2 | `MutationObserver`（挂在 `document.body`） | src `:707-713` / lib `:779-782` | `childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'data-dsao-tg-state']` |
| T3 | 相关性过滤 `hasRelevantMutation` | src `:666-693` / lib `:744-768` | 过滤不相关变更（见 1.2 差异） |
| T4 | 80ms 防抖 → `scanToolGroups(document.body)` | src `:695-702` / lib `:771-775` | 连续相关变更合并为一次扫描 |
| T5 | `confirmTimer`（**仅 src 版**） | src `:563-567` | 一次性 160ms，hysteresis 确认用，见 1.3 |
| — | `setInterval` / `requestAnimationFrame` / 轮询 / store 订阅 | **无**（全 bundle grep 为 0） | — |

### 1.2 相关性过滤的两版差异（影响"什么算相关变更"）

**lib 版（生产）** — `lib/client.js:744-768`：
- 任意 `data-state` / `data-dsao-tg-state` **属性变化 → 相关**（`:747`，**全文档范围，不要求位于聊天流内**）；
- 新增节点：任何带 `data-chat-flow-key` 的节点（**任意 flow kind**：文本、thinking、user、tool，`:627`）、任何 `data-dsao-tg-header`（`:628`）、任何匹配 `[class*="_turnStatus"]` 的节点（`:630`）→ 相关；且对每个新增元素节点额外执行 3 次子树 `querySelector`（`:754-758`）；
- 移除节点：同样判定（`:761-765`）。

**src 版（开发参考）** — `src/modules/tool-group.js:666-693`：
- `data-state` 属性变化 → 相关（`:670`，**同样是全文档范围**）；
- 新增节点：仅 `data-chat-flow-kind="tool-call"` / `assistant-step` / `data-dsao-tg-header` 三类（`:678-682`），或对新增元素执行 2 次子树 `querySelector`（`:684-688`）；**不检查 removedNodes**。

> 两者共同点：**`data-state` 的触发判定是文档级、不限定聊天容器**——这是"无关 UI 也能驱动全量重扫"的共同弱点（见结论 2.b）。

### 1.3 自触发链是否收敛（"重渲染循环"排查）

模块自身会写 DOM：`data-dsao-tg-state`（展开/收起）、`data-dsao-tg-collapsed`（组内项）、header 的插入/移除、`data-dsao-tg-size` 更新。逐项验证：

- **状态切换自触发**：`applyCollapse`/`applyExpand` 写 `data-dsao-tg-state`（在 attributeFilter 内）→ 触发 1 次后续扫描 → 下一次扫描中状态已一致，`applyGroup` 的幂等分支（src `:454-462` / lib `:586-592`）只做"值相同"的 `setAttribute`（不产生 mutation）→ **无操作，收敛**。`data-dsao-tg-collapsed` 不在 attributeFilter 内，不触发。
- **`confirmTimer` 链（src 版）**：只在"最新组已结束 + 组后已出现内容 + 状态仍 expanded + 信号未 arm"时 arm 并设置 160ms 定时（src `:553-568`）。确认扫描到来时，要么 `applyCollapse`（状态变 collapsed，之后任何扫描都走 `:554-555` 的 no-op 分支），要么组后内容消失则清信号（`:570-572`）。**每次 arm 最多导致 1 次确认扫描 + 1 次 no-op 扫描，数学上收敛，不能自我延续**。
- **header 重建/清理**：`cleanupStaleMarkers`（src `:609-641` / lib `:698-727`）移除失效 header → 1 次 childList mutation → 下次扫描稳定。
- **结论：不存在重渲染循环 / 反馈环。**

---

## 2. 是否存在无防抖/无脏检查的重复计算

**是。防抖只存在于"触发"（80ms），计算本身每次都是全量重算，没有任何脏检查/增量。**

每次 `scanToolGroups`（src `:645-655` / lib `:729-738`）的固定开销，与"本次变更了什么"完全无关：

| 步骤 | 位置（src / lib） | 成本 |
|---|---|---|
| `ensureStyles` | `:137-146` / `:378-387` | 幂等，O(1) |
| `cleanupStaleMarkers(document.body)` | `:609-641` / `:698-727` | 2 次全 body `querySelectorAll`（所有 header + 所有已标记项）+ 每项双向 sibling 遍历 |
| `detectGroups(document.body)` | `:192-224` / `:415-442` | 全 body `querySelectorAll('[data-chat-flow-kind="tool-call"]')`（`:194` / `:417`）；**每个工具行 2 次 `querySelector`**（`[data-tool]` + `[data-sample]`，src `:67` / `:73`）；`areConsecutive` 相邻项间 sibling 遍历 + `textContent` 读取（`:182`，强制收集文本节点） |
| `applyGroup` × 每组 | `:391-463` / `:543-593` | 尺寸不变 → 幂等属性写（廉价）；尺寸变化 → 删 header 重建（`:399-406`） |
| `manageLatestGroup` | `:530-573` / `:664-677` | 见下 |

**lib 版（生产）的额外全文档探针**：`manageLatestGroup → groupShouldExpand`（`:660-662`）每次扫描都执行 `isTurnActive()`（`:615-619`）：

```js
if (document.querySelector('[data-state="running"]')) return true;   // 全文档
return document.querySelector('[class*="_turnStatus"]') !== null;    // 全文档 + class 子串选择器
```

即**每次扫描 = 全 body 工具行查询 + 每行 2 次子查询 + 2 次全文档 `querySelector`**（`[class*="…"]` 为属性子串匹配，比精确类名更贵）。

因此：
- 流式回合中（相关变更密集），扫描频率上限 **1 次/80ms**，每次为 O(挂载的工具行总数) 的 DOM 查询——**成本随会话长度线性增长**；
- 即使只新增 1 个工具行，**所有历史组**都要重新 detect + apply（无按组脏检查）；
- `toolNameOf` 的结果没有按元素缓存，同一行每扫描 2 次 `querySelector`。

---

## 3. 页面空闲 / 无数据变化时是否仍持续触发

**分两层回答：**

### 3.1 DOM 完全静止（真空闲）→ 不触发

- `MutationObserver` 在无 mutation 时不回调（浏览器标准行为）→ `onMutations` 不执行 → 无扫描；
- `scanTimer` 为防抖计时，触发后 80ms 内必清；`confirmTimer`（src）一次性且收敛（§1.3）；无其他定时器；
- 模块自写（状态切换/header 重建）最多引出 1 次 no-op 后续扫描（§1.3）。

**即：代码层面不存在"空闲时自我维持"的计算循环。**

### 3.2 "逻辑空闲"（聊天无变化，但页面其他处有活动）→ 可能持续触发 ⚠️

`attributeFilter: ['data-state', 'data-dsao-tg-state']` 挂在 `document.body` 上，而 `data-state` 的判定**不限定聊天流**（src `:670` / lib `:747`）。DSH 宿主 UI 中多处使用 `data-state`：

| 宿主位置 | 用途 |
|---|---|
| `dsh-client-ui-conversation/lib/client.js:9408, 9597` | 聊天行 `running/ok`（回合内正常变化） |
| `dsh-client-ui-tool/lib/client.js:719, 1210` | 工具行状态 |
| `dsh-client-ui-cordis/lib/client.js:150, 293, 498` | **插件工具卡 `card.state`** |
| `dsh-client-ui-skill/lib/client.js:137` | 技能列表行 `model.state` |

若其中任一元素被周期性更新（任务进度 tick、状态心跳、React 重渲染反复设置该属性），则**聊天完全空闲时也会以 ≤1 次/80ms 的频率持续全 body 重扫**——这就是"不断计算刷新"唯一成立的代码路径。

同 bundle 内的一个**具体实例**：prompt-enhance 按钮在点击/结算时切换自身 `data-state`（`lib/client.js:1870` busy / `:1879` idle）→ 每次切换引出 1 次 tool-group 全量重扫（一次性，非循环，但证明跨模块 data-state 耦合真实存在）。

另一相关弱点（lib 版生产）：`isTurnActive()` 的 `document.querySelector('[data-state="running"]')`（`lib:617`）是**全文档探针**——若任意无关元素残留/周期性携带 `data-state="running"`，会把最新组错误保持为 expanded（状态错误，非计算循环），并在其闪烁时叠加 §3.2 的持续扫描。

**多 observer 叠加**：仅当 `apply()` 被重复执行而旧 fiber 未 dispose 时发生（HMR/宿主重复 apply）。正常 cordis 生命周期（§0）会先 dispose 旧 observer。未运行时验证。

### 3.3 同 bundle 相关观察（非 tool-group，供参考）

| 观察 | 位置 | 评估 |
|---|---|---|
| **mermaid observer** | `lib/client.js:1077-1084` | 挂 `document.body`，`childList: subtree: true`，**无相关性过滤、无防抖** → 文档中**每一次** DOM mutation（含无关 UI）都触发全 body `querySelectorAll('.md-code-block')`。命中后跳过已处理块，单次廉价，但它是 bundle 内最"随 mutation 而跑"的模式——若实测资源占用偏大，优先怀疑它 |
| diff 徽章 observer（每行一个） | `lib/client.js:891-899` | 仅观察本行，React effect cleanup 断开，无问题 |
| prompt-enhance 定位 observer | `lib/client.js:1952-1961` | 仅观察 `trailing` 元素，卸载时清理，无问题 |

---

## 4. 两版实现差异对照（src vs lib）

| 维度 | `src/modules/tool-group.js`（开发参考，未打包） | `lib/client.js` 内嵌版（**生产**，行 319-797） |
|---|---|---|
| 展开/收起策略 | hysteresis：`pendingSignal` + `confirmTimer` 双扫描确认（`:510-573`），rebuild 时 `isRebuild ? (running \|\| !hasContentAfter) : running`（`:446-448`） | turn-status：`isTurnActive()`（`:615-619`）+ `groupShouldExpand`（`:660-662`），无 hysteresis、无 confirmTimer |
| 每次扫描的全文档探针 | 无 | 2 次 `document.querySelector`（`:617-618`） |
| 透明节点判定 | `data-chat-flow-kind="assistant-step"` 且无文本（`:174-184`） | 带 `data-chat-flow-key` 的任意空 flow 节点（`:396-401`） |
| 相关性过滤 | 仅 tool-call/assistant-step/header 三类新增（`:678-682`） | 任意 `data-chat-flow-key` 节点增删 + turnStatus 行（`:624-632`，**更宽**） |
| 定时器清理 | 清 `scanTimer` + `confirmTimer`（`:714-718`） | 只清 `scanTimer`（`:783-786`） |

> `package.json` 无 `scripts`，`lib/client.js` 为手工组装的静态 bundle → **src 的 hysteresis 新设计尚未进入生产**。对 src 单独分析不能代表运行时行为。

---

## 5. 触发条件与频率汇总

| 场景 | 扫描频率 | 每次成本 |
|---|---|---|
| 页面加载（apply） | 1 次初始扫描 | O(N 工具行) 全量 |
| 流式回合（tool-call 增删 / data-state 翻转） | ≤ 1 次/80ms（防抖合并） | O(N) 全量重算 +（lib 版）2 次全文档 query |
| 组状态切换（expand/collapse/rebuild） | 每次切换 +1 次 no-op 后续扫描 | O(N) 全量（收敛） |
| src 版 hysteresis 确认 | 每次 arm ≤ 1 次 160ms 确认扫描 + 1 次 no-op | O(N) 全量（收敛） |
| **聊天空闲，但文档内任意 `data-state` 元素周期性变化** | **≤ 1 次/80ms 持续** | O(N) 全量 ⚠️ |
| DOM 完全静止 | 0 | 0 |
| setInterval / 轮询 / rAF | 不存在 | — |

---

## 6. 优化方向（仅方向，不改代码）

按收益/风险排序：

1. **把 `data-state` 相关性判定限定到聊天流内**（两版共同的最高收益项）：`hasRelevantMutation` 中属性类 mutation 要求 `m.target.closest('[data-chat-flow-kind]')`（或位于聊天列容器内）才算相关，消除文档级 `data-state` 误触发（§3.2）。
2. **缩小观察根**：observer 从 `document.body` 收窄到承载 flow items 的聊天列容器（可用初始扫描时定位并缓存），无关 UI 的 childList/attribute 变更不再进入回调；顺带省掉对无关新增节点的子树 `querySelector`（lib `:754-758`）。
3. **增量/脏检查**：以 `data-chat-flow-key` 为身份维护组索引；重扫时只对成员边界发生变化的组重新 detect/apply，其余组跳过；`toolNameOf` 结果按元素 `WeakMap` 缓存，消灭每行每扫描 2 次 `querySelector`。
4. **去掉 lib 版每次扫描的 2 次全文档探针**：turn 激活态改由 observer 已可见的 turnStatus 行 mount/unmount 推导（缓存布尔），不再 `document.querySelector('[data-state="running"]')` / `[class*="_turnStatus"]`（`lib:615-619`）。
5. **统一两版实现**：把 src 的 hysteresis 版打包进 `lib/client.js`（或反向对齐），消除"分析/测试/生产三处代码不一致"（`test/load-module.mjs` 从 lib 取码，而 src 无 tool-group 测试）。
6. **mermaid observer 补齐过滤+防抖**（`lib:1077-1084`）：与 tool-group 相同的 80ms 防抖 + 仅对可能含 `.md-code-block` 的新增子树做处理，消除"每次任意 mutation 全 body 扫"。
7. **可选**：会话视图卸载 / `document.hidden` 时 `obs.disconnect()`，可见性恢复时重新 observe（浏览器对后台页的 MO 回调已延迟，disconnect 更干净且省掉相关性判定本身）。
8. **运行时实证（建议先做）**：临时给 `scanToolGroups` 入口加计数/`performance.mark`，实测三个场景的扫描频率——(a) 加载后静置 60s（预期 ≈1 次）；(b) 活动回合（预期 ≤~12 次/s）；(c) 聊天空闲但操作无关 UI（输入、开设置页、任务卡刷新）。若 (c) 非零，即坐实 §3.2 路径，优化 1/2 直接命中。

---

## 7. 风险 / 未决项

- **"空闲 = 零扫描"是静态代码推导**，未在 GUI 运行时实测（本次为只读分析，未启动应用）；最可能被打脸的场景是 §3.2 的文档级 `data-state` 触发，建议按 §6.8 做一次带计数的实测。
- **多 observer 叠加路径未验证**（HMR / 宿主重复 apply 时 `apply()` 重入而旧 fiber 未 dispose）；代码层面正常生命周期无此问题。
- src 版 hysteresis 代码**无测试覆盖且未打包**，其收敛性论证（§1.3）未经过 `test/` 基建校验。
- `isTurnActive` 的 `[class*="_turnStatus"]` 依赖宿主 CSS-module 类名后缀稳定（代码注释自述"hash 前缀会变"），属脆弱耦合，与性能无关但值得记录。

---

## 8. 已实施：增量/脏检查扫描（2026-07-09）

按用户确认的目标模型落地："**打开会话历史时全量算一次，之后实时只管理最新的那个组**；任何不是'尾部单节点追加'的变更回退到全量重算"。两版（`lib/client.js` 生产版 + `src/modules/tool-group.js` 开发参考）均已改动，各自保留原有状态逻辑（lib=turn-status，src=hysteresis），只替换"扫描由什么触发、算多少"。

### 8.1 三级分派（替换"每次全量重算"）

每次 mutation 批先经 `classifyMutations` 判定成本档位，80ms 防抖窗口内跨批合并（见 8.2），到期只跑对应档位的计算：

| 档位 | 触发条件 | 计算量 |
|---|---|---|
| **full** | 任意相关节点**移除**；turn-status 行挂载（仅 lib）；窗口内**≥2 个** flow 节点新增；新增节点**不在尾部**（`nextSignificantSibling(item) !== null`）；新增节点与现有组**不同列**（`parentNode` 不同） | `fullPipeline`：`ensureStyles` + `cleanupStaleMarkers` + `detectGroups` + 逐组 `applyGroup` + `manageLatestGroup`（= 原全量） |
| **tail** | 窗口内**恰好 1 个** flow 节点新增，且在尾部、同列 | `performTailScan`：仅回扫该节点起的连续可分组 run（`computeTailRun`，O(run)）；run≥2 才 `applyGroup(run)` 并刷新 `lastLatest`；非可分组项（如 assistant 文本落在尾部）只 `manageLatestGroup([lastLatest])` |
| **attr** | 仅 `data-state` 属性变化（组成员只由 flow 节点集合/顺序决定，属性不改成员） | `performAttrScan`：只 `manageLatestGroup([lastLatest])`（O(最新组)） |
| **ignore** | 无相关变更 | **零扫描** |

稳态流式（逐个工具追加、`data-state` 翻转）因此从"O(全部历史组)"降为"O(尾部 run / 最新组)"；全量重算只发生在真正使缓存失效的事件（删除、批量、换会话、turn-status 挂载）。

### 8.2 pending 累加器（关键正确性修复）

80ms 窗口内会到达**多个** mutation 批。若只对"最新一批"分派并用闭包捕获档位，"先 tail 后 attr"的两批会丢掉 tail（防抖被重排成 attr 扫描）。故引入模块级 `pending = { full, item }` 跨批合并：

- `full` 覆盖 `tail`/`attr`；
- 窗口内**两个不同 tail 节点** → 升级为 `full`（等价批量）；
- `attr` 不累积（真正跑的那次扫描会重算状态）；
- 到期取走 `done = pending; pending = null` 后按 `done.full → full / done.item → tail / 否则 → attr` 执行；`performTailScan` 到期时若 `item` 已脱离 DOM 则回退 `full`。

### 8.3 自触发消除 + 观察面收窄

- **header 自写不再触发扫描**：`classifyMutations` 对带 `data-dsao-tg-header` 的新增/移除节点直接忽略（该属性只有本模块的 `applyGroup`/`cleanupStaleMarkers` 会写）。原实现中 header 插入/移除会被判为"相关"→ 引出 1 次 no-op 后续全量扫描；现在**扫描不会自我续命**，稳态下 header 重建只产生 `ignored++`。
- **`data-dsao-tg-state` 移出 `attributeFilter`**（`["data-state","data-dsao-tg-state"]` → `["data-state"]`）：该属性同样只有本模块写，观察它只会制造自触发；移出后省掉这条 proven no-op 的自触发重扫。
- **初始扫描**由 `startToolGroupObserver` 直接 `fullPipeline(document.body)`（"打开即算一次"的基线），并写入 `lastLatest` 缓存。
- **`stop()`** 清 `scanTimer` +（src）`confirmTimer` + `pending` + `obs.disconnect()`，返回 cordis disposable 不变。

### 8.4 有意的行为变更（需知悉）

1. `data-dsao-tg-state` 不再被观察（安全：仅本模块写；消除自触发重扫）。
2. **src 版现在对"移除"有反应**（原 `hasRelevantMutation` 只看 addedNodes，删除会漏 → 残留旧 header）；新增的 flow 节点判定也放宽到 `data-chat-flow-key` 超集（廉价档位）。这是修 bug，不是回归。
3. 稳态下 `data-state` 翻转 = O(最新组) +（仅 lib）`isTurnActive` 的 ≤2 次全文档 `querySelector`（因 `||` 短路，仅当组内无 running 时才命中）。

### 8.5 验证

- 新增 `test/tool-group.test.mjs`（**lib 生产版**，经 `test/load-module.mjs` 取 exact shipped code + 真 `MutationObserver` 打桩）：**42 断言**，覆盖初始全量、tail 追加、attr 翻转、删除→full、批量→full、中部插入→full、换会话→full、turn-status 挂载→full、组后内容→collapse、user flag 保持、**累加器两个回归场景**（tail+attr 同窗口保 tail；两 tail 同窗口→full）。
- 新增 `test/tool-group-src.test.mjs`（**src 开发参考版**，直接求值模块体）：**11 断言**，验证同一分派策略已镜像（初始/tail/attr/删除四档）。
- `node --check` 通过 `lib/client.js`、`src/client.js`、`src/modules/tool-group.js`；`lib` 模块体大括号配平未被破坏（`load-module.mjs` 抽取成功）。
- 全量测试 9 个文件全绿（content-embed / context / diff-stats / ensure-badge / fast-context-gate / host-prompt-enhance / prompt-enhance / tool-group / tool-group-src）。
- 新增导出 `exports.scanStats`（`{full,tail,attr,ignored}` 计数）供运行时实测与测试断言；`exports.classifyMutations` 一并导出。

### 8.6 残留成本 / 未决项（本次不做）

- **组增长后的 header 重建**：`applyGroup` 尺寸变化时删旧 header 建新 header → 产生被忽略的 childList 批（`ignored++`，无后续扫描）。有界、无循环。
- **lib 版 `isTurnActive` 的 2 次全文档 `querySelector`**：仅在组内无 running（`||` 短路后）命中；考虑过用 observer 可见的 turnStatus 行缓存布尔，因状态同步风险暂不做（§6.4）。
- **`data-state` 仍是文档级触发**（§3.2 / §6.1）：无关 UI 周期性改 `data-state` 仍会触发 attr 档扫描（比原来的全量轻，但非零）；限定到聊天流内是后续高收益项。
- **mermaid observer** 仍无过滤无防抖（§3.3 / §6.6）：bundle 内最"随 mutation 而跑"的模式，未动。
- **src/lib 两版状态逻辑未统一**（hysteresis vs turn-status）：本次只统一了"扫描分派"，状态策略仍各自为政；打包 src 的 hysteresis 进 lib 是独立决策（§6.5）。
- **"空闲 = 零扫描"** 现由测试的 `ignored`/档位计数佐证（静置 DOM 不再触发任何扫描），但 GUI 运行时实测（§6.8）仍建议做一次带 `scanStats` 的确认。
