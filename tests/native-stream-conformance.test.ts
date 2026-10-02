import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSseSender, encodeChunk } from "@/lib/chat-stream";
import { parseClientFeatures } from "@/lib/chat/client-features";
import type { StreamChunk } from "@/types/chat";
import {
  decodeNativeEvent,
  decodeNativeStream,
  NativeEventTooLarge,
  NativeMalformedResponse,
  parseNativeSse,
  type NativeServerEvent,
} from "./fixtures/native-v1-decoder";
import { playTurnScript, wireBytes } from "./fixtures/turn-player";
import { TURN_SCRIPTS, type TurnScript } from "./fixtures/turn-scripts";

/*
 * WHAT A SHIPPED NATIVE BUILD READS (INV-1 to INV-6).
 *
 * Mac and iOS 1.6.0 throw on any SSE frame `type` they do not know and on a
 * known frame whose fields fail validation — and on `done`, the frame they
 * throw on is the answer. So every turn the server can produce for a request
 * that declared nothing (profile 1) must decode, frame by frame, with a port
 * of Swift's own decoder (`tests/fixtures/native-v1-decoder.ts`). The turns
 * are the `/dev/run` scripts, played through the real pipeline.
 */

function decodeTurn(script: TurnScript): NativeServerEvent[] {
  const played = playTurnScript(script, { features: [] });
  return decodeNativeStream(wireBytes(played));
}

test("every scripted turn, as a profile-1 request, decodes with the native v1 decoder", () => {
  for (const script of TURN_SCRIPTS) {
    if (script.legacy) continue;
    let events: NativeServerEvent[] = [];
    assert.doesNotThrow(() => {
      events = decodeTurn(script);
    }, `${script.id}: a shipped native build would refuse this stream`);
    assert.equal(events[0].kind, "metadata", `${script.id}: starts with meta`);
    const last = events[events.length - 1];
    assert.ok(last.kind === "completed" || last.kind === "failed", `${script.id}: ends with done or error`);
  }
});

test("what native reads matches the turn: the answer, the tool rows it knows, the approvals", () => {
  const search = decodeTurn(TURN_SCRIPTS.find((script) => script.fixture === 4)!);
  const completed = search.find((event) => event.kind === "completed");
  assert.ok(completed && completed.kind === "completed");
  assert.match(completed.content, /Three programmes fund heat pumps/);
  assert.ok(completed.sources.length >= 3, "the cited sources survive native's source validation");
  const kinds = new Set(search.flatMap((event) => (event.kind === "activity" ? [event.activityKind] : [])));
  for (const kind of ["context", "model", "search", "visit", "write", "done"]) assert.ok(kinds.has(kind), `a ${kind} row`);

  const approvals = decodeTurn(TURN_SCRIPTS.find((script) => script.fixture === 8)!);
  assert.equal(approvals.filter((event) => event.kind === "approval").length, 1);
  assert.ok(approvals.some((event) => event.kind === "activity" && event.title === "GitHub needs approval"));
});

test("the glued-text fix reaches native live: a separator delta between two steps' text", () => {
  const events = decodeTurn(TURN_SCRIPTS.find((script) => script.fixture === 27)!);
  const live = events.flatMap((event) => (event.kind === "textDelta" ? [event.text] : [])).join("");
  assert.doesNotMatch(live, /\.Applications/, "never glued");
  assert.match(live, /numbers are exact\.\n\nApplications/);
});

test("the web grammar would NOT decode natively: which is why it is gated", () => {
  const handoff = TURN_SCRIPTS.find((script) => script.handoffRunId)!;
  const played = playTurnScript(handoff);
  assert.throws(() => decodeNativeStream(wireBytes(played)), NativeMalformedResponse);
});

test("sources that would fail native's validation are normalised before they are sent (INV-3)", () => {
  const script: TurnScript = {
    fixture: 0,
    id: "hostile-sources",
    title: "Sources with titles native refuses",
    features: [],
    end: "completed",
    steps: [
      {
        atMs: 10,
        event: {
          type: "sources",
          origin: "provider_search",
          sources: [
            { title: "", url: "https://empty.example/a", snippet: "" },
            { title: "Two\nlines", url: "https://lines.example/b", snippet: "" },
            { title: "Soft\u00adhyphen and \u200Bzero width", url: "https://format.example/c", snippet: "" },
            { title: "x".repeat(5_000), url: "https://long.example/d", snippet: "y".repeat(40_000) },
            { title: "Relative", url: "/relative", snippet: "" },
            { title: "Spaces", url: "https://spaces.example/a b", snippet: "" },
          ],
        },
      },
      { atMs: 20, event: { type: "text", text: "Done.", round: 0 } },
      { atMs: 30, event: { type: "round_end", round: 0, tools: 0, serverTools: 0, final: false, stop: "end_turn" } },
    ],
  };
  const events = decodeTurn(script);
  const frame = events.find((event) => event.kind === "sources");
  assert.ok(frame && frame.kind === "sources");
  assert.deepEqual(
    frame.sources.map((source) => source.url),
    ["https://empty.example/a", "https://lines.example/b", "https://format.example/c", "https://long.example/d", "https://spaces.example/a%20b"]
  );
  assert.equal(frame.sources[0].title, "empty.example");
  assert.equal(frame.sources[2].title, "Softhyphen and zero width");
});

