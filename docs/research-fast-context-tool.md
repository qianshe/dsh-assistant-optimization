# 调研/设计：把 fast-context（语义快速定位）内置为插件工具

> 目标：在 `dsh-assistant-optimization` 插件中内置一个**模型可调用的代码库快速定位工具**——对模糊/不清晰的查询，AI 多轮探索返回「文件 + 行范围 + grep 关键词」，模型再 `read` 对应行。
> 参考实现：`SammySnake-d/fast-context-mcp`（v1.3.2，"windsurf-fast-context"）——**移植其机制，不是把这个 MCP 拿来直接用**。
> 前置：工具注册机制已验证，见 `docs/research-index-as-tool-plugin.md` §3（`ctx.tools.register` + 裸定义对象 + 插件形态）。

> **实现状态（已落地，本文部分描述以 README 为准）：**
> - 采用 **key 门控**：工具 `context_search` 与其提示词段**仅在能解析到 Windsurf key 时**注册（无 key ⇒ 两者都不出现，模型不可调用）。见 `lib/fast-context/tool.js` + `key-source.js`。
> - key 解析链：`WINDSURF_API_KEY` 环境变量 → 手动填写（`~/.dsh/dsao-windsurf-key` / 设置页 / `PUT /api/dsao/windsurf-key`）→ 本地 Windsurf/Devin `state.vscdb` 自动读取。
> - 本地 key 读取改用 **Node 内置 `node:sqlite`**（先拷贝快照再只读打开），**不再依赖** `sql.js`/`better-sqlite3`——零新增原生依赖。
> - ripgrep 懒解析四级回退：`FC_RG_PATH` → 插件依赖 `@vscode/ripgrep` → PATH 上的 `rg` → **DSH 自身打包的 rg**（经宿主 `process.argv[1]` 的 `createRequire` 解析），标准部署零额外依赖。
> - 注入提示词精简为两句话（用途 + 模糊/不清晰搜索适用场景 + 最小调用形态），无背景/示例，<400 字符（测试断言）。

---

## 1. 结论

1. **fast-context 不是向量/embedding 语义检索**，而是 **LLM 代理式探索**：目录树（repo map）打底 → 模型每轮下发搜索命令 → 本地执行（ripgrep 等）→ 结果回喂 → 末轮强制结构化答案。"语义"来自模型对自然语言查询的理解 + 迭代收窄，不来自索引。
2. **参考实现的管道可近乎整体移植**：搜索循环 ~1000 行纯 JS；protobuf/Connect-RPC 是**自研模块**（无外部 protobuf 依赖）；真正的外部原生依赖只有 `@vscode/ripgrep`（打包的 rg 二进制）与 `better-sqlite3`（仅方案 A 的 key 提取用）。MCP 层（`server.mjs` + zod）完全不需要——DSH 的 `register()` 直接就是工具面。
3. **唯一实质决策是循环的"大脑"用谁**（见 §3.5）：
   - **A** 移植 Windsurf Devstral API（忠实复刻；需 `WINDSURF_API_KEY` 或从本地 Windsurf 的 SQLite 自动提取）；
   - **B** 用 DSH 自己的 `ctx.llm`（部署当前模型，**原生 tool-call 流已确认**：`StreamChunk.tool-call-delta{index,id,name,argumentsDelta}` + `block-end{block}`，比参考实现的 `[TOOL_CALLS]` 文本解析更稳）；
   - **C** A 主 + B 自动兜底（key 缺失/429/AUTH_ERROR 时切换）。
   循环体（tree→prompt→execute→feedback→force-answer）在 A/B 间**完全相同**，只有 brain 客户端不同 → C 的增量成本小（一个 brain 适配器接口）。
4. **注册方式**：Host 半体 `lib/index.js` 的 `apply(ctx)` 里 `ctx.tools.register({...})`（与现有 webServer 路由并列）；`tools` 服务可选探测（`ctx.get`），无注册表的部署不阻断挂载。
5. **天然改进点**：参考实现 `project_path` 缺省 `process.cwd()`；插件版应缺省**调用方 agent 的会话 cwd**（`exec.agent` → session header），MCP 版没有的上下文。

