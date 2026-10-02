/**
 * The client run model: one message's activity, reasoning and sources turned
 * into the ordered view the run block and the Activity panel render (SPEC §7.2).
 *
 * Typed messages (any event carries `seq`) are read from their records; older
 * messages go through the legacy adapter (`legacy.ts`, INV-20). Nothing here
 * reads an English title: behaviour keys on `kind`, typed payloads, `status`
 * and `code` (INV-28).
 *
 * Pure. `buildRunView` depends on the activity array, the reasoning text and
 * the sources, never on `content`, so the caller can memoise it on those and
 * an answer token never rebuilds it (U5).
 */

import * as React from "react";

import { buildLegacyRunView } from "@/lib/run/legacy";
import type { RunItem, RunView } from "@/lib/run/types";
import type { ClientActivityEvent, ClientMemoryReceipt, ClientMessage } from "@/types/chat";
import type { RunFact, ToolCallRecord } from "@/types/run";
import { TERMINAL_TOOL_CALL_STATUSES } from "@/types/run";

export type { RunItem, RunView } from "@/lib/run/types";

type RunMessage = Pick<ClientMessage, "activity" | "reasoning" | "reasoningParts" | "sources" | "content">;
type ToolItem = Extract<RunItem, { kind: "tool" }>;

/** The OpenAI/Anthropic summary heading form: a first line that is bold and nothing else. */
const HEADLINE = /^\*\*(.{3,80})\*\*\s*$/;

/** A reasoning segment's provider headline, or null (§7.3 "The thinking label"). */
export function headlineOf(text: string): string | null {
  const first = text.trimStart().split("\n", 1)[0] ?? "";
  const match = HEADLINE.exec(first);
  return match ? match[1].trim() : null;
}

/** How many step keys the peek keeps: two visible slots and the one leaving. */
const PEEK_KEYS = 3;

/** An ISO instant as epoch ms, or null. */
export function instant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

export function isTerminalStatus(status: ToolCallRecord["status"]): boolean {
  return TERMINAL_TOOL_CALL_STATUSES.includes(status);
}

/** The whole view. Typed iff any activity event has `seq`; otherwise the legacy adapter builds it. */
export function buildRunView(message: RunMessage, now?: number): RunView {
  const activity = message.activity ?? [];
  if (!activity.some((event) => typeof event.seq === "number")) return buildLegacyRunView(message, now);
  return buildTypedRunView(message, activity, now);
}

/**
 * The view of a message, rebuilt only when its activity, reasoning or sources
 * change — never for an answer token (U5). `now` feeds the live timing of a
 * run that has no end row yet.
 */
export function useRunView(message: RunMessage, now?: number): RunView {
  const { activity, reasoning, reasoningParts, sources } = message;
  return React.useMemo(
    () => buildRunView({ activity, reasoning, reasoningParts, sources, content: "" }, now),
    [activity, reasoning, reasoningParts, sources, now],
  );
}

/** One reasoning item per `segment` event; the text runs to the next segment's offset. */
function reasoningSlices(
  reasoning: string,
  segments: ReadonlyArray<{ event: ClientActivityEvent; order: number }>,
): Array<{ event: ClientActivityEvent; order: number; text: string }> {
  const sorted = [...segments].sort((a, b) => a.event.segment!.offset - b.event.segment!.offset);
  return sorted.map((entry, i) => {
    const start = Math.max(0, Math.min(reasoning.length, entry.event.segment!.offset));
    const next = sorted[i + 1]?.event.segment!.offset;
    const end = next === undefined ? reasoning.length : Math.max(start, Math.min(reasoning.length, next));
    return { ...entry, text: reasoning.slice(start, end).trim() };
  });
}

