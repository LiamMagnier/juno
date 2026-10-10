/**
 * The composer's mode: one control for how much the agent may do on its own.
 *
 * The contract keeps two settings per turn, a runtime mode (the sandbox and
 * approval preset, SPEC §3.7) and an interaction mode (plan first or not). A
 * reader thinks of one ladder instead, the one every coding agent offers:
 * Ask, Accept edits, Auto, Plan, Full access. This maps that ladder onto the
 * pair, both ways, so the web composer and the Mac and iOS composers (which
 * mirror this table in Swift) say the same five things.
 *
 * Plan keeps the runtime mode it had: plan mode is read-only by itself, and
 * the run that follows an approved plan builds with the mode it had before.
 * Read only is not offered (Plan covers it), but a thread that is already on
 * it still says so.
 */
import type { InteractionMode, RuntimeMode } from "./contracts";

export type ComposerMode = "ask" | "accept-edits" | "auto" | "plan" | "full" | "read-only";

export interface ComposerModeInfo {
  mode: ComposerMode;
  label: string;
  /** One line, shown under the label in the menu. */
  description: string;
  /** A name from the shared icon set. */
  glyph: string;
}

export const COMPOSER_MODES: readonly ComposerModeInfo[] = [
  { mode: "ask", label: "Ask", description: "Asks before every edit and command.", glyph: "hand" },
  { mode: "accept-edits", label: "Accept edits", description: "Edits files without asking. Asks before commands.", glyph: "edit" },
  { mode: "auto", label: "Auto", description: "A reviewer model approves routine steps. Asks for the rest.", glyph: "shield" },
  { mode: "plan", label: "Plan", description: "Reads and writes a plan. Changes nothing until you approve.", glyph: "plan" },
  { mode: "full", label: "Full access", description: "Never asks inside the project. Still asks for sudo, other machines and anything outside the folder.", glyph: "unlock" },
];

const READ_ONLY: ComposerModeInfo = { mode: "read-only", label: "Read only", description: "Reads the project. Changes nothing.", glyph: "eye" };

export function composerModeInfo(mode: ComposerMode): ComposerModeInfo {
  return COMPOSER_MODES.find((m) => m.mode === mode) ?? READ_ONLY;
}

/** The ladder rung a thread's two settings add up to. */
export function composerModeOf(runtimeMode: RuntimeMode, interactionMode: InteractionMode): ComposerMode {
  if (interactionMode === "plan") return "plan";
  switch (runtimeMode) {
    case "ask":
      return "ask";
    case "auto-edit":
      return "accept-edits";
    case "auto":
      return "auto";
    case "full":
      return "full";
    case "read-only":
      return "read-only";
  }
}

/** The pair a rung sets. Plan keeps `current` unless it is read-only. */
export function applyComposerMode(mode: ComposerMode, current: RuntimeMode): { runtimeMode: RuntimeMode; interactionMode: InteractionMode } {
  switch (mode) {
    case "plan":
      return { runtimeMode: current === "read-only" ? "auto-edit" : current, interactionMode: "plan" };
    case "ask":
      return { runtimeMode: "ask", interactionMode: "default" };
    case "accept-edits":
      return { runtimeMode: "auto-edit", interactionMode: "default" };
    case "auto":
      return { runtimeMode: "auto", interactionMode: "default" };
    case "full":
      return { runtimeMode: "full", interactionMode: "default" };
    case "read-only":
      return { runtimeMode: "read-only", interactionMode: "default" };
  }
}

/**
 * The rungs an instance can honour. `approvals` is the runtime modes it can
 * enforce (empty means all); `planMode` whether it can plan first.
 */
export function availableComposerModes(approvals?: readonly RuntimeMode[], planMode = true): ComposerModeInfo[] {
  return COMPOSER_MODES.filter((m) => {
    if (m.mode === "plan") return planMode;
    const runtime = applyComposerMode(m.mode, "auto-edit").runtimeMode;
    return !approvals?.length || approvals.includes(runtime);
  });
}

