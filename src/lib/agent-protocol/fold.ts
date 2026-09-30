/*
 * ONE FOLD: the canonical agent protocol, reduced to what a surface shows.
 *
 * Every Juno reader of a coding session — the web transcript, the persisted
 * outcome message, the Mac and the iPhone (JunoAgentProtocol's
 * `AgentSessionFold`, a line-for-line port) — reduces the same events to the
 * same view through these rules, and the golden transcripts in
 * contracts/agent/fixtures prove it: each `<name>.jsonl` must fold to its
 * `<name>.folded.json` in both languages. A rule changed here without the
 * Swift port fails the Swift half of that test.
 *
 * Pure and deterministic: no clock, no randomness, no I/O. Events are applied
 * in the order given; an id already applied is skipped, so a replayed batch is
 * harmless. Outcomes are TYPED — a tool's status is the protocol's
 * `ToolResultStatus`, never something read out of a display string.
 *
 * The view's JSON shape is part of the contract with the Swift port: optional
 * keys are omitted rather than null, and counts are integers.
 */
import type {
  AgentApprovalDecision,
  AgentApprovalResolver,
  AgentCompactionSource,
  AgentErrorInfo,
  AgentFileChangeKind,
  AgentNoticeSource,
  AgentOutputChannel,
  AgentPermissionMode,
  AgentPlanDecision,
  AgentPlanStep,
  AgentQuestionOption,
  AgentReasoningEffort,
  AgentRepositoryRef,
  AgentRisk,
  AgentSessionState,
  AgentSessionTarget,
  AgentStopReason,
  AgentSubagentStatus,
  AgentToolKind,
  AgentToolResultStatus,
  AgentTurnOrigin,
  AgentUsage,
  AgentUserDelivery,
  ParsedAgentEvent,
} from "./protocol.generated";

/** A tool call's status in the view: running until its result, then the result's status. */
export type AgentToolItemStatus = "running" | AgentToolResultStatus;

export type AgentTurnStatus = "running" | "completed" | "failed" | "interrupted";

export interface AgentTurnView {
  turnId: string;
  origin: AgentTurnOrigin;
  status: AgentTurnStatus;
  stopReason?: AgentStopReason;
  durationMs?: number;
  filesChanged?: number;
  summary?: string;
  error?: AgentErrorInfo;
  itemIds: string[];
}

interface ItemBase {
  itemId: string;
  turnId?: string;
  agentId?: string;
}

export interface AgentUserMessageItem extends ItemBase {
  kind: "user_message";
  text: string;
  delivery: AgentUserDelivery;
  commandId?: string;
}
export interface AgentAssistantTextItem extends ItemBase {
  kind: "assistant_text";
  text: string;
}
export interface AgentThinkingItem extends ItemBase {
  kind: "thinking";
  text: string;
}
export interface AgentToolItem extends ItemBase {
  kind: "tool";
  toolName: string;
  toolKind: AgentToolKind;
  title: string;
  inputSummary?: string;
  risk?: AgentRisk;
  status: AgentToolItemStatus;
  summary?: string;
  exitCode?: number;
  durationMs?: number;
  /** Live output chunks, joined; a result's own `output` replaces them. */
  output?: string;
  /** The channel of the last live chunk, when any arrived. */
  outputChannel?: AgentOutputChannel;
}
export interface AgentFileChangeItem extends ItemBase {
  kind: "file_change";
  path: string;
  change: AgentFileChangeKind;
  linesAdded: number;
  linesRemoved: number;
  patch?: string;
  checkpointId?: string;
  toolItemId?: string;
}
export interface AgentTestRunItem extends ItemBase {
  kind: "test_run";
  command: string;
  passed: boolean;
  testsRun?: number;
  failures?: number;
  durationMs?: number;
}
export interface AgentSubagentItem extends ItemBase {
  kind: "subagent";
  title: string;
  status: AgentSubagentStatus;
  role?: string;
  activity?: string;
  summary?: string;
  error?: string;
  toolItemId?: string;
  usage?: AgentUsage;
}
export interface AgentCompactionItem extends ItemBase {
  kind: "compaction";
  source: AgentCompactionSource;
  beforeMessages?: number;
  afterMessages?: number;
  requestedByUser?: boolean;
}
export interface AgentNoticeItem extends ItemBase {
  kind: "notice";
  source: AgentNoticeSource;
  text: string;
  detail?: string;
}
export interface AgentApprovalItem extends ItemBase {
  kind: "approval";
  approvalId: string;
  action: string;
  summary: string;
  risk: AgentRisk;
  toolItemId?: string;
  digest?: string;
  expiresAt?: string;
  suggestedRule?: string;
  decision?: AgentApprovalDecision;
  by?: AgentApprovalResolver;
  feedback?: string;
}
export interface AgentQuestionItem extends ItemBase {
  kind: "question";
  questionId: string;
  prompt: string;
  options?: AgentQuestionOption[];
  multiSelect?: boolean;
  expiresAt?: string;
  answered: boolean;
  answer?: string;
  selected?: string[];
}
export interface AgentPlanProposalItem extends ItemBase {
  kind: "plan_proposal";
  planId: string;
  text: string;
  decision?: AgentPlanDecision;
}
export interface AgentErrorItem extends ItemBase {
  kind: "error";
  error: AgentErrorInfo;
}

