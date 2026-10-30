import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SESSION_EXPIRED_STASH_KEY,
  SESSION_EXPIRED_STASH_TTL_MS,
  currentSessionExpired,
  dismissSessionExpired,
  reportSessionExpired,
  safeReturnPath,
  signInUrlFor,
  stashUnsentTurn,
  subscribeSessionExpired,
  takeUnsentTurn,
} from "@/lib/chat/session-expired";

/*
 * A send that came back 401 (src/lib/chat/session-expired.ts): the chat says
 * the session ended, keeps the words, and hands them back in the same
 * conversation after sign-in — to the same account only.
 */

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const NOW = 1_800_000_000_000;
const turn = { returnTo: "/chat/c1?agent=profile", text: "Plan my week", conversationId: "c1" };

test("the store holds one report and tells its subscriber", () => {
  let calls = 0;
  const unsubscribe = subscribeSessionExpired(() => calls++);
  assert.equal(currentSessionExpired(), null);
  reportSessionExpired(turn);
  assert.deepEqual(currentSessionExpired(), turn);
  reportSessionExpired({ ...turn, text: "newer" });
  assert.equal(currentSessionExpired()?.text, "newer", "the newest report wins: there is one dialog");
  dismissSessionExpired();
  assert.equal(currentSessionExpired(), null);
  dismissSessionExpired();
  assert.equal(calls, 3, "dismissing nothing tells nobody");
  unsubscribe();
  reportSessionExpired(turn);
  assert.equal(calls, 3);
  dismissSessionExpired();
});

test("the way back is a same-origin path, nothing else", () => {
  assert.equal(safeReturnPath("/chat/c1?agent=profile"), "/chat/c1?agent=profile");
  assert.equal(safeReturnPath("/chat"), "/chat");
  for (const hostile of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "", null, undefined]) {
    assert.equal(safeReturnPath(hostile), "/chat", String(hostile));
  }
  // Paths that only become another host once normalised: dot segments,
  // encoded dots, a stripped tab, a backslash after a dot segment.
  for (const disguised of ["/.//evil.example", "/a/..//evil.example", "/.%2e//evil.example", "/chat/../..//evil.example/x", "/\t/evil.example", "/./\\evil.example"]) {
    assert.equal(safeReturnPath(disguised), "/chat", JSON.stringify(disguised));
    assert.equal(signInUrlFor(disguised), "/sign-in?callbackUrl=%2Fchat", JSON.stringify(disguised));
  }
  // An encoded slash stays a path on this host.
  assert.equal(safeReturnPath("/%2F%2Fevil.example"), "/%2F%2Fevil.example");
  // The sign-in form, where this path ends up, re-checks the normalised path the same way.
  const form = readFileSync(new URL("../src/components/auth/auth-form.tsx", import.meta.url), "utf8");
  assert.ok(form.includes('if (parsed.pathname.startsWith("//") || parsed.pathname.startsWith("/\\\\")) return "/chat";'));
  assert.equal(signInUrlFor("/chat/c1?agent=profile"), "/sign-in?callbackUrl=%2Fchat%2Fc1%3Fagent%3Dprofile");
  assert.equal(signInUrlFor("https://evil.example/"), "/sign-in?callbackUrl=%2Fchat");
});

test("the unsent words come back on the same page, for the same account, once", () => {
  const storage = memoryStorage();
  assert.equal(stashUnsentTurn(storage, turn, "user_a", NOW), true);
  // Another page does not take them, and leaves them for theirs.
  assert.equal(takeUnsentTurn(storage, { pathname: "/chat/c2", userId: "user_a", now: NOW + 1_000 }), null);
  assert.equal(takeUnsentTurn(storage, { pathname: "/projects", userId: "user_a", now: NOW + 1_000 }), null);
  assert.ok(storage.map.has(SESSION_EXPIRED_STASH_KEY));
  const back = takeUnsentTurn(storage, { pathname: "/chat/c1", userId: "user_a", now: NOW + 1_000 });
  assert.deepEqual(back, turn);
  assert.equal(storage.map.has(SESSION_EXPIRED_STASH_KEY), false, "handed over once");
  assert.equal(takeUnsentTurn(storage, { pathname: "/chat/c1", userId: "user_a", now: NOW + 2_000 }), null);
});

test("words for a page the sign-in never returns to come back on /chat, where it lands instead", () => {
  // The sign-in page sends someone already signed in to /chat, whatever the
  // way back said: the words wait there rather than on a page never reached.
  const storage = memoryStorage();
  stashUnsentTurn(storage, turn, "user_a", NOW);
  assert.deepEqual(takeUnsentTurn(storage, { pathname: "/chat", userId: "user_a", now: NOW + 1_000 }), turn);
  assert.equal(storage.map.has(SESSION_EXPIRED_STASH_KEY), false, "handed over once");
  assert.equal(takeUnsentTurn(storage, { pathname: "/chat/c1", userId: "user_a", now: NOW + 2_000 }), null);
  const signIn = readFileSync(new URL("../src/app/(auth)/sign-in/page.tsx", import.meta.url), "utf8");
  assert.ok(signIn.includes('if (await getCurrentUser()) redirect("/chat");'), "the landing this fallback mirrors");
});

