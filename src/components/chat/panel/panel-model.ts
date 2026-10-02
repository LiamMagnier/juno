import type { ClientActionApproval } from "@/lib/action-approval";
import type { ArgNode, PhraseLine, PhraseSpec, RunItem, RunPhase, RunView } from "@/lib/run/types";
import type { ClientMemoryReceipt, ClientMessage, ClientToolDetail } from "@/types/chat";
import type {
  CanonicalToolId,
  ConnectorFailure,
  RunFact,
  RunNotice,
  ToolCallApproval,
  ToolCallRecord,
} from "@/types/run";

import { PANEL_COPY } from "./copy";

/*
 * What the Activity panel shows, decided without React (SPEC §8.3).
 *
 * Everything here is a function of the run view (`RunView`, built by the run
 * UI) and the message it came from, so the tab bar, the header, the approval
 * control, the Details rows and the "Ask to run again" rule are tested against
 * hand-built views with no DOM (§13 harness rule 4). The components only map
 * these shapes to elements.
 *
 * Phrases come from `PANEL_COPY` and ride as `PhraseSpec`s: one bare phrase
 * per spec, arguments as their own nodes (the one-phrase rule, §7.6).
 */

const phrase = (text: string) => ({ phrase: text });
const spec = (...parts: PhraseSpec["parts"]): PhraseSpec => ({ parts });

// ── Tabs ──────────────────────────────────────────────────────────────────────

export type ActivityTabId = "timeline" | "sources" | "details";

/** Where the last chosen tab is remembered, per viewer (SPEC §8.3, beside `juno:thought-width`). */
export const ACTIVITY_TAB_STORAGE_KEY = "juno:activity-tab";

export interface ActivityTab {
  id: ActivityTabId;
  label: string;
  count?: number;
}

/**
 * The tabs this message has something for, in order. A tab with nothing to
 * show is omitted, not disabled (SPEC §8.3). Timeline is always there: it is
 * the default, and while a run has not produced a step yet it carries the
 * "steps appear here" state rather than leaving the panel without a tab.
 */
export function activityTabs(input: { sources: number; details: boolean }): ActivityTab[] {
  const tabs: ActivityTab[] = [{ id: "timeline", label: PANEL_COPY.tabs.timeline }];
  if (input.sources > 0) tabs.push({ id: "sources", label: PANEL_COPY.tabs.sources, count: input.sources });
  if (input.details) tabs.push({ id: "details", label: PANEL_COPY.tabs.details });
  return tabs;
}

export function isActivityTabId(value: unknown): value is ActivityTabId {
  return value === "timeline" || value === "sources" || value === "details";
}

/**
 * The tab to show: the one the reader chose last when this message has it,
 * otherwise Timeline. A focused call (a click on one tool row in the
 * transcript) always opens on Timeline, where that row is.
 */
export function resolveActivityTab(
  preferred: string | null | undefined,
  available: readonly ActivityTab[],
  opts: { focusCall?: boolean } = {},
): ActivityTabId {
  if (opts.focusCall) return "timeline";
  return isActivityTabId(preferred) && available.some((tab) => tab.id === preferred) ? preferred : "timeline";
}

// ── The header ────────────────────────────────────────────────────────────────

/**
 * The static phase word beside the h2 while the run works (SPEC §8.3). Never
 * the transcript line's shimmering label, and never a tool row's verb prefix
 * ("Searching", "Reading"): one English string has one translation (§7.6
 * homographs), so the status words are their own phrases.
 */
export const PANEL_PHASE_WORD: Readonly<Partial<Record<RunPhase, string>>> = {
  queued: PANEL_COPY.phase.thinking,
  thinking: PANEL_COPY.phase.thinking,
  searching: PANEL_COPY.phase.searching,
  reading: PANEL_COPY.phase.reading,
  tool: PANEL_COPY.phase.tool,
  waiting: PANEL_COPY.phase.waiting,
  writing: PANEL_COPY.phase.writing,
};

export type PanelHeaderModel =
  /** Working: the static phase word and the clock, counting from `since`. */
  | { kind: "live"; word: string; since: number | null }
  /** At rest (and once the answer has started): the summary lead and its duration. */
  | { kind: "rest"; line: PhraseSpec; failed: boolean }
  | { kind: "none" };

/** The research completion message's own fact (SPEC §9.6.3), which leads with "Researched for". */
export function researchFactOf(
  message: Pick<ClientMessage, "activity"> | null | undefined,
): Extract<RunFact, { key: "research" }> | null {
  for (const event of message?.activity ?? []) {
    if (event.fact?.key === "research") return event.fact;
  }
  return null;
}

