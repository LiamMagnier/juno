import type { ClientActionApproval } from "@/lib/action-approval";
import type { ClientActivityEvent, ClientMessage, ClientSource } from "@/types/chat";
import type { RunFact, RunNotice, ToolCallRecord } from "@/types/run";

/*
 * Typed activity rows for the run UI's unit tests (WS5): `buildRunView`,
 * `derivePhase`, the summary, `applyStreamChunk`.
 *
 * These are the shapes SPEC §2.4 fixes for what `TurnStream` records, written
 * out by hand so the run model can be tested while the server side is being
 * built. The gallery never uses them: its frames come from the turn scripts
 * played through `TurnStream` (§11.1).
 */

export const T0 = Date.parse("2026-09-23T19:07:00.000Z");

/** The ISO instant `ms` after T0. */
export function at(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

export type RunMessage = Pick<ClientMessage, "activity" | "reasoning" | "reasoningParts" | "sources" | "content">;

export function row(
  seq: number,
  atMs: number,
  kind: ClientActivityEvent["kind"],
  title: string,
  extra: Partial<ClientActivityEvent> = {},
): ClientActivityEvent {
  return { id: `act_${seq}`, seq, kind, title, createdAt: at(atMs), ...extra };
}

export function call(partial: Partial<ToolCallRecord> & Pick<ToolCallRecord, "callId" | "tool">): ToolCallRecord {
  return {
    v: 1,
    origin: partial.tool === "mcp" ? "connector" : partial.tool.startsWith("provider_") ? "provider" : "juno",
    title: partial.tool,
    status: "succeeded",
    round: 0,
    index: 0,
    startedAt: at(0),
    ...partial,
  };
}

/** A tool row as TurnStream records it: the legacy projection plus the typed `call`. */
export function toolRow(seq: number, atMs: number, record: ToolCallRecord): ClientActivityEvent {
  const kind: ClientActivityEvent["kind"] =
    record.tool === "web_search" || record.tool === "provider_web_search" || record.tool === "provider_x_search"
      ? "search"
      : record.tool === "web_fetch"
        ? "visit"
        : "tool";
  const title = kind === "search" ? "Searching the web" : kind === "visit" ? "Visited source" : `Using ${record.connectorLabel ?? record.title}`;
  return row(seq, atMs, kind, title, { round: record.round, call: record });
}

export function segmentRow(seq: number, atMs: number, round: number, offset: number, part?: number): ClientActivityEvent {
  return row(seq, atMs, "reasoning", "Thinking", {
    round,
    segment: part === undefined ? { round, offset } : { round, offset, part },
  });
}

export function commentaryRow(seq: number, atMs: number, round: number, text: string, inline: boolean): ClientActivityEvent {
  return row(seq, atMs, "reasoning", "Commentary", { round, detail: text.slice(0, 96), commentary: { round, text, inline } });
}

export function factRow(seq: number, atMs: number, fact: RunFact): ClientActivityEvent {
  const kind: ClientActivityEvent["kind"] = fact.key === "model" ? "model" : fact.key === "connectors" ? "tool" : "context";
  return row(seq, atMs, kind, `fact ${fact.key}`, { fact });
}

export function noticeRow(seq: number, atMs: number, notice: RunNotice, kind: "warning" | "context" = "warning"): ClientActivityEvent {
  return row(seq, atMs, kind, `notice ${notice.code}`, { notice });
}

export function source(n: number, host = "example.org"): ClientSource {
  return { title: `Source ${n}`, url: `https://${host}/page-${n}`, snippet: `Snippet ${n}.` };
}

export function message(activity: ClientActivityEvent[], extra: Partial<RunMessage> = {}): RunMessage {
  return { activity, reasoning: null, reasoningParts: null, sources: [], content: "", ...extra };
}

export function approval(input: Partial<ClientActionApproval> & Pick<ClientActionApproval, "id">): ClientActionApproval {
  return {
    surface: "chat",
    sessionId: "gen_1",
    conversationId: "conv_1",
    connectorId: "github",
    connectorLabel: "GitHub",
    toolName: "create_issue",
    action: "Create issue",
    riskClass: "external_write",
    preview: "Create issue in juno/web",
    detail: { repository: "juno/web" },
    receiptDigest: `digest_${input.id}`,
    status: "pending",
    decision: null,
    canAllowScope: true,
    derivedFromUntrusted: false,
    expiresAt: at(15 * 60_000),
    decidedAt: null,
    completedAt: null,
    createdAt: at(0),
    ...input,
  };
}
