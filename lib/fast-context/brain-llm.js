/**
 * DSH ctx.llm brain — runs the fast-context search loop on the deployment's
 * own model (same service pattern as this plugin's prompt-enhance route),
 * using native function calling instead of the Windsurf [TOOL_CALLS] text
 * protocol.
 *
 * New module (no reference equivalent); same brain contract as ./windsurf.js:
 *   prepare(ctx, opts)  → state
 *   stream(state, messages, turnOpts) → { text, toolCalls }
 */

import {
  parseJsonWithRepair,
  salvageRestrictedExecArgs,
} from "./repair.js";
import { buildLlmPrompt, buildToolSchemas } from "./shared.js";

/**
 * Prepare the local-model brain: resolve the llm service and the current
 * default model selection.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{ provider: string, model: string, reasoningEffort?: string }>}
 */
async function prepare(ctx) {
  const llm = ctx.get("llm");
  const defaultModel = ctx.get("agentDefaultModel");
  if (!llm || typeof llm.stream !== "function") {
    throw new Error("llm service unavailable (ctx.get('llm') missing or without stream())");
  }
  if (!defaultModel || typeof defaultModel.currentSelection !== "function") {
    throw new Error("agentDefaultModel service unavailable (ctx.get('agentDefaultModel') missing)");
  }
  let selection;
  try {
    selection = defaultModel.currentSelection();
  } catch (e) {
    throw new Error(`no model selected: ${e?.message || e}`);
  }
  if (!selection || typeof selection.provider !== "string" || typeof selection.model !== "string") {
    throw new Error("no model selected");
  }
  return {
    llm,
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  };
}

/**
 * Convert one FC message ({role:1|2|4|5, content, ...}) into the DSH llm
 * message shape. Role 5 (system) is NOT converted here — it goes to the
 * GenerateOptions.system slot (see stream()).
 * @param {{role: number, content: string, tool_call_id?: string, tool_name?: string, tool_args_json?: string, ref_call_id?: string}} m
 * @param {number} seq
 * @param {{ provider: string, model: string }} state
 * @returns {Object}
 */
function toDshMessage(m, seq, state) {
  const text = String(m.content ?? "");
  if (m.role === 1) {
    return {
      id: `fc-llm-u${seq}`,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    };
  }
  if (m.role === 2) {
    const blocks = [];
    if (text) blocks.push({ type: "text", text });
    if (m.tool_call_id && m.tool_name && m.tool_args_json) {
      blocks.push({
        type: "tool-call",
        id: m.tool_call_id,
        name: m.tool_name,
        arguments: m.tool_args_json,
      });
    }
    return {
      id: `fc-llm-a${seq}`,
      role: "assistant",
      content: blocks,
      source: { kind: "model", provider: state.provider, model: state.model },
    };
  }
  if (m.role === 4) {
    return {
      id: `fc-llm-t${seq}`,
      role: "user",
      content: [
        {
          type: "tool-result",
          toolCallId: m.ref_call_id || `fc-llm-missing-call-${seq}`,
          content: [{ type: "text", text }],
          isError: false,
        },
      ],
      source: { kind: "tool", callId: m.ref_call_id || `fc-llm-missing-call-${seq}` },
    };
  }
  throw new Error(`unsupported FC role ${m.role}`);
}

/**
 * Run one turn on the local model with native function calling.
 * @param {Object} state - from prepare()
 * @param {Array} messages - FC message list
 * @param {{ maxTurns?: number, maxCommands?: number, maxResults?: number, system?: string, timeoutMs?: number, signal?: AbortSignal }} [turnOpts]
 * @returns {Promise<{ text: string, toolCalls: Array<{name: string, args: Object}> }>}
 */
async function stream(state, messages, turnOpts = {}) {
  const { maxTurns = 3, maxCommands = 8, maxResults = 10, signal } = turnOpts;
  const llm = state.llm;

  const systemText = turnOpts.system
    || buildLlmPrompt(maxTurns, maxCommands, maxResults);
  const seqs = [0];
  const dshMessages = messages
    .filter((m) => m.role !== 5)
    .map((m) => toDshMessage(m, ++seqs[0], state));

  const streamIt = llm.stream({
    provider: state.provider,
    model: state.model,
    ...(state.reasoningEffort === undefined ? {} : { reasoningEffort: state.reasoningEffort }),
    system: systemText,
    messages: dshMessages,
    tools: buildToolSchemas(maxCommands),
    temperature: 0,
    signal,
  });

  let text = "";
  const toolCalls = [];
  for await (const chunk of streamIt) {
    if (chunk.type === "text-delta") {
      text += chunk.text;
    } else if (chunk.type === "block-end") {
      const block = chunk.block;
      if (block && block.type === "tool-call" && block.name) {
        let args = null;
        try {
          args = parseJsonWithRepair(block.arguments || "{}");
        } catch {
          args = null;
        }
        if (!args && block.name === "restricted_exec") {
          args = salvageRestrictedExecArgs(block.arguments || "");
        }
        toolCalls.push({ name: block.name, args: args && typeof args === "object" ? args : {} });
      }
    } else if (chunk.type === "finish") {
      const reason = chunk.reason;
      if (reason && reason.kind === "error") {
        throw new Error(`local model call failed: ${reason.failure?.message || "unknown error"}`);
      }
      if (reason && reason.kind === "aborted") {
        throw new Error("aborted");
      }
    }
  }

  return { text, toolCalls };
}

export const llmBrain = { kind: "llm", prepare, stream };
