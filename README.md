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
4. **Prompt enhance** — A sparkle button left of the send button rewrites the current draft into a clearer instruction, using the model already selected in the composer. One plain chat request: no session is created and nothing is written to any session log.
5. **Settings page** — Manage split markers under **Settings → General**.

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
- **Prompt enhance** — Type a rough draft, then click the sparkle button left of the send button. The draft is replaced in place with a clearer version; press Ctrl/Cmd+Z to undo. The button is disabled while the draft is empty or a submission is in flight, and it pulses while the request runs. On failure the icon flashes red and the reason lands in its tooltip — the draft is never cleared.

### Configuration

| Setting | Default | Description |
|---|---|---|
| Markers | `["</think>"]` | Strings that split reasoning from body text. Text before a marker becomes a collapsible block. Multiple markers supported. Stored in `localStorage` under `dsao:thinking-markers`. |

## How It Works

The plugin never replaces official UI. It shadows official components at two slot tiers and delegates the actual rendering back to the component it shadowed, and it adds one control to a shipped list slot.

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

### Composer tier — prompt enhance

The composer tool row exposes `conversation.input.right`, but that seat renders *before* the model select and the context meter, while the button belongs immediately left of the send button — where no slot exists. So the entry renders only a hidden anchor in that seat, walks up to the `.trailing` container that holds the send button, and inserts a plain DOM button before it. Placement follows the same discipline as the diff badge: cleanup runs first, so a container swap cannot orphan the button, and re-placement is a no-op when the position is already correct.

The Host half registers one loopback-only route, `POST /api/dsao/prompt-enhance`. It reads the deployment's current model through `ctx.agentDefaultModel.currentSelection()` and issues a single `ctx.llm.stream()` call with the draft as the only user message — no tools, no `sessionId`, no session, nothing logged. The reply replaces the draft through the public `inputActions.setDraft()`, which routes through the input machine's normal write path, so the browser's undo history still works.

Failures are reported, never silent: a missing service answers 503, an oversized or empty draft 400/413, and a failed or empty model call 502. The client leaves the draft untouched and puts the reason in the button's tooltip.

### File structure

```
├── cordis.patch.yml   # composition layer: plugin row insert
├── lib/
│   ├── index.js       # Host half: the prompt-enhance route
│   └── client.js      # Browser plugin (__ModuleLoader__.load wrapper)
├── package.json       # dsh.bundle + dsh.client metadata
├── src/               # Module sources (development reference)
│   ├── client.js      # apply() — slot registrations
│   ├── host.js
│   └── modules/
│       ├── markers.js         # marker storage
│       ├── text-split.js      # splitText + transformBlocks
│       ├── tool-diff.js       # diffStats + ensureBadge
│       ├── wrapper.js         # shadowing components
│       ├── prompt-enhance.js  # composer button + placement
│       ├── mermaid.js         # SVG rendering + pan/zoom
│       └── settings.js        # settings row component
├── test/
│   ├── load-module.mjs         # evaluate one bundle module in isolation
│   ├── dom-stub.mjs            # minimal DOM + ToolRow fixture
│   ├── diff-stats.test.mjs
│   ├── ensure-badge.test.mjs
│   ├── prompt-enhance.test.mjs      # button placement
│   └── host-prompt-enhance.test.mjs # route guards + model call
└── docs
    ├── design.md
    └── technical-reference.md   # DSH slot & tool-call rendering reference
```

`lib/client.js` is the shipped bundle: the same modules assembled as `window.__ModuleLoader__.load()` registrations. Edit both when changing behaviour.

## Development

```bash
node test/diff-stats.test.mjs         # diff counting + error suppression
node test/ensure-badge.test.mjs       # DOM convergence, incl. running → errored
node test/prompt-enhance.test.mjs     # button placement + cleanup
node test/host-prompt-enhance.test.mjs # route guards + one non-session call
node --check lib/client.js            # bundle syntax
```

The client suites load real modules out of `lib/client.js` and the host suite imports `lib/index.js`, so they test the shipped code rather than a re-implementation.

## Requirements

- DSH (DeepSeek Harness) with the web profile
- Internet access (only for mermaid.js CDN loading when diagrams are present)

## License

MIT
