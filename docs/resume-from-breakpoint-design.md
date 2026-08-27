# PRD：断点续发（Resume-from-Breakpoint）

> **状态**：v0.2 草案（需求粒度已澄清：重发对象 = agent 工作流中的**一次 LLM 请求调用**）
> **范围**：DSH web profile 会话消息链路的"中断后免输入续跑"能力
> **关联版本**：平台 `@deepseek-ai/dsh` 0.1.1-rc.2；本插件 `dsh-assistant-optimization` 1.5.3
> **文档位置说明**：按本仓库惯例放 `docs/`（未用 skill 默认的 `tasks/`，仓库无此目录）
> **v0.1 → v0.2 变更摘要**：删除"补定稿锚点"故事与 A/B/C 执行梯子（粒度澄清后不再需要）；主线收敛为**调用级重放——撤尾 + 重跑那一次请求**；阻塞点从 7 条收敛为 5 条

---

## 0. 决策记录（已与需求方确认）

| # | 决策 | 内容 |
|---|---|---|
| DR-0 | **重发粒度** | 重发的对象是一次 **LLM 调用请求**（step 级），不是 user prompt，也不是半截文本的字节级续写。"继续" = 把出错/中断的那次调用原样重跑 |
| DR-1 | 回退预算 | 可接受倒退一两次 LLM 调用换取成功率保底（与 DR-0 天然一致：重放本身就是"重来这一步"） |
| DR-2 | 错误场景 | 报错终止可能带半截内容（如模型配额中途耗尽），切模型后重放同样成立：内容整体重新生成，不依赖残稿 |
| DR-3 | 触发形态 | 复用发送按钮做三态：可继续时中间图标变播放键 ▶，其余保持原样 |
| DR-4 | 红线 | 不向会话注入任何「继续」类提示文本 |

跳过澄清提问的理由：DR-0 即本轮澄清产物（此前 v0.1 曾误读为"续写半截文本"，已在 v0.2 全文校正）。

## 1. 引言

回复流因报错或手动中断停止后，用户目前只能打字（输入「继续」之类）再发。本功能让系统在**非正常终态**下把发送按钮变成播放键 ▶，一次点击、零输入即可**把中断的那次 LLM 调用原样重跑**。

调研结论先行：**可行**。一个 turn 内的多次调用天然可分步重试（turn = step 循环）；消息序列无 "user 结尾" 约束；受阻点集中在"免输入触发入口"，最大硬阻塞是 Agent 公开接口没有"免消息唤醒"（§8）。

### 1.1 为什么 v0.2 更简单了（粒度澄清的连锁收益）

v0.1 围绕"字节级续写"设计了补锚点、A/B/C 梯子等机制。澄清为"调用级重放"后：

- **补锚点整个消失**。重放不需要残稿参与——模型从头重新生成该次调用的输出。报告中途死掉的内容不必追认进历史（BLK-6 上游口径问题随之蒸发）。
- **A/B/C 梯子坍缩成一个策略**："撤尾 + 重放"。手动停止留下的半截锚点若留在模型视野里，会让下一次请求变成"assistant 结尾的续写"；重放语义要求把它撤出模型可见面（surface replace），这正是原 B 档的既有设计。
- **唯一不变的是准入闸门**（见 §4 时序第 ③ 步注释）。

## 2. 目标

- 空草稿 + 非正常终态（中止/出错/max-tokens）时，发送键呈现 ▶ 态，单击即重放中断的那次调用
- "记录"零成本：调用素材天然全量落在会话日志中（user/message、tool/call+result、chunk、锚点），无需新建任何存储
- 任何场景最坏倒退 ≤2 次调用（DR-1）
- 人读聊天记录审计无损：撤尾只影响"下一次请求的消息序列"，不动 append-only 日志
- 刷新页面/服务重启后 ▶ 门控状态仍存活（全部信号来自可重放投影）

### Non-Goals

- 不做字节级断字续写（那是被放弃的原 A 档语义）
- 不做多档策略自动选择（只有一条策略：撤尾 + 重放）
- 不改变报错自动重试的现有行为（平台自带 `agent/request-error` retry 基建照旧工作；本功能处理的是它覆盖不到的手动中止与耗尽后的兜底）

## 3. 现状事实基础（调研结论摘要）

