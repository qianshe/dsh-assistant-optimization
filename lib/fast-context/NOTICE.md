# Attribution

`lib/fast-context/` 移植自 [SammySnake-d/fast-context-mcp](https://github.com/SammySnake-d/fast-context-mcp)
（MIT License, Copyright (c) 2025），版本基线 v1.3.2。

MIT 许可要求：保留版权声明与许可声明。完整 LICENSE 见本目录 `LICENSE-MIT`。

模块对应关系（参考仓库 → 本目录）：

| 参考仓库 | 本目录 | 改动 |
| --- | --- | --- |
| src/protobuf.mjs | protocol.js | 无逻辑改动 |
| src/path-safety.mjs | path-safety.js | 无逻辑改动 |
| src/response-repair.mjs | repair.js | 仅 import 路径 |
| src/shared.mjs | shared.js | tree-node-cli 换为纯 node:fs 树渲染；其余无逻辑改动 |
| src/executor.mjs | executor.js | 仅保留异步路径；新增 exec.signal 取消支持；ripgrep 懒解析（依赖 → PATH → DSH 内置） |
| src/extract-key.mjs | extract-key.js | state.vscdb 读取改用 Node 内置 node:sqlite（替代参考实现的 sql.js WASM），先拷贝快照再只读打开 |
| src/cache.mjs | cache.js | 无逻辑改动 |
| src/core.mjs（协议部分） | windsurf.js | 拆出 brain 接口；其余无逻辑改动 |
| src/core.mjs（循环部分） | core.js | 支持 brain 抽象（Windsurf / DSH ctx.llm）与 A→B 自动降级 |
| —（新增） | brain-llm.js | 用 DSH 部署模型替代 Windsurf Devstral 的循环大脑 |
| —（新增） | key-source.js | key 解析链：WINDSURF_API_KEY 环境变量 → 手动 key 文件（$DSH_HOME/dsao-windsurf-key）→ 本地安装自动发现 |
| —（新增） | tool.js | `context_search` 工具注册：无 key 时工具与提示词段均不注册（key 门控） |

非官方协议声明：windsurf.js 与 extract-key.js 调用的是 Windsurf/Devin 的非官方端点，
并读取本地应用数据（state.vscdb）。使用即代表用户自担相应风险（端点变更、限流、ToS）。
