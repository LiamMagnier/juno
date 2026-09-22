"use client";

import * as React from "react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { openSettings } from "@/components/settings/settings-sections";
import { SummaryCard } from "@/components/memory/summary-card";
import { PrivacyStrip } from "@/components/memory/privacy-strip";
import { EditsPanel } from "@/components/memory/edits-panel";
import { EntryList } from "@/components/memory/entry-list";
import { MemoryStats } from "@/components/memory/memory-stats";
import { ImportDialog } from "@/components/memory/import-dialog";
import { MemoryToolbar, type MemoryView } from "@/components/memory/memory-toolbar";
import { TopicsView } from "@/components/memory/topics-view";
import { RecapView } from "@/components/memory/recap-view";
import { useMemory } from "@/components/memory/use-memory";
import { groupMemoriesByTopic, isRetired, type Memory } from "@/components/memory/memory-model";
import { MEMORY_CATEGORIES, MEMORY_CATEGORY_META, isMemoryCategory } from "@/lib/memory-categories";
import { staggerDelay } from "@/lib/motion";

/**
 * The memory manager: what Juno knows, why it knows it, and every way to
 * change it.
 *
 * ONE COMPONENT, TWO HOMES — the `/memory` page and the Memory section of
 * settings. `compact` is the difference, and it is a question of how much room
 * there is rather than how much the user is allowed to do: inside the settings
 * modal the summary and the privacy controls are the whole of it, because a
 * scrollable list of two hundred facts nested in a scrollable pane is not
 * usable at that size. The page gets the lot.
 *
 * WHAT CHANGED. This used to render the summary and the privacy strip alone,
 * and post instructions to a route that did not exist. `EntryList` and
 * `EditsPanel` were finished components nothing imported. The whole of the
 * server's memory model — categories, provenance, supersession, confidence,
 * project scope — was reachable by API and invisible in the product. The
 * wiring lives in `useMemory`; this file is the composition.
 */
