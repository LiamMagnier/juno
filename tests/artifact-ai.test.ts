import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import type { Plan } from "@prisma/client";
import type { ModelInfo } from "@/lib/models";
import type { RecordSpendInput } from "@/lib/spend";
import type { LlmEvent } from "@/types/llm";
import {
  ALEVR_CHUNK,
  ALEVR_REQUEST,
  ALEVR_RESPONSE,
  ARTIFACT_RUNTIME_COMPLETE_PATH,
  ARTIFACT_RUNTIME_STORAGE_PATH,
  BRIDGE_MAX_INFLIGHT_COMPLETIONS,
  COMPLETE_MAX_PROMPT_CHARS,
  STORAGE_MAX_VALUE_BYTES,
  errorCodeForResponse,
  isRuntimeTarget,
  newBridgeChannel,
  parseBridgeRequest,
} from "@/lib/artifact-ai/protocol";
import { alevrBridgeScript } from "@/lib/sandbox/alevr-bridge";
import { createAlevrBridgeHost, type ConsentAnswer } from "@/lib/artifact-ai/bridge-host";
import { resolveRuntimeAccess, runsWithBridge, type RuntimeAccessDeps, type RuntimeArtifactRow } from "@/lib/artifact-ai/access";
import {
  DEFAULT_ARTIFACT_SYSTEM,
  admitArtifactCompletion,
  estimateCompletionMicroUsd,
  streamArtifactCompletion,
  type ArtifactCompletionDeps,
} from "@/lib/artifact-ai/complete";
import {
  STORAGE_LIMITS,
  createArtifactStorage,
  storageWriteVerdict,
  type ArtifactStorageStore,
  type StorageScope,
  type StorageUsage,
  type StorageVerdict,
} from "@/lib/artifact-ai/storage";
import { buildSandboxDoc } from "../src/components/canvas/sandbox-frame";
import { sandboxPolicyMeta } from "@/lib/sandbox-policy";
import { buildSystemPromptSections } from "@/lib/chat/system-prompt";

/*
 * AI-powered artifacts and their storage (src/lib/artifact-ai, window.alevr).
 *
 *   1. The bridge: what the parent accepts from a frame (channel, shape,
 *      limits), the in-frame script run in a VM against a fake parent, and
 *      the parent's host against a fake fetch: consent, sign-in, streaming,
 *      error mapping, the in-flight cap, cancel.
 *   2. Who pays and who may: the access rules (the viewer's own artifact by
 *      id, a live link only while shared previews run scripts) and the
 *      completion's metering (admission, hold, guard, one ledger row per
 *      attempt, settlement) — always on the viewer's account.
 *   3. Storage: the caps, per-viewer isolation, and that the store only ever
 *      sees sealed values.
 *
 * No database and no provider: every dependency is a fake handed in.
 */

const CHANNEL = "test-channel-0123456789";

// ── 1. The bridge ───────────────────────────────────────────────────────────

test("the parent drops messages that are not bridge calls on this frame's channel", () => {
  assert.equal(parseBridgeRequest(null, CHANNEL), null);
  assert.equal(parseBridgeRequest({ type: "juno:console", text: "hi" }, CHANNEL), null);
  // A document the preview navigated to never saw the channel: no answer at all.
  assert.equal(parseBridgeRequest({ type: ALEVR_REQUEST, channel: "guess", id: "r1", method: "complete" }, CHANNEL), null);
  assert.equal(parseBridgeRequest({ type: ALEVR_REQUEST, id: "r1", method: "complete" }, CHANNEL), null);
  // No channel configured means nothing is accepted, not everything.
  assert.equal(parseBridgeRequest({ type: ALEVR_REQUEST, channel: "", id: "r1", method: "complete" }, ""), null);
});

test("a malformed bridge call is refused with a reason, never forwarded", () => {
  const call = (body: Record<string, unknown>) => parseBridgeRequest({ type: ALEVR_REQUEST, channel: CHANNEL, ...body }, CHANNEL);
  assert.deepEqual(call({ id: "<script>", method: "complete" }), {
    ok: false,
    id: null,
    code: "invalid_request",
    message: "The request has no usable id.",
  });
  const unknown = call({ id: "r1", method: "fetch", params: { url: "https://example.com" } });
  assert.equal(unknown?.ok, false);
  assert.equal(unknown && !unknown.ok && unknown.id, "r1");

  const empty = call({ id: "r1", method: "complete", params: { prompt: "   " } });
  assert.ok(empty && !empty.ok && /prompt/.test(empty.message));
  const long = call({ id: "r1", method: "complete", params: { prompt: "x".repeat(COMPLETE_MAX_PROMPT_CHARS + 1) } });
  assert.ok(long && !long.ok && long.code === "too_large");
  for (const maxTokens of [0, 4097, 1.5, "100"]) {
    const bad = call({ id: "r1", method: "complete", params: { prompt: "hi", maxTokens } });
    assert.ok(bad && !bad.ok, `maxTokens ${String(maxTokens)}`);
  }
  for (const key of ["", "k".repeat(201), "line\nbreak", 42, null]) {
    const bad = call({ id: "r1", method: "storage.get", params: { key } });
    assert.ok(bad && !bad.ok, `key ${JSON.stringify(key)}`);
  }
  // Values with no JSON form are refused rather than stored as nothing.
  for (const value of [undefined, () => 1, BigInt(1)]) {
    const bad = call({ id: "r1", method: "storage.set", params: { key: "k", value } });
    assert.ok(bad && !bad.ok, `value ${typeof value}`);
  }
  const huge = call({ id: "r1", method: "storage.set", params: { key: "k", value: "x".repeat(STORAGE_MAX_VALUE_BYTES) } });
  assert.ok(huge && !huge.ok && huge.code === "too_large");
});

