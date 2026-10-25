"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Check, EyeOff, Pencil, Trash2, Undo2 } from "@/components/ui/icons";
import { memoryEntryHref, memorySourceChat } from "@/lib/chat/memory-receipts";
import { cn } from "@/lib/utils";
import type { ClientMemoryReceipt } from "@/types/chat";

/*
 * ONE REMEMBERED FACT, WITH WHAT CAN BE DONE TO IT FROM THE CHAT.
 *
 * Shared by the answer's memory receipt (answer-memory.tsx) and the "Memory
 * updated" notice (memory-updated-notice.tsx), so a fact undone in one is
 * undone in the other: the outcome of each action is kept in a small store
 * keyed by the memory's id, not in either component.
 *
 * The actions go through the memory page's own route (`PATCH /api/memory/[id]`):
 *
 *   Edit    rewrites the sentence in place. The route screens it against the
 *           block-list, and a refusal is shown in its own words.
 *   Forget  retires the fact and blocks it from being learned again — the
 *           memory page's Forget, not Delete, because a deleted fact is
 *           relearned from the chat it came from.
 *   Undo    the same act on a fact this turn just saved, plus the half that
 *           makes it an undo: whatever that fact replaced ("lives in Lisbon",
 *           replaced by "lives in Madrid") is believed again (`undo` on the
 *           route).
 *   Not relevant
 *           for a fact the answer USED: it is still true, it just had nothing
 *           to do with this answer. Ranking stops letting it ride along with
 *           messages that are not about it for a while (`notRelevant` on the
 *           route, NOT_RELEVANT_DAYS in memory-lifecycle.ts). Undo takes the
 *           mark back.
 *   View    opens the fact on the memory page, lit, with everything else
 *           that can be done to it.
 *
 * And where the fact was learned: "this chat", or a link to the chat (at the
 * message) it came from, the "memories and chats" half of what personalised
 * the answer.
 */

type FactOutcome = {
  /** The sentence after an edit made here. */
  content?: string;
  forgotten?: boolean;
  /** How many earlier facts an Undo brought back (the ones this fact had replaced). */
  restored?: number;
  /** Marked "Not relevant" here (false once that was taken back). */
  notRelevant?: boolean;
};

const outcomes = new Map<string, FactOutcome>();
const listeners = new Set<() => void>();
let version = 0;

function setOutcome(id: string, next: FactOutcome) {
  outcomes.set(id, { ...outcomes.get(id), ...next });
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders when any fact's outcome changes; reads are by id. */
function useOutcomes(): ReadonlyMap<string, FactOutcome> {
  React.useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return outcomes;
}

/** Test seam: forget every outcome recorded in this tab. */
export function resetMemoryFactOutcomesForTests() {
  outcomes.clear();
  version += 1;
}

type PatchResult = { failure: string; restored?: undefined } | { failure: null; restored: number };

/**
 * What a failed action says. Held under a `…Copy` name so the translation
 * extractor reads every sentence whole (scripts/generate-i18n-catalog.mjs);
 * the same sentences written into the results below would stay English.
 */
const FACT_ACTION_COPY = {
  gone: "That memory no longer exists.",
  forget: "Couldn’t forget that memory. Try again.",
  edit: "Couldn’t save that edit. Try again.",
  notRelevant: "Couldn’t mark that memory. Try again.",
  offline: "You seem to be offline. Try again.",
} as const;

async function patchMemory(
  id: string,
  body: Record<string, unknown>,
  action: "forget" | "edit" | "notRelevant",
): Promise<PatchResult> {
  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: unknown; restored?: unknown };
    if (res.ok) return { failure: null, restored: typeof data.restored === "number" ? data.restored : 0 };
    if (res.status === 404) return { failure: FACT_ACTION_COPY.gone };
    // An edit the block-list refused says why in the screen's own words.
    if (res.status === 409 && action === "edit" && typeof data.error === "string") return { failure: data.error };
    return { failure: FACT_ACTION_COPY[action] };
  } catch {
    return { failure: FACT_ACTION_COPY.offline };
  }
}

/**
 * Forget one fact and record the outcome for every surface showing it.
 * `undo` is a chat's Undo on a fact its turn just saved: whatever that fact
 * replaced comes back too. Resolves to the failure message, or null.
 */