function buildTypedRunView(message: RunMessage, activity: ClientActivityEvent[], now?: number): RunView {
  const reasoning = message.reasoning ?? "";
  const facts: RunView["facts"] = { memory: [] };
  const items: Array<RunItem & { order: number }> = [];
  const segments: Array<{ event: ClientActivityEvent; order: number }> = [];
  let firstAnswerAt: number | null = null;
  let endedAt: number | null = null;
  let warnings = 0;
  let lastOrder = 0;
  const memory: ClientMemoryReceipt[] = [];

  for (const event of activity) {
    // An event the server did not number (it should not happen on a typed turn) keeps its place
    // in the array, just after the one before it.
    const order = typeof event.seq === "number" ? event.seq : lastOrder + 0.001;
    lastOrder = order;
    const at = instant(event.createdAt);
    if (event.memoryReceipt?.length) memory.push(...event.memoryReceipt);
    if (event.kind === "write" && firstAnswerAt === null) firstAnswerAt = at;
    if (event.kind === "done") endedAt = at;
    if (event.kind === "warning") warnings += 1;

    if (event.fact) {
      recordFact(facts, event.fact);
      continue;
    }
    if (event.segment) {
      segments.push({ event, order });
      continue;
    }
    if (event.commentary) {
      items.push({
        kind: "commentary",
        key: `commentary:${event.id}`,
        seq: order,
        round: event.commentary.round,
        text: event.commentary.text,
        inline: event.commentary.inline,
        order,
      });
      continue;
    }
    if (event.call) {
      items.push({
        kind: "tool",
        key: event.call.callId,
        seq: order,
        round: event.call.round,
        call: event.call,
        ...(event.tool ? { detail: event.tool } : {}),
        live: !isTerminalStatus(event.call.status),
        order,
      });
      continue;
    }
    if (event.notice || event.kind === "warning") {
      items.push({
        kind: "notice",
        key: `notice:${event.id}`,
        seq: order,
        notice: event.notice ?? null,
        legacyTitle: event.title,
        ...(event.detail ? { legacyDetail: event.detail } : {}),
        order,
      });
    }
  }

  // The run starts at its first event by seq (the turn-start facts), in the server's clock.
  const first = activity.reduce<ClientActivityEvent | null>(
    (earliest, event) =>
      typeof event.seq === "number" && (earliest === null || event.seq < (earliest.seq ?? Infinity)) ? event : earliest,
    null,
  );
  const startedAt = instant(first?.createdAt);

  if (segments.length) {
    for (const slice of reasoningSlices(reasoning, segments)) {
      items.push({
        kind: "reasoning",
        key: `reasoning:${slice.event.id}`,
        seq: slice.order,
        round: slice.event.segment!.round,
        ...(slice.event.segment!.part === undefined ? {} : { part: slice.event.segment!.part }),
        text: slice.text,
        live: false,
        order: slice.order,
      });
    }
  } else if (reasoning.trim()) {
    // Reasoning with no segment markers: one item, at the start of the run.
    items.push({ kind: "reasoning", key: "reasoning:all", seq: 0, round: 0, text: reasoning.trim(), live: false, order: 0 });
  }

  items.sort((a, b) => a.order - b.order);
  const lastReasoning = findLastIndex(items, (item) => item.kind === "reasoning");
  if (lastReasoning !== -1) (items[lastReasoning] as Extract<RunItem, { kind: "reasoning" }>).live = true;
  facts.memory = memory;

  const finalItems: RunItem[] = items.map(({ order: _order, ...item }) => item as RunItem);
  return finishView({
    typed: true,
    items: finalItems,
    facts,
    message,
    warnings,
    timing: { startedAt, firstAnswerAt, endedAt },
    now,
  });
}

function findLastIndex<T>(list: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i -= 1) if (predicate(list[i])) return i;
  return -1;
}

function recordFact(facts: RunView["facts"], fact: RunFact): void {
  switch (fact.key) {
    case "model":
      facts.model = fact;
      break;
    case "effort":
      facts.effort = fact;
      break;
    case "context":
      facts.context = fact;
      break;
    case "research":
      facts.research = fact;
      break;
    case "tools":
      facts.tools = fact;
      break;
    case "connectors":
      facts.connectors = fact;
      break;
    case "memory":
      break;
  }
}