test("a well-formed bridge call is normalized to exactly what the routes accept", () => {
  const ok = (body: Record<string, unknown>) => {
    const parsed = parseBridgeRequest({ type: ALEVR_REQUEST, channel: CHANNEL, ...body }, CHANNEL);
    assert.ok(parsed?.ok, JSON.stringify(parsed));
    return parsed.request;
  };
  assert.deepEqual(ok({ id: "r1", method: "complete", params: { prompt: "Name a colour", extra: "dropped" } }), {
    id: "r1",
    method: "complete",
    params: { prompt: "Name a colour", maxTokens: 1024, stream: false },
  });
  assert.deepEqual(ok({ id: "r2", method: "complete", params: { prompt: "p", system: "s", maxTokens: 64, stream: true } }), {
    id: "r2",
    method: "complete",
    params: { prompt: "p", system: "s", maxTokens: 64, stream: true },
  });
  assert.deepEqual(ok({ id: "r3", method: "storage.set", params: { key: "todos", value: [{ done: false }] } }), {
    id: "r3",
    method: "storage.set",
    params: { key: "todos", valueJson: '[{"done":false}]' },
  });
  assert.deepEqual(ok({ id: "r4", method: "storage.list", params: {} }), { id: "r4", method: "storage.list", params: { prefix: "" } });
  assert.deepEqual(ok({ id: "r5:cancel", method: "cancel", params: { id: "r2" } }), {
    id: "r5:cancel",
    method: "cancel",
    params: { id: "r2" },
  });
});

test("targets are one id or one token, never both or anything else", () => {
  assert.equal(isRuntimeTarget({ artifactId: "cm123abc" }), true);
  assert.equal(isRuntimeTarget({ shareToken: "A".repeat(32) }), true);
  assert.equal(isRuntimeTarget({ artifactId: "cm123abc", shareToken: "A".repeat(32) }), false);
  assert.equal(isRuntimeTarget({ shareToken: "short" }), false);
  assert.equal(isRuntimeTarget({ artifactId: "../../etc" }), false);
  assert.equal(isRuntimeTarget({ userId: "u1" }), false);
  assert.equal(errorCodeForResponse(402, { code: "QUOTA_EXCEEDED" }), "budget_exceeded");
  assert.equal(errorCodeForResponse(401, null), "sign_in_required");
  assert.equal(errorCodeForResponse(413, { code: "storage_full" }), "storage_full");
  const a = newBridgeChannel();
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, newBridgeChannel());
});

