"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { EyeOff, FolderLock, Loader2, MessageSquare, ShieldAlert } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { sensitiveTopicLabel } from "@/lib/memory-sensitive";
import { duration, ease } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { isRetired, type Memory } from "@/components/memory/memory-model";

/*
 * One remembered fact, as a row.
 *
 * Lifted out of `entry-list.tsx` because the topics view needs the same row and
 * a second copy of it is how the two surfaces would drift — one gaining the
 * sensitive chip, the other keeping the old provenance line, with nothing to
 * notice the difference. Everything a row can do (rewrite, forget, delete) and
 * everything it says about itself (category, scope, confidence, status,
 * sensitivity, where it came from, when it was last used) lives here.
 *
 * THE ROW IS A PRESENCE ELEMENT. Deleting one used to be a splice: the row
 * vanished and every row beneath it jumped up a notch, in one frame, with no
 * indication that the thing that left was the thing you pressed. It now
 * collapses its own height on the way out, so the gap closing IS the
 * confirmation — which matters more here than on most lists, because the
 * control next to it ("forget") is destructive in a different way and the two
 * have to feel different.
 */

interface EntryRowProps {
  memory: Memory;
  busy: boolean;
  /** Memory paused: the row still edits, but says its facts are not in use. */
  paused?: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onForget: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}

export function EntryRow({ memory, busy, paused = false, onEdit, onForget, onDelete }: EntryRowProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(memory.content);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const editButtonRef = React.useRef<HTMLButtonElement>(null);
  const wasEditing = React.useRef(false);
  const reduceMotion = useReducedMotion() ?? false;

  // A fact rewritten elsewhere (an applied instruction, another tab) must not
  // leave this row's draft holding the old sentence the next time it opens.
  React.useEffect(() => {
    if (!editing) setDraft(memory.content);
  }, [editing, memory.content]);

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

  const retired = isRetired(memory);
  const statusMeta = isMemoryStatus(memory.status) ? MEMORY_STATUS_META[memory.status] : null;
  const categoryMeta = isMemoryCategory(memory.category) ? MEMORY_CATEGORY_META[memory.category] : null;

  return (
    <motion.li
      layout={!reduceMotion}
      // No `initial`: a row that is merely being rendered (the list loaded, a
      // topic opened) has not arrived from anywhere, and animating it in would
      // make every scroll into a performance. Only the EXIT is animated,
      // because leaving is the one thing the user caused.
      exit={
        reduceMotion
          ? { opacity: 0, transition: { duration: duration.exit } }
          : { opacity: 0, height: 0, marginTop: 0, marginBottom: 0, transition: { duration: duration.exit, ease: ease.in } }
      }
      className={cn(
        "group/fact overflow-hidden px-4 py-3 transition-colors duration-fast ease-out-soft hover:bg-muted/40 motion-reduce:transition-none",
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
          <Button type="submit" size="icon-sm" variant="ghost" disabled={busy} aria-label="Save this memory" title="Save">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <StatusIcons.success className="size-3.5" />}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Cancel editing"
            title="Cancel"
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
            <p className={cn("text-ui text-foreground/90", retired && "line-through decoration-muted-foreground/50")}>
              {memory.content}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="soft" title={categoryMeta?.description}>
                {memoryCategoryLabel(memory.category)}
              </Badge>
              {memory.sensitive && (
                // Warning-tinted rather than soft: this chip is the one that
                // says "you may not have meant to keep this", and it has to
                // out-rank the category chip beside it to do that job.
                <Badge
                  variant="outline"
                  className="gap-1 border-warning/40 bg-warning/10"
                  title="A sensitive subject. Juno only learns these on its own when you turn the topic on in Settings → Memory."
                >
                  <ShieldAlert className="size-3" aria-hidden="true" />
                  {sensitiveTopicLabel(memory.sensitive)}
                </Badge>
              )}
              {memory.projectId && (
                <Badge variant="outline" className="gap-1" title="Only chats in this project can see this memory.">
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
              {paused && !retired && (
                <Badge variant="muted" title="Memory is paused, so nothing here reaches a conversation.">
                  Not in use
                </Badge>
              )}
            </div>
            <ProvenanceLine memory={memory} />
            {memory.reason && <p className="mt-1 text-caption italic text-muted-foreground/80">{memory.reason}</p>}
          </div>
          {/* The row's verbs arrive with the pointer (or focus, or a coarse
              pointer, or a delete in flight) — a column of three glyphs on
              every fact was the loudest thing in a list meant for reading. */}
          <div
            className={cn(
              "flex shrink-0 items-center gap-0.5 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover/fact:opacity-100 coarse:opacity-100 motion-reduce:transition-none",
              busy ? "opacity-100" : "opacity-0"
            )}
          >
            <Button
              ref={editButtonRef}
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit: ${memory.content}`}
              title="Edit"
              className="text-muted-foreground"
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
                className="text-muted-foreground"
                onClick={() => onForget(memory)}
                disabled={busy}
              >
                <EyeOff className="size-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="danger-hover text-muted-foreground"
              aria-label={`Delete: ${memory.content}`}
              title="Delete"
              onClick={() => onDelete(memory)}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ActionIcons.delete className="size-3.5" />}
            </Button>
          </div>
        </div>
      )}
    </motion.li>
  );
}

/** Where a fact came from, when it arrived, and when it was last leaned on. */
function ProvenanceLine({ memory }: { memory: Memory }) {
  const learnedFrom = (() => {
    if (memory.sourceRef === "manual") return "You added this";
    if (memory.sourceRef === "edit") return "From an edit you made";
    if (memory.sourceRef === "forget") return "From a fact you forgot";
    if (memory.sourceRef === "import") return "Imported from another assistant";
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
          className="inline-flex items-center gap-1.5 underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline motion-reduce:transition-none"
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
