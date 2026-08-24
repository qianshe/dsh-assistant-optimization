/**
 * Budget-limited content embedding + result formatting for context_search.
 *
 * The search loop (core.js) ends with files + line ranges. The brain's
 * prompt asks it to include ENTIRE semantic blocks, so a range can span
 * hundreds of lines. This module re-reads the ranges from disk at format
 * time (so a cache hit still yields fresh content) and formats the result
 * in TWO independent sections — no interleaving:
 *
 *   1. "Files:"    the explicit list, one entry per file with its ranges
 *   2. "Contents:" each file's code for its ranges (fenced, `N:` line numbers)
 *
 * Ranges are embedded COMPLETELY — there is no per-range line cap. The
 * safety net is byte budgets (env-tunable, clamped to sane bounds):
 *
 *   FC_CONTENT_MAX_BYTES          total content across all files (49152)
 *   FC_CONTENT_FILE_MAX_BYTES     content per file (16384)
 *   FC_CONTENT_LINE_MAX_CHARS     chars per line (400)
 *
 * When a byte budget cuts a range short, the tail is dropped with a marker.
 * Every failure mode — missing file, binary file, exhausted budget —
 * degrades to a marker line; content embedding must never fail the search
 * itself. No keyword or config lines: the result IS the context.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";

// ─── Budgets ───────────────────────────────────────────────

/**
 * Parse an integer env var with clamping (same pattern as executor.js).
 * @param {string} name
 * @param {number} defaultValue
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {number}
 */
function readIntEnv(name, defaultValue, opts = {}) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  const min = typeof opts.min === "number" ? opts.min : null;
  const max = typeof opts.max === "number" ? opts.max : null;
  let value = parsed;
  if (min !== null) value = Math.max(min, value);
  if (max !== null) value = Math.min(max, value);
  return value;
}

/**
 * Resolve the content budgets (env-tunable, clamped to sane bounds).
 * @returns {{ totalMaxBytes: number, fileMaxBytes: number, lineMaxChars: number }}
 */
export function resolveContentBudgets() {
  return {
    totalMaxBytes: readIntEnv("FC_CONTENT_MAX_BYTES", 49152, { min: 1024, max: 262144 }),
    fileMaxBytes: readIntEnv("FC_CONTENT_FILE_MAX_BYTES", 16384, { min: 256, max: 131072 }),
    lineMaxChars: readIntEnv("FC_CONTENT_LINE_MAX_CHARS", 400, { min: 50, max: 10000 }),
  };
}

/** Preview head (in lines) for a salvaged file that carries no ranges. */
const PREVIEW_LINES = 40;

/** A marker is only worth the bytes when at least this much budget remains. */
const MIN_USEFUL_BYTES = 256;

// ─── File reading ──────────────────────────────────────────

const LANG_BY_EXT = {
  ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx",
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".rb": "ruby", ".php": "php", ".swift": "swift",
  ".kt": "kotlin", ".kts": "kotlin", ".sh": "bash", ".zsh": "bash",
  ".yml": "yaml", ".yaml": "yaml", ".json": "json", ".jsonc": "json",
  ".md": "markdown", ".css": "css", ".scss": "scss", ".less": "less",
  ".html": "html", ".vue": "html", ".sql": "sql", ".toml": "toml",
  ".xml": "xml", ".proto": "protobuf", ".graphql": "graphql",
};

/** Fence language tag from the file extension (fallback "text"). */
function langTag(fullPath) {
  return LANG_BY_EXT[extname(String(fullPath || "")).toLowerCase()] || "text";
}

/**
 * Read a file once: "missing" when unreadable, "binary" on a NUL in the
 * head (never embed binary content), else the line array.
 * @param {string} fullPath
 * @returns {{ state: "missing" | "binary" | "ok", lines: string[] | null }}
 */
function readFileLines(fullPath) {
  let content;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    return { state: "missing", lines: null };
  }
  if (content.slice(0, 8192).includes("\u0000")) {
    return { state: "binary", lines: null };
  }
  return { state: "ok", lines: content.split("\n") };
}

// ─── Embedding ─────────────────────────────────────────────

/**
 * Build one file's content block(s): fenced code with `N:` line prefixes
 * (matching the read tool), plus omission markers when the byte budgets
 * cut a range short. Reads the file once and shares it across its ranges.
 *
 * @param {{ full_path?: string, path?: string, ranges?: [number, number][] }} file
 * @param {{ totalMaxBytes: number, fileMaxBytes: number, lineMaxChars: number }} budgets
 * @param {{ left: number }} totalLeft — mutable shared total budget
 * @returns {string} the block (code fences and/or marker lines)
 */
