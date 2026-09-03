"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, EyeOff, FolderLock, Loader2, MessageSquare } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import {
  MEMORY_CATEGORY_META,
  MEMORY_STATUS_META,
  confidenceLabel,
  isMemoryCategory,
  isMemoryStatus,
  memoryCategoryLabel,
} from "@/lib/memory-categories";
import { cn } from "@/lib/utils";
import type { Memory } from "./memory-model";

/*
 * The entry list — what Juno remembers, one fact at a time.
 *
 * The page used to hold these rows without ever showing them: the consolidated
 * summary was the whole interface. That reads well until a fact is wrong, at
 * which point the user has no row to point at, no way to see whether Juno
 * believes it because they said so or because a background model guessed, and
 * no way to tell an account-wide fact from one that should never have left a
 * project. Prose cannot carry provenance. Rows can.
 */

/** Retired entries are the trail, not the memory — collapsed until asked for. */
const RETIRED_STATUSES = new Set(["superseded", "contradicted", "suppressed", "expired"]);

function ProvenanceLine({ memory }: { memory: Memory }) {
  const learnedFrom = (() => {
    if (memory.sourceRef === "manual") return "You added this";
    if (memory.sourceRef === "edit") return "From an edit you made";
    if (memory.sourceRef === "forget") return "From a fact you forgot";
    if (memory.source === "MANUAL") return "You told Juno";
    return null;
  })();

  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
      {learnedFrom ? (
        <span>{learnedFrom}</span>
      ) : memory.sourceRef ? (
        <Link
          href={`/chat/${memory.sourceRef}`}
          className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
        >
          <MessageSquare className="size-3" aria-hidden="true" />
          Remembered from a chat
        </Link>
      ) : (
        <span>Remembered from your chats</span>
      )}
      <span aria-hidden="true">·</span>
      <span>{timeAgo(memory.createdAt)}</span>
      {memory.lastUsedAt && (
        <>
          <span aria-hidden="true">·</span>
          <span>used {timeAgo(memory.lastUsedAt)}</span>
        </>
      )}
      {memory.expiresAt && (
        <>
          <span aria-hidden="true">·</span>
          <span>expires {new Date(memory.expiresAt).toLocaleDateString()}</span>
        </>
      )}
    </p>
  );
}

interface EntryRowProps {
  memory: Memory;
  busy: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onForget: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}

function EntryRow({ memory, busy, onEdit, onForget, onDelete }: EntryRowProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(memory.content);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const editButtonRef = React.useRef<HTMLButtonElement>(null);
  const wasEditing = React.useRef(false);

  // The row swaps its text for an input, which destroys the focused element —
  // hand focus to whichever control took its place so keyboard users aren't
  // dropped back to the top of the document.
  React.useEffect(() => {
    if (editing) {
      wasEditing.current = true;
      const timer = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
    if (wasEditing.current) editButtonRef.current?.focus();
    wasEditing.current = false;
  }, [editing]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (!next || next === memory.content) {
      setEditing(false);
      return;
    }
    if (await onEdit(memory.id, next)) setEditing(false);
    else inputRef.current?.focus();
  };

  const retired = RETIRED_STATUSES.has(memory.status);
  const statusMeta = isMemoryStatus(memory.status) ? MEMORY_STATUS_META[memory.status] : null;
  const categoryMeta = isMemoryCategory(memory.category) ? MEMORY_CATEGORY_META[memory.category] : null;

  return (
    // A hover tint is the only thing telling you the row's controls belong to
    // THIS fact rather than the one above it — the rows are divided by a hairline
    // and nothing else, which on the black ground is very little.
    <li
      className={cn(
        "px-4 py-3 transition-colors duration-fast ease-out-soft hover:bg-muted/40 motion-reduce:transition-none",
        retired && "opacity-70"
      )}
    >
      {editing ? (
        <form onSubmit={save} className="flex items-center gap-1.5">
          <Input
            ref={inputRef}
            value={draft}
            maxLength={500}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(memory.content);
                setEditing(false);
              }
            }}
            aria-label="Edit this memory"
            className="h-9"
          />
          <Button type="submit" size="icon-sm" variant="ghost" disabled={busy} aria-label="Save this memory">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <StatusIcons.success className="size-3.5" />}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Cancel editing"
            onClick={() => {
              setDraft(memory.content);
              setEditing(false);
            }}
          >
            <ActionIcons.dismiss className="size-3.5" />
          </Button>
        </form>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className={cn("text-sm text-foreground/90", retired && "line-through decoration-muted-foreground/50")}>
              {memory.content}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="soft" title={categoryMeta?.description}>
                {memoryCategoryLabel(memory.category)}
              </Badge>
              {memory.projectId && (
                <Badge
                  variant="outline"
                  className="gap-1"
                  title="Only chats in this project can see this memory."
                >
                  <FolderLock className="size-3" aria-hidden="true" />
                  {memory.projectName ?? "One project"}
                </Badge>
              )}
              <Badge variant="muted" title="How Juno came to believe this.">
                {confidenceLabel(memory.confidence)}
              </Badge>
              {statusMeta && memory.status !== "active" && (
                <Badge variant="outline" title={statusMeta.description}>
                  {statusMeta.label}
                </Badge>
              )}
            </div>
            <ProvenanceLine memory={memory} />
            {memory.reason && <p className="mt-1 text-caption italic text-muted-foreground/80">{memory.reason}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              ref={editButtonRef}
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit: ${memory.content}`}
              onClick={() => setEditing(true)}
              disabled={busy}
            >
              <ActionIcons.edit className="size-3.5" />
            </Button>
            {memory.status !== "suppressed" && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Forget: ${memory.content}`}
                title="Stop using this, and never learn it again."
                onClick={() => onForget(memory)}
                disabled={busy}
              >
                <EyeOff className="size-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-destructive danger-hover"
              aria-label={`Delete: ${memory.content}`}
              onClick={() => onDelete(memory)}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ActionIcons.delete className="size-3.5" />}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

interface EntryListProps {
  memories: Memory[];
  busyIds: ReadonlySet<string>;
  paused: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onForget: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}

export function EntryList({ memories, busyIds, paused, onEdit, onForget, onDelete }: EntryListProps) {
  const [showRetired, setShowRetired] = React.useState(false);

  // Suppressions are a block-list, not memories — they have their own strip on
  // the page and listing them here would read as "Juno remembers that you asked
  // it to forget X", which is the opposite of what the user did.
  const facts = memories.filter((memory) => memory.kind === "FACT");
  const active = facts.filter((memory) => !RETIRED_STATUSES.has(memory.status));
  const retired = facts.filter((memory) => RETIRED_STATUSES.has(memory.status));

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
            icon={MessageSquare}
            title="Nothing specific yet"
            description="Facts appear here as you chat."
          />
        </div>
      ) : (
        <ul className="divide-y divide-border/50 border-t border-border/50">
          {active.map((memory) => (
            <EntryRow
              key={memory.id}
              memory={memory}
              busy={busyIds.has(memory.id)}
              onEdit={onEdit}
              onForget={onForget}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}

      {retired.length > 0 && (
        <div className="border-t border-border/50">
          <button
            type="button"
            onClick={() => setShowRetired((open) => !open)}
            aria-expanded={showRetired}
            aria-controls="memory-retired-list"
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors duration-fast hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-fast ease-out-soft motion-reduce:transition-none",
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
                {retired.map((memory) => (
                  <EntryRow
                    key={memory.id}
                    memory={memory}
                    busy={busyIds.has(memory.id)}
                    onEdit={onEdit}
                    onForget={onForget}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