### 3.1 发送链路（按钮 → LLM → 流式 → 中断 → 落库）

```
UI 键盘/点击 ─ InputMachine.submit ─▶ defaultSink ─▶ conversation.sendSession
    │ (@ds/dsh-client-ui-conversation lib/client.js)
    ├─ 空稿拦截: onEnter trimmed==="" 直接吞事件 (L821-822)；sink() 对 ""+无图短路假成功 (L1578)
    ▼
session.prompt RPC (client-runtime lib/client.js L7196-7257；cancel L7304-7336 keepInbox)
    ▼
/api 路由表 (host-apiproxy fetch/handler.js L23-37; session.cancel→agent.cancel({kind:'user'},{keepInbox:true}) api-proxy.js L2239-2252)
    ▼
api.sessions.prompt 校验+持久内容 (api-proxy.js L2077-2136; durablePromptContent L51-61)
    ▼
Agent 收纳 (agent-loop lib/index.js send/followup/steer/inject L390-404)
    ▼
turn()/preStep()/step() (L516-688): user/message append(L554) → buildRequest(messages=session.deriveMessages(), L693-762) → 流式 chunk 逐条落库(L621-626) → 锚点提交(L665-681)
```

### 3.2 中断终态 × 调用级重放的适用性

| 终态 | 持久化了什么 | 重放动作 |
|---|---|---|
| 手动停止（有可见输出） | `assistant/message{interrupted:true}` 半截锚点 + `turn/end{aborted,user}`（L629-649） | 撤出锚点（§4 步骤②），重放中断的那次调用 |
| 流中报错（配额耗尽等） | chunk 已落库但**无锚点**（catch 仅 signal.aborted 才定稿）；模型序列里没有这半截内容 | **天然干净**：直接重放即可，无需任何清理 |
| finish 级错误 / 首 token 前死亡 | 无 chunk 无锚点，仅 `turn/end{error}` | 同上，直接重放 |
| max-tokens 截断 | 完整锚点已提交（L682 前），正文被截断 | 与手动停止同：撤出锚点后重放（否则会被当作已完成回答） |
| 进程崩溃 | 重载时 `interruptedTurnClosers` 合成 tool 结果与 turn/end{interrupted}（dsh-session repair.js） | 日志自洽，重放规则同上 |

> 关键洞察：**报错中途死是"最便宜"的重放入口**（什么都没留下）——这恰是 DR-2 的主场景；手动停止因有锚点反而多一步"撤尾"。撤尾的两个特例（部分工具结果已落库、多步 turn 的撤回边界划分）见 OD-2 / BLK-4。

### 3.3 关键不变量与现成设施

- 每次请求 = `deriveMessages()` 从 surface 全量重建（surface.js 仅投影 user/message、assistant/message、tool/result 三类，L11-15/L71-103）。**没有任何"末条必须是 user"的校验**
- 服务面现成：`ctx.agents.get(id)/register/list`（dsh-agent README §registry）、`agent/pre-step` waterfall 可改写进入 step 的消息（agent-loop L492-513）、wake latch 处理 abort 收敛竞态（agent.d.ts L38-45）
- 撤尾所需替换机制现成：`surfaceOp:'replace'` 遮蔽既有节点并触发派生缓存重建（session index.js L1546-1558）；约束：tool/result 替换仅许改内容且单节点（surface.js L222-249）
- 人读转录走 append-origin 事件、不受替换影响（surface.js L35-47）——撤尾对模型生效、对审计无害
- 报错自动重试已是基建：`agent/request-error` waterfall + llm/retry 记录（L651-663）——其语义与"调用级重放"同构，本功能可视作它的手动兜底延伸

## 4. 方案设计

### 4.1 核心流程：撤尾 + 重放（单策略）

```
▶ 点击
 ├─ ① 前置校验: agent idle ∧ 末次终态∈{aborted,error,max-tokens}（复用门控谓词 FR-1）
 ├─ ② 撤尾: 若存在被打断/截断的 assistant 锚点 → 组装 surface replace 事件将其撤出模型可见面
 │        （无锚点的报错场景跳过此步；锚点含配对 tool/call+result 时按平台校验拆分组合）
 ├─ ③ 准入: 使一次"免注入消息唤醒"发生（Route α：resume() 接口；β：空块标记消息入列，二选一，见 §7）
 └─ ④ 重放: 新 turn 的首次 provider 调用即等价于重发那次的请求形态 —— 因为
          buildRequest(messages=deriveMessages()) 在撤尾后恢复到中断前一刻的样子，
          加载同一 provider/model 配置即得到与上次几乎一致的请求体
```