/** Run the in-frame script in a VM whose `window.parent` records what it is sent. */
function frameWithBridge(channel = CHANNEL) {
  const posted: Record<string, unknown>[] = [];
  const listeners: ((e: { source: unknown; data: unknown }) => void)[] = [];
  const parentWindow = {
    // Structured clone, as the real postMessage does: a function in a value throws.
    postMessage: (message: unknown) => posted.push(structuredClone(message) as Record<string, unknown>),
  };
  const sandbox: Record<string, unknown> = {
    console,
    parent: parentWindow,
    addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
      if (type === "message") listeners.push(fn);
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const html = alevrBridgeScript(channel);
  // The bridge is exactly one inline script element; run what is inside it.
  const open = "<script>";
  const close = "</script>";
  assert.ok(html.startsWith(open) && html.endsWith(close), "the bridge is one <script> element");
  const body = html.slice(open.length, html.length - close.length);
  vm.runInContext(body, sandbox);
  const deliver = (data: unknown, source: unknown = parentWindow) => listeners.forEach((fn) => fn({ source, data }));
  const alevr = sandbox.alevr as {
    complete: (input: unknown) => Promise<string>;
    stream: (input: unknown) => AsyncIterable<string>;
    storage: {
      get: (key: string) => Promise<unknown>;
      set: (key: string, value: unknown) => Promise<void>;
      delete: (key: string) => Promise<boolean>;
      list: (prefix?: string) => Promise<string[]>;
    };
  };
  return { posted, deliver, alevr, sandbox };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("window.alevr in the frame posts to its parent on its channel and accepts only its parent's answers", async () => {
  const { posted, deliver, alevr, sandbox } = frameWithBridge();
  assert.ok(Object.isFrozen(alevr) && Object.isFrozen(alevr.storage));
  // Not replaceable by artifact code.
  assert.equal(Reflect.set(sandbox, "alevr", {}), false);
  assert.equal(sandbox.alevr, alevr);

  const answer = alevr.complete("Say hi");
  const request = posted[0];
  assert.equal(request.type, ALEVR_REQUEST);
  assert.equal(request.channel, CHANNEL);
  assert.equal(request.method, "complete");
  assert.deepEqual(request.params, { prompt: "Say hi", system: undefined, maxTokens: undefined, stream: false });

  let settled = false;
  void answer.then(() => (settled = true), () => (settled = true));
  // Another window, the wrong channel or an unknown id is ignored.
  deliver({ type: ALEVR_RESPONSE, channel: CHANNEL, id: request.id, ok: true, result: "forged" }, { postMessage() {} });
  deliver({ type: ALEVR_RESPONSE, channel: "other", id: request.id, ok: true, result: "forged" });
  deliver({ type: ALEVR_RESPONSE, channel: CHANNEL, id: "nope", ok: true, result: "forged" });
  await flush();
  assert.equal(settled, false);

  deliver({ type: ALEVR_RESPONSE, channel: CHANNEL, id: request.id, ok: true, result: "Hi!" });
  assert.equal(await answer, "Hi!");
});

test("window.alevr streams chunks to onText and rejects with the parent's error code", async () => {
  const { posted, deliver, alevr } = frameWithBridge();
  const chunks: string[] = [];
  const streamed = alevr.complete({ prompt: "Count", onText: (t: string) => chunks.push(t) });
  const req = posted[0];
  assert.equal((req.params as { stream: boolean }).stream, true);
  deliver({ type: ALEVR_CHUNK, channel: CHANNEL, id: req.id, text: "one " });
  deliver({ type: ALEVR_CHUNK, channel: CHANNEL, id: req.id, text: "two" });
  deliver({ type: ALEVR_RESPONSE, channel: CHANNEL, id: req.id, ok: true, result: "one two" });
  assert.equal(await streamed, "one two");
  assert.deepEqual(chunks, ["one ", "two"]);

  const iterated = (async () => {
    const parts: string[] = [];
    for await (const part of alevr.stream({ prompt: "Go" })) parts.push(part);
    return parts;
  })();
  await flush();
  const req2 = posted[1];
  deliver({ type: ALEVR_CHUNK, channel: CHANNEL, id: req2.id, text: "a" });
  deliver({ type: ALEVR_CHUNK, channel: CHANNEL, id: req2.id, text: "b" });
  deliver({ type: ALEVR_RESPONSE, channel: CHANNEL, id: req2.id, ok: true, result: "ab" });
  assert.deepEqual(await iterated, ["a", "b"]);

  const refused = alevr.storage.get("k");
  const req3 = posted[2];
  assert.deepEqual(req3.params, { key: "k" });
  deliver({ type: ALEVR_RESPONSE, channel: CHANNEL, id: req3.id, ok: false, error: { code: "budget_exceeded", message: "Spent." } });
  await assert.rejects(refused, (err: Error & { code?: string }) => err.code === "budget_exceeded" && err.message === "Spent.");

  // A value structured clone cannot carry is refused in the frame itself.
  await assert.rejects(alevr.storage.set("k", { fn() {} }), (err: Error & { code?: string }) => err.code === "invalid_request");
  assert.equal(posted.length, 3);
});

test("an aborted call is cancelled in the frame and the parent is told", async () => {
  const { posted, alevr } = frameWithBridge();
  const controller = new AbortController();
  const pending = alevr.complete({ prompt: "Long", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err: Error & { code?: string }) => err.code === "aborted");
  assert.equal(posted[1].method, "cancel");
  assert.deepEqual(posted[1].params, { id: posted[0].id });
});

test("preview documents carry the bridge right after the policy, and only where scripts run as an app", () => {
  const react = buildSandboxDoc("REACT", "export default function App(){return <p>hi</p>}", "tsx", "private", undefined, { channel: CHANNEL });
  const meta = sandboxPolicyMeta("private");
  assert.ok(react.includes(meta + alevrBridgeScript(CHANNEL)), "bridge directly after the policy meta");
  const html = buildSandboxDoc("HTML", "<html><head><script>window.alevr.storage.get('x')</script></head><body></body></html>", "html", "public", undefined, { channel: CHANNEL });
  assert.ok(html.indexOf(alevrBridgeScript(CHANNEL)) < html.indexOf("window.alevr.storage.get('x')"), "before the author's head scripts");
  // No channel, no bridge; no script runs at all on the static profile; a console run is not an app.
  assert.doesNotMatch(buildSandboxDoc("REACT", "export default function A(){return null}", "tsx"), /alevr:request/);
  assert.doesNotMatch(buildSandboxDoc("HTML", "<p>x</p>", "html", "static", undefined, { channel: CHANNEL }), /alevr:request/);
  assert.doesNotMatch(buildSandboxDoc("CODE", "console.log(1)", "javascript", "private", undefined, { channel: CHANNEL }), /alevr:request/);
  assert.doesNotMatch(buildSandboxDoc("SVG", "<svg/>", "svg", "private", undefined, { channel: CHANNEL }), /alevr:request/);
  // A channel cannot end the script element it is written into.
  assert.doesNotMatch(alevrBridgeScript("</script><img src=x>"), /<\/script><img/);
});

/** A fake fetch that records calls and answers from a queue. */
function fakeFetch(answers: ((url: string, init: RequestInit) => Response | Promise<Response>)[]) {
  const calls: { url: string; body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: JSON.parse(String(init?.body)), signal: init?.signal });
    const next = answers.shift();
    if (!next) throw new Error("unexpected fetch");
    return next(u, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function ndjson(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split a line across chunks, as a real network would.
        const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
        const mid = Math.floor(text.length / 2);
        controller.enqueue(encoder.encode(text.slice(0, mid)));
        controller.enqueue(encoder.encode(text.slice(mid)));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } }
  );
}

function hostHarness(opts: { target?: { artifactId: string } | { shareToken: string } | null; askConsent?: () => Promise<ConsentAnswer>; answers?: Parameters<typeof fakeFetch>[0] } = {}) {
  const sent: Record<string, unknown>[] = [];
  const { fetchImpl, calls } = fakeFetch(opts.answers ?? []);
  const host = createAlevrBridgeHost({
    channel: CHANNEL,
    target: opts.target === undefined ? { artifactId: "art1" } : opts.target,
    post: (m) => sent.push(m),
    fetch: fetchImpl,
    askConsent: opts.askConsent,
  });
  const call = (id: string, method: string, params: Record<string, unknown>) =>
    host.handle({ type: ALEVR_REQUEST, channel: CHANNEL, id, method, params });
  const answerFor = (id: string) => sent.find((m) => m.type === ALEVR_RESPONSE && m.id === id);
  return { host, sent, calls, call, answerFor };
}

async function until(check: () => unknown) {
  for (let i = 0; i < 50 && !check(); i++) await flush();
  assert.ok(check(), "condition never held");
}

test("the host refuses every call when there is no saved artifact behind the preview", async () => {
  const h = hostHarness({ target: null });
  h.call("r1", "complete", { prompt: "hi" });
  await until(() => h.answerFor("r1"));
  assert.deepEqual((h.answerFor("r1") as { error: unknown }).error, {
    code: "unavailable",
    message: "AI and storage work once this artifact is saved and opened in the app.",
  });
  assert.equal(h.calls.length, 0);
  // Wrong channel: no answer at all.
  h.host.handle({ type: ALEVR_REQUEST, channel: "x", id: "r2", method: "complete", params: { prompt: "hi" } });
  await flush();
  assert.equal(h.answerFor("r2"), undefined);
});

