/**
 * The screenshot timeline for computer use (SPEC §3.12), as pure functions.
 *
 * Every computer action — from the Mac's own sessions or from a subscription
 * agent driving the Mac through the Alevr MCP server — lands in the thread as
 * a `computer_action` turn item carrying a screenshot reference. This module
 * folds those items into frames the `ComputerTimeline` component draws: a
 * stage (the screenshot at the scrubber, with a ring where the action landed),
 * a scrubber, and a thumbnail strip with captions.
 *
 * Pure so it is tested without a DOM (tests/computer-timeline.test.ts).
 */
import type { ComputerActionItem, ComputerActionKind, TurnItem } from "./contracts";

export interface TimelineFrame {
  /** The item id; stable across `item.updated`. */
  id: string;
  callId: string;
  /** Position in the timeline, 0-based. */
  index: number;
  action: ComputerActionKind;
  /** The sentence under the stage. */
  caption: string;
  /** A short label for the thumbnail ("Click", "Type"). */
  verb: string;
  app?: string;
  /** Resolved image URL for the screenshot, or null when this step has none. */
  src: string | null;
  /** Where the action landed, fractions of the screenshot. */
  point: { x: number; y: number } | null;
  status: ComputerActionItem["status"];
  /** Failed, declined or interrupted. */
  failed: boolean;
  /** Still running: the one place the coral accent is allowed. */
  live: boolean;
  createdAt: string;
  error?: string;
}

const VERBS: Record<ComputerActionKind, { verb: string; past: string; progressive: string }> = {
  screenshot: { verb: "Look", past: "Looked at", progressive: "Looking at" },
  click: { verb: "Click", past: "Clicked", progressive: "Clicking" },
  double_click: { verb: "Double-click", past: "Double-clicked", progressive: "Double-clicking" },
  right_click: { verb: "Right-click", past: "Right-clicked", progressive: "Right-clicking" },
  move: { verb: "Point", past: "Pointed at", progressive: "Pointing at" },
  drag: { verb: "Drag", past: "Dragged", progressive: "Dragging" },
  scroll: { verb: "Scroll", past: "Scrolled", progressive: "Scrolling" },
  type: { verb: "Type", past: "Typed in", progressive: "Typing in" },
  key: { verb: "Keys", past: "Pressed", progressive: "Pressing" },
  wait: { verb: "Wait", past: "Waited", progressive: "Waiting" },
  open_app: { verb: "Open", past: "Opened", progressive: "Opening" },
  zoom: { verb: "Zoom", past: "Zoomed into", progressive: "Zooming into" },
  ax_find: { verb: "Find", past: "Read the controls of", progressive: "Reading the controls of" },
  ax_press: { verb: "Press", past: "Pressed", progressive: "Pressing" },
  menu: { verb: "Menu", past: "Chose", progressive: "Choosing" },
};

/** Short verb for a thumbnail. Unknown actions (a newer server) read as "Step". */
export function actionVerb(action: string): string {
  return (VERBS as Record<string, { verb: string }>)[action]?.verb ?? "Step";
}

const FAILED: ReadonlySet<ComputerActionItem["status"]> = new Set(["failed", "declined", "interrupted"]);

/**
 * The caption: the item's own summary when the executor wrote one, otherwise
 * "<verb> <target> in <app>" from the parts, in the tense the status implies.
 */