test("an error frame's message is one line native accepts", () => {
  const frames: Uint8Array[] = [];
  const sender = createSseSender({ enqueue: (bytes: Uint8Array) => void frames.push(bytes) } as unknown as ReadableStreamDefaultController<Uint8Array>);
  sender.send({ type: "error", message: "Provider said:\nsomething\u200B broke\u0085" });
  const [event] = decodeNativeStream(frames[0]);
  assert.deepEqual(event, { kind: "failed", message: "Provider said: something broke", finishReason: "error" });
});

test("a profile-1 sender never sends the resume notice native cannot read (INV-1)", async () => {
  const frames: Uint8Array[] = [];
  const failingLog = {
    available: false,
    record: () => null,
    flush: async () => {},
    close: async () => {},
  };
  const sender = createSseSender(
    { enqueue: (bytes: Uint8Array) => void frames.push(bytes) } as unknown as ReadableStreamDefaultController<Uint8Array>,
    { log: failingLog as never, features: parseClientFeatures([]) }
  );
  sender.send({ type: "delta", text: "a" });
  const bytes = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let at = 0;
  for (const frame of frames) {
    bytes.set(frame, at);
    at += frame.length;
  }
  assert.deepEqual(decodeNativeStream(bytes), [{ kind: "textDelta", text: "a" }]);

  const web: Uint8Array[] = [];
  createSseSender({ enqueue: (b: Uint8Array) => void web.push(b) } as unknown as ReadableStreamDefaultController<Uint8Array>, {
    log: failingLog as never,
    features: parseClientFeatures(["resume"]),
  }).send({ type: "delta", text: "a" });
  assert.match(new TextDecoder().decode(web[0]), /"type":"resume"/, "a client that declared resume gets it");
});

// ── The decoder itself follows Swift ─────────────────────────────────────────

test("the decoder follows Swift: unknown keys ignored, unknown types refused, types checked", () => {
  assert.deepEqual(decodeNativeEvent(JSON.stringify({ type: "reasoning", text: "x", part: 2, round: 1 })), { kind: "reasoningDelta", text: "x" });
  assert.deepEqual(
    decodeNativeEvent(JSON.stringify({ type: "activity", event: { id: "a", kind: "tool", title: "T", seq: 4, call: { v: 1 } } })),
    { kind: "activity", id: "a", activityKind: "tool", title: "T", detail: undefined, url: undefined }
  );
  assert.deepEqual(decodeNativeEvent(JSON.stringify({ type: "activity", event: { id: "a" } })), { kind: "ping" }, "an unreadable activity is tolerated");
  assert.throws(() => decodeNativeEvent(JSON.stringify({ type: "handoff", to: "research" })), NativeMalformedResponse);
  assert.throws(() => decodeNativeEvent(JSON.stringify({ type: "resume", available: false })), NativeMalformedResponse);
  assert.throws(() => decodeNativeEvent(JSON.stringify({ type: "delta", text: 3 })), NativeMalformedResponse);
  assert.throws(() => decodeNativeEvent(JSON.stringify({ type: "sources", sources: [{ title: "", url: "https://a.example", snippet: "" }] })), NativeMalformedResponse);
  assert.throws(() => decodeNativeEvent(JSON.stringify({ type: "delta", text: "é".repeat(40_000) })), NativeMalformedResponse, "a delta over 64 KiB");
  assert.throws(() => decodeNativeEvent(JSON.stringify({ type: "error", message: "two\nlines" })), NativeMalformedResponse);
});

test("the decoder follows Swift: an event over 5 MiB is refused before it is decoded", () => {
  const big = encodeChunk({ type: "delta", text: "x".repeat(5 * 1024 * 1024 + 10) } as StreamChunk);
  assert.throws(() => parseNativeSse(big), NativeEventTooLarge);
});

test("the fixture decoder is a port of the shipped Swift, which it cites", () => {
  const swift = readFileSync(
    path.join(process.cwd(), "native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeChatAPIClient.swift"),
    "utf8"
  );
  // If the shipped decoder changes shape, this port must be re-read against it.
  assert.match(swift, /switch envelope\.type \{/);
  assert.match(swift, /private static let maximumEventBytes = 5 \* 1_024 \* 1_024/);
  // The default case was changed from `throw NativeChatAPIError.malformedResponse` to
  // `return .ping` — unknown frame types are now silently forwarded as pings rather than
  // ending the stream (a guard at the top filters to `decodedFrameTypes` already).
  assert.match(swift, /default:\s*\n\s*\/\/ Unreachable past the guard/);
});