test("the host completes through the route and streams chunks only when the frame asked", async () => {
  const lines = [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }, { type: "done", model: "m" }];
  const h = hostHarness({ answers: [() => ndjson(lines), () => ndjson(lines)] });
  h.call("r1", "complete", { prompt: "hi", maxTokens: 50, stream: true });
  await until(() => h.answerFor("r1"));
  assert.equal(h.calls[0].url, ARTIFACT_RUNTIME_COMPLETE_PATH);
  assert.deepEqual(h.calls[0].body, { target: { artifactId: "art1" }, prompt: "hi", maxTokens: 50 });
  assert.deepEqual(
    h.sent.filter((m) => m.type === ALEVR_CHUNK).map((m) => m.text),
    ["Hel", "lo"]
  );
  assert.deepEqual(h.answerFor("r1"), { type: ALEVR_RESPONSE, channel: CHANNEL, id: "r1", ok: true, result: "Hello" });

  h.call("r2", "complete", { prompt: "hi" });
  await until(() => h.answerFor("r2"));
  assert.equal(h.sent.filter((m) => m.type === ALEVR_CHUNK && m.id === "r2").length, 0);
});

test("the host maps route refusals and a failed stream onto error codes", async () => {
  const h = hostHarness({
    answers: [
      () => Response.json({ error: "You've used up your plan's usage budget.", code: "QUOTA_EXCEEDED" }, { status: 402 }),
      () => Response.json({ error: "Too many.", code: "rate_limited" }, { status: 429 }),
      () => ndjson([{ type: "text", text: "partial" }, { type: "error", code: "budget_exceeded", message: "Stopped." }]),
      () => ndjson([{ type: "text", text: "cut off" }]),
    ],
  });
  for (const id of ["r1", "r2", "r3", "r4"]) h.call(id, "complete", { prompt: "hi" });
  await until(() => ["r1", "r2", "r3", "r4"].every((id) => h.answerFor(id)));
  const code = (id: string) => (h.answerFor(id) as { error: { code: string } }).error.code;
  assert.equal(code("r1"), "budget_exceeded");
  assert.equal((h.answerFor("r1") as { error: { message: string } }).error.message, "You've used up your plan's usage budget.");
  assert.equal(code("r2"), "rate_limited");
  assert.equal(code("r3"), "budget_exceeded");
  assert.equal(code("r4"), "failed");
});

test("the host runs storage calls and splices a set value in without re-encoding it", async () => {
  const h = hostHarness({
    answers: [
      () => Response.json({ ok: true, usedBytes: 20 }),
      () => Response.json({ found: true, value: { a: [1, 2] } }),
      () => Response.json({ found: false, value: null }),
      () => Response.json({ keys: ["a", "b"] }),
      () => Response.json({ ok: true, deleted: true }),
    ],
  });
  h.call("s1", "storage.set", { key: "a", value: { a: [1, 2] } });
  await until(() => h.answerFor("s1"));
  assert.equal(h.calls[0].url, ARTIFACT_RUNTIME_STORAGE_PATH);
  assert.deepEqual(h.calls[0].body, { target: { artifactId: "art1" }, op: "set", key: "a", value: { a: [1, 2] } });
  h.call("s2", "storage.get", { key: "a" });
  h.call("s3", "storage.get", { key: "missing" });
  h.call("s4", "storage.list", { prefix: "" });
  h.call("s5", "storage.delete", { key: "a" });
  await until(() => ["s2", "s3", "s4", "s5"].every((id) => h.answerFor(id)));
  const result = (id: string) => (h.answerFor(id) as { result: unknown }).result;
  assert.equal(result("s1"), null);
  assert.deepEqual(result("s2"), { a: [1, 2] });
  assert.equal(result("s3"), null);
  assert.deepEqual(result("s4"), ["a", "b"]);
  assert.equal(result("s5"), true);
});

test("on a shared page the visitor is asked once, and a no or a sign-in stops calls before the network", async () => {
  let asked = 0;
  let answer: ConsentAnswer = "denied";
  const denied = hostHarness({ target: { shareToken: "T".repeat(32) }, askConsent: async () => {
      asked++;
      return answer;
    } });
  denied.call("r1", "complete", { prompt: "hi" });
  denied.call("r2", "storage.get", { key: "k" });
  await until(() => denied.answerFor("r1") && denied.answerFor("r2"));
  assert.equal(asked, 1, "asked once for both calls");
  assert.equal((denied.answerFor("r1") as { error: { code: string } }).error.code, "consent_denied");
  assert.equal((denied.answerFor("r2") as { error: { code: string } }).error.code, "consent_denied");
  assert.equal(denied.calls.length, 0);

  answer = "sign_in";
  asked = 0;
  const signedOut = hostHarness({ target: { shareToken: "T".repeat(32) }, askConsent: async () => {
      asked++;
      return answer;
    } });
  signedOut.call("r1", "complete", { prompt: "hi" });
  await until(() => signedOut.answerFor("r1"));
  assert.equal((signedOut.answerFor("r1") as { error: { code: string } }).error.code, "sign_in_required");
  assert.equal(signedOut.calls.length, 0);

  asked = 0;
  answer = "granted";
  const granted = hostHarness({
    target: { shareToken: "T".repeat(32) },
    askConsent: async () => {
      asked++;
      return answer;
    },
    answers: [() => Response.json({ found: false, value: null }), () => Response.json({ found: false, value: null })],
  });
  granted.call("r1", "storage.get", { key: "a" });
  await until(() => granted.answerFor("r1"));
  granted.call("r2", "storage.get", { key: "b" });
  await until(() => granted.answerFor("r2"));
  assert.equal(asked, 1);
  assert.deepEqual(granted.calls[0].body.target, { shareToken: "T".repeat(32) });
});

