import test from "node:test";
import assert from "node:assert/strict";
import { firstPartyDefinitions, FIRST_PARTY_IDS } from "@/lib/first-party-connectors/providers";
import { boundedText, connectorApiUrl, FirstPartyClient } from "@/lib/first-party-connectors/client";
import { callFirstPartyTool, firstPartyTools, gmailRawMessage } from "@/lib/first-party-connectors/tools";
import { readSlackSyncPage, readSyncPage } from "@/lib/first-party-connectors/sync";
import { classifyExternalAction, decideActionPolicy } from "@/lib/action-approval";

function mocked(provider: (typeof FIRST_PARTY_IDS)[number], replies: Array<unknown | Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new FirstPartyClient(provider, "test-provider-token", async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    assert.ok(replies.length, "unexpected extra API call");
    const next = replies.shift();
    return next instanceof Response ? next : Response.json(next);
  });
  return { client, calls };
}

test("all six first-party apps use dedicated app credentials and internal MCP endpoints", () => {
  const defs = firstPartyDefinitions("https://alevr.example/", { CONNECTOR_GOOGLE_CLIENT_ID: "connector-google", GOOGLE_CLIENT_ID: "login-only", CONNECTOR_MICROSOFT_CLIENT_ID: "connector-ms" });
  assert.deepEqual(defs.map((d) => d.id), [...FIRST_PARTY_IDS]);
  for (const d of defs) {
    assert.equal(d.firstParty, true);
    assert.equal(d.cfg.mcpUrl, `https://alevr.example/api/mcp/first-party/${d.id}`);
    assert.equal(d.refreshUrl, d.tokenUrl);
    assert.notEqual(d.cfg.clientId, "login-only");
    assert.equal(d.pkce, d.id !== "slack");
  }
  assert.equal(defs[0].authorizeParams?.access_type, "offline");
  assert.equal(defs.at(-1)?.authorizeParams?.user_scope, defs.at(-1)?.scope);
});

for (const provider of FIRST_PARTY_IDS) test(`${provider}: tools have schemas and independent approval classification`, () => {
  const specs = firstPartyTools(provider);
  assert.equal(specs.length, { gmail: 4, "google-calendar": 4, "google-drive": 2, outlook: 7, "microsoft-365": 5, slack: 4 }[provider]);
  for (const spec of specs) {
    assert.equal(spec.inputSchema.type, "object");
    const classification = classifyExternalAction({ connectorId: provider, toolName: spec.name, annotations: spec.annotations });
    if (spec.annotations.readOnlyHint) assert.equal(classification.riskClass, "read_only", spec.name);
    else assert.notEqual(classification.riskClass, "read_only", spec.name);
    if (/send|post|create/.test(spec.name)) {
      assert.equal(classification.riskClass, "external_write", spec.name);
      for (const policy of ["always_ask", "ask_for_any_change", "ask_for_important_actions", "allow_selected_low_risk"] as const) assert.equal(decideActionPolicy({ policy, riskClass: classification.riskClass, hasStandingApproval: true }), "ask");
    }
  }
});

test("provider URL validation rejects cross-origin cursors, credentials and wrong API prefixes", () => {
  for (const path of ["https://attacker.example/v1.0/me", "//attacker.example/v1.0/me", "https://user:pass@graph.microsoft.com/v1.0/me", "/beta/me", "/v1.0/me#x"]) assert.throws(() => connectorApiUrl("outlook", path));
  assert.equal(connectorApiUrl("outlook", "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=opaque").searchParams.get("$deltatoken"), "opaque");
});

test("mail drafts encode UTF-8 safely and reject header injection before network access", async () => {
  const raw = gmailRawMessage({ to: ["person@example.com"], subject: "Héllo", body: "Un café" });
  const decoded = Buffer.from(raw, "base64url").toString();
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
  assert.match(decoded, /Content-Transfer-Encoding: base64/);
  const { client, calls } = mocked("gmail", []);
  await assert.rejects(callFirstPartyTool(client, "draft_message", { to: ["person@example.com"], subject: "Hello\r\nBcc: other@example.com", body: "x" }));
  await assert.rejects(callFirstPartyTool(client, "send_draft", { draftId: "d1", to: ["other@example.com"] }));
  assert.equal(calls.length, 0);
});

test("Gmail draft and approved-send tools call different endpoints", async () => {
  const { client, calls } = mocked("gmail", [{ id: "draft1" }, { id: "message1" }]);
  await callFirstPartyTool(client, "draft_message", { to: ["person@example.com"], subject: "Test", body: "Draft" });
  await callFirstPartyTool(client, "send_draft", { draftId: "draft1" });
  assert.equal(calls[0].url.pathname, "/gmail/v1/users/me/drafts");
  assert.equal(calls[1].url.pathname, "/gmail/v1/users/me/drafts/send");
  assert.deepEqual(JSON.parse(calls[1].init?.body as string), { id: "draft1" });
  assert.equal(calls[1].init?.redirect, "manual");
});

test("writes never retry an ambiguous provider failure or include its body in errors", async () => {
  const { client, calls } = mocked("slack", [new Response("provider-secret-value", { status: 503 })]);
  await assert.rejects(callFirstPartyTool(client, "post_message", { channelId: "C123", text: "Hello" }), (err: Error) => !err.message.includes("provider-secret-value"));
  assert.equal(calls.length, 1);
});

test("Slack 200 responses with ok:false fail instead of being recorded as success", async () => {
  const { client } = mocked("slack", [{ ok: false, error: "secret provider detail" }]);
  await assert.rejects(callFirstPartyTool(client, "search_messages", { query: "hello" }), /Slack refused/);
});

