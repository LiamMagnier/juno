"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { EyeOff, Folder, FolderLock, MessageSquare, MessagesSquare, ShieldAlert } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { MENU_W, MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MEMORY_STATUS_META, isMemoryStatus } from "@/lib/memory-categories";
import { sensitiveTopicLabel } from "@/lib/memory-sensitive";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { isRetired, type Memory } from "@/components/memory/memory-model";
import { relativeTime, shortDate } from "@/components/memory/memory-time";
import type { ProjectOption, ProjectOptions } from "@/components/memory/use-project-options";
import type { RemovalKind } from "@/components/memory/use-deferred-removal";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * One remembered fact: a line of text, one muted line about it, and a menu.
 *
 * WHAT THE ROW STOPPED SAYING. It used to carry up to six badges (topic,
 * sensitivity, project, confidence, status, "not in use"), a provenance line
 * and an italic reason, so a one-line fact could stand four lines tall and the
 * list read as a database. The topic is the section the row sits in; the
 * confidence was on every row, so it distinguished none of them; "not in use"
 * repeated a paused banner on every line. What is left is what a reader acts
 * on: where the fact came from and when, plus the two tokens that change what
 * the fact MEANS (a sensitive subject, a project boundary).
 *
 * EDITING IS CLICKING THE TEXT. The sentence becomes a field in place, the same
 * size and at the same spot, so the thing being corrected never moves. The
 * menu carries everything else, including Edit for keyboard users.
 *
 * THE ROW IS A PRESENCE ELEMENT. It has no entrance when it is simply rendered
 * (a list loading, a search clearing), because it has not arrived from
 * anywhere. It animates on the way OUT, closing its own grid track so the rows
 * beneath close the gap in the same move, and on the way back IN when an Undo
 * restores it, which is the same move reversed.
 */

interface EntryRowProps {
  memory: Memory;
  busy: boolean;
  /** Draw the project token. Off when the whole page is already that project. */
  showProject: boolean;
  /** A change just landed on this row: flash it once so the eye finds it. */
  highlighted?: boolean;
  /**
   * Arrive by unfolding rather than appearing: a row brought back by Undo, or
   * one revealed by its section's "Show all". Everything else is simply there.
   */
  enter?: boolean;
  /** Projects for the "Move to" menu; null until loaded. */
  projects: ProjectOptions;
  /** Ask for the project list, the first time a menu opens. */
  onWantProjects: () => void;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onRemove: (memory: Memory, kind: RemovalKind) => void;
  onMove: (memory: Memory, project: ProjectOption | null) => void;
}

