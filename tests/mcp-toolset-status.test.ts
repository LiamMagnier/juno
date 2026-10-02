import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONNECTOR_TOOL_TIMEOUT_MS,
  connectFailureOf,
  connectorFailureFor,
  connectorPresentArgs,
  flattenToolResult,
  humaniseToolName,
  refusalStatusFields,
  resolvedConnectorTool,
  sortConnectorTools,
} from "@/lib/tools/connector-tools";
import { connectorUnavailableLine } from "@/lib/tools/connector-tools.prompt";

/*
 * Connectors mapped into the chat contract (SPEC §3.4). `src/lib/mcp.ts` is
 * `server-only` and shared with Work, so its pure rules live in
 * `tools/connector-tools.ts` and are driven here; the wiring in mcp.ts is read
 * as text. Everything chat asks of it is opt-in: Work calls it as before and
 * gets today's behaviour, with no connect budget.
 */

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const mcp = read("src/lib/mcp.ts");

test("the connector rules keep server-only out of their static graph", () => {
  const source = read("src/lib/tools/connector-tools.ts");
  assert.doesNotMatch(source, /^import "server-only";/m);
  for (const line of source.split("\n").filter((l) => /^import (?!type )/.test(l))) {
    assert.doesNotMatch(line, /@\/lib\/(mcp|prisma|connectors|crypto|action-approval-store)"/, line);
  }
  assert.match(mcp, /^import "server-only";/m, "mcp.ts is server-only, which is why it is read as text here");
});

test("resolveConnectorsWithStatus verdicts: not linked, misconfigured, auth expired, ready", () => {
  assert.equal(connectorFailureFor({ linked: false, configured: true, credential: "usable" }), "not_linked");
  // Not offerable on this deployment (no client id, no MCP endpoint): misconfigured, before linking.
  assert.equal(connectorFailureFor({ linked: false, configured: false, credential: "usable" }), "misconfigured");
  assert.equal(connectorFailureFor({ linked: true, configured: false, credential: "usable" }), "misconfigured");
  // A credential Juno cannot decrypt is a deployment problem; a failed refresh is the user's to fix.
  assert.equal(connectorFailureFor({ linked: true, configured: true, credential: "unreadable" }), "misconfigured");
  assert.equal(connectorFailureFor({ linked: true, configured: true, credential: "refresh_failed" }), "auth_expired");
  assert.equal(connectorFailureFor({ linked: true, configured: true, credential: "usable" }), null);

  // mcp.ts: beside getActiveConnectors (Work keeps its array), one shared resolver, request order.
  assert.match(mcp, /export async function getActiveConnectors\(userId: string, requestedIds\?: string\[\]\): Promise<ActiveConnector\[\]>/);
  assert.match(mcp, /export async function resolveConnectorsWithStatus\(/);
  assert.match(mcp, /for \(const id of requested\) \{/);
  assert.equal((mcp.match(/await resolveConnection\(userId, row\)/g) ?? []).length, 2, "both readers share one resolver");
  assert.doesNotMatch(mcp, /not implemented: WS1/);
});

test("an opt-in connect budget maps failures to a ConnectorFailure", () => {
  const fired = AbortSignal.abort();
  assert.equal(connectFailureOf(new Error("socket hang up"), fired), "timeout", "a fired budget is a timeout whatever the error says");
  assert.equal(connectFailureOf(Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
  assert.equal(connectFailureOf(Object.assign(new Error("Request timed out"), { code: -32001 })), "timeout");
  assert.equal(connectFailureOf(Object.assign(new Error("HTTP error"), { code: 401 })), "auth_expired");
  assert.equal(connectFailureOf(new Error("Error POSTing to endpoint (HTTP 403): Forbidden")), "auth_expired");
  assert.equal(connectFailureOf(new Error("invalid_token")), "auth_expired");
  assert.equal(connectFailureOf(new Error("getaddrinfo ENOTFOUND mcp.example")), "unreachable");
  assert.equal(connectFailureOf(undefined), "unreachable");
});

test("with no budget (Work) the connection is not bounded, and Work's calls are unchanged", () => {
  assert.match(mcp, /const budget = opts\.connectTimeoutMs \? AbortSignal\.timeout\(opts\.connectTimeoutMs\) : null;/);
  assert.match(mcp, /const requestOptions = budget \? \{ signal: budget, timeout: opts\.connectTimeoutMs \} : undefined;/);
  assert.match(mcp, /await client\.connect\(transport, requestOptions\);/);
  assert.match(mcp, /await client\.listTools\(undefined, requestOptions\);/);
  assert.match(mcp, /opts\.onConnectorStatus\?\.\(c\.id, "ready"\);/);
  assert.match(mcp, /opts\.onConnectorStatus\?\.\(c\.id, connectFailureOf\(error, budget\)\);/);
  // Work's callers pass no options, and a missing per-call option keeps today's call.
  const runner = read("scripts/work-runner.ts");
  const openCall = runner.slice(runner.indexOf("await openMcpToolset("), runner.indexOf("await openMcpToolset(") + 600);
  assert.doesNotMatch(openCall, /connectTimeoutMs/);
  assert.match(mcp, /const timer = opts\?\.timeoutMs \? AbortSignal\.timeout\(opts\.timeoutMs\) : null;/);
});

test("tools are named in (connector, tool) order after every connection settled", () => {
  const settled = [
    { connectorId: "notion", toolName: "search" },
    { connectorId: "github", toolName: "search" },
    { connectorId: "github", toolName: "create_issue" },
    { connectorId: "apple-mail", toolName: "list_mailboxes" },
  ];
  assert.deepEqual(sortConnectorTools(settled).map((t) => `${t.connectorId}:${t.toolName}`), [
    "apple-mail:list_mailboxes",
    "github:create_issue",
    "github:search",
    "notion:search",
  ]);
  assert.deepEqual(settled[0], { connectorId: "notion", toolName: "search" }, "the input is not reordered in place");
  assert.match(mcp, /for \(const \{ connector: c, tool: t \} of sortConnectorTools\(listed\)\) \{/);
});

test("isError, images and structured content (M6)", () => {
  const failed = flattenToolResult({ isError: true, content: [{ type: "text", text: "Quota exceeded" }] });
  assert.deepEqual(failed, { text: "Quota exceeded", images: [], isError: true });

  const pictures = flattenToolResult({
    content: [
      { type: "text", text: "Three screenshots" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "image", data: "BBB", mimeType: "image/jpeg" },
      { type: "image", data: "CCC", mimeType: "image/png" },
    ],
    structuredContent: { count: 3 },
  });
  assert.equal(pictures.images.length, 2, "at most two pictures per result");
  assert.deepEqual(pictures.images.map((i) => i.base64), ["AAA", "BBB"]);
  assert.doesNotMatch(pictures.text, /AAA|BBB|CCC/, "pixels never ride in the text");
  assert.match(pictures.text, /^Three screenshots\n\[An image from the tool was not included/);
  assert.ok(pictures.text.endsWith(JSON.stringify({ count: 3 }, null, 2)), "structured content comes after the text parts, pretty");
  assert.equal(pictures.isError, false);

  assert.equal(flattenToolResult({ structuredContent: { ok: true } }).text, JSON.stringify({ ok: true }, null, 2));
  assert.equal(flattenToolResult({ content: [{ type: "resource", resource: { uri: "x" } }] }).text, '{"uri":"x"}');

  // mcp.ts: an isError result is a failure, settled as one, with its pictures.
  assert.match(mcp, /if \(isError\) \{[\s\S]*?status: "failed",\s*error: \{ code: "tool_error" \}/);
});

test("per-call approvals and the timer start after authorisation", () => {
  assert.match(mcp, /onApprovalRequest: opts\?\.onApprovalRequest \?\? ctx\.onApprovalRequest,/);
  const authorized = mcp.indexOf("opts?.onAuthorized?.();");
  const sink = mcp.indexOf("client.callTool(");
  const authorize = mcp.indexOf("authorizeExternalAction({");
  assert.ok(authorize > 0 && authorized > authorize && sink > authorized, "authorise → onAuthorized → timer → callTool");
  assert.ok(mcp.indexOf("AbortSignal.timeout(opts.timeoutMs)") > authorized);
  assert.match(mcp, /\.\.\.refusalStatusFields\(authorization\.status\)/);
});

test("refusals carry their record status", () => {
  assert.deepEqual(refusalStatusFields("denied"), { status: "denied", error: { code: "denied" } });
  assert.deepEqual(refusalStatusFields("expired"), { status: "expired", error: { code: "expired" } });
  assert.deepEqual(refusalStatusFields("blocked"), { status: "failed", error: { code: "blocked" } });
  assert.deepEqual(refusalStatusFields("superseded"), { status: "cancelled", error: { code: "cancelled" } });
  assert.deepEqual(refusalStatusFields(undefined), { status: "failed", error: { code: "not_permitted" } });
});

test("a connector tool maps into the contract with the broker's risk", () => {
  const unannotated = resolvedConnectorTool({
    functionName: "github__list_issues",
    connectorId: "github",
    connectorLabel: "GitHub",
    toolName: "list_issues",
  });
  assert.equal(unannotated.canonical, "mcp");
  assert.equal(unannotated.origin, "connector");
  assert.equal(unannotated.risk, "external", "no annotations: unknown, which asks");
  assert.equal(unannotated.parallelSafe, false);
  assert.equal(unannotated.title, "List issues");
  assert.equal(unannotated.toolTitle, "List issues");
  assert.equal(unannotated.timeoutMs, CONNECTOR_TOOL_TIMEOUT_MS);
  assert.equal(unannotated.dedupe, true);

  const read = resolvedConnectorTool({
    functionName: "github__list_issues",
    connectorId: "github",
    connectorLabel: "GitHub",
    toolName: "list_issues",
    title: "List Issues",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  });
  assert.deepEqual([read.risk, read.parallelSafe, read.title], ["read", true, "List Issues"]);
  assert.deepEqual(read.inputSchema, { type: "object", properties: {} });

  const lying = resolvedConnectorTool({
    functionName: "x__delete_repo",
    connectorId: "x",
    connectorLabel: "X",
    toolName: "delete_repo",
    annotations: { readOnlyHint: true },
  });
  assert.equal(lying.risk, "destructive", "a read hint cannot launder a delete");
  assert.equal(lying.parallelSafe, false);
});

test("a connector row shows at most three safe, one-line arguments", () => {
  assert.deepEqual(
    connectorPresentArgs({
      api_key: "sk-secret",
      repo: "juno",
      title: "Crash on\nlaunch",
      body: "x".repeat(300),
      labels: ["bug"],
      draft: true,
    }),
    { repo: "juno", title: "Crash on launch", body: `${"x".repeat(119)}…` },
  );
  assert.deepEqual(connectorPresentArgs({ count: 3, enabled: false, token: "t" }), { count: 3, enabled: false });
  assert.equal(humaniseToolName("listCalendarEvents"), "List calendar events");
  assert.equal(humaniseToolName("search-messages"), "Search messages");
});

test("an unavailable connector becomes one line for the model, outside the cached prompt", () => {
  assert.equal(
    connectorUnavailableLine("Figma", "auth_expired"),
    "Figma is linked but unavailable this turn (auth expired). If the user asks for it, say so and suggest reconnecting it in Settings.",
  );
});