export function embedFileContent(file, budgets, totalLeft) {
  const hasRanges = Array.isArray(file.ranges) && file.ranges.length > 0;
  const ranges = hasRanges
    ? file.ranges.map(([s, e]) => [Math.max(1, Number(s) || 1), Math.max(1, Number(e) || 1)])
    : [[1, PREVIEW_LINES]];

  const blocks = [];
  let fileLeft = budgets.fileMaxBytes;
  let fileRead = null;

  for (const [rawStart, rawEnd] of ranges) {
    if (fileLeft <= MIN_USEFUL_BYTES || totalLeft.left <= MIN_USEFUL_BYTES) {
      blocks.push(`(content omitted: budget exhausted; use read L${rawStart}-${rawEnd})`);
      continue;
    }
    if (fileRead === null) {
      fileRead = readFileLines(file.full_path || file.path || "");
      if (fileRead.state === "missing") {
        blocks.push("(content unavailable: file no longer exists)");
        return blocks.join("\n");
      }
      if (fileRead.state === "binary") {
        blocks.push("(content skipped: binary file)");
        return blocks.join("\n");
      }
    }

    const allLines = fileRead.lines;
    const totalLines = allLines.length;
    // A range that starts past the end of file is not clampable: it is a
    // stale answer, reported as such (the file shrank since the search).
    if (rawStart > totalLines) {
      blocks.push(`(range L${rawStart}-${rawEnd} is out of file bounds)`);
      continue;
    }
    const start = rawStart;
    const end = Math.min(rawEnd, totalLines);
    if (start > end) {
      blocks.push(`(range L${rawStart}-${rawEnd} is out of file bounds)`);
      continue;
    }

    // The range is embedded completely — per-line char truncation only.
    // There is deliberately no per-range line cap: the byte budgets below
    // are the safety net, and a range that fits them ships in full.
    const lines = [];
    for (let i = start; i <= end; i++) {
      let text = allLines[i - 1] || "";
      if (text.length > budgets.lineMaxChars) text = text.slice(0, budgets.lineMaxChars);
      lines.push(`${i}: ${text}`);
    }

    const fenceOpen = "```" + langTag(file.full_path || file.path) + "\n";
    const fenceClose = "```\n";
    const sizeOf = (body) => Buffer.byteLength(fenceOpen + body + fenceClose, "utf-8");
    const limit = Math.min(fileLeft, totalLeft.left);

    // Shrink from the tail until the block fits both budgets.
    let body = lines.join("\n") + "\n";
    while (lines.length > 1 && sizeOf(body) > limit) {
      lines.pop();
      body = lines.join("\n") + "\n";
    }
    if (sizeOf(body) > limit) {
      // Not even the head fits: fall back to a marker for this range.
      blocks.push(`(content omitted: budget exhausted; use read L${start}-${end})`);
      continue;
    }

    const size = sizeOf(body);
    fileLeft -= size;
    totalLeft.left -= size;
    blocks.push(fenceOpen + body + fenceClose);
    const embedded = lines.length;
    if (embedded < end - start + 1) {
      // Byte budgets trimmed the tail of the range.
      blocks.push(`(L${start + embedded}-${end} omitted: content budget; use read for the rest)`);
    } else if (end < rawEnd) {
      blocks.push(`(L${end + 1}-${rawEnd} omitted: beyond end of file)`);
    }
  }

  return blocks.join("\n");
}

// ─── Result formatting ─────────────────────────────────────

/**
 * Format a successful search result in two independent sections:
 *
 *   Found N relevant files.
 *
 *   Files:
 *     [1/N] path (L1-320)
 *     ...
 *
 *   Contents:
 *     [1/N] path (L1-320)
 *     ```ts
 *     1: ...
 *     ```
 *     ...
 *
 * The list is written first in full (scannable, code-free), then the
 * content section follows — they are never interleaved.
 * includeContent=false ships only the Files section.
 *
 * @param {Array<{ full_path?: string, path?: string, ranges?: [number, number][] }>} files
 * @param {{ includeContent?: boolean, budgets?: Object }} [opts]
 * @returns {string}
 */
export function formatSearchResult(files, opts = {}) {
  const list = Array.isArray(files) ? files : [];
  const includeContent = opts.includeContent !== false;
  const budgets = opts.budgets || resolveContentBudgets();
  const n = list.length;

  if (n === 0) {
    return "No files found.";
  }

  const rangeLabel = (entry) => {
    const hasRanges = Array.isArray(entry.ranges) && entry.ranges.length > 0;
    return hasRanges ? entry.ranges.map(([s, e]) => `L${s}-${e}`).join(", ") : "preview";
  };

  const parts = [`Found ${n} relevant files.`, "", "Files:"];

  // Section 1 — the explicit file list: one entry per file with its ranges.
  for (let i = 0; i < n; i++) {
    parts.push(`  [${i + 1}/${n}] ${list[i].full_path || list[i].path || ""} (${rangeLabel(list[i])})`);
  }

  if (includeContent) {
    // Section 2 — the code of each file's ranges, in the same order as the
    // list. Fresh from disk even on a cache hit; budget-limited.
    parts.push("", "Contents:");
    const totalLeft = { left: budgets.totalMaxBytes };
    for (let i = 0; i < n; i++) {
      const entry = list[i];
      parts.push(`  [${i + 1}/${n}] ${entry.full_path || entry.path || ""} (${rangeLabel(entry)})`);
      parts.push(embedFileContent(entry, budgets, totalLeft));
      parts.push("");
    }
  }

  return parts.join("\n").replace(/\n+$/, "");
}
