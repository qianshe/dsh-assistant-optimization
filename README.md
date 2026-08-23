# dsh-assistant-optimization

> A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin for the web profile that makes model output easier to read and your prompts easier to write.

**[中文文档](./README.zh.md)**

## Features

Four capabilities, all plug-and-play. Official rendering is never replaced — the plugin shadows DSH components and delegates back to them, so Markdown, tool cards, images, and tables keep working exactly as shipped.

| | Capability | What it does |
|---|---|---|
| 💭 | **Reasoning fold** | Collapses mis-rendered chain-of-thought into the native "Think" block |
| 📊 | **Mermaid diagrams** | Renders mermaid code blocks as interactive SVG (zoom / pan / touch) |
| ✎ | **Edit diff counts** | Shows `+10/-2` on collapsed Write & Edit rows, no expand needed |
| ✨ | **Prompt enhance** | Rewrites a rough draft into a clearer instruction in one click |

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

While running it shows a spinning arc and "增强中"; on success a green check; on failure the icon flashes red with the reason in its tooltip and **the draft is never cleared**. The tooltip also reports how much context the last call actually received — the first thing to check when a rewrite is unhelpful.

## Installation

```bash
dsh plugin --profile web add github:qianshe/dsh-assistant-optimization
dsh web
```

Open http://127.0.0.1:3080 — the plugin activates automatically. A restart is required after install, update, and removal, because both halves load at profile boot.

| | |
|---|---|
| From source | `dsh plugin --profile web add .` |
| Update | `dsh plugin --profile web update dsh-assistant-optimization` |
| Uninstall | `dsh plugin --profile web remove dsh-assistant-optimization` |

## Configuration

| Setting | Default | Description |
|---|---|---|
| Thinking Tag Markers | `["</thinking>"]` | Strings that split reasoning from body text. Multiple supported. Stored in `localStorage` under `dsao:thinking-markers`. Edit at **Settings → General**. |

## How it works

Each capability shadows a DSH rendering slot and delegates back to the official renderer — no product UI is replaced.

- **Reasoning fold** wraps the assistant message renderer, splits `text` blocks at the configured markers into alternating `reasoning` + `text` blocks, and hands the rest back to DSH.
- **Edit diff counts** wraps the file-mutation tool row and injects a `+N/-N` badge derived from DSH's own diff model; errored edits get no badge.
- **Prompt enhance** anchors a button in the composer and exposes one loopback-only route (`POST /api/dsao/prompt-enhance`) that calls the currently selected model with the draft plus project/session context as private reference, then writes the result back through the normal input path so undo still works.

For slot keys, priorities, the exact reference-extraction contract, and the failure-status map, see [`docs/technical-reference.md`](./docs/technical-reference.md).

### File structure

~~~
├── cordis.patch.yml   # composition layer: plugin row insert
├── lib/
│   ├── index.js       # Host half: the prompt-enhance route
│   └── client.js      # shipped browser bundle (__ModuleLoader__.load)
├── package.json       # dsh.bundle + dsh.client metadata
├── src/               # module sources (development reference)
│   ├── client.js      # apply() — slot registrations
│   ├── host.js
│   └── modules/
│       ├── markers.js         # marker storage
│       ├── text-split.js      # splitText + transformBlocks
│       ├── tool-diff.js       # diffStats + ensureBadge
│       ├── wrapper.js         # shadowing components
│       ├── context.js         # private-reference extraction
│       ├── prompt-enhance.js  # composer button + placement
│       ├── mermaid.js         # SVG rendering + pan/zoom
│       └── settings.js        # settings row component
├── test/
│   ├── load-module.mjs        # evaluate one bundle module in isolation
│   ├── dom-stub.mjs           # minimal DOM + ToolRow fixture
│   ├── diff-stats.test.mjs
│   ├── ensure-badge.test.mjs
│   ├── context.test.mjs
│   ├── prompt-enhance.test.mjs
│   └── host-prompt-enhance.test.mjs
└── docs/
    ├── design.md
    └── technical-reference.md  # DSH slot & tool-call rendering reference
~~~

`lib/client.js` is the shipped artifact: the same modules assembled as `window.__ModuleLoader__.load()` registrations. Change behaviour in both `src/` and `lib/`.

## Development

```bash
node test/diff-stats.test.mjs          # diff counting + error suppression
node test/ensure-badge.test.mjs        # DOM convergence, incl. running → errored
node test/context.test.mjs             # reference extraction + exclusions
node test/prompt-enhance.test.mjs      # button placement + cleanup
node test/host-prompt-enhance.test.mjs # inject contract, route guards, model call
node --check lib/client.js             # bundle syntax
```

Tests load the shipped modules from `lib/client.js` / `lib/index.js`, not a re-implementation.

## Requirements

- DSH (DeepSeek Harness) with the web profile
- Internet access only for the mermaid.js CDN, and only when a diagram is present

## License

MIT
