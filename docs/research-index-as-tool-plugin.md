# 调研：把"索引能力"作为工具调用放进插件

> 问题：如何把 DSH 的工具注册表索引（渐进式披露一/二级，`tools_catalog` / `tools_help`）做成**插件注册、模型可直接调用**的工具，落到 `dsh-assistant-optimization`。
> 证据基线（2026-08-23 实测，行号以当日文件为准）：
> - own-layer 实现：`C:\Users\qjq\.dsh\.agent-presets\router-standard\router-bootstrap-v34.mjs`（+ `agent.cordis.yml`、`stages.json`）
> - 公开契约：`@deepseek-ai/dsh@0.1.1-rc.2` 已发布包（`dsh-tools`、`dsh-llm`、`dsh-tool-fs`、`dsh-tool-cordis`、`config/agent-presets/standard`）
> - 本仓库：`lib/index.js`、`docs/technical-reference.md`

---

## 1. 结论

1. **索引能力今天已经是一个"插件工具"**：`router-standard` 预设把 `router-bootstrap-v34.mjs` 作为本地插件行挂载（`agent.cordis.yml` L65–67：`- id: router-bootstrap / name: ./router-bootstrap-v34.mjs?v=46`），其 `apply(ctx)` 里用 `ctx.effect(() => ctx.tools.register({...}))` 注册 `tools_catalog`/`tools_help`（v34 L829–933）。它不是什么不可移植的魔法——**就是 cordis 插件 + `ctx.tools.register` 的标准用法**，只是目前以"会话层 own-layer shim"形态存在（重启不随包走、依赖私有成员访问）。
2. **"放进插件"的落地方式**：把索引工具移植为正规插件注册——两个宿主可选：
   - **A. 本仓库 web 插件的 Host 半体**（`lib/index.js` 的 `apply(ctx)` 里追加注册）：随 `dsh plugin build/add` 全局安装，对所有 agent 可见；
   - **B. 独立插件包 / 预设行**（仿 `dsh-tool-cordis` 形态，`packages/extensions` 风格）：可发布、可被任意预设挂载，最彻底的"插件化"。
   推荐 A 先做（复用现成插件位、当天可验），B 作为发布形态。
3. **数据源与阶段标记的实现已完全摸清**（v34 L163–243）：
   - 全量名册 = `view(scope).knownNames` ∪ `schemas(scope)` ∪ **私有 `toolsSvc.layers`**（`chainLayers/peek/global` → 各层 `layer.tools` Map）逐层查原始定义；
   - 标记 = `runtimeMark`：`view(scope).visible.has(name)` → [可调] / [未解锁]（meta 工具 → [meta]）；`view()` 在 TS 里是 private，但运行期可直接访问；
   - **风险点**：全量索引依赖 `layers`/`view` 私有面（无跨版本契约）。shim 全程 try/catch 包裹、失败时降级为公开 `schemas()`（只能列可见集）。插件版必须保留同样的降级路径。
4. **阶段门控不是"注册/注销工具"，而是 per-agent `restrict({allow})`**（v34 L702–722：每会话持一个 disposer，末阶段释放 → 全量开放）。因此索引工具与门控**天然正交**：索引工具自己应当常显（像 META_ALL 一样进每个阶段的 allow 表），它回答的是"现在哪些工具真绑在 SDK 上"。
5. **输出契约取 shim 同款即可**：`output: { schema: { type: 'string' }, render: (a,v) => [{type:'text', text: String(v)}] }` —— 字符串输出最简单、回放最稳（v34 L911）。结构化输出（对象 schema）更规范但非必需。
6. **有官方先例**：`dsh-tool-cordis`（`cordis_inspect`）就是"把运行时 machine-readable catalog 作为模型可调用工具"的一等包。方向已被验证。

---

## 2. 索引能力现状剖析（own-layer shim 实拆）

文件：`C:\Users\qjq\.dsh\.agent-presets\router-standard\router-bootstrap-v34.mjs`

### 2.1 注册方式（L829–933，L1067–1135）

```js
// 插件内的注册助手（L829-834）
const registerTool = (tool) => {
  ctx.effect(() => ctx.tools.register({
    ...tool,
    parameters: toJsonSchema(tool.parameters),   // 作者期参数 spec → JSON Schema
  }))
}
```

