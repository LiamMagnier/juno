/**
 * How an adapter's loop runs the tool calls a round ended with (SPEC §4.2,
 * §4.3, §5.0).
 *
 * Every adapter does the same three things after a round that asked for tools:
 * stamp each call's id, hand the calls to one runner, and send the results back
 * in call order. The runner is the dispatcher (`executeToolBatch`) whenever the
 * caller opened the turn's toolset and passed its batch context — the reworked
 * route. Until the route switches (WS9a), `streamChat` still opens the old
 * toolset itself from `connectors`/`allowedTools`/`audit`/`nativeTools`, and
 * that toolset brokers its own calls; `legacyToolRound` runs it the way the
 * adapters always did, one call at a time. Both yield the same event shapes, so
 * an adapter never knows which one it has.
 *
 * Free of `server-only`: the adapter loops that import it run offline in tests.
 */

import { FINAL_ROUND_NOTE } from "@/lib/llm/loop";
import type { AdapterRequest } from "@/lib/llm/types";
import type { McpToolset } from "@/lib/mcp";
import { executeToolBatch, type BatchResult, type ToolCallInput } from "@/lib/tools/dispatch";
import type { ChatToolset, ResolvedTool, ToolRisk } from "@/lib/tools/types";
import type { LlmEvent } from "@/types/llm";
import type { ToolErrorCode } from "@/types/run";

/**
 * Runs one round's calls. Yields `tool` status/result and `sources` events as
 * they happen and returns the results in CALL order. `nextIsFinal` is read from
 * the loop controller at the moment the batch starts, so a spend-guard verdict
 * that arrived with the round's usage is already in it.
 */
export type ToolRoundRunner = (
  calls: readonly ToolCallInput[],
  signal: AbortSignal,
  nextIsFinal: boolean,
) => AsyncGenerator<LlmEvent, BatchResult[]>;

/**
 * The runner for this request, or null when it carries no client tools.
 *
 * `execute` is the dispatcher; a parameter only so a test can observe the
 * context it is handed without standing up the real one.
 */
export function toolRoundRunner(
  req: Pick<AdapterRequest, "toolset" | "batch">,
  execute: typeof executeToolBatch = executeToolBatch,
): ToolRoundRunner | null {
  const toolset = req.toolset;
  if (!toolset || toolset.tools.length === 0) return null;
  const batch = req.batch;
  if (!batch) return legacyToolRound(toolset);
  return (calls, signal, nextIsFinal) => execute(calls, signal, { ...batch, toolset, nextIsFinal });
}

/**
 * The id a call is known by for the rest of the turn (SPEC §4.3): the
 * provider's own id when it has one and it is unused, a `jc_<round>_<index>` id
 * when it has none, and either one suffixed with `#<round>.<index>` when it was
 * already used — Kimi numbers its calls `functions.<name>:<idx>`, several
 * compat hosts restart their numbering every response, and Gemini's id is
 * optional, so a provider id is not unique across a turn.
 *
 * The adapter stamps the id because it announces the call (`tool` `call`)
 * before the dispatcher sees it; the call, its status acts, its result, the
 * broker's idempotency key and the persisted record all share this one id.
 * `taken` is every id already issued this generation.
 */
export function stampCallId(
  providerCallId: string | undefined,
  round: number,
  index: number,
  taken: { has(id: string): boolean },
): string {
  const base = providerCallId || `jc_${round}_${index}`;
  return taken.has(base) ? `${base}#${round}.${index}` : base;
}

/**
 * One generation's call-id issuer: `stampCallId` against both the ids this
 * adapter issued and the ids the dispatcher has recorded in `seenCallIds`.
 * Issued ids are remembered at once, so two calls in one response that carry
 * the same provider id still come out distinct.
 */
export function callIdIssuer(seenCallIds?: ReadonlySet<string>): (providerCallId: string | undefined, round: number, index: number) => string {
  const issued = new Set<string>();
  const taken = { has: (id: string) => issued.has(id) || !!seenCallIds?.has(id) };
  return (providerCallId, round, index) => {
    const id = stampCallId(providerCallId, round, index, taken);
    issued.add(id);
    return id;
  };
}

/** A signal for the dispatcher when the caller passed none: one that never aborts. */
export function signalOrNever(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}

// ── The pre-rework toolset (removed by WS9a with the options that open it) ────

/**
 * Runs the calls through the toolset `streamChat` opened itself, in order, with
 * the arguments parsed the way they always were. That toolset authorises inside
 * `execute` (the runtime registry's broker, a connector's per-call approval), so
 * there is nothing to authorise here; what this adds over the old inline loops
 * is the reworked event shape — `round`, `index`, `status` — and the final-round
 * note on the last result.
 */
export function legacyToolRound(toolset: McpToolset): ToolRoundRunner {
  return async function* runLegacyRound(calls, signal, nextIsFinal) {
    const results: BatchResult[] = [];
    for (const call of calls) {
      const server = toolset.labelFor(call.name);
      const exec = await toolset.execute(call.name, argumentsOf(call.argsText), signal, call.callId);
      const status = exec.status ?? (exec.ok ? "succeeded" : "failed");
      const code: ToolErrorCode | undefined =
        status === "succeeded" ? undefined : (exec.error?.code ?? (status === "failed" ? "tool_error" : status));
      yield {
        type: "tool",
        phase: "result",
        server,
        name: call.name,
        callId: call.callId,
        round: call.round,
        index: call.index,
        args: call.argsText,
        result: exec.body,
        ok: status === "succeeded",
        status,
        ...(code ? { error: { code } } : {}),
        ...(exec.durationMs === undefined ? {} : { durationMs: exec.durationMs }),
      };
      results.push({
        callId: call.callId,
        name: call.name,
        ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
        text: exec.text,
        isError: status !== "succeeded",
        images: exec.images ?? [],
        ...(code ? { errorCode: code } : {}),
      });
    }
    const last = results.at(-1);
    if (nextIsFinal && last) last.text = `${last.text}\n\n${FINAL_ROUND_NOTE}`;
    return results;
  };
}

/**
 * The old toolset seen through the new contract's `resolve`, so it can ride in
 * an `AdapterRequest`. Every tool resolves as a connector tool — which is what
 * each of them is to the adapters: a schema they did not write (the Gemini
 * adapter sanitises it accordingly) and a call that authorises itself.
 */
export function legacyChatToolset(toolset: McpToolset): ChatToolset {
  const names = new Set(toolset.tools.map((tool) => tool.function.name));
  return {
    tools: toolset.tools,
    labelFor: (name) => toolset.labelFor(name),
    accessFor: (name) => toolset.accessFor(name),
    execute: (name, args, signal, callId, opts) => toolset.execute(name, args, signal, callId, opts),
    close: () => toolset.close(),
    resolve(name): ResolvedTool | undefined {
      if (!names.has(name)) return undefined;
      const risk: ToolRisk = toolset.accessFor(name) === "read" ? "read" : "external";
      return {
        name,
        canonical: "mcp",
        origin: "connector",
        title: toolset.labelFor(name),
        risk,
        parallelSafe: false,
        timeoutMs: 60_000,
        dedupe: false,
        present: () => ({}),
      };
    },
    connectors: [],
  };
}

/**
 * Arguments as the old loops parsed them: an object, or `{}` for anything else.
 * The dispatcher reports malformed JSON back to the model instead (RC-14); this
 * path keeps its old behaviour until it is deleted.
 */
function argumentsOf(argsText: string): Record<string, unknown> {
  if (!argsText.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(argsText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
