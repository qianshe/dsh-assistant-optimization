// dsh-assistant-optimization — Archived-session cleanup (Host logic, no HTTP).
//
// Why this module exists
// ----------------------
// In dsh 0.1.2 "archive" is a durable *display filter*: `workspaceRegistry`
// keeps an `archivedSessionIds` set, and the Web sidebar subtracts it from the
// grouped list, the flat list, and search results. Archiving deletes nothing,
// and no unarchive action ships at all (`dsh-workspace` README: "Archiving is
// one-way"; "no unarchive action exists yet"). The persistence seam likewise
// exposes no deletion API ("pruning stored sessions is out-of-band backend
// maintenance"), so archived sessions accumulate on disk invisibly.
//
// Doing it live, without stopping the host
// ---------------------------------------
// Editing `~/.dsh/storages/workspace.json` from another process is unsafe: the
// JSON `single` layout keeps the unit in memory and republishes the whole file
// on every write, with no cross-process lock. Inside the host process there is
// no such conflict — writes go through the owning service's serialized domain
// write chain, so memory and disk move together and the workspace follow
// stream republishes (`domain/changed` -> `archived` increment), which is why
// an open GUI updates without a refresh.
//
// API surface actually used, and the one gap
// -----------------------------------------
//   public   registry.archivedSessionIds / registry.list()
//   public   Workspace.detachSession(id)          (idempotent, own write chain)
//   public   sessionPersistence.list() / locate(meta)
//            (list() returns headers directly on older backends and
//             `SessionPersistenceSnapshot` envelopes — `{ header, revision }` —
//             on newer ones; both shapes are handled)
//   private  registry.state / setState / enqueueOperation   <- archive-set prune
//   private  sessionProjectionCache.table                   <- checkpoint row
// The archive set has NO public mutator (`archiveSession` only appends), and a
// plugin cannot open the `workspace` domain itself (`storageDomain.open` throws
// `already-open`). So the prune reaches for the registry's own private write
// path — the same `global.set` chain the registry uses internally, which is what
// actually matters for coherence. Both private touches are probed, never
// assumed: when they are absent the caller still gets files back and an honest
// `unavailable` report instead of a crash.
//
// Ordering invariant
// ------------------
// membership -> transcript -> checkpoint -> archive set. Membership first keeps
// `detachSession` working off a still-readable account; the archive set goes
// last because a crash midway must never leave a session that is *visible* in
// the sidebar while its log is already gone. The opposite residue (log gone,
// id still archived) is invisible and retryable.
//
// Deletion guardrail
// ------------------
// Only ids that are (a) in `archivedSessionIds` and (b) not live may lose a
// byte. The unit of deletion is the **session directory** —
// `<root>/<project-dir>/<session-id>/` — which the JSONL backend itself
// declares session-owned. Purging that directory recursively is what actually
// finishes the job: the backend keeps one log per Session format generation
// (`session.jsonl[.zstd]` for v0, `session.vN.jsonl[.zstd]` for v1+, e.g.
// `session.v3.jsonl.zstd`) and treats the newest remaining file as the
// session, so unlinking only the file `locate()` names can leave an older
// generation behind to resurrect the row on the next restart.
//
// The recursion is bounded by three checks that must pass before any byte
// goes: the path comes from the backend's own `locate(header)` (never from
// caller input), the located basename still matches the generation filename
// shape, and the session directory's name equals the id as the backend encodes
// path segments (`encodeSegment`, the identity for `session-<uuid>` ids). If
// any check fails the id is reported `kept` and stays archived — retryable,
// never silently un-hidden.
//
// The `<project-dir>` level is never touched: a mis-scoped delete there would
// take sibling sessions with it.
//
// Stored-log shape
// ----------------
// `sessionPersistence.list()` has shipped in two shapes: a bare
// `SessionHeader[]` (older backends) and, since the snapshot seam, a
// `SessionPersistenceSnapshot[]` carrying the header under `.header`. Both are
// read here. A listing whose entries cannot be mapped to ids at all is
// reported loudly (scan throws, remove refuses every id) instead of being
// mistaken for "no stored logs" — silently pruning the archive set on that
// misunderstanding is exactly how deleted-but-not-really sessions reappear
// under 未分组.

import { readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const ARCHIVES_ROUTE_PATH = '/api/dsao/archives';

/**
 * The shipped JSONL backend's transcript file names (README: On-disk layout).
 * Generation 0 keeps the original `session.jsonl`; every later generation
 * adds a lowercase `.vN` component before `.jsonl` (v1, v2, v3, …). The
 * optional `.zstd` suffix marks Zstandard compression. Used to validate that
 * `locate()` really pointed at a session log before the directory around it is
 * purged — it is not used to decide which files inside the directory survive.
 */
const TRANSCRIPT_PATTERN = /^session(?:\.v[0-9]+)?\.jsonl(?:\.zstd)?$/;
/** Refuse batches larger than this; a GUI page of archived sessions never nears it. */
export const MAX_IDS_PER_CALL = 512;

/**
 * Mirror of the JSONL backend's path-segment escaping for session ids: keep
 * `A-Za-z0-9._-`, escape everything else as `~XXXX`, and special-case the two
 * relative segments. The backend owns the real implementation; this copy only
 * serves the delete guard, which accepts a session directory named either
 * `<id>` or `<encoded id>` so ids that need escaping are not falsely refused.
 * @param raw - the raw session id.
 * @returns the id as it appears as one filesystem path segment.
 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const ch = String.fromCharCode(code);
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Whether an fs error is the "not there" case (never a reason to delete). */
function isMissing(error) {
  return error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/**
 * Normalize a caller-supplied id list: strings only, trimmed, de-duplicated,
 * order preserved, capped.
 * @param raw - whatever the request body carried.
 * @returns {{ ids: string[], overflow: boolean }} capped list plus an overflow flag.
 */
export function parseIdList(raw) {
  if (!Array.isArray(raw)) return { ids: [], overflow: false };
  const seen = new Set();
  const ids = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > MAX_IDS_PER_CALL) return { ids: ids.slice(0, MAX_IDS_PER_CALL), overflow: true };
  return { ids, overflow: false };
}

/** String-view a branded id list without assuming it is an array of strings. */
function toIds(list) {
  return Array.isArray(list) ? list.map((id) => String(id)) : [];
}

/**
 * Build the cleanup capability over already-resolved host services.
 * Every service except `registry` and `persistence` is optional, and every
 * private reach is probed at call time (not at construction) so a host upgrade
 * that reshapes internals degrades to a report rather than a mount failure.
 *
 * @param deps - injected dependencies (all probed defensively).
 * @param deps.registry - `ctx.workspaceRegistry`.
 * @param deps.persistence - `ctx.sessionPersistence`.
 * @param deps.sessions - `ctx.sessions` (live-session registry; absence = "nothing is live").
 * @param deps.cache - `ctx.sessionProjectionCache` (checkpoint rows).
 * @param [deps.fileOps] - fs overrides for tests `{ readdir, stat, rm }`.
 * @returns the cleanup facade `{ scan, remove, restore, capabilities }`.
 */
export function createArchiveCleanup(deps) {
  const registry = deps.registry;
  const persistence = deps.persistence;
  const sessions = deps.sessions;
  const cache = deps.cache;
  // Live agent registry (`ctx.agents`): get(id) → { status: 'idle'|'running', cancel(cause) }.
  // Required only for force-deleting attached sessions; absent → force is refused.
  const agents = deps.agents;
  const fs = deps.fileOps || { readdir, stat, rm };
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // How long a forced delete waits for a cancelled agent to settle before
  // refusing. An unsettled agent still owns the session writer, and the JSONL
  // backend opens the transcript per batch — unlinking under it would let the
  // next flush resurrect a partial file.
  const settleTimeoutMs = typeof deps.settleTimeoutMs === 'number' ? deps.settleTimeoutMs : 8000;
  // Broadcast hub for `api-session/removed` (dsh-api-remotes forwards every
  // emit-mode event to connected clients). Without it, a client's session-list
  // store keeps the deleted row as a ghost: the archive filter that hid it is
  // pruned by this very operation, so the ghost resurfaces under 未分组, and
  // any ghost whose last running bit was true shows 运行中 forever with no
  // live agent behind it to stop or resume. Absent (older hosts, tests): the
  // deletion still stands, nothing is announced.
  const notifyRemoved = typeof deps.notifyRemoved === 'function' ? deps.notifyRemoved : undefined;

  /** Ids of sessions the host process currently holds open (attached, running or not). */
  function liveIds() {
    const list = typeof sessions?.list === 'function' ? sessions.list() : [];
    return new Set(Array.isArray(list) ? list.map((session) => String(session?.id ?? session)) : []);
  }

  /**
   * Whether one session's live agent is actually executing right now.
   * `sessions.list()` marks a session ATTACHED (resident), which is not the
   * same thing as running — an opened-then-finished session is attached and
   * idle. The host's own list summary uses exactly this agent status
   * (`ctx.agents.get(id)?.status === 'running'`), so the panel's badge and the
   * force guard follow the same truth source.
   */
  function agentStatus(id) {
    if (typeof agents?.get !== 'function') return undefined;
    let agent;
    try {
      agent = agents.get(id);
    } catch {
      return undefined;
    }
    if (agent === undefined || agent === null) return 'none';
    return typeof agent.status === 'string' ? agent.status : 'unknown';
  }

  /**
   * Bring a running agent to rest before its session is force-deleted: cancel
   * the active turn (dropping queued input too — a kept inbox would run after
   * settlement and resurrect the transcript), then wait for the status to
   * leave 'running'.
   * @returns {Promise<'settled'|'refused'|'timeout'>} whether it is safe to unlink.
   */
  async function settleAgent(id, entry) {
    if (typeof agents?.get !== 'function') return 'refused';
    const agent = agents.get(id);
    if (agent === undefined || agent === null) return 'settled';
    if (agent.status !== 'running') return 'settled';
    if (typeof agent.cancel !== 'function') return 'refused';
    try {
      // No keepInbox: queued messages must not run after settlement.
      agent.cancel({ kind: 'user' });
      entry.cancelled = true;
    } catch {
      return 'refused';
    }
    const deadline = Date.now() + settleTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(50);
      const current = agents.get(id);
      if (current === undefined || current === null || current.status !== 'running') return 'settled';
    }
    return 'timeout';
  }

  /**
   * Workspace entities owning one session id, straight from the registry.
   * `Workspace.sessionIds` is the filtered getter, so an id whose header is
   * already unreadable may not appear; that is acceptable here — detach is
   * idempotent, and every accepted workspace mutation also prunes durably
   * filtered candidates on the write chain.
   */
  function ownersOf(id) {
    const all = typeof registry?.list === 'function' ? registry.list() : [];
    const owners = [];
    for (const workspace of Array.isArray(all) ? all : []) {
      if (workspace === null || typeof workspace !== 'object') continue;
      if (toIds(workspace.sessionIds).includes(id)) owners.push(workspace);
    }
    return owners;
  }

  /**
   * Stored headers keyed by string id, re-read per operation (never cached).
   * `sessionPersistence.list()` returned bare headers before the snapshot seam
   * and returns `SessionPersistenceSnapshot` envelopes (`{ header, revision }`)
   * after it, so both are unwrapped here.
   *
   * `shape` distinguishes three outcomes that must not be conflated:
   * `empty` (the root really holds no stored session — the bookkeeping-only
   * cleanup case), `ok` (entries mapped to ids), and `unknown` (entries came
   * back but none could be mapped — a listing shape we do not understand).
   * Treating `unknown` as `empty` is what previously pruned the archive set
   * while leaving every byte on disk, resurrecting the session under 未分组.
   * @returns {Promise<{ byId: Map<string, object>, shape: 'ok'|'empty'|'unknown', listed: number }>}
   */
  async function storedHeaders() {
    const listed = typeof persistence?.list === 'function' ? await persistence.list() : [];
    const rows = Array.isArray(listed) ? listed : [];
    const byId = new Map();
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const header = row.header !== null && typeof row.header === 'object' ? row.header : row;
      const id = header.id;
      if (typeof id === 'string' || typeof id === 'object') byId.set(String(id), header);
    }
    const shape = rows.length === 0 ? 'empty' : byId.size === 0 ? 'unknown' : 'ok';
    return { byId, shape, listed: rows.length };
  }

  /** Loud, actionable failure for a listing shape the guard cannot read. */
  function headerShapeError(stored) {
    return new Error(
      `sessionPersistence.list() returned ${stored.listed} entries with no readable session id; `
      + 'refusing to delete anything, and the archive set stays untouched (un-archive still '
      + 'works, since it needs no stored-log lookup)',
    );
  }

  /**
   * Resolve the **session directory** to purge and verify the guards that make
   * a recursive delete safe: the path must come from the backend's own
   * `locate()`, its basename must still look like a session log generation, and
   * the directory must be named after this id (raw or path-segment encoded).
   * Returning a problem string instead of a path is how the guardrail reports
   * itself; a problem means "delete nothing, keep it archived".
   * @returns {{ path?: string, dirPath?: string, problem?: string }}
   */
  function transcriptOf(header, id) {
    if (typeof persistence?.locate !== 'function') return { problem: 'locate-unavailable' };
    let location;
    try {
      location = persistence.locate(header);
    } catch (error) {
      return { problem: `locate-failed: ${errorMessage(error)}` };
    }
    const path = location !== null && typeof location === 'object' && typeof location.path === 'string'
      ? location.path
      : '';
    if (path === '') return { problem: 'no-location' };
    const dirPath = dirname(path);
    if (!TRANSCRIPT_PATTERN.test(basename(path))) return { problem: 'unexpected-layout' };
    const dirName = basename(dirPath);
    if (dirName !== id && dirName !== encodeSegment(id)) return { problem: 'unexpected-layout' };
    return { path, dirPath };
  }

  /** Whether the archive set can be pruned through the registry's own write chain. */
  function canPruneArchive() {
    return typeof registry?.setState === 'function' && registry?.state !== undefined && registry?.state !== null;
  }

  /** Whether checkpoint rows can be dropped through the cache's domain table. */
  function canDropCheckpoint() {
    return typeof cache?.table?.delete === 'function';
  }

  /**
   * Drop ids from `archivedSessionIds`. Runs inside the registry's own
   * operation queue when that queue exists, so it serializes against a
   * concurrent `archiveSession` instead of racing its check-then-write pair.
   * @param {string[]} drop - ids to un-archive (or forget after deletion).
   * @returns {Promise<boolean>} true when the write was attempted and held.
   */
  async function pruneArchiveSet(drop) {
    const dropSet = new Set(drop);
    if (dropSet.size === 0) return true;
    if (!canPruneArchive()) return false;
    const operation = async () => {
      const state = registry.state;
      const current = toIds(state?.archivedSessionIds);
      const kept = (state?.archivedSessionIds ?? []).filter((id) => !dropSet.has(String(id)));
      if (kept.length === current.length) return true;
      await registry.setState({ ...state, archivedSessionIds: kept });
      return true;
    };
    try {
      if (typeof registry.enqueueOperation === 'function') return await registry.enqueueOperation(operation);
      return await operation();
    } catch (error) {
      return false;
    }
  }

  /** Full read-only inventory: what is archived, where it lives, what it costs. */
  async function scan() {
    const archived = toIds(registry?.archivedSessionIds);
    const live = liveIds();
    const stored = await storedHeaders();
    // An unmappable listing is not "no stored sessions": say so instead of
    // reporting every archive row as a bookkeeping-only residue.
    if (stored.shape === 'unknown') throw headerShapeError(stored);
    const items = [];
    const missing = [];
    let totalBytes = 0;
    for (const id of archived) {
      const isLive = live.has(id);
      const header = stored.byId.get(id);
      const workspaces = ownersOf(id).map((workspace) => ({
        id: String(workspace.id),
        title: typeof workspace.title === 'string' ? workspace.title : '',
        path: typeof workspace.path === 'string' ? workspace.path : '',
      }));
      if (header === undefined) {
        // Same workspace shape as the rows below: the GUI renders a project
        // *name* out of it, and flattening to strings here would drop the path
        // it falls back to when a workspace has no title.
        missing.push({ id, live: isLive, running: false, attached: isLive, workspaces, reason: 'no-stored-log' });
        continue;
      }
      const located = transcriptOf(header, id);
      const status = agentStatus(id);
      const running = status === 'running';
      const entry = {
        id,
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        live: isLive,
        running,
        attached: isLive,
        path: located.path ?? '',
        dirPath: located.dirPath ?? '',
        bytes: null,
        mtime: null,
        workspaces,
      };
      if (located.problem !== undefined) entry.problem = located.problem;
      else {
        // The delete unit is the whole session directory, so the reported size
        // is the directory's total, not just the generation `locate()` names —
        // an older generation sitting beside it is freed bytes too.
        const usage = await dirUsage(fs, located.dirPath);
        if (usage === null) entry.problem = 'dir-missing';
        else {
          entry.bytes = usage.bytes;
          entry.files = usage.files;
          entry.mtime = usage.mtime;
          totalBytes += usage.bytes;
        }
      }
      items.push(entry);
    }
    const liveArchived = items.filter((item) => item.live).map((item) => item.id);
    const runningArchived = items.filter((item) => item.running).map((item) => item.id);
    const allRows = items.concat(missing);
    return {
      archivedIds: archived,
      items,
      missing,
      live: liveArchived,
      running: runningArchived,
      totalBytes,
      // Anything not in the archive set can never be selected by this surface.
      // Deletable without force = archived and not resident. Force-deletable =
      // archived and resident (idle-attached or running), offered only when
      // the agents registry is reachable (capabilities.force).
      deletableIds: allRows.filter((row) => !row.live).map((row) => row.id),
      forceDeletableIds: allRows.filter((row) => row.live).map((row) => row.id),
      unarchivableIds: archived.filter((id) => !live.has(id)),
      capabilities: {
        archivePrune: canPruneArchive(),
        checkpointDelete: canDropCheckpoint(),
        detach: typeof registry?.list === 'function',
        force: typeof agents?.get === 'function',
      },
      // Lets the GUI notice the registry moved under it (e.g. another tab).
      storedCount: stored.byId.size,
      archivedCount: archived.length,
    };
  }

  /**
   * Permanently remove archived sessions: the whole session directory (every
   * stored log generation plus any other session-owned artifact), the
   * projection checkpoint row, the workspace account, the removal
   * announcement, and the archive entry.
   * @param {string[]} rawIds - requested ids; anything not archived is refused.
   * @param {object} [options] - operation options.
   * @param {boolean} [options.force] - also delete ARCHIVED sessions that are
   *   still attached (resident): a running agent is cancelled (queued input
   *   dropped too) and awaited to settle before any byte is touched. force
   *   never bypasses the archive-set authorization boundary, and never unlinks
   *   under an agent that refuses to settle (refused: 'not-settled').
   * @returns {Promise<object>} per-id outcome plus what could not be cleaned.
   */
  async function remove(rawIds, options = {}) {
    const force = options.force === true;
    const { ids, overflow } = parseIdList(rawIds);
    const archived = new Set(toIds(registry?.archivedSessionIds));
    const live = liveIds();
    const stored = await storedHeaders();
    // Same rule as scan(): an unmappable listing must never be read as "these
    // sessions have no data". Refuse the whole batch rather than prune.
    if (stored.shape === 'unknown') throw headerShapeError(stored);
    const deleted = [];
    const refused = [];
    const errors = [];
    const cleaned = [];
    for (const id of ids) {
      if (!archived.has(id)) {
        refused.push({ id, reason: 'not-archived' });
        continue;
      }
      if (live.has(id) && !force) {
        refused.push({ id, reason: agentStatus(id) === 'running' ? 'running' : 'attached' });
        continue;
      }
      const entry = { id, log: 'absent', bytes: 0, checkpoint: 'none' };
      // 0. force: bring the live agent to rest before anything touches the log.
      // The JSONL backend opens the transcript per batch, so an unsettled
      // writer would resurrect a partial file on its next flush.
      if (live.has(id)) {
        const settled = await settleAgent(id, entry);
        if (settled !== 'settled') {
          refused.push({ id, reason: settled === 'timeout' ? 'not-settled' : 'no-agent-control' });
          continue;
        }
        entry.forced = true;
      }
      // 1. membership (public API, own write chain) — before the log disappears
      for (const workspace of ownersOf(id)) {
        try {
          if (typeof workspace.detachSession === 'function') await workspace.detachSession(id);
        } catch (error) {
          errors.push({ id, step: 'detach', detail: errorMessage(error) });
        }
      }
      // 2. transcript — the session directory is the unit of deletion
      const header = stored.byId.get(id);
      if (header !== undefined) {
        const located = transcriptOf(header, id);
        if (located.problem !== undefined) {
          // Bookkeeping still proceeds; the transcript is reported untouched so
          // the caller can see this id was NOT deleted by us.
          entry.log = 'kept';
          errors.push({ id, step: 'transcript', detail: located.problem });
        } else {
          try {
            // Purge the whole session directory. `locate()` names only the
            // current generation, and the backend promotes the newest file it
            // finds, so anything narrower can leave an older generation to
            // resurrect the session after a restart.
            const outcome = await purgeSessionDir(fs, located.dirPath);
            entry.log = outcome.status;
            entry.bytes = outcome.bytes;
            entry.files = outcome.files;
          } catch (error) {
            entry.log = 'failed';
            errors.push({ id, step: 'transcript', detail: errorMessage(error) });
          }
        }
        entry.cwd = typeof header.cwd === 'string' ? header.cwd : '';
      }
      // 3. projection checkpoint row
      if (canDropCheckpoint()) {
        try {
          const removed = await cache.table.delete(id);
          entry.checkpoint = removed === false ? 'absent' : 'removed';
        } catch (error) {
          entry.checkpoint = 'failed';
          errors.push({ id, step: 'checkpoint', detail: errorMessage(error) });
        }
      } else {
        entry.checkpoint = 'unavailable';
      }
      // 3b. tell every connected client the session is gone, so the list store
      // drops the row instead of keeping a ghost. The client relays this into
      // `handleSessionRemoved` -> `recordMutation({kind:'remove'})`, which
      // filters the id out of `summaries` (api-session-controller client.js
      // `applyMutation`). Only a row that actually went away is announced: a
      // kept or failed transcript leaves a loadable session behind.
      if (notifyRemoved !== undefined && (entry.log === 'removed' || entry.log === 'absent')) {
        try {
          notifyRemoved(id);
          entry.announced = true;
        } catch (error) {
          errors.push({ id, step: 'announce', detail: errorMessage(error) });
        }
      }
      // Only an id whose durable log is really gone may leave the archive set.
      // A kept/failed transcript still loads from disk, so the id must stay
      // archived (invisible in the sidebar) and remain retryable instead of
      // resurfacing under 未分组 on the next restart.
      if (entry.log === 'removed' || entry.log === 'absent') cleaned.push(id);
      deleted.push(entry);
    }
    // 4. archive set last (see ordering invariant)
    const archivePruned = await pruneArchiveSet(cleaned);
    return {
      deleted,
      refused,
      errors,
      overflow,
      archivePruned,
      forced: force,
      note: archivePruned
        ? undefined
        : 'transcript and account cleanup done; the archive set could not be written in-process',
    };
  }

  /**
   * Un-archive without touching any file: the only supported way back, since
   * dsh ships no unarchive action.
   * @param {string[]} rawIds - archived ids to bring back into the sidebar.
   * @returns {Promise<object>} restored / refused / overflow.
   */
  async function restore(rawIds) {
    const { ids, overflow } = parseIdList(rawIds);
    const archived = new Set(toIds(registry?.archivedSessionIds));
    const restored = [];
    const refused = [];
    for (const id of ids) {
      if (archived.has(id)) restored.push(id);
      else refused.push({ id, reason: 'not-archived' });
    }
    const archivePruned = await pruneArchiveSet(restored);
    return { restored: archivePruned ? restored : [], refused, overflow, archivePruned, requested: restored };
  }

  return {
    scan,
    remove,
    restore,
    capabilities: () => ({
      archivePrune: canPruneArchive(),
      checkpointDelete: canDropCheckpoint(),
      detach: typeof registry?.list === 'function',
    }),
  };
}

