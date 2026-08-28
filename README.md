# dsh-assistant-optimization

> A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin for the web profile that makes model output easier to read and your prompts easier to write.

**[中文文档](./README.zh.md)**

## Features

Six capabilities, all plug-and-play. Official rendering is never replaced — the plugin shadows DSH components and delegates back to them, so Markdown, tool cards, images, and tables keep working exactly as shipped.

| | Capability | What it does |
|---|---|---|
| 💭 | **Reasoning fold** | Collapses mis-rendered chain-of-thought into the native "Think" block |
| 📊 | **Mermaid diagrams** | Renders mermaid code blocks as interactive SVG (zoom / pan / touch) |
| ✎ | **Edit diff counts** | Shows `+10/-2` on collapsed Write & Edit rows, no expand needed |
| ✨ | **Prompt enhance** | Rewrites a rough draft into a clearer instruction in one click |
| ▶ | **Resume-from-breakpoint** | After a manual stop or session error, the send button becomes a play key — hover shows a tooltip, one click resumes from the interruption with the currently selected model. Typing or starting a new turn instantly restores the normal send button. |
| 📁 | **Turn folding** | When a turn finishes, its process (thinking, tool calls, intermediate text) auto-collapses into one "已完成 · 时长" header; the final summary reply stays expanded. Nothing collapses while a turn runs. |
| 🛰️ | **Semantic search** | `context_search` — locate code from a vague description (Windsurf-backed) |

### Reasoning fold

Some providers (OpenAI-compatible APIs with no dedicated `reasoning_content` channel) dump chain-of-thought into the regular text stream:

~~~
The user wants to know about X, I should explain Y first...
</thinking>

Here is the answer to your question...
~~~

DSH renders that as a single block. This plugin splits it at configurable markers so the reasoning folds into the native "Think" disclosure and only the answer stays visible. Manage the markers under **Settings → General → Thinking Tag Markers**.

### Mermaid diagrams

Mermaid code blocks render inline as interactive SVG. Toolbar buttons zoom and reset, the scroll wheel zooms, and mouse or touch drag pans.

### Edit diff counts

Write and Edit rows carry a `+N` (added) / `-N` (removed) badge right after the file path, visible without expanding the row. A failed edit produces no diff, so it gets no badge.

### Prompt enhance

A sparkle button sits left of the send button and rewrites a rough draft into a clearer instruction using the model already selected in the composer. It sends one plain chat request — no session, nothing logged — and replaces the draft in place, so Ctrl/Cmd+Z undoes it.

While running it shows a spinning arc and "增强中"; on success a green check; on failure the icon flashes red with the reason in its tooltip and **the draft is never cleared**. The tooltip uses the same CSS styling as DSH's native button tooltips and also reports how much context the last call actually received — the first thing to check when a rewrite is unhelpful.

### Resume-from-breakpoint

When a conversation stops abnormally — the user clicks **Stop** or the session hits an error — the send button transforms into a ▶ play key. A hover tooltip ("断点续发") appears with the same style as DSH's native button tooltips.

- **One click** sends a resume signal via the host route; the agent picks up from the interruption using whatever model is currently selected in the composer.
- **Instant revert**: typing in the draft, or the agent starting to run, immediately restores the normal send/stop button — no stuck play icon.
- **Gate logic**: reads `session.chat.timeline` for the last closed turn's `turn/end` reason. Only `aborted` (user stop) and `error` (session error) trigger the play button; normal completions and max-tokens do not.
- **Empty marker rows**: when the resume marker enters the transcript, the plugin replaces the blank bubble + copy button with a subtle "已从中断处继续" hint line.
- **Implementation**: CSS-overlay approach — the official button's SVG is hidden via `data-dsao-resume` attribute + a play SVG sibling, so React's re-render cycle is never disrupted.

### Turn folding

While a turn runs, everything stays visible — the native "Deep diving…" status with its clock is the running indicator. The moment the turn completes (the final answer lands), the process content of that turn — thinking rows, tool calls, intermediate text — collapses into a single header line: **已完成 · 时长** (errored/stopped turns show 已出错/已停止 instead). What stays visible: your prompt, the final summary reply, and its action row (copy etc.). Click the header to expand the full process; click again to collapse. Expand/collapse choices live in memory only; a fresh page load starts collapsed.

The plan is computed entirely from the session snapshot: turn grouping via `chat.locations`, completion via the turn's `turn/end` reason, the summary reply via the official `turn-tail` node's `closing` pointer, duration from the turn's start/end timestamps (same figures the native clock shows). Toggle under **Settings → General → Turn Folding**.

### Semantic search (`context_search`)

A host-side tool for **vague or unclear** searches: pass a natural-language query and get back the matching files with their line ranges and code. It runs an agentic search loop built on the fast-context approach and driven by a Windsurf key.

**Key gating — the whole point.** The tool and its one-line prompt guidance are registered *only* when a Windsurf key resolves. With no key, nothing is registered, so the model is never told about a tool it cannot call.

The key is resolved in this order (first hit wins): `WINDSURF_API_KEY` env → manual entry (**Settings → General → Windsurf API Key**, stored at `~/.dsh/dsao-windsurf-key`, `0600`) → local auto-read from the logged-in Windsurf/Devin editor's `state.vscdb`. `DSAO_FC_AUTO_KEY=0` disables auto-read. See `lib/fast-context/NOTICE.md` for the non-official protocol note.

## Installation

```bash
dsh plugin --profile web add github:qianshe/dsh-assistant-optimization
dsh web
```

Open http://127.0.0.1:3080 — the plugin activates automatically. A restart is required after install, update, and removal.

| | |
|---|---|
| From source | `dsh plugin --profile web add .` |
| Update | `dsh plugin --profile web update dsh-assistant-optimization` |
| Uninstall | `dsh plugin --profile web remove dsh-assistant-optimization` |

## Configuration

| Setting | Default | Description |
|---|---|---|
| Thinking Tag Markers | `["</thinking>"]` | Strings that split reasoning from body text. Multiple supported. Edit at **Settings → General**. |
| Turn Folding | on | Auto-collapse finished turns' process into a one-line header. Edit at **Settings → General**. |
| Windsurf API Key | — | Credential for `context_search`. See key resolution above. No key ⇒ tool not registered. |

## Requirements

- DSH (DeepSeek Harness) with the web profile
- Internet access only for the mermaid.js CDN, and only when a diagram is present

## Development

```bash
node test/diff-stats.test.mjs
node test/ensure-badge.test.mjs
node test/context.test.mjs
node test/prompt-enhance.test.mjs
node test/host-prompt-enhance.test.mjs
node test/resume-gate.test.mjs
node test/resume-route.test.mjs
node test/resume-continuity.test.mjs
node test/turn-fold.test.mjs
node test/fast-context-gate.test.mjs
node test/content-embed.test.mjs
node --check lib/client.js
```

Tests load shipped modules from `lib/client.js` / `lib/index.js`. For slot keys, priorities, the reference-extraction contract, the failure-status map, and the full file structure, see [`docs/technical-reference.md`](./docs/technical-reference.md).

## License

MIT
