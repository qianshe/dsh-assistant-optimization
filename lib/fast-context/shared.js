/**
 * Shared utilities for Fast Context search.
 *
 * Ported from fast-context-mcp src/shared.mjs (MIT, see NOTICE.md).
 * Change: tree-node-cli replaced by a pure node:fs tree renderer (renderTree),
 * avoiding the extra dependency; output format matches closely enough for the
 * model (root line + ├──/└── branches + │ indentation, hidden dirs skipped).
 */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveWithinRoot } from "./path-safety.js";

// ─── Constants ─────────────────────────────────────────────

/** Max safe tree size in bytes (server payload limit ~346KB, fixed overhead ~26KB) */
export const MAX_TREE_BYTES = 250 * 1024;

/** Injected after last effective search round to force an answer (Windsurf [TOOL_CALLS]/XML format) */
export const FINAL_FORCE_ANSWER =
  "You have no turns left. Now you MUST provide your final ANSWER, even if it's not complete.";

// ─── Pure-fs tree renderer (tree-node-cli replacement) ─────

/**
 * Render a directory tree: root label first, then ├──/└── branches with │
 * indentation, hidden (dot) entries skipped, sorted by name.
 * @param {string} root
 * @param {number} maxDepth
 * @param {{ excludeRegexes?: RegExp[], virtualRoot?: string }} [opts]
 * @returns {string}
 */
export function renderTree(root, maxDepth, opts = {}) {
  const { excludeRegexes = [], virtualRoot } = opts;
  const lines = [virtualRoot || basename(root) || root];
  const walk = (dir, depth, prefix) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
    } catch {
      return;
    }
    if (excludeRegexes.length) {
      entries = entries.filter((e) => !excludeRegexes.some((rx) => rx.test(e.name)));
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    entries.forEach((e, idx) => {
      const last = idx === entries.length - 1;
      const branch = last ? "└── " : "├── ";
      lines.push(prefix + branch + e.name + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory() && depth < maxDepth) {
        walk(join(dir, e.name), depth + 1, prefix + (last ? "    " : "│   "));
      }
    });
  };
  walk(root, 1, "");
  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Convert an exclude pattern (directory/file name or simple glob) to RegExp.
 * @param {string} pattern - e.g. "node_modules", "dist", "*.min.*"
 * @returns {RegExp}
 */
export function _excludePatternToRegex(pattern) {
  if (!/[*?]/.test(pattern)) {
    return new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
  }
  let regex = "^";
  for (const c of pattern) {
    if (c === "*") regex += ".*";
    else if (c === "?") regex += ".";
    else if (".+^${}()|[]\\".includes(c)) regex += "\\" + c;
    else regex += c;
  }
  return new RegExp(regex + "$");
}

/**
 * Get a directory tree of the project with adaptive depth fallback.
 *
 * Tries the requested depth first. If the tree output exceeds MAX_TREE_BYTES,
 * automatically falls back to lower depths until it fits.
 *
 * @param {string} projectRoot
 * @param {number} [targetDepth=3] - Desired tree depth (1-6)
 * @param {string[]} [excludePaths=[]] - Patterns to exclude from tree
 * @returns {{ tree: string, depth: number, sizeBytes: number, fellBack: boolean }}
 */
export function getRepoMap(projectRoot, targetDepth = 3, excludePaths = []) {
  const dirName = basename(projectRoot) || projectRoot;
  const excludeRegexes = excludePaths.length ? excludePaths.map(_excludePatternToRegex) : [];

  for (let L = targetDepth; L >= 1; L--) {
    try {
      const treeStr = renderTree(projectRoot, L, { excludeRegexes, virtualRoot: "/codebase" });
      const sizeBytes = Buffer.byteLength(treeStr, "utf-8");
      if (sizeBytes <= MAX_TREE_BYTES) {
        return { tree: treeStr, depth: L, sizeBytes, fellBack: L < targetDepth };
      }
    } catch {
      // tree failed at this level, try lower
    }
  }

  // Ultimate fallback: simple ls
  try {
    let entries = readdirSync(projectRoot).sort();
    if (excludeRegexes.length) {
      entries = entries.filter((e) => !excludeRegexes.some((rx) => rx.test(e)));
    }
    const treeStr = ["/codebase", ...entries.map((e) => `├── ${e}`)].join("\n");
    return { tree: treeStr, depth: 0, sizeBytes: Buffer.byteLength(treeStr, "utf-8"), fellBack: true };
  } catch {
    const treeStr = "/codebase\n(empty or inaccessible)";
    return { tree: treeStr, depth: 0, sizeBytes: treeStr.length, fellBack: true };
  }
}