> **关于步骤③为什么仍然存在**：哪怕只重放一次调用，进入 step 的前提仍是收件箱有可领取消息（agent-loop L543-546 对空收件箱直接短路 completed）。这是 Agent 驱动器的固有契约，与"续写还是重放"无关——所以免输入触发通道依旧是先决条件。

### 4.2 发送按钮三态

| 态 | 中间图标 | 触发条件 | 点击行为 |
|---|---|---|---|
| 运行中 | ■（现状） | 有活动轮次 | 取消（keepInbox） |
| 待发送 | ✈（现状） | 空闲且草稿非空，或挂了图片 | 正常 prompt |
| **可继续** | **▶** | 空闲、草稿为空、无挂图、队列为空，末次终态 ∈ {aborted, error, max-tokens} | 触发 §4.1 流程 |

仲裁优先级：running ■ > send ✈ > play ▶ > noop。资产复用现成的 `IconPlayOutline16`。

### 4.3 可见性渲染

- 手动停止后被撤尾的旧稿在人读转录里保留原位，客户端折叠为弱化块 + 标注「上次输出已撤回并重新生成」；
- 报错场景本来就没有锚点，用户看到的就是错误条消失、新的流式输出开始；
- 识别信号纯投影可得（turn 终态 + 相邻关系 + 是否发生 replace），客户端本地计算，零新增下行事件。

## 5. 用户故事

### US-001: 免输入触发端点
**Story Type:** backend
**Depends on:** None
**Description:** 作为用户，我希望在非正常终态下免输入地唤醒会话，让中断的那次调用得以重跑。
**Acceptance Criteria:**
- [ ] 新增免输入触发入口（上游 `resume()` 接口或等效 wire 方法），受理前置条件：目标 agent 为 idle 且满足 FR-1 门控谓词
- [ ] busy 时返回结构化 busy 错误码而非排队
- [ ] 触发成功后产生新 `turn/start`，且第一步请求的消息序列**不含任何新增用户文本块**（FR-9）
- [ ] typecheck 通过；触发逻辑有单元测试

### US-002: 撤尾执行器
**Story Type:** backend
**Depends on:** US-001
**Description:** 作为系统，我需要把被打断/截断的 assistant 输出撤出下一次请求的消息序列，使重放恢复中断前的请求形态。
**Acceptance Criteria:**
- [ ] 判定分支正确：有撤回对象（组装 replace）/ 无（直通）（对应 FR-4 收敛后的两分支）
- [ ] replace 事件通过 surface 校验器：sourceEventSeqs 引用更早 seq；范围含 tool/result 时按"单节点仅内容替换"约束拆分组合（FR-6）
- [ ] 幂等：重复触发不产生第二个 replace
- [ ] 单测覆盖三分支判定、幂等与校验器交互；`node --test test/` 通过

### US-003: 发送按钮三态
**Story Type:** ui
**Depends on:** US-001
**Description:** 作为用户，我要在不打字时看到播放键 ▶ 表示"可重跑"，其余时候按钮一切照旧（DR-3）。
**Acceptance Criteria:**
- [ ] 门控谓词按 FR-1 实现；优先级仲裁按 FR-2 实现
- [ ] 图标态资产复用 `IconPlayOutline16`；aria-label 与 tooltip 成对中英文（FR-11）
- [ ] 点击接线到 US-001 入口并即时转入运行中视觉；再次停止回到 ▶；跑完回 ✈（闭环）
- [ ] 浏览器实测（本地 dsh web，playwright 或人工冒烟记录截图）

### US-004: 结果渲染
**Story Type:** ui
**Depends on:** US-002
**Description:** 作为用户，我要能分辨"这是重新生成的完整回答"，且复核被撤掉的旧稿。
**Acceptance Criteria:**
- [ ] 撤尾折叠块可展开复核；标注文案 i18n 两语言齐备（FR-8 收敛版）
- [ ] 无锚点的报错场景不出现任何多余 UI 残留
- [ ] 浏览器实测各一次

