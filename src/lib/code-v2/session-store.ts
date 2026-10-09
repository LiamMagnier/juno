/**
 * The client-side session log (Code v2 SPEC §3.1): a pure reducer that folds
 * env-server envelopes into a session view, honouring the snapshot + cursor
 * rules in contracts.ts (`classifyEvent`). The web workspace keeps one of
 * these per open thread; the same fold drives fixtures in /dev/code-v2.
 *
 * Nothing here touches React, the network or time, so every rule is a test.
 */
import {
  classifyEvent,
  isTurnItem,
  type EventDisposition,
  type InteractionMode,
  type ModelSelection,
  type QueuedInput,
  type RoleRouting,
  type RuntimeMode,
  type ServerEventEnvelope,
  type SessionSnapshot,
  type ScheduledResume,
  type SessionState,
  type SessionUsage,
  type TurnItem,
  type TurnOutcome,
} from "@/lib/code-v2/contracts";

export interface SessionView {
  id: string;
  cwd: string;
  title?: string;
  selection: ModelSelection;
  routing?: RoleRouting;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  state: SessionState;
  activeTurnId?: string;
  resumeAt?: string;
  stateMessage?: string;
  /** Items in arrival order. */
  order: string[];
  items: Record<string, TurnItem>;
  queue: QueuedInput[];
  usage?: SessionUsage;
  /** Last applied session-stream sequence; null until a snapshot lands. */
  cursor: number | null;
  /** Set when a gap was seen: the client must re-open with afterSequence = cursor. */
  needsResync: boolean;
  /** Outcome of the most recent finished turn, for the Limited / error states. */
  lastOutcome?: TurnOutcome;
  /** A turn the env server will start at a usage window reset (turn.schedule). */
  scheduledResume?: ScheduledResume;
}

export function emptySessionView(id: string, selection: ModelSelection, cwd = ""): SessionView {
  return {
    id,
    cwd,
    selection,
    runtimeMode: "auto-edit",
    interactionMode: "default",
    state: "idle",
    order: [],
    items: {},
    queue: [],
    cursor: null,
    needsResync: false,
  };
}

export function sessionViewFromSnapshot(snapshot: SessionSnapshot, sequence: number): SessionView {
  const items: Record<string, TurnItem> = {};
  const order: string[] = [];
  for (const item of snapshot.items) {
    if (!isTurnItem(item)) continue;
    if (!(item.id in items)) order.push(item.id);
    items[item.id] = item;
  }
  return {
    id: snapshot.id,
    cwd: snapshot.cwd,
    title: snapshot.title,
    selection: snapshot.selection,
    routing: snapshot.routing,
    runtimeMode: snapshot.runtimeMode,
    interactionMode: snapshot.interactionMode,
    state: snapshot.state,
    activeTurnId: snapshot.activeTurnId,
    resumeAt: snapshot.resumeAt,
    order,
    items,
    queue: snapshot.queue,
    usage: snapshot.usage,
    ...(snapshot.scheduledResume ? { scheduledResume: snapshot.scheduledResume } : {}),
    cursor: sequence,
    needsResync: false,
  };
}

/** The items as a list, in arrival order. */
export function sessionItems(view: SessionView): TurnItem[] {
  return view.order.map((id) => view.items[id]).filter(Boolean);
}

function upsert(view: SessionView, item: TurnItem): SessionView {
  if (!isTurnItem(item)) return view;
  const exists = item.id in view.items;
  return {
    ...view,
    items: { ...view.items, [item.id]: item },
    order: exists ? view.order : [...view.order, item.id],
  };
}

function appendDelta(view: SessionView, itemId: string, field: "text" | "output", append: string): SessionView {
  const item = view.items[itemId];
  if (!item) return view;
  const record = item as unknown as Record<string, unknown>;
  const prev = typeof record[field] === "string" ? (record[field] as string) : "";
  if (field === "text" && item.kind !== "assistant_message" && item.kind !== "reasoning" && item.kind !== "plan") return view;
  if (field === "output" && item.kind !== "command_execution") return view;
  return { ...view, items: { ...view.items, [itemId]: { ...item, [field]: prev + append } as TurnItem } };
}

export interface ApplyResult {
  view: SessionView;
  disposition: EventDisposition;
}

/**
 * Apply one session-stream envelope. Duplicates are ignored; a gap marks the
 * view for resync and leaves it otherwise untouched (never apply out of order).
 * Global-stream envelopes are ignored here (providers/terminals have their own
 * stores).
 */
