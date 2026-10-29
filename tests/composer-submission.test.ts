import test from "node:test";
import assert from "node:assert/strict";
import { createComposerSubmissionGuard, submittedDraftIsCurrent } from "@/lib/chat/composer-submission";

test("two synchronous submit events produce only one pending request", async () => {
  const guard = createComposerSubmissionGuard();
  const stamp = { scope: "saved:chat-a", revision: 1 };
  let release!: () => void;
  const response = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  const send = async () => {
    const ticket = guard.begin(stamp);
    if (!ticket) return false;
    requests++;
    try { await response; return true; }
    finally { guard.finish(ticket); }
  };
  const first = send();
  const duplicate = send();
  assert.equal(requests, 1);
  assert.equal(await duplicate, false);
  release();
  assert.equal(await first, true);
  assert.ok(guard.begin(stamp), "the next intentional send is allowed after settlement");
});

test("a receipt can clear its original draft but never a newer edit", () => {
  const submitted = { scope: "saved:chat-a", revision: 4 };
  assert.equal(submittedDraftIsCurrent(submitted, { ...submitted }), true);
  assert.equal(submittedDraftIsCurrent(submitted, { ...submitted, revision: 5 }), false);
  // Editing back to the same words still creates a new revision and preserves
  // the user's explicit edit; string equality would lose it.
  assert.equal(submittedDraftIsCurrent(submitted, { ...submitted, revision: 6 }), false);
});

test("a different conversation can send while an old receipt is pending", () => {
  const guard = createComposerSubmissionGuard();
  const old = guard.begin({ scope: "saved:chat-a", revision: 1 })!;
  const next = guard.begin({ scope: "saved:chat-b", revision: 1 })!;
  assert.ok(next);
  assert.equal(guard.owns(old), false);
  assert.equal(submittedDraftIsCurrent(old, next), false);
  assert.equal(guard.finish(old), false, "the old finally must not release the new request");
  assert.equal(guard.begin({ scope: "saved:chat-b", revision: 2 }), null);
  assert.equal(guard.finish(next), true);
  assert.ok(guard.begin({ scope: "saved:chat-b", revision: 2 }));
});

test("private and saved drafts do not share a completion scope", () => {
  assert.equal(submittedDraftIsCurrent(
    { scope: "private:new", revision: 1 },
    { scope: "saved:new", revision: 1 },
  ), false);
});

test("a failed send releases its ticket so a deliberate retry works", async () => {
  const guard = createComposerSubmissionGuard();
  const stamp = { scope: "saved:chat-a", revision: 1 };
  const ticket = guard.begin(stamp)!;
  await assert.rejects(async () => {
    try { throw new Error("Offline"); }
    finally { guard.finish(ticket); }
  }, /Offline/);
  const retry = guard.begin(stamp);
  assert.ok(retry);
  assert.notEqual(retry.id, ticket.id);
});