- **全局注册**：`apply(ctx)` 里注册 `tools_catalog`（L907–933）、`tools_help`（L935–954）等 → 进全局层，所有 agent 继承。
- **per-agent 影子注册**：`installMetaShim(agent)`（L1067+）在每个 agent 的 ctx 上**再注册一份**（先 `layers.scoped.get(agent).tools.data.delete(name)` 清掉旧代），scoped 层遮蔽全局层（dsh-tools 契约：`Scoped tools shadow globals`）。这一步让 meta 工具绑定进该 agent 的 `run_code` SDK（Code Mode 面）。
- **注册期校验很轻**（`dsh-tools/lib/index.js` L2762–2771）：`output{schema,render}` 必须、schema 过 `assertSupportedJsonSchema`、`timeoutMs` 正数、`run_code` 保留。**裸定义对象即可注册，无需 `defineTool` import** —— 动态插件（纯 JS 无 import）同样可行。

### 2.2 全量索引：`registryFullIndex(toolsSvc, scope)`（L177–219）

```
names = view(scope).knownNames          // restrict 前的继承面 + own layer
      ∪ schemas(scope)                  // 当前可见集
layers = [toolsSvc.layers.global, ...layers.chainLayers(scope), layers.peek(scope)]
def(name) = 逐层 layer.tools.get(name) / entries() 扫描
           ↳ 兜底：view(scope).tools.get(name)、schemas(scope) 反查
返回 [{ name, description, parameters }] 按名排序
```

要点：
- `view()`/`layers` 是 `ToolRuntime` 的 **TS-private 成员**，运行期（JS）可直接访问——shim 正是这么做的；
- 每一环都在 try/catch 里，`layers` 拿不到时退化为 `knownNames + schemas()`（只剩可见集，但名字仍全）；
- 这正是"catalog 列全部工具（含锁定项）"的来源——**公开 API（`schemas`/`get`）给不了锁定项的完整定义**，私有面才给得了。

### 2.3 阶段标记：`runtimeMark`（L235–243）+ `markerFor`（L224–231）

```js
visible = toolsSvc.view(scope).visible      // SDK 生成的唯一事实源
mark = META_ALL.has(name) ? (visible ? 'meta' : '未解锁')
                           : (visible ? '可调' : '未解锁')
```

- **以运行时可见面为准**，不做静态阶段映射（v1.9 根修注释：静态映射与 SDK 真绑定会错位）；
- 静态兜底 `markerFor(name, stage)`：`stage + 2` 预放窗口内 → [可调]，否则 [未解锁]。

### 2.4 门控与呈现

- **门控**：`applyStageRestrict`（L702–722）——每会话一个 `toolsSvc.restrict({ allow })` disposer（`sharedLift` Map 跨代共享，避免交集叠加）；末阶段（stage ≥ 3）直接释放 → 全量开放。
- **域分类**（L916–924）：关键词启发式 → `file/exec/network/delegate/memory/other`。
- **参数速览** `paramHint`（L262–277）：从 JSON Schema 提取 `name: type` 一行。
- **行格式**（L931 / L1116）：`- name [mark] — desc首行(≤90字符) (params: ...)`。
- **交付 gate 的证据契约**（`deliveryCheck` L556–615，顺带摸清）：`evidence = { items: [{label, kind, target?, result?, reviewed?}] }`，`kind ∈ {file,page,image,run,test,text}`；`run/text` 需非空 `result`；`file/page/image` 需 `target` 指向现存非空文件，`page/image` 另需 `reviewed: true`；传 `url` 时至少一条已复核视觉证据。

---

## 3. 公开契约（插件可长期依赖的部分）

### 3.1 ToolRuntime（`@deepseek-ai/dsh-tools`，`ctx.tools`）