test("the host caps calls in flight per frame, and cancel and dispose abort them", async () => {
  const never = (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const h = hostHarness({ answers: Array.from({ length: BRIDGE_MAX_INFLIGHT_COMPLETIONS }, () => never) });
  for (let i = 0; i < BRIDGE_MAX_INFLIGHT_COMPLETIONS + 1; i++) h.call(`r${i}`, "complete", { prompt: "hi" });
  await until(() => h.calls.length === BRIDGE_MAX_INFLIGHT_COMPLETIONS && h.answerFor(`r${BRIDGE_MAX_INFLIGHT_COMPLETIONS}`));
  assert.equal((h.answerFor(`r${BRIDGE_MAX_INFLIGHT_COMPLETIONS}`) as { error: { code: string } }).error.code, "busy");

  h.call("c1", "cancel", { id: "r0" });
  await until(() => h.calls[0].signal?.aborted);
  // The frame already rejected a cancelled call; the host does not answer it.
  await flush();
  assert.equal(h.answerFor("r0"), undefined);

  h.host.dispose();
  assert.ok(h.calls.every((c) => c.signal?.aborted));
  await flush();
  assert.equal(h.sent.filter((m) => m.type === ALEVR_RESPONSE).length, 1, "only the busy refusal was ever sent");
});

// ── 2. Who may, and who pays ────────────────────────────────────────────────

const OWNER = "user-owner";
const VISITOR = "user-visitor";

function accessDeps(rows: (RuntimeArtifactRow & { ownerId: string; token?: string })[], scripts = true) {
  const lookups: string[] = [];
  const deps: RuntimeAccessDeps = {
    async findOwnedArtifact(viewerId, artifactId) {
      lookups.push(`owned:${viewerId}:${artifactId}`);
      const row = rows.find((r) => r.id === artifactId && r.ownerId === viewerId);
      return row ? { id: row.id, type: row.type, language: row.language } : null;
    },
    async findLinkedArtifact(token) {
      lookups.push(`link:${token}`);
      const row = rows.find((r) => r.token === token);
      return row ? { id: row.id, type: row.type, language: row.language } : null;
    },
    publicScriptsEnabled: () => scripts,
  };
  return { deps, lookups };
}

const TOKEN = "L".repeat(32);
const APP = { id: "art-app", type: "REACT" as const, language: "tsx", ownerId: OWNER, token: TOKEN };
const DOC = { id: "art-doc", type: "MARKDOWN" as const, language: null, ownerId: OWNER, token: "D".repeat(32) };

test("by id, only the viewer's own artifact; a stranger's is the same not-found as none", async () => {
  const { deps, lookups } = accessDeps([APP]);
  assert.deepEqual(await resolveRuntimeAccess(OWNER, { artifactId: APP.id }, deps), {
    ok: true,
    artifactId: APP.id,
    viewerId: OWNER,
    via: "owner",
  });
  const stranger = await resolveRuntimeAccess(VISITOR, { artifactId: APP.id }, deps);
  const none = await resolveRuntimeAccess(VISITOR, { artifactId: "missing" }, deps);
  assert.equal(stranger.ok, false);
  assert.deepEqual(stranger, none);
  assert.deepEqual(lookups, [`owned:${OWNER}:${APP.id}`, `owned:${VISITOR}:${APP.id}`, `owned:${VISITOR}:missing`]);
});

test("by link, the visitor is the viewer, and only while shared previews run scripts", async () => {
  const on = accessDeps([APP, DOC]);
  const visitor = await resolveRuntimeAccess(VISITOR, { shareToken: TOKEN }, on.deps);
  assert.deepEqual(visitor, { ok: true, artifactId: APP.id, viewerId: VISITOR, via: "link" });
  // The owner's id is not in the answer at all, so nothing downstream can bill it.
  assert.doesNotMatch(JSON.stringify(visitor), new RegExp(OWNER));

  const doc = await resolveRuntimeAccess(VISITOR, { shareToken: DOC.token! }, on.deps);
  assert.ok(!doc.ok && doc.status === 409);

  const off = accessDeps([APP], false);
  const refused = await resolveRuntimeAccess(VISITOR, { shareToken: TOKEN }, off.deps);
  assert.ok(!refused.ok && refused.status === 409);
  assert.deepEqual(off.lookups, [], "no lookup while shared previews are static");

  assert.equal(runsWithBridge("HTML", null), true);
  assert.equal(runsWithBridge("CODE", "jsx"), true);
  assert.equal(runsWithBridge("CODE", "python"), false);
  assert.equal(runsWithBridge("DESIGN", null), false);
  assert.equal(runsWithBridge("SPREADSHEET", null), false);
});

const MODEL_A = {
  id: "openai:test-artifact",
  provider: "openai",
  providerModel: "gpt-4.1-mini",
  name: "Artifact fixture A",
  family: "gpt",
  minPlan: "FREE",
  cost: 1,
  modality: "chat",
} as ModelInfo;
const MODEL_B = { ...MODEL_A, id: "google:test-artifact", provider: "google", providerModel: "gemini-2.5-flash", name: "Artifact fixture B" } as ModelInfo;

function completionHarness({
  scripts = {},
  ...over
}: Partial<ArtifactCompletionDeps> & { scripts?: Record<string, (signal: AbortSignal) => AsyncIterable<LlmEvent>> } = {}) {
  const log: string[] = [];
  const records: RecordSpendInput[] = [];
  const settled: { userId: string; ref: string; micro: number }[] = [];
  const streamed: { model: string; system: string; prompt: string; maxTokens: number }[] = [];
  const deps: ArtifactCompletionDeps = {
    resolveModels: async (userId) => (log.push(`models:${userId}`), [MODEL_A, MODEL_B]),
    admit: async (input) => (log.push(`admit:${input.userId}:${input.estimateMicroUsd}`), { allowed: true, remainingMicroUsd: 1_000_000 }),
    reserve: async (input) => (log.push(`reserve:${input.userId}:${input.ref}`), { allowed: true }),
    settle: async (userId, ref, micro) => {
      settled.push({ userId, ref, micro });
    },
    stream: (input) => {
      streamed.push({ model: input.model.id, system: input.system, prompt: input.prompt, maxTokens: input.maxTokens });
      const script = scripts[input.model.id];
      if (!script) throw new Error(`no script for ${input.model.id}`);
      return script(input.signal);
    },
    record: async (input) => {
      records.push(input);
    },
    rates: () => ({ input: 1, output: 4 }),
    newRef: () => "ref-1",
    ...over,
  };
  return { deps, log, records, settled, streamed };
}

async function collect(gen: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const input = (viewerId: string) => ({ viewerId, plan: "PRO" as Plan, prompt: "Suggest a name", maxTokens: 100 });

test("the estimate is an upper bound: the whole prompt and the whole reply cap", () => {
  assert.equal(estimateCompletionMicroUsd({ input: 1, output: 4 }, 4000, 1000), 1000 + 4000);
  assert.equal(estimateCompletionMicroUsd({ input: 0.1, output: 0.4 }, 4, 1), 500, "never below the floor");
});

test("a refusal before the provider costs nothing and reaches no model", async () => {
  const noModel = completionHarness({ resolveModels: async () => [] });
  const r1 = await admitArtifactCompletion(input(VISITOR), noModel.deps);
  assert.ok(!r1.ok && r1.status === 409 && r1.body.code === "model_unavailable");

  const spent = completionHarness({
    admit: async () => ({ allowed: false, body: { error: "You've used up your plan's usage budget.", code: "QUOTA_EXCEEDED" } }),
  });
  const r2 = await admitArtifactCompletion(input(VISITOR), spent.deps);
  assert.ok(!r2.ok && r2.status === 402);
  assert.equal(r2.body.code, "budget_exceeded");
  assert.equal(r2.body.error, "You've used up your plan's usage budget.");
  assert.deepEqual(spent.log, [`models:${VISITOR}`], "no hold after a refused admission");
  assert.equal(spent.streamed.length, 0);

  const held = completionHarness({ reserve: async () => ({ allowed: false }) });
  const r3 = await admitArtifactCompletion(input(VISITOR), held.deps);
  assert.ok(!r3.ok && r3.status === 402 && r3.body.code === "budget_exceeded");
  assert.equal(held.streamed.length, 0);
});

test("a completion is admitted, held, streamed, billed and settled on the viewer's account", async () => {
  const h = completionHarness({
    scripts: {
      [MODEL_A.id]: async function* () {
        yield { type: "text", text: "Lumen" };
        yield { type: "usage", input: 40, output: 3 };
      },
    },
  });
  const admitted = await admitArtifactCompletion(input(VISITOR), h.deps);
  assert.ok(admitted.ok);
  // The estimate covers the dearer of the two models it may land on.
  const promptChars = DEFAULT_ARTIFACT_SYSTEM.length + "Suggest a name".length;
  assert.equal(h.log[1], `admit:${VISITOR}:${estimateCompletionMicroUsd({ input: 1, output: 4 }, promptChars, 100)}`);
  assert.equal(h.log[2], `reserve:${VISITOR}:ref-1`);
  const events = await collect(streamArtifactCompletion(admitted.admission, h.deps, new AbortController().signal));
  assert.deepEqual(events, [{ type: "text", text: "Lumen" }, { type: "done", model: MODEL_A.id }]);
  assert.equal(h.streamed[0].system, DEFAULT_ARTIFACT_SYSTEM);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].userId, VISITOR);
  assert.equal(h.records[0].kind, "utility");
  assert.equal(h.records[0].promptTokens, 40);
  assert.equal(h.records[0].completionTokens, 3);
  assert.equal(h.settled.length, 1);
  assert.equal(h.settled[0].userId, VISITOR);
  assert.equal(h.settled[0].ref, "ref-1");
  assert.equal(h.settled[0].micro, Math.round((h.records[0].costUsd ?? 0) * 1_000_000));
  // Nothing in the whole call names the owner.
  assert.doesNotMatch(JSON.stringify([h.log, h.records, h.settled]), new RegExp(OWNER));
});

