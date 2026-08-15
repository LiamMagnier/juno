"use client";

import * as React from "react";
import type { ClientWorkSession } from "@/lib/work/serializers";

/*
 * Which tasks have moved since the reader last looked at them.
 *
 * There is no server-side read state for a Work session and this deliberately
 * does not invent one. Adding a `lastReadAt` column would mean a schema change,
 * a migration, a serializer field and a write on every task open — and the
 * three clients that share this data (web, macOS, iOS) would each need teaching
 * to send it before the flag meant anything on any of them. What is actually
 * wanted here is smaller than that: a dot that stops the reader scrolling past
 * the one row that changed while they were in a meeting.
 *
 * So it is local, per browser, and says so. `lastActivityAt` is already a
 * genuine heartbeat — `appendEvents` bumps it on every batch a run writes — so
 * comparing it against the moment this browser last opened the task is an
 * honest answer to "has anything happened since I looked", for this browser.
 * It is not an answer to "has anybody looked", and no part of the UI claims it
 * is: the pill is labelled Unread, not Unseen, and nothing is ever marked read
 * on the reader's behalf by a poll.
 *
 * READ IN AN EFFECT, NEVER IN `useState`. A storage read during render makes
 * the first client render disagree with the server's HTML, which is the
 * hydration bug this codebase names in three other files. Until the effect has
 * run, `seenAt` is empty and every row is treated as READ — the quiet
 * direction. A dot that appears a frame late is a non-event; a page-load flash
 * of forty unread dots that then vanish is the surface calling itself wrong.
 */

const STORAGE_KEY = "juno:work-inbox-seen";

/**
 * How many sessions the ledger remembers.
 *
 * The list route is clamped at forty and a person accumulates tasks for ever,
 * so an unbounded map would grow until it hit the origin's storage quota — at
 * which point `setItem` throws and takes the whole write with it, including the
 * entry for the task just opened. Two hundred is five pages of list, which is
 * far more history than "did this change since I looked" is ever asked about,
 * and the eviction is oldest-timestamp-first so the rows still on screen are
 * the last to go.
 */
const MAX_ENTRIES = 200;

type SeenLedger = Readonly<Record<string, string>>;

function readLedger(): SeenLedger {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    );
    return Object.fromEntries(entries);
  } catch {
    // A quota error, a disabled storage API, or somebody else's JSON under our
    // key. All three mean the same thing to this feature — no history — and
    // none of them is worth a broken page.
    return {};
  }
}

function writeLedger(ledger: SeenLedger): void {
  try {
    const entries = Object.entries(ledger);
    const trimmed =
      entries.length <= MAX_ENTRIES
        ? entries
        : entries.sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // Storage full or blocked. The dots are a convenience; losing them is not
    // worth taking the render down with an exception.
  }
}

export interface UnreadLedger {
  /** Whether this task has recorded activity since this browser last opened it. */
  isUnread: (session: ClientWorkSession) => boolean;
  /** Called when a task is opened, or when the reader marks the list read. */
  markSeen: (sessionId: string, at: string) => void;
  markAllSeen: (sessions: readonly ClientWorkSession[]) => void;
  /** False until the effect has read storage — see the note above. */
  ready: boolean;
}

export function useUnreadLedger(): UnreadLedger {
  const [seen, setSeen] = React.useState<SeenLedger>({});
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    setSeen(readLedger());
    setReady(true);
  }, []);

  const markSeen = React.useCallback((sessionId: string, at: string) => {
    setSeen((current) => {
      // Already at or past this activity stamp: no write, and — importantly —
      // the same object back, so a row that re-renders on every poll does not
      // schedule a storage write thirty times a minute.
      if ((current[sessionId] ?? "") >= at) return current;
      const next = { ...current, [sessionId]: at };
      writeLedger(next);
      return next;
    });
  }, []);

  const markAllSeen = React.useCallback((sessions: readonly ClientWorkSession[]) => {
    setSeen((current) => {
      const next = { ...current };
      for (const session of sessions) next[session.id] = session.lastActivityAt;
      writeLedger(next);
      return next;
    });
  }, []);

  const isUnread = React.useCallback(
    (session: ClientWorkSession) => {
      if (!ready) return false;
      const mark = seen[session.id];
      // A task this browser has never opened is unread only if something has
      // actually happened on it — which is every task, since a session is
      // created with an activity stamp. That would light up the whole list on a
      // new device, so a missing mark is read as "seen at creation": only
      // activity AFTER the task was made counts as something to catch up on.
      if (mark === undefined) return session.lastActivityAt > session.createdAt;
      return session.lastActivityAt > mark;
    },
    [ready, seen]
  );

  return { isUnread, markSeen, markAllSeen, ready };
}
