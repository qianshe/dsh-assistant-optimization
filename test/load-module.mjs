// Load one `window.__ModuleLoader__.load({ id, factory })` module out of the
// shipped bundle and evaluate its factory body in isolation, so tests exercise
// the exact code that ships rather than a re-implementation.
import { readFileSync } from 'node:fs'

/**
 * Extract a module factory body from lib/client.js by balancing braces from the
 * factory's opening brace, skipping over string literals and line comments so a
 * brace inside them cannot end the scan early.
 */
export function loadBundleModule(moduleId, requireStub = () => ({})) {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const idAt = bundle.indexOf(`id: "${moduleId}"`)
  if (idAt < 0) throw new Error(`module ${moduleId} not found in bundle`)

  const factoryAt = bundle.indexOf('factory: function (require) {', idAt)
  if (factoryAt < 0) throw new Error(`factory for ${moduleId} not found`)
  const bodyStart = bundle.indexOf('{', factoryAt + 'factory: function (require)'.length) + 1

  let depth = 1
  let i = bodyStart
  while (depth > 0 && i < bundle.length) {
    const ch = bundle[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '"' || ch === "'") {
      const quote = ch
      i++
      while (i < bundle.length && bundle[i] !== quote) {
        if (bundle[i] === '\\') i++
        i++
      }
    } else if (ch === '/' && bundle[i + 1] === '/') {
      while (i < bundle.length && bundle[i] !== '\n') i++
    }
    i++
  }
  if (depth !== 0) throw new Error(`unbalanced factory body for ${moduleId}`)

  return new Function('require', bundle.slice(bodyStart, i - 1))(requireStub)
}