test("a provider rejection it never consumed is not billed, and the next model answers", async () => {
  const h = completionHarness({
    scripts: {
      // Refused before the first event: nothing was consumed.
      [MODEL_A.id]: async function* () {
        yield* [];
        throw Object.assign(new Error("Rate limited"), { status: 429 });
      },
      [MODEL_B.id]: async function* () {
        yield { type: "text", text: "Ok" };
      },
    },
  });
  const admitted = await admitArtifactCompletion(input(VISITOR), h.deps);
  assert.ok(admitted.ok);
  const events = await collect(streamArtifactCompletion(admitted.admission, h.deps, new AbortController().signal));
  assert.deepEqual(events, [{ type: "text", text: "Ok" }, { type: "done", model: MODEL_B.id }]);
  assert.deepEqual(h.records.map((r) => r.model), [MODEL_B.id]);
  assert.equal(h.settled.length, 1);
});

test("a failure after text reached the app is final and still billed", async () => {
  const h = completionHarness({
    scripts: {
      [MODEL_A.id]: async function* () {
        yield { type: "text", text: "Half an ans" };
        throw new Error("socket hang up");
      },
    },
  });
  const admitted = await admitArtifactCompletion(input(VISITOR), h.deps);
  assert.ok(admitted.ok);
  const events = await collect(streamArtifactCompletion(admitted.admission, h.deps, new AbortController().signal));
  assert.deepEqual(events.map((e) => (e as { type: string }).type), ["text", "error"]);
  assert.equal(h.streamed.length, 1, "no second model glued onto a half answer");
  assert.equal(h.records.length, 1);
  assert.ok((h.records[0].costUsd ?? 0) > 0);
});