export function MemoryManager({ compact = false }: { compact?: boolean }) {
  const memory = useMemory();
  const [view, setView] = React.useState<MemoryView>("topics");
  const [query, setQuery] = React.useState("");
  const [editsOpen, setEditsOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);

  /*
   * A drafted edit opens the queue that holds it.
   *
   * The instruction bar is at the top of the summary card and the diff it
   * produces is in a collapsed panel below — so an instruction that worked
   * perfectly looked, from the reader's seat, like a toast and nothing else.
   * Watching the PENDING count rather than the list length is what keeps a
   * ledger full of old applied edits from opening the panel — they are not
   * waiting on anyone — and what leaves the panel alone on an accept, which
   * lowers the count. A pending edit found on load DOES open it, on purpose:
   * a drafted change from a previous visit is still waiting for a decision,
   * and a collapsed panel with "1 pending" in its corner is easy to miss.
   */
  const pendingCount = memory.edits.filter((edit) => edit.status === "pending").length;
  const lastPending = React.useRef(pendingCount);
  React.useEffect(() => {
    if (pendingCount > lastPending.current) setEditsOpen(true);
    lastPending.current = pendingCount;
  }, [pendingCount]);

  const facts = React.useMemo(
    () => (memory.memories ?? []).filter((entry) => entry.kind === "FACT"),
    [memory.memories]
  );

  // Matched against the fact, its topic label and its project name — a user
  // searching "thesis" means the project as readily as the word, and a search
  // that only reads `content` makes the scope chip look like a lie.
  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return facts;
    return facts.filter((entry) => haystack(entry).includes(needle));
  }, [facts, query]);

  const topics = React.useMemo(
    () => groupMemoriesByTopic(visible, topicMetaFor, MEMORY_CATEGORIES),
    [visible]
  );

  const activeCount = React.useMemo(() => facts.filter((entry) => !isRetired(entry)).length, [facts]);
  const retiredCount = facts.length - activeCount;
  const filtered = query.trim().length > 0;

  if (memory.loadError) {
    return (
      <EmptyState
        tone="error"
        size={compact ? "panel" : "page"}
        icon={StatusIcons.error}
        title="Couldn’t load your memory"
        description="Check your connection and try again. Nothing has been changed."
        action={
          <Button variant="outline" size="sm" onClick={() => void memory.reload()}>
            <ActionIcons.refresh className="size-4" aria-hidden="true" />
            Retry
          </Button>
        }
      />
    );
  }

  if (memory.memories === null) {
    return (
      <div className="space-y-3" aria-hidden="true">
        <Skeleton style={staggerDelay(0, "tight")} className="h-64 w-full rounded-card" />
        <Skeleton style={staggerDelay(1, "tight")} className="h-20 w-full rounded-card" />
        {!compact && <Skeleton style={staggerDelay(2, "tight")} className="h-48 w-full rounded-card" />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!compact && (
        <MemoryStats
          activeCount={activeCount}
          retiredCount={retiredCount}
          paused={memory.paused}
          onLearned={memory.reload}
        />
      )}

      <SummaryCard
        summary={memory.summary}
        paused={memory.paused}
        consolidating={memory.busy}
        onRegenerate={() => void memory.regenerate()}
        onInstruction={memory.instruct}
      />

      {memory.policyNotice && (
        <div
          role="status"
          aria-live="polite"
          className="surface-inset flex flex-wrap items-start gap-x-3 gap-y-2 rounded-card px-4 py-3 text-ui text-foreground motion-safe:animate-fade-in-up"
        >
          <StatusIcons.info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-muted-foreground">{memory.policyNotice}</p>
          <Button variant="outline" size="sm" onClick={() => openSettings("memory")}>
            Background processing
          </Button>
        </div>
      )}

      {/* The review queue sits directly under the composer that fills it —
          an instruction drafted at the top of the card has its diff waiting
          one element below, rather than at the bottom of a long page. */}
      <EditsPanel
        edits={memory.edits}
        open={editsOpen}
        onOpenChange={setEditsOpen}
        busyIds={memory.busyEditIds}
        onAccept={(edit) => void memory.acceptEdit(edit)}
        onUndo={(edit) => void memory.undoEdit(edit)}
        onDelete={(id) => void memory.deleteEdit(id)}
      />

      {!compact && (
        <>
          <MemoryToolbar
            view={view}
            onViewChange={setView}
            query={query}
            onQueryChange={setQuery}
            topicCount={topics.length}
            factCount={visible.length}
            paused={memory.paused}
            onAdd={memory.addMemory}
          />

          {view === "topics" ? (
            <TopicsView
              topics={topics}
              busyIds={memory.busyIds}
              paused={memory.paused}
              filtered={filtered}
              onEdit={memory.editMemory}
              onForget={(entry) => void memory.forgetMemory(entry)}
              onDelete={(entry) => void memory.deleteMemory(entry)}
              onImport={() => setImportOpen(true)}
            />
          ) : view === "recap" ? (
            <RecapView
              // Every row, suppressions included: "what Juno let go of" is
              // built from the block-list's own dates.
              memories={memory.memories}
              busyIds={memory.busyIds}
              paused={memory.paused}
              query={query}
              onEdit={memory.editMemory}
              onForget={(entry) => void memory.forgetMemory(entry)}
              onDelete={(entry) => void memory.deleteMemory(entry)}
            />
          ) : (
            <EntryList
              memories={visible}
              busyIds={memory.busyIds}
              paused={memory.paused}
              filtered={filtered}
              onEdit={memory.editMemory}
              onForget={(entry) => void memory.forgetMemory(entry)}
              onDelete={(entry) => void memory.deleteMemory(entry)}
            />
          )}
        </>
      )}

      <PrivacyStrip
        paused={memory.paused}
        onPausedChange={(next) => void memory.setPaused(next)}
        onExport={memory.exportMemory}
        onImport={() => setImportOpen(true)}
        onReset={() => void memory.resetMemory()}
        resetting={memory.resetting}
        empty={facts.length === 0 && !memory.summary}
      />

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={memory.reload} />
    </div>
  );
}

/** Everything a search should be able to find a fact by. */
function haystack(entry: Memory): string {
  return [
    entry.content,
    entry.projectName ?? "",
    isMemoryCategory(entry.category) ? MEMORY_CATEGORY_META[entry.category].label : "",
    entry.reason ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Category id → the card's identity.
 *
 * Rows written before Memory v2 carry no category, and a row written by a
 * newer build could carry one this bundle has never heard of. Both land in the
 * same "Uncategorised" bucket with an honest description, rather than in a
 * card named after a raw enum value or in no card at all.
 */
function topicMetaFor(category: string | null): { id: string; label: string; description: string } {
  if (isMemoryCategory(category)) {
    return { id: category, ...MEMORY_CATEGORY_META[category] };
  }
  return {
    id: "uncategorised",
    label: "Uncategorised",
    description: "Facts Juno kept before it started filing them by subject.",
  };
}
