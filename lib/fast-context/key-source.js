/**
 * Windsurf API key resolution for the fast-context tool.
 *
 * Order (first hit wins):
 *   1. `WINDSURF_API_KEY` — process environment.
 *   2. Manual key file — `$DSH_HOME/dsao-windsurf-key` (DSH_HOME defaults to
 *      `~/.dsh`). This is the manual entry point: one line, the key itself.
 *   3. Local Windsurf/Devin installation — `state.vscdb` `windsurfAuthStatus`
 *      (see extract-key.js). Verified reliable when the editor is logged in.
 *
 * A key is REQUIRED for the tool to exist at all: with no key the plugin
 * registers neither the tool nor its prompt section, so the model never learns
 * about a tool it cannot call.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import { extractKey, getCredentialSources } from "./extract-key.js";

/** File name of the manual key file inside DSH_HOME. */
export const KEY_FILE_NAME = "dsao-windsurf-key";

/**
 * Absolute path of the manual key file.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function keyFilePath(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, KEY_FILE_NAME);
}

/**
 * Read the manual key file. A missing or blank file is not an error.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the trimmed key, or `''`
 */
export function readKeyFile(env = process.env) {
  const path = keyFilePath(env);
  if (!existsSync(path)) return "";
  try {
    // Tolerate a file saved with a trailing newline or wrapped in quotes.
    return readFileSync(path, "utf8").trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

/**
 * Write the manual key file (the manual entry point's write half).
 * @param {string} key
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the path written
 */
export function writeKeyFile(key, env = process.env) {
  const path = keyFilePath(env);
  mkdirSync(dirname(path), { recursive: true });
  // 0o600: the key is a bearer credential.
  writeFileSync(path, `${String(key).trim()}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

/**
 * Remove the manual key file.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} whether a file was removed
 */
export function clearKeyFile(env = process.env) {
  const path = keyFilePath(env);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * Resolve the Windsurf key from every configured source.
 * Set `DSAO_FC_AUTO_KEY=0` to skip local-installation discovery (opt out of
 * reading the editor's stored credential).
 * @param {{ env?: NodeJS.ProcessEnv, allowAuto?: boolean }} [opts]
 * @returns {Promise<{ key: string, source: 'env'|'file'|'auto'|'none', detail: string, tried: string[] }>}
 */
export async function resolveWindsurfKey(opts = {}) {
  const env = opts.env || process.env;
  const allowAuto = opts.allowAuto !== false && (env.DSAO_FC_AUTO_KEY || "") !== "0";
  const tried = [];

  const envKey = (env.WINDSURF_API_KEY || "").trim();
  tried.push("env:WINDSURF_API_KEY");
  if (envKey !== "") return { key: envKey, source: "env", detail: "WINDSURF_API_KEY", tried };

  const filePath = keyFilePath(env);
  tried.push(`file:${filePath}`);
  const fileKey = readKeyFile(env);
  if (fileKey !== "") return { key: fileKey, source: "file", detail: filePath, tried };

  if (!allowAuto) {
    return { key: "", source: "none", detail: "no manual key; local discovery disabled (DSAO_FC_AUTO_KEY=0)", tried };
  }

  // Local installation. Never throws: extractKey reports its failure as data.
  try {
    const found = await extractKey();
    for (const src of found.tried_paths || getCredentialSources().map((s) => s.path)) {
      tried.push(`auto:${src}`);
    }
    if (found.api_key) {
      return { key: found.api_key, source: "auto", detail: found.db_path || "local installation", tried };
    }
    return { key: "", source: "none", detail: found.error || "no key in local installation", tried };
  } catch (e) {
    return { key: "", source: "none", detail: `auto-discovery failed: ${e.message}`, tried };
  }
}