export function applyEnvelope(view: SessionView, envelope: ServerEventEnvelope): ApplyResult {
  if (envelope.stream !== "session") return { view, disposition: "duplicate" };
  if (envelope.sessionId && envelope.sessionId !== view.id && envelope.event.type !== "session.snapshot") {
    return { view, disposition: "duplicate" };
  }
  const disposition = classifyEvent(view.cursor, envelope);
  if (disposition === "duplicate") return { view, disposition };
  if (disposition === "gap") return { view: { ...view, needsResync: true }, disposition };

  const event = envelope.event;
  let next: SessionView = view;
  switch (event.type) {
    case "session.snapshot":
      return { view: sessionViewFromSnapshot(event.session, event.snapshotSequence), disposition };
    case "session.state":
      next = {
        ...view,
        state: event.state,
        resumeAt: event.resumeAt,
        stateMessage: event.message,
      };
      break;
    case "turn.started":
      next = { ...view, activeTurnId: event.turnId, selection: event.selection, state: "running" };
      break;
    case "turn.completed":
      next = {
        ...view,
        activeTurnId: view.activeTurnId === event.turnId ? undefined : view.activeTurnId,
        lastOutcome: event.outcome,
        usage: event.usage ?? view.usage,
        state: event.outcome === "limited" ? "limited" : event.outcome === "failed" ? "error" : view.state === "running" ? "idle" : view.state,
      };
      next = settleStreaming(next, event.turnId);
      break;
    case "item.added":
    case "item.updated":
      next = upsert(view, event.item);
      break;
    case "item.delta":
      next = appendDelta(view, event.itemId, event.field, event.append);
      break;
    case "queue.updated":
      next = { ...view, queue: event.queue };
      break;
    case "usage.updated":
      next = { ...view, usage: event.usage };
      break;
    case "session.scheduled":
      next = { ...view, scheduledResume: event.scheduledResume };
      break;
    default:
      break;
  }
  return { view: { ...next, cursor: envelope.sequence, needsResync: false }, disposition };
}

/** A finished turn leaves no item marked as streaming. */
function settleStreaming(view: SessionView, turnId: string): SessionView {
  let changed = false;
  const items = { ...view.items };
  for (const id of view.order) {
    const item = items[id];
    if ((item.kind === "assistant_message" || item.kind === "reasoning") && item.streaming && (!item.turnId || item.turnId === turnId)) {
      items[id] = { ...item, streaming: false };
      changed = true;
    }
  }
  return changed ? { ...view, items } : view;
}

/** Apply a batch, stopping at the first gap (the rest would also be gaps). */
export function applyEnvelopes(view: SessionView, envelopes: readonly ServerEventEnvelope[]): ApplyResult {
  let current = view;
  let last: EventDisposition = "duplicate";
  for (const envelope of envelopes) {
    const result = applyEnvelope(current, envelope);
    current = result.view;
    last = result.disposition;
    if (last === "gap") break;
  }
  return { view: current, disposition: last };
}

/**
 * Merge consecutive `item.delta` envelopes for the same item and field into
 * one (keeping the last sequence's predecessor chain intact is not needed:
 * the merged envelope carries the LAST sequence and the client applies the
 * first one's position). Used to coalesce a burst into one render (≤ 50 ms).
 *
 * The merge is only valid for a run of consecutive sequences, which is what a
 * single read off the socket delivers; anything else is passed through.
 */
export function coalesceDeltas(envelopes: readonly ServerEventEnvelope[]): ServerEventEnvelope[] {
  const out: ServerEventEnvelope[] = [];
  for (const env of envelopes) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.stream === "session" &&
      env.stream === "session" &&
      prev.sessionId === env.sessionId &&
      prev.event.type === "item.delta" &&
      env.event.type === "item.delta" &&
      prev.event.itemId === env.event.itemId &&
      prev.event.field === env.event.field &&
      env.sequence === ((prev as ServerEventEnvelope & { coalescedThrough?: number }).coalescedThrough ?? prev.sequence) + 1
    ) {
      // Keep the FIRST sequence so classifyEvent still sees cursor + 1, then
      // fast-forward the cursor by the merged count via `coalescedThrough`.
      out[out.length - 1] = {
        ...prev,
        event: { ...prev.event, append: prev.event.append + env.event.append },
        coalescedThrough: env.sequence,
      } as ServerEventEnvelope & { coalescedThrough: number };
      continue;
    }
    out.push(env);
  }
  return out;
}

/** Apply a coalesced batch: a merged delta advances the cursor to its last sequence. */
export function applyCoalesced(view: SessionView, envelopes: readonly ServerEventEnvelope[]): ApplyResult {
  let current = view;
  let last: EventDisposition = "duplicate";
  for (const envelope of coalesceDeltas(envelopes)) {
    const result = applyEnvelope(current, envelope);
    current = result.view;
    last = result.disposition;
    const through = (envelope as ServerEventEnvelope & { coalescedThrough?: number }).coalescedThrough;
    if (last === "apply" && typeof through === "number") current = { ...current, cursor: through };
    if (last === "gap") break;
  }
  return { view: current, disposition: last };
}

/** Pending approvals and questions in arrival order (the composer takeover reads these). */
export function pendingRequests(view: SessionView): TurnItem[] {
  return sessionItems(view).filter(
    (i) => (i.kind === "approval_request" && i.status === "pending") || (i.kind === "user_input_request" && i.status === "pending"),
  );
}
