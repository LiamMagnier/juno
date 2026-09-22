"use client";

import * as React from "react";
import { AnimatePresence } from "framer-motion";
import { ChevronDown, MessageSquare } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { MemoryIcons } from "@/components/memory/memory-icons";
import { cn } from "@/lib/utils";
import { EntryRow } from "@/components/memory/entry-row";
import { isRetired, type Memory } from "@/components/memory/memory-model";

/*
 * The entry list — what Juno remembers, one fact at a time, unsorted by topic.
 *
 * The page used to hold these rows without ever showing them: the consolidated
 * summary was the whole interface. That reads well until a fact is wrong, at
 * which point the user has no row to point at, no way to see whether Juno
 * believes it because they said so or because a background model guessed, and
 * no way to tell an account-wide fact from one that should never have left a
 * project. Prose cannot carry provenance. Rows can.
 *
 * It survives alongside the topics view rather than being replaced by it,
 * because the two answer different questions. Topics answer "what does Juno
 * think I'm like"; this answers "what did it learn, and when" — newest first,
 * every subject interleaved, which is the only reading that shows you what
 * yesterday's conversation actually added.
 */

interface EntryListProps {
  memories: Memory[];
  busyIds: ReadonlySet<string>;
  paused: boolean;
  /** True when a search or filter is narrowing the list — a different empty. */
  filtered: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onForget: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}

export function EntryList({
  memories,
  busyIds,
  paused,
  filtered,
  onEdit,
  onForget,
  onDelete,
}: EntryListProps) {
  const [showRetired, setShowRetired] = React.useState(false);

  // Suppressions are a block-list, not memories — they have their own strip on
  // the page and listing them here would read as "Juno remembers that you asked
  // it to forget X", which is the opposite of what the user did.
  const facts = memories.filter((memory) => memory.kind === "FACT");
  const active = facts.filter((memory) => !isRetired(memory));
  const retired = facts.filter(isRetired);

  return (
    <section
      aria-labelledby="memory-entries-heading"
      className="overflow-hidden rounded-panel border border-border/60 bg-card"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 pb-2 pt-4">
        <h2 id="memory-entries-heading" className="font-sans text-heading">
          Individual facts
        </h2>
        {/* Forgetting or deleting a fact removes a row and changes nothing
            else on screen; announcing the tally is how that reaches a screen
            reader as an outcome rather than as silence. */}
        <p role="status" aria-live="polite" className="font-mono text-caption text-muted-foreground">
          <span>{active.length}</span> <span>in use</span>
          {retired.length > 0 && (
            <>
              {" · "}
              <span>{retired.length}</span> <span>retired</span>
            </>
          )}
        </p>
      </div>
      <p className="px-4 pb-3 text-caption text-muted-foreground">
        {paused
          ? "Memory is paused, so none of these are used as context right now."
          : "Every one of these can be edited, forgotten, or deleted. Nothing here is used in a chat it isn’t scoped to."}
      </p>

      {active.length === 0 && retired.length === 0 ? (
        <div className="border-t border-border/50">
          <EmptyState
            size="panel"
            icon={filtered ? MemoryIcons.search : MessageSquare}
            title={filtered ? "Nothing matches that" : "Nothing specific yet"}
            description={
              filtered
                ? "Try a shorter word, or clear the filters to see everything Juno remembers."
                : "Facts appear here as you chat."
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-border/50 border-t border-border/50">
          <AnimatePresence initial={false}>
            {active.map((memory) => (
              <EntryRow
                key={memory.id}
                memory={memory}
                busy={busyIds.has(memory.id)}
                paused={paused}
                onEdit={onEdit}
                onForget={onForget}
                onDelete={onDelete}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}

      {retired.length > 0 && (
        <div className="border-t border-border/50">
          <button
            type="button"
            onClick={() => setShowRetired((open) => !open)}
            aria-expanded={showRetired}
            aria-controls="memory-retired-list"
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent/40 hover:text-foreground motion-reduce:transition-none"
          >
            {/* A-to-B with both ends on screen: the caret turns on the in-out
                curve at the base rung, in step with the panel it opens. */}
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                showRetired && "rotate-180"
              )}
              aria-hidden="true"
            />
            {/* The count sits in its own node so the localization extractor
                sees a whole sentence rather than a fragment ending in "(". */}
            <span>What Juno stopped believing</span>
            <span className="font-mono text-caption">{retired.length}</span>
          </button>
          {/* Grid-rows collapse, the same disclosure every other panel uses:
              height animates through grid-template-rows so the list needs no
              measured height, and the rows stay mounted — `inert` is what keeps
              a closed list out of the tab order and the accessibility tree. */}
          <div
            id="memory-retired-list"
            className={cn(
              "grid transition-[grid-template-rows,opacity] duration-base ease-out-soft motion-reduce:transition-none",
              showRetired ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
            )}
          >
            <div className="min-h-0 overflow-hidden" inert={!showRetired}>
              <ul className="divide-y divide-border/50 border-t border-border/50">
                <AnimatePresence initial={false}>
                  {retired.map((memory) => (
                    <EntryRow
                      key={memory.id}
                      memory={memory}
                      busy={busyIds.has(memory.id)}
                      paused={paused}
                      onEdit={onEdit}
                      onForget={onForget}
                      onDelete={onDelete}
                    />
                  ))}
                </AnimatePresence>
              </ul>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