/**
 * The header's status row (SPEC §8.3, the lead of §7.6.2): the phase word while
 * the run works, "Thought for 12s" at rest. The lead is "Thought for" whenever
 * the run reasoned or ran any call, "Answered in" when it did neither,
 * "Researched for" on a research completion, "Stopped after" and "Couldn't
 * finish" for the two ends that are not an answer. No duration is invented: a
 * run with no measured time shows no lead, except "Couldn't finish", which is
 * true without one.
 */
export function panelHeaderModel(
  view: RunView | null,
  phase: RunPhase | null,
  research?: Extract<RunFact, { key: "research" }> | null,
): PanelHeaderModel {
  if (!view) return { kind: "none" };
  const word = phase ? PANEL_PHASE_WORD[phase] : undefined;
  if (word) return { kind: "live", word, since: view.timing.startedAt };

  const duration = (ms: number | null | undefined): ArgNode | null =>
    ms != null && Number.isFinite(ms) && ms > 0 ? { kind: "duration", ms, style: "narrow" } : null;

  if (phase === "failed") {
    const ms = duration(view.timing.workedMs);
    return { kind: "rest", failed: true, line: ms ? spec(phrase(PANEL_COPY.lead.couldntFinish), ms) : spec(phrase(PANEL_COPY.lead.couldntFinish)) };
  }
  if (research) {
    const ms = duration(research.workedMs);
    return ms ? { kind: "rest", failed: false, line: spec(phrase(PANEL_COPY.lead.researchedFor), ms) } : { kind: "none" };
  }
  const ms = duration(view.timing.workedMs);
  if (!ms) return { kind: "none" };
  const lead =
    phase === "stopped"
      ? PANEL_COPY.lead.stoppedAfter
      : view.hasReasoning || view.tools.length > 0
        ? PANEL_COPY.lead.thoughtFor
        : PANEL_COPY.lead.answeredIn;
  return { kind: "rest", failed: false, line: spec(phrase(lead), ms) };
}

// ── Timeline rows ─────────────────────────────────────────────────────────────

export type ToolItem = Extract<RunItem, { kind: "tool" }>;

export type ToolRowState = "working" | "waiting" | "succeeded" | "failed" | "declined" | "cancelled";

/**
 * How a call's row reads. A denial or an expiry is the reader's (or the
 * clock's) decision, not a failure: it is never drawn in the failure ink and
 * never offers a retry (SPEC §7.6.1, bug B5).
 */
export function toolRowState(call: Pick<ToolCallRecord, "status">): ToolRowState {
  switch (call.status) {
    case "queued":
    case "running":
      return "working";
    case "awaiting_approval":
      return "waiting";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "denied":
    case "expired":
      return "declined";
    case "cancelled":
      return "cancelled";
  }
}

/** Which of the presentation's three lines a row shows. */
export function toolLineKind(call: Pick<ToolCallRecord, "status">): "running" | "done" | "failed" {
  const state = toolRowState(call);
  if (state === "working" || state === "waiting") return "running";
  return state === "succeeded" ? "done" : "failed";
}

/**
 * The call the panel's loop belongs to (SPEC §7.9.1 priority 1): the most
 * recently started running call, or, when nothing runs, the live reasoning
 * item. Null when nothing in the panel is working.
 */
export function panelLoopItemKey(view: RunView | null, streaming: boolean): string | null {
  if (!view || !streaming) return null;
  let running: ToolItem | null = null;
  for (const tool of view.tools) {
    if (tool.call.status !== "running") continue;
    if (!running || Date.parse(tool.call.startedAt) >= Date.parse(running.call.startedAt)) running = tool;
  }
  if (running) return running.key;
  for (let i = view.items.length - 1; i >= 0; i -= 1) {
    const item = view.items[i];
    if (item.kind === "reasoning" && item.live) return item.key;
  }
  return null;
}

/**
 * The panel's claim on the one loop (SPEC §7.9.1 priority 1, §8.4): held while
 * the panel has a live item, whatever tab is showing — in sheet mode the
 * transcript's run line is covered, and an `IntersectionObserver` cannot see
 * that. One id per panel, so the claim does not change hands when the live item
 * moves from reasoning to a call. Null when nothing in the panel is working;
 * the transcript line keeps the loop then.
 */
