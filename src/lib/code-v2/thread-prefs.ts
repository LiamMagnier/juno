/**
 * A web Code thread's composer choices and draft, on the shared thread-sync
 * row (docs/code-v2/REMOTE-CONTROL.md §Sync, src/lib/sync/thread-sync.ts).
 *
 * The web workspace kept its model and mode in one browser's localStorage and
 * never kept the draft at all, while Chat synced drafts and the Mac app
 * synced `ThreadSyncPrefs`. This is the translation both ways, in the strings
 * the Mac writes (`CodeV2SyncedPrefs` in CodeV2ThreadContinuity.swift): the
 * model as `<instanceId>/<model>`, the effort, the runtime and interaction
 * modes, the team preset and the skill names. A value this browser cannot
 * read is ignored rather than applied, as the Mac does.
 *
 * Pure; the route and the composer drive it.
 */
import {
  EFFORT_LEVEL_VALUES,
  INTERACTION_MODE_VALUES,
  RUNTIME_MODE_VALUES,
  type EffortLevel,
  type InteractionMode,
  type ModelSelection,
  type RoleRouting,
  type RuntimeMode,
} from "./contracts";
import { chatThreadKey, codeThreadKey, type ThreadPrefs } from "@/lib/sync/thread-sync";

/** `<instanceId>/<model>`, the Mac's spelling. */
export function syncedModelKey(selection: Pick<ModelSelection, "instanceId" | "model">): string {
  return `${selection.instanceId}/${selection.model}`;
}

/** Splits `<instanceId>/<model>` at its first slash (model ids may hold more). */
export function parseSyncedModelKey(key: string | undefined): { instanceId: string; model: string } | null {
  if (!key) return null;
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { instanceId: key.slice(0, slash), model: key.slice(slash + 1) };
}

export interface WebThreadChoices {
  selection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  routing?: Pick<RoleRouting, "preset">;
}

/** What this thread's composer shows, as the sync row stores it. */
export function syncedPrefsOf(choices: WebThreadChoices): ThreadPrefs {
  return {
    ...(choices.selection.model ? { model: syncedModelKey(choices.selection) } : {}),
    ...(choices.selection.effort ? { effort: choices.selection.effort } : {}),
    mode: choices.runtimeMode,
    interactionMode: choices.interactionMode,
    ...(choices.routing?.preset ? { team: choices.routing.preset } : {}),
  };
}

const isOneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === "string" && (values as readonly string[]).includes(v);

/**
 * The choices another device wrote, as changes to make here: only the fields
 * that differ and that this browser can read. Empty when nothing applies.
 */
export function choicesFromSynced(
  prefs: ThreadPrefs | null | undefined,
  current: WebThreadChoices,
): { selection?: ModelSelection; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode } {
  if (!prefs) return {};
  const out: { selection?: ModelSelection; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode } = {};
  const parsed = parseSyncedModelKey(prefs.model);
  const effort: EffortLevel | undefined = isOneOf(EFFORT_LEVEL_VALUES, prefs.effort) ? prefs.effort : undefined;
  if (parsed && (parsed.instanceId !== current.selection.instanceId || parsed.model !== current.selection.model)) {
    // Another model: its own effort, never this one's tier or speed.
    out.selection = { instanceId: parsed.instanceId, model: parsed.model, ...(effort ? { effort } : {}) };
  } else if (effort && effort !== current.selection.effort) {
    out.selection = { ...current.selection, effort };
  }
  if (isOneOf(RUNTIME_MODE_VALUES, prefs.mode) && prefs.mode !== current.runtimeMode) out.runtimeMode = prefs.mode;
  if (isOneOf(INTERACTION_MODE_VALUES, prefs.interactionMode) && prefs.interactionMode !== current.interactionMode) out.interactionMode = prefs.interactionMode;
  return out;
}

/** Whether two prefs say the same thing (to skip writing an unchanged row). */
export function samePrefs(a: ThreadPrefs | null | undefined, b: ThreadPrefs | null | undefined): boolean {
  const keys = ["model", "effort", "mode", "interactionMode", "team"] as const;
  return keys.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
}

/**
 * The thread's sync key. A thread running on a Mac's env server uses the key
 * the Mac app writes for the same session (`code:<device>:<session>`), so the
 * draft and choices follow the reader between the browser and the Mac; any
 * other web Code thread (a cloud run, a Mac without the env server, a thread
 * whose session has not opened yet) is keyed by its conversation.
 */
export function webCodeThreadKey(input: { conversationId: string; deviceId?: string | null; envSessionId?: string | null }): string {
  if (input.deviceId && input.envSessionId) return codeThreadKey(input.deviceId, input.envSessionId);
  return chatThreadKey(input.conversationId);
}

/** The local (this tab) draft key for a thread, or the landing's. */
export function codeDraftKey(conversationId: string | null): string {
  return `code:${conversationId ?? "new"}`;
}