---

## 2. fast-context 机制实拆（参考仓库）

### 2.1 工具面（`src/server.mjs`）

```
context_search(
  query: string,              // 自然语言问题
  project_path: string="",    // 缺省 cwd
  tree_depth: 1-6 default 3,  // 目录树深度
  max_turns: 1-5 default 3,   // 搜索-执行-反馈轮数
  max_results: number,
  exclude_paths: string[]
)
env: WINDSURF_API_KEY / FC_MAX_TURNS=3 / FC_MAX_COMMANDS=8 / FC_TIMEOUT_MS=30000
```

### 2.2 搜索管道（`src/core.mjs` `searchWithContent` → `search`）

1. **repo map**：`getRepoMap(treeDepth)` 建目录树；超 250KB 自动降级 depth 3→2→1→普通 `ls`；路径虚拟化到 `/codebase`。
2. **初始 prompt**：`WINDSURF_PROMPT_TEMPLATE`（内嵌 max_turns/max_commands/max_results）+ repoMap + query。模型任务：给出与查询相关的全部文件路径 + 行范围。
3. **每轮请求 Windsurf API**：Connect-RPC over HTTP/1.1，**protobuf + gzip 帧**（1B flag + 4B BE 长度 + payload，`connectFrameEncode/Decode` 自研实现）。端点：
   - 流式：`https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService/GetDevstralStream`
   - 认证：`.../exa.auth_pb.AuthService/GetUserJwt`（API key 换 JWT，缓存/刷新）
4. **模型响应解析**：解码 Connect 帧 → 提取 `[TOOL_CALLS]name[ARGS]{json}` → 工具名 `restricted_exec`。
5. **本地执行**（`src/executor.mjs`，每轮最多 `max_commands=8` 并行）：命令白名单 **`rg` / `readfile` / `tree` / `ls` / `glob`**；
   - `rg`：`@vscode/ripgrep` 二进制，`--no-heading -n --max-count 50 <pattern> <path>` + `--glob`（include/exclude），30s 超时，无纯 JS 回退；
   - 结果作为 `tool_result` 消息回喂 → 下一轮。
6. **末轮**：注入 `FINAL_FORCE_ANSWER` user 消息，强制给出最终答案。
7. **最终答案**：模型输出 XML
   ```xml
   <ANSWER>
     <file path="/codebase/src/auth/handler.py">
       <range>10-60</range><range>120-180</range>
     </file>
   </ANSWER>
   ```
   `_parseAnswer` → 格式化文本：
   ```
   Found 3 relevant files.
     [1/3] /project/src/auth/handler.py (L10-60, L120-180)
     ...
   grep keywords: authenticate, jwt.*verify, session.*token   ← 搜索过程中用过的 rg pattern
   [config] tree_depth=3, tree_size=12.5KB, max_turns=3
   ```

### 2.3 认证 / 限流 / 错误

- **key**：`WINDSURF_API_KEY` env 优先；否则 `extractKey()` 自动提取——Windows：`%APPDATA%\Windsurf\User\globalStorage\state.vscdb`（SQLite，`better-sqlite3` 读，取 `api_key`）。
- **限流**：`CheckUserMessageRateLimit` 预检；HTTP 429 → 退避重试（`maxRetries`），其他 4xx 不重试。
- **错误码**：`TIMEOUT | PAYLOAD_TOO_LARGE | RATE_LIMITED | AUTH_ERROR | SERVER_ERROR | NETWORK_ERROR`。
- **依赖**（README）：`@modelcontextprotocol/sdk`（不需要）、`@vscode/ripgrep`、`tree-node-cli`（可用纯 node:fs 替代）、`better-sqlite3`（仅 A）、`zod`（不需要）。

---

## 3. 内置到插件：设计

### 3.1 工具定义（模型面）