test("someone else signing in on the same tab never receives them", () => {
  const storage = memoryStorage();
  stashUnsentTurn(storage, { ...turn, returnTo: "/chat" }, "user_a", NOW);
  assert.equal(takeUnsentTurn(storage, { pathname: "/chat", userId: "user_b", now: NOW + 1_000 }), null);
  assert.equal(storage.map.has(SESSION_EXPIRED_STASH_KEY), false, "discarded, not kept for later");
});

test("old, malformed or incognito stashes are never handed back", () => {
  const storage = memoryStorage();
  stashUnsentTurn(storage, turn, "user_a", NOW);
  assert.equal(takeUnsentTurn(storage, { pathname: "/chat/c1", userId: "user_a", now: NOW + SESSION_EXPIRED_STASH_TTL_MS + 1 }), null);
  assert.equal(storage.map.has(SESSION_EXPIRED_STASH_KEY), false);

  storage.setItem(SESSION_EXPIRED_STASH_KEY, "{not json");
  assert.equal(takeUnsentTurn(storage, { pathname: "/chat/c1", userId: "user_a", now: NOW }), null);
  assert.equal(storage.map.has(SESSION_EXPIRED_STASH_KEY), false);

  storage.setItem(SESSION_EXPIRED_STASH_KEY, JSON.stringify({ v: 2, returnTo: "/chat/c1", userId: "user_a", savedAt: NOW }));
  assert.equal(takeUnsentTurn(storage, { pathname: "/chat/c1", userId: "user_a", now: NOW }), null);

  assert.equal(stashUnsentTurn(storage, { ...turn, incognito: true }, "user_a", NOW), false, "incognito keeps nothing");
  assert.equal(storage.map.has(SESSION_EXPIRED_STASH_KEY), false);
  assert.equal(stashUnsentTurn(storage, turn, "", NOW), false, "no account, no stash");
  assert.equal(stashUnsentTurn(null, turn, "user_a", NOW), false);
  assert.equal(takeUnsentTurn(null, { pathname: "/chat/c1", userId: "user_a", now: NOW }), null);
});

test("a storage that throws never breaks the page", () => {
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(stashUnsentTurn(throwing, turn, "user_a", NOW), false);
  assert.equal(takeUnsentTurn(throwing, { pathname: "/chat/c1", userId: "user_a", now: NOW }), null);
});

test("a hostile return path is cleaned before it is stored", () => {
  const storage = memoryStorage();
  stashUnsentTurn(storage, { ...turn, returnTo: "https://evil.example/chat" }, "user_a", NOW);
  const stored = JSON.parse(storage.map.get(SESSION_EXPIRED_STASH_KEY)!) as { returnTo: string };
  assert.equal(stored.returnTo, "/chat");
});

test("the dialog is mounted with the chat, says what happened, and keeps its promise only when it can", () => {
  const dialog = readFileSync(new URL("../src/components/chat/session-expired-dialog.tsx", import.meta.url), "utf8");
  assert.ok(dialog.includes('const sessionEndedTitle = "Your session ended";'));
  assert.ok(dialog.includes("Sign in again"));
  assert.ok(dialog.includes("Not now"));
  // "Waiting in the message box" is only said when this tab can store it,
  // only for a sign-in in this tab (an email link opens another, with no
  // stash), and never for attachments, which are not carried.
  assert.ok(/!canKeep\s*\?\s*sessionEndedCopyFirstMessage\s*:\s*turn\?\.withAttachments\s*\?\s*sessionEndedKeepsWordsMessage\s*:\s*sessionEndedKeepsMessage/.test(dialog));
  const promises = [...dialog.matchAll(/"([^"]*waiting in the message box[^"]*)"/g)].map((m) => m[1]);
  assert.equal(promises.length, 2);
  for (const promise of promises) assert.match(promise, /If you sign in again in this tab/);
  assert.match(promises[1], /but not its attachments/);
  assert.ok(!dialog.includes("It will be waiting in the message box when you’re back"), "no unconditional promise");
  assert.ok(dialog.includes('new CustomEvent("juno:composer-seed", { detail: { text, append: true } })'), "handed to the composer after what it restored");
  // React runs effects twice in development (StrictMode): a cleanup that
  // cleared the hand-back's timer lost the words, because the first run had
  // already taken the stash. Found in the browser.
  assert.ok(!/clearTimeout\(timer\)/.test(dialog), "the hand-back is not cancelled by a cleanup");
  assert.ok(!dialog.includes("Unauthorized"));
  const view = readFileSync(new URL("../src/components/chat/chat-view.tsx", import.meta.url), "utf8");
  assert.ok(view.includes("<SessionExpiredDialog />"));
  // The composer's seed event accepts the shape the dialog sends.
  const composer = readFileSync(new URL("../src/components/chat/composer.tsx", import.meta.url), "utf8");
  assert.ok(composer.includes('window.addEventListener("juno:composer-seed", seed);'));
  assert.ok(composer.includes("(detail as { append?: unknown }).append === true"));
});
