# dsh-assistant-optimization

> A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin for the web profile that makes model output easier to read and your prompts easier to write.

**[中文文档](./README.zh.md)**

## Features

Eight capabilities, all plug-and-play. Official rendering is never replaced — the plugin shadows DSH components and delegates back to them, so Markdown, tool cards, images, and tables keep working exactly as shipped.

| | Capability | What it does |
|---|---|---|
| 💭 | **Reasoning fold** | Collapses mis-rendered chain-of-thought into the native "Think" block |
| 📊 | **Mermaid diagrams** | Renders mermaid code blocks as interactive SVG (zoom / pan / touch) |
| ✎ | **Tool-call grouping** | Collapses consecutive tool-call rows into one `# bash · N tools` header. Reasoning rows between calls do not break the group — merge across them; collapsed groups tuck those reasoning rows in, expanded groups indent them like members |
| ✨ | **Prompt enhance** | Rewrites a rough draft into a clearer instruction in one click |
| ▶ | **Resume-from-breakpoint** | After a manual stop or session error, the send button becomes a play key — hover shows a tooltip, one click resumes from the interruption with the currently selected model. Typing or starting a new turn instantly restores the normal send button. |
| 📁 | **Turn folding** | When a turn finishes, its process (thinking, tool calls, intermediate text) auto-collapses into one "已完成 · 时长" header; the final summary reply stays expanded. Interrupted-and-resumed turns merge into one group; mid-run steering messages collapse with a "· N 条插话" count. The plugin takes over the built-in transcript mode so folds never double up. |
| 🛰️ | **Semantic search** | `context_search` — locate code from a vague description (Windsurf-backed) |
| 🧹 | **Archived-session cleanup** | Lists what archiving hid, frees the disk it still occupies, and un-archives — in one click, no host restart, no hand-edited JSON |

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

### Edit diff counts (retired)

dsh 0.1.2+ renders native diff statistics on Write & Edit rows, so the plugin's own badges were retired in v1.8.0. The module is kept for older hosts but registers nothing on current versions.

### Prompt enhance

A sparkle button sits left of the send button and rewrites a rough draft into a clearer instruction using the model already selected in the composer. It sends one plain chat request — no session, nothing logged — and replaces the draft in place, so Ctrl/Cmd+Z undoes it.

While running it shows a spinning arc and "增强中"; on success a green check; on failure the icon flashes red with the reason in its tooltip and **the draft is never cleared**. The tooltip uses the same CSS styling as DSH's native button tooltips and also reports how much context the last call actually received — the first thing to check when a rewrite is unhelpful.

### Resume-from-breakpoint

When a conversation stops abnormally — the user clicks **Stop** or the session hits an error — the send button transforms into a ▶ play key. A hover tooltip ("断点续发") appears with the same style as DSH's native button tooltips.

- **One click** sends a resume signal via the host route; the agent picks up from the interruption using whatever model is currently selected in the composer.
- **Instant revert**: typing in the draft, or the agent starting to run, immediately restores the normal send/stop button — no stuck play icon.
- **Gate logic**: reads `session.chat.timeline` for the last closed turn's `turn/end` reason. `aborted` (user stop), `error`, `max-tokens` (truncation), and `interrupted` (crash-repaired by dsh-session's synthetic closers) trigger the play button — the same set the host route accepts. Normal completions and other kinds do not. A `running` bit only blocks the gate when the timeline corroborates it (an open turn): a stale running flag with a fully closed timeline falls through to the terminal check, so a crashed session can always be resumed instead of wedging in "running".
- **Empty marker rows**: when the resume marker enters the transcript, the plugin replaces the blank bubble + copy button with a subtle "已从中断处继续" hint line.
- **Implementation**: CSS-overlay approach — the official button's SVG is hidden via `data-dsao-resume` attribute + a play SVG sibling, so React's re-render cycle is never disrupted.

### Turn folding

**Replaces the built-in fold.** dsh 0.1.2+ ships its own turn-process folding (Settings → Conversation display → Compact). This plugin now drives that setting: while Turn Folding is enabled here, the built-in mode is forced to **Normal** so the plugin’s own fold (duration + steering counts, resume-chain merge) is the only one acting; disabling Turn Folding here hands the column back to the built-in Compact. Toggling either side realigns both.

While a turn runs, everything stays visible — the native "Deep diving…" status with its clock is the running indicator. The moment the turn completes (the final answer lands), the process content of that turn — thinking rows, tool calls, intermediate text — collapses into a single header line: **已完成 · 时长** (errored/stopped turns show 已出错/已停止 instead). Mid-run steering interjections collapse with the turn; the header shows「· N 条插话」when present. What stays visible: your prompt, the final summary reply, and its action row (copy etc.). Click the header to expand the full process; click again to collapse. Expand/collapse choices live in memory only; a fresh page load starts collapsed.

The plan is computed entirely from the session snapshot: turn grouping via `chat.locations`, completion via the turn's `turn/end` reason, the summary reply via the official `turn-tail` node's `closing` pointer, duration from the turn's start/end timestamps (same figures the native clock shows). Toggle under **Settings → General → Turn Folding**.

### Semantic search (`context_search`)