export function panelLoopClaim(renderKey: string, loopKey: string | null): { id: string; priority: 1 } | null {
  return loopKey ? { id: panelLoopId(renderKey), priority: 1 } : null;
}

/** The id the panel claims the loop under, and reads its ownership by. */
export function panelLoopId(renderKey: string): string {
  return `panel:${renderKey}`;
}

/** The first `max` lines of a block and how many were left out, for "Show all". */
export function clampLines(text: string, max: number): { head: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { head: text, hidden: 0 };
  return { head: lines.slice(0, max).join("\n"), hidden: lines.length - max };
}

/** A reasoning item's provider headline (`**Planning the search**` on its first line), shown as an h3. */
export function splitHeadline(text: string): { headline: string | null; body: string } {
  const match = /^\*\*(.{3,80})\*\*[ \t]*(?:\n|$)/.exec(text.trimStart());
  if (!match) return { headline: null, body: text.trim() };
  return { headline: match[1].trim(), body: text.trimStart().slice(match[0].length).trim() };
}

/** Paragraphs of model prose: split on blank lines, never on a single newline. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/**
 * What the Arguments section shows: the redacted text the server recorded for
 * the call (connector calls), else the tool's safe presentation parameters as
 * JSON, else nothing. `note` is the sentence that replaces a missing box.
 */
export function argumentsOf(
  call: Pick<ToolCallRecord, "args">,
  detail: ClientToolDetail | undefined,
): { text: string | null; truncated: boolean; noteKey: NonNullable<ClientToolDetail["argsNote"]> | null } {
  if (detail?.args) return { text: detail.args, truncated: detail.argsTruncated === true, noteKey: null };
  if (detail?.argsNote) return { text: null, truncated: false, noteKey: detail.argsNote };
  const args = call.args && Object.keys(call.args).length > 0 ? JSON.stringify(call.args, null, 2) : null;
  return { text: args, truncated: false, noteKey: null };
}

// ── Failures and "Ask to run again" ──────────────────────────────────────────

/**
 * "Ask to run again" is offered on a FAILED call to a third-party tool only
 * (SPEC §8.3.1): never on a denial, an expiry or a block, which were decisions
 * and would be made again, and never on Juno's own tools, which the model
 * retries itself.
 */
export function canAskToRunAgain(call: Pick<ToolCallRecord, "origin" | "status" | "error">): boolean {
  if (call.origin !== "connector" || call.status !== "failed") return false;
  const code = call.error?.code;
  return code !== "blocked" && code !== "denied" && code !== "expired" && code !== "not_permitted";
}

/** The composer text "Ask to run again" writes: ["Try again:", label(tool title)]. */
export function askToRunAgainSpec(call: Pick<ToolCallRecord, "toolTitle" | "connectorLabel" | "title">): PhraseSpec {
  const title = call.toolTitle?.trim() || call.connectorLabel?.trim() || call.title;
  return spec(phrase(PANEL_COPY.call.tryAgain), { kind: "label", value: title });
}

// ── Approvals ─────────────────────────────────────────────────────────────────

/**
 * The live approval a waiting call is asking for, from the message's
 * `approvals` (the `approval` frames). The decision control needs its digest,
 * which only the frame carries; a call whose frame has not arrived yet, or has
 * already been answered, has no control.
 */
export function pendingApprovalFor(
  call: Pick<ToolCallRecord, "status" | "approval">,
  approvals: readonly ClientActionApproval[] | null | undefined,
): ClientActionApproval | null {
  if (call.status !== "awaiting_approval" || !call.approval?.id) return null;
  const live = approvals?.find((approval) => approval.id === call.approval?.id);
  return live && live.status === "pending" ? live : null;
}

/**
 * The receipt line for an answered approval (SPEC §7.10): "Allowed once",
 * "Always allowed", "You declined this", "Approval expired". The time of the
 * decision is shown beside it by the component, as a clock time.
 */
export function approvalReceiptPhrase(approval: Pick<ToolCallApproval, "status" | "decision">): string | null {
  switch (approval.status) {
    case "pending":
      return PANEL_COPY.approval.waiting;
    case "denied":
      return PANEL_COPY.approval.declined;
    case "expired":
      return PANEL_COPY.approval.expired;
    case "blocked":
      return PANEL_COPY.approval.blocked;
    case "superseded":
      return PANEL_COPY.approval.cancelled;
    case "allowed":
    case "executing":
    case "executed":
    case "failed":
      return approval.decision === "allow_scope" ? PANEL_COPY.approval.alwaysAllowed : PANEL_COPY.approval.allowedOnce;
  }
}

