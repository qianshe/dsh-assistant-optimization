# dsh-assistant-optimization

> A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin for the web profile: folds mis-rendered reasoning into collapsible blocks, renders mermaid inline, shows file-edit diff counts on collapsed tool rows, and rewrites composer drafts with the model you already selected.

**[中文文档](./README.zh.md)**

## Features

**Thinking tag split** — Some providers (OpenAI-compatible APIs without a dedicated `reasoning_content` channel) dump chain-of-thought into the regular text output:

```
The user wants to know about X, I should explain Y first...
</think>
Here is the answer to your question...
```

DSH renders that as one block of message text. This plugin splits it at configurable markers so the reasoning collapses into DSH's native "Think" disclosure and only the answer stays visible.

**Mermaid diagrams** — `` ```mermaid `` blocks become interactive SVG with zoom, pan, and touch support.

**File-edit diff counts** — Write and Edit rows carry `+10/-2` right after the file path, visible without expanding the row. A failed edit produces no diff, so it gets no badge.

**Prompt enhance** — A sparkle button left of the send button rewrites a rough draft into a clearer instruction using the model already selected in the composer. One plain chat request: no session, nothing logged.

**Settings page** — Manage split markers under **Settings → General**.

Official DSH rendering is never replaced. The plugin shadows official components and delegates back to them, so Markdown, tool cards, images, and tables keep working exactly as shipped.

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

## Usage

Nothing to configure to get started.

**Reasoning fold** — When a model emits `</think>` (or any marker you configure), the text before it collapses into a "Think" disclosure.

**Mermaid** — Toolbar buttons zoom and reset; scroll wheel zooms; mouse or touch drag pans.

**Diff counts** — `+N` green for added lines, `-N` red for removed. Errored edits show no badge.

**Custom markers** — **Settings → General → Thinking Tag Markers** adds or removes split markers, since different models use different tags.

**Prompt enhance** — Type a rough draft, click the sparkle button. The draft is replaced in place, so Ctrl/Cmd+Z undoes it. The button is disabled while the draft is empty or a submission is in flight, shows a spinning arc and an "增强中" label while running, then a green check. On failure the icon flashes red with the reason in its tooltip and **the draft is never cleared**. The tooltip also reports how much context the last call actually received, which is the first thing to check when a rewrite is unhelpful:

```
上次上下文：project 74 / instructions 237 (README.md) / summary 0 / asks 663 / results 420
```

### Configuration

| Setting | Default | Description |
|---|---|---|
| Markers | `["</think>"]` | Strings that split reasoning from body text. Multiple markers supported. Stored in `localStorage` under `dsao:thinking-markers`. |

## How It Works

Three tiers, each shadowing or extending a queried slot rather than replacing product UI.

### Message tier — reasoning fold

Registered at `conversation.chat.node` key `assistant-step`, `priority: -1`, shadowing the official renderer at `priority: 0`. The wrapper finds that renderer through `slots.entries()`, splits any `text` block at the configured markers into alternating `reasoning` + `text` blocks, and calls the official renderer with the modified blocks. Everything else — ReasoningRow folding, Markdown, tool cards, image galleries — remains the official renderer's job.

### Tool-row tier — diff badges

Registered at `tool.call.toolview` keys `write` and `edit`, `priority: -1`, shadowing the official `FileMutationRow`. This is a leaf slot, so the wrapper declares no children and needs no `renderSlot` call.

The official row renders inside a `display: contents` container, and the badge is injected into the resulting DOM through a `MutationObserver`. Two properties make that safe:

- **Idempotent injection.** `ensureBadge` returns without touching the DOM when the badge is already in place with matching counts. Without this the observer re-triggers itself into a render loop that freezes the page on expand.
- **Cleanup before anchor lookup.** The official row only renders the file-link button while the call has not failed; an errored call swaps it for an error summary. Since the badge is a node React does not own, that swap would orphan it — so cleanup runs first and never depends on the anchor still existing.

Line counts follow the official `diffCardModel` contract: a settled call reads `resultView` only. An errored mutation has no diff card, so its `callView` is deliberately not used as a fallback.

### Composer tier — prompt enhance

`conversation.input.right` exists, but it renders *before* the model select and the context meter, while the button belongs in the trailing cluster just left of the primary button group. So the entry renders only a hidden anchor there, walks up to the `.trailing` container that owns the primary buttons, and inserts a plain DOM button before the **first** button in the group (send alone when idle; stop+send whenever a run has an interrupt available). Anchoring to the first primary means the button never wedges between stop and send, so the stop button is not displaced. Subagent sessions render nothing: the composer belongs to the delegated agent's draft flow, so the mount returns null and no anchor, button, or network logic is created. Placement follows the same discipline as the diff badge.

The Host half declares `inject: ['webServer']` and registers one loopback-only route, `POST /api/dsao/prompt-enhance`. Row order in the composed tree does not make a service available, so probing `webServer` with `ctx.get` would let the plugin mount before the service exists and skip registration silently. It reads the current model through `ctx.agentDefaultModel.currentSelection()` and issues a single `ctx.llm.stream()` call — no tools, no `sessionId`, no session, nothing logged. The reply lands through the public `inputActions.setDraft()`, which routes through the input machine's normal write path, so browser undo still works.

#### What the rewrite is told

The draft is the source of truth. Everything else is **private reference**: non-output context used only to resolve what the draft refers to, ordered broadest to most specific because DSH declares that more specific instructions take precedence and a model weighs later content more heavily.

| Part | Source |
|---|---|
| Project identity | workspace title + path |
| Instruction outline | project `AGENTS.md` and its `.local` overlay, reduced to headings and rule names |
| Session summary | DSH's own `CompactionSummaryNode.summary` |
| Recent user asks | the tail of user turns — what was requested |
| Recent agent results | each turn's concluding reply — what was finished |

The last two are a pair: asks record intent, results record accomplished fact, and a draft like "接着改" cannot be resolved without both.

Three exclusions keep the reference from carrying anything a rewrite could restate as a false fact:

- **The user-global `~/.dsh/AGENTS.md`.** It describes general agent behaviour, not this project. DSH marks it by display path.
- **Rule prose.** Only headings and rule *names* are extracted — the enhancer needs a map of which constraints exist, and the rules already bind the agent directly.
- **Fenced code blocks, table rows, and sentences containing a standalone quantity**, inside agent replies. That is where transient literals live. Whole sentences are dropped rather than edited, because a placeholder can be copied into the output verbatim and stripping in place leaves stumps. Inline backticks survive with the ticks removed, since `ensureBadge` or `lib/client.js` is an identity — exactly what a rewrite should be able to name.

A `.local` overlay is kept beside its shared file rather than treated as a duplicate: it is the personal, usually git-ignored layer, and DSH injects both, collapsing them only when their trimmed content matches. Per directory one *family* wins — AGENTS over CLAUDE — and it contributes both its shared file and its overlay.

When the conversation window has scrolled the instruction context out of the snapshot, or the project ships no instruction file, the Host reads one itself in preference order: `AGENTS.md`, `CLAUDE.md`, `README.md`.

Failures are reported, never silent: a missing service answers 503, an oversized or empty draft 400/413, a failed or empty model call 502. A response body that is not JSON is reported by status and snippet rather than as a parse error.

### File structure

```
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
```

`lib/client.js` is the shipped artifact: the same modules assembled as `window.__ModuleLoader__.load()` registrations. Change behaviour in both places.

## Development

```bash
node test/diff-stats.test.mjs          # diff counting + error suppression
node test/ensure-badge.test.mjs        # DOM convergence, incl. running → errored
node test/context.test.mjs             # reference extraction + exclusions
node test/prompt-enhance.test.mjs      # button placement + cleanup
node test/host-prompt-enhance.test.mjs # inject contract, route guards, model call
node --check lib/client.js             # bundle syntax
```

The client suites load real modules out of `lib/client.js` and the host suite imports `lib/index.js`, so they exercise the shipped code rather than a re-implementation. Several tests pin contracts that a plausible edit would silently break: that the user-global instruction file never leaks, that the `webServer` injection stays declared while the other services stay optional, and that the enhancer prompt does not grow a new rule per observed failure.

## Requirements

- DSH (DeepSeek Harness) with the web profile
- Internet access only for the mermaid.js CDN, and only when a diagram is present

## License

MIT