| API | 出处 | 语义 |
| --- | --- | --- |
| `register(def) → disposer` | index.d.ts L503/L603 | 全局层或调用方 agent scope；scoped 遮蔽全局；**同层重名失败**；`run_code` 保留；运行期校验轻（见 §2.1） |
| `get(name, scope?)` | L657 | 按 scope 解析；restrict 掉的名字读作 absent |
| `schemas(scope?) → ToolSchema[]` | L578 | 可见集的模型面 schema（name/description/parameters，深拷贝） |
| `restrict({allow,deny}) → disposer` | L611 | 仅 scope ctx 可用；过滤继承面，不影响本层 |
| `guard(fn)` / `presentAs(mode)` | L622/L574 | 单调守卫 / per-scope 展示模式 |
| 事件 `tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`、`tools/change` | L24–95 | 门控/审计/缓存失效 |
| **私有面** `view(scope)`（`.knownNames`/`.visible`/`.restrictableNames`/`.tools`）、`layers`（`.global`/`.chainLayers`/`.peek`/`.scoped`） | 运行期可访问 | shim 的全量索引与标记依赖于此；**无跨版本契约** |

### 3.2 ToolDefinition / `defineTool`

`dsh-tools/lib/types/schema.d.ts` L178–239；`index.d.ts` L105–172：

```
{
  name, description,                      // 模型面白名单仅 name/description/parameters
  parameters: { <prop>: {type, required?, description?} },
  output: { schema, render(args,value)→ContentBlock[], presentationMeta? },
  execute(args, exec) → Promise<value>,   // 异步须观察 exec.signal
  timeoutMs?, isConcurrencySafe?(args), presentCall?, presentResult?, finalizeContent?
}
```

- 返回值违反 `output.schema` → `ToolOutputError`；`render` 是纯函数（live 流式 + 历史回放都会调）。
- `ToolSchema`（`dsh-llm/lib/types/types.d.ts` L325–330）= `{name, description, parameters}`。

### 3.3 插件形态

- 官方模板 `dsh-tool-fs/lib/index.js` L1199–1237：`export { Config, apply, inject, name }`；`inject` 声明硬依赖（Cordis 会让插件等待服务就绪——行序不保证可用，本仓库 `webServer` 实测教训 `lib/index.js` L263–277）；可选服务 `ctx.get()` 探测 + 降级。
- 官方先例 `dsh-tool-cordis`：`name="tool-cordis"`、`inject`、`apply(ctx)` 注册 `cordis_inspect` 等"运行时目录"工具；包描述自述 "Self-referential cordis toolset: inspect the live runtime"。
- 展示模式（`Config.mode`，index.d.ts L449–468）：`native` 直发 / `code` 仅 `run_code`+SDK（插件工具经 SDK 子派发，原生直呼 → `UNKNOWN_TOOL`）/ `both`。**插件侧零改动**，三模式通吃。

### 3.4 组合挂载

- 预设行：`- id: <id> / name: <包名或本地 .mjs> / config`（`standard/agent.cordis.yml`、`router-standard/agent.cordis.yml`）。
- "注册进 host `tools` 注册表、不提供服务"的工具插件**不需要 isolate realm**（standard 预设 L54–56 注释）。
- 本仓库 web 插件：`cordis.patch.yml` 把 host 模块（`lib/index.js`）插进组合，host 半体运行在 Host 面（已解析 `webServer`/`llm`/`fs`/`agentDefaultModel`）。

---

## 4. 实施方案

### 4.1 方案 A（推荐先做）：`dsh-assistant-optimization` Host 半体追加索引工具

在 `lib/index.js` 的 `apply(ctx)` 中追加（与现有 webServer 路由并列）：