test("bounded reads reject oversized streamed responses", async () => {
  await assert.rejects(boundedText(new Response("1234567890"), 5), /too large/);
  assert.equal(await boundedText(new Response("abc"), 5), "abc");
});

test("Gmail establishes a quiet baseline and retains its original history position while paging", async () => {
  const { client, calls } = mocked("gmail", [{ historyId: "100" }, { historyId: "200", nextPageToken: "p2", history: [{ id: "101", messagesAdded: [{ message: { id: "m1" } }] }] }, { historyId: "200", history: [{ id: "102", messagesDeleted: [{ message: { id: "m2" } }] }] }]);
  const baseline = await readSyncPage(client, {});
  assert.deepEqual(baseline.changes, []);
  const first = await readSyncPage(client, baseline.cursor);
  assert.equal(first.cursor.position, "100");
  assert.equal(first.changes[0].type, "message_received");
  const last = await readSyncPage(client, first.cursor);
  assert.equal(calls[2].url.searchParams.get("startHistoryId"), "100");
  assert.equal(calls[2].url.searchParams.get("pageToken"), "p2");
  assert.equal(last.cursor.position, "200");
  assert.equal(last.changes[0].type, "message_deleted");
});

test("an expired Gmail history cursor establishes a new baseline and reports reset", async () => {
  const { client } = mocked("gmail", [new Response(null, { status: 404 }), { historyId: "new" }]);
  const page = await readSyncPage(client, { position: "old", established: true });
  assert.equal(page.reset, true); assert.equal(page.cursor.position, "new"); assert.equal(page.changes.length, 0);
});

test("Drive retains tombstones without file metadata", async () => {
  const { client } = mocked("google-drive", [{ newStartPageToken: "2", changes: [{ fileId: "removed", removed: true }] }]);
  const page = await readSyncPage(client, { position: "1", established: true });
  assert.equal(page.changes[0].resourceId, "removed");
  assert.equal(page.changes[0].type, "file_deleted");
  assert.equal(page.cursor.position, "2");
});

test("Calendar baseline pages do not emit old events; deltas do", async () => {
  const { client, calls } = mocked("google-calendar", [{ nextPageToken: "page2", items: [{ id: "old1" }] }, { nextSyncToken: "start", items: [{ id: "old2" }] }, { nextSyncToken: "end", items: [{ id: "new", etag: "v2", status: "cancelled" }] }]);
  const a = await readSyncPage(client, {}), b = await readSyncPage(client, a.cursor), c = await readSyncPage(client, b.cursor);
  assert.equal(a.changes.length + b.changes.length, 0);
  assert.equal(calls[2].url.searchParams.get("syncToken"), "start");
  assert.equal(c.changes[0].type, "event_deleted");
});

test("Calendar 410 invalidation resets its entire baseline", async () => {
  const { client } = mocked("google-calendar", [new Response(null, { status: 410 }), { nextSyncToken: "fresh", items: [{ id: "old" }] }]);
  const page = await readSyncPage(client, { position: "expired", established: true });
  assert.equal(page.reset, true); assert.equal(page.changes.length, 0); assert.equal(page.cursor.position, "fresh");
});

test("Microsoft delta pages preserve the opaque links and suppress the initial snapshot", async () => {
  const next = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=opaque";
  const delta = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next";
  const { client, calls } = mocked("outlook", [{ "@odata.nextLink": next, value: [{ id: "old" }] }, { "@odata.deltaLink": delta, value: [] }, { "@odata.deltaLink": delta + "2", value: [{ id: "new", lastModifiedDateTime: "2026-01-01T00:00:00Z" }] }]);
  const a = await readSyncPage(client, {}), b = await readSyncPage(client, a.cursor), c = await readSyncPage(client, b.cursor);
  assert.equal(calls[1].url.toString(), next);
  assert.equal(a.changes.length, 0); assert.equal(c.changes.length, 1);
  assert.equal(c.changes[0].resourceId, "new");
});

test("Slack newest-first pagination preserves the newest timestamp across older pages", async () => {
  const { client, calls } = mocked("slack", [{ ok: true, messages: [{ ts: "100.000009" }, { ts: "100.000008" }], has_more: true, response_metadata: { next_cursor: "next" } }, { ok: true, messages: [{ ts: "100.000007" }] }]);
  const quiet = await readSlackSyncPage(client, {}, "C123", 99_000);
  assert.equal(quiet.changes.length, 0);
  const a = await readSlackSyncPage(client, quiet.cursor, "C123"), b = await readSlackSyncPage(client, a.cursor, "C123");
  assert.equal(b.cursor.position, "100.000009");
  assert.equal(calls[1].url.searchParams.get("oldest"), "99.000000");
  assert.equal(calls[1].url.searchParams.get("cursor"), "next");
});

test("Outlook sends only a specified draft and accepts its empty 202 response", async () => {
  const { client, calls } = mocked("outlook", [new Response(null, { status: 202 })]);
  assert.deepEqual(await callFirstPartyTool(client, "send_draft", { draftId: "draft1" }), {});
  assert.equal(calls[0].url.pathname, "/v1.0/me/messages/draft1/send");
});

test("unknown tools and reversed calendar ranges fail before provider access", async () => {
  const { client, calls } = mocked("google-calendar", []);
  await assert.rejects(callFirstPartyTool(client, "delete_everything", {}), /Unknown/);
  await assert.rejects(callFirstPartyTool(client, "create_event", { title: "Backwards", start: "2026-10-17T10:00:00Z", end: "2026-10-17T09:00:00Z" }));
  assert.equal(calls.length, 0);
});