/** Everything the typed and the legacy view compute the same way: counts, timing, the peek's keys. */
export function finishView(input: {
  typed: boolean;
  items: RunItem[];
  facts: RunView["facts"];
  message: RunMessage;
  warnings: number;
  timing: { startedAt: number | null; firstAnswerAt: number | null; endedAt: number | null };
  /** Legacy runs: URLs of `visit` rows, which feed the source count only. */
  extraSourceUrls?: readonly string[];
  now?: number;
}): RunView {
  const { items, message } = input;
  const tools = items.filter((item): item is ToolItem => item.kind === "tool");

  const urls = new Set<string>();
  for (const source of message.sources ?? []) if (source?.url) urls.add(source.url);
  for (const url of input.extraSourceUrls ?? []) urls.add(url);
  for (const { call } of tools) {
    if (call.tool === "web_fetch" && call.status === "succeeded" && call.web?.finalUrl) urls.add(call.web.finalUrl);
  }

  const connectors: string[] = [];
  const filesRead: string[] = [];
  let searches = 0;
  let codeRuns = 0;
  let filesCreated = 0;
  let failedTools = 0;
  for (const { call } of tools) {
    if (call.tool === "web_search" || call.tool === "provider_web_search" || call.tool === "provider_x_search") searches += 1;
    if (call.tool === "run_code") {
      codeRuns += 1;
      if (call.figure?.kind === "files" && typeof call.figure.n === "number") filesCreated += call.figure.n;
    }
    // A call the reader declined, that expired or that their settings blocked never used the connector.
    const dispatched = call.status !== "denied" && call.status !== "expired" && call.error?.code !== "blocked";
    if (call.tool === "mcp" && dispatched) {
      const name = call.connectorLabel?.trim();
      if (name && !connectors.includes(name)) connectors.push(name);
    }
    if (call.tool === "read_document" && call.status === "succeeded") {
      const file = call.args?.file;
      if (typeof file === "string" && file.trim() && !filesRead.includes(file.trim())) filesRead.push(file.trim());
    }
    if (call.status === "failed") failedTools += 1;
  }

  const { startedAt, firstAnswerAt, endedAt } = input.timing;
  const now = input.now;

  let workedMs: number | null = null;
  if (startedAt !== null) {
    const until = firstAnswerAt ?? endedAt ?? (now ?? null);
    if (until !== null) {
      workedMs = Math.max(0, until - startedAt);
      if (firstAnswerAt !== null) workedMs += toolTimeAfter(tools, firstAnswerAt, endedAt ?? now ?? null);
    }
  }

  const steps = items.filter(
    (item) => item.kind === "tool" || item.kind === "reasoning" || (item.kind === "commentary" && !item.inline),
  );

  return {
    typed: input.typed,
    items,
    tools,
    facts: input.facts,
    counts: {
      sources: urls.size,
      searches,
      codeRuns,
      filesCreated,
      connectorsUsed: connectors,
      filesRead,
      failedTools,
      warnings: input.warnings,
    },
    hasReasoning: Boolean(message.reasoning?.trim()) || Boolean(message.reasoningParts?.some((part) => part.trim())),
    timing: { startedAt, firstAnswerAt, endedAt, workedMs },
    sourceUrls: [...urls],
    pendingApprovalIds: tools
      .filter((item) => item.call.status === "awaiting_approval" && item.call.approval?.id)
      .map((item) => item.call.approval!.id),
    latestStepKeys: steps.slice(-PEEK_KEYS).map((item) => item.key),
  };
}

/**
 * The union of the tool intervals that start after the first answer text:
 * the clock resumes for a tool that runs once the answer has begun (§7.3
 * re-entry), and counts overlapping calls once.
 */
function toolTimeAfter(tools: readonly ToolItem[], from: number, until: number | null): number {
  const spans: Array<[number, number]> = [];
  for (const { call } of tools) {
    const start = instant(call.startedAt);
    if (start === null || start < from) continue;
    // A call still working counts to now; a finished one with no recorded end counts nothing.
    const end = instant(call.endedAt) ?? (isTerminalStatus(call.status) ? null : until);
    if (end === null || end <= start) continue;
    spans.push([start, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let open: [number, number] | null = null;
  for (const span of spans) {
    if (open && span[0] <= open[1]) {
      open[1] = Math.max(open[1], span[1]);
      continue;
    }
    if (open) total += open[1] - open[0];
    open = [span[0], span[1]];
  }
  if (open) total += open[1] - open[0];
  return total;
}