/**
 * Parse answer XML into structured file + range data.
 * @param {string} xmlText
 * @param {string} projectRoot
 * @returns {{ files: Array }}
 */
export function _parseAnswer(xmlText, projectRoot) {
  const files = [];
  const fileRegex = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
  let fm;
  while ((fm = fileRegex.exec(xmlText)) !== null) {
    const vpath = fm[2];
    let rel = vpath.replace(/^\/codebase[\/\\]?/, "");
    rel = rel.replace(/^[\/\\]+/, "");

    let fullPath;
    try {
      fullPath = resolveWithinRoot(projectRoot, vpath);
    } catch {
      continue;
    }

    const ranges = [];
    const rangeRegex = /<range>(\d+)-(\d+)<\/range>/g;
    let rm;
    while ((rm = rangeRegex.exec(fm[3])) !== null) {
      ranges.push([parseInt(rm[1], 10), parseInt(rm[2], 10)]);
    }
    files.push({ path: rel, full_path: fullPath, ranges });
  }
  return { files };
}

// ─── Prompt Builders ───────────────────────────────────────

const PROMPT_HEAD = `You are an expert software engineer, responsible for providing context \
to another engineer to solve a code issue in the current codebase. \
The user will present you with a description of the issue, and it is \
your job to provide a series of file paths with associated line ranges \
that contain ALL the information relevant to understand and correctly \
address the issue.

# IMPORTANT:
- A relevant file does not mean only the files that must be modified to \
solve the task. It means any file that contains information relevant to \
planning and implementing the fix, such as the definitions of classes \
and functions that are relevant to the pieces of code that will have to \
be modified.
- You should include enough context around the relevant lines to allow \
the engineer to understand the task correctly. You must include ENTIRE \
semantic blocks (functions, classes, definitions, etc). For example:
If addressing the issue requires modifying a method within a class, then \
you should include the entire class definition, not just the lines around \
the method we want to modify.
- NEVER truncate these blocks unless they are very large (hundreds of \
lines or more, in which case providing only a relevant portion of the \
block is acceptable).
- Your job is to essentially alleviate the job of the other engineer by \
giving them a clean starting context from which to start working. More \
precisely, you should minimize the number of files the engineer has to \
read to understand and solve the task correctly (while not providing \
irrelevant code snippets).

# ENVIRONMENT
- Working directory: /codebase. Make sure to run commands in this \
directory, not \`.
- Allowed sub-commands (schema-enforced):
  - rg: Search for patterns in files using ripgrep
    - Required: pattern (string), path (string)
    - Optional: include (array of globs), exclude (array of globs)
  - readfile: Read contents of a file with optional line range
    - Required: file (string)
    - Optional: start_line (int), end_line (int) — 1-indexed, inclusive
  - tree: Display directory structure as a tree
    - Required: path (string)
    - Optional: levels (int)

# THINKING RULES
- Think step-by-step. Plan, reason, and reflect before each tool call.
- Use tool calls liberally and purposefully to ground every conclusion \
in real code, not assumptions.
- If a command fails, rethink and try something different; do not \
complain to the user.

# FAST-SEARCH DEFAULTS (optimize rg/tree on large repos)
- Start NARROW, then widen only if needed. Prefer searching likely code \
roots first (e.g., \`src/\`, \`lib/\`, \`app/\`, \`packages/\`, \`services/\`) \
instead of \`/codebase\`.
- Prefer fixed-string search for literals: escape patterns or keep regex \
simple. Use smart case; avoid case-insensitive unless necessary.
- Prefer file-type filters and globs (in include) over full-repo scans.
- Default EXCLUDES for speed (apply via the exclude array): \
node_modules, .git, dist, build, coverage, .venv, venv, target, out, \
.cache, __pycache__, vendor, deps, third_party, logs, data, *.min.*
- Skip huge files where possible; when opening files, prefer reading \
only relevant ranges with readfile.
- Limit directory traversal with tree levels to quickly orient before \
deeper inspection.

# SOME EXAMPLES OF WORKFLOWS
- MAP – Use \`tree\` with small levels; \`rg\` on likely roots to grasp \
structure and hotspots.
- ANCHOR – \`rg\` for problem keywords and anchor symbols; restrict by \
language globs via include.
- TRACE – Follow imports with targeted \`rg\` in narrowed roots; open \
files with \`readfile\` scoped to entire semantic blocks.
- VERIFY – Confirm each candidate path exists by reading or additional \
searches; drop false positives (tests, vendored, generated) unless they \
must change.
`;

