# Design Document: dsh-assistant-optimization

## 1. Problem

Some LLM providers output reasoning/thinking content as plain text instead of using a dedicated reasoning channel. DSH renders this as normal message body, making conversations hard to read.

A typical malformed output looks like:

```
The user is asking about X. I should explain Y first...
</thinking>
Here's the answer to your question...
```

The reasoning text (`The user is asking...`) appears before the `</think>` closing tag with no corresponding opening tag. DSH treats the entire text block as body content.

## 2. Architecture Decision: Rendering-Layer Wrapping

**Rejected: Host-side stream interception (`llm/stream` waterfall)**

Initially considered intercepting the model's output stream on the Host side. This was rejected because:
- Splitting must be configurable per user (marker strings vary by model)
- The Host has no UI for configuration persistence
- Stream-level parsing is fragile with chunked delivery

**Chosen: Client-side renderer wrapping (slot priority)**

Register a wrapper component at `conversation.chat.node` slot key `assistant-step` with `priority: -1`. The official renderer remains at `priority: 0`. The wrapper:

1. Finds the official renderer via `slots.entries()` public API
2. Splits text blocks into `reasoning` + `text` blocks using user-configured markers
3. Calls the official renderer with the modified `node.data.blocks`

**Why this works:**
- The official renderer (`AssistantMarkdown`) already handles `reasoning` blocks natively via `ReasoningRow`
- Markdown, tool-calls, images, and all other block types pass through untouched
- The split is pure string matching — no regex, no heuristics, no risk of misinterpreting content

## 3. Key Technical Details

### Slot Priority Shadowing

The DSH slot system allows multiple registrations at different priorities (lowest renders). By registering at `-1` while the official renderer is at `0`, the wrapper takes over rendering without destroying the official entry. The official component is recovered at render time via `slots.entries('conversation.chat.node')`.

### Locale Injection

The slot system injects a `t` function into component props only when `locale` is set on the registration options. The wrapper must include `locale: 'conversation'` to receive `t`, which is then forwarded to the official renderer.

### Marker Splitting

`splitText(text, markers)` performs iterative `indexOf` scanning:
- Finds the earliest marker occurrence from the current position
- Text before the marker → `reason` segment
- Advances past the marker, continues scanning for the next occurrence
- Supports multiple markers and multiple occurrences (alternating reason/body)

### Mermaid Rendering

DSH has no native mermaid support — `MarkdownText` renders all code blocks as `CodeBlock` with syntax highlighting. The plugin uses a `MutationObserver` to scan for `.md-code-block` elements with `mermaid` language info, then:
- Loads mermaid.js v11 from CDN (lazy, cached)
- Renders the diagram as SVG
- Wraps in an interactive container with zoom/pan/touch

The observer is debounced (50ms) to avoid excessive scans during streaming.

### File-Edit Diff Counts

Write, Edit, and `str_replace_editor` (`command: "str_replace"`) rows already render the applied diff inside an expandable `DiffBlock`. To make the change size visible at a glance, the plugin also wraps the official `tool-call` renderer at `priority: -1`, renders the official `ToolCallTree` unchanged inside a `display: contents` wrapper, then annotates each file-mutation row's file path with a colored line-count badge:

- `+N` (green) for added lines
- `-N` (red) for removed lines
- Combined form: `+N/-N`

For `str_replace_editor`, only the `str_replace` command is annotated; read-only commands like `view` are not treated as file edits.

The badge data is read from the same `callView` / `resultView` diff hunks the official diff card uses, so it works during streaming (call-side diff) and after execution (result-side applied diff).

## 4. File Structure

```
src/
├── host.js         # Marker list state + JSON RPC handlers
├── client.js       # Renderer wrapper + mermaid post-processor + settings UI
└── modules/
    ├── markers.js      # Marker persistence
    ├── text-split.js   # Thinking/text split
    ├── tool-diff.js    # File-edit diff count badges
    ├── wrapper.js      # Assistant + tool-call renderer wrappers
    ├── mermaid.js      # Mermaid DOM observer
    └── settings.js     # Settings UI
```

## 5. RPC Protocol

| Method | Input | Output | Description |
| --- | --- | --- | --- |
| `thinking-tags/get` | `{}` | `{ markers: string[] }` | Get current marker list |
| `thinking-tags/add` | `{ tag: string }` | `{ markers: string[] }` | Add a marker (deduped) |
| `thinking-tags/remove` | `{ tag: string }` | `{ markers: string[] }` | Remove a marker |

## 6. Future Directions

- **CDN fallback**: Multiple mermaid CDN sources for reliability
- **Marker presets**: Common markers for popular models (Claude, GLM, etc.)
- **Static plugin**: Package as npm package with composition row for global installation
- **Per-model markers**: Auto-detect model and apply appropriate markers
- **Theme-aware mermaid**: Match DSH dark/light theme
