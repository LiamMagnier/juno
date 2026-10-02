"use client";

import * as React from "react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { useApp } from "@/components/app/app-provider";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { openSettings } from "@/components/settings/settings-sections";
import { cn } from "@/lib/utils";
import { ActivitySheet, type ActivityTab } from "@/components/memory/activity-sheet";
import { ImportDialog } from "@/components/memory/import-dialog";
import { MemoryFooter, ResetDialog } from "@/components/memory/memory-footer";
import { MemoryHeaderActions } from "@/components/memory/memory-header";
import { MemoryList, topicSummary, type MemoryListHandle, type MemorySort } from "@/components/memory/memory-list";
import { MemoryHero } from "@/components/memory/memory-hero";
import "@/components/memory/memory.css";
import { BackfillNotice, PausedNotice, PolicyNotice } from "@/components/memory/memory-notices";
import { MemoryBodySkeleton } from "@/components/memory/memory-skeleton";
import { MemoryWelcome } from "@/components/memory/memory-welcome";
import { PromptDock, type PromptDockHandle } from "@/components/memory/prompt-dock";
import type { RecapExtras } from "@/components/memory/recap-view";
import { ScopeBar } from "@/components/memory/scope-bar";
import { SummaryPanel } from "@/components/memory/summary-panel";
import { useBackfill, type BackfillState } from "@/components/memory/use-backfill";
import { useDeferredRemoval } from "@/components/memory/use-deferred-removal";
import { useMemory, type MemoryState } from "@/components/memory/use-memory";
import { useProjectOptions, type ProjectOptions } from "@/components/memory/use-project-options";
import {
  isRetired,
  memoriesInScope,
  memoryScopes,
  type MemoryEditRecord,
} from "@/components/memory/memory-model";
import type { RecapPeriod } from "@/lib/memory-recap";

/*
 * The memory page: what Juno knows, where it came from, and every way to
 * change it.
 *
 * ONE CALM COLUMN. The page used to stack seven bordered surfaces sixteen
 * pixels apart (scope chips, a stats strip, the summary card, a "Manage edits"
 * card, a toolbar with three views, a card per topic, a privacy strip), and
 * none of them was the primary one. Now there is one raised surface, the
 * summary with its prompt bar, and everything else is a list or quiet text:
 *
 *   header      the name, the one On/Off switch, a menu for the rare things
 *   notices     memory is off / a policy refused / reading past chats
 *   scope       only when a project has memory of its own
 *   summary     prose that unfolds in place, the prompt bar at its foot, and
 *               a drafted change right under the bar
 *   list        every memory, by topic or by date, rows on hairlines
 *   footer      what never reaches memory, and import, export, reset
 *
 * The edit history and the recap are one step aside, in the activity sheet.
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
}

const SORT_KEY = "juno.memory.sort";
/** How long a row that a change just touched stays lit. */
const HIGHLIGHT_MS = 1400;
/** Below this many memories, unread history is worth a banner, not just a menu item. */
const THIN_MEMORY = 12;

/** The rows an edit rewrites in place (its adds arrive as new ids). */
function updatedIds(edit: MemoryEditRecord, inverse = false): string[] {
  return (inverse ? edit.inverse ?? [] : edit.operations).flatMap((op) => (op.op === "update" ? [op.id] : []));
}