const WINDSURF_TOOL_USE = `# TOOL USE GUIDELINES
- You must use a SINGLE restricted_exec call in your answer, that lets \
you execute at most {max_commands} commands in a single turn. Each command must be \
an object with a \`type\` field of \`rg\`, \`readfile\`, or \`tree\` and the appropriate fields for that type.
- Example restricted_exec usage:
[TOOL_CALLS]restricted_exec[ARGS]{{
  "command1": {{
    "type": "rg",
    "pattern": "Controller",
    "path": "/codebase/slime",
    "include": ["**/*.py"],
    "exclude": ["**/node_modules/**", "**/.git/**", "**/dist/**", \
"**/build/**", "**/.venv/**", "**/__pycache__/**"]
  }},
  "command2": {{
    "type": "readfile",
    "file": "/codebase/slime/train.py",
    "start_line": 1,
    "end_line": 200
  }},
  "command3": {{
    "type": "tree",
    "path": "/codebase/slime/",
    "levels": 2
  }}
}}
- You have at most {max_turns} turns to interact with the environment by calling \
tools, so issuing multiple commands at once is necessary and encouraged \
to speed up your research.
- Each command result may be truncated to 50 lines; prefer multiple \
targeted reads/searches to build complete context.
- DO NOT EVER USE MORE THAN {max_commands} commands in a single turn, or you will \
be penalized.
`;

const LLM_TOOL_USE = `# TOOL USE GUIDELINES
- You have a \`restricted_exec\` tool (function calling). Call it at most \
ONCE per turn with fields command1..commandN (up to {max_commands}), where \
each commandN is an object with a \`type\` field of \`rg\`, \`readfile\`, \
\`tree\`, \`ls\`, or \`glob\` and the appropriate fields for that type.
- You have an \`answer\` tool (function calling). When you are ready to \
finish, call it exactly once with the XML answer as its \`answer\` argument.
- You have at most {max_turns} turns to interact with the environment by calling \
tools, so issuing multiple commands at once is necessary and encouraged \
to speed up your research.
- Each command result may be truncated to 50 lines; prefer multiple \
targeted reads/searches to build complete context.
- DO NOT EVER USE MORE THAN {max_commands} commands in a single turn, or you will \
be penalized.
`;

const PROMPT_TAIL = `# ANSWER FORMAT (strict format, including tags)
- You will output an XML structure with a root element "ANSWER" \
containing "file" elements. Each "file" element will have a "path" \
attribute and contain "range" elements.
- You will output this as your final response.
- The line ranges must be inclusive.

Output example inside the "answer" tool argument:
<ANSWER>
  <file path="/codebase/info_theory/formulas/entropy.py">
    <range>10-60</range>
    <range>150-210</range>
  </file>
  <file path="/codebase/info_theory/data_structures/bits.py">
    <range>1-40</range>
    <range>110-170</range>
  </file>
</ANSWER>


Remember: Prefer narrow, fixed-string, and type-filtered searches with \
aggressive excludes and size/depth limits. Widen scope only as needed. \
Use the restricted tools available to you, and output your answer in \
exactly the specified format.

# NO RESULTS POLICY
If after thorough searching you are confident that NO relevant files exist \
for the given query (e.g., the function/class/concept does not exist in the \
codebase), you MUST return an empty ANSWER:
<ANSWER></ANSWER>
Do NOT return irrelevant files (such as entry points or config files) just \
to provide some output. An empty answer is always better than a misleading one.

# RESULT COUNT
Aim to return at most {max_results} files in your answer. Focus on the most \
relevant files first. If fewer files are relevant, return fewer.
`;