export function actionCaption(item: ComputerActionItem): string {
  const summary = item.summary?.trim();
  if (summary && item.status !== "running" && item.status !== "pending") return summary;
  const words = (VERBS as Record<string, (typeof VERBS)["click"]>)[item.action];
  const running = item.status === "running" || item.status === "pending";
  const verb = words ? (running ? words.progressive : words.past) : "Used";
  const target = item.target?.trim();
  const app = item.app?.trim();
  let sentence = verb;
  if (target) sentence += ` ${target}`;
  if (app && !(target && target.includes(app))) sentence += target ? ` in ${app}` : ` ${app}`;
  if (!target && !app) sentence += item.action === "wait" ? "" : " the screen";
  if (FAILED.has(item.status)) {
    const why = item.error?.trim();
    const lead = item.status === "declined" ? "Not allowed" : item.status === "interrupted" ? "Stopped" : "Failed";
    return why ? `${lead}: ${why}` : `${lead} — ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
  }
  return running ? `${sentence}…` : `${sentence}.`;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Folds turn items into timeline frames. Later versions of the same item id
 * (an `item.updated` appended after `item.added`) replace earlier ones in
 * place, so a step keeps its slot as it goes from running to completed. Order
 * is the order items were first seen — the thread's order.
 */
export function buildComputerTimeline(
  items: readonly (TurnItem | ComputerActionItem)[],
  resolveScreenshot: (ref: string) => string | null = defaultScreenshotResolver,
): TimelineFrame[] {
  const order: string[] = [];
  const latest = new Map<string, ComputerActionItem>();
  for (const item of items) {
    if (!item || item.kind !== "computer_action") continue;
    if (!latest.has(item.id)) order.push(item.id);
    latest.set(item.id, item);
  }
  return order.map((id, index) => {
    const item = latest.get(id)!;
    const point =
      item.point && Number.isFinite(item.point.x) && Number.isFinite(item.point.y)
        ? { x: clamp01(item.point.x), y: clamp01(item.point.y) }
        : null;
    return {
      id,
      callId: item.callId,
      index,
      action: item.action,
      caption: actionCaption(item),
      verb: actionVerb(item.action),
      app: item.app,
      src: item.screenshotRef ? resolveScreenshot(item.screenshotRef) : null,
      point,
      status: item.status,
      failed: FAILED.has(item.status),
      live: item.status === "running" || item.status === "pending",
      createdAt: item.createdAt,
      error: item.error,
    };
  });
}

/**
 * Screenshot refs the web can show directly: data URLs, https URLs and
 * same-origin paths. `alevr-shot://<session>/<file>` refs live on the Mac and
 * reach the web through the env server's screenshot route.
 */
export function defaultScreenshotResolver(ref: string): string | null {
  if (ref.startsWith("data:image/") || ref.startsWith("https://") || ref.startsWith("/")) return ref;
  const shot = /^alevr-shot:\/\/([^/]+)\/(.+)$/.exec(ref);
  if (shot) return `/api/code/screenshots/${encodeURIComponent(shot[1])}/${encodeURIComponent(shot[2])}`;
  return null;
}

/**
 * The screenshot the stage shows at `index`: that step's own, or the latest
 * earlier one (a key press has no new frame of its own on some routes). -1
 * when nothing at or before it has a screenshot.
 */
export function stageFrameIndex(frames: readonly TimelineFrame[], index: number): number {
  for (let i = Math.min(index, frames.length - 1); i >= 0; i--) if (frames[i].src) return i;
  return -1;
}

/** Scrubber ratio (0…1) → frame index. */
export function indexFromRatio(ratio: number, count: number): number {
  if (count <= 0) return -1;
  if (!Number.isFinite(ratio)) return count - 1;
  return Math.round(clamp01(ratio) * (count - 1));
}

/** Frame index → scrubber ratio (0…1); a single frame sits at the end. */
export function ratioFromIndex(index: number, count: number): number {
  if (count <= 1) return 1;
  return clamp01(index / (count - 1));
}

/**
 * Whether the stage should follow the newest step. It does while the reader
 * has not scrubbed back, i.e. while the selection is the last frame (or none).
 */
export function followsLive(selected: number | null, count: number): boolean {
  return selected === null || selected >= count - 1;
}

/** Next selection after an arrow key, clamped to the timeline. */
export function stepSelection(selected: number | null, count: number, delta: -1 | 1): number {
  if (count === 0) return -1;
  const from = selected ?? count - 1;
  return Math.min(count - 1, Math.max(0, from + delta));
}

/** "12 steps in Pages and Safari" — the collapsed header line. */
export function timelineSummary(frames: readonly TimelineFrame[]): string {
  if (frames.length === 0) return "No steps yet";
  const apps: string[] = [];
  for (const f of frames) if (f.app && !apps.includes(f.app)) apps.push(f.app);
  const steps = `${frames.length} ${frames.length === 1 ? "step" : "steps"}`;
  if (apps.length === 0) return steps;
  const list =
    apps.length === 1
      ? apps[0]
      : apps.length === 2
        ? `${apps[0]} and ${apps[1]}`
        : `${apps.slice(0, 2).join(", ")} and ${apps.length - 2} more`;
  return `${steps} in ${list}`;
}

/** CSS position of the target ring over the stage image, or null. */
export function ringPosition(frame: TimelineFrame | undefined): { left: string; top: string } | null {
  if (!frame?.point) return null;
  return { left: `${(frame.point.x * 100).toFixed(2)}%`, top: `${(frame.point.y * 100).toFixed(2)}%` };
}
