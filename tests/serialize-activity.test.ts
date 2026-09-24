import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ACTIVITY_KINDS,
  readCommentaryItem,
  readReasoningSegment,
  readRunFact,
  readRunNotice,
  readToolCallRecord,
  serializeActivity,
  settleToolCallRecord,
} from "@/lib/chat/run-record";
import type { ClientActivityEvent } from "@/types/chat";
import type { ToolCallRecord } from "@/types/run";
import { playTurnScript } from "./fixtures/turn-player";
import { TURN_SCRIPTS, turnScript } from "./fixtures/turn-scripts";

/*
 * WHAT SURVIVES A RELOAD (SPEC §2.7).
 *
 * `serializeActivity` rebuilds `Message.activity` from a FIELD WHITELIST: a
 * field written live and not read here streams, then vanishes on reload, and
 * looks exactly like the feature working. It lives in the pure
 * `run-record.ts` so this test can import it (`serializers.ts` is
 * server-only). Every reader degrades a malformed payload to `undefined` —
 * that field, never the event — because a row written by a LATER build must
 * still load in this one.
 */

const at = "2026-09-24T10:00:00.000Z";
const base = { id: "a1", kind: "tool", title: "Using GitHub", createdAt: at };
const roundTrip = (events: unknown[]) => serializeActivity(JSON.parse(JSON.stringify(events)));

const record: ToolCallRecord = {
  v: 1,
  callId: "toolu_1",
  providerCallId: "toolu_1",
  tool: "mcp",
  origin: "connector",
  title: "Create issue",
  connectorId: "github",
  connectorLabel: "GitHub",
  toolTitle: "Create issue",
  status: "denied",
  round: 1,
  index: 0,
  startedAt: at,
  endedAt: at,
  durationMs: 12,
  timeoutMs: 60_000,
  args: { title: "Flaky", count: 2, draft: false },
  figure: { kind: "items", n: 1 },
  error: { code: "denied", detail: "The person declined." },
  approval: { id: "apr_1", status: "denied", riskClass: "external_write", decision: "deny", decidedAt: at, expiresAt: at },
  web: { query: "q", engine: "tavily", results: [{ n: 1, title: "T", url: "https://t.example/" }] },
  cached: true,
};

test("a legacy row (no seq anywhere) comes back exactly as before", () => {
  const legacy = [
    { id: "a", kind: "search", title: "Preparing web search", detail: "Claude web search", createdAt: at },
    { ...base, detail: "github__list_issues", tool: { server: "GitHub", name: "github__list_issues", argsNote: "empty", status: "ok" } },
    { id: "c", kind: "visit", title: "Visited source", detail: "Docs", url: "https://docs.example/", createdAt: at },
  ];
  assert.deepEqual(roundTrip(legacy), [
    { id: "a", kind: "search", title: "Preparing web search", detail: "Claude web search", url: undefined, createdAt: at },
    { ...base, detail: "github__list_issues", url: undefined, tool: { server: "GitHub", name: "github__list_issues", argsNote: "empty", status: "ok" } },
    { id: "c", kind: "visit", title: "Visited source", detail: "Docs", url: "https://docs.example/", createdAt: at },
  ]);
});

test("every new key survives the round trip: seq, round, call, segment, commentary, fact, notice", () => {
  const events = [
    { ...base, seq: 3, round: 1, call: record },
    { id: "s", kind: "reasoning", title: "Thinking", createdAt: at, seq: 4, round: 2, segment: { round: 2, part: 1, offset: 120 } },
    { id: "m", kind: "reasoning", title: "Commentary", createdAt: at, seq: 5, round: 0, commentary: { round: 0, text: "Let me check.", inline: true } },
    { id: "f", kind: "context", title: "Tools ready", createdAt: at, seq: 1, fact: { key: "tools", offered: ["web_search", "web_fetch"], nativeSearch: false, roundBudget: 10 } },
    { id: "n", kind: "warning", title: "GitHub unavailable", createdAt: at, seq: 2, notice: { code: "connector_unavailable", params: { connector: "GitHub", reason: "unreachable" } } },
  ];
  const out = roundTrip(events)!;
  assert.deepEqual(out[0].call, record);
  assert.equal(out[0].seq, 3);
  assert.equal(out[0].round, 1);
  assert.deepEqual(out[1].segment, { round: 2, part: 1, offset: 120 });
  assert.deepEqual(out[2].commentary, { round: 0, text: "Let me check.", inline: true });
  assert.deepEqual(out[3].fact, { key: "tools", offered: ["web_search", "web_fetch"], nativeSearch: false, roundBudget: 10 });
  assert.deepEqual(out[4].notice, { code: "connector_unavailable", params: { connector: "GitHub", reason: "unreachable" } });
});

test("memoryReceipt, artifactVerification and the artifact kind are restored (INV-20)", () => {
  const verification = {
    version: 1,
    status: "repaired",
    attempts: 1,
    checked: 2,
    accepted: ["a"],
    refused: [],
    problems: [{ identifier: "a", code: "x", detail: "d", repairable: true }],
    repairs: [{ identifier: "a", code: "x", detail: "d", repairable: true }],
  };
  const out = roundTrip([
    { id: "m", kind: "context", title: "Remembered about you", createdAt: at, memoryReceipt: [{ id: "mem_1", content: "Likes tea", category: null, sourceRef: "chat", sourceMessageId: null }] },
    { id: "v", kind: "artifact", title: "Artifact repaired", createdAt: at, artifactVerification: verification },
  ])!;
  assert.deepEqual(out[0].memoryReceipt, [{ id: "mem_1", content: "Likes tea", category: null, sourceRef: "chat", sourceMessageId: null }]);
  assert.equal(out[1].kind, "artifact");
  assert.deepEqual(out[1].artifactVerification, verification);
  assert.ok(ACTIVITY_KINDS.has("artifact"));
});