function fill(template, maxTurns, maxCommands, maxResults) {
  return template
    .replaceAll("{max_turns}", String(maxTurns))
    .replaceAll("{max_commands}", String(maxCommands))
    .replaceAll("{max_results}", String(maxResults));
}

/**
 * Build the Windsurf system prompt (detailed, [TOOL_CALLS] format).
 * @param {number} maxTurns
 * @param {number} maxCommands
 * @param {number} maxResults
 * @returns {string}
 */
export function buildWindsurfPrompt(maxTurns = 3, maxCommands = 8, maxResults = 10) {
  return fill(PROMPT_HEAD + WINDSURF_TOOL_USE + PROMPT_TAIL, maxTurns, maxCommands, maxResults);
}

/**
 * Build the system prompt for the DSH ctx.llm brain (native function
 * calling instead of the [TOOL_CALLS] text protocol).
 * @param {number} maxTurns
 * @param {number} maxCommands
 * @param {number} maxResults
 * @returns {string}
 */
export function buildLlmPrompt(maxTurns = 3, maxCommands = 8, maxResults = 10) {
  return fill(PROMPT_HEAD + LLM_TOOL_USE + PROMPT_TAIL, maxTurns, maxCommands, maxResults);
}

// ─── Tool Schemas (shared by both brains) ──────────────────

/**
 * Per-command schema: one of rg / readfile / tree / ls / glob.
 * @param {number} n
 * @returns {Object}
 */
function _buildCommandSchema(n) {
  return {
    type: "object",
    description: `Command ${n} to execute. Must be one of: rg, readfile, or tree.`,
    oneOf: [
      {
        properties: {
          type: { type: "string", const: "rg", description: "Search for patterns in files using ripgrep." },
          pattern: { type: "string", description: "The regex pattern to search for." },
          path: { type: "string", description: "The path to search in." },
          include: { type: "array", items: { type: "string" }, description: "File patterns to include." },
          exclude: { type: "array", items: { type: "string" }, description: "File patterns to exclude." },
        },
        required: ["type", "pattern", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "readfile", description: "Read contents of a file with optional line range." },
          file: { type: "string", description: "Path to the file to read." },
          start_line: { type: "integer", description: "Starting line number (1-indexed)." },
          end_line: { type: "integer", description: "Ending line number (1-indexed)." },
        },
        required: ["type", "file"],
      },
      {
        properties: {
          type: { type: "string", const: "tree", description: "Display directory structure as a tree." },
          path: { type: "string", description: "Path to the directory." },
          levels: { type: "integer", description: "Number of directory levels." },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "ls", description: "List files in a directory." },
          path: { type: "string", description: "Path to the directory." },
          long_format: { type: "boolean" },
          all: { type: "boolean" },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "glob", description: "Find files matching a glob pattern." },
          pattern: { type: "string" },
          path: { type: "string" },
          type_filter: { type: "string", enum: ["file", "directory", "all"] },
        },
        required: ["type", "pattern", "path"],
      },
    ],
  };
}

/**
 * Build the model-facing tool schemas (name/description/parameters form).
 * The Windsurf brain JSON-encodes these into the request; the DSH ctx.llm
 * brain passes them through GenerateOptions.tools as-is.
 * @param {number} maxCommands
 * @returns {Array<{name: string, description: string, parameters: Object}>}
 */
export function buildToolSchemas(maxCommands = 8) {
  const props = {};
  for (let i = 1; i <= maxCommands; i++) {
    props[`command${i}`] = _buildCommandSchema(i);
  }
  return [
    {
      name: "restricted_exec",
      description: "Execute restricted commands (rg, readfile, tree, ls, glob) in parallel.",
      parameters: { type: "object", properties: props, required: ["command1"] },
    },
    {
      name: "answer",
      description: "Final answer with relevant files and line ranges.",
      parameters: {
        type: "object",
        properties: { answer: { type: "string", description: "The final answer in XML format." } },
        required: ["answer"],
      },
    },
  ];
}
