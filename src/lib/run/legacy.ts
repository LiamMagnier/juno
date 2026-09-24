/**
 * The legacy adapter: a message persisted before the rework, read into the
 * same view (SPEC §7.7, INV-20).
 *
 * A pre-rework row has no `seq`, no typed records and no round structure, so
 * its shape is recovered from what the old emitters wrote: the array order,
 * `tool` detail on the connector rows, and a handful of English titles. This
 * file is the ONLY place in the run UI that reads a title (INV-28); an ESLint
 * rule forbids `.title.startsWith(` under `components/chat/run` and
 * `components/chat/panel`, so the matching cannot leak into a component.
 *
 * Nothing is backfilled and nothing is inferred beyond what the row says:
 * glued content stays glued, no commentary is invented, and an approval row
 * whose outcome was never recorded is dropped rather than guessed.
 */

import { finishView } from "@/lib/run/timeline";
import type { RunItem, RunView } from "@/lib/run/types";
import type { ClientActivityEvent, ClientMemoryReceipt, ClientMessage, ClientToolDetail } from "@/types/chat";
import type { CanonicalToolId, ToolCallRecord, ToolCallStatus } from "@/types/run";

type RunMessage = Pick<ClientMessage, "activity" | "reasoning" | "reasoningParts" | "sources" | "content">;

/**
 * Old tool ids under their new names (INV-23). The alias map proper is WS1's
 * `src/lib/tools/aliases.ts`; the two entries a stored row can carry are
 * repeated here so the client bundle does not pull the server's registry.
 */
const LEGACY_TOOL_IDS: Readonly<Record<string, CanonicalToolId>> = {
  code_interpreter: "run_code",
  browser_agent: "web_fetch",
};

const JUNO_TOOL_IDS: ReadonlySet<string> = new Set<CanonicalToolId>([
  "web_search",
  "web_fetch",
  "read_document",
  "inspect_image",
  "run_code",
  "search_chats",
  "current_time",
  "calculate",
  "start_task",
  "suggest_research",
]);

/** The canonical id of a stored call: a namespaced name (`github__create_issue`) is a connector. */
export function canonicalToolId(detail: Pick<ClientToolDetail, "name">): CanonicalToolId {
  const name = detail.name.trim();
  if (name.includes("__")) return "mcp";
  const aliased = LEGACY_TOOL_IDS[name];
  if (aliased) return aliased;
  return JUNO_TOOL_IDS.has(name) ? (name as CanonicalToolId) : "mcp";
}