export function EntryRow({
  memory,
  busy,
  showProject,
  highlighted = false,
  enter = false,
  projects,
  onWantProjects,
  onEdit,
  onRemove,
  onMove,
}: EntryRowProps) {
  const [editing, setEditing] = React.useState(false);
  const reduceMotion = useReducedMotion() ?? false;
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const retired = isRetired(memory);

  const closed = reduceMotion ? { opacity: 0 } : { opacity: 0, gridTemplateRows: "0fr" };
  const variants = {
    closed,
    // The resting state seeds the track in framer's own units: read back from
    // the DOM it would be the resolved pixel height, which does not
    // interpolate with "0fr" and would hold the row open until the last frame.
    open: { opacity: 1, gridTemplateRows: "1fr", transition: transition.symmetric },
    // The list passes `instant` through its AnimatePresence when rows leave
    // because the reader searched or re-sorted: filtering is immediate, and
    // only a removal the reader asked for plays the fold.
    exit: (instant: boolean | undefined) =>
      instant ? { opacity: 0, transition: { duration: 0 } } : { ...closed, transition: transition.exit },
  };

  return (
    <motion.li
      variants={variants}
      initial={enter ? "closed" : false}
      animate="open"
      exit="exit"
      // The hairline between rows is drawn inset to the text column, not by
      // the list's border: the row itself bleeds 12px either side so its hover
      // fill has room around the text, and a border would bleed with it.
      className="relative grid grid-rows-[1fr] before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-border/70 first:before:hidden"
    >
      {/* The clip lives on the track's only item and the padding one level in:
          padding cannot shrink below itself, so a padded item would stop the
          track closing short of zero. */}
      <div className="min-h-0 overflow-hidden">
        {editing ? (
          <RowEditor
            memory={memory}
            busy={busy}
            onSave={async (next) => {
              if (next === memory.content || (await onEdit(memory.id, next))) {
                setEditing(false);
                // The field that had focus is gone; the row's menu button is
                // the nearest control that is still there.
                requestAnimationFrame(() => menuButtonRef.current?.focus());
                return true;
              }
              return false;
            }}
            onCancel={() => {
              setEditing(false);
              requestAnimationFrame(() => menuButtonRef.current?.focus());
            }}
          />
        ) : (
          <div
            // Keyed on the highlight so a second change to the same row replays it.
            key={highlighted ? "flash" : "rest"}
            className={cn(
              "group/row flex items-start gap-2 px-3 py-2.5 transition-colors duration-fast ease-out-soft hover:bg-accent/50 motion-reduce:transition-none",
              highlighted && "animate-cite-flash [animation-duration:var(--dur-emphasis)]"
            )}
          >
            <div className="min-w-0 flex-1">
              <p
                // Clicking the sentence edits it, unless the click ended a text
                // selection: a reader copying a fact is not asking to rewrite it.
                onClick={() => {
                  if (busy || window.getSelection()?.toString()) return;
                  setEditing(true);
                }}
                className={cn(
                  "cursor-text text-pretty text-ui text-foreground",
                  retired && "text-muted-foreground line-through decoration-muted-foreground/40"
                )}
              >
                {memory.content}
              </p>
              <RowMeta memory={memory} showProject={showProject} />
            </div>
            <RowMenu
              memory={memory}
              busy={busy}
              buttonRef={menuButtonRef}
              projects={projects}
              onWantProjects={onWantProjects}
              onEdit={() => setEditing(true)}
              onRemove={onRemove}
              onMove={onMove}
            />
          </div>
        )}
      </div>
    </motion.li>
  );
}

