# dsh-assistant-optimization

> [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin — fold mis-rendered thinking/reasoning content into collapsible blocks, and render mermaid diagrams inline.

## Problem

Some LLM providers (especially those using OpenAI-compatible APIs without a dedicated `reasoning_content` channel) dump the model's chain-of-thought into the regular text output. DSH renders this as normal message text, polluting the conversation with long reasoning passages that are hard to distinguish from the actual answer.

A common pattern: the model outputs reasoning text followed by a `</think>` tag, then the real response — but there's no opening + response)
  ↓
Plugin wrapper (priority -1 slot registration)
  ↓ split text block at markers → [reasoning block] + [text block]
Official assistant-step renderer (priority 0, called by wrapper)
  ↓ renders reasoning as collapsible ReasoningRow, text as MarkdownText
DSH chat view (unchanged)
```

- **Host** (`src/host.js`) — Maintains the marker list in process memory and exposes it via JSON RPC (`thinking-tags/get`, `/add`, `/remove`).
- **Client** (`src/client.js`) — Registers at slot priority -1 to wrap the official `assistant-step` renderer, runs the mermaid DOM post-processor, and provides the settings UI.

## How It Works

### Thinking Tag Split

The plugin registers a component at `conversation.chat.node` slot key `assistant-step` with `priority: -1`, which shadows the official renderer at `priority: 0`. At render time, the wrapper:

1. Looks up the official renderer component from the slot registry's entry list
2. Checks if the current message's `data.blocks` contain any `text` blocks
3. If markers are configured, splits each text block at every marker occurrence into alternating `reasoning` + `text` segments
4. Calls the official renderer with the modified `node.data.blocks`

The official `ReasoningRow` component renders reasoning blocks with the standard DSH collapsible "Think" UI — including streaming animations and summary lines. No custom CSS or components are needed for the reasoning display.

### Mermaid Diagrams

A `MutationObserver` watches the document for `.md-code-block` elements whose language info string is `mermaid`. When found, the code block is replaced with a container that:

- Loads [mermaid.js](https://mermaid.js.org/) v11 from [jsDelivr CDN](https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js)
- Renders the diagram as SVG
- Provides zoom in / zoom out / reset buttons
- Supports mouse drag, touch drag, and scroll-wheel zoom
- Has `max-height: 500px` with overflow scrolling

### Settings

Registered at `settings.general.item` slot with `id: thinking-tags`. The settings row renders its own title and description (matching DSH's official settings row styling) and manages the marker list via Host RPC.

## Installation

### As a Dynamic Cordis Plugin (development)

Dynamic plugins are session-level and do not persist across process restarts. To load in your current DSH session:

1. Read `src/host.js` and `src/client.js`
2. Use `cordis_define` with `code.host` and `code.client`
3. Activate with `cordis_run`

### As a Static Plugin (production)

Package as an npm package and add a composition row to your DSH configuration. See the [DSH documentation](https://github.com/deepseek-ai/deepseek-harness) for details on static plugin composition.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| Markers | `["</think>"]` | Strings that separate reasoning from body text. Text before a marker becomes a reasoning block. Supports multiple markers. |

Manage markers in **Settings → General → Thinking Tag Markers**.

## Requirements

- DSH (DeepSeek Harness) with the conversation UI plugin
- Internet access (for mermaid.js CDN loading — only needed when mermaid diagrams are present)

## License

MIT