test("the stream guard stops a reply at what the viewer has left, and bills what ran", async () => {
  let aborted = false;
  const h = completionHarness({
    admit: async () => ({ allowed: true, remainingMicroUsd: 300 }),
    scripts: {
      [MODEL_A.id]: async function* (signal: AbortSignal) {
        signal.addEventListener("abort", () => (aborted = true));
        // 400 characters ≈ 100 tokens at 4 micro-USD each: past the 300 left.
        yield { type: "text", text: "x".repeat(400) };
        yield { type: "text", text: "never read" };
      },
    },
  });
  const admitted = await admitArtifactCompletion(input(VISITOR), h.deps);
  assert.ok(admitted.ok);
  const events = await collect(streamArtifactCompletion(admitted.admission, h.deps, new AbortController().signal));
  assert.deepEqual(events.map((e) => (e as { type: string; code?: string }).code ?? (e as { type: string }).type), ["text", "budget_exceeded"]);
  assert.equal(aborted, true, "the provider request was aborted");
  assert.equal(h.records.length, 1);
  assert.equal(h.settled.length, 1);
});

test("a page that goes away mid-reply gets no done line, and the call is still billed and settled", async () => {
  const page = new AbortController();
  const h = completionHarness({
    scripts: {
      [MODEL_A.id]: async function* () {
        yield { type: "text", text: "First" };
        page.abort();
        yield { type: "text", text: "Second" };
      },
    },
  });
  const admitted = await admitArtifactCompletion(input(VISITOR), h.deps);
  assert.ok(admitted.ok);
  const events = await collect(streamArtifactCompletion(admitted.admission, h.deps, page.signal));
  assert.deepEqual(events, [{ type: "text", text: "First" }]);
  assert.equal(h.records.length, 1);
  assert.equal(h.settled.length, 1);
});

// ── 3. Storage ──────────────────────────────────────────────────────────────

/** An in-memory store that keeps what it is given, so the tests can see it sealed. */
function memoryStore() {
  const rows = new Map<string, { scope: StorageScope; key: string; stored: string; bytes: number }>();
  const id = (scope: StorageScope, key: string) => JSON.stringify([scope.artifactId, scope.userId, key]);
  const store: ArtifactStorageStore = {
    async get(scope, key) {
      const row = rows.get(id(scope, key));
      return row ? { stored: row.stored } : null;
    },
    async list(scope, prefix, limit) {
      return [...rows.values()]
        .filter((r) => r.scope.artifactId === scope.artifactId && r.scope.userId === scope.userId && r.key.startsWith(prefix))
        .map((r) => r.key)
        .sort()
        .slice(0, limit);
    },
    async put(scope, entry, decide): Promise<StorageVerdict> {
      const mine = [...rows.values()].filter((r) => r.scope.userId === scope.userId);
      const here = mine.filter((r) => r.scope.artifactId === scope.artifactId);
      const existing = rows.get(id(scope, entry.key));
      const usage: StorageUsage = {
        existingKey: !!existing,
        existingBytes: existing?.bytes ?? 0,
        artifactBytes: here.reduce((n, r) => n + r.bytes, 0),
        artifactKeys: here.length,
        accountBytes: mine.reduce((n, r) => n + r.bytes, 0),
      };
      const verdict = decide(usage);
      if (verdict.ok) rows.set(id(scope, entry.key), { scope, key: entry.key, stored: entry.stored, bytes: entry.bytes });
      return verdict;
    },
    async delete(scope, key) {
      return rows.delete(id(scope, key));
    },
  };
  return { store, rows };
}

const seal = (plain: string) => `sealed:${Buffer.from(plain).toString("base64")}`;
const open = (stored: string) =>
  stored.startsWith("sealed:") ? Buffer.from(stored.slice("sealed:".length), "base64").toString() : null;

test("storage keeps JSON per artifact and per viewer, and the store only ever sees it sealed", async () => {
  const { store, rows } = memoryStore();
  const storage = createArtifactStorage({ store, seal, open });
  const ownerScope = { artifactId: APP.id, userId: OWNER };
  const visitorScope = { artifactId: APP.id, userId: VISITOR };

  assert.deepEqual(await storage.set(ownerScope, "notes", JSON.stringify({ text: "private diary" })), { ok: true, artifactBytes: 5 + 24 });
  for (const row of rows.values()) assert.doesNotMatch(row.stored, /private diary/);

  assert.deepEqual(await storage.get(ownerScope, "notes"), { ok: true, valueJson: '{"text":"private diary"}' });
  // The same artifact, another viewer: a store of their own, empty.
  assert.deepEqual(await storage.get(visitorScope, "notes"), { ok: true, valueJson: null });
  assert.deepEqual(await storage.list(visitorScope, ""), { ok: true, keys: [] });
  assert.deepEqual(await storage.delete(visitorScope, "notes"), { ok: true, deleted: false });
  assert.deepEqual(await storage.get(ownerScope, "notes"), { ok: true, valueJson: '{"text":"private diary"}' });

  await storage.set(ownerScope, "todo:1", "true");
  await storage.set(ownerScope, "todo:2", "false");
  assert.deepEqual(await storage.list(ownerScope, "todo:"), { ok: true, keys: ["todo:1", "todo:2"] });
  assert.deepEqual(await storage.delete(ownerScope, "todo:1"), { ok: true, deleted: true });
  assert.deepEqual(await storage.list(ownerScope, "todo:"), { ok: true, keys: ["todo:2"] });

  // A value that cannot be unsealed is an error, not silently missing data.
  rows.set(JSON.stringify([APP.id, OWNER, "broken"]), { scope: ownerScope, key: "broken", stored: "garbage", bytes: 1 });
  const broken = await storage.get(ownerScope, "broken");
  assert.ok(!broken.ok && broken.code === "failed");

  const invalid = await storage.set(ownerScope, "k", "{not json");
  assert.ok(!invalid.ok && invalid.code === "invalid_request");
  const badKey = await storage.get(ownerScope, "");
  assert.ok(!badKey.ok && badKey.code === "invalid_request");
});

