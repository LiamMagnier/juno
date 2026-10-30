/**
 * A send that came back 401: the session ended while the chat was open.
 *
 * The turn used to end with the route's word for it — "Unauthorized" — printed
 * inside the assistant's bubble, and the message was gone with the next page
 * load. Now the chat says what happened in a dialog
 * (components/chat/session-expired-dialog.tsx), keeps the words, and takes the
 * reader through sign-in back to the same conversation with them waiting in
 * the message box.
 *
 * Two pieces live here so they can be tested without a browser:
 *
 *  - a one-slot store: `use-chat` reports the expiry, the dialog shows it;
 *  - the stash that carries the unsent words across the sign-in redirect, in
 *    this tab's sessionStorage, bound to the account that wrote them so a
 *    different person signing in on the same tab never receives them.
 *
 * The composer keeps its own draft across the redirect already
 * (lib/chat/context-draft.ts); the stash adds only the message that was being
 * sent, which the composer had already let go of.
 */

export interface SessionExpiredTurn {
  /** Where the reader was: a same-origin path and query, the sign-in's way back. */
  returnTo: string;
  /** The words that were not sent, when a message was being sent (null for a regenerate). */
  text: string | null;
  /** The conversation it was sent in; null for a chat that did not exist yet. */
  conversationId: string | null;
  /** An incognito chat: nothing of it is kept, the unsent words included. */
  incognito?: boolean;
  /**
   * The message also carried attachments or references. Only its words are
   * kept across sign-in, so the dialog says the rest will need adding again.
   */
  withAttachments?: boolean;
}

// ── The one-slot store ─────────────────────────────────────────────────────

let current: SessionExpiredTurn | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** A send came back 401. The newest report wins; there is one dialog. */
export function reportSessionExpired(turn: SessionExpiredTurn): void {
  current = turn;
  notify();
}

export function dismissSessionExpired(): void {
  if (!current) return;
  current = null;
  notify();
}

export function currentSessionExpired(): SessionExpiredTurn | null {
  return current;
}

export function subscribeSessionExpired(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── The way back ───────────────────────────────────────────────────────────

/**
 * A same-origin path, or "/chat". The sign-in form applies the same rule to
 * its `callbackUrl` (components/auth/auth-form.tsx); applied here too so the
 * stash never records anywhere else either.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/chat";
  try {
    const parsed = new URL(value, "https://juno.invalid");
    if (parsed.origin !== "https://juno.invalid") return "/chat";
    // Checked again once normalised: dot segments and stripped tabs collapse
    // "/.//evil.com" or "/a/..//evil.com" into "//evil.com", which a browser
    // reads as another host.
    if (parsed.pathname.startsWith("//") || parsed.pathname.startsWith("/\\")) return "/chat";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/chat";
  }
}

export function signInUrlFor(returnTo: string): string {
  return `/sign-in?callbackUrl=${encodeURIComponent(safeReturnPath(returnTo))}`;
}

// ── The stash ──────────────────────────────────────────────────────────────

export const SESSION_EXPIRED_STASH_KEY = "juno:session-expired:v1";
/** Longer than any sign-in takes; short enough that a forgotten tab does not resurrect old words. */
export const SESSION_EXPIRED_STASH_TTL_MS = 2 * 60 * 60 * 1000;
/** Where the sign-in page lands someone already signed in (app/(auth)/sign-in/page.tsx). */
const SESSION_EXPIRED_FALLBACK_PATH = "/chat";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StashRecord {
  v: 1;
  returnTo: string;
  text: string | null;
  conversationId: string | null;
  /** The account the words belong to. */
  userId: string;
  savedAt: number;
}

/** Keep the unsent words for after sign-in. False when the tab cannot store them. */
export function stashUnsentTurn(
  storage: StorageLike | null,
  turn: SessionExpiredTurn,
  userId: string,
  now: number
): boolean {
  // Incognito keeps nothing in the browser, these words included.
  if (!storage || !userId || turn.incognito) return false;
  const record: StashRecord = {
    v: 1,
    returnTo: safeReturnPath(turn.returnTo),
    text: turn.text?.trim() ? turn.text : null,
    conversationId: turn.conversationId,
    userId,
    savedAt: now,
  };
  try {
    storage.setItem(SESSION_EXPIRED_STASH_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * The stashed words for this page and this account, removed as they are
 * handed over. A stash for another page is left for that page, except on
 * `/chat`: the sign-in page sends someone who turns out to be signed in
 * already there, whatever the way back said, and words waiting on a page that
 * is never reached are as good as lost. One that is stale, malformed or
 * another account's is discarded.
 */
export function takeUnsentTurn(
  storage: StorageLike | null,
  at: { pathname: string; userId: string; now: number }
): SessionExpiredTurn | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(SESSION_EXPIRED_STASH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const discard = () => {
    try {
      storage.removeItem(SESSION_EXPIRED_STASH_KEY);
    } catch {
      // Nothing more to do: a stash that cannot be removed also cannot be read twice by the same page.
    }
    return null;
  };
  let record: Partial<StashRecord>;
  try {
    record = JSON.parse(raw) as Partial<StashRecord>;
  } catch {
    return discard();
  }
  if (
    !record ||
    record.v !== 1 ||
    typeof record.returnTo !== "string" ||
    typeof record.userId !== "string" ||
    typeof record.savedAt !== "number"
  ) {
    return discard();
  }
  if (record.userId !== at.userId) return discard();
  if (at.now - record.savedAt > SESSION_EXPIRED_STASH_TTL_MS || at.now < record.savedAt - 60_000) return discard();
  const path = record.returnTo.split("?")[0];
  if (path !== at.pathname && at.pathname !== SESSION_EXPIRED_FALLBACK_PATH) return null;
  discard();
  return {
    returnTo: record.returnTo,
    text: typeof record.text === "string" && record.text.trim() ? record.text : null,
    conversationId: typeof record.conversationId === "string" ? record.conversationId : null,
  };
}