/** The field a fact becomes while it is being corrected. */
function RowEditor({
  memory,
  busy,
  onSave,
  onCancel,
}: {
  memory: Memory;
  busy: boolean;
  onSave: (content: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState(memory.content);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);

  // Grows with the sentence instead of scrolling it sideways, the way the
  // one-line input it replaced clipped any fact longer than the row. It snaps
  // rather than tweening: the field opens at its full height and only changes
  // when a line wraps under the reader's own typing.
  React.useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [draft]);

  React.useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  const save = async () => {
    const next = draft.trim();
    if (!next) return;
    if (!(await onSave(next))) fieldRef.current?.focus();
  };

  return (
    <form
      className="px-3 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <textarea
        ref={fieldRef}
        value={draft}
        rows={1}
        maxLength={500}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // A fact is one sentence, so Enter saves; Shift+Enter still breaks
          // a line for the rare one that needs it.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        aria-label="Edit this memory"
        // The field's text sits exactly where the sentence did: the negative
        // margin cancels the padding that gives the field its edge, out to the
        // row's own edges (the list bleeds the rows 12px past the column).
        className="-mx-3 block w-[calc(100%+1.5rem)] resize-none overflow-hidden rounded-field border border-input bg-background px-3 py-2 text-ui text-foreground outline-none transition-colors duration-fast ease-out-soft focus-visible:border-foreground/60"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-caption text-muted-foreground">Enter to save, Esc to cancel</p>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" loading={busy} disabled={!draft.trim()}>
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Where a fact came from, in words; null for a fact learned from a chat. */
function learnedFrom(memory: Memory): string | null {
  if (memory.sourceRef === "manual") return "You added this";
  if (memory.sourceRef === "edit") return "From an edit you made";
  if (memory.sourceRef === "forget") return "From a fact you forgot";
  if (memory.sourceRef === "import") return "Imported from another assistant";
  if (memory.source === "MANUAL") return `You told ${PRODUCT_NAME}`;
  return null;
}

/** A fact learned from a conversation carries its id; the other sources are words. */
function sourceChatId(memory: Memory): string | null {
  return learnedFrom(memory) === null && memory.sourceRef ? memory.sourceRef : null;
}

/**
 * The one line under a fact. Sans, muted, separated by middots, with the two
 * tokens that change what the fact means at the end of it. The retired status
 * leads, because on a retired row it is the first thing a reader needs.
 */
function RowMeta({ memory, showProject }: { memory: Memory; showProject: boolean }) {
  const words = learnedFrom(memory);
  const chatId = sourceChatId(memory);
  const status = isRetired(memory) && isMemoryStatus(memory.status) ? MEMORY_STATUS_META[memory.status] : null;

  const parts: React.ReactNode[] = [];
  if (status) {
    parts.push(
      <span key="status" title={memory.reason ?? status.description} className="font-medium">
        {status.label}
      </span>
    );
  }
  parts.push(
    words ? (
      <span key="source">{words}</span>
    ) : chatId ? (
      // A link that reads as metadata until it is pointed at: the whole of the
      // "why does Juno think this" question is one click from here.
      <Link
        key="source"
        href={`/chat/${chatId}`}
        className="rounded-xs underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline motion-reduce:transition-none"
      >
        From a chat
      </Link>
    ) : (
      <span key="source">From your chats</span>
    )
  );
  parts.push(<span key="when">{relativeTime(memory.createdAt)}</span>);
  if (memory.expiresAt && !status) {
    parts.push(
      <span key="expires">
        <span>Until</span> <span>{shortDate(memory.expiresAt)}</span>
      </span>
    );
  }

  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-muted-foreground">
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span aria-hidden="true">·</span>}
          {part}
        </React.Fragment>
      ))}
      {memory.sensitive && (
        // Warm-tinted: this is the token that says "you may not have meant to
        // keep this", so it has to out-rank the words beside it.
        <span
          title={`A sensitive subject. ${PRODUCT_NAME} only learns these on its own when you allow the topic in Settings.`}
          className="ml-0.5 inline-flex h-[1.125rem] items-center gap-1 rounded-full bg-warning/15 px-1.5 font-medium text-foreground dark:bg-warning/10 dark:text-warning"
        >
          <ShieldAlert className="size-3" aria-hidden="true" />
          {sensitiveTopicLabel(memory.sensitive)}
        </span>
      )}
      {showProject && memory.projectId && (
        <span
          title="Only chats in this project use this memory."
          className="ml-0.5 inline-flex h-[1.125rem] max-w-[14rem] items-center gap-1 rounded-full bg-secondary px-1.5 font-medium text-muted-foreground"
        >
          <FolderLock className="size-3 shrink-0" aria-hidden="true" />
          <span translate="no" className="truncate">
            {memory.projectName ?? "One project"}
          </span>
        </span>
      )}
    </div>
  );
}

