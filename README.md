# dsh-assistant-optimization

> [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin — fold mis-rendered thinking/reasoning content into collapsible blocks, and render mermaid diagrams inline.

## Problem

Some LLM providers (especially those using OpenAI-compatible APIs without a dedicated `reasoning_content` channel) dump the model's chain-of-thought into the regular text output. DSH renders this as normal message text, polluting the conversation with long reasoning passages that are hard to distinguish from the actual answer.

A common pattern: the model outputs reasoning text followed by a `</think>` tag, then the real response.

## Features

- **Thinking tag split** — Configurable markers (default: `</think>`) separate reasoning from body text. Reasoning content is folded into DSH's native collapsible "Think" disclosure (ReasoningRow).
- **Mermaid diagrams** — ```` ```mermaid ```` code blocks are rendered as interactive SVG diagrams with zoom, pan, and touch support.
- **Settings page** — Manage split markers in **Settings → General → Thinking Tag Markers**.

## Installation

### Via `dsh plugin` (recommended)

```bash
dsh plugin --profile web add github:qianshe/dsh-assistant-optimization
```

Then restart your DSH web profile. The plugin activates automatically.

### From source

```bash
git clone https://github.com/qianshe/dsh-assistant-optimization.git
cd dsh-assistant-optimization
dsh plugin --profile web add .
```

## How It Works

```
Model output (text block with reasoning + </think> + response)
  ↓
Plugin wrapper (priority -1 slot registration)
  ↓ split text block at markers → [reasoning block] + [text block]
Official assistant-step renderer (priority 0, called by wrapper)
  ↓ renders reasoning as collapsible ReasoningRow, text as MarkdownText
DSH chat view (unchanged)
```

- **Host module** (`lib/index.js`) — No-op entry point (the plugin is client-side only).
- **Client module** (`lib/client.js`) — Wraps the official `assistant-step` renderer, runs the mermaid DOM post-processor, and provides the settings UI. Markers are persisted in `localStorage`.

### Slot Priority Shadowing

The plugin registers at `conversation.chat.node` slot key `assistant-step` with `priority: -1`, which shadows the official renderer at `priority: 0`. At render time, the wrapper finds the official renderer via `slots.entries()`, splits text blocks at configured markers, and calls the official renderer with modified `node.data.blocks`. The official renderer handles all rendering — markdown, tool-calls, images, and the ReasoningRow component for reasoning blocks.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| Markers | `["</think>"]` | Strings that separate reasoning from body text. Text before a marker becomes a reasoning block. Supports multiple markers. |

Manage markers in **Settings → General → Thinking Tag Markers**.

## Requirements

- DSH (DeepSeek Harness) with the web profile
- Internet access (for mermaid.js CDN — only needed when mermaid diagrams are present)

## License

MIT
