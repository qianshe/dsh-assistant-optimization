/**
 * Tool executor for the restricted commands (rg / readfile / tree / ls / glob).
 *
 * Ported from fast-context-mcp src/executor.mjs (MIT, see NOTICE.md).
 * Changes:
 *  - only the async paths are kept (the DSH tool dispatch is async);
 *  - tree-node-cli replaced by renderTree from ./shared.js;
 *  - optional AbortSignal (agent interrupt) is forwarded to the rg subprocess;
 *  - ripgrep is resolved lazily from the dependency or from PATH.
 */

import { execFile as execFileCb } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, delimiter } from "node:path";
import { promisify } from "node:util";
import { renderTree } from "./shared.js";
import { resolveWithinRoot } from "./path-safety.js";

const execFileAsync = promisify(execFileCb);

// Lazy ripgrep resolution: a missing @vscode/ripgrep dependency degrades the
// `rg` command (clear error) instead of breaking the whole module load —
// tree/readfile/ls/glob stay usable.
//
// Resolution order:
//   1. `FC_RG_PATH` — explicit override (absolute path to an rg executable);
//   2. `@vscode/ripgrep` — the plugin's own dependency, when installed;
//   3. an `rg` already on PATH (a system install);
//   4. DSH's bundled copy — the plugin runs inside the dsh host, whose entry
//      point can resolve @vscode/ripgrep from the dsh package itself. This is
//      the same binary DSH's own grep uses, so a standard deployment works
//      with zero extra dependencies.
import { createRequire } from "node:module";

let _rgPath = null;
let _rgError = null;
async function _getRgPath() {
  if (_rgPath) return _rgPath;
  if (_rgError) throw new Error(_rgError);

  const problems = [];

  const override = (process.env.FC_RG_PATH || "").trim();
  if (override !== "") {
    if (existsSync(override)) {
      _rgPath = override;
      return _rgPath;
    }
    problems.push(`FC_RG_PATH does not exist: ${override}`);
  }

  try {
    const mod = await import("@vscode/ripgrep");
    if (typeof mod.rgPath === "string" && mod.rgPath !== "" && existsSync(mod.rgPath)) {
      _rgPath = mod.rgPath;
      return _rgPath;
    }
    problems.push("@vscode/ripgrep resolved without a usable binary");
  } catch (e) {
    problems.push(`@vscode/ripgrep not installed: ${e.message.split("\n")[0]}`);
  }

  const onPath = _findRgOnPath();
  if (onPath) {
    _rgPath = onPath;
    return _rgPath;
  }

  const bundled = _findDshBundledRg();
  if (bundled) {
    _rgPath = bundled;
    return _rgPath;
  }

  problems.push("no rg on PATH; no DSH-bundled copy found");
  _rgError = `ripgrep unavailable: ${problems.join("; ")}`;
  throw new Error(_rgError);
}

/**
 * Locate an `rg` executable on PATH without spawning a process.
 * @returns {string} the absolute path, or `''`
 */
function _findRgOnPath() {
  const dirs = (process.env.PATH || "").split(delimiter).filter((d) => d !== "");
  const names = process.platform === "win32" ? ["rg.exe", "rg.cmd", "rg.bat"] : ["rg"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // An unreadable PATH entry is ordinary; try the next one.
      }
    }
  }
  return "";
}

/**
 * Locate the rg binary bundled inside the dsh package, when the plugin runs
 * in a dsh host process. Resolving through the host entry reuses dsh's own
 * node_modules without any dependency on how the plugin was installed.
 * @returns {string} the absolute path, or `''`
 */
function _findDshBundledRg() {
  const entry = process.argv[1] || "";
  if (entry === "") return "";
  try {
    const req = createRequire(entry);
    const pkg = req.resolve("@vscode/ripgrep");
    const mod = req(pkg);
    if (typeof mod.rgPath === "string" && mod.rgPath !== "" && existsSync(mod.rgPath)) {
      return mod.rgPath;
    }
  } catch {
    // The entry is not inside a dsh installation (e.g. tests); expected.
  }
  return "";
}

