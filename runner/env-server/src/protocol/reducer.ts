/**
 * Pure fold of session events into a SessionSnapshot. The server keeps its
 * snapshot with it, and any client may use the same function to apply the
 * events it receives after a snapshot (SPEC §3.1).
 */
import type {
  ServerEvent,
  SessionSnapshot,
  TurnItem,
  SessionState,
} from "../contracts/code-v2.js";

export function applySessionEvent(snapshot: SessionSnapshot, event: ServerEvent): SessionSnapshot {
  switch (event.type) {
    case "session.snapshot":
      return structuredClone(event.session);
    case "session.state": {
      const next: SessionSnapshot = { ...snapshot, state: event.state };
      if (event.resumeAt) next.resumeAt = event.resumeAt;
      else delete next.resumeAt;
      return next;
    }
    case "turn.started": {
      const next: SessionSnapshot = { ...snapshot, state: "running", activeTurnId: event.turnId, selection: event.selection };
      delete next.resumeAt;
      return next;
    }
    case "turn.completed": {
      const next: SessionSnapshot = { ...snapshot, state: stateAfter(event.outcome, snapshot.state) };
      delete next.activeTurnId;
      if (event.usage) next.usage = event.usage;
      return next;
    }
    case "item.added":
    case "item.updated":
      return { ...snapshot, items: upsertItem(snapshot.items, event.item) };
    case "item.delta": {
      const index = snapshot.items.findIndex((item) => item.id === event.itemId);
      if (index < 0) return snapshot;
      const items = snapshot.items.slice();
      const item = { ...items[index] } as TurnItem & { text?: string; output?: string };
      const key = event.field;
      item[key] = `${item[key] ?? ""}${event.append}`;
      items[index] = item;
      return { ...snapshot, items };
    }
    case "queue.updated":
      return { ...snapshot, queue: event.queue };
    case "usage.updated":
      return { ...snapshot, usage: event.usage };
    default:
      return snapshot;
  }
}

function stateAfter(outcome: "completed" | "interrupted" | "failed" | "limited", _current: SessionState): SessionState {
  switch (outcome) {
    case "limited":
      return "limited";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

function upsertItem(items: TurnItem[], item: TurnItem): TurnItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}
