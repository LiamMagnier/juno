"use client";

import * as React from "react";
import { AnimatePresence } from "framer-motion";
import { ChevronDown, Plus, Search, type IconComponent } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { MENU_W } from "@/components/ui/menu-recipe";
import { RollingNumber } from "@/components/ui/micro";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MEMORY_CATEGORIES, MEMORY_CATEGORY_META, isMemoryCategory } from "@/lib/memory-categories";
import { cn } from "@/lib/utils";
import { EntryRow } from "@/components/memory/entry-row";
import { MemoryIcons } from "@/components/memory/memory-icons";
import { groupMemoriesByTopic, isRetired, type Memory } from "@/components/memory/memory-model";
import { DATE_BUCKETS, dateBucket } from "@/components/memory/memory-time";
import type { ProjectOption, ProjectOptions } from "@/components/memory/use-project-options";
import type { RemovalKind } from "@/components/memory/use-deferred-removal";

/*
 * Everything Juno remembers, as one list.
 *
 * It used to be three peer views of the same rows: Topics (an accordion of
 * cards, one open at a time), All facts (the same rows sorted by date) and
 * Recap (a report). Reading everything took one click per topic, and the three
 * disagreed about what a row looked like. Now there is one list, grouped by
 * topic as plain headings with every section open, or by date when the reader
 * asks for newest first. A long section shows its first few rows and unfolds
 * the rest in place. The recap moved to the activity sheet, where a report
 * belongs.
 *
 * SEARCH IS CLIENT-SIDE, even though `GET /api/memory?q=` exists: the whole
 * list is already loaded (hundreds of short sentences, not a corpus), so
 * filtering here is instant, keystroke for keystroke. It matches a fact by its
 * words, its topic and its project, because a reader searching "thesis" means
 * the project as readily as the word.
 */

export type MemorySort = "topic" | "newest";

/** Rows a section shows before "Show all". Enough to read the topic, few enough to scan past it. */
const PREVIEW_ROWS = 5;
/** A section folds only when that hides at least this many rows: "Show all" for one more is a click spent on nothing. */
const MIN_FOLDED = 3;

// Copy that differs between the account and one project, named so the copy
// extractor reads it (a string inside a ternary prop is invisible to it).
// Third person is the shape every stored fact takes; showing it in the
// placeholder is cheaper than explaining it after the classifier has filed it.
const ACCOUNT_ADD_PLACEHOLDER = "Something Juno should know, like “I prefer metric units”";
const PROJECT_ADD_PLACEHOLDER = "Something true of this project, like “We cite in APA”";
const ACCOUNT_EMPTY_TITLE = "No memories yet";
const ACCOUNT_EMPTY_DESCRIPTION = "Juno fills this in as you chat. You can also add something yourself.";
const PROJECT_EMPTY_TITLE = "Nothing remembered in this project yet";
const PROJECT_EMPTY_DESCRIPTION = "Juno keeps what it learns in this project’s chats here, apart from everything else.";

interface MemoryListProps {
  /** Facts in scope, active and retired, with any pending removal already taken out. */
  facts: Memory[];
  query: string;
  onQueryChange: (query: string) => void;
  sort: MemorySort;
  onSortChange: (sort: MemorySort) => void;
  /** Writes are refused while memory is off; reading and editing are not. */
  paused: boolean;
  /** The page is showing one project: its rows need no project token, and Add files into it. */
  project: { id: string; name: string } | null;
  busyIds: ReadonlySet<string>;
  highlightIds: ReadonlySet<string>;
  restoredIds: ReadonlySet<string>;
  projects: ProjectOptions;
  onWantProjects: () => void;
  onAdd: (content: string) => Promise<boolean>;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onRemove: (memory: Memory, kind: RemovalKind) => void;
  onMove: (memory: Memory, project: ProjectOption | null) => void;
}

interface Section {
  id: string;
  label: string;
  icon?: IconComponent;
  rows: Memory[];
}