```js
// 索引工具：移植 router-bootstrap-v34 的实现思路（全量名册 + 运行时标记 + 公开面降级）
const INVENTORY_FALLBACK = true   // layers 私有面不可用时，退化为 schemas() 可见集

function fullIndex(tools, scope) {
  const names = new Set()
  try {
    const view = typeof tools.view === 'function' ? tools.view(scope) : undefined
    for (const n of view?.knownNames ?? []) names.add(n)
  } catch { /* 私有面不可用 → 降级 */ }
  for (const s of tools.schemas(scope) ?? []) if (s?.name) names.add(s.name)
  const defs = new Map()
  try {
    const ls = tools.layers
    const layers = []
    if (ls?.global) layers.push(ls.global)
    if (typeof ls?.chainLayers === 'function') layers.push(...(ls.chainLayers(scope) ?? []))
    const own = typeof ls?.peek === 'function' ? ls.peek(scope) : undefined
    if (own) layers.push(own)
    for (const n of names) {
      for (const layer of layers) {
        const lt = layer?.tools
        const d = typeof lt?.get === 'function' ? lt.get(n) : undefined
        if (d) { defs.set(n, d); break }
      }
    }
  } catch { /* 保持降级 */ }
  return [...names].sort().map((n) => ({
    name: n,
    desc: defs.get(n)?.description ?? '',
    parameters: defs.get(n)?.parameters ?? {},
    visible: (typeof tools.view === 'function'
      ? (() => { try { return tools.view(scope)?.visible?.has?.(n) ?? false } catch { return false } })()
      : tools.schemas(scope).some((s) => s.name === n)),
  }))
}

function paramHint(parameters) { /* 同 v34 L262-277：props → 'name: type' 一行 */ }

const tools = ctx.get('tools')
if (tools !== undefined) {
  ctx.effect(() => tools.register({
    name: 'tools_catalog',
    description: '全量工具注册表索引：名称 + 一行摘要 + 可调标记。query 关键词过滤；domain 域浏览（file/exec/network/delegate/memory/other）。',
    parameters: {
      query:  { type: 'string', description: '关键词过滤（可选）' },
      domain: { type: 'string', description: '域过滤（可选）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const all = fullIndex(tools, exec.agent ?? undefined)
      const rows = all
        .filter((t) => !args.query || (t.name + ' ' + t.desc).toLowerCase().includes(String(args.query).toLowerCase()))
        // domain 启发式同 v34 L916-924
        .map((t) => `- ${t.name} [${t.visible ? '可调' : '未解锁'}] — ${t.desc.split(/\n|\. /)[0].slice(0, 90)} (${paramHint(t.parameters)})`)
      return rows.join('\n') || '（无匹配工具）'
    },
  }), 'dsao: tools_catalog')

  ctx.effect(() => tools.register({
    name: 'tools_help',
    description: '单个工具的完整 schema（参数/必需/描述）。精准调用前先查。',
    parameters: { name: { type: 'string', required: true, description: '工具名（tools_catalog 里查到的）' } } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const t = fullIndex(tools, exec.agent ?? undefined).find((x) => x.name === args.name)
      if (!t) return `未知工具: ${args.name}（先用 tools_catalog 查）`
      const props = t.parameters?.properties ?? {}
      const required = t.parameters?.required ?? []
      const lines = [`工具: ${t.name} [${t.visible ? '可调' : '未解锁'}]`, `描述: ${t.desc}`]
      for (const [k, v] of Object.entries(props))
        lines.push(`  ${k}: ${v?.type || 'any'}${required.includes(k) ? '（必需）' : ''} — ${v?.description || ''}`)
      return lines.join('\n')
    },
  }), 'dsao: tools_help')
}
```

要点：
- `tools` 保持**可选探测**（`ctx.get`）：无注册表的部署（headless/minimal）不阻断挂载；要硬依赖就移入 `inject`（Cordis 等待就绪）。
- `exec.agent` 传入 `schemas`/`view` → 标记与可见集**跟随调用方 scope**（每个 agent 各自的 restrict 视图），这正是 shim 的语义。
- 私有面访问全部 try/catch + 降级（与 shim 一致），dsh-tools 升级破坏 `layers` 结构时工具仍可用（只是少了锁定项的完整描述）。
- 行首不加阶段号（[可调]/[未解锁] 已由运行时可见面给出）；阶段号属于 router 预设的 `stages.json` 知识，若要显示需另配静态表（可选增强）。

### 4.2 动态插件版（会话内先验证，当天可跑）

按 `technical-reference.md` §8.3：`cordis_define({ code: { host: `<上面 fullIndex/paramHint/register 的纯 JS 版>` } })` → `cordis_run({ mode: 'run' })` → `cordis_inspect_self` 看诊断。host 代码无 import，直接传裸定义对象（§2.1 已确认注册接受裸对象）。验证通过后再固化进 `lib/index.js`。

### 4.3 方案 B（发布形态）：独立工具插件包

仿 `dsh-tool-cordis`：`name`/`inject: ['tools']`/`apply(ctx)` 注册两个工具（代码同上，去掉降级分支也可保留），打成 npm 包，任意预设加一行 `- id: tool-registry-index / name: '<包名>'` 即挂。适合"让所有预设/部署都能用索引"的目标；与方案 A 不冲突（A 是先行验证位）。