### US-005: 场景验证矩阵落地
**Story Type:** qa
**Depends on:** US-002, US-003, US-004
**Description:** 用 §6 矩阵完成验收并留档证据。
**Acceptance Criteria:**
- [ ] S1–S6 全绿，每项附最小复现步骤与结果记录
- [ ] 错误注入方式落地（自建 SSE stub 或真实配额复现，见 BLK-5）

## 6. 功能需求

- FR-1 门控谓词：`idle && draft.trim()==="" && images.length===0 && queue.empty && lastTerminal ∈ {aborted,error,max-tokens}`
- FR-2 按钮优先级：running(■) > send(草稿/图片) > play(▶) > noop
- FR-3 ▶ 点击 = 触发撤尾+重放流程 → 立即本地进入 running 视觉；失败回滚到 ▶ 并显示原因
- FR-4 尾部预检两分支：有被中断/截断的锚点 → 先撤尾再重放；无 → 直接重放
- FR-5 撤尾幂等：同一锚点至多产生一个 replace 事件
- FR-6 撤尾替换事件组装遵从平台校验器：范围含 tool/result 时按"单节点仅内容替换"规则拆分组合
- FR-7 渲染判据只依赖可重放投影数据，客户端本地计算，零新增下行事件
- FR-8 零注入硬约束：任何路径不得在派生历史里新增"继续"语义的用户/系统文本
- FR-9 队列非空时不点亮 ▶（插队手势保持既有语义，两者条件互斥）
- FR-10 文案对：zh「继续生成 / 上次输出已撤回并重新生成」en "Resume generation / Previous output was withdrawn and regenerated"
- FR-11 门控状态跨刷新存活（全部由日志重放推导）

## 7. 实施路线对照

| 维度 | Route α：上游核心小改（主推） | Route β：本插件全量兜底 |
|---|---|---|
| 免输入准入 | Agent/loop 加 `resume()`（绕过 turn() 空收件箱短路 agent-loop L543-546）+ wire 层方法 | `followup(空块标记消息)` 入列；**无法做到零注入**，只能选空块 user（wire 风险，BLK-3）或最小哨兵文本（违 DR-4） |
| 撤尾位置 | loop 感知 interrupted 锚点并随 resume 清理，契约干净 | 插件经 ctx.agents.get(id) 取活体后以 session.append 追加 replace 事件，职责边界靠纪律维持 |
| 按钮三态 | 改 dsh-web-frontend 输入组件，需重建前端 dist | cordis.patch 遮蔽组件委托回去（本项目成熟工艺）；保底=旁挂兄弟按钮（星形按钮先例已证可行，形态打折） |
| 升级兼容风险 | 随上游发版演进，稳定 | 平台内部变动即碎，需版本 pin + 自愈检查 |
| 工作量级 | 中小（接口面扩展 + 一处短路例外） | 中偏高（含 workaround 维护成本） |

结论：粒度澄清后 α 的改动面进一步缩小（不再需要任何锚点定稿逻辑）；β 的两处妥协保持不变。

## 8. 阻塞点（开工前必读）

