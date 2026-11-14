import type { ClientActionApproval } from "@/lib/action-approval";
import type { ClientActivityEvent, ClientMessage } from "@/types/chat";
import type { ContextUsage } from "@/lib/chat/context-usage";
import type { ToolCallRecord } from "@/types/run";

export const RENEWALS_TITLE = "Q3 forecast against Stripe revenue";
export const RENEWALS_PROJECT = "Renewals 2026";
export const RENEWALS_USAGE: ContextUsage = { key: "context_usage", inputTokens: 41_200, cachedTokens: 25_000, windowTokens: 200_000 };
const SUMMARY = "Q3 renewals: Stripe is €26,000 under forecast. Halvorsen accounts for €23,600 of it. Mira is checking usage and will flag which accounts need a call this week.";
const AT = "2026-11-14T12:00:00.000Z";

export function renewalApproval(now: Date): ClientActionApproval {
  return {
    id: "fixture-renewal-summary", conversationId: "c-active", surface: "chat", sessionId: "fixture-generation",
    connectorId: "slack", connectorLabel: "Slack", toolName: "post_message", action: "connector.slack.post_message",
    riskClass: "external_write", preview: SUMMARY, detail: { channel: "#design", text: SUMMARY },
    receiptDigest: "fixture-digest", status: "pending", decision: null, canAllowScope: false, derivedFromUntrusted: false,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(), decidedAt: null, completedAt: null,
  };
}

function tool(seq: number, detail: string, call: Pick<ToolCallRecord, "tool" | "title" | "args" | "connectorLabel" | "origin">): ClientActivityEvent {
  const id = `fixture-call-${seq}`;
  return {
    id, seq, kind: "tool", title: `Using ${call.connectorLabel ?? call.title}`, detail, createdAt: AT,
    call: { ...call, v: 1, callId: id, status: "succeeded", round: 0, index: seq - 1, startedAt: AT, endedAt: AT },
    tool: { name: detail, server: call.connectorLabel ?? "Alevr", argsNote: "empty", result: "Completed in the sample conversation.", status: "ok" },
  };
}

const ACTIVITY: ClientActivityEvent[] = [
  tool(1, "calculate_forecast_gap", { tool: "run_code", title: "Python", args: { language: "python" }, origin: "juno" }),
  tool(2, "read_document", { tool: "read_document", title: "Document", args: { file: "Q3 Forecast.xlsx" }, origin: "juno" }),
  tool(3, "list_collections", { tool: "mcp", title: "List collections", connectorLabel: "Stripe", origin: "connector" }),
  { id: "fixture-memory", seq: 4, kind: "context", title: "Read saved memory summary", createdAt: AT, fact: { key: "memory", summaryScope: "project" } },
  { id: "fixture-usage", seq: 5, kind: "usage", title: "Context usage recorded", createdAt: "2026-11-14T12:00:08.100Z", fact: RENEWALS_USAGE },
  { id: "fixture-done", seq: 6, kind: "done", title: "Finished response", createdAt: "2026-11-14T12:00:08.100Z" },
];

export const RENEWAL_MESSAGES: ClientMessage[] = [
  {
    id: "fixture-user-turn", role: "USER", createdAt: AT, conversationId: "c-active", attachments: [],
    content: "Compare the Q3 forecast with what Stripe actually collected, and tell me which renewals are short.",
  },
  {
    id: "fixture-assistant-turn", role: "ASSISTANT", createdAt: AT, conversationId: "c-active", activity: ACTIVITY, attachments: [],
    content: `Stripe collected **€196,000** against a **€222,000** forecast, so Q3 is **€26,000 short**. Almost all of it is one account.

| Account | Forecast | Collected | Gap |
| --- | ---: | ---: | ---: |
| Halvorsen | €120,000 | €96,400 | **€23,600** |
| Brightline | €64,000 | €61,600 | €2,400 |
| Kestrel | €38,000 | €38,000 | €0 |

Mira is checking usage on all three and will flag which accounts need a call.`,
  },
];