/**
 * Remove one session's whole directory (recursively) after the caller's
 * layout guards have accepted it. The backend defines this directory as
 * session-owned and keeps one log per Session format generation inside it
 * (`session.jsonl` for v0, `session.vN.jsonl` for v1+), promoting the newest
 * file it finds. Deleting only the file `locate()` names therefore leaves an
 * older generation to resurrect the session on the next restart — the whole
 * directory has to go. Scope is exactly one session directory: never the
 * project directory, never a path the caller supplied.
 *
 * @param fs - injected fileOps (`readdir`, `stat`, `rm`).
 * @param dirPath - the session-owned directory under the sessions root.
 * @returns {{ status: 'removed'|'absent', bytes: number, files: number }} —
 *   `absent` when the directory is already gone (nothing to free, but the
 *   bookkeeping may be cleaned); `removed` with the best-effort byte count of
 *   what the purge took.
 */
async function purgeSessionDir(fs, dirPath) {
  const usage = await dirUsage(fs, dirPath);
  if (usage === null) return { status: 'absent', bytes: 0, files: 0 };
  // Recursive + force: this is the whole point of the page — the history is
  // gone for good. The guard that matters is upstream, in `transcriptOf`.
  await fs.rm(dirPath, { recursive: true, force: true });
  return { status: 'removed', bytes: usage.bytes, files: usage.files };
}

/**
 * Best-effort size/date probe for one session directory: the sum of its direct
 * entries plus their newest mtime. `null` when the directory does not exist —
 * which is reported, not guessed at.
 * @param fs - injected fileOps (`readdir`, `stat`).
 * @param dirPath - the session directory to measure.
 * @returns {Promise<{ bytes: number, files: number, mtime: string|null }|null>}
 */
async function dirUsage(fs, dirPath) {
  let names;
  try {
    names = await fs.readdir(dirPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let bytes = 0;
  let newest = null;
  for (const name of names) {
    try {
      const info = await fs.stat(join(dirPath, name));
      if (typeof info.size === 'number') bytes += info.size;
      const stamp = info.mtime instanceof Date ? info.mtime.getTime() : null;
      if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
    } catch {
      /* a vanished entry contributes nothing to the estimate */
    }
  }
  return { bytes, files: names.length, mtime: newest === null ? null : new Date(newest).toISOString() };
}

/** Best-effort error text for JSON responses. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