/** "github__create_issue" → "Create issue": the bare function name, as a reader would say it. */
export function humaniseToolName(name: string): string {
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  const words = bare.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function legacyStatus(detail: ClientToolDetail): ToolCallStatus {
  if (detail.status === "ok") return "succeeded";
  if (detail.status === "failed") return "failed";
  if (detail.resultNote === "pending" || detail.resultNote === "unfinished") return "cancelled";
  // A finished row that recorded a result but no status predates `status`: it ran.
  return "succeeded";
}

const USING = "Using ";
const NEEDS_APPROVAL = " needs approval";
const TASK_NEEDS_APPROVAL = "Starting a task needs your approval";
const TASK_STARTED = "Started a task";
const TASK_NOT_STARTED = "Task not started";
const PROVIDER_SEARCH = "Searching the web";

function record(event: ClientActivityEvent, index: number, fields: Omit<ToolCallRecord, "v" | "callId" | "round" | "index" | "startedAt">): ToolCallRecord {
  return { v: 1, callId: event.id, round: 0, index, startedAt: event.createdAt, ...fields };
}

export function buildLegacyRunView(message: RunMessage, now?: number): RunView {
  const activity = message.activity ?? [];
  const items: RunItem[] = [];
  const memory: ClientMemoryReceipt[] = [];
  const visitUrls: string[] = [];
  let seq = 0;
  let warnings = 0;
  let firstAnswerAt: number | null = null;
  let endedAt: number | null = null;
  let toolIndex = 0;

  // One reasoning item — the whole text, or one per stored part — placed first.
  const parts = (message.reasoningParts ?? []).map((part) => part.trim()).filter(Boolean);
  if (parts.length) {
    parts.forEach((text, part) => {
      seq += 1;
      items.push({ kind: "reasoning", key: `reasoning:${part}`, seq, round: 0, part, text, live: false });
    });
  } else if (message.reasoning?.trim()) {
    seq += 1;
    items.push({ kind: "reasoning", key: "reasoning:all", seq, round: 0, text: message.reasoning.trim(), live: false });
  }
  const lastReasoning = items.length - 1;
  if (lastReasoning >= 0) (items[lastReasoning] as Extract<RunItem, { kind: "reasoning" }>).live = true;

  for (const event of activity) {
    const at = Date.parse(event.createdAt);
    if (event.memoryReceipt?.length) memory.push(...event.memoryReceipt);
    if (event.kind === "write" && firstAnswerAt === null && Number.isFinite(at)) firstAnswerAt = at;
    if (event.kind === "done" && Number.isFinite(at)) endedAt = at;

    switch (event.kind) {
      case "tool": {
        const title = event.title;
        if (title.endsWith(NEEDS_APPROVAL) || title === TASK_NEEDS_APPROVAL) break;
        if (title === TASK_STARTED || title === TASK_NOT_STARTED) {
          seq += 1;
          const call = record(event, toolIndex++, {
            tool: "start_task",
            origin: "juno",
            title: "Start a task",
            status: title === TASK_STARTED ? "succeeded" : "failed",
            ...(event.detail ? { args: { title: event.detail } } : {}),
          });
          items.push({ kind: "tool", key: call.callId, seq, round: 0, call, live: false });
          break;
        }
        if (!title.startsWith(USING) || !event.tool) break;
        const tool = canonicalToolId(event.tool);
        const connector = tool === "mcp";
        seq += 1;
        const call = record(event, toolIndex++, {
          tool,
          origin: connector ? "connector" : "juno",
          title: humaniseToolName(event.tool.name),
          ...(connector
            ? { connectorLabel: title.slice(USING.length).trim() || event.tool.server, toolTitle: humaniseToolName(event.tool.name) }
            : {}),
          status: legacyStatus(event.tool),
          ...(typeof event.tool.durationMs === "number" ? { durationMs: event.tool.durationMs } : {}),
          // The row was opened when the call started; its end is known only when a duration was measured.
          ...(typeof event.tool.durationMs === "number" && Number.isFinite(at)
            ? { endedAt: new Date(at + event.tool.durationMs).toISOString() }
            : {}),
        });
        items.push({ kind: "tool", key: call.callId, seq, round: 0, call, detail: event.tool, live: false });
        break;
      }
      case "search": {
        // Only the real query rows; "Preparing web search" named no query and ran nothing yet.
        if (event.title !== PROVIDER_SEARCH || !event.detail) break;
        seq += 1;
        const call = record(event, toolIndex++, {
          tool: "provider_web_search",
          origin: "provider",
          title: "Web search",
          status: "succeeded",
          args: { query: event.detail },
        });
        items.push({ kind: "tool", key: call.callId, seq, round: 0, call, live: false });
        break;
      }
      case "visit":
        if (event.url) visitUrls.push(event.url);
        break;
      case "warning":
        warnings += 1;
        seq += 1;
        items.push({
          kind: "notice",
          key: `notice:${event.id}`,
          seq,
          notice: null,
          legacyTitle: event.title,
          ...(event.detail ? { legacyDetail: event.detail } : {}),
        });
        break;
      default:
        break;
    }
  }

  const startedAt = activity.length ? Date.parse(activity[0].createdAt) : Number.NaN;
  return finishView({
    typed: false,
    items,
    facts: { memory },
    message,
    warnings,
    timing: { startedAt: Number.isFinite(startedAt) ? startedAt : null, firstAnswerAt, endedAt },
    extraSourceUrls: visitUrls,
    now,
  });
}