// ── Notices ───────────────────────────────────────────────────────────────────

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null;
const count = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function isConnectorFailure(value: unknown): value is ConnectorFailure {
  return typeof value === "string" && value in PANEL_COPY.connectorFailure;
}

type ResearchRefusal = keyof typeof PANEL_COPY.researchRefusal;
function isResearchRefusal(value: unknown): value is Exclude<ResearchRefusal, "resetsOn"> {
  return typeof value === "string" && value !== "resetsOn" && value in PANEL_COPY.researchRefusal;
}

/**
 * A typed notice as its line (SPEC §7.6 notice table). The typed UI never shows
 * a notice's legacy English title; params that are missing drop their node
 * rather than printing a hole.
 */
export function noticeLine(notice: RunNotice): PhraseLine {
  const params = notice.params ?? {};
  const copy = PANEL_COPY.notices;
  switch (notice.code) {
    case "model_changed": {
      const model = text(params.model ?? params.label);
      return [model ? spec(phrase(copy.model_changed), { kind: "label", value: model }) : spec(phrase(copy.model_changed))];
    }
    case "skill_not_applied": {
      const skill = text(params.skill ?? params.label);
      return skill ? [spec(phrase(copy.skill_not_applied)), spec({ kind: "label", value: skill })] : [spec(phrase(copy.skill_not_applied))];
    }
    case "connector_unavailable": {
      const connector = text(params.connector ?? params.label);
      const line: PhraseSpec[] = [
        connector ? spec({ kind: "label", value: connector }, phrase(copy.connector_unavailable)) : spec(phrase(PANEL_COPY.details.couldntConnect)),
      ];
      if (isConnectorFailure(params.reason)) line.push(spec(phrase(PANEL_COPY.connectorFailure[params.reason])));
      return line;
    }
    case "tool_budget": {
      if (params.reason === "searches") return [spec(phrase(copy.tool_budget_searches))];
      const steps = count(params.steps);
      return [
        steps != null
          ? spec(phrase(copy.tool_budget), { kind: "count", n: steps, ...PANEL_COPY.units.step })
          : spec(phrase(copy.tool_budget_searches)),
      ];
    }
    case "hostile_content": {
      const host = text(params.host ?? params.domain);
      return host ? [spec(phrase(copy.hostile_content)), spec({ kind: "domain", value: host })] : [spec(phrase(copy.hostile_content))];
    }
    case "search_degraded": {
      const engine = text(params.engine);
      return engine ? [spec(phrase(copy.search_degraded)), spec({ kind: "label", value: engine })] : [spec(phrase(copy.search_degraded))];
    }
    case "research_skipped": {
      const line: PhraseSpec[] = [spec(phrase(copy.research_skipped))];
      if (isResearchRefusal(params.reason)) line.push(spec(phrase(PANEL_COPY.researchRefusal[params.reason])));
      const resetsOn = text(params.resetsOn);
      if (resetsOn) line.push(spec(phrase(PANEL_COPY.researchRefusal.resetsOn), { kind: "date", iso: resetsOn, style: "medium" }));
      return line;
    }
    case "tools_capped": {
      const dropped = count(params.dropped);
      return dropped != null
        ? [spec(phrase(copy.tools_capped)), spec({ kind: "count", n: dropped, ...PANEL_COPY.units.tool })]
        : [spec(phrase(copy.tools_capped))];
    }
    case "usage_limit":
    case "stall":
    case "finish_length":
    case "finish_sensitive":
    case "web_off_lockdown":
    case "provenance_refused":
    case "private_tools_limited":
      return [spec(phrase(copy[notice.code]))];
  }
}

/** Must-act notices read in the failure ink (SPEC §2.4): the codes that ride `kind: "warning"`. */
export function isWarningNotice(notice: RunNotice | null): boolean {
  return (
    notice != null &&
    (notice.code === "finish_length" ||
      notice.code === "usage_limit" ||
      notice.code === "connector_unavailable" ||
      notice.code === "hostile_content" ||
      notice.code === "research_skipped")
  );
}

// ── Details ───────────────────────────────────────────────────────────────────

export type EffortRung = keyof typeof PANEL_COPY.details.rung;

export interface ModelCatalogEntry {
  name: string;
  contextWindow?: number;
}

