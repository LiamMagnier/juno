"use client";

import * as React from "react";
import { toast } from "sonner";
import { DEFAULT_WORK_PERMISSION_POLICY, type WorkPermissionPolicy } from "@/lib/work/domain";
import { AUTO_MODEL_ID } from "@/lib/work/models";
import type { ClientWorkSession } from "@/lib/work/serializers";
import {
  WORK_CONTEXT_FIELDS,
  WORK_SYNC_EVENT,
  fetchWorkSessionContext,
  updateWorkSessionContext,
  type WorkBlocked,
  type WorkContextChange,
  type WorkContextField,
  type WorkSessionContext,
  type WorkSessionContextInput,
  type WorkTransportFailure,
} from "@/components/work/work-transport";

/*
 * What a task is working with, and what changing it mid-task actually does.
 *
 * Every control on the thread composer reads and writes through here. It exists
 * to hold three things that are easy to get wrong separately and impossible to
 * keep consistent if they live in three components:
 *
 *   1. **The honest timing rule.** An active run's inputs were fixed at
 *      dispatch: `WorkRunIO` rows are written once from the session's file
 *      grants, the connector set resolves when the run starts, and the model,
 *      effort and permission policy bind when the agent loop is constructed. So
 *      a change made during a task takes effect on the NEXT attempt unless the
 *      server says otherwise, and `note` below is that sentence, per field, in
 *      the server's own words wherever it wrote them. Nothing here ever says a
 *      change landed on a running attempt on its own authority.
 *
 *   2. **A refused change leaves no trace.** The optimistic value is snapshotted
 *      before the request and restored exactly on any non-ok result. A control
 *      left asserting a state the server rejected is worse than one that never
 *      moved, because the reader has no way to tell the difference.
 *
 *   3. **Not knowing is a state, not a zero.** Apps, files and the skill have no
 *      column on `ClientWorkSession` — they are grant rows — so until a read
 *      lands this client genuinely does not know what the task holds.
 *      `reachKnown` carries that, and the menu draws its unknown state rather
 *      than switches that would read as "this task reaches nothing".
 *
 * The session prop is authoritative but LATE: the thread re-renders roughly once
 * a second off the event stream, so for the second between a request landing and
 * the stream catching up it still carries the old value. Local values therefore
 * outrank it and are dropped only once it agrees — see `reconcile`.
 */

export interface WorkThreadContextState {
  /** Never empty: a session with no stored model is on Auto, like a new one. */
  model: string;
  reasoningEffort: string | null;
  permissionPolicy: WorkPermissionPolicy;
  projectId: string | null;
  /** Meaningless unless `reachKnown` — see the note above. */
  connectorIds: readonly string[];
  /** Meaningless unless `reachKnown`. */
  attachmentIds: readonly string[];
  /** Meaningless unless `reachKnown`. */
  skillSlug: string | null;
  /** True once Juno has said what this task holds. */
  reachKnown: boolean;
  /** True when the read was attempted and did not land. */
  reachUnreadable: boolean;
  /** A change is in flight. Every control is held, so only one ever is. */
  saving: boolean;
  /** The quiet line under the controls: what the last change will actually do. */
  note: string | null;
  /** Reads what the task holds. Cheap to call repeatedly; runs at most once. */
  load: () => void;
  /** Re-reads after a failed read, for the Retry in the menu's unknown state. */
  reload: () => void;
  change: (input: WorkSessionContextInput) => void;
}

/** The client's own copy of the fields, as far as it knows them. */
interface LocalValues {
  model?: string;
  reasoningEffort?: string | null;
  permissionPolicy?: WorkPermissionPolicy;
  projectId?: string | null;
  connectorIds?: string[];
  attachmentIds?: string[];
  skillSlug?: string | null;
}

/**
 * What each field is called in the line under the controls.
 *
 * The reader's word, not the wire's: "Approvals" rather than `permissionPolicy`,
 * because the note sits under a control they just used and naming it after the
 * column would be the one place in this surface that leaks the schema.
 */
const FIELD_LABEL: Record<WorkContextField, string> = {
  model: "Model",
  reasoningEffort: "Thinking",
  permissionPolicy: "Approvals",
  projectId: "Project",
  connectorIds: "Apps",
  attachmentIds: "Files",
  skillSlug: "Skill",
};