test("Juno Code's patch and exitCode survive (INV-21)", () => {
  const out = roundTrip([
    { id: "w", kind: "write", title: "Edited file", createdAt: at, patch: "--- a\n+++ b" },
    { id: "t", kind: "tool", title: "Ran tests", createdAt: at, exitCode: 1 },
  ])!;
  assert.equal(out[0].patch, "--- a\n+++ b");
  assert.equal(out[1].exitCode, 1);
});

test("malformed payloads degrade that field, never the event", () => {
  const out = roundTrip([
    { ...base, seq: 0, round: -1, call: { v: 2, callId: "x" }, segment: { round: "0" }, commentary: { round: 0, text: "   " }, fact: { key: "nope" }, notice: { code: "made_up" }, memoryReceipt: "x", artifactVerification: { version: 2 } },
  ])!;
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { ...base, detail: undefined, url: undefined });
});

test("rows without id, kind, title or createdAt, or with an unknown kind, are dropped; nothing throws", () => {
  assert.equal(serializeActivity(null), undefined);
  assert.equal(serializeActivity("x"), undefined);
  assert.equal(serializeActivity([]), undefined);
  assert.equal(roundTrip([{ kind: "tool", title: "x", createdAt: at }, { ...base, kind: "hologram" }, 3, null]), undefined);
});

test("the §2.5 read-time rewrites: a non-terminal call is cancelled, an unsettled approval expired", () => {
  const running = { ...record, status: "running", error: undefined, approval: { ...record.approval!, status: "pending", decision: null } };
  const out = roundTrip([{ ...base, call: running, tool: { server: "GitHub", name: "x", resultNote: "pending" } }])!;
  assert.equal(out[0].call!.status, "cancelled");
  assert.deepEqual(out[0].call!.error, { code: "cancelled" });
  assert.equal(out[0].call!.approval!.status, "expired");
  assert.equal(out[0].tool!.resultNote, "unfinished");
  assert.deepEqual(settleToolCallRecord(running as ToolCallRecord).status, "cancelled", "the same rewrite at write time");
});

test("readers clamp strings and drop unknown enum values", () => {
  const call = readToolCallRecord({ ...record, title: "x".repeat(900), args: { q: "y".repeat(900), nested: { a: 1 } }, figure: { kind: "bananas" }, error: { code: "exploded" } })!;
  assert.ok(call.title.length <= 200);
  assert.ok(String(call.args!.q).length <= 200);
  assert.equal("nested" in call.args!, false);
  assert.equal(call.figure, undefined);
  assert.equal(call.error, undefined);
  assert.equal(readToolCallRecord({ ...record, tool: "teleport" }), undefined, "an unknown tool is not presentable");
  assert.equal(readReasoningSegment({ round: 1, offset: -1 }), undefined);
  assert.equal(readCommentaryItem({ round: 0, text: "a", inline: "no" })?.inline, true);
  assert.equal(readRunFact({ key: "effort", effort: "ludicrous", auto: false }), undefined);
  assert.deepEqual(readRunNotice({ code: "stall", params: { seconds: 120, bad: { x: 1 } } }), { code: "stall", params: { seconds: 120 } });
});

test("a web result title is normalised like a source on the way back (INV-3)", () => {
  const call = readToolCallRecord({ ...record, web: { results: [{ n: 1, title: "", url: "https://www.site.example/p" }, { title: "bad", url: "javascript:x" }] } })!;
  assert.deepEqual(call.web!.results, [{ n: 1, title: "site.example", url: "https://www.site.example/p" }]);
});

test("every scripted turn's persisted activity survives a reload unchanged", () => {
  for (const script of TURN_SCRIPTS) {
    if (script.legacy) continue;
    const played = playTurnScript(script);
    const persisted = JSON.parse(JSON.stringify(played.record.activity)) as ClientActivityEvent[];
    const reloaded = serializeActivity(JSON.parse(JSON.stringify(persisted)));
    // `undefined` keys vanish in JSON; compare the JSON of both sides.
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded)), persisted, `${script.id}: a field did not survive the reload`);
  }
});

test("the pre-rework fixture row (19) reloads as it was written", () => {
  const legacy = turnScript(19).legacy!;
  assert.deepEqual(JSON.parse(JSON.stringify(serializeActivity(JSON.parse(JSON.stringify(legacy.activity))))), JSON.parse(JSON.stringify(legacy.activity)));
});

test("run-record stays importable without server-only or node:crypto (harness rule 1)", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/chat/run-record.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  const runtimeImports = source.split("\n").filter((line) => /^import (?!type )/.test(line)).join("\n");
  assert.doesNotMatch(runtimeImports, /action-approval"|node:crypto/);
  const serializers = readFileSync(path.join(process.cwd(), "src/lib/serializers.ts"), "utf8");
  assert.match(serializers, /import \{ serializeActivity \} from "@\/lib\/chat\/run-record";/, "serializers.ts delegates to it");
});