### 4.4 与 own-layer shim 的共存语义

- **同层重名才失败**（register 契约）。shim 的 `tools_catalog` 经 `installMetaShim` 注册在 **agent scope 层**；插件 A 的注册在 **全局层**（host 面 ctx）。scoped 遮蔽 global → **router 会话里 shim 版生效、非 router 会话里插件版生效**，互不冲突（这一层语义基于 dsh-tools 文档 + shim 代码推断，实机首跑确认一次即可）。
- 若未来想让插件版**取代** shim：把 `tools_catalog`/`tools_help` 从 `installMetaShim` 的注册列表移除（或 shim 检测全局层已有同名时跳过）即可。
- 门控侧：router 预设的每阶段 `restrict({allow})` 表（`META_ALL`）需要把插件工具名加入 allow（否则 router 会话里插件版被门控锁住）；shim 保留期内这条天然成立。

---

## 5. 验证计划

1. **动态插件**：`cordis_run` → `cordis_inspect_self` → 会话内 native 调 `tools_catalog`（无参全量 / `query=bash` / `domain=exec` 各一）；`run_code` 内 `await tools['tools_catalog']({})` 各验一次（本会话 presentation=both）。
2. **静态插件**：`dsh plugin build --profile web .` → `dsh plugin --profile web add .` → 重启 → 同上。
3. **负空间**：
   - router 预设挂载的会话（shim 在场）→ 确认 scoped 遮蔽生效、无挂载失败；
   - 非 router 会话 → 插件版全量可用；
   - 对某 agent `restrict({deny:['tools_catalog']})` → 索引自身被锁（预期，确认行为）；
   - code-only 部署 → 原生直呼 `UNKNOWN_TOOL`、SDK 路径正常（设计如此）;
   - 空 query/domain、无匹配 → 返回 `（无匹配工具）` 不报错；
   - 构造 `toolsSvc.layers` 不可用的场景（或 mock 缺省）→ 降级路径只列可见集、不抛错。
4. **交付 gate**：`delivery_check(file, { items: [{label, kind, result/target, reviewed?}] })` —— `kind=text/run` 带 `result`，`kind=file` 的 `target` 指向现存非空文件；页面类需 `kind=page` + `reviewed:true`（契约见 §2.4）。
5. **回放**：切走再切回会话，触发历史回放渲染，确认 `render` 纯函数无状态依赖。

---

## 6. 风险 / 未决项

- **私有面依赖（首要风险）**：全量索引 + 真标记依赖 `ToolRuntime.view/layers` 私有成员（`view()` 在 .d.ts 中是 private）。dsh-tools 跨版本升级可能改结构 → 必须保留 §4.1 的 try/catch 降级（降级后 = 仅可见集索引，功能收窄但可用）。若要求长期契约稳定，需向 dsh 上游要一个公开枚举 API（如 `list(scope?)`）——这是唯一需要上游配合的点。
- **未验证（实机首跑即消）**：① web 插件 Host 面 `ctx.get('tools')` 可解析（证据链：shim 以插件身份在 agent 面用 `ctx.tools`；`tools` 注册表在 host 面（standard 预设注释 "the registries themselves"）；本插件 host 半体已解析同面服务）；② scoped-shim 与 global-插件同名的遮蔽行为。
- **Prompt 缓存稳定性**：新增工具改变模型面 catalog → 请求缓存失效一次（standard 预设 plan-mode 注释明确要求 catalog 跨模式稳定）；description 保持静态。
- **披露面**：索引暴露全部工具名（含锁定项）+ 一行摘要。敏感部署应允许裁剪（inventory 化或配置过滤）。
- **范围界定**：若诉求是**客户端 UI 入口**（按钮/面板查索引）而非模型工具调用 → 走 `harness.handle` + slot（thinking-tags 模式）；两面可并存。
- **假设声明**：本报告"索引能力" = 本会话 bootstrap 标注 `tools_catalog (index)` 的注册表索引。若你指的是别的索引（如代码库索引），§3/§4 的插件工具注册机制同样适用，仅 `execute` 体换成你的索引服务。