| 编号 | 等级 | 描述 | 依据 | 解除动作 |
|---|---|---|---|---|
| BLK-1 | 🔴 硬 | Agent 公开接口只有 send/followup/steer/inject/cancel（agent.d.ts L32-36），**无免消息唤醒**；ReactLoopAgent.turn() 对空收件箱直接 completed 短路（index.js L543-546）。α 线必须改此处；β 线原则性缺口在于"要进 step 必须有可领取消息"，绕不过零注入红线 | 本文档 §4.1 注释 | 确认 deepseek-harness 源码通道 → 提交 `resume()` 小改；否则 β 下做 wire 冒烟后在空块/哨兵间取舍（OD-2） |
| BLK-2 | 🔴 硬（随 α 生效） | 本机仅有 npm 编译产物（node_modules 内 lib/*.js + dist），无 monorepo checkout；改核心/前端都需 github.com/deepseek-ai/deepseek-harness 访问权 + pnpm 构建 + 前端重建发布链 | package.json repository 字段；本机目录勘察 | 申请仓库访问或确立 fork-patch 发布方式；在此之前 α 无法排期 |
| BLK-3 | 🟡 中 | 空块 user message（content:[]）的跨适配器序列化行为未验证：pi-ai 三套 API（openai-completions/anthropic-messages/openai-responses）接受度不一，可能被拒 | durablePromptContent 对 [] 原样返回；api-proxy.js L51-61 | 一次 wire 冒烟实验（真实或 stub 端点）在三 API 各发一条空块请求观察 |
| BLK-4 | 🟡 中 | 多步 turn 里撤回边界怎么划：中断可能发生在第 N 次调用（如第 2 步的工具轮之后），"那次调用之前的完整成果"应保留、仅撤最后一次的不完整输出；边界识别需要精确的事件区间规则 | agent-loop step 循环结构（L531-572） | 设计时产出"撤回区间推导规则"并通过 US-002 单测固化 |
| BLK-5 | 🟡 中 | 平台自带 dsh-llm-mock-server 未随安装（目录不存在于本机 node_modules），错误注入场景缺官方确定性工具 | glob 验证 IO error | 自建最小 SSE stub（可控 mid-stream error/finish kind），或真机制造一次配额失败留档 |
| BLK-6 | 🟢 软 | β 若要精确"图标内嵌替换"，需遮蔽 ui-conversation 输入组件；该组件是否在已被实践遮蔽过的范围内未查证。旁挂按钮可行有先例（本项目 prompt-enhance 星形按钮、"conversation.chat.assistant-actions" 条带声明） | 本仓 README；message-feedback README | 定位输入区组件导出面，试遮蔽一个属性级改动验证通道 |

**唯一先决闸门**：BLK-1 + BLK-2 的路线抉择。它决定后续所有故事的宿主包与 AC 细节，其余阻塞均可并行推进。

*（v0.1 原 BLK-6「上游补锚口径对齐」已删除：粒度澄清后不存在补锚行为。）*

## 9. 验证矩阵

| # | 场景 | 注入方式 | 期望 |
|---|---|---|---|
| S1 | 手动停止半截文本 → ▶ | 真 UI 操作 | 锚点撤出模型面；旧稿折叠可展开；重放生成完整回答 |
| S2 | 配额中途死 → 切模型 → ▶ | stub 在流中途抛错 | 天然干净重放（无锚点无残留）；换 provider 后上下文完整 |
| S3 | 无内容错误 → ▶ | stub 首 token 前失败 | 直接重放，无多余 UI |
| S4 | 工具轮中止（只读工具）→ ▶ | 停止按钮 | 合成 ABORTED_BEFORE_DISPATCH 配对保留，模型据提示自行决定重派发 |
| S5 | 队列非空 + 空草稿 Enter | UI 构造 | ▶ 不亮；Enter 保持 steerQueue 行为 |
| S6 | 正常 completed 轮 | 完成 | 不出现 ▶ |
| S7 | 刷新页面后 | F5 | ▶ 态存活性与刷新前一致 |

## 10. 交付计划

1. **闸门**：BLK-1/BLK-2 路线抉择——第一优先，其余并行
2. US-001（触发骨架，TDD）→ US-002（撤尾执行器：判定、replace 组装、幂等、区间规则，全部 `node --test` 可先行）
3. US-003 按钮 → US-004 渲染
4. US-005 矩阵回归留档；上线前核对平台版本兼容清单（β 必须）

## 11. 成功指标

- 全部残局场景在 ≤2 次额外调用内推进到正常输出（US-002/US-001 生效口径）
- 报错中途断流（DR-2 主场景）后续跑成功率 100%（因为无需撤尾，路径最短）
- 门控误亮率 0：正常完成的轮次绝不出现 ▶（S6/S7 为回归红线）
- 人读转录零丢失：任何撤尾操作后，旧稿仍可在 UI 展开（append-only 保证 + 折叠块验收项）

## 12. 开放问题

- OD-1：正常 completed 轮要不要也提供 ▶（等同"再往下说一点"）？当前默认：不给，避免与普通发送混淆
- OD-2：多步 turn 的撤回区间边界规则细节（BLK-4 的设计产物，随 US-002 定稿）
- OD-3：报错耗尽重试后的**自动**续跑开关，挂 v2 还是 v1 附带开关？

## 13. 实施前深调研结论（四个知识缺口全部核实）

| 缺口 | 结论 | 关键证据 |
|---|---|---|
| G1 β 准入：标记消息的完整路径 | **可行，残余不确定性收窄为"标记内容本身"**。pre-step waterfall 的决策消息被原样消费（turn 循环仅检查 `decision.messages.length===0`），`decision.messages` 里的一切都会成为持久 user/message 进入模型序列——所以免输入触发必然留下一个标记 user 块，能选的只是它的内容形态（空块/哨兵文本）。**重要旁证**：今天用户"停止后打字继续"走的就是「interrupted 锚点 + 新 user」请求形态，各家 provider 对此已被日常流量验证容忍——我们缺的证据只剩"空块"这一小格 | agent-loop index.js L492-514（waterfall 无条件执行）、L542-554（决策消费与追加）；dsh-agent runtime-types.d.ts L48-53 |
| G2 撤尾边界规则素材 | **事件齐备**。log 里 `step/start`、`step/end`、`assistant/chunk`、`tool/call`、`tool/result` 全部携带 `{turn, step}` 二元组 → 第 N 次调用的事件区间可以精确切出；锚点属于其所在 step。撤回规则 v1 = 只撤最后未完结 step 的表面节点，此前 step 成果不动。replace 机制本身允许多节点遮蔽（替换事件类型不是 tool/result 时不触发单节点限制） | KNOWN_SESSION_EVENT_TYPES 含 step/start/end 等（dsh-session lib/index.js）；surface.js planSurfaceEvent/assertToolResultRewrite |
| G3 ctx.agents 可达性 | **平台官方同款用法存在**。host-apiproxy 自己就用 `ctx.get('agents')?.get(sessionId)` 取活体 agent（api-proxy.js L1283）；服务名 `'agents'`（AgentRegistry 构造 L425）；idle 判定一行：`phase.kind === "idle" \|\| "maintenance"`（L380 get status）。本插件现有 inject/get 用法与其一致 | api-proxy.js L1283；dsh-agent/lib/index.js L424-432；agent-loop index.js L380 |
| G4 触发端点写法 | **本仓已有完整模板可复制**。现役 `/api/dsao/prompt-enhance` 路由已解决：webServer 硬注入声明（避免 apply 时序踩空）、loopback fence、JSON body 解析、结构化错误返回。resume 端点照抄骨架即可；会话对象从 `agents.get(sessionId).session` 或 sessions store 均可得 | 本仓 lib/index.js L30、L451-465、L548-600 |

> 追加一条经验证据：今天产品里"停止后手打『继续』再发送"，下一次请求就携带着 interrupted 半截锚点 + 新 user 消息——这正是我们重放形态的近亲，provider 层早已被真实使用验证。

### 综合判定

**Route β 可以立即开始实施**，且比 v0.2 最初估计更简单：
- v0 阶段**连撤尾都可以省掉**（保留锚点时标记消息紧随其后，形成与现状等价的"继续型"请求；撤尾作为保真升级项放入 v1）；
- 剩余的唯一实验（BLK-3）收窄为"空块 vs 最小哨兵"的单变量冒烟；
- α 线的所有调研结论同步有效，随时可作为后续上游 PR 材料。

## 14. 实施计划（Route β 先行，α 通道保留）

### Phase 0 · 探针（约半天，决定两个开关）

| 任务 | 内容 | 验收 |
|---|---|---|
| P0-1 标记形态冒烟 | 写临时脚本对真实/自建端点各发一次：`content:[]` 尾随 user 与最小哨兵文本尾随 user，记录三套 API 的接受度 | 得出 BLK-3 结论 → 设定配置默认值 `dsao.resume.markerStyle = zero \| sentinel` |
| P0-2 遮蔽探针 | 定位 ui-conversation 发送按钮组件导出面，用 cordis.patch 试做一次属性级遮蔽委托 | 得出 BLK-6 结论 → 三态按钮实现路径（内嵌替换 or 旁挂兄弟键） |

### Phase 1 · 服务端 MVP（1–2 天）

| 任务 | 内容 | 验收 |
|---|---|---|
| T1 resume 路由 | `POST /api/dsao/resume {sessionId}`：复用 loopback fence 与 JSON 解析骨架 → `agents.get()` 取活体 → `status !== 'idle'` 返回 409 结构化 busy → 按 P0-1 结论构造标记 UserMessage → `agent.followup(marker)`；返回 `{accepted:true}` | curl 正反例通过；`node --test test/` 绿 |
| T2 门控数据端点可选 | 若客户端自算末次终态成本高，则路由附带返回 `{canResume:boolean, reason}` 派生字段（从 log 读取，见 T3） | 字段与 FR-1 谓词一致 |
| T3 单测 | fake agents/webServer stub 下覆盖：busy 拒绝、非 loopback 拒绝、正常唤醒序列（spy 断言 followup 参数）、重复触发幂等语义（idle 才受理即天然幂等） | `node --test test/resume-route.test.mjs` |

### Phase 2 · 客户端三态（约 1 天）

| 任务 | 内容 | 验收 |
|---|---|---|
| T4 门控谓词模块 | 从会话快照读五输入：`running`(快照已有)、draft/images(composer 状态)、queue(快照已有)、末次终态(`snapshot.turnEnds` 映射取最后一个 end 的 reason.kind)——纯函数并单测 | FR-1 谓词测试全绿 |
| T5 ▶ 态接线 | 按 P0-2 结论实现内嵌替换或旁挂按钮；点击 → fetch resume 路由 → 成功即依赖 mux 事件自然转入运行中视觉；失败恢复 ▶ 并 toast 原因 | 浏览器实测闭环：▶→■→✈；停止→▶ |

### Phase 3 · 渲染与文案（0.5 天）

T6 i18n 两语言文案对（FR-10）；T7 空泡观感处置（若标记块产生可见空行：客户端投影层抑制同源 `source.rpcId='dsao-resume'` 的 user 行显示——本项目渲染遮蔽工艺的直接应用）。

### Phase 4 · 验收与留档（0.5 天）

US-005 场景矩阵逐项跑（S1/S2/S3/S5/S6 必测，S7 刷新回放）+ 结果记入本文档附录 B。

### Phase 5 · 升级通道（另行排期）

W1 撤尾执行器（G2 区间规则 → US-002 固有 AC）→ 重放保真度提升到"纯重发"；W2 整理 α 材料：resume() 最小 diff + BLK 口径说明，具备条件时提上游。

### 里程碑与开关汇总

- DoD 映射 §11 成功指标；S6/S7 是回归红线。
- 配置开关：`markerStyle`（P0-1）、按钮实现路径（P0-2）、后续预留 `withdraw.enabled`（Phase 5）。
- 平台兼容：lib/index.js 头部注释维持既有纪律——所有 `ctx.get` 探测失败给出明确路由级错误。

## 附录 A：关键代码位置速查

| 主题 | 位置 |
|---|---|
| 输入机空稿门 | @ds/dsh-client-ui-conversation/lib/client.js L808-841 |
| sink 假成功短路 | 同上 L1577-1580 |
| prompt/cancel 控制器 | @ds/dsh-client-runtime/lib/client.js L7196-7257 / L7304-7336 |
| session.* 路由表 | @ds/dsh-host-apiproxy/lib/types/fetch/handler.js L23-37 |
| prompt 实现 + durablePromptContent | @ds/dsh-host-apiproxy/lib/types/api-proxy.js L2077-2136 / L45-61 |
| wake/send/inject 与 cancel | @ds/dsh-agent-loop/lib/index.js L386-411 |
| turn 空收件箱短路 / pre-step waterfall | 同上 L543-546 / L492-513 |
| 流式 chunk、中止定稿、错误路径、buildRequest | 同上 L606-762 |
| surface 三类投影 / replace 规则 | @ds/dsh-session/lib/types/surface.js L11-103 / L112-249 |
| deriveMessages 缓存重建 | @ds/dsh-session/lib/index.js L1543-1558 |
| ctx.agents 注册表 | @ds/dsh-agent README.md（registry 一节）；服务名 `'agents'`（lib/index.js L425） |
| 平台自取活体 agent 先例 | @ds/dsh-host-apiproxy/lib/types/api-proxy.js L1283 `ctx.get('agents')?.get(sessionId)` |
| status idle 判定 | @ds/dsh-agent-loop/lib/index.js L380 `get status()` |
| 本仓可复用路由模板 | lib/index.js L30/L451-465/L548-600（/api/dsao/prompt-enhance：注入声明、loopback fence、body 解析、结构化错误） |

## 附录 B：验收留档

### B.1 自动化验证（实施完成时点）

| 项 | 结果 | 命令 / 方式 |
|---|---|---|
| T1 resume 路由 | ✅ `test/resume-route.test.mjs` 全绿：注册 3 路由、loopback 403、405、400（缺 sessionId/坏 markerStyle）、503（缺 agents 服务）、404（非活体会话）、409 busy / not-resumable / pending、200 正常唤醒 + followup 参数断言（role=user、content=[]、source.kind=user、id 前缀 dsao-resume-）、sentinel 覆盖、四类可继续终态对称通过、GET gate 只读不打扰 | `node test/resume-route.test.mjs` |
| T4 门控谓词 | ✅ `test/resume-gate.test.mjs` 全绿：FR-1 五输入逐项、四正二负终态、turnEnds 三种容器形态与按 seq 取最新、queue 仅 queued 行阻塞、subagent 排除、空白草稿按 trim 通过 | `node test/resume-gate.test.mjs` |
| 回归 | ✅ 全仓 11 个测试文件 ALL GREEN（含既有 host/prompt-enhance 26+7 场景） | 逐个 `node test/*.test.mjs` |
| 语法 | ✅ lib/index.js 与 lib/client.js `node --check` 通过；bundle 内两个新模块经 loadBundleModule 加载冒烟 | `node --check` |

实现落位（对应 §14 计划）：
- Host：`lib/index.js` —— `/api/dsao/resume`（GET gate 只读 + POST 唤醒）、`computeResumeGate()`、markerStyle 常量（默认 zero，请求可覆盖 sentinel）
- Client 门控：`src/modules/resume-gate.js`（源）+ bundle 内 `dsao/resume-gate`
- Client 按钮：`src/modules/resume-button.js`（源）+ bundle 内 `dsao/resume-button`（▶ 图标 PATH_PLAY、轮询 700ms、成功对勾/失败闪红文案 FR-10）
- 注册：主入口 order 101 兄弟槽位（src/client.js 与 lib/client.js 已同步）

### B.2 浏览器实测项（待真实 GUI 环境）

### B.3 P0-2 探针结论（按钮形态路线判定）

| 探测项 | 结论 | 证据 |
|---|---|---|
| conversation.composer 链语义 | **替换式**：选举出的条目整体顶掉 fallback 渲染，无「包官方再委托」的缝；且链选举按注册序（比较器 priority 升序+稳定排序），非包裹栈 | dsh-client-ui-renderer SlotOutlet.renderOutletContent chain 分支；SlotCore.register 比较器 (p??0)-(p??0) |
| 官方发送按钮 | JSX 内联 SVG + disabled: empty||disabled||machineBusy；空稿时原生吞掉一切点击——"改节点内部"会被 React 重画覆盖，"子元素代理点击"不可达 | dsh-client-ui-conversation InputBar：primaryStops/onPrimary/primaryLabel 段 |
| 结论 | wrapper 遮蔽委托不可行 → 采用**覆盖面（overlay face）**：绝对定位层精确盖住 primary 盒子绘制 ▶ 面、自行接管 click，位置三路刷新（interval 700ms / resize / MutationObserver），其余场景完全隐藏 | resume-button.js 重写版 + primaryBox 单元冒烟 |


| # | 场景 | 步骤要点 | 结果 |
|---|---|---|---|
| S1 | 手动停止 → ▶ → 续跑 | 让模型写长文，中途停止；确认 ▶ 出现；点击；观察新流式输出从原上下文接续（保留锚点的"继续型"语义） | 待测 |
| S2 | 配额中途死 → 切模型 → ▶ | 自建 SSE stub 注入 mid-stream error；切模型后点击 ▶ | 待测 |
| S5 | 队列非空互斥 | 排队一条消息后空草稿 Enter | 待测 |
| S6/S7 | 正常完成不亮 & 刷新存活 | 正常问答完成后观察；F5 后再观察 | 待测 |
| BLK-3 空块 wire 冒烟 | markerStyle=zero 默认值实测 | 观察续跑是否被 provider 拒（拒则置 sentinel） | 待测 |

> v0 语义备注：标记消息紧随未撤回的半截锚点，属"继续型重放"——与现状"停止后手打『继续』"的请求形态同构（§13 经验证据）；纯重放的撤尾执行器留在 Phase 5。图片附件信号不可达导致的 FR-1 放宽已记于 resume-gate 源头注释。
| crash 恢复合成结果 | @ds/dsh-session/lib/types/repair.js |
