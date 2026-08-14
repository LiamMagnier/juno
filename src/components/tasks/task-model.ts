/**
 * Client-side types + display helpers for scheduled tasks. Mirrors the shape
 * serializeTask (src/lib/scheduled-tasks.ts) sends over /api/tasks — kept
 * separate so the page never imports the server lib (llm/prisma chain).
 */

export type TaskCadence = "DAILY" | "WEEKDAYS" | "WEEKLY" | "MONTHLY" | "ONCE";

export interface TaskRunSummary {
  id: string;
  status: string; // running | done | error | budget
  error: string | null;
  costMicroUsd: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface TaskItem {
  id: string;
  name: string;
  prompt: string;
  model: string;
  modelName: string;
  cadence: TaskCadence;
  hour: number;
  minute: number;
  weekday: number | null;
  monthday: number | null;
  onDate: string | null;
  timezone: string;
  webSearch: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  conversationId: string | null;
  createdAt: string;
  latestRun: TaskRunSummary | null;
}

export const DEFAULT_TASK_TIMEZONE = "Europe/Paris";

// "Once" leads: the picker reads one-shot → recurring, left to right.
export const CADENCES: { id: TaskCadence; label: string }[] = [
  { id: "ONCE", label: "Once" },
  { id: "DAILY", label: "Daily" },
  { id: "WEEKDAYS", label: "Weekdays" },
  { id: "WEEKLY", label: "Weekly" },
  { id: "MONTHLY", label: "Monthly" },
];

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}

const pad = (n: number) => String(n).padStart(2, "0");

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Aug 20" (year only when it isn't this year's). Parsed from the raw
 * "YYYY-MM-DD" parts — a Date round-trip would shift the day near midnight in
 * browsers west of the task's timezone.
 */
function onceDateLabel(onDate: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(onDate ?? "");
  if (!m) return "—";
  const monthDay = `${MONTH_LABELS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
  return Number(m[1]) === new Date().getFullYear() ? monthDay : `${monthDay} ${m[1]}`;
}

/** "Daily · 08:00", "Weekly · Mon 09:00", "Once · Aug 20 09:00" (+ non-default tz). */
export function describeSchedule(
  t: Pick<TaskItem, "cadence" | "hour" | "minute" | "weekday" | "monthday" | "onDate" | "timezone">
): string {
  const time = `${pad(t.hour)}:${pad(t.minute)}`;
  let label: string;
  switch (t.cadence) {
    case "ONCE":
      label = `Once · ${onceDateLabel(t.onDate)} ${time}`;
      break;
    case "WEEKDAYS":
      label = `Weekdays · ${time}`;
      break;
    case "WEEKLY":
      label = `Weekly · ${WEEKDAY_LABELS[t.weekday ?? 1]} ${time}`;
      break;
    case "MONTHLY":
      label = `Monthly · ${ordinal(t.monthday ?? 1)} ${time}`;
      break;
    default:
      label = `Daily · ${time}`;
  }
  return t.timezone !== DEFAULT_TASK_TIMEZONE ? `${label} (${t.timezone})` : label;
}

/**
 * A one-off that already fired: not paused — done. Drives the card's quiet
 * completed treatment and hides the resume switch (there is no future instant
 * to resume to; rescheduling goes through the edit dialog).
 */
export function isCompletedOnce(t: Pick<TaskItem, "cadence" | "enabled" | "latestRun">): boolean {
  return t.cadence === "ONCE" && !t.enabled && !!t.latestRun && t.latestRun.status !== "running";
}
