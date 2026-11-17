"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Search } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapse } from "@/components/ui/collapse";
import { EmptyState } from "@/components/ui/empty-state";
import { RollingNumber } from "@/components/ui/micro";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { customizeFieldClass } from "@/components/customize/customize-section";
import { cn } from "@/lib/utils";
import { EntryRow } from "@/components/memory/entry-row";
import { MemoryIcons } from "@/components/memory/memory-icons";
import { isRetired, type Memory } from "@/components/memory/memory-model";
import {
  MEMORY_GROUPINGS,
  groupMemories,
  memorySearchText,
  offerSearch,
  type MemoryGrouping,
} from "@/components/memory/memory-groups";
import type { ProjectOption, ProjectOptions } from "@/components/memory/use-project-options";
import type { RemovalKind } from "@/components/memory/use-deferred-removal";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { prefersReducedMotion } from "@/lib/motion-preference";

/*
 * Everything Alevr remembers, as one list on hairlines.
 *
 * GROUPED THE WAY A PERSON SORTS THEIR LIFE (memory-groups.ts): About you,
 * Your work, Preferences, Goals and learning, For now. Or by where each
 * memory came from (what you told Alevr, what it learned in your chats, what
 * was imported), or by when it was said. The list used to sit beside a
 * sticky index of the classifier's nine categories, with a search box, a sort
 * switch and an Add button stacked in that margin; a list of five groups
 * needs no index, and the controls sit on the list's own title line.
 *
 * SEARCH ARRIVES WHEN IT HELPS: once the list is longer than a screen takes
 * in at a glance (offerSearch). It is client-side, even though
 * `GET /api/memory?q=` exists: the whole list is already loaded (short
 * sentences, not a corpus), so filtering here keeps up with every keystroke.
 *
 * ADDING happens at the top of the list, in place: the header's Add memory
 * opens the field here (`adding`), and closing it hands focus back to that
 * button (`addButtonRef`).
 *
 * WHAT NEEDS A LOOK comes first (`overlaps`, the panel the manager draws for
 * memories that may say the same thing or disagree), then the groups, then
 * what memory no longer uses, folded.
 */

/** Rows a group shows before "Show all". Enough to read the group, few enough to scan past it. */
const PREVIEW_ROWS = 5;
/** A group folds only when that hides at least this many rows: "Show all" for one more is a click spent on nothing. */
const MIN_FOLDED = 3;

// Copy that differs between the account and one project, named so the copy
// extractor reads it (a string inside a ternary prop is invisible to it).
// Third person is the shape every stored fact takes; showing it in the
// placeholder is cheaper than explaining it after the classifier has filed it.
const ACCOUNT_ADD_PLACEHOLDER = `Something ${PRODUCT_NAME} should know, like “I prefer metric units”`;
const PROJECT_ADD_PLACEHOLDER = "Something true of this project, like “We cite in APA”";
const ACCOUNT_EMPTY_TITLE = "No memories yet";
const ACCOUNT_EMPTY_DESCRIPTION = `${PRODUCT_NAME} fills this in as you chat. You can also add something yourself.`;
const PROJECT_EMPTY_TITLE = "Nothing remembered in this project yet";
const PROJECT_EMPTY_DESCRIPTION = `${PRODUCT_NAME} keeps what it learns in this project’s chats here, apart from everything else.`;

interface MemoryListProps {
  /** Facts in scope, active and retired, with any pending removal already taken out. */
  facts: Memory[];
  query: string;
  onQueryChange: (query: string) => void;
  grouping: MemoryGrouping;
  onGroupingChange: (grouping: MemoryGrouping) => void;
  /** Writes are refused while memory is off; reading and editing are not. */
  paused: boolean;
  /** The page is showing one project: its rows need no project token, and Add files into it. */
  project: { id: string; name: string } | null;
  busyIds: ReadonlySet<string>;
  highlightIds: ReadonlySet<string>;
  restoredIds: ReadonlySet<string>;
  projects: ProjectOptions;
  onWantProjects: () => void;
  /** The add field is open (the header's Add memory). */
  adding: boolean;
  onAddingChange: (open: boolean) => void;
  /** The control that opened the add field, where focus returns when it closes. */
  addButtonRef: React.RefObject<HTMLButtonElement | null>;
  onAdd: (content: string) => Promise<boolean>;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onRemove: (memory: Memory, kind: RemovalKind) => void;
  onMove: (memory: Memory, project: ProjectOption | null) => void;
  /** Memories that may say the same thing or disagree: drawn above the groups. */
  overlaps?: React.ReactNode;
  /** A fact to bring into view once (`/memory?entry=`): its group unfolds and it scrolls to it. */
  revealId?: string | null;
  /** Open that fact for editing as it arrives (`&edit=1`). */
  revealEdit?: boolean;
}