```js
{
  name: 'context_search',
  description: '代码库模糊搜索：AI 多轮探索，返回相关文件的候选行范围 + 建议 grep 关键词。当你不知道要读哪个文件、查询比较模糊时用；拿到结果后对返回的行范围用 read。',
  parameters: {
    query:        { type: 'string',  required: true,  description: '自然语言问题/描述（如"认证 token 过期在哪里处理"）' },
    project_path: { type: 'string',  description: '项目根目录；缺省=当前会话工作目录' },
    tree_depth:   { type: 'integer', description: '目录树深度 1-6，默认 3' },
    max_turns:    { type: 'integer', description: '搜索轮数 1-5，默认 3' },
    max_results:  { type: 'integer', description: '最大返回文件数' },
    exclude_paths:{ type: 'array',   description: '额外排除路径 glob' },
  },
  output: {
    schema: { type: 'string' },            // 与 shim 同款：字符串输出回放最稳
    render: (_a, v) => [{ type: 'text', text: String(v) }],
  },
  timeoutMs: 120000,                        // 3 轮 × (模型 + 命令执行)，实测后调
  isConcurrencySafe: () => true,            // 只读
  execute: async (args, exec) => { /* §3.4 循环；全程观察 exec.signal */ },
}
```

可选引导（`ctx.systemPrompt.section({name:'tool:context_search', order: 150, text: '模糊的代码库问题先用 context_search 定位文件与行范围，再 read 对应区间。'})`）。

### 3.2 文件布局（本仓库）

```
lib/index.js                  # Host 半体：apply(ctx) 追加工具注册（与 webServer 路由并列）
lib/fast-context/core.js      # 搜索循环（移植 core.mjs 的 search，去 MCP 层）
lib/fast-context/executor.js  # 本地执行器（移植 executor.mjs：rg/readfile/tree/ls/glob）
lib/fast-context/tree.js      # getRepoMap（纯 node:fs 实现 + 250KB 降级，免 tree-node-cli 依赖）
lib/fast-context/brain-ws.js  # [仅 A/C] Windsurf brain：Connect-RPC/protobuf/gzip + JWT + key 提取
lib/fast-context/brain-llm.js # [仅 B/C] DSH brain：ctx.llm.stream 原生 tool-call 循环
lib/fast-context/answer.js    # XML 答案解析 + 格式化输出（_parseAnswer 移植）
```

- `package.json`：`dependencies` 加 `@vscode/ripgrep`（A/C 再加 `better-sqlite3`）；`files` 已含整个 `lib/`，新目录自动随包。
- lib/ 内联代码手工维护（§8.4 既有约定）；`dsh plugin build --profile web .` 做打包验证。

### 3.3 执行器与 Host 能力对齐

- Host 半体运行在 DSH host 进程（普通 Node）：`child_process.spawn` 可用（webServer 路由已在同面运行，无沙箱限制——沙箱只约束模型面的 bash/pwsh 工具）。
- **rg**：`@vscode/ripgrep` 的 `rgPath`（跨平台打包二进制；DSH 自身也依赖该包，win32-x64 二进制已在其 node_modules）。
- **tree/ls/glob**：纯 `node:fs` 实现（免 `tree-node-cli` 依赖）；glob 用简单递归匹配即可（执行器内部用，非模型面）。
- **readfile**：`node:fs` 读 + 行/字节上限（防 250KB+ 打爆 payload → `PAYLOAD_TOO_LARGE` 保护）。
- **取消**：`exec.signal`（agent 中断）→ `AbortController` → 中止在途 HTTP（A）/kill 子进程。

### 3.4 循环骨架（A/B 共用）