export type AgentItemView =
  | AgentUserMessageItem
  | AgentAssistantTextItem
  | AgentThinkingItem
  | AgentToolItem
  | AgentFileChangeItem
  | AgentTestRunItem
  | AgentSubagentItem
  | AgentCompactionItem
  | AgentNoticeItem
  | AgentApprovalItem
  | AgentQuestionItem
  | AgentPlanProposalItem
  | AgentErrorItem;

export interface AgentUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costMicroUsd: number;
  /** The model the last usage report named. */
  model?: string;
}

export interface AgentPullRequestView {
  branch: string;
  prUrl?: string;
  prNumber?: number;
  reused?: boolean;
}

export interface AgentSessionView {
  sessionId?: string;
  state: AgentSessionState;
  target?: AgentSessionTarget;
  workspaceName?: string;
  repository?: AgentRepositoryRef;
  model?: string;
  effort?: AgentReasoningEffort;
  mode?: AgentPermissionMode;
  title?: string;
  turns: AgentTurnView[];
  items: AgentItemView[];
  /** The approval a reader can answer now. */
  pendingApprovalId?: string;
  /** The question a reader can answer now. */
  pendingQuestionId?: string;
  plan?: { steps: AgentPlanStep[]; objective?: string };
  usage: AgentUsageTotals;
  pullRequest?: AgentPullRequestView;
  lastError?: AgentErrorInfo;
  /** The highest `seq` applied. */
  lastSeq: number;
  /** Events applied, duplicates excluded, unknown types included. */
  eventCount: number;
  /** Events of a type this build does not know. */
  unknownEventCount: number;
}

/** A fold in progress: the view, and what it needs to apply the next event. */
export interface AgentFold {
  view: AgentSessionView;
  /** Event ids already applied. */
  seen: Set<string>;
  /** Where each item sits in `view.items`. */
  itemIndex: Map<string, number>;
  /** Where each turn sits in `view.turns`. */
  turnIndex: Map<string, number>;
  /** The turn items without a turnId join. */
  openTurnId?: string;
}

export function emptyAgentSessionView(): AgentSessionView {
  return {
    state: "idle",
    turns: [],
    items: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costMicroUsd: 0,
    },
    lastSeq: 0,
    eventCount: 0,
    unknownEventCount: 0,
  };
}

export function createAgentFold(): AgentFold {
  return { view: emptyAgentSessionView(), seen: new Set(), itemIndex: new Map(), turnIndex: new Map() };
}

/** Fold a whole stream. */
export function foldAgentEvents(events: Iterable<ParsedAgentEvent>): AgentSessionView {
  const fold = createAgentFold();
  for (const event of events) applyAgentEvent(fold, event);
  return fold.view;
}

