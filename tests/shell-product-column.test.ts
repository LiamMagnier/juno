import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { productOf } from "@/components/app/product-switch";

const SIDEBAR = readFileSync(new URL("../src/components/app/app-sidebar.tsx", import.meta.url), "utf8");

/*
 * Which column the shell draws, and whether the one new control in it can be
 * pressed with a thumb.
 *
 * `product` decides the whole left column — its destinations and which
 * conversations its folds hold — so a wrong answer here is not a mis-lit
 * segment, it is Library, Projects and every chat row disappearing from a page
 * that has nothing to do with Code.
 */

test("the path alone decides every route that is not a conversation", () => {
  assert.equal(productOf("/chat", null), "chat");
  assert.equal(productOf("/library", null), "chat");
  assert.equal(productOf("/code", null), "code");
  assert.equal(productOf("/code/pulls", null), "code");
  assert.equal(productOf(null, null), "chat");
});

test("a Code session's kind is the tiebreak while you are inside it", () => {
  // The path says "chat" for the entire time somebody is in a Code session,
  // because /chat/<id> is where CodeSessionView is served.
  assert.equal(productOf("/chat/abc", "code"), "code");
  assert.equal(productOf("/chat/abc", "chat"), "chat");
  assert.equal(productOf("/chat/abc", null), "chat");
});

test("the kind does not follow you out of the conversation", () => {
  /*
   * `activeConversationId` is set when a conversation view mounts and is never
   * cleared on unmount, so after opening one Code session its kind is still
   * sitting in the store on every later route. Unanchored, that stale kind
   * swapped the entire column — this is the regression, and it is the same one
   * the mobile title fixed for itself with `inConversation`.
   */
  for (const path of [
    "/library",
    "/projects",
    "/design",
    "/settings",
    "/memory",
    "/tasks",
    "/connections",
    "/artifacts",
    "/chat",
  ]) {
    assert.equal(productOf(path, "code"), "chat", `${path} must keep Chat's column`);
  }
});

test("the Needs you toggle is a full touch target in the phone drawer", () => {
  /*
   * The sidebar IS the phone drawer — AppShell renders AppSidebar inside
   * SheetContent — and this fold's header is the only interactive control the
   * triage rework added. Every other pressable row in the file grows on a
   * coarse pointer; at its resting `h-6` this one would be half the size of
   * everything around it under the same thumb.
   */
  const fold = SIDEBAR.slice(SIDEBAR.indexOf("function NeedsYouFold"));
  const pressable = fold.slice(0, fold.indexOf("</Pressable>"));
  assert.ok(pressable.includes("h-6"), "the resting geometry is still the date folds'");
  assert.ok(pressable.includes("coarse:h-11"), "but a coarse pointer gets the panel's 44px target");
});