export function MemoryList({
  facts,
  query,
  onQueryChange,
  grouping,
  onGroupingChange,
  paused,
  project,
  busyIds,
  highlightIds,
  restoredIds,
  projects,
  onWantProjects,
  adding,
  onAddingChange,
  addButtonRef,
  onAdd,
  onEdit,
  onRemove,
  onMove,
  overlaps,
  revealId = null,
  revealEdit = false,
}: MemoryListProps) {
  // The field that had focus folds away with the form, on a save or a cancel;
  // the button that opened it is where a keyboard reader expects to be.
  const closeAdd = React.useCallback(() => {
    onAddingChange(false);
    requestAnimationFrame(() => addButtonRef.current?.focus());
  }, [addButtonRef, onAddingChange]);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const [showRetired, setShowRetired] = React.useState(false);

  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;

  // Rows that leave because the reader searched or regrouped leave at once;
  // only a removal they asked for plays the fold (see EntryRow). The flag is
  // true for exactly the render in which the filter changed.
  const filterKey = `${needle}|${grouping}`;
  const lastFilterKey = React.useRef(filterKey);
  const instant = lastFilterKey.current !== filterKey;
  React.useEffect(() => {
    lastFilterKey.current = filterKey;
  }, [filterKey]);

  const matching = React.useMemo(
    () => (searching ? facts.filter((entry) => memorySearchText(entry).includes(needle)) : facts),
    [facts, needle, searching]
  );
  const retired = React.useMemo(
    () => matching.filter(isRetired).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [matching]
  );
  const totalActive = React.useMemo(() => facts.filter((entry) => !isRetired(entry)).length, [facts]);
  const groups = React.useMemo(() => groupMemories(matching, grouping), [matching, grouping]);

  // A linked fact: unfold whatever hides it, once, then bring it into view.
  const revealed = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!revealId || revealed.current === revealId) return;
    const entry = facts.find((fact) => fact.id === revealId);
    if (!entry) return;
    revealed.current = revealId;
    if (isRetired(entry)) setShowRetired(true);
    else {
      const group = groups.find((candidate) => candidate.rows.some((row) => row.id === revealId));
      const index = group ? group.rows.findIndex((row) => row.id === revealId) : -1;
      if (group && index >= PREVIEW_ROWS) setExpanded((prev) => new Set([...prev, group.id]));
    }
    // After the unfold has rendered the row.
    const frame = window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-memory-id="${CSS.escape(revealId)}"]`);
      row?.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [facts, revealId, groups]);

  const toggleGroup = (id: string) =>
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

  const nothing = facts.length === 0;
  const noMatch = searching && matching.length === 0;
  const showSearch = offerSearch(totalActive, query);

  return (
    // `data-memory-list` is the region a removed row hands focus on within
    // (see EntryRow), and the heading is where it lands when no row is left.
    <section aria-labelledby="memory-list-heading" data-memory-list="">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h2
          id="memory-list-heading"
          tabIndex={-1}
          data-memory-list-anchor=""
          className="flex items-baseline gap-2 text-foreground outline-none"
        >
          <span className="mem-title">Memories</span>
          <span className="mem-count text-ui">
            <RollingNumber value={totalActive} />
          </span>
        </h2>
        {!nothing && (
          <div className="flex w-full flex-wrap items-center gap-2 @[40rem]/page:w-auto">
            {showSearch && <SearchField query={query} onQueryChange={onQueryChange} />}
            <GroupingSwitch value={grouping} onChange={onGroupingChange} />
          </div>
        )}
      </div>

      <Collapse open={adding && !paused}>
        <div className="pt-4">
          <AddForm project={project} onAdd={onAdd} onClose={closeAdd} />
        </div>
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

      {!searching && overlaps ? <div className="mt-5">{overlaps}</div> : null}

      {nothing ? (
        <EmptyState
          size="panel"
          className="mt-5"
          title={project ? PROJECT_EMPTY_TITLE : ACCOUNT_EMPTY_TITLE}
          description={project ? PROJECT_EMPTY_DESCRIPTION : ACCOUNT_EMPTY_DESCRIPTION}
        />
      ) : noMatch ? (
        <EmptyState
          size="panel"
          className="mt-5"
          icon={MemoryIcons.search}
          title="Nothing matches that"
          description="Try a shorter word, or search by group or project name."
          action={
            <Button variant="outline" size="sm" onClick={() => onQueryChange("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div>
          {groups.map((group) => {
            // A search shows every match: capping results is hiding them.
            const foldable = !searching && group.rows.length - PREVIEW_ROWS >= MIN_FOLDED;
            const open = !foldable || expanded.has(group.id);
            const shown = open ? group.rows : group.rows.slice(0, PREVIEW_ROWS);
            return (
              <section
                key={group.id}
                aria-labelledby={`memory-group-${group.id}`}
                data-memory-group={group.id}
                className="mt-8 scroll-mt-6"
              >
                <header className="flex items-baseline gap-2">
                  <h3 id={`memory-group-${group.id}`} className="mem-group text-foreground">
                    {group.label}
                  </h3>
                  <span className="mem-count text-ui">{group.rows.length}</span>
                </header>
                {group.description && (
                  <p className="mt-0.5 max-w-prose text-pretty text-ui text-muted-foreground">{group.description}</p>
                )}
                <ul className="ed-list -mx-3 mt-2">
                  <AnimatePresence initial={false} custom={instant}>
                    {shown.map((entry, rowIndex) => (
                      <EntryRow
                        key={entry.id}
                        memory={entry}
                        busy={busyIds.has(entry.id)}
                        highlighted={highlightIds.has(entry.id)}
                        startEditing={revealEdit && entry.id === revealId}
                        // Rows past the preview unfold with "Show all"; a row
                        // Undo brought back re-enters where it was.
                        enter={restoredIds.has(entry.id) || (foldable && !instant && rowIndex >= PREVIEW_ROWS)}
                        {...rowProps}
                      />
                    ))}
                  </AnimatePresence>
                </ul>
                {foldable && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    aria-expanded={open}
                    className="relative -mx-3 mt-1 inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-ui font-medium text-muted-foreground hit-44 transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground"
                  >
                    {open ? (
                      <span>Show fewer</span>
                    ) : (
                      <>
                        <span>Show all</span>
                        <span className="tabular-nums">{group.rows.length}</span>
                      </>
                    )}
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-4 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                        open && "rotate-180"
                      )}
                    />
                  </button>
                )}
              </section>
            );
          })}

          {retired.length > 0 && (
            <div className="mt-10 border-t border-[var(--mem-hair)] pt-4">
              <button
                type="button"
                onClick={() => setShowRetired((open) => !open)}
                aria-expanded={showRetired}
                aria-controls="memory-retired-list"
                className="relative -mx-3 flex h-9 items-center gap-2 rounded-control px-3 text-left text-ui text-muted-foreground hit-44 transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground"
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-4 -rotate-90 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                    showRetired && "rotate-0"
                  )}
                />
                {/* The count sits in its own node so the extractor sees a whole phrase. */}
                <span className="font-medium">No longer used</span>
                <span className="tabular-nums">{retired.length}</span>
              </button>
              <Collapse open={showRetired || (searching && retired.length > 0)}>
                <p className="max-w-prose pb-2 pt-1 text-ui text-muted-foreground">
                  {`Replaced by something newer, contradicted, expired, or forgotten at your request. ${PRODUCT_NAME} doesn’t use these.`}
                </p>
                <ul id="memory-retired-list" className="ed-list -mx-3">
                  <AnimatePresence initial={false} custom={instant}>
                    {retired.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        memory={entry}
                        busy={busyIds.has(entry.id)}
                        highlighted={highlightIds.has(entry.id)}
                        startEditing={revealEdit && entry.id === revealId}
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

function SearchField({ query, onQueryChange }: { query: string; onQueryChange: (query: string) => void }) {
  return (
    <label className="relative block min-w-0 flex-1 @[40rem]/page:w-60 @[40rem]/page:flex-none">
      <span className="sr-only">Search memories</span>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.preventDefault();
            onQueryChange("");
          }
        }}
        placeholder="Search memories"
        className={cn(
          "h-8 w-full rounded-field border pl-9 pr-8 text-ui outline-none transition-[border-color] duration-fast ease-out-soft placeholder:text-muted-foreground coarse:h-11 [&::-webkit-search-cancel-button]:hidden",
          customizeFieldClass
        )}
      />
      {query && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onQueryChange("")}
              className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hit-44 transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground"
            >
              <ActionIcons.dismiss className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Clear search</TooltipContent>
        </Tooltip>
      )}
    </label>
  );
}

/** Topic, source or date, as three segments: every choice visible, one press to switch. */
function GroupingSwitch({ value, onChange }: { value: MemoryGrouping; onChange: (grouping: MemoryGrouping) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Group memories by"
      className="flex h-8 shrink-0 items-center rounded-control bg-muted p-0.5 coarse:h-10"
    >
      {MEMORY_GROUPINGS.map(({ id, label }) => {
        const on = value === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(id)}
            className={cn(
              "relative h-full rounded-sm px-2.5 text-ui hit-44 transition-colors duration-fast ease-out-soft",
              on ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {on && (
              // The selected segment is a flat key on the track: the page's
              // ground with a hairline, no shadow.
              <motion.span
                layoutId="memory-grouping-thumb"
                aria-hidden="true"
                className="absolute inset-0 rounded-sm bg-background shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.08)]"
                transition={{ type: "spring", stiffness: 480, damping: 38 }}
              />
            )}
            <span className="relative">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The field a new memory is typed into: one sentence, kept as written. */
export function AddForm({
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
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
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
        className="block min-h-0 resize-none overflow-hidden px-3 py-2"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="min-w-0 text-ui text-muted-foreground">
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

/** Topics in scope with their active counts. */
export function topicSummary(facts: Memory[]): { id: string; label: string; count: number }[] {
  return groupMemories(facts, "topic").map((group) => ({ id: group.id, label: group.label, count: group.rows.length }));
}