/** ⇧⌘A: the next rung the instance offers, wrapping. */
export function cycleComposerMode(mode: ComposerMode, approvals?: readonly RuntimeMode[], planMode = true): ComposerMode {
  const list = availableComposerModes(approvals, planMode).map((m) => m.mode);
  if (!list.length) return mode;
  const i = list.indexOf(mode);
  return list[(i + 1) % list.length];
}

/** The last mode a reader chose in a project, the default for its next thread. */
export interface ProjectModeDefault {
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
}

/** Storage key for a project's last mode. Null when the thread names no project. */
export function projectModeKey(project: string | null | undefined): string | null {
  const name = project?.trim();
  return name ? `alevr.code.mode.project.${name}` : null;
}

/**
 * A thread's starting pair: its own choice when it has one, else the
 * project's last, else Accept edits.
 */
export function initialModePair(
  own: { runtimeMode?: RuntimeMode; interactionMode?: InteractionMode },
  project: Partial<ProjectModeDefault> | null,
): ProjectModeDefault {
  if (own.runtimeMode) return { runtimeMode: own.runtimeMode, interactionMode: own.interactionMode ?? "default" };
  return { runtimeMode: project?.runtimeMode ?? "auto-edit", interactionMode: project?.interactionMode ?? "default" };
}

/** What applying a rung needs from a thread's actions. */
export interface ModeSetters {
  setRuntimeMode(mode: RuntimeMode): void;
  setInteractionMode(mode: InteractionMode): void;
  setModes?(pair: ProjectModeDefault): void;
}

/** Applies a rung through one write when the thread offers it. */
export function setComposerMode(actions: ModeSetters, mode: ComposerMode, current: RuntimeMode): ProjectModeDefault {
  const pair = applyComposerMode(mode, current);
  if (actions.setModes) actions.setModes(pair);
  else {
    actions.setRuntimeMode(pair.runtimeMode);
    actions.setInteractionMode(pair.interactionMode);
  }
  return pair;
}

// ── The /code landing ───────────────────────────────────────────────────────

/** What a cloud run's sandbox can enforce (`CodeTask.permissionMode`): Plan, Accept edits, Full access. */
export const CLOUD_RUNTIME_APPROVALS: readonly RuntimeMode[] = ["auto-edit", "full"];

/** The cloud task's `permissionMode` for a rung, or null when a cloud run cannot honour it. */
export function cloudPermissionMode(mode: ComposerMode): "plan" | "auto-edit" | "full" | null {
  switch (mode) {
    case "plan":
      return "plan";
    case "accept-edits":
      return "auto-edit";
    case "full":
      return "full";
    default:
      return null;
  }
}

/** The landing's starting rung: the project's last, else the target's own default (cloud runs have always had Full access). */
export function landingMode(target: "device" | "cloud", project: Partial<ProjectModeDefault> | null): ComposerMode {
  const fallback: ComposerMode = target === "cloud" ? "full" : "accept-edits";
  if (!project?.runtimeMode) return fallback;
  const mode = composerModeOf(project.runtimeMode, project.interactionMode ?? "default");
  if (target === "cloud" && !cloudPermissionMode(mode)) return fallback;
  return mode;
}

/** The per-thread prefs key the v2 route reads (`alevr.code.prefs.<id>`). */
export function threadPrefsKey(conversationId: string): string {
  return `alevr.code.prefs.${conversationId}`;
}

/** The v2 route's prefs for a new thread, with the landing's mode in them. */
export function seededThreadPrefs(existing: Record<string, unknown> | null, mode: ComposerMode): Record<string, unknown> {
  const pair = applyComposerMode(mode, "auto-edit");
  return { ...(existing ?? {}), runtimeMode: pair.runtimeMode, interactionMode: pair.interactionMode };
}
