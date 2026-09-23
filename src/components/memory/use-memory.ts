"use client";

import * as React from "react";
import { toast } from "sonner";
import { useApp } from "@/components/app/app-provider";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import {
  createEdits,
  deleteEditRecord,
  fetchEdits,
  migrateLegacyEdits,
  newEditId,
  updateEdit,
  type Memory,
  type MemoryEditRecord,
  type Operation,
  type ProjectSummaryData,
  type SummaryData,
} from "@/components/memory/memory-model";

/*
 * The memory page's whole state machine, in one place.
 *
 * IT EXISTS BECAUSE THE PAGE HAD LOST ITS WIRING. Three things were broken at
 * once, and each was invisible from the surface that broke it:
 *
 *  1. The natural-language editor POSTed to `/api/memory/instruct`, a route
 *     that does not exist. Every instruction a user typed — the headline
 *     feature of the page — 404'd and reported itself as "Couldn't update
 *     memory". The real contract is two calls: `/api/memory/edit` DRAFTS a
 *     reviewable proposal and writes nothing, `/api/memory/edit/apply` commits
 *     it and hands back the inverse for Undo.
 *  2. `EntryList` and `EditsPanel` were complete, reviewed components that
 *     nothing imported. The page rendered a prose summary and no rows, so a
 *     wrong fact had nothing to point at and no way to be removed.
 *  3. Pausing memory called the app provider's `setSettings`, which only
 *     touches React state. The switch moved, the toast said "Memory paused",
 *     and the next page load had it on again.
 *
 * All three were one refactor's worth of loose ends, and all three are the kind
 * that a type-checker cannot see: a string URL, an unused export, and a setter
 * whose name promises persistence it does not do. Collecting the state here is
 * what makes the next such refactor fail loudly — there is now exactly one
 * place that knows how this page talks to the server.
 */

/** A memory mutation's outcome, in the words the surface needs. */
type Refused = { ok: false; message: string };

export interface MemoryState {
  /** null while the first load is in flight; [] is a genuinely empty account. */
  memories: Memory[] | null;
  summary: SummaryData | null;
  /** Each project's own summary — what that project's chats read instead of `summary`. */
  projectSummaries: ProjectSummaryData[];
  edits: MemoryEditRecord[];
  loadError: boolean;
  /** A background model is drafting, consolidating, or applying. */
  busy: boolean;
  /** Entry ids with a mutation in flight — their row controls disable. */
  busyIds: ReadonlySet<string>;
  /** Edit-ledger ids with an apply/undo in flight. */
  busyEditIds: ReadonlySet<string>;
  /** Set when a background-provider policy refused the work, with the reason. */
  policyNotice: string | null;
  paused: boolean;
  resetting: boolean;
  reload: () => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  /** Rebuild the account's summary, or — given a `projectId` — that project's. */
  regenerate: (opts?: { silent?: boolean; projectId?: string | null }) => Promise<void>;
  /** Draft an instruction into a reviewable edit. Resolves true when drafted. */
  instruct: (instruction: string) => Promise<boolean>;
  acceptEdit: (edit: MemoryEditRecord) => Promise<void>;
  undoEdit: (edit: MemoryEditRecord) => Promise<void>;
  deleteEdit: (id: string) => Promise<void>;
  /** Save a fact by hand — account-wide, or scoped to one project. */
  addMemory: (content: string, projectId?: string | null) => Promise<boolean>;
  editMemory: (id: string, content: string) => Promise<boolean>;
  /**
   * Retire a fact and block it from being learned again. `silent` skips the
   * success toast, for a caller that already showed its own (the page's
   * deferred delete, which toasts with Undo before this ever runs). Resolves
   * true when the server agreed.
   */
  forgetMemory: (memory: Memory, opts?: { silent?: boolean }) => Promise<boolean>;
  deleteMemory: (memory: Memory, opts?: { silent?: boolean }) => Promise<boolean>;
  /** File a fact under one project, or (null) back under the whole account. */
  moveMemory: (memory: Memory, project: { id: string; name: string } | null) => Promise<boolean>;
  /** Delete everything remembered, account-wide. Resolves true when the server did. */
  resetMemory: () => Promise<boolean>;
  exportMemory: () => void;
}

/** The shape every memory route answers a mutation with. */
interface MemoryListResponse {
  memories?: Memory[];
  summary?: SummaryData | null;
  projectSummaries?: ProjectSummaryData[];
  inverse?: Operation[];
}

const GENERIC_FAILURE = "Couldn’t update memory. Try again in a moment.";

/**
 * Read a route's error body into one sentence.
 *
 * Every memory route answers a refusal with `{ error }` and, where it matters,
 * a machine-readable `code` — `suppressed` when the block-list refused the
 * write, `background_policy_denied` when the provider policy did. The message
 * is already written for a reader at the route, so this never rewrites one; it
 * only supplies a fallback when the body is missing or unparseable.
 */