export function MemoryList({
  facts,
  query,
  onQueryChange,
  sort,
  onSortChange,
  paused,
  project,
  busyIds,
  highlightIds,
  restoredIds,
  projects,
  onWantProjects,
  onAdd,
  onEdit,
  onRemove,
  onMove,
}: MemoryListProps) {
  const [adding, setAdding] = React.useState(false);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);
  // The field that had focus folds away with the form, on a save or a cancel;
  // the button that opened it is where a keyboard reader expects to be.
  const closeAdd = React.useCallback(() => {
    setAdding(false);
    requestAnimationFrame(() => addButtonRef.current?.focus());
  }, []);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const [showRetired, setShowRetired] = React.useState(false);

  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;

  // Rows that leave because the reader searched or re-sorted leave at once;
  // only a removal they asked for plays the fold (see EntryRow). The flag is
  // true for exactly the render in which the filter changed.
  const filterKey = `${needle}|${sort}`;
  const lastFilterKey = React.useRef(filterKey);
  const instant = lastFilterKey.current !== filterKey;
  React.useEffect(() => {
    lastFilterKey.current = filterKey;
  }, [filterKey]);

  const matching = React.useMemo(
    () => (searching ? facts.filter((entry) => haystack(entry).includes(needle)) : facts),
    [facts, needle, searching]
  );
  const active = React.useMemo(() => matching.filter((entry) => !isRetired(entry)), [matching]);
  const retired = React.useMemo(
    () => matching.filter(isRetired).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [matching]
  );
  const totalActive = React.useMemo(() => facts.filter((entry) => !isRetired(entry)).length, [facts]);

  const sections = React.useMemo<Section[]>(() => {
    if (sort === "newest") {
      const byBucket = new Map<string, Memory[]>();
      for (const entry of [...active].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        const bucket = dateBucket(entry.createdAt);
        byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), entry]);
      }
      return DATE_BUCKETS.filter((bucket) => byBucket.has(bucket.id)).map((bucket) => ({
        id: bucket.id,
        label: bucket.label,
        rows: byBucket.get(bucket.id) ?? [],
      }));
    }
    return groupMemoriesByTopic(active, topicMetaFor, MEMORY_CATEGORIES)
      .filter((topic) => topic.active.length > 0)
      .map((topic) => ({
        id: topic.id,
        label: topic.label,
        icon: MemoryIcons.forTopic(topic.id),
        // Newest first inside a topic too: the fact most likely to be wrong is
        // the one learned last.
        rows: [...topic.active].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      }));
  }, [active, sort]);

  const toggleSection = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rowProps = {
    showProject: !project,
    projects,
    onWantProjects,
    onEdit,
    onRemove,
    onMove,
  };

  return (
    // `data-memory-list` is the region a removed row hands focus on within
    // (see EntryRow), and the heading is where it lands when no row is left.
    <section aria-labelledby="memory-list-heading" data-memory-list="" className="@container/list">
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="memory-list-heading"
          tabIndex={-1}
          data-memory-list-anchor=""
          className="mr-auto flex items-baseline gap-2 text-heading outline-none"
        >
          <span>Memories</span>
          <span className="text-body font-normal tabular-nums text-muted-foreground">
            <RollingNumber value={totalActive} />
          </span>
        </h2>

        <div className="relative order-last w-full @[34rem]/list:order-none @[34rem]/list:w-60">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                onQueryChange("");
              }
            }}
            type="search"
            aria-label="Search memories"
            placeholder="Search memories"
            className="h-8 pl-9 pr-8 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => onQueryChange("")}
                  className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-safe:animate-fade-in coarse:size-9"
                >
                  <ActionIcons.dismiss className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Clear search</TooltipContent>
            </Tooltip>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1.5 px-2.5 text-muted-foreground" aria-label="Group memories">
              {sort === "topic" ? <span>By topic</span> : <span>Newest first</span>}
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={MENU_W}>
            <DropdownMenuLabel>Group memories</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSortChange(value as MemorySort)}>
              <DropdownMenuRadioItem value="topic">By topic</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <AddButton ref={addButtonRef} paused={paused} open={adding} onToggle={() => setAdding((open) => !open)} />
      </div>

      <Collapse open={adding && !paused}>
        <AddForm
          project={project}
          onAdd={onAdd}
          onClose={closeAdd}
        />
      </Collapse>

      {/* A search changes the rows under a screen reader without a word; this
          says how many are left. Always mounted, so the change is announced. */}
      <p role="status" className="sr-only">
        {searching &&
          (matching.length === 1 ? (
            <span>1 memory matches</span>
          ) : (
            <>
              <span>{matching.length}</span> <span>memories match</span>
            </>
          ))}
      </p>

      {facts.length === 0 ? (
        <EmptyState
          size="panel"
          className="mt-4"
          icon={MemoryIcons.topic}
          title={project ? PROJECT_EMPTY_TITLE : ACCOUNT_EMPTY_TITLE}
          description={project ? PROJECT_EMPTY_DESCRIPTION : ACCOUNT_EMPTY_DESCRIPTION}
        />
      ) : searching && matching.length === 0 ? (
        <EmptyState
          size="panel"
          className="mt-4"
          icon={MemoryIcons.search}
          title="Nothing matches that"
          description="Try a shorter word, or search by topic or project name."
          action={
            <Button variant="outline" size="sm" onClick={() => onQueryChange("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div className="mt-2">
          {sections.map((section) => {
            // A search shows every match: capping results is hiding them.
            const foldable = !searching && section.rows.length - PREVIEW_ROWS >= MIN_FOLDED;
            const open = !foldable || expanded.has(section.id);
            const shown = open ? section.rows : section.rows.slice(0, PREVIEW_ROWS);
            const Icon = section.icon;
            return (
              <section key={section.id} aria-labelledby={`memory-section-${section.id}`} className="pt-5 first:pt-3">
                <h3
                  id={`memory-section-${section.id}`}
                  className="flex items-center gap-2 pb-1 text-ui font-medium text-foreground"
                >
                  {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden="true" />}
                  <span>{section.label}</span>
                  <span className="font-normal tabular-nums text-muted-foreground">{section.rows.length}</span>
                </h3>
                <ul className="-mx-3">
                  <AnimatePresence initial={false} custom={instant}>
                    {shown.map((entry, index) => (
                      <EntryRow
                        key={entry.id}
                        memory={entry}
                        busy={busyIds.has(entry.id)}
                        highlighted={highlightIds.has(entry.id)}
                        // Rows past the preview unfold with "Show all"; a row
                        // Undo brought back re-enters where it was.
                        enter={restoredIds.has(entry.id) || (foldable && !instant && index >= PREVIEW_ROWS)}
                        {...rowProps}
                      />
                    ))}
                  </AnimatePresence>
                </ul>
                {foldable && (
                  <button
                    type="button"
                    onClick={() => toggleSection(section.id)}
                    aria-expanded={open}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-control py-1 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none"
                  >
                    {open ? (
                      <span>Show fewer</span>
                    ) : (
                      <>
                        <span>Show all</span>
                        <span className="tabular-nums">{section.rows.length}</span>
                      </>
                    )}
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                        open && "rotate-180"
                      )}
                    />
                  </button>
                )}
              </section>
            );
          })}

          {retired.length > 0 && (
            <div className="mt-6 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setShowRetired((open) => !open)}
                aria-expanded={showRetired}
                aria-controls="memory-retired-list"
                className="flex w-full items-center gap-2 rounded-control py-1.5 text-left text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none"
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 -rotate-90 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                    showRetired && "rotate-0"
                  )}
                />
                {/* The count sits in its own node so the extractor sees a whole phrase. */}
                <span>No longer used</span>
                <span className="tabular-nums">{retired.length}</span>
              </button>
              <Collapse open={showRetired || (searching && retired.length > 0)}>
                <p className="pb-1 pt-0.5 text-caption text-muted-foreground">
                  Replaced by something newer, contradicted, expired, or forgotten at your request. Juno doesn’t use these.
                </p>
                <ul id="memory-retired-list" className="-mx-3">
                  <AnimatePresence initial={false} custom={instant}>
                    {retired.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        memory={entry}
                        busy={busyIds.has(entry.id)}
                        highlighted={highlightIds.has(entry.id)}
                        enter={restoredIds.has(entry.id)}
                        {...rowProps}
                      />
                    ))}
                  </AnimatePresence>
                </ul>
              </Collapse>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const AddButton = React.forwardRef<
  HTMLButtonElement,
  { paused: boolean; open: boolean; onToggle: () => void }
>(function AddButton({ paused, open, onToggle }, ref) {
  const button = (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      disabled={paused}
      aria-expanded={open}
      onClick={onToggle}
      className="gap-1.5 px-2.5"
    >
      {/* The plus rests at 45° while the field is open, so the control that
          opened it reads as the one that closes it. The turn is on a wrapper:
          the glyph's own hover articulation would out-rank a utility on the svg. */}
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex transition-transform duration-base ease-in-out motion-reduce:transition-none",
          open && "rotate-45"
        )}
      >
        <Plus motion="none" className="size-3.5" />
      </span>
      Add
    </Button>
  );
  if (!paused) return button;
  // A disabled button takes no pointer events, so the tooltip that says why
  // hangs on a focusable wrapper instead.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-control">
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>Turn memory on to add to it</TooltipContent>
    </Tooltip>
  );
});