export interface DetailsModel {
  model: { label: string; provider: string | null; routed: boolean } | null;
  effort: { rung: EffortRung; auto: boolean } | null;
  /** Measured context against the model's window, or the turn's input counts when either is unknown. */
  context:
    | { kind: "tokens"; used: number; window: number }
    | { kind: "counts"; historyMessages: number; attachments: number; projectFiles: number }
    | null;
  tools: { offered: CanonicalToolId[]; nativeSearch: boolean; roundBudget: number } | null;
  connectors: Extract<RunFact, { key: "connectors" }> | null;
  memory: ClientMemoryReceipt[];
}

/**
 * The Details tab's rows (SPEC §8.3.3). A row with nothing true to say is
 * absent. The model comes from the turn's `fact:model`; a message written
 * before facts existed falls back to its stored model id through the client
 * catalog. The context row shows tokens used against the window only when both
 * are known, and the turn's input counts otherwise.
 */
export function detailsModel(
  view: RunView,
  message: Pick<ClientMessage, "promptTokens" | "model">,
  catalog: (modelId: string) => ModelCatalogEntry | null,
): DetailsModel {
  const modelFact = view.facts.model?.key === "model" ? view.facts.model : null;
  const modelId = modelFact?.modelId ?? message.model ?? null;
  const entry = modelId ? catalog(modelId) : null;
  const model = modelFact
    ? { label: modelFact.label || entry?.name || modelFact.modelId, provider: modelFact.provider || null, routed: modelFact.routed === true }
    : modelId
      ? { label: entry?.name ?? modelId, provider: null, routed: false }
      : null;

  const effortFact = view.facts.effort?.key === "effort" ? view.facts.effort : null;
  const effort = effortFact && effortFact.effort in PANEL_COPY.details.rung ? { rung: effortFact.effort, auto: effortFact.auto } : null;

  const contextFact = view.facts.context?.key === "context" ? view.facts.context : null;
  const used = message.promptTokens;
  const window = entry?.contextWindow;
  const context =
    used != null && used > 0 && window != null && window > 0
      ? ({ kind: "tokens", used, window } as const)
      : contextFact
        ? ({
            kind: "counts",
            historyMessages: contextFact.historyMessages,
            attachments: contextFact.attachments,
            projectFiles: contextFact.projectFiles,
          } as const)
        : null;

  const toolsFact = view.facts.tools?.key === "tools" ? view.facts.tools : null;
  const tools = toolsFact
    ? { offered: [...new Set(toolsFact.offered)], nativeSearch: toolsFact.nativeSearch, roundBudget: toolsFact.roundBudget }
    : null;

  const connectorsFact = view.facts.connectors?.key === "connectors" ? view.facts.connectors : null;
  const connectors = connectorsFact && connectorsFact.ready.length + connectorsFact.failed.length > 0 ? connectorsFact : null;

  return { model, effort, context, tools, connectors, memory: view.facts.memory };
}

export function hasDetails(details: DetailsModel | null): boolean {
  return (
    details != null &&
    (details.model != null ||
      details.effort != null ||
      details.context != null ||
      details.tools != null ||
      details.connectors != null ||
      details.memory.length > 0)
  );
}

/** The context row: ["Context used", tokens] · ["Window", tokens], or the input counts that are non-zero. */
export function contextLine(context: NonNullable<DetailsModel["context"]>): PhraseLine {
  const units = PANEL_COPY.units;
  if (context.kind === "tokens") {
    return [
      spec(phrase(PANEL_COPY.details.contextUsed), { kind: "count", n: context.used, ...units.token }),
      spec(phrase(PANEL_COPY.details.window), { kind: "count", n: context.window, ...units.token }),
    ];
  }
  const line: PhraseSpec[] = [];
  if (context.historyMessages > 0) line.push(spec({ kind: "count", n: context.historyMessages, ...units.earlierMessage }));
  if (context.attachments > 0) line.push(spec({ kind: "count", n: context.attachments, ...units.attachment }));
  if (context.projectFiles > 0) line.push(spec({ kind: "count", n: context.projectFiles, ...units.projectFile }));
  return line;
}

/** The tool list's phrases, one per offered tool, never a raw tool id (INV-28). */
export function toolNamePhrases(offered: readonly CanonicalToolId[]): string[] {
  const names = PANEL_COPY.toolNames as Record<string, string>;
  const seen = new Set<string>();
  for (const id of offered) {
    const name = names[id];
    if (name) seen.add(name);
  }
  return [...seen];
}
