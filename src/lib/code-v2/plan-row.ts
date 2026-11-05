/**
 * The plan row above the Code composer: the agent's newest todo list, pinned
 * where the person is looking (Codex's plan row, Claude Code's todo panel).
 *
 * Pure, so the rules are testable without a DOM: the newest `todo_list` item
 * of the main thread wins; the row shows while the session works, and after
 * it stops only while steps are left undone (a finished plan folds away; it
 * stays readable in the work log).
 */
import type { SessionState, TodoListItem, TurnItem } from "./contracts";

export interface PlanRowModel {
  steps: { text: string; status: "pending" | "in_progress" | "completed" }[];
  done: number;
  total: number;
  /** The step in progress, else the first not done, else null. */
  current: string | null;
  /** Every step is completed. */
  finished: boolean;
}

export function planRowModel(items: readonly TurnItem[], state: SessionState): PlanRowModel | null {
  let latest: TodoListItem | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    // A child agent's list belongs to its own pane, not the coordinator's row.
    if (item.kind === "todo_list" && !item.agentId) {
      latest = item;
      break;
    }
  }
  if (!latest || latest.todos.length === 0) return null;
  const steps = latest.todos.map((t) => ({ text: t.text, status: t.status }));
  const done = steps.filter((s) => s.status === "completed").length;
  const finished = done === steps.length;
  const active = state === "running" || state === "waiting";
  if (finished && !active) return null;
  const current = steps.find((s) => s.status === "in_progress")?.text ?? steps.find((s) => s.status !== "completed")?.text ?? null;
  return { steps, done, total: steps.length, current, finished };
}
