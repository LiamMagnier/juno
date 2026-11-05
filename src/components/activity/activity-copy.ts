import type { ActivityKind, ActivityNeed, ActivityState } from "@/lib/activity/model";

/*
 * Every word the Activity page says, as literals the i18n extractor harvests
 * (`*_COPY`), so the French catalog carries them. The state words are the shared
 * status vocabulary (docs/design/UI_UX_MOTION_SPEC_2026-10.md §3.4): Needs you,
 * Running, Ready, Blocked, the same on every surface and every platform.
 */
export const ACTIVITY_COPY = {
  heading: "Activity",
  lede: "What is running across chats, Code and research, and what is waiting on you.",
  filterLabel: "Show",
  all: "All",
  states: {
    needs_you: "Needs you",
    running: "Running",
    ready: "Ready",
    blocked: "Blocked",
  } satisfies Record<ActivityState, string>,
  hints: {
    needs_you: "Stopped until you answer.",
    running: "Under way, or waiting for a machine.",
    ready: "Finished in the last day.",
    blocked: "Ended on an error in the last day.",
  } satisfies Record<ActivityState, string>,
  kinds: {
    work: "Task",
    code: "Code",
    research: "Research",
  } satisfies Record<ActivityKind, string>,
  needs: {
    approval: "Needs your approval",
    question: "Has a question for you",
    plan: "Plan to confirm",
    host: "Waiting for your Mac",
    decision: "Waiting on you",
    review: "Ready to review",
  } satisfies Record<ActivityNeed, string>,
  verbs: {
    approval: "Review",
    question: "Answer",
    plan: "Review plan",
    host: "Open",
    decision: "Open",
    review: "Open",
  } satisfies Record<ActivityNeed, string>,
  open: "Open",
  stop: "Stop",
  stopping: "Stopping",
  stopFailed: "Couldn’t stop it. Try again from its own page.",
  runningFor: "Running for",
  waitingFor: "Waiting for",
  ago: "ago",
  showMore: "Show more",
  emptyTitle: "Nothing is running",
  emptyDescription: "Tasks, Code sessions and research you start show up here while they work, and stay for a day after they finish.",
  emptyAction: "Start a chat",
  filteredEmpty: "Nothing in this group right now.",
  loadError: "Couldn’t load your activity",
  loading: "Loading your activity",
  keyboardHint: "Use the arrow keys to move between items.",
} as const;
