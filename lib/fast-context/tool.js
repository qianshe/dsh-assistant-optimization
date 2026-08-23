/**
 * `context_search` tool registration.
 *
 * Key gating (the whole point of this module): the tool and its prompt section
 * are registered ONLY when a Windsurf key resolves. Without a key nothing is
 * registered, so the model neither sees guidance for it nor can call it.
 *
 * The prompt section is deliberately minimal — purpose, when to reach for it,
 * and the smallest call shape. No background, no examples: this text is paid
 * for on every single turn.
 */

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { resolveWindsurfKey } from "./key-source.js";
import { searchWithContent } from "./core.js";

/** Prompt order: tool guidance lives in 100–199; ours sits after the fs tools. */
const PROMPT_ORDER = 150;

/** Hard ceiling for one search (the loop makes maxTurns+1 model calls). */
const TOOL_TIMEOUT_MS = 120000;

/**
 * The minimal model-facing guidance. Purpose + applicability + call shape.
 * Kept to two sentences on purpose: every extra clause is context tax.
 */
const PROMPT_TEXT = [
  'Use context_search to locate code when the target is vague: you know what a feature does but not which files or symbols implement it.',
  'Pass a natural-language query; it returns candidate files with line ranges. Use grep/glob instead whenever you already know an exact string or path.',
].join(' ');

/**
 * Resolve the project root for one call: explicit argument, else the calling
 * session's cwd, else the harness process cwd.
 * @param {unknown} argPath
 * @param {Object} exec - tool run context
 * @returns {string}
 */
function resolveProjectRoot(argPath, exec) {
  if (typeof argPath === 'string' && argPath.trim() !== '') {
    const candidate = argPath.trim();
    return isAbsolute(candidate) ? resolve(candidate) : resolve(sessionCwd(exec) ?? process.cwd(), candidate);
  }
  return sessionCwd(exec) ?? process.cwd();
}

/**
 * The calling agent's session cwd, when the execution carries one.
 * `session.header.cwd` is the durable session working directory (dsh-session
 * SessionHeader); it is absent for sessions created without one.
 * @param {Object} exec
 * @returns {string | undefined}
 */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined;
}

/** Clamp an optional integer argument into range. */
function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Register the tool and its prompt section when a key is available.
 *
 * @param {Object} ctx - the plugin context
 * @returns {Promise<{ registered: boolean, source: string, detail: string }>}
 */
export async function applyFastContextTool(ctx) {
  const tools = ctx.get('tools');
  if (tools === undefined) {
    return { registered: false, source: 'none', detail: 'tools service unavailable' };
  }

  const resolved = await resolveWindsurfKey();
  if (resolved.key === '') {
    // No key → no tool, no prompt. This is the requested behaviour, not a
    // failure: the plugin's other halves stay mounted.
    return { registered: false, source: 'none', detail: resolved.detail };
  }

  const apiKey = resolved.key;

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'dsao:tool:fast-context',
      order: PROMPT_ORDER,
      text: PROMPT_TEXT,
    }), 'dsao: fast-context prompt section');
  }

  ctx.effect(() => tools.register({
    name: 'context_search',
    description:
      'Semantic code search: describe what you are looking for in natural language and get candidate files with line ranges. For vague targets where the exact file, symbol, or string is unknown.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What to find, in natural language (e.g. "where clipboard images are decoded before upload").',
      },
      project_path: {
        type: 'string',
        description: 'Absolute project root to search. Defaults to the session working directory.',
      },
      tree_depth: {
        type: 'integer',
        description: 'Directory-tree depth used for the repo map, 1-6. Defaults to 3 and degrades automatically when the tree is large.',
      },
      max_turns: {
        type: 'integer',
        description: 'Search rounds, 1-5. Defaults to 3. Lower is faster, higher digs deeper.',
      },
      max_results: {
        type: 'integer',
        description: 'Maximum number of files to return, 1-30. Defaults to 10.',
      },
      exclude_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra paths or globs to exclude (node_modules, .git, dist and similar are already excluded).',
      },
    },
    output: {
      // A plain string keeps the canonical value replay-stable: the formatted
      // report is exactly what the model reads.
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    // Read-only: it shells out to ripgrep and reads files, mutating nothing.
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query === '') throw new Error('query must be a non-empty string');

      const projectRoot = resolveProjectRoot(args.project_path, exec);
      let stat;
      try {
        stat = statSync(projectRoot);
      } catch (e) {
        throw new Error(`project_path is not readable: ${projectRoot} (${e.message})`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`project_path is not a directory: ${projectRoot}`);
      }

      const excludePaths = Array.isArray(args.exclude_paths)
        ? args.exclude_paths.filter((p) => typeof p === 'string' && p.trim() !== '')
        : [];

      return await searchWithContent({
        query,
        projectRoot,
        ctx,
        // A key is present by construction; the local model still backs a
        // Windsurf-side auth/rate/network failure.
        brain: 'auto',
        apiKey,
        treeDepth: clampInt(args.tree_depth, 1, 6, 3),
        maxTurns: clampInt(args.max_turns, 1, 5, 3),
        maxResults: clampInt(args.max_results, 1, 30, 10),
        excludePaths,
        signal: exec.signal,
      });
    },
  }), 'dsao: context_search tool');

  return { registered: true, source: resolved.source, detail: resolved.detail };
}
