import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyToolAccess, toolNameTokens } from "@/lib/tool-access";

test("annotations win over the name", () => {
  // A server that labels its tools is believed, even when the name disagrees:
  // `list_` here is a read verb but the server says otherwise.
  assert.equal(classifyToolAccess("list_events", { readOnlyHint: false }), "write");
  assert.equal(classifyToolAccess("delete_event", { readOnlyHint: true }), "read");
  assert.equal(classifyToolAccess("create_event", { readOnlyHint: false, destructiveHint: false }), "write");
  assert.equal(classifyToolAccess("delete_event", { readOnlyHint: false, destructiveHint: true }), "write");
  // destructiveHint alone still names a write.
  assert.equal(classifyToolAccess("anything", { destructiveHint: true }), "write");
});

test("unannotated tools fall back to the leading verb", () => {
  for (const name of ["list_events", "search_messages", "get_page", "read_message", "queryDatabase"]) {
    assert.equal(classifyToolAccess(name), "read", name);
  }
  for (const name of ["create_event", "delete_event", "add_to_playlist", "send_message", "updatePage"]) {
    assert.equal(classifyToolAccess(name), "write", name);
  }
});

test("a read verb in front beats a write-shaped noun behind it", () => {
  // The `get_post` / `list_issues` shape is why only the FIRST token decides
  // when it is a known verb — a trailing scan would call both of these writes.
  assert.equal(classifyToolAccess("get_post"), "read");
  assert.equal(classifyToolAccess("list_comments"), "read");
  assert.equal(classifyToolAccess("search_pull_requests"), "read");
});

test("noun-first names are read from the trailing verb", () => {
  assert.equal(classifyToolAccess("repo_create"), "write");
  assert.equal(classifyToolAccess("page_update"), "write");
  assert.equal(classifyToolAccess("playlist_add"), "write");
});

test("what cannot be told apart stays unknown", () => {
  // The honest residue: an unannotated server whose names carry no verb. These
  // must NOT silently classify as reads — a caller gating on "write" is
  // entitled to know the difference between "this reads" and "no idea".
  for (const name of ["notion_pages", "issue_23", "x", ""]) {
    assert.equal(classifyToolAccess(name), "unknown", name);
  }
});

test("a non-boolean hint is not a hint", () => {
  // Hints arrive from the connector over JSON-RPC; a string "false" is truthy
  // in JS and would otherwise turn a write into a read.
  const hostile = { readOnlyHint: "true" } as unknown as { readOnlyHint?: boolean };
  assert.equal(classifyToolAccess("delete_event", hostile), "write");
});

test("tokenizer splits snake, kebab and camel case", () => {
  assert.deepEqual(toolNameTokens("create_event"), ["create", "event"]);
  assert.deepEqual(toolNameTokens("create-event"), ["create", "event"]);
  assert.deepEqual(toolNameTokens("createEvent"), ["create", "event"]);
  assert.deepEqual(toolNameTokens("GitHub__createIssue"), ["git", "hub", "create", "issue"]);
});