/**
 * The sentence for one settled change.
 *
 * The server's own words win wherever it wrote any: it is the only party that
 * knows whether this particular field could reach this particular run, and a
 * fallback that guessed would be a second, quieter way of getting it wrong.
 *
 * With no run under way there is no timing question to answer — nothing is
 * mid-flight to miss the change — so all three server timings collapse into the
 * same true sentence rather than being reported as a distinction the reader
 * cannot act on.
 */
function noteFor(field: WorkContextField, change: WorkContextChange | null, live: boolean): string {
  const label = FIELD_LABEL[field];
  if (change?.explanation) return `${label} — ${change.explanation}`;
  if (!live) return `${label} saved. It will be used the next time this task runs.`;
  switch (change?.timing ?? "unstated") {
    case "now":
      return `${label} changed. It applies to the attempt now running.`;
    case "next_attempt":
      return `${label} saved. It applies to the next attempt, not the one running.`;
    default:
      // Juno saved it and did not say when it lands. The only claim available is
      // the one that cannot mislead.
      return `${label} saved. The attempt already running may not pick it up.`;
  }
}

/** What to say about a change that did not happen. Never blames the reader. */
function failureSentence(result: WorkBlocked | WorkTransportFailure): string {
  if (result.kind === "blocked") return result.explanation;
  if (result.cause === "offline") return "Couldn’t reach Juno, so nothing was changed.";
  // The route's own sentence, where it wrote one — it is the only part of this
  // that knows which plan, which model or which app.
  if (result.message !== null) return result.message;
  if (result.cause === "not_found") {
    return "This task, or something it points at, is no longer there. Nothing was changed.";
  }
  if (result.cause === "unauthorized") {
    return "Juno turned this down. You may have been signed out — reload the page to check.";
  }
  return "Couldn’t change this just now, so it is unchanged.";
}

/** The values an input sets, for the optimistic copy. */
function valuesFrom(input: WorkSessionContextInput): LocalValues {
  return {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.permissionPolicy === undefined ? {} : { permissionPolicy: input.permissionPolicy }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.connectorIds === undefined ? {} : { connectorIds: [...input.connectorIds] }),
    ...(input.attachmentIds === undefined ? {} : { attachmentIds: [...input.attachmentIds] }),
    ...(input.skillSlug === undefined ? {} : { skillSlug: input.skillSlug }),
  };
}

/** The first field this input touched, in the order the wire lists them. */
function primaryField(input: WorkSessionContextInput): WorkContextField | null {
  return WORK_CONTEXT_FIELDS.find((field) => input[field] !== undefined) ?? null;
}