/** Apply events to a fold in progress, in order. */
export function applyAgentEvents(fold: AgentFold, events: Iterable<ParsedAgentEvent>): void {
  for (const event of events) applyAgentEvent(fold, event);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const TERMINAL_SESSION_STATES: ReadonlySet<AgentSessionState> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

/**
 * The item with this id and kind, created (and placed in its turn) when it is
 * new. An id that already names an item of another kind is replaced in place:
 * the later event is the one that knows what the item is.
 */
function upsert<K extends AgentItemView["kind"]>(
  fold: AgentFold,
  event: ParsedAgentEvent,
  itemId: string,
  make: () => Extract<AgentItemView, { kind: K }>,
): Extract<AgentItemView, { kind: K }> {
  const index = fold.itemIndex.get(itemId);
  const fresh = make();
  if (index !== undefined) {
    const current = fold.view.items[index];
    if (current.kind === fresh.kind) return current as Extract<AgentItemView, { kind: K }>;
    const replaced = { ...fresh, ...placement(current) } as Extract<AgentItemView, { kind: K }>;
    fold.view.items[index] = replaced;
    return replaced;
  }
  const turnId = event.turnId ?? fold.openTurnId;
  const placed = { ...fresh } as Extract<AgentItemView, { kind: K }>;
  if (turnId !== undefined) placed.turnId = turnId;
  if (event.agentId !== undefined) placed.agentId = event.agentId;
  fold.itemIndex.set(itemId, fold.view.items.length);
  fold.view.items.push(placed);
  if (turnId !== undefined) {
    const turn = turnOf(fold, turnId);
    if (turn) turn.itemIds.push(itemId);
  }
  return placed;
}

function placement(current: AgentItemView): Partial<ItemBase> {
  const out: Partial<ItemBase> = {};
  if (current.turnId !== undefined) out.turnId = current.turnId;
  if (current.agentId !== undefined) out.agentId = current.agentId;
  return out;
}

function turnOf(fold: AgentFold, turnId: string | undefined): AgentTurnView | undefined {
  if (turnId === undefined) return undefined;
  const index = fold.turnIndex.get(turnId);
  return index === undefined ? undefined : fold.view.turns[index];
}

/** Assign or clear an optional key, so an absent value never lands as `undefined`. */
function set<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

/** Tool calls in `turnId` (or anywhere, when undefined) that are still running end with an unknown outcome. */
function settleRunningTools(fold: AgentFold, turnId: string | undefined): void {
  for (const entry of fold.view.items) {
    if (entry.kind !== "tool" || entry.status !== "running") continue;
    if (turnId !== undefined && entry.turnId !== turnId) continue;
    entry.status = "unknown";
  }
}

/** End a turn: its running tools have unknown outcomes and nothing it asked can still be answered. */
function closeTurn(fold: AgentFold, turn: AgentTurnView, status: AgentTurnStatus): void {
  turn.status = status;
  settleRunningTools(fold, turn.turnId);
  if (fold.openTurnId === turn.turnId) fold.openTurnId = undefined;
  delete fold.view.pendingApprovalId;
  delete fold.view.pendingQuestionId;
}

/** After a turn ends, a session that was working is waiting for the reader again. */
function settleAfterTurn(fold: AgentFold): void {
  const state = fold.view.state;
  if (state === "running" || state === "awaiting_approval" || state === "awaiting_input") {
    fold.view.state = "idle";
  }
}

/** The turn an event names, or the one that is open. */
function targetTurn(fold: AgentFold, event: ParsedAgentEvent): AgentTurnView | undefined {
  return turnOf(fold, event.turnId ?? fold.openTurnId);
}

/** Back to work after a question or an approval if a turn is open, else back to waiting. */
function resume(fold: AgentFold): void {
  const open = turnOf(fold, fold.openTurnId);
  fold.view.state = open && open.status === "running" ? "running" : "idle";
}

// ── The reducer ─────────────────────────────────────────────────────────────

export function applyAgentEvent(fold: AgentFold, event: ParsedAgentEvent): void {
  if (fold.seen.has(event.id)) return;
  fold.seen.add(event.id);
  const view = fold.view;
  view.eventCount += 1;
  if (event.seq > view.lastSeq) view.lastSeq = event.seq;
  if (view.sessionId === undefined) view.sessionId = event.sessionId;

  switch (event.type) {
    case "unknown":
      view.unknownEventCount += 1;
      return;

    // ── Session ──
    case "session.created":
      view.target = event.target;
      set(view, "workspaceName", event.workspaceName ?? view.workspaceName);
      set(view, "repository", event.repository ?? view.repository);
      set(view, "model", event.model ?? view.model);
      set(view, "effort", event.effort ?? view.effort);
      set(view, "mode", event.mode ?? view.mode);
      set(view, "title", event.title ?? view.title);
      return;
    case "session.configured":
      set(view, "model", event.model ?? view.model);
      set(view, "effort", event.effort ?? view.effort);
      set(view, "mode", event.mode ?? view.mode);
      set(view, "title", event.title ?? view.title);
      return;
    case "session.state": {
      view.state = event.state;
      if (TERMINAL_SESSION_STATES.has(event.state)) {
        const open = turnOf(fold, fold.openTurnId);
        if (open && open.status === "running") {
          closeTurn(fold, open, event.state === "completed" ? "completed" : event.state === "failed" ? "failed" : "interrupted");
        }
        settleRunningTools(fold, undefined);
        delete view.pendingApprovalId;
        delete view.pendingQuestionId;
      }
      return;
    }
    case "session.error": {
      view.lastError = { ...event.error };
      upsert(fold, event, `error:${event.id}`, () => ({ kind: "error", itemId: `error:${event.id}`, error: { ...event.error } }));
      return;
    }

    // ── Turns ──
    case "turn.started": {
      const turnId = event.turnId ?? `turn:${event.id}`;
      const previous = turnOf(fold, fold.openTurnId);
      // A turn that never said it ended: we did not see how, so say that.
      if (previous && previous.status === "running" && previous.turnId !== turnId) closeTurn(fold, previous, "interrupted");
      if (!fold.turnIndex.has(turnId)) {
        fold.turnIndex.set(turnId, view.turns.length);
        view.turns.push({ turnId, origin: event.origin, status: "running", itemIds: [] });
      } else {
        const turn = turnOf(fold, turnId)!;
        turn.status = "running";
      }
      fold.openTurnId = turnId;
      view.state = "running";
      return;
    }
    case "turn.completed": {
      const turn = targetTurn(fold, event);
      if (turn) {
        set(turn, "stopReason", event.stopReason);
        set(turn, "durationMs", event.durationMs);
        set(turn, "filesChanged", event.filesChanged);
        set(turn, "summary", event.summary);
        closeTurn(fold, turn, "completed");
      }
      settleAfterTurn(fold);
      return;
    }
    case "turn.failed": {
      view.lastError = { ...event.error };
      const turn = targetTurn(fold, event);
      if (turn) {
        turn.error = { ...event.error };
        closeTurn(fold, turn, "failed");
      }
      settleAfterTurn(fold);
      return;
    }
    case "turn.interrupted": {
      const turn = targetTurn(fold, event);
      if (turn) closeTurn(fold, turn, "interrupted");
      else settleRunningTools(fold, undefined);
      settleAfterTurn(fold);
      return;
    }
    case "transcript.restarted":
      view.turns = [];
      view.items = [];
      fold.itemIndex.clear();
      fold.turnIndex.clear();
      fold.openTurnId = undefined;
      delete view.pendingApprovalId;
      delete view.pendingQuestionId;
      delete view.lastError;
      return;

    // ── Items ──
    case "item.user_message": {
      const entry = upsert(fold, event, event.itemId, () => ({
        kind: "user_message",
        itemId: event.itemId,
        text: "",
        delivery: event.delivery,
      }));
      entry.text = event.text;
      entry.delivery = event.delivery;
      set(entry, "commandId", event.commandId);
      return;
    }
    case "item.assistant_text.delta": {
      const entry = upsert(fold, event, event.itemId, () => ({ kind: "assistant_text", itemId: event.itemId, text: "" }));
      entry.text += event.text;
      return;
    }
    case "item.assistant_text": {
      const entry = upsert(fold, event, event.itemId, () => ({ kind: "assistant_text", itemId: event.itemId, text: "" }));
      entry.text = event.text;
      return;
    }
    case "item.thinking.delta": {
      const entry = upsert(fold, event, event.itemId, () => ({ kind: "thinking", itemId: event.itemId, text: "" }));
      entry.text += event.text;
      return;
    }
    case "item.thinking": {
      const entry = upsert(fold, event, event.itemId, () => ({ kind: "thinking", itemId: event.itemId, text: "" }));
      entry.text = event.summary;
      return;
    }
    case "item.tool_call": {
      const entry = upsertTool(fold, event, event.itemId);
      entry.toolName = event.toolName;
      entry.toolKind = event.toolKind;
      entry.title = event.title;
      set(entry, "inputSummary", event.inputSummary);
      set(entry, "risk", event.risk);
      return;
    }
    case "item.tool_output": {
      const entry = upsertTool(fold, event, event.itemId);
      entry.output = (entry.output ?? "") + event.text;
      entry.outputChannel = event.channel;
      return;
    }
    case "item.tool_result": {
      const entry = upsertTool(fold, event, event.itemId);
      entry.status = event.status;
      set(entry, "summary", event.summary);
      set(entry, "exitCode", event.exitCode);
      set(entry, "durationMs", event.durationMs);
      if (event.output !== undefined) entry.output = event.output;
      return;
    }
    case "item.file_change": {
      const entry = upsert(fold, event, event.itemId, () => ({
        kind: "file_change",
        itemId: event.itemId,
        path: event.path,
        change: event.change,
        linesAdded: 0,
        linesRemoved: 0,
      }));
      entry.path = event.path;
      entry.change = event.change;
      entry.linesAdded = event.linesAdded;
      entry.linesRemoved = event.linesRemoved;
      set(entry, "patch", event.patch);
      set(entry, "checkpointId", event.checkpointId);
      set(entry, "toolItemId", event.toolItemId);
      return;
    }
    case "item.test_run": {
      const entry = upsert(fold, event, event.itemId, () => ({
        kind: "test_run",
        itemId: event.itemId,
        command: event.command,
        passed: event.passed,
      }));
      entry.command = event.command;
      entry.passed = event.passed;
      set(entry, "testsRun", event.testsRun);
      set(entry, "failures", event.failures);
      set(entry, "durationMs", event.durationMs);
      return;
    }
    case "item.subagent": {
      const entry = upsert(fold, event, event.itemId, () => ({
        kind: "subagent",
        itemId: event.itemId,
        title: event.title,
        status: event.status,
      }));
      // The latest snapshot wins whole: a field it no longer carries is gone.
      entry.title = event.title;
      entry.status = event.status;
      set(entry, "role", event.role);
      set(entry, "activity", event.activity);
      set(entry, "summary", event.summary);
      set(entry, "error", event.error);
      set(entry, "toolItemId", event.toolItemId);
      set(entry, "usage", event.usage ? { ...event.usage } : undefined);
      return;
    }
    case "item.compaction": {
      const entry = upsert(fold, event, event.itemId, () => ({ kind: "compaction", itemId: event.itemId, source: event.source }));
      entry.source = event.source;
      set(entry, "beforeMessages", event.beforeMessages);
      set(entry, "afterMessages", event.afterMessages);
      set(entry, "requestedByUser", event.requestedByUser);
      return;
    }
    case "item.notice": {
      const entry = upsert(fold, event, event.itemId, () => ({
        kind: "notice",
        itemId: event.itemId,
        source: event.source,
        text: event.text,
      }));
      entry.source = event.source;
      entry.text = event.text;
      set(entry, "detail", event.detail);
      return;
    }

    // ── Approvals, questions, plans ──
    case "approval.requested": {
      const entry = upsertApproval(fold, event, event.approvalId);
      entry.action = event.action;
      entry.summary = event.summary;
      entry.risk = event.risk;
      set(entry, "toolItemId", event.itemId);
      set(entry, "digest", event.digest);
      set(entry, "expiresAt", event.expiresAt);
      set(entry, "suggestedRule", event.suggestedRule);
      if (entry.decision === undefined) {
        view.pendingApprovalId = event.approvalId;
        view.state = "awaiting_approval";
      }
      return;
    }
    case "approval.resolved": {
      const entry = upsertApproval(fold, event, event.approvalId);
      entry.decision = event.decision;
      entry.by = event.by;
      set(entry, "feedback", event.feedback);
      if (view.pendingApprovalId === event.approvalId) {
        delete view.pendingApprovalId;
        if (view.state === "awaiting_approval") resume(fold);
      }
      return;
    }
    case "question.asked": {
      const entry = upsertQuestion(fold, event, event.questionId);
      entry.prompt = event.prompt;
      set(entry, "options", event.options ? event.options.map((option) => ({ ...option })) : undefined);
      set(entry, "multiSelect", event.multiSelect);
      set(entry, "expiresAt", event.expiresAt);
      if (!entry.answered) {
        view.pendingQuestionId = event.questionId;
        view.state = "awaiting_input";
      }
      return;
    }
    case "question.answered": {
      const entry = upsertQuestion(fold, event, event.questionId);
      entry.answered = true;
      set(entry, "answer", event.answer);
      set(entry, "selected", event.selected ? [...event.selected] : undefined);
      if (view.pendingQuestionId === event.questionId) {
        delete view.pendingQuestionId;
        if (view.state === "awaiting_input") resume(fold);
      }
      return;
    }
    case "plan.updated": {
      const plan: { steps: AgentPlanStep[]; objective?: string } = { steps: event.steps.map((step) => ({ ...step })) };
      if (event.objective !== undefined) plan.objective = event.objective;
      view.plan = plan;
      return;
    }
    case "plan.proposed": {
      const entry = upsert(fold, event, `plan:${event.planId}`, () => ({
        kind: "plan_proposal",
        itemId: `plan:${event.planId}`,
        planId: event.planId,
        text: event.text,
      }));
      entry.text = event.text;
      return;
    }
    case "plan.resolved": {
      const entry = upsert(fold, event, `plan:${event.planId}`, () => ({
        kind: "plan_proposal",
        itemId: `plan:${event.planId}`,
        planId: event.planId,
        text: "",
      }));
      entry.decision = event.decision;
      return;
    }

    // ── Usage and extensions ──
    case "usage.updated": {
      const usage = view.usage;
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
      usage.cacheReadTokens += event.usage.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += event.usage.cacheWriteTokens ?? 0;
      usage.reasoningTokens += event.usage.reasoningTokens ?? 0;
      usage.costMicroUsd += event.usage.costMicroUsd ?? 0;
      if (event.model !== undefined) usage.model = event.model;
      return;
    }
    case "code.pull_request": {
      const pr: AgentPullRequestView = { branch: event.branch };
      if (event.prUrl !== undefined) pr.prUrl = event.prUrl;
      if (event.prNumber !== undefined) pr.prNumber = event.prNumber;
      if (event.reused !== undefined) pr.reused = event.reused;
      view.pullRequest = pr;
      return;
    }
  }
}

function upsertTool(fold: AgentFold, event: ParsedAgentEvent, itemId: string): AgentToolItem {
  return upsert(fold, event, itemId, () => ({
    kind: "tool",
    itemId,
    toolName: "",
    toolKind: "unknown",
    title: "",
    status: "running",
  }));
}

function upsertApproval(fold: AgentFold, event: ParsedAgentEvent, approvalId: string): AgentApprovalItem {
  const itemId = `approval:${approvalId}`;
  return upsert(fold, event, itemId, () => ({
    kind: "approval",
    itemId,
    approvalId,
    action: "",
    summary: "",
    risk: "unknown",
  }));
}

function upsertQuestion(fold: AgentFold, event: ParsedAgentEvent, questionId: string): AgentQuestionItem {
  const itemId = `question:${questionId}`;
  return upsert(fold, event, itemId, () => ({ kind: "question", itemId, questionId, prompt: "", answered: false }));
}

// ── Reading a view ──────────────────────────────────────────────────────────

/** The item with an id, if it is of the kind asked for. */
export function agentItem<K extends AgentItemView["kind"]>(
  view: AgentSessionView,
  itemId: string,
  kind: K,
): Extract<AgentItemView, { kind: K }> | undefined {
  const found = view.items.find((entry) => entry.itemId === itemId);
  return found && found.kind === kind ? (found as Extract<AgentItemView, { kind: K }>) : undefined;
}

/** The approval a reader can answer now, if any. */
export function pendingAgentApproval(view: AgentSessionView): AgentApprovalItem | undefined {
  return view.pendingApprovalId === undefined ? undefined : agentItem(view, `approval:${view.pendingApprovalId}`, "approval");
}

/** The question a reader can answer now, if any. */
export function pendingAgentQuestion(view: AgentSessionView): AgentQuestionItem | undefined {
  return view.pendingQuestionId === undefined ? undefined : agentItem(view, `question:${view.pendingQuestionId}`, "question");
}

/** The view as the JSON the golden `.folded.json` files hold. */
export function agentSessionViewJSON(view: AgentSessionView): unknown {
  return JSON.parse(JSON.stringify(view));
}

// Re-exported for callers that fold and read without importing the generated file.
export type { AgentUsage };