function AddForm({
  project,
  onAdd,
  onClose,
}: {
  project: { id: string; name: string } | null;
  onAdd: (content: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    const timer = window.setTimeout(() => fieldRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, []);

  React.useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [draft]);

  const submit = async () => {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    const ok = await onAdd(content);
    setSaving(false);
    if (ok) {
      setDraft("");
      onClose();
    } else {
      fieldRef.current?.focus();
    }
  };

  return (
    <form
      className="pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={fieldRef}
        value={draft}
        rows={1}
        maxLength={500}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={project ? PROJECT_ADD_PLACEHOLDER : ACCOUNT_ADD_PLACEHOLDER}
        aria-label="New memory"
        className="block w-full resize-none overflow-hidden rounded-field border border-input bg-background px-3 py-2 text-ui text-foreground outline-none transition-colors duration-fast ease-out-soft placeholder:text-muted-foreground focus-visible:border-foreground/60"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="min-w-0 text-caption text-muted-foreground">
          {project ? (
            <>
              <span>Only chats in</span> <span translate="no">{project.name}</span> <span>will use it.</span>
            </>
          ) : (
            "Every chat can use it."
          )}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" loading={saving} disabled={!draft.trim()}>
            Save
          </Button>
        </div>
      </div>
    </form>
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
 * Category id to the section's identity. Rows written before Memory v2 carry
 * no category, and a newer build could write one this bundle has never heard
 * of; both land under "Uncategorised" rather than under a raw enum value.
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