async function readRefusal(res: Response): Promise<{ message: string; code?: string }> {
  const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  return { message: data?.error || GENERIC_FAILURE, code: data?.code };
}

export function useMemory(): MemoryState {
  const { user, settings } = useApp();
  const saveSettings = useSettingsSave();

  const [memories, setMemories] = React.useState<Memory[] | null>(null);
  const [summary, setSummary] = React.useState<SummaryData | null>(null);
  const [projectSummaries, setProjectSummaries] = React.useState<ProjectSummaryData[]>([]);
  const [edits, setEdits] = React.useState<MemoryEditRecord[]>([]);
  const [loadError, setLoadError] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [busyIds, setBusyIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [busyEditIds, setBusyEditIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [policyNotice, setPolicyNotice] = React.useState<string | null>(null);
  const [resetting, setResetting] = React.useState(false);

  const paused = !settings.memoryEnabled;

  const mark = React.useCallback(
    (setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, id: string, on: boolean) => {
      setter((prev) => {
        const next = new Set(prev);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    []
  );

  // Whether a list has ever arrived. A refresh that fails after that (the
  // reload behind an edit, a forget, a move) must not swap a page of rows the
  // reader can see for "Couldn't load your memory. Nothing has been changed",
  // which is false the moment the change it followed went through.
  const loadedOnce = React.useRef(false);

  const reload = React.useCallback(async () => {
    try {
      const res = await fetch("/api/memory");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as MemoryListResponse;
      setMemories(data.memories ?? []);
      setSummary(data.summary ?? null);
      setProjectSummaries(data.projectSummaries ?? []);
      setLoadError(false);
      loadedOnce.current = true;
    } catch {
      if (loadedOnce.current) toast.error("Couldn’t refresh your memory. Reload the page to see the latest.");
      else setLoadError(true);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  // The ledger, and the one-time rescue of any records stranded in
  // localStorage by the pre-v3 build. Both are best effort: a page that cannot
  // reach the ledger still edits memory perfectly well, it just cannot show
  // the history, so a failure here must not paint the whole page as broken.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (user?.id) await migrateLegacyEdits(user.id);
        const list = await fetchEdits();
        if (!cancelled) setEdits(list);
      } catch {
        /* history unavailable — the editor itself still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const setPaused = React.useCallback(
    async (nextPaused: boolean) => {
      // `saveSettings`, not the provider's `setSettings`: this writes to
      // /api/settings and rolls the switch back when the server refuses. The
      // provider's setter is local state only, and using it here is what made
      // the pause toggle forget itself on reload.
      const ok = await saveSettings({ memoryEnabled: !nextPaused });
      if (!ok) return;
      if (nextPaused) toast.success("Memory is off. Juno won’t use or save memories.");
      else toast.success("Memory is on. Juno will learn from your chats.");
    },
    [saveSettings]
  );

  const regenerate = React.useCallback(
    async (opts?: { silent?: boolean; projectId?: string | null }) => {
      setBusy(true);
      try {
        // Both routes answer with the same contract (a 409 carrying
        // `background_policy_denied`, a 502 carrying the reason), so one path
        // handles either summary.
        const res = await fetch(
          opts?.projectId ? `/api/projects/${encodeURIComponent(opts.projectId)}/memory` : "/api/memory/consolidate",
          { method: "POST" }
        );
        if (!res.ok) {
          const { message, code } = await readRefusal(res);
          if (code === "background_policy_denied") {
            setPolicyNotice(message);
            return;
          }
          throw new Error(message);
        }
        setPolicyNotice(null);
        await reload();
        if (!opts?.silent) {
          toast.success(
            opts?.projectId ? "Summary rebuilt from this project’s chats." : "Summary rebuilt from your chats and projects."
          );
        }
      } catch (error) {
        if (!opts?.silent) toast.error(error instanceof Error ? error.message : GENERIC_FAILURE);
      } finally {
        setBusy(false);
      }
    },
    [reload]
  );

  /**
   * Turn an instruction into a reviewable edit.
   *
   * Drafting and applying are deliberately kept as two steps even though one
   * round-trip would be simpler. The model is rewriting what Juno believes
   * about a person from one sentence of theirs; a diff they can read before it
   * lands is the difference between an editor and a slot machine. The draft
   * writes nothing at all, so a refusal costs the user nothing to have tried.
   */
  const instruct = React.useCallback(
    async (instruction: string): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await fetch("/api/memory/edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction }),
        });
        if (!res.ok) {
          const { message, code } = await readRefusal(res);
          if (code === "background_policy_denied") {
            setPolicyNotice(message);
            return false;
          }
          throw new Error(message);
        }
        setPolicyNotice(null);
        const data = (await res.json()) as {
          refusal?: string;
          proposal?: { summary: string; operations: Operation[] };
        };

        // A refusal is recorded, not discarded. "Juno wouldn't do that" with no
        // trace of the asking leaves the user re-typing the same sentence to
        // find out whether it went through.
        if (data.refusal) {
          const list = await createEdits([
            {
              clientId: newEditId(),
              instruction,
              note: data.refusal,
              status: "rejected",
              operations: [],
            },
          ]).catch(() => null);
          if (list) setEdits(list);
          toast.info(data.refusal);
          return true;
        }

        if (!data.proposal?.operations.length) throw new Error(GENERIC_FAILURE);
        const list = await createEdits([
          {
            clientId: newEditId(),
            instruction,
            summary: data.proposal.summary,
            status: "pending",
            operations: data.proposal.operations,
          },
        ]);
        // No toast: the draft appears under the prompt bar that asked for it,
        // which is where the reader is already looking.
        setEdits(list);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : GENERIC_FAILURE);
        return false;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  /**
   * Commit a drafted edit and keep its inverse.
   *
   * The ledger is written AFTER the apply succeeds and with the inverse the
   * server computed, never with one derived here: the server is what knows
   * which rows actually changed (a suppression added mid-batch can refuse an
   * operation after it), and an Undo built from the client's guess would
   * restore a state that never existed.
   */
  const applyOperations = React.useCallback(
    async (operations: Operation[]): Promise<{ inverse: Operation[] } | Refused> => {
      const res = await fetch("/api/memory/edit/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operations }),
      });
      if (!res.ok) return { ok: false, ...(await readRefusal(res)) };
      const data = (await res.json()) as MemoryListResponse;
      // The apply route answers with the whole fresh list, so the page swaps
      // its state rather than re-fetching — one round-trip, and no window in
      // which the rows and the summary disagree.
      setMemories(data.memories ?? []);
      setSummary(data.summary ?? null);
      return { inverse: data.inverse ?? [] };
    },
    []
  );

  const acceptEdit = React.useCallback(
    async (edit: MemoryEditRecord) => {
      mark(setBusyEditIds, edit.id, true);
      try {
        const outcome = await applyOperations(edit.operations);
        if ("ok" in outcome) {
          // A stale or refused edit stays in the ledger, marked and explained,
          // so the note survives the page reload the user is about to do.
          const list = await updateEdit(edit.id, { status: "rejected", note: outcome.message }).catch(() => null);
          if (list) setEdits(list);
          toast.error(outcome.message);
          return;
        }
        // No toast: both places that accept an edit (the proposal under the
        // prompt bar, the activity sheet) turn the row itself into "Applied"
        // with its Undo beside it, which says more than a toast could.
        const list = await updateEdit(edit.id, { status: "applied", inverse: outcome.inverse });
        setEdits(list);
      } catch {
        toast.error(GENERIC_FAILURE);
      } finally {
        mark(setBusyEditIds, edit.id, false);
      }
    },
    [applyOperations, mark]
  );

  const undoEdit = React.useCallback(
    async (edit: MemoryEditRecord) => {
      if (!edit.inverse?.length) return;
      mark(setBusyEditIds, edit.id, true);
      try {
        const outcome = await applyOperations(edit.inverse);
        if ("ok" in outcome) {
          toast.error(outcome.message);
          return;
        }
        // Undone goes back to `pending` with its ORIGINAL operations, not to a
        // third state: the user has put the memory back and may well want the
        // change again, and a ledger entry they can re-accept is the shortest
        // path to that. The inverse is cleared because it no longer describes
        // anything that has been applied.
        const list = await updateEdit(edit.id, { status: "pending", inverse: null });
        setEdits(list);
        toast.success("Change undone.");
      } catch {
        toast.error(GENERIC_FAILURE);
      } finally {
        mark(setBusyEditIds, edit.id, false);
      }
    },
    [applyOperations, mark]
  );

  const deleteEdit = React.useCallback(async (id: string) => {
    try {
      setEdits(await deleteEditRecord(id));
    } catch {
      toast.error("Couldn’t remove that from the history.");
    }
  }, []);

  const addMemory = React.useCallback(
    async (content: string, projectId?: string | null): Promise<boolean> => {
      try {
        const res = await fetch("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(projectId ? { content, projectId } : { content }),
        });
        if (!res.ok) {
          const { message } = await readRefusal(res);
          throw new Error(message);
        }
        const { memory } = (await res.json()) as { memory: Memory };
        setMemories((prev) => [memory, ...(prev ?? [])]);
        toast.success(projectId ? "Added to this project’s memory." : "Added to memory.");
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : GENERIC_FAILURE);
        return false;
      }
    },
    []
  );

  const editMemory = React.useCallback(
    async (id: string, content: string): Promise<boolean> => {
      mark(setBusyIds, id, true);
      try {
        const res = await fetch(`/api/memory/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (!res.ok) {
          const { message } = await readRefusal(res);
          throw new Error(message);
        }
        // Reloaded rather than patched in place: rewriting a fact reclassifies
        // it, re-dates it and clears its "replaced by", so the row the user is
        // looking at changes in four ways a local splice would not show.
        await reload();
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : GENERIC_FAILURE);
        return false;
      } finally {
        mark(setBusyIds, id, false);
      }
    },
    [mark, reload]
  );

  const forgetMemory = React.useCallback(
    async (memory: Memory, opts?: { silent?: boolean }): Promise<boolean> => {
      mark(setBusyIds, memory.id, true);
      try {
        const res = await fetch(`/api/memory/${memory.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forget: true }),
          // The page's deferred removal can send this as the tab closes; a
          // keepalive request outlives the page that started it.
          keepalive: true,
        });
        if (!res.ok) throw new Error();
        await reload();
        if (!opts?.silent) toast.success("Forgotten. Juno won’t learn this again.");
        return true;
      } catch {
        toast.error("Couldn’t forget that. Nothing was changed.");
        return false;
      } finally {
        mark(setBusyIds, memory.id, false);
      }
    },
    [mark, reload]
  );

  const deleteMemory = React.useCallback(
    async (memory: Memory, opts?: { silent?: boolean }): Promise<boolean> => {
      mark(setBusyIds, memory.id, true);
      try {
        const res = await fetch(`/api/memory/${memory.id}`, { method: "DELETE", keepalive: true });
        // A 404 is the outcome asked for, not a failure: the row is already
        // gone (a reset, another tab), and "Nothing was changed" would be false.
        if (!res.ok && res.status !== 404) throw new Error();
        setMemories((prev) => (prev ?? []).filter((m) => m.id !== memory.id));
        // Deliberately says what delete does NOT do. Delete removes the row;
        // the chat it came from is still there, so a later backfill may learn
        // the same fact again. "Forget" is the one that also blocks it, and
        // this is the moment the difference matters.
        if (!opts?.silent) toast.success("Deleted. Juno may learn it again from the chat it came from.");
        return true;
      } catch {
        toast.error("Couldn’t delete that. Nothing was changed.");
        return false;
      } finally {
        mark(setBusyIds, memory.id, false);
      }
    },
    [mark]
  );

  const moveMemory = React.useCallback(
    async (memory: Memory, project: { id: string; name: string } | null): Promise<boolean> => {
      mark(setBusyIds, memory.id, true);
      try {
        // `projectId: null` is the route's "back to the whole account"; the
        // route checks the project belongs to this account before it moves.
        const res = await fetch(`/api/memory/${memory.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: project?.id ?? null }),
        });
        if (!res.ok) {
          const { message } = await readRefusal(res);
          throw new Error(message);
        }
        // Reloaded rather than spliced: the row's project name comes from the
        // server, and the scope chips count from the same list.
        await reload();
        if (project) toast.success("Moved. Only chats in that project will use it.");
        else toast.success("Moved. Every chat can use it now.");
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : GENERIC_FAILURE);
        return false;
      } finally {
        mark(setBusyIds, memory.id, false);
      }
    },
    [mark, reload]
  );

  const resetMemory = React.useCallback(async (): Promise<boolean> => {
    setResetting(true);
    try {
      const res = await fetch("/api/memory", { method: "DELETE" });
      if (!res.ok) throw new Error();
      setMemories([]);
      setSummary(null);
      setProjectSummaries([]);
      setEdits([]);
      toast.success("Memory reset. Juno starts fresh.");
      return true;
    } catch {
      toast.error("Couldn’t reset memory. Nothing was deleted.");
      return false;
    } finally {
      setResetting(false);
    }
  }, []);

  const exportMemory = React.useCallback(() => {
    const payload = { exportedAt: new Date().toISOString(), summary, projectSummaries, memories };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `juno-memory-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Memory exported.");
  }, [memories, projectSummaries, summary]);

  return {
    memories,
    summary,
    projectSummaries,
    edits,
    loadError,
    busy,
    busyIds,
    busyEditIds,
    policyNotice,
    paused,
    resetting,
    reload,
    setPaused,
    regenerate,
    instruct,
    acceptEdit,
    undoEdit,
    deleteEdit,
    addMemory,
    editMemory,
    forgetMemory,
    deleteMemory,
    moveMemory,
    resetMemory,
    exportMemory,
  };
}