/**
 * Parse an integer env var with optional clamping.
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

const RESULT_MAX_LINES = readIntEnv("FC_RESULT_MAX_LINES", 50, { min: 1, max: 500 });
const LINE_MAX_CHARS = readIntEnv("FC_LINE_MAX_CHARS", 250, { min: 20, max: 10000 });

/** Default depth for `tree` when the model omits `levels` (output is truncated anyway). */
const TREE_DEFAULT_LEVELS = 3;
const TREE_MAX_LEVELS = 10;

export class ToolExecutor {
  /**
   * @param {string} projectRoot
   * @param {{ signal?: AbortSignal }} [opts]
   */
  constructor(projectRoot, opts = {}) {
    this.root = resolve(projectRoot);
    this.signal = opts.signal || null;
    /** @type {string[]} */
    this.collectedRgPatterns = [];
  }

  /**
   * Map virtual /codebase path to real filesystem path.
   * @param {string} virtual
   * @returns {string}
   */
  _real(virtual) {
    return resolveWithinRoot(this.root, virtual);
  }

  /**
   * Truncate output to match Windsurf behavior:
   * 50 line limit, 250 char per-line silent truncation.
   * @param {string} text
   * @returns {string}
   */
  static _truncate(text) {
    const lines = String(text).split("\n");
    const truncatedLines = [];
    const limit = Math.min(lines.length, RESULT_MAX_LINES);
    for (let i = 0; i < limit; i++) {
      const line = lines[i];
      truncatedLines.push(line.length > LINE_MAX_CHARS ? line.slice(0, LINE_MAX_CHARS) : line);
    }
    let result = truncatedLines.join("\n");
    if (lines.length > RESULT_MAX_LINES) {
      result += "\n... (lines truncated) ...";
    }
    return result;
  }

  /**
   * Replace real project root with /codebase in output.
   * @param {string} text
   * @returns {string}
   */
  _remap(text) {
    // Replace both native-sep and forward-slash versions of the root
    return String(text)
      .replaceAll(this.root, "/codebase")
      .replaceAll(this.root.replace(/\\/g, "/"), "/codebase");
  }

