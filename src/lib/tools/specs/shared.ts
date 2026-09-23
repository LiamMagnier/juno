/**
 * What every Juno tool spec needs and none of them should write twice: the two
 * outcome shapes, the one-line cut `present` promises (SPEC §3.1), taking the
 * envelope back off a model-facing string for the panel, and the bridge from
 * the agent tools' result shape to a `ToolOutcome`.
 *
 * Pure. The agent tools themselves are imported by the specs that wrap them,
 * never here.
 */

import type { AgentExecutionContext, ToolExecutionResult } from "@/lib/agent/types";
import type { ToolContext, ToolOutcome } from "@/lib/tools/types";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "@/lib/untrusted-content";
import type { ToolErrorCode, ToolFigure } from "@/types/run";

/** `present` strings are one line and at most this long (SPEC §3.1). */
export const PRESENT_MAX_CHARS = 200;

/**
 * One line, control characters and newlines collapsed to a space, cut at
 * `max` with an ellipsis. What `present` returns and what a row shows.
 */
export function oneLine(value: unknown, max = PRESENT_MAX_CHARS): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f  \s]+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** A string argument trimmed, or null when the model sent something else. */
export function stringArg(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A whole number argument, from a number or a numeric string, clamped; `fallback` when absent. */
export function intArg(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function succeeded(
  text: string,
  extra: Partial<Omit<ToolOutcome, "status" | "text">> = {},
): ToolOutcome {
  return { status: "succeeded", text, body: extra.body ?? text, ...extra };
}

export function failed(code: ToolErrorCode, text: string, extra: Partial<Omit<ToolOutcome, "status" | "text" | "error">> = {}): ToolOutcome {
  return { status: "failed", text, body: extra.body ?? text, error: { code }, ...extra };
}

/**
 * The same text without the untrusted envelope, for the panel (SPEC §3.1
 * `body`). The markers are a model-context construct; a reader gains nothing
 * from them. Only whole marker lines are removed, so content that merely
 * mentions the sentinel (defanged by `wrapUntrusted`) is left as it is.
 */
export function withoutEnvelope(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith(`${UNTRUSTED_OPEN} source=`) && line !== UNTRUSTED_CLOSE)
    .join("\n")
    .trim();
}

/** The agent tools' execution context, built from a Juno tool call's. */
export function agentContextFor(ctx: ToolContext): AgentExecutionContext {
  return {
    userId: ctx.userId,
    sessionId: ctx.generationId,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    mode: "chat",
    environment: "server_sandbox",
    abortSignal: ctx.signal,
  };
}

/**
 * An agent tool's result as a Juno outcome. `stdout` is the model-facing text
 * (already enveloped where its content is outside text); the panel gets it
 * without the envelope.
 */
export function outcomeFromAgentResult(
  result: ToolExecutionResult<unknown>,
  extra: { figure?: ToolFigure; feeMicroUsd?: number; failureCode?: ToolErrorCode } = {},
): ToolOutcome {
  const text = result.stdout || result.summary || result.error || "";
  const body = withoutEnvelope(text);
  const shared = {
    body,
    ...(result.images?.length ? { images: result.images } : {}),
    ...(extra.figure ? { figure: extra.figure } : {}),
    ...(extra.feeMicroUsd ? { feeMicroUsd: extra.feeMicroUsd } : {}),
    ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
  };
  if (result.success) return { status: "succeeded", text, ...shared };
  return { status: "failed", text, ...shared, error: { code: extra.failureCode ?? "tool_error" } };
}