export async function forgetMemoryFact(id: string, opts: { undo?: boolean } = {}): Promise<string | null> {
  const result = await patchMemory(id, opts.undo ? { forget: true, undo: true } : { forget: true }, "forget");
  if (result.failure === null) setOutcome(id, { forgotten: true, restored: result.restored });
  return result.failure;
}

/** Mark a fact the answer used as not relevant to it, or take that back. */
export async function markMemoryNotRelevant(id: string, notRelevant: boolean): Promise<string | null> {
  const result = await patchMemory(id, { notRelevant }, "notRelevant");
  if (result.failure === null) setOutcome(id, { notRelevant });
  return result.failure;
}

const linkClass =
  "rounded-xs underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline motion-reduce:transition-none disabled:cursor-wait disabled:opacity-60";

/** A fact's action: a compact ghost button, glyph then word, inked on hover. */
const actionClass =
  "inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-reduce:transition-none disabled:cursor-wait disabled:opacity-60 coarse:h-9 [&>svg]:size-3.5 [&>svg]:shrink-0";

export function MemoryFactRow({
  fact,
  saved = false,
  conversationId = null,
  onNavigate,
}: {
  fact: ClientMemoryReceipt;
  /** This turn saved it: the retire action reads "Undo", and there is no "Not relevant". */
  saved?: boolean;
  /** The chat being read, so a fact learned in it says "this chat" rather than linking to itself. */
  conversationId?: string | null;
  /** Called before following View, so a transient surface can close itself. */
  onNavigate?: () => void;
}) {
  const all = useOutcomes();
  const outcome = all.get(fact.id);
  const content = outcome?.content ?? fact.content;
  const forgotten = outcome?.forgotten === true;
  const notRelevant = !saved && outcome?.notRelevant === true;
  // A fact this turn saved was learned here, which its section already says.
  const source = saved ? null : memorySourceChat(fact, conversationId);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(content);
  const [busy, setBusy] = React.useState<"forget" | "edit" | "notRelevant" | null>(null);
  const notRelevantRef = React.useRef<HTMLButtonElement>(null);
  const undoMarkRef = React.useRef<HTMLButtonElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const editButtonRef = React.useRef<HTMLButtonElement>(null);
  const viewRef = React.useRef<HTMLAnchorElement>(null);

  React.useEffect(() => {
    if (!editing) return;
    const field = fieldRef.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [editing]);

  const forget = async () => {
    setBusy("forget");
    setError(null);
    const failure = await forgetMemoryFact(fact.id, { undo: saved });
    setBusy(null);
    if (failure) {
      setError(failure);
      return;
    }
    // The pressed control is replaced by a status line; focus moves to the
    // row's link instead of falling to the page.
    requestAnimationFrame(() => viewRef.current?.focus());
  };

  const save = async () => {
    const next = draft.trim();
    if (!next || next === content) {
      setEditing(false);
      return;
    }
    setBusy("edit");
    setError(null);
    const { failure } = await patchMemory(fact.id, { content: next }, "edit");
    setBusy(null);
    if (failure) {
      setError(failure);
      return;
    }
    setOutcome(fact.id, { content: next });
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };

  const mark = async (next: boolean) => {
    setBusy("notRelevant");
    setError(null);
    const failure = await markMemoryNotRelevant(fact.id, next);
    setBusy(null);
    if (failure) {
      setError(failure);
      return;
    }
    // The control that was pressed has gone; focus lands on the one that
    // replaced it, so a keyboard reader can take it straight back.
    requestAnimationFrame(() => (next ? undoMarkRef.current : notRelevantRef.current)?.focus());
  };

  const cancel = () => {
    setDraft(content);
    setEditing(false);
    setError(null);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };

  return (
    <li className="group/fact py-2.5" data-memory-fact={fact.id} data-state={forgotten ? "forgotten" : notRelevant ? "not-relevant" : undefined}>
      {editing ? (
        <form
          className="motion-safe:animate-fade-in"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="sr-only" htmlFor={`memory-fact-${fact.id}`}>
            Edit this memory
          </label>
          <textarea
            id={`memory-fact-${fact.id}`}
            ref={fieldRef}
            value={draft}
            maxLength={500}
            rows={Math.min(4, Math.max(1, Math.ceil(draft.length / 60)))}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
              } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void save();
              }
            }}
            disabled={busy === "edit"}
            className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-ui text-foreground outline-none transition-[border-color,box-shadow] duration-fast ease-out-soft focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 motion-reduce:transition-none"
          />
          <div className="mt-1.5 flex items-center gap-1.5 text-caption text-muted-foreground">
            <button
              type="submit"
              disabled={busy === "edit"}
              className="inline-flex h-7 items-center rounded-md bg-foreground px-2.5 text-caption font-medium text-background transition-opacity duration-fast ease-out-soft hover:opacity-90 disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none coarse:h-9"
            >
              {busy === "edit" ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={cancel} disabled={busy === "edit"} className={actionClass}>
              Cancel
            </button>
            <span className="ml-auto hidden font-mono text-micro text-muted-foreground sm:inline" aria-hidden="true">
              Enter saves · Esc cancels
            </span>
          </div>
        </form>
      ) : (
        <p
          className={cn(
            "break-words text-ui leading-5 text-foreground transition-[color,opacity] duration-base ease-out-soft motion-reduce:transition-none",
            forgotten && "text-muted-foreground line-through decoration-muted-foreground/40 opacity-70",
            notRelevant && "text-muted-foreground",
          )}
        >
          {content}
        </p>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-caption text-destructive motion-safe:animate-fade-in">
          {error}
        </p>
      ) : null}
      {!editing && (
        <div className="-ml-1.5 mt-1 flex flex-wrap items-center gap-x-0.5 gap-y-1 text-caption text-muted-foreground">
          {forgotten ? (
            <span role="status" className="inline-flex h-7 items-center gap-1 px-1.5 motion-safe:animate-fade-in">
              <Check aria-hidden="true" className="size-3.5 shrink-0" />
              {!saved
                ? "Forgotten. It won’t be used again."
                : outcome?.restored
                  ? "Removed. What it replaced is remembered again."
                  : "Removed, and it won’t be learned again."}
            </span>
          ) : notRelevant ? (
            <>
              <span role="status" className="inline-flex h-7 items-center gap-1 px-1.5 motion-safe:animate-fade-in">
                <EyeOff aria-hidden="true" className="size-3.5 shrink-0" />
                Noted. It’ll only come up when you ask about it.
              </span>
              <button
                ref={undoMarkRef}
                type="button"
                onClick={() => void mark(false)}
                disabled={busy !== null}
                className={cn(actionClass, "text-foreground")}
              >
                <Undo2 aria-hidden="true" />
                <span>{busy === "notRelevant" ? "Undoing…" : "Undo"}</span>
              </button>
            </>
          ) : (
            <>
              {!saved && (
                <button
                  ref={notRelevantRef}
                  type="button"
                  onClick={() => void mark(true)}
                  disabled={busy !== null}
                  className={actionClass}
                >
                  <EyeOff aria-hidden="true" />
                  <span>{busy === "notRelevant" ? "Saving…" : "Not relevant"}</span>
                </button>
              )}
              <button
                ref={editButtonRef}
                type="button"
                onClick={() => {
                  setDraft(content);
                  setEditing(true);
                }}
                disabled={busy !== null}
                className={actionClass}
              >
                <Pencil aria-hidden="true" />
                <span>Edit</span>
              </button>
              <button
                type="button"
                onClick={() => void forget()}
                disabled={busy !== null}
                className={cn(actionClass, "hover:text-destructive")}
              >
                {saved ? <Undo2 aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                <span>{busy === "forget" ? (saved ? "Undoing…" : "Forgetting…") : saved ? "Undo" : "Forget"}</span>
              </button>
            </>
          )}
          <Link ref={viewRef} href={memoryEntryHref(fact.id)} onClick={onNavigate} className={actionClass}>
            View in memory
            <ArrowUpRight aria-hidden="true" />
          </Link>
          {(source?.kind === "this" || source?.kind === "chat") && (
            <span aria-hidden="true" className="mx-1 h-3.5 w-px bg-border" />
          )}
          {source?.kind === "this" && <span className="px-1 text-muted-foreground">Learned in this chat</span>}
          {source?.kind === "chat" && (
            <Link href={source.href} onClick={onNavigate} className={cn(linkClass, "px-1")}>
              From a past chat
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

/** Whether every one of these facts has been forgotten or undone in this tab. */
export function useAllForgotten(ids: readonly string[]): boolean {
  const all = useOutcomes();
  return ids.length > 0 && ids.every((id) => all.get(id)?.forgotten === true);
}