  /**
   * Search for pattern using @vscode/ripgrep (async version).
   * @param {string} pattern
   * @param {string} path
   * @param {string[]|null} [include]
   * @param {string[]|null} [exclude]
   * @returns {Promise<string>}
   */
  async rgAsync(pattern, path, include = null, exclude = null) {
    if (!pattern || typeof pattern !== "string") {
      return "Error: missing or invalid pattern";
    }
    if (!path || typeof path !== "string") {
      return "Error: missing or invalid path";
    }
    this.collectedRgPatterns.push(pattern);
    let rp;
    try {
      rp = this._real(path);
    } catch (e) {
      return `Error: ${e.message}`;
    }
    if (!existsSync(rp)) {
      return `Error: path does not exist: ${path}`;
    }

    const args = ["--no-heading", "-n", "--max-count", "50", pattern, rp];
    if (include) {
      for (const g of include) {
        args.push("--glob", g);
      }
    }
    if (exclude) {
      for (const g of exclude) {
        args.push("--glob", `!${g}`);
      }
    }

    let rgBin;
    try {
      rgBin = await _getRgPath();
    } catch (e) {
      return `Error: ${e.message}`;
    }

    try {
      const { stdout } = await execFileAsync(rgBin, args, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
        encoding: "utf-8",
        ...(this.signal ? { signal: this.signal } : {}),
      });
      return ToolExecutor._truncate(this._remap(stdout || "(no matches)"));
    } catch (err) {
      if (err.name === "AbortError" || err.code === "ABORT_ERR") {
        return "Error: aborted";
      }
      if (err.code === 1 || err.status === 1) {
        return "(no matches)";
      }
      if (err.stderr) {
        return ToolExecutor._truncate(this._remap(err.stderr));
      }
      return `Error: ${err.message}`;
    }
  }

  /**
   * Read file contents with optional line range (1-indexed, inclusive).
   * @param {string} file
   * @param {number|null} [startLine]
   * @param {number|null} [endLine]
   * @returns {string}
   */
  readfile(file, startLine = null, endLine = null) {
    if (!file || typeof file !== "string") {
      return "Error: missing or invalid file path";
    }
    let rp;
    try {
      rp = this._real(file);
    } catch (e) {
      return `Error: ${e.message}`;
    }
    try {
      const stat = statSync(rp);
      if (!stat.isFile()) {
        return `Error: file not found: ${file}`;
      }
    } catch {
      return `Error: file not found: ${file}`;
    }

    let content;
    try {
      content = readFileSync(rp, "utf-8");
    } catch (e) {
      return `Error: ${e.message}`;
    }

    const allLines = content.split("\n");
    // If the file ends with a newline, there'll be an empty string at the end
    // Keep behavior consistent with Python readlines()
    const s = (startLine || 1) - 1;
    const e = endLine || allLines.length;
    const selected = allLines.slice(s, e);
    const out = selected.map((line, idx) => `${s + idx + 1}:${line}`).join("\n");
    return ToolExecutor._truncate(out);
  }

  /**
   * Display directory structure as a tree.
   * @param {string} path
   * @param {number|null} [levels]
   * @returns {string}
   */
  tree(path, levels = null) {
    if (!path || typeof path !== "string") {
      return "Error: missing or invalid path";
    }
    let rp;
    try {
      rp = this._real(path);
    } catch (e) {
      return `Error: ${e.message}`;
    }
    try {
      const stat = statSync(rp);
      if (!stat.isDirectory()) {
        return `Error: dir not found: ${path}`;
      }
    } catch {
      return `Error: dir not found: ${path}`;
    }

    const depth = Math.min(Math.max(levels || TREE_DEFAULT_LEVELS, 1), TREE_MAX_LEVELS);
    try {
      // renderTree roots at the model-facing virtual path (matches tree-node-cli remap)
      const stdout = renderTree(rp, depth, { virtualRoot: path });
      return ToolExecutor._truncate(this._remap(stdout));
    } catch {
      return `Error: failed to generate tree for ${path}`;
    }
  }

  /**
   * List files in a directory.
   * @param {string} path
   * @param {boolean} [longFormat=false]
   * @param {boolean} [allFiles=false]
   * @returns {string}
   */
  ls(path, longFormat = false, allFiles = false) {
    if (!path || typeof path !== "string") {
      return "Error: missing or invalid path";
    }
    let rp;
    try {
      rp = this._real(path);
    } catch (e) {
      return `Error: ${e.message}`;
    }
    try {
      const stat = statSync(rp);
      if (!stat.isDirectory()) {
        return `Error: not a directory: ${path}`;
      }
    } catch {
      return `Error: dir not found: ${path}`;
    }

    let entries;
    try {
      entries = readdirSync(rp).sort();
    } catch (e) {
      return `Error: ${e.message}`;
    }

    if (!allFiles) {
      entries = entries.filter((e) => !e.startsWith("."));
    }

    if (!longFormat) {
      return ToolExecutor._truncate(entries.join("\n"));
    }

    // Long format: emulate ls -l output
    const lines = [`total ${entries.length}`];
    for (const name of entries) {
      const fp = join(rp, name);
      try {
        const st = statSync(fp);
        const isDir = st.isDirectory();
        const type = isDir ? "d" : "-";
        const perm = "rwxr-xr-x";
        const size = String(st.size).padStart(8);
        const mtime = st.mtime;
        const month = mtime.toLocaleString("en", { month: "short" });
        const day = String(mtime.getDate()).padStart(2);
        const hh = String(mtime.getHours()).padStart(2, "0");
        const mm = String(mtime.getMinutes()).padStart(2, "0");
        const dateStr = `${month} ${day} ${hh}:${mm}`;
        lines.push(`${type}${perm}  1 user  staff ${size} ${dateStr} ${name}`);
      } catch {
        lines.push(`?---------  ? ?     ?        ? ? ?     ? ${name}`);
      }
    }
    return ToolExecutor._truncate(this._remap(lines.join("\n")));
  }

  /**
   * Glob pattern matching.
   * @param {string} pattern
   * @param {string} path
   * @param {string} [typeFilter="all"]
   * @returns {string}
   */
  glob(pattern, path, typeFilter = "all") {
    if (!pattern || typeof pattern !== "string") {
      return "Error: missing or invalid pattern";
    }
    if (!path || typeof path !== "string") {
      return "Error: missing or invalid path";
    }
    let rp;
    try {
      rp = this._real(path);
    } catch (e) {
      return `Error: ${e.message}`;
    }

    // Use recursive readdir + fnmatch since Node 22 globSync may not be available
    const matches = [];

    try {
      _globWalk(rp, pattern, matches, typeFilter);
    } catch {
      // fallback: try simple readdir
      try {
        const entries = readdirSync(rp);
        for (const entry of entries) {
          const fp = join(rp, entry);
          if (_fnmatch(entry, pattern)) {
            try {
              const st = statSync(fp);
              if (typeFilter === "file" && !st.isFile()) continue;
              if (typeFilter === "directory" && !st.isDirectory()) continue;
              matches.push(fp);
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }

    const sorted = matches.sort().slice(0, 100);
    const out = sorted.map((m) => this._remap(m)).join("\n");
    return out || "(no matches)";
  }

  /**
   * Dispatch a command dict to the appropriate method (async).
   * Uses async rg for parallelism, sync for others (they are fast enough).
   * @param {Object} cmd
   * @returns {Promise<string>}
   */
  async execCommandAsync(cmd) {
    if (!cmd || typeof cmd !== "object") {
      return "Error: missing or invalid command";
    }
    const t = cmd.type || "";
    switch (t) {
      case "rg":
        return this.rgAsync(cmd.pattern, cmd.path, cmd.include || null, cmd.exclude || null);
      case "readfile":
        return this.readfile(cmd.file, cmd.start_line || null, cmd.end_line || null);
      case "tree":
        return this.tree(cmd.path, cmd.levels || null);
      case "ls":
        return this.ls(cmd.path, cmd.long_format || false, cmd.all || false);
      case "glob":
        return this.glob(cmd.pattern, cmd.path, cmd.type_filter || "all");
      default:
        return `Error: unknown command type '${t}'`;
    }
  }

  /**
   * Execute all commandN keys from a tool call args dict (parallel).
   * @param {Object} args
   * @returns {Promise<string>}
   */
  async execToolCallAsync(args) {
    if (!args || typeof args !== "object") {
      return "Error: missing or invalid tool args";
    }
    const keys = Object.keys(args).filter((k) => k.startsWith("command")).sort();
    const tasks = keys.map(async (key) => {
      const output = await this.execCommandAsync(args[key]);
      return `<${key}_result>\n${output}\n</${key}_result>`;
    });
    const results = await Promise.all(tasks);
    return results.join("");
  }
}

// ─── Helpers ───────────────────────────────────────────────

/**
 * Simple fnmatch-like glob matching.
 * Supports *, ?, and ** patterns.
 * @param {string} str
 * @param {string} pattern
 * @returns {boolean}
 */
function _fnmatch(str, pattern) {
  // Convert glob pattern to regex
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches everything including /
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // skip trailing /
        continue;
      }
      regex += "[^/]*";
    } else if (c === "?") {
      regex += "[^/]";
    } else if (c === "[") {
      // Pass through character classes
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        regex += "\\[";
      } else {
        regex += pattern.slice(i, end + 1);
        i = end;
      }
    } else if (".+^${}()|\\".includes(c)) {
      regex += "\\" + c;
    } else {
      regex += c;
    }
    i++;
  }
  regex += "$";
  try {
    return new RegExp(regex).test(str);
  } catch {
    return false;
  }
}

/**
 * Recursive glob walk.
 * @param {string} base
 * @param {string} pattern
 * @param {string[]} matches
 * @param {string} typeFilter
 */
function _globWalk(base, pattern, matches, typeFilter) {
  const isRecursive = pattern.includes("**");
  const walk = (dir, depth) => {
    if (matches.length >= 100) return;
    if (!isRecursive && depth > 0) return;

    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= 100) return;
      const fp = join(dir, entry);
      const relFromBase = relative(base, fp).replace(/\\/g, "/");

      let st;
      try {
        st = statSync(fp);
      } catch {
        continue;
      }

      if (_fnmatch(relFromBase, pattern) || _fnmatch(entry, pattern)) {
        if (typeFilter === "file" && !st.isFile()) continue;
        if (typeFilter === "directory" && !st.isDirectory()) continue;
        matches.push(fp);
      }

      if (st.isDirectory() && !entry.startsWith(".") && isRecursive) {
        walk(fp, depth + 1);
      }
    }
  };

  walk(base, 0);
}