function RowMenu({
  memory,
  busy,
  buttonRef,
  projects,
  onWantProjects,
  onEdit,
  onRemove,
  onMove,
}: {
  memory: Memory;
  busy: boolean;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  projects: ProjectOptions;
  onWantProjects: () => void;
  onEdit: () => void;
  onRemove: (memory: Memory, kind: RemovalKind) => void;
  onMove: (memory: Memory, project: ProjectOption | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  // Where focus goes when the menu closes. Edit swaps this whole row for a
  // field, trigger included, and the field takes focus itself. Forget and
  // Delete fold the row away, trigger included, so focus moves on to the
  // neighbouring row: handed back to a button that is about to leave the page,
  // it would fall to the document and send a keyboard reader to the top.
  const closingFor = React.useRef<"edit" | "remove" | null>(null);
  const chatId = sourceChatId(memory);
  const forgettable = memory.status !== "suppressed";
  const otherProjects = Array.isArray(projects) ? projects.filter((project) => project.id !== memory.projectId) : [];
  const removeWith = (kind: RemovalKind) => {
    closingFor.current = "remove";
    onRemove(memory, kind);
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onWantProjects();
      }}
    >
      <Tooltip>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <IconButton
              ref={buttonRef}
              variant="ghost"
              size="sm"
              label="Memory options"
              title=""
              disabled={busy}
              data-memory-row-menu=""
              // The verbs arrive with the pointer, keyboard focus or an open
              // menu; a column of dots on every fact was the loudest thing in
              // a list meant for reading. Always there on a touch screen.
              className="-my-1 opacity-0 transition-opacity duration-fast ease-out-soft focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100 motion-reduce:transition-none"
            >
              <ActionIcons.more className="size-4" />
            </IconButton>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <TooltipContent>Options</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className={MENU_W_WIDE}
        onCloseAutoFocus={(event) => {
          const reason = closingFor.current;
          closingFor.current = null;
          if (reason === null) return;
          event.preventDefault();
          if (reason === "remove") focusNeighbourRow(buttonRef.current);
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            closingFor.current = "edit";
            onEdit();
          }}
        >
          <ActionIcons.edit />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderLock />
            Move to project
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={MENU_W}>
            {memory.projectId && (
              <DropdownMenuItem onSelect={() => onMove(memory, null)}>
                <MessagesSquare />
                All chats
              </DropdownMenuItem>
            )}
            {projects === null ? (
              <DropdownMenuItem disabled>Loading projects…</DropdownMenuItem>
            ) : projects === "failed" ? (
              // Said, not shown as "No other projects": the list is retried the
              // next time this menu opens.
              <DropdownMenuItem disabled>Couldn’t load your projects</DropdownMenuItem>
            ) : otherProjects.length === 0 ? (
              <DropdownMenuItem disabled>No other projects</DropdownMenuItem>
            ) : (
              otherProjects.map((project) => (
                <DropdownMenuItem key={project.id} onSelect={() => onMove(memory, project)}>
                  <Folder />
                  <span translate="no" className="truncate">
                    {project.name}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {chatId && (
          <DropdownMenuItem asChild>
            <Link href={`/chat/${chatId}`}>
              <MessageSquare />
              Open source chat
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {forgettable && (
          <DropdownMenuItem onSelect={() => removeWith("forget")} className="items-start">
            <EyeOff className="mt-0.5" />
            <span className="flex min-w-0 flex-col">
              <span>Forget</span>
              <span className="text-caption text-muted-foreground">{`${PRODUCT_NAME} won’t learn this again`}</span>
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem variant="destructive" onSelect={() => removeWith("delete")} className="items-start">
          <ActionIcons.delete className="mt-0.5" />
          <span className="flex min-w-0 flex-col">
            <span>Delete</span>
            <span className="text-caption text-muted-foreground">{`${PRODUCT_NAME} may learn it again from its chat`}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * After a row is removed from its own menu: focus the next row's menu button,
 * or the previous one's at the end of the list, or the list's heading when the
 * row was the last one there. Rows in any section count, so removing the last
 * fact under one topic moves on to the first under the next.
 */
function focusNeighbourRow(from: HTMLElement | null) {
  const row = from?.closest("li");
  const list = row?.closest<HTMLElement>("[data-memory-list]");
  if (!row || !list) return;
  const buttons = [...list.querySelectorAll<HTMLElement>("[data-memory-row-menu]")].filter(
    (button) => !button.hasAttribute("disabled")
  );
  const index = buttons.findIndex((button) => row.contains(button));
  const next = index === -1 ? undefined : buttons[index + 1] ?? buttons[index - 1];
  (next ?? list.querySelector<HTMLElement>("[data-memory-list-anchor]"))?.focus();
}