export function useWorkThreadContext({
  session,
  live,
}: {
  session: ClientWorkSession;
  /** A run is under way, so a change has an attempt it might miss. */
  live: boolean;
}): WorkThreadContextState {
  const [local, setLocal] = React.useState<LocalValues>({});
  const [reachKnown, setReachKnown] = React.useState(false);
  const [reachUnreadable, setReachUnreadable] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  // The snapshot a rollback restores has to be the values as they are at the
  // moment of the request, which a closure over `local` cannot promise.
  const localRef = React.useRef<LocalValues>(local);
  const loadedRef = React.useRef(false);
  // Read in the same tick a change is made, which `saving` cannot be: state set
  // during one handler is not visible to the next until React re-renders.
  const savingRef = React.useRef(false);

  const write = React.useCallback((next: LocalValues) => {
    localRef.current = next;
    setLocal(next);
  }, []);

  /*
   * Drop a local value once the session prop carries the same thing.
   *
   * Only the three fields the session actually has. Holding them forever would
   * mean this composer ignoring a change made from the rail or another tab for
   * the rest of the page's life; dropping them on the next render instead would
   * flip the control back to the old value for the second before the stream
   * catches up, which reads as the change being undone.
   */
  React.useEffect(() => {
    const current = localRef.current;
    const next = { ...current };
    let changed = false;
    if (next.model !== undefined && next.model === (session.requestedModel ?? AUTO_MODEL_ID)) {
      delete next.model;
      changed = true;
    }
    if (next.reasoningEffort !== undefined && next.reasoningEffort === session.reasoningEffort) {
      delete next.reasoningEffort;
      changed = true;
    }
    if (next.permissionPolicy !== undefined && next.permissionPolicy === session.permissionPolicy) {
      delete next.permissionPolicy;
      changed = true;
    }
    if (next.projectId !== undefined && next.projectId === session.projectId) {
      delete next.projectId;
      changed = true;
    }
    if (changed) write(next);
  }, [
    session.requestedModel,
    session.reasoningEffort,
    session.permissionPolicy,
    session.projectId,
    write,
  ]);

  /** Folds a server copy in without discarding a value it has not seen yet. */
  const adopt = React.useCallback(
    (context: WorkSessionContext) => {
      const current = localRef.current;
      const arrived: LocalValues = {
        ...(context.model === undefined ? {} : { model: context.model ?? AUTO_MODEL_ID }),
        ...(context.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: context.reasoningEffort }),
        ...(context.permissionPolicy === undefined
          ? {}
          : { permissionPolicy: context.permissionPolicy }),
        ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
        ...(context.connectorIds === undefined ? {} : { connectorIds: context.connectorIds }),
        ...(context.attachmentIds === undefined ? {} : { attachmentIds: context.attachmentIds }),
        ...(context.skillSlug === undefined ? {} : { skillSlug: context.skillSlug }),
      };
      // The read is the older fact whenever a change has already been made on
      // top of it, so anything held locally wins the merge. At first load there
      // is nothing local and this is simply the server's copy.
      write({ ...arrived, ...current });
      if (context.connectorIds !== undefined || context.skillSlug !== undefined) {
        setReachKnown(true);
        setReachUnreadable(false);
      }
    },
    [write]
  );

  const read = React.useCallback(async () => {
    setReachUnreadable(false);
    const result = await fetchWorkSessionContext(session.id);
    if (result.kind !== "ok") {
      // No toast. A reader who opened a menu is owed the sentence inside that
      // menu, where the Retry is, rather than a notification about a request
      // they did not make.
      setReachUnreadable(true);
      return;
    }
    adopt(result.value);
    // A route that answered with nothing useful is a route that told us
    // nothing, and the menu says so rather than drawing switches over a guess.
    if (
      result.value.connectorIds === undefined &&
      result.value.attachmentIds === undefined &&
      result.value.skillSlug === undefined
    ) {
      setReachUnreadable(true);
    }
  }, [adopt, session.id]);

  const load = React.useCallback(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void read();
  }, [read]);

  const reload = React.useCallback(() => {
    loadedRef.current = true;
    void read();
  }, [read]);

  const change = React.useCallback(
    (input: WorkSessionContextInput) => {
      const field = primaryField(input);
      if (field === null) return;
      /*
       * One change at a time. The controls are already held while a request is
       * in flight, but a keyboard user inside a menu that was open when it
       * started can still reach a second one — and two overlapping writes make
       * the rollback wrong: the second snapshots the first's optimistic values,
       * so a failure restores a state that was never confirmed.
       */
      if (savingRef.current) return;
      savingRef.current = true;
      const previous = localRef.current;
      write({ ...previous, ...valuesFrom(input) });
      setSaving(true);
      setNote(null);

      void (async () => {
        const result = await updateWorkSessionContext(session.id, input);
        savingRef.current = false;
        setSaving(false);
        if (result.kind !== "ok") {
          // Exactly the values from before the press. Anything else leaves the
          // control asserting a state the server refused.
          write(previous);
          toast.error(failureSentence(result));
          return;
        }
        adopt(result.value.context);
        setNote(
          noteFor(
            field,
            result.value.changes.find((entry) => entry.field === field) ?? null,
            live
          )
        );
        // The sidebar and the task list poll on their own clock, so without this
        // a task whose project just changed keeps its old filing beside the
        // reader for up to thirty seconds.
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
      })();
    },
    [adopt, live, session.id, write]
  );

  /*
   * A local value wins, and `undefined` is what "no local value" means — hence
   * the explicit checks rather than `??` on the two fields whose real value can
   * be null. `local.projectId ?? session.projectId` would quietly refuse to
   * take a task out of a project, because taking it out sets null and null
   * falls through to the session's old id.
   */
  return {
    model: local.model ?? session.requestedModel ?? AUTO_MODEL_ID,
    reasoningEffort:
      local.reasoningEffort !== undefined ? local.reasoningEffort : session.reasoningEffort,
    // The last fallback is for a payload rather than for the type: this arrives
    // as JSON from a deployment that may be older than this bundle, and a
    // missing policy must not render as `undefined` on a control.
    permissionPolicy:
      local.permissionPolicy ?? session.permissionPolicy ?? DEFAULT_WORK_PERMISSION_POLICY,
    projectId: local.projectId !== undefined ? local.projectId : session.projectId,
    connectorIds: local.connectorIds ?? [],
    attachmentIds: local.attachmentIds ?? [],
    skillSlug: local.skillSlug ?? null,
    reachKnown,
    reachUnreadable,
    saving,
    note,
    load,
    reload,
    change,
  };
}