```js
async function fastContextSearch(ctx, args, exec, brain) {
  const root = resolveProjectRoot(args, exec)        // args.project_path → 会话 cwd → process.cwd()
  const tree = getRepoMap(root, args.tree_depth ?? 3) // >250KB 自动降级
  const messages = [systemTemplate(args), userMsg(tree, args.query)]
  const usedRgPatterns = []
  for (let turn = 0; turn < (args.max_turns ?? 3); turn++) {
    if (exec.signal?.aborted) throw new Error('cancelled')
    if (turn === (args.max_turns ?? 3) - 1) messages.push({ role: 'user', content: FINAL_FORCE_ANSWER })
    const resp = await brain.stream(messages, EXEC_TOOL_SCHEMA, exec.signal)  // brain 适配器
    const calls = resp.toolCalls                              // [{name:'restricted_exec', args:{command}}]
    if (calls.length === 0) return formatAnswer(resp.answerXml, usedRgPatterns, args)
    const results = await Promise.all(calls.slice(0, 8).map(c => runCommand(root, c, args.exclude_paths, exec.signal)))
    collectRgPatterns(calls, usedRgPatterns)
    messages.push(assistantToolCalls(calls), toolResults(results))
  }
  return formatAnswer(/* 末轮答案 */ , usedRgPatterns, args)
}
```

- **brain 适配器**：`stream(messages, toolSchema, signal) → { toolCalls, answerXml }`
  - **A**：`brain-ws.js` 移植 Connect-RPC 帧编码 + protobuf 请求构造（自研模块原样搬）+ JWT 认证 + `extractKey()`；响应解析 `[TOOL_CALLS]name[ARGS]{json}`。
  - **B**：`brain-llm.js`：`ctx.llm.stream({ provider, model, system, messages, tools: [EXEC_TOOL_SCHEMA] })`（`GenerateOptions.tools` 已确认存在）；消费 `tool-call-delta`（累积 `argumentsDelta`）+ `block-end` 组装 `toolCalls`；`provider/model` 取 `ctx.get('agentDefaultModel').currentSelection()`——与 prompt-enhance 同一服务模式。
  - **C**：`brain = wsBrain ?? llmBrain`；A 抛 `AUTH_ERROR`/`RATE_LIMITED`(重试耗尽)/`NETWORK_ERROR` 且无 key 时切 B，输出附一行 `[fallback: local model]`。
- **会话 cwd**：`exec.agent` → session header 的 cwd 字段（`agent-loop` 的 `create(id, options, meta: Pick<SessionHeader,'cwd'>)` 表明 header 携带 cwd；**精确字段路径用动态插件探测一次确认**，见 §4）。

### 3.5 大脑决策点（互斥三选）

| | A：仅 Windsurf Devstral | B：仅 DSH ctx.llm | C：A 主 + B 兜底（推荐） |
| --- | --- | --- | --- |
| 忠实度 | 100%（参考实现即此） | 机制同、模型不同 | A 在场时 100% |
| 外部依赖 | 非官方端点 + key（env 或 state.vscdb 提取）+ better-sqlite3 | 无 | 同 A |
| 密钥/ToS | 有（非官方 API 调用，灰色地带；读本地 Windsurf 数据需明示） | 无 | 有（仅 key 在场时激活） |
| 无 key 时 | 功能不可用 | 可用 | 自动降级 B |
| 工作量 | 中（搬 protocol + 执行器 + 循环） | 小（循环 + 执行器 + 原生 tool-call） | 中 + 小（brain 适配器接口） |
| 风险 | 端点/协议无通知变更；429 | 效果取决于部署模型；一次搜索 ≈1-5 次模型调用 | 两者叠加，但相互兜底 |

> 说明：C 推荐 = 尊重"Windsurf fast-context"本意（A 为主路径）+ 工程稳健性（key 失效 ≠ 功能死亡）；brain 适配器使 A/B 共享 90% 代码，增量小。若你确定长期只跑 Windsurf 且接受端点风险 → A 最简。

### 3.6 验证顺序（先跑通管道，再接大脑）