export function MemoryManagerView({
  memory,
  backfill,
  projects,
  onWantProjects,
  onOpenSettings,
  loadRecapExtras,
}: MemoryManagerViewProps) {
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<MemorySort>("topic");
  /** The project the page is narrowed to, or null for everything. */
  const [scope, setScope] = React.useState<string | null>(null);
  const [scopeSwitched, setScopeSwitched] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [activityOpen, setActivityOpen] = React.useState(false);
  const [activityTab, setActivityTab] = React.useState<ActivityTab>("edits");
  const [composing, setComposing] = React.useState(false);
  // Tracked here rather than read off `memory.busy`, which is also true while
  // an instruction drafts: the Rebuild button spins only for a rebuild.
  const [rebuilding, setRebuilding] = React.useState(false);
  const [highlightIds, setHighlightIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [justApplied, setJustApplied] = React.useState<ReadonlyMap<string, number>>(() => new Map());
  const dockRef = React.useRef<PromptDockHandle>(null);

  // `/memory?project=<id>` is where the project page's "Manage memory" lands.
  // Read off `location` rather than useSearchParams, which would ask for a
  // Suspense boundary around a page that is otherwise plain.
  React.useEffect(() => {
    const requested = new URL(window.location.href).searchParams.get("project");
    if (requested) setScope(requested);
    try {
      const saved = window.localStorage.getItem(SORT_KEY);
      if (saved === "topic" || saved === "newest") setSort(saved);
    } catch {
      // Storage unavailable: the default grouping is fine.
    }
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

  const changeSort = React.useCallback((next: MemorySort) => {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_KEY, next);
    } catch {
      // A grouping that is not remembered is a small loss, not an error.
    }
  }, []);

  const removal = useDeferredRemoval((entry, kind) =>
    kind === "forget" ? memory.forgetMemory(entry, { silent: true }) : memory.deleteMemory(entry, { silent: true })
  );
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

  /*
   * CAUSE AND EFFECT. A change that lands somewhere the reader is not looking
   * (an applied instruction rewrites three rows further down; a fact added from
   * the list header files itself under a topic) lights the rows it touched for
   * a moment. The marker is set before the change and read when the list
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

  // "Tell Juno something" in the welcome unfolds the dock; focus follows it in.
  React.useEffect(() => {
    if (!composing) return;
    const timer = window.setTimeout(() => dockRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [composing]);

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

  // The hero's figures and constellation describe the scope on screen.
  const topics = React.useMemo(() => topicSummary(facts), [facts]);
  const newest = React.useMemo(() => {
    let best: (typeof facts)[number] | null = null;
    for (const entry of facts) {
      if (isRetired(entry)) continue;
      if (!best || entry.createdAt > best.createdAt) best = entry;
    }
    return best;
  }, [facts]);
  const previews = React.useMemo(() => {
    const byTopic: Record<string, string[]> = {};
    const newestFirst = facts.filter((entry) => !isRetired(entry)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const entry of newestFirst) {
      const id = topics.some((t) => t.id === entry.category) ? (entry.category as string) : "uncategorised";
      const list = (byTopic[id] ??= []);
      if (list.length < 3) list.push(entry.content);
    }
    return byTopic;
  }, [facts, topics]);
  const activeCount = React.useMemo(() => facts.filter((entry) => !isRetired(entry)).length, [facts]);
  const listRef = React.useRef<MemoryListHandle>(null);
  const [currentTopic, setCurrentTopic] = React.useState<string | null>(null);
  const liveTopicId = React.useMemo(
    () => (newest ? (topics.find((t) => t.id === (newest.category ?? "uncategorised"))?.id ?? null) : null),
    [newest, topics]
  );
  const showHeroData = loaded && anythingRemembered && !memory.loadError;

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
    />
  );

  return (
    <div className="mem @container/memory">
      <MemoryHero
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
            onReset={() => setResetOpen(true)}
            empty={!anythingRemembered}
          />
        }
        count={activeCount}
        topics={showHeroData ? topics : []}
        lastLearned={newest?.createdAt ?? null}
        liveTopicId={liveTopicId}
        activeId={currentTopic}
        onSelect={(id) => listRef.current?.jumpTo(id)}
        previews={previews}
        scopes={
          loaded && anythingRemembered && scopes.length > 1 ? (
            <ScopeBar scopes={scopes} value={activeScope} onChange={changeScope} />
          ) : undefined
        }
      />
      <div className="h-12" aria-hidden="true" />

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
        <div className="motion-safe:animate-rise-in">
          <MemoryWelcome
            paused={memory.paused}
            unread={backfill.remaining}
            learning={backfill.running}
            onImport={() => setImportOpen(true)}
            onLearn={backfill.run}
            composing={composing || pendingCount > 0}
            onCompose={() => setComposing(true)}
          >
            {dock}
          </MemoryWelcome>
        </div>
      ) : (
        // One entrance for the page body as the data lands; nothing inside it
        // staggers. A scope switch re-plays a fade on the content it changed.
        <div className="motion-safe:animate-rise-in">
          <div key={activeScope ?? "account"} className={cn(scopeSwitched && "motion-safe:animate-fade-in")}>
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
            >
              {/* The drafting model edits account-wide facts, so the bar is
                  offered only where the page is showing the account. */}
              {!activeScope && dock}
            </SummaryPanel>

            <div className="mt-16">
              <MemoryList
                handleRef={listRef}
                onActiveChange={setCurrentTopic}
                facts={facts}
                query={query}
                onQueryChange={setQuery}
                sort={sort}
                onSortChange={changeSort}
                paused={memory.paused}
                project={activeProject}
                busyIds={memory.busyIds}
                highlightIds={highlightIds}
                restoredIds={removal.restoredIds}
                projects={projects}
                onWantProjects={onWantProjects}
                onAdd={addMemory}
                onEdit={memory.editMemory}
                onRemove={removal.remove}
                onMove={(entry, project) => void memory.moveMemory(entry, project)}
              />
            </div>
          </div>
        </div>
      )}

      {loaded && (
        <MemoryFooter
          paused={memory.paused}
          empty={!anythingRemembered}
          onImport={() => setImportOpen(true)}
          onExport={memory.exportMemory}
          onReset={() => setResetOpen(true)}
          onSettings={onOpenSettings}
        />
      )}

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={memory.reload} />
      <ResetDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        resetting={memory.resetting}
        onExport={memory.exportMemory}
        onReset={resetMemory}
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
