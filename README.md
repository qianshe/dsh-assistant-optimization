# dsh-assistant-optimization

> A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that folds mis-rendered thinking/reasoning content into collapsible blocks and renders mermaid diagrams inline.

**[中文文档](./README.zh.md)**

## The Problem

Some LLM providers (especially those using OpenAI-compatible APIs without a dedicated `reasoning_content` channel) dump the model's chain-of-thought into the regular text output, like this:

```
The user wants to know about X, I should explain Y first...
</think>
Here is the answer to your question...
```

DSH renders the entire thing as normal message text, making it hard to separate reasoning from the actual answer.

## Features

1. **Thinking tag split** — Splits text at configurable markers (default: `</think>`). Content before a marker becomes a collapsible "Think" block via DSH's native ReasoningRow. Everything after renders as normal text.
2. **Mermaid diagrams** — `` ```mermaid `` code blocks render as interactive SVG diagrams with zoom, pan, and touch support.
3. **File-edit diff counts** — Write and Edit tool rows show colored line-change counts (e.g. `+10/-2`, `+10`, `-11`) right after the file path, while the row is still collapsed. A failed edit produces no diff, so it gets no badge.
4. **Settings page** — Manage split markers under **Settings → General**.

All original rendering (Markdown, tool calls, images, tables) is handled by the official DSH renderer — the plugin only does text splitting and lightweight tool-row annotations.

## Installation

### Via `dsh plugin` (recommended)

```bash
dsh plugin --profile web add github:qianshe/dsh-assistant-optimization
```

Restart your web profile:

```bash
dsh web
```

Open http://127.0.0.1:3080 — the plugin is active automatically.

### From source

```bash
git clone https://github.com/qianshe/dsh-assistant-optimization.git
cd dsh-assistant-optimization
dsh plugin --profile web add .
```

### Update

```bash
dsh plugin --profile web update dsh-assistant-optimization
```

### Uninstall

```bash
dsh plugin --profile web remove dsh-assistant-optimization
```

Restart the profile after removing.

## Usage

After installation, the plugin works automatically — no extra steps needed.

- **Reasoning fold** — When a model outputs `</think>` (or any marker you configure), the reasoning text before it is collapsed into a "Think" disclosure. Click to expand/collapse.
- **Mermaid** — Any `` ```mermaid `` code block in the conversation renders as an SVG diagram. Use the toolbar buttons (zoom in/out/reset), scroll wheel to zoom, or mouse/touch drag to pan.
- **File-edit diff counts** — After the model writes or edits a file, the tool row path is followed by a colored badge: `+N` in green for added lines, `-N` in red for removed lines. The badge is visible without expanding the row. Errored edits show no badge.
- **Custom markers** — Go to **Settings → General → Thinking Tag Markers** to add or remove split markers (different models may use different tags).

### Configuration

| Setting | Default | Description |
|---|---|---|
| Markers | `["</think>"]` | Strings that split reasoning from body text. Text before a marker becomes a collapsible block. Multiple markers supported. Stored in `localStorage` under `dsao:thinking-markers`. |

## How It Works

The plugin never replaces official UI. It registers shadowing components at two different slot tiers and delegates the actual rendering back to the official component it shadowed.

### Message tier — reasoning fold

At `conversation.chat.node` slot key `assistant-step` with `priority: -1`, shadowing the official renderer at `priority: 0`. At render time, the wrapper:

1. Finds the official renderer via `slots.entries()`
2. Checks if the message's `data.blocks` contain any `text` blocks
3. Splits text blocks at configured markers into alternating `reasoning` + `text` blocks
4. Calls the official renderer with the modified blocks

The official renderer handles everything — ReasoningRow folding, Markdown rendering, tool-call cards, image galleries — the plugin only does string splitting.

### Tool-row tier — diff badges

At `tool.call.toolview` slot keys `write` and `edit` with `priority: -1`, shadowing the official `FileMutationRow`. This is a leaf-level slot, so the wrapper declares no children and needs no `renderSlot` call.

The wrapper renders the official row inside a `display: contents` container and injects the badge into the resulting DOM through a `MutationObserver`. The injection is idempotent: `ensureBadge` returns without touching the DOM when the badge is already correctly placed with matching counts, which is what keeps the observer from re-triggering itself into a render loop.

Line counts come from the block's diff render intent, following the official `diffCardModel` contract: a settled call reads `resultView` only. An errored mutation has no diff card, so its `callView` is deliberately not used as a fallback and no badge appears.

### File structure

```
├── cordis.patch.yml   # composition layer: plugin row insert
├── lib/
│   ├── index.js       # Host entry (no-op)
│   └── client.js      # Browser plugin (__ModuleLoader__.load wrapper)
├── package.json       # dsh.bundle + dsh.client metadata
├── src/               # Module sources (development reference)
│   ├── client.js      # apply() — slot registrations
│   ├── host.js
│   └── modules/
│       ├── markers.js     # marker storage
│       ├── text-split.js  # splitText + transformBlocks
│       ├── tool-diff.js   # diffStats + ensureBadge
│       ├── wrapper.js     # shadowing components
│       ├── mermaid.js     # SVG rendering + pan/zoom
│       └── settings.js    # settings row component
├── test/
│   ├── load-module.mjs         # evaluate one bundle module in isolation
│   ├── dom-stub.mjs            # minimal DOM + ToolRow fixture
│   ├── diff-stats.test.mjs
│   └── ensure-badge.test.mjs
└── docs/
    ├── design.md
    └── technical-reference.md   # DSH slot & tool-call rendering reference
```

`lib/client.js` is the shipped bundle: the same modules assembled as `window.__ModuleLoader__.load()` registrations. Edit both when changing behaviour.

## Development

```bash
node test/diff-stats.test.mjs    # diff counting + error suppression
node test/ensure-badge.test.mjs  # DOM convergence, incl. running → errored
node --check lib/client.js       # bundle syntax
```

Both suites load the real `dsao/tool-diff` module out of `lib/client.js`, so they test the shipped bundle rather than a re-implementation.

## Requirements

- DSH (DeepSeek Harness) with the web profile
- Internet access (only for mermaid.js CDN loading when diagrams are present)

## License

MIT