1. **单元（`node --test`，沿用 `test/*.mjs` 风格）**：
   - `tree.js`：小仓库 depth=3 正确；>250KB 降级链 3→2→1→ls；
   - `executor.js`：rg 命中已知符号（含 include/exclude）、readfile 行上限、超时、白名单外命令拒绝；
   - `answer.js`：正常/畸形/缺 file 的 XML 解析；grep keywords 收集；
   - `core.js`：mock brain（固定命令序列）→ 3 轮收敛 → 末轮 force-answer → 格式化输出。
2. **动态插件**（`cordis_define` `code.host` 纯 JS 版：注册简化工具，brain 先用 B——无 key 依赖）→ `cordis_run` → 会话里问模糊问题（"这个插件的 diff 徽标在哪个文件哪几行"）验证定位质量。
3. **静态固化**：整合进 `lib/` → `dsh plugin build --profile web .` → `dsh plugin --profile web add .` → 重启 → 全量验证。

---

## 4. 验证计划（交付级）

1. **双面调用**：native 直呼 `context_search` + `run_code` 内 `await tools['context_search']({query})`（本会话 presentation=both，两面都要通）。
2. **负空间**：
   - 无 key（A/C）→ 清晰报错或 fallback 行（C）；
   - `project_path` 不存在 → 明确错误不挂起；
   - 空 query / 无结果仓库 → "未找到" 类文本，不报错；
   - `max_turns=1` 单轮收敛；`tree_depth` 越界钳制；
   - agent 中断（exec.signal）→ 循环与子进程及时终止；
   - code-only 部署 → 原生直呼 `UNKNOWN_TOOL`、SDK 路径正常（设计如此）。
3. **效果基线**：同一组 5 个模糊问题，对比 ①直接 grep/人工 ②context_search 的命中文件与行范围准确度（记录 tree_size/轮数/耗时）。
4. **交付 gate**：`delivery_check(file, { items: [...] })`——`kind=text/run` 带 `result`、`kind=file` 的 `target` 现存非空（契约：`kind ∈ file/page/image/run/test/text`）。
5. **回放**：切走再切回会话，历史回放渲染确认 `render` 纯函数。

---

## 5. 风险 / 未决项

- **非官方端点（A/C 首要风险）**：`server.self-serve.windsurf.com` 的协议无契约承诺，Windsurf 升级可能静默破坏 → 以参考实现 v1.3.2 为基线，坏时降级 B（C）或明确报错（A）。
- **key 隐私（A/C）**：`state.vscdb` 提取 = 读用户本地 Windsurf 应用数据；必须文档明示 + env 变量优先 + 不随包/日志外泄。
- **成本/延迟（B/C）**：一次搜索 ≈ 1-5 次模型调用 + 30s~2min；`timeoutMs` 先给 120s 实测调。
- **payload**：repoMap 250KB 上限 + readfile 行/字节上限（`PAYLOAD_TOO_LARGE` 保护）；超大 monorepo 靠 depth 降级。
- **安全面**：模型可控 query/path → `project_path` 必须校验为现存目录；默认排除 `node_modules/.git/dist/build/coverage/.venv/__pycache__/vendor` 等；Host 插件可读用户可读的一切路径（与 host 插件同等信任级，文档注明）。
- **模型能力（B/C）**：`ctx.llm` 原生 tool-call 要求部署模型支持 function calling；不支持的 provider 需文本解析回退（或限制 B 到支持的模型）——**实机验证项**。
- **未验证（实机首跑即消）**：① `exec.agent` → session cwd 的精确字段路径（动态插件探测）；② web 插件 Host 面 `ctx.get('llm')`/`ctx.get('agentDefaultModel')` 可解析（prompt-enhance 路由已在同面用这两个服务，证据已强）；③ 各 provider 的 tool-call 流块兼容性。
- **UI**：v1 用通用工具卡片；后续可注册 `tool.call.toolview` key `context_search` 做专属卡片（文件列表 + 行范围高亮），见 technical-reference §3.4/§8.2。
- **范围界定**：若将来要"离线/零模型调用"的定位（纯算法），那是 ripgrep + 符号索引路线，与 fast-context 是两条路，不在本设计内。
