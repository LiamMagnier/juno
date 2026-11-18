"use client";

import * as React from "react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { useApp } from "@/components/app/app-provider";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { openSettings } from "@/components/settings/settings-sections";
import { cn } from "@/lib/utils";
import { findMemoryOverlaps, overlapKey, type MemoryOverlap } from "@/lib/memory-overlaps";
import { ActivitySheet, type ActivityTab } from "@/components/memory/activity-sheet";
import { ImportDialog } from "@/components/memory/import-dialog";
import { ClearProjectDialog, MemoryFooter, ResetDialog } from "@/components/memory/memory-footer";
import { ExcludedTopicsDialog } from "@/components/memory/excluded-topics";
import { SkillCandidates, type SkillCandidateTransport } from "@/components/memory/skill-candidates";
import { MemoryHeaderActions, MemoryPageHeader } from "@/components/memory/memory-header";
import { AddForm, MemoryList } from "@/components/memory/memory-list";
import type { MemoryGrouping } from "@/components/memory/memory-groups";
import "@/components/memory/memory.css";
import { BackfillNotice, PausedNotice, PolicyNotice } from "@/components/memory/memory-notices";
import { MemoryBodySkeleton } from "@/components/memory/memory-skeleton";
import { MemoryWelcome } from "@/components/memory/memory-welcome";
import { OverlapsPanel } from "@/components/memory/overlaps-panel";
import { PromptDock, type PromptDockHandle } from "@/components/memory/prompt-dock";
import type { RecapExtras } from "@/components/memory/recap-view";
import { ScopeBar } from "@/components/memory/scope-bar";
import { SummaryPanel } from "@/components/memory/summary-panel";
import { ReviewDeck } from "@/components/memory/review-deck";
import { memoriesToReview } from "@/components/memory/memory-review";
import { useBackfill, type BackfillState } from "@/components/memory/use-backfill";
import { useDeferredRemoval } from "@/components/memory/use-deferred-removal";
import { useMemory, type MemoryState } from "@/components/memory/use-memory";
import { useProjectOptions, type ProjectOptions } from "@/components/memory/use-project-options";
import {
  isRetired,
  memoriesInScope,
  memoryScopes,
  type Memory,
  type MemoryEditRecord,
} from "@/components/memory/memory-model";
import type { RecapPeriod } from "@/lib/memory-recap";

/*
 * The memory page: what Alevr knows, where each thing came from, and every
 * way to correct it or take it away.
 *
 * A PRODUCT PAGE, NOT A REPORT. It opens the way every app page does (the
 * shared header: the name, one plain sentence, its controls) and then reads
 * top to bottom:
 *
 *   notices     memory is off / a policy refused / reading past chats
 *   scope       only when a project has memory of its own
 *   summary     what Alevr makes of it all, in prose, and the bar that
 *               changes memory in words right under it
 *   list        every memory, grouped by what it is about (or where it came
 *               from, or when), with what needs a look first
 *   footer      what never reaches memory
 *
 * It used to open on a hero: a display title, three large figures and a dot
 * constellation, with the summary and the list each set beside a 13rem margin
 * column of their own. All of it said less than the list's own group counts.
 * The edit history and the recap are one step aside, in the activity sheet;
 * import, export and reset are in the header's menu.
 *
 * DATA AND PRESENTATION ARE SPLIT. `MemoryManager` owns the requests (the
 * memory hook, the backfill job, the project list); `MemoryManagerView` is the
 * whole page as a function of that state, which is what lets the dev gallery
 * (src/app/dev/memory) render the real page from fixtures.
 */

export function MemoryManager() {
  const memory = useMemory();
  const { settings } = useApp();
  const backfill = useBackfill({
    paused: memory.paused,
    backgroundLearning: settings.memoryBackgroundLearning,
    onLearned: memory.reload,
  });
  const projects = useProjectOptions();
  const openMemorySettings = React.useCallback(() => openSettings("memory"), []);

  return (
    <MemoryManagerView
      memory={memory}
      backfill={backfill}
      projects={projects.projects}
      onWantProjects={projects.load}
      onOpenSettings={openMemorySettings}
    />
  );
}

interface MemoryManagerViewProps {
  memory: MemoryState;
  backfill: BackfillState;
  /** Projects a memory can move to; null until first asked for and loaded. */
  projects: ProjectOptions;
  /** Load the projects, when a row's menu first opens (and again after a failure). */
  onWantProjects: () => void;
  onOpenSettings: () => void;
  /** For the dev gallery: the recap's server half, without the server. */
  loadRecapExtras?: (days: RecapPeriod) => Promise<RecapExtras>;
  /** For the dev gallery: proposals without the server. */
  skillCandidates?: SkillCandidateTransport;
}