test("storage caps: a value, an artifact's bytes and keys, and a viewer's whole account", async () => {
  const limits = { valueBytes: 50, artifactBytes: 100, artifactKeys: 3, accountBytes: 150 };
  const { store } = memoryStore();
  const storage = createArtifactStorage({ store, seal, open, limits });
  const a = { artifactId: "a", userId: VISITOR };
  const b = { artifactId: "b", userId: VISITOR };
  const big = JSON.stringify("x".repeat(40)); // 42 bytes; + key "k1" = 44

  const tooBig = await storage.set(a, "k", JSON.stringify("x".repeat(60)));
  assert.ok(!tooBig.ok && tooBig.code === "too_large" && tooBig.status === 413);

  assert.ok((await storage.set(a, "k1", big)).ok);
  assert.ok((await storage.set(a, "k2", big)).ok);
  const full = await storage.set(a, "k3", big);
  assert.ok(!full.ok && full.code === "storage_full" && /This app's storage is full/.test(full.error));
  // Rewriting a key frees what it held first, so the same size fits.
  assert.ok((await storage.set(a, "k2", big)).ok);
  assert.ok((await storage.set(a, "k3", '"s"')).ok);
  const keys = await storage.set(a, "k4", '"s"');
  assert.ok(!keys.ok && /keeps 3 keys/.test(keys.error));

  // Another artifact, same viewer: room in its own store, but the account cap binds.
  assert.ok((await storage.set(b, "k1", big)).ok);
  const account = await storage.set(b, "k2", big);
  assert.ok(!account.ok && /across all of them/.test(account.error));

  assert.deepEqual(STORAGE_LIMITS, { valueBytes: 5 * 1024 * 1024, artifactBytes: 20 * 1024 * 1024, artifactKeys: 1000, accountBytes: 100 * 1024 * 1024 });
  const usage = { existingKey: true, existingBytes: 90, artifactBytes: 100, artifactKeys: 3, accountBytes: 100 };
  // Replacing 90 bytes with 95 needs 105 in a 100-byte store; with 85, 95 fits.
  assert.equal(storageWriteVerdict(usage, 95, limits).ok, false);
  assert.deepEqual(storageWriteVerdict(usage, 85, limits), { ok: true, artifactBytes: 95 });
});

// ── The prompt ──────────────────────────────────────────────────────────────

test("the web prompt teaches window.alevr; a native client's never mentions it", () => {
  // `artifactAi` is the web with ARTIFACT_AI_ENABLED on (src/lib/chat/turn/prompt.ts).
  const base = { memories: [], memoryEnabled: false, canvas: true, customInstructions: "", personality: "default", responseLanguage: "auto", artifactAi: true };
  const web = buildSystemPromptSections({ ...base, semanticArtifacts: true } as never).stable;
  const native = buildSystemPromptSections({ ...base, semanticArtifacts: false } as never).stable;
  assert.match(web, /window\.alevr\.complete\(\{ prompt, system, maxTokens \}\)/);
  assert.match(web, /window\.alevr\.storage\.get\(key\)/);
  assert.match(web, /try\/catch/);
  assert.doesNotMatch(native, /alevr/);
  const noCanvas = buildSystemPromptSections({ ...base, canvas: false } as never).stable;
  assert.doesNotMatch(noCanvas, /alevr/);
});

test("with ARTIFACT_AI_ENABLED off (the default) no prompt teaches window.alevr", () => {
  const base = { memories: [], memoryEnabled: false, canvas: true, customInstructions: "", personality: "default", responseLanguage: "auto" };
  for (const opts of [{ ...base, semanticArtifacts: true }, { ...base, semanticArtifacts: true, artifactAi: false }]) {
    const web = buildSystemPromptSections(opts as never).stable;
    assert.doesNotMatch(web, /alevr\./, JSON.stringify(opts));
    // The rest of the artifact section is untouched.
    assert.match(web, /Interactive: when the user would want to DO something with the content/);
  }
  const turn = readFileSync(new URL("../src/lib/chat/turn/prompt.ts", import.meta.url), "utf8");
  assert.match(turn, /artifactAi: isArtifactAiEnabled\(\) && legacyChatClientForOrigin\(input\) === "web",/);
});

test("every write of ArtifactStorageEntry.value is the sealed text, and production seals with encryptField", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = join(dir, entry);
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry)) files.push(rel);
    }
  };
  walk("src");
  const writers = files.filter((file) => /artifactStorageEntry\.(create|update|upsert)/.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(writers, ["src/lib/artifact-ai/storage-store.ts"]);
  const store = readFileSync(join(root, "src/lib/artifact-ai/storage-store.ts"), "utf8");
  // Every `value:` the store writes (create and update) is what it was handed sealed; `select` reads aside.
  const written = (store.match(/value: [^,}]+/g) ?? []).filter((m) => !/^value: true\b/.test(m));
  assert.deepEqual(written, ["value: entry.stored", "value: entry.stored"]);
  const server = readFileSync(join(root, "src/lib/artifact-ai/server.ts"), "utf8");
  assert.match(server, /seal: \(plain\) => encryptField\(plain\)/);
  assert.match(server, /decryptField\(stored\)/);
});