A host-side tool for **vague or unclear** searches: pass a natural-language query and get back the matching files with their line ranges and code. It runs an agentic search loop built on the fast-context approach and driven by a Windsurf key.

**Key gating — the whole point.** The tool and its one-line prompt guidance are registered *only* when a Windsurf key resolves. With no key, nothing is registered, so the model is never told about a tool it cannot call.

The key is resolved in this order (first hit wins): `WINDSURF_API_KEY` env → manual entry (**Settings → General → Windsurf API Key**, stored at `~/.dsh/dsao-windsurf-key`, `0600`) → local auto-read from the logged-in Windsurf/Devin editor's `state.vscdb`. `DSAO_FC_AUTO_KEY=0` disables auto-read. See `lib/fast-context/NOTICE.md` for the non-official protocol note.

### Archived-session cleanup

Archiving a session in dsh 0.1.2 hides it and nothing else: the archive set is a display filter, so the archived row disappears from the grouped list, the flat list **and** search, while its transcript, projection checkpoint, and workspace account keep occupying `~/.dsh`. There is no unarchive action anywhere in the GUI, and the persistence seam ships no deletion API — pruning is documented as "out-of-band backend maintenance". The result is invisible disk that you can neither see, restore, nor clean.

**Settings → Archived sessions** — its own entry in the settings nav, not a row inside General, because this is a workflow page rather than a preference toggle — scans the archive set and reports, per session: title (from the live session list), owning project, transcript path, size, and last write. From there:

- **Delete selected** — unlinks every stored transcript generation (the JSONL backend keeps `session.jsonl[.zstd]` and `session.vN.jsonl[.zstd]` side by side; deleting only the current one would let an older generation resurface after a restart), removes the projection checkpoint row, detaches the session from its project account, announces `api-session/removed` so every open GUI drops the sidebar row immediately (no ghost under ungrouped, no stale "running" dot), and prunes the archive entry. Two clicks: the first arms the button, the second commits. Irreversible — the transcript is the only copy of that history, so the row also carries an **export** link (the built-in `session.export` route) to grab a ZIP first.
- **Un-archive selected** — writes the id back out of the archive set only. Files untouched, the row reappears in the sidebar. This is the missing "unarchive".
- **Select deletable** — picks everything the guards allow.
- **Force mode** (toggle, only offered when the host exposes the agents registry) — unlocks archived sessions that are still **attached**: a running one is first cancelled through the same `agent.cancel` the official stop button uses (queued input dropped too), awaited until settled, and only then deleted. A session that refuses to settle is refused (`not-settled`) rather than unlinked under its writer — the JSONL backend opens the transcript per batch, so an unsettled writer would resurrect a partial file. The session you are currently viewing can never be picked, in any mode.

Nothing here can touch a session you have not archived: the archive set drives the candidate list, so an un-archived id is refused (`not-archived`) even under force — and a protected session is not even cancelled. Attached sessions need force to be offered at all, split by the host's own truth source into `running` (live agent executing) and `attached` (resident but idle — the earlier build mislabeled both as "live-session" and blocked them). A transcript whose path does not match the documented `<root>/<project>/<session-id>/session(.vN)?.jsonl[.zstd]` layout is left alone. All generation artifacts (`session.jsonl[.zstd]` plus any `session.vN.jsonl[.zstd]`) are unlinked; the session directory is removed only if it is then empty, so there is no recursive delete anywhere.

This works **without stopping the host**. Editing `~/.dsh/storages/workspace.json` from outside is unsafe — the JSON `single` layout is memory-authoritative, republishes the whole file on every write, and locks nothing across processes — but inside the host the same facts are reached through the owning services' serialized write chains, so memory and disk move together and the workspace follow stream republishes the archive set. An open GUI tab updates without a refresh. Two of the touches are private-by-type (the archive set has no public mutator, and the checkpoint table is service-internal): both are probed at call time and degrade to an honest report instead of a crash or a guess.

The page speaks only in the host's own `--dsw-alias-*` design tokens — no literal colors, so it re-themes with the shell in light and dark — and models all four states: a skeleton while scanning, an explicit empty state, a retryable error banner, and a result banner that only reads as success when nothing was refused. Interaction states (`hover`, `focus-visible`, `disabled`, the sticky table header, `prefers-reduced-motion`) live in a scoped stylesheet instead of inline styles, because inline styles cannot express them. Rules and rationale: [`docs/technical-reference.md`](./docs/technical-reference.md) §11.7.

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
node test/archive-cleanup.test.mjs
node test/archive-cleanup-panel.test.mjs
node test/archive-cleanup-integration.test.mjs
node test/fast-context-gate.test.mjs
node test/content-embed.test.mjs
node test/turn-fold-sync.test.mjs
node scripts/repro-switch-back.cjs
node scripts/lib-sync-check.cjs
node scripts/build-client.cjs verify
node --check lib/client.js
```

Tests load shipped modules from `lib/client.js` / `lib/index.js`. `lib/client.js` is a build artifact: edit `src/` and regenerate with `node scripts/build-client.cjs build` — never edit by hand. For slot keys, priorities, the reference-extraction contract, the failure-status map, and the full file structure, see [`docs/technical-reference.md`](./docs/technical-reference.md).

## License

MIT