const SORT_KEY = "juno.memory.sort";
/** Pairs the person said are both right ("Keep both"): a per-viewer convenience, so browser storage. */
const KEPT_BOTH_KEY = "alevr.memory.kept-both";
/** How long a row that a change just touched stays lit. */
const HIGHLIGHT_MS = 1400;
/** Below this many memories, unread history is worth a banner, not just a menu item. */
const THIN_MEMORY = 12;

/** The rows an edit rewrites in place (its adds arrive as new ids). */
function updatedIds(edit: MemoryEditRecord, inverse = false): string[] {
  return (inverse ? edit.inverse ?? [] : edit.operations).flatMap((op) => (op.op === "update" ? [op.id] : []));
}

function readKeptBoth(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEPT_BOTH_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

export function MemoryManagerView({
  memory,
  backfill,
  projects,
  onWantProjects,
  onOpenSettings,
  loadRecapExtras,
  skillCandidates,
}: MemoryManagerViewProps) {
  const [query, setQuery] = React.useState("");
  const [grouping, setGrouping] = React.useState<MemoryGrouping>("topic");
  /** The project the page is narrowed to, or null for everything. */
  const [scope, setScope] = React.useState<string | null>(null);
  const [scopeSwitched, setScopeSwitched] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [topicsOpen, setTopicsOpen] = React.useState(false);
  /** The project whose memory the clear dialog is asking about, when open. */
  const [clearing, setClearing] = React.useState<{ id: string; name: string } | null>(null);
  const [activityOpen, setActivityOpen] = React.useState(false);
  const [activityTab, setActivityTab] = React.useState<ActivityTab>("edits");
  /** The add field is open: at the top of the list, or in the empty state. */
  const [adding, setAdding] = React.useState(false);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  // Tracked here rather than read off `memory.busy`, which is also true while
  // an instruction drafts: the Rebuild button spins only for a rebuild.
  const [rebuilding, setRebuilding] = React.useState(false);
  const [highlightIds, setHighlightIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [justApplied, setJustApplied] = React.useState<ReadonlyMap<string, number>>(() => new Map());
  const [keptBoth, setKeptBoth] = React.useState<ReadonlySet<string>>(() => new Set());
  /**
   * The fact the page was opened on — `/memory?entry=<id>`, where a chat's
   * "View in memory" and "Memory updated → View" land — and whether to open
   * it for editing (`&edit=1`). The list unfolds its group, scrolls it into
   * view and lights it once.
   */
  const [reveal, setReveal] = React.useState<{ id: string; edit: boolean } | null>(null);
  const dockRef = React.useRef<PromptDockHandle>(null);

  // `/memory?project=<id>` is where the project page's "Manage memory" lands.
  // Read off `location` rather than useSearchParams, which would ask for a
  // Suspense boundary around a page that is otherwise plain.
  React.useEffect(() => {
    const params = new URL(window.location.href).searchParams;
    const requested = params.get("project");
    if (requested) setScope(requested);
    const entry = params.get("entry");
    if (entry) setReveal({ id: entry, edit: params.get("edit") === "1" });
    try {
      const saved = window.localStorage.getItem(SORT_KEY);
      if (saved === "topic" || saved === "source" || saved === "newest") setGrouping(saved);
    } catch {
      // Storage unavailable: the default grouping is fine.
    }
    setKeptBoth(readKeptBoth());
  }, []);

  // Kept in the URL, so a narrowed page survives a reload and can be linked.
  const changeScope = React.useCallback((next: string | null) => {
    setScope(next);
    setScopeSwitched(true);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("project", next);
    else url.searchParams.delete("project");
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
  }, []);

  const changeGrouping = React.useCallback((next: MemoryGrouping) => {
    setGrouping(next);
    try {
      window.localStorage.setItem(SORT_KEY, next);
    } catch {
      // A grouping that is not remembered is a small loss, not an error.
    }
  }, []);

  /*
   * Delete, Forget, and "Keep this" on a flagged pair all wait out an Undo
   * toast before anything is sent (useDeferredRemoval). Keep needs to know
   * which memory was kept and why; that rides here, by the set-aside row's id,
   * until the request goes or the Undo takes it back.
   */
  const replaceTargets = React.useRef(new Map<string, { kept: Memory; because: MemoryOverlap["kind"] }>());
  const removal = useDeferredRemoval(async (entry, kind) => {
    if (kind === "forget") return memory.forgetMemory(entry, { silent: true });
    if (kind === "delete") return memory.deleteMemory(entry, { silent: true });
    const target = replaceTargets.current.get(entry.id);
    replaceTargets.current.delete(entry.id);
    return target ? memory.replaceMemory(entry, target.kept, target.because, { silent: true }) : false;
  });
  // A reset has removed everything a waiting delete or forget would have, so
  // they are dropped rather than sent after it (to rows that no longer exist)
  // and their Undo leaves with them. A failed reset keeps them waiting.
  const resetMemory = async () => {
    if (await memory.resetMemory()) removal.discardAll();
  };

  const scopes = React.useMemo(
    () => memoryScopes(memory.memories ?? [], memory.projectSummaries),
    [memory.memories, memory.projectSummaries]
  );
  // A project the account has no memory for (deleted since, or a stale link)
  // shows everything rather than an empty page that looks like data loss.
  const activeScope = scope && scopes.some((option) => option.id === scope) ? scope : null;
  const activeProject = activeScope
    ? { id: activeScope, name: scopes.find((option) => option.id === activeScope)?.label ?? "This project" }
    : null;
  const scopedMemories = React.useMemo(
    () => memoriesInScope(memory.memories ?? [], activeScope),
    [memory.memories, activeScope]
  );
  // What Review asks about, in the scope on screen.
  const reviewItems = React.useMemo(() => memoriesToReview(scopedMemories), [scopedMemories]);
  const projectSummary = activeScope
    ? memory.projectSummaries.find((summary) => summary.projectId === activeScope) ?? null
    : null;

  const facts = React.useMemo(
    () => scopedMemories.filter((entry) => entry.kind === "FACT" && !removal.hiddenIds.has(entry.id)),
    [scopedMemories, removal.hiddenIds]
  );
  // Account-wide, not in scope: a project with three facts in an account of
  // three hundred is not a thin memory.
  const accountActiveCount = React.useMemo(
    () => (memory.memories ?? []).filter((entry) => entry.kind === "FACT" && !isRetired(entry)).length,
    [memory.memories]
  );
  const anythingRemembered =
    (memory.memories ?? []).some((entry) => entry.kind === "FACT") ||
    !!memory.summary ||
    memory.projectSummaries.length > 0;
  const pendingCount = memory.edits.filter((edit) => edit.status === "pending").length;

  // Memories that may say the same thing, or disagree, in the scope on screen.
  const overlaps = React.useMemo(() => findMemoryOverlaps(facts, { dismissed: keptBoth }), [facts, keptBoth]);
  const factsById = React.useMemo(() => new Map(facts.map((entry) => [entry.id, entry])), [facts]);

  /*
   * CAUSE AND EFFECT. A change that lands somewhere the reader is not looking
   * (an applied instruction rewrites three rows further down; a fact added at
   * the top files itself under a group) lights the rows it touched for a
   * moment. The marker is set before the change and read when the list
   * arrives, so the flash lands on the rows as they are after it: new ids, and
   * the ones an update rewrote in place.
   */
  const highlightMarker = React.useRef<{ before: Set<string>; updated: string[] } | null>(null);
  React.useEffect(() => {
    const marker = highlightMarker.current;
    if (!marker || !memory.memories) return;
    const ids = [
      ...memory.memories.filter((entry) => !marker.before.has(entry.id)).map((entry) => entry.id),
      ...marker.updated,
    ];
    if (ids.length === 0) return;
    highlightMarker.current = null;
    setHighlightIds(new Set(ids));
  }, [memory.memories]);
  // The linked fact is lit once its row exists.
  const revealedId = reveal && memory.memories?.some((entry) => entry.id === reveal.id) ? reveal.id : null;
  React.useEffect(() => {
    if (revealedId) setHighlightIds(new Set([revealedId]));
  }, [revealedId]);
  React.useEffect(() => {
    if (highlightIds.size === 0) return;
    const timer = window.setTimeout(() => setHighlightIds(new Set()), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightIds]);

  const withHighlight = React.useCallback(
    async <T,>(updated: string[], run: () => Promise<T>): Promise<T> => {
      const marker = { before: new Set((memory.memories ?? []).map((entry) => entry.id)), updated };
      highlightMarker.current = marker;
      try {
        return await run();
      } finally {
        // A change that failed never delivers a list, and its marker must not
        // wait for the next unrelated one. Long enough for a success to land.
        window.setTimeout(() => {
          if (highlightMarker.current === marker) highlightMarker.current = null;
        }, 1500);
      }
    },
    [memory.memories]
  );

  const acceptEdit = React.useCallback(
    (edit: MemoryEditRecord) => withHighlight(updatedIds(edit), () => memory.acceptEdit(edit)),
    [memory, withHighlight]
  );
  const undoEdit = React.useCallback(
    (edit: MemoryEditRecord) => withHighlight(updatedIds(edit, true), () => memory.undoEdit(edit)),
    [memory, withHighlight]
  );
  const addMemory = React.useCallback(
    (content: string) => withHighlight([], () => memory.addMemory(content, activeScope)),
    [activeScope, memory, withHighlight]
  );

  // "Keep this" sets the other aside at once (with Undo) and lights the one
  // kept, so the eye sees which stayed.
  const keepOverlap = React.useCallback(
    (kept: Memory, drop: Memory, overlap: MemoryOverlap) => {
      replaceTargets.current.set(drop.id, { kept, because: overlap.kind });
      removal.remove(drop, "replace");
      setHighlightIds(new Set([kept.id]));
    },
    [removal]
  );
  const keepBoth = React.useCallback((overlap: MemoryOverlap) => {
    setKeptBoth((prev) => {
      const next = new Set(prev).add(overlapKey(overlap.ids));
      try {
        window.localStorage.setItem(KEPT_BOTH_KEY, JSON.stringify([...next].slice(-200)));
      } catch {
        // Not remembered past this visit: the pair is asked about again next time.
      }
      return next;
    });
  }, []);

  const openActivity = (tab: ActivityTab) => {
    setActivityTab(tab);
    setActivityOpen(true);
  };

  const loaded = memory.memories !== null && !memory.loadError;
  const offerBackfill =
    loaded &&
    anythingRemembered &&
    !memory.paused &&
    !backfill.dreaming &&
    (backfill.remaining ?? 0) > 0 &&
    accountActiveCount < THIN_MEMORY;

  const dock = (
    <PromptDock
      ref={dockRef}
      edits={memory.edits}
      busyEditIds={memory.busyEditIds}
      paused={memory.paused}
      onInstruct={memory.instruct}
      onAccept={acceptEdit}
      onUndo={undoEdit}
      onDiscard={memory.deleteEdit}
      justApplied={justApplied}
      onJustAppliedChange={setJustApplied}
      // Starting points teach the bar to someone with little remembered; past
      // a handful of memories they were three more objects on every visit.
      suggest={facts.length < 4}
    />
  );

  return (
    <div className="mem">
      <MemoryPageHeader
        actions={
          <MemoryHeaderActions
            enabled={!memory.paused}
            onEnabledChange={(on) => void memory.setPaused(!on)}
            unread={backfill.remaining}
            learning={backfill.running}
            dreaming={backfill.dreaming}
            onLearn={backfill.run}
            onImport={() => setImportOpen(true)}
            onExport={memory.exportMemory}
            onSettings={onOpenSettings}
            onActivity={() => openActivity("edits")}
            onTopics={() => setTopicsOpen(true)}
            onReset={() => setResetOpen(true)}
            project={activeProject}
            onClearProject={() => setClearing(activeProject)}
            empty={!anythingRemembered}
            // While nothing is remembered the empty state carries Add.
            onAdd={loaded && anythingRemembered ? () => setAdding((open) => !open) : undefined}
            adding={adding}
            addButtonRef={addButtonRef}
          />
        }
      />

      <PausedNotice open={memory.paused} onTurnOn={() => void memory.setPaused(false)} />
      <PolicyNotice message={memory.policyNotice} onOpenSettings={onOpenSettings} />
      <BackfillNotice
        running={backfill.running}
        offer={offerBackfill}
        remaining={backfill.remaining ?? 0}
        total={backfill.total}
        onRun={backfill.run}
      />

      {memory.loadError ? (
        <EmptyState
          tone="error"
          icon={StatusIcons.error}
          title="Couldn’t load your memory"
          description="Check your connection and try again. Nothing has been changed."
          action={
            <Button variant="outline" size="sm" onClick={() => void memory.reload()}>
              <ActionIcons.refresh className="size-4" aria-hidden="true" />
              Try again
            </Button>
          }
        />
      ) : memory.memories === null ? (
        // The skeleton is drawn for the eye and hidden from the reader; this
        // says the same thing in words (loading.tsx does it with its own label).
        <div role="status">
          <span className="sr-only">Loading memory</span>
          <MemoryBodySkeleton />
        </div>
      ) : !anythingRemembered ? (
        <MemoryWelcome
          paused={memory.paused}
          unread={backfill.remaining}
          learning={backfill.running}
          onImport={() => setImportOpen(true)}
          onLearn={backfill.run}
          composing={adding}
          onCompose={() => setAdding((open) => !open)}
          pending={pendingCount > 0 ? dock : undefined}
        >
          <AddForm project={null} onAdd={addMemory} onClose={() => setAdding(false)} />
        </MemoryWelcome>
      ) : (
        // A scope switch re-plays a fade on the content it changed; nothing
        // else here has an entrance, since the page frame already rose once.
        <div key={activeScope ?? "account"} className={cn(scopeSwitched && "motion-safe:animate-fade-in")}>
          {scopes.length > 1 && (
            <div className="mb-6">
              <ScopeBar scopes={scopes} value={activeScope} onChange={changeScope} />
            </div>
          )}
          {/* The one way to change memory in words, first under the header:
              the summary and the list follow it (owner, 18 Nov 2026). It edits
              account-wide facts, so it is offered only on the account. */}
          {!activeScope && <div className="mb-8">{dock}</div>}
          <SummaryPanel
            summary={activeScope ? projectSummary : memory.summary}
            project={activeProject}
            consolidating={rebuilding}
            onRebuild={async () => {
              setRebuilding(true);
              await memory.regenerate({ projectId: activeScope });
              setRebuilding(false);
            }}
            onOpenActivity={() => openActivity("edits")}
            reviewCount={reviewItems.length}
            onOpenReview={() => setReviewOpen(true)}
          />

          <div className="mt-10">
            <MemoryList
              facts={facts}
              query={query}
              onQueryChange={setQuery}
              grouping={grouping}
              onGroupingChange={changeGrouping}
              paused={memory.paused}
              project={activeProject}
              busyIds={memory.busyIds}
              highlightIds={highlightIds}
              restoredIds={removal.restoredIds}
              projects={projects}
              onWantProjects={onWantProjects}
              adding={adding}
              onAddingChange={setAdding}
              addButtonRef={addButtonRef}
              onAdd={addMemory}
              onEdit={memory.editMemory}
              onRemove={removal.remove}
              onMove={(entry, project) => void memory.moveMemory(entry, project)}
              overlaps={
                <OverlapsPanel overlaps={overlaps} memories={factsById} onKeep={keepOverlap} onKeepBoth={keepBoth} />
              }
              revealId={revealedId}
              revealEdit={reveal?.edit ?? false}
            />
          </div>
        </div>
      )}

      {/* Procedural memory: methods, not facts — proposed for the account as a whole. */}
      {loaded && !activeScope && <SkillCandidates transport={skillCandidates} />}

      {loaded && <MemoryFooter onSettings={onOpenSettings} onTopics={() => setTopicsOpen(true)} />}
      <ExcludedTopicsDialog open={topicsOpen} onOpenChange={setTopicsOpen} onChanged={() => void memory.reload()} />
      <ClearProjectDialog
        project={clearing}
        onOpenChange={(open) => {
          if (!open) setClearing(null);
        }}
        clearing={memory.resetting}
        onClear={async (projectId) => {
          const ok = await memory.clearProjectMemory(projectId);
          if (ok) changeScope(null);
          return ok;
        }}
      />

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={memory.reload} />
      <ResetDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        resetting={memory.resetting}
        onExport={memory.exportMemory}
        onReset={resetMemory}
      />
      <ReviewDeck
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        items={reviewItems}
        onConfirm={memory.confirmMemory}
        onForget={(entry) => memory.forgetMemory(entry, { silent: true })}
      />
      <ActivitySheet
        open={activityOpen}
        onOpenChange={setActivityOpen}
        tab={activityTab}
        onTabChange={setActivityTab}
        edits={memory.edits}
        busyEditIds={memory.busyEditIds}
        memories={scopedMemories}
        onAccept={acceptEdit}
        onUndo={undoEdit}
        onDelete={memory.deleteEdit}
        loadRecapExtras={loadRecapExtras}
      />
    </div>
  );
}
