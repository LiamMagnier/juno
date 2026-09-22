"use client";

import * as React from "react";
import { History, List, Plus, Search } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { MemoryIcons } from "@/components/memory/memory-icons";
import { cn } from "@/lib/utils";

/*
 * Search, shape, and the one way to add a fact by hand.
 *
 * SEARCH IS CLIENT-SIDE, even though `GET /api/memory?q=` exists and works.
 * The whole list is already loaded (an account's facts are hundreds of short
 * sentences, not a corpus), so filtering in the browser is instant and
 * keystroke-for-keystroke, where the round-trip version spends 120ms per
 * character to return a subset of what is already on the page. The server
 * parameter stays for callers that are not this page.
 *
 * THE VIEW SWITCH IS NOT A PREFERENCE. The three readings answer different
 * questions — "what does Juno think I'm like" (Topics), "what did it learn,
 * newest first" (All facts) and "what changed lately" (Recap) — so the switch
 * is on the toolbar where the question is being asked, not buried in settings.
 * The search applies to all three.
 */

export type MemoryView = "topics" | "list" | "recap";

interface MemoryToolbarProps {
  view: MemoryView;
  onViewChange: (view: MemoryView) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Tallies for the two segments, so the switch says what it would show. */
  topicCount: number;
  factCount: number;
  /** Adding is refused while memory is paused, like every other write. */
  paused: boolean;
  onAdd: (content: string) => Promise<boolean>;
  /** What the add field suggests — a project's page suggests something about the project. */
  addPlaceholder?: string;
}

export function MemoryToolbar({
  view,
  onViewChange,
  query,
  onQueryChange,
  topicCount,
  factCount,
  paused,
  onAdd,
  addPlaceholder,
}: MemoryToolbarProps) {
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const addRef = React.useRef<HTMLInputElement>(null);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);
  const wasAdding = React.useRef(false);

  React.useEffect(() => {
    if (adding) {
      wasAdding.current = true;
      const timer = setTimeout(() => addRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
    if (wasAdding.current) addButtonRef.current?.focus();
    wasAdding.current = false;
  }, [adding]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    const ok = await onAdd(content);
    setSaving(false);
    if (ok) {
      setDraft("");
      setAdding(false);
    } else {
      addRef.current?.focus();
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                onQueryChange("");
              }
            }}
            type="search"
            // `aria-label` rather than a visible one: the magnifier and the
            // placeholder already say what the field is, and a label above a
            // 36px control in a toolbar row costs more height than it explains.
            aria-label="Search what Juno remembers"
            placeholder="Search what Juno remembers…"
            className="h-9 pl-9 pr-9"
          />
          {query && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Clear the search"
              title="Clear search"
              onClick={() => {
                onQueryChange("");
                searchRef.current?.focus();
              }}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground motion-safe:animate-fade-in"
            >
              <ActionIcons.dismiss className="size-3.5" />
            </Button>
          )}
        </div>

        <SegmentedControl<MemoryView>
          value={view}
          onChange={onViewChange}
          ariaLabel="How to group what Juno remembers"
          className="shrink-0"
          options={[
            { value: "topics", label: "Topics", icon: <MemoryIcons.topic className="size-3.5" />, count: topicCount },
            { value: "list", label: "All facts", icon: <List className="size-3.5" />, count: factCount },
            { value: "recap", label: "Recap", icon: <History className="size-3.5" /> },
          ]}
        />

        <Button
          ref={addButtonRef}
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={paused}
          aria-label={paused ? "Add a memory — unavailable while memory is paused" : "Add a memory yourself"}
          aria-expanded={adding}
          onClick={() => setAdding((open) => !open)}
        >
          {/* The plus rests at 45° while the field is open, so the control
              that opened the field reads as the one that closes it. The turn
              is on a wrapper: the glyph's own transition (its hover
              articulation, globals.css) would out-rank a utility on the svg. */}
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex transition-transform duration-base ease-in-out motion-reduce:transition-none",
              adding && "rotate-45"
            )}
          >
            <Plus className="size-3.5" />
          </span>
          Add
        </Button>
      </div>

      {/* The add field is a disclosure rather than a permanent input: a page
          whose first control is an empty text box reads as a form, and this
          page is mostly for reading. Grid-rows collapse, the same idiom as
          every other disclosure in the product. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-base ease-out-soft motion-reduce:transition-none",
          adding ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!adding}>
          <form onSubmit={submit} className="flex items-center gap-1.5 pt-0.5">
            <Input
              ref={addRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft("");
                  setAdding(false);
                }
              }}
              maxLength={500}
              // Third person, because that is the shape every stored fact
              // takes — showing it in the placeholder is cheaper than
              // explaining it after the classifier has filed it oddly.
              placeholder={addPlaceholder ?? "Something durable about you — “I prefer metric units”"}
              aria-label="A new memory"
              className="h-9"
            />
            <Button type="submit" size="sm" disabled={saving || !draft.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft("");
                setAdding(false);
              }}
            >
              Cancel
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
