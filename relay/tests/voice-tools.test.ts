import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { mintRelayCallbackToken, verifyRelayToken } from "../src/auth.js";
import { MockVoiceSession } from "../src/providers/mock.js";
import type { ProviderEvents, VoiceSessionSeed } from "../src/providers/types.js";
import { RelaySession } from "../src/session.js";
import {
  OVERLAPPED_YES_TEXT,
  SCREEN_ONLY_TEXT,
  VoiceToolBridge,
  pendingApprovalText,
  readToolListing,
  spokenDecision,
  type VoiceToolListing,
} from "../src/tools.js";
import { VOICE_TOOL_LIMIT, VOICE_TOOL_LIMIT_WITH_TOOLS, withToolsLimit } from "../src/voice-context.js";
import type { ServerMessage } from "../src/protocol.js";

/*
 * The chat's tools in a voice call, on the relay's side (relay/src/tools.ts;
 * Juno's side is tests/voice-tools.test.ts).
 *
 * The relay lists and runs tools only by asking Juno, under callback tokens of
 * their own audience; a change waits for the person, who may answer a card
 * aloud only in a turn that began after it, and never for an action that
 * cannot be undone; and nothing a connector holds passes through here. These
 * drive the real RelaySession against the dev mock provider and a fake Juno.
 */

process.env.AUTH_SECRET = "relay-test-secret";
process.env.RELAY_ENABLE_MOCK = "1";
process.env.JUNO_APP_URL = "https://juno.test";

const OAUTH = "oauth-secret-must-never-leave-juno";
const GRANT = { conversationId: "cm1a2b3c4d5e6f7g8h9i0jkl", connectorIds: ["gcal"], timeZone: "Europe/Amsterdam" };

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as Record<string, unknown>;
}

const LISTING_BODY = {
  instructions: "Your tools include the person's connected apps (Google Calendar).",
  tools: [
    { name: "web_search", description: "Search the web.", parameters: { type: "object", properties: { query: { type: "string" } } }, label: "Web search", confirm: "none" },
    {
      name: "gcal__create_event",
      description: "Create an event.",
      parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      label: "Google Calendar · Create event",
      confirm: "voice_or_screen",
      // Whatever Juno ever sent beside a tool, the relay keeps only the five fields it reads.
      headers: { Authorization: `Bearer ${OAUTH}` },
      mcpUrl: "https://mcp.calendar.example",
    },
    { name: "gcal__delete_event", description: "Delete an event.", parameters: { type: "object", properties: {} }, label: "Google Calendar · Delete event", confirm: "screen" },
  ],
};

/** A fake Juno: the list and a call stream the test drives. It has no decision endpoint to call, and must never be asked for one. */
function fakeJuno() {
  const requests: Array<{
    url: string;
    method: string;
    token: string;
    auth: Record<string, unknown>;
    body: Record<string, unknown> | null;
  }> = [];
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const header = new Headers(init?.headers).get("authorization") ?? "";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const token = header.replace(/^Bearer /, "");
    requests.push({ url, method: init?.method ?? "GET", token, auth: payloadOf(token), body });
    // Juno takes exactly two things from the relay: the list and a call.
    assert.equal(url, "https://juno.test/api/voice/tools", "the relay never asks Juno for anything else");
    if ((init?.method ?? "GET") === "GET") return Response.json(LISTING_BODY);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streams.set(String(body?.callId), controller);
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  }) as typeof fetch;
  const line = (callId: string, frame: Record<string, unknown>) =>
    streams.get(callId)?.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
  const finish = (callId: string, frame: Record<string, unknown>) => {
    line(callId, frame);
    streams.get(callId)?.close();
  };
  return { fetchImpl, requests, line, finish, streams };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

const approval = (id: string, riskClass: string) => ({
  id,
  receiptDigest: `digest_${id}`,
  riskClass,
  preview: "Google Calendar wants to create event.",
  connectorLabel: "Google Calendar",
  detail: { title: "Dentist" },
});

// ---------------------------------------------------------------------------
// A spoken yes is narrow
// ---------------------------------------------------------------------------

test("only a pure confirmation is a spoken yes; a short refusal is a no; anything else answers nothing", () => {
  for (const yes of ["yes", "Yeah.", "yep, go ahead", "okay send it", "Sure, do it please", "Yes please!", "oui merci", "ja bitte", "that's fine"]) {
    assert.equal(spokenDecision(yes), "allow", yes);
  }
  for (const no of ["no", "Nope.", "don't send that", "no thanks", "wait", "cancel it", "not now", "nein"]) {
    assert.equal(spokenDecision(no), "deny", no);
  }
  for (const neither of [
    "send Bob an email saying yes",
    "yes and also book a table for two tomorrow at eight please",
    "no, yes, go",
    "what's on my calendar",
    "",
    "go",
    "um",
  ]) {
    assert.equal(spokenDecision(neither), null, neither);
  }
});

// ---------------------------------------------------------------------------
// The grant and the callbacks
// ---------------------------------------------------------------------------

test("a session token grants tools only when Juno signed them, and carries no credential", () => {
  // The app's signState, in the shape the relay verifies.
  const sign = (payload: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${createHmac("sha256", "relay-test-secret").update(body).digest("base64url")}`;
  };
  const exp = Math.floor(Date.now() / 1000) + 60;
  assert.equal(verifyRelayToken(sign({ uid: "user_1", exp }))?.tools, undefined);
  assert.deepEqual(verifyRelayToken(sign({ uid: "user_1", exp, tl: 1, cid: GRANT.conversationId, cx: ["gcal", "bad id", 4], tz: "Europe/Amsterdam" }))?.tools, GRANT);
  // A callback token is never a session token, tools or not.
  assert.equal(verifyRelayToken(mintRelayCallbackToken("user_1", 60, "juno.voice.tools", { sid: "s", cid: GRANT.conversationId })), null);
  assert.equal(verifyRelayToken(mintRelayCallbackToken("user_1", 60, "juno.voice.spend")), null);
});

test("the list is asked for under the tools audience with the call's grant, and anything beside a tool is dropped", async () => {
  const juno = fakeJuno();
  const bridge = new VoiceToolBridge({ userId: "user_1", sessionId: "session-1234", grant: GRANT, send: () => {}, fetchImpl: juno.fetchImpl });
  await bridge.load();
  assert.equal(juno.requests.length, 1);
  assert.equal(juno.requests[0].url, "https://juno.test/api/voice/tools");
  assert.deepEqual(
    { aud: juno.requests[0].auth.aud, uid: juno.requests[0].auth.uid, sid: juno.requests[0].auth.sid, cid: juno.requests[0].auth.cid, cx: juno.requests[0].auth.cx, tz: juno.requests[0].auth.tz },
    { aud: "juno.voice.tools", uid: "user_1", sid: "session-1234", cid: GRANT.conversationId, cx: ["gcal"], tz: "Europe/Amsterdam" }
  );
  assert.deepEqual(bridge.declarations.map((tool) => Object.keys(tool).sort()), [
    ["description", "name", "parameters"],
    ["description", "name", "parameters"],
    ["description", "name", "parameters"],
  ]);
  assert.equal(JSON.stringify(bridge.declarations).includes(OAUTH), false);
  // Malformed entries are dropped, and an unreadable confirmation is read as the strictest.
  const odd = readToolListing({ tools: [{ name: "bad name!", parameters: { type: "object" } }, { name: "x", parameters: { type: "array" } }, { name: "ok", parameters: { type: "object", properties: {} }, confirm: "whatever" }] });
  assert.deepEqual(odd?.declarations.map((tool) => tool.name), ["ok"]);
  assert.equal(odd?.meta.get("ok")?.confirm, "screen");
});

// ---------------------------------------------------------------------------
// A whole call: list, read, write with a spoken yes, and nothing leaking
// ---------------------------------------------------------------------------

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Array<Record<string, unknown>> = [];
  send(data: unknown): void {
    if (typeof data === "string") this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
  tools(): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame.type === "tool.activity");
  }
  spoken(): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame.type === "tool.spoken");
  }
}

const seeds: VoiceSessionSeed[] = [];
const sentToModel: string[] = [];
const originalConnect = MockVoiceSession.prototype.connect;
const originalSendText = MockVoiceSession.prototype.sendText;
MockVoiceSession.prototype.connect = async function (seed: VoiceSessionSeed, events: ProviderEvents) {
  seeds.push(seed);
  return originalConnect.call(this, seed, events);
};
MockVoiceSession.prototype.sendText = function (text: string) {
  sentToModel.push(text);
  return originalSendText.call(this, text);
};

async function startCall() {
  seeds.length = 0;
  sentToModel.length = 0;
  const juno = fakeJuno();
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user_1", { tools: GRANT, toolsFetch: juno.fetchImpl });
  await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
  return { juno, ws, session };
}

test("a call granted tools declares them to the model and tells the client how many it got", async () => {
  const { ws, session } = await startCall();
  try {
    assert.deepEqual(seeds[0].tools?.map((tool) => tool.name), ["web_search", "gcal__create_event", "gcal__delete_event"]);
    assert.equal(seeds[0].toolInstructions, LISTING_BODY.instructions);
    assert.equal(ws.frames.find((frame) => frame.type === "session.ready")?.tools, 3);
  } finally {
    await session.destroy();
  }
});

test("a call without a grant asks Juno for nothing and says nothing about tools", async () => {
  const juno = fakeJuno();
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user_1", { toolsFetch: juno.fetchImpl });
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    assert.equal(juno.requests.length, 0);
    assert.equal("tools" in (ws.frames.find((frame) => frame.type === "session.ready") ?? {}), false);
  } finally {
    await session.destroy();
  }
});

test("a call Juno could not list tools for starts anyway, with none, and does not claim the model can't", async () => {
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user_1", {
    tools: GRANT,
    toolsFetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
  });
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    const ready = ws.frames.find((frame) => frame.type === "session.ready");
    assert.ok(ready);
    assert.equal("tools" in ready, false);
    assert.equal(seeds.at(-1)?.tools, undefined);
  } finally {
    await session.destroy();
  }
});

test("a voice model that cannot take functions reports 0, so the client can say so", async () => {
  const established = MockVoiceSession.prototype.established;
  MockVoiceSession.prototype.established = () => ({ thinking: false, tools: 0 });
  try {
    const { ws, session } = await startCall();
    try {
      assert.equal(ws.frames.find((frame) => frame.type === "session.ready")?.tools, 0);
    } finally {
      await session.destroy();
    }
  } finally {
    MockVoiceSession.prototype.established = established;
  }
});

test("a read runs on Juno and its result goes to the model; the chips follow it", async () => {
  const { juno, ws, session } = await startCall();
  try {
    await session.handleText(JSON.stringify({ type: "input.text", text: 'call web_search {"query":"weather"}' }));
    await flush();
    const run = juno.requests.find((entry) => entry.method === "POST");
    assert.equal(run?.auth.aud, "juno.voice.tools");
    assert.deepEqual(run?.body, { callId: "mock_call_1", name: "web_search", arguments: '{"query":"weather"}' });
    juno.finish("mock_call_1", { type: "result", status: "succeeded", text: "Sunny, 21 degrees." });
    await flush();
    assert.deepEqual(ws.tools().map((frame) => frame.status), ["running", "succeeded"]);
    assert.equal(ws.tools()[0].label, "Web search");
  } finally {
    await session.destroy();
  }
});

test("a change waits for the person; the model is told to ask; a yes in their NEXT turn goes to their own client", async () => {
  const { juno, ws, session } = await startCall();
  try {
    await session.handleText(JSON.stringify({ type: "input.text", text: 'call gcal__create_event {"title":"Dentist"}' }));
    await flush();
    juno.line("mock_call_1", { type: "approval", approval: approval("rcpt_1", "external_write"), spoken: true });
    await flush();
    const waiting = ws.tools().at(-1)!;
    assert.equal(waiting.status, "awaiting_approval");
    assert.equal((waiting.approval as { id: string }).id, "rcpt_1");
    assert.equal(waiting.spoken, true);
    assert.deepEqual(ws.spoken(), []);

    // A turn about something else answers nothing.
    await session.handleText(JSON.stringify({ type: "input.text", text: "what time is it" }));
    await flush();
    assert.deepEqual(ws.spoken(), []);

    // The relay records nothing: the signed-in client answers the card.
    await session.handleText(JSON.stringify({ type: "input.text", text: "yes, go ahead" }));
    await flush();
    assert.deepEqual(ws.spoken(), [{ type: "tool.spoken", id: "mock_call_1", approvalId: "rcpt_1", decision: "allow_once" }]);
    assert.deepEqual(juno.requests.map((entry) => entry.method), ["GET", "POST"], "no decision is ever posted by the relay");
    // Saying it again does not answer twice.
    await session.handleText(JSON.stringify({ type: "input.text", text: "yes" }));
    await flush();
    assert.equal(ws.spoken().length, 1);

    juno.finish("mock_call_1", { type: "result", status: "succeeded", text: 'Created "Dentist".' });
    await flush();
    assert.equal(ws.tools().at(-1)?.status, "succeeded");
    // The outcome reaches the model as a turn of its own, labelled as a tool result.
    assert.ok(sentToModel.some((text) => text.includes('the outcome of "Google Calendar · Create event"') && text.includes('Created "Dentist".')));
  } finally {
    await session.destroy();
  }
});

/** A bridge with a fixed listing, recording what it tells the client. */
function bridgeFor(toClient: ServerMessage[]) {
  return new VoiceToolBridge({
    userId: "user_1",
    sessionId: "session-1234",
    grant: GRANT,
    send: (msg) => void toClient.push(msg),
    listing: readToolListing(LISTING_BODY) as VoiceToolListing,
    fetchImpl: (async () => assert.fail("the bridge must not call Juno here")) as unknown as typeof fetch,
  });
}
const answers = (toClient: ServerMessage[]) =>
  toClient.flatMap((msg) => (msg.type === "tool.spoken" ? [msg.decision] : []));

test("the words that asked for a change can never be its answer, even when their caption lands late", () => {
  const sent: string[] = [];
  const toClient: ServerMessage[] = [];
  const bridge = bridgeFor(toClient);
  // The person starts speaking ("…and say yes"), the model calls the tool, the card goes up…
  bridge.userTurnOpened();
  (bridge as unknown as { pending: Map<string, unknown>; turnSeq: number }).pending.set("rcpt_1", {
    callId: "c1",
    approval: approval("rcpt_1", "external_write"),
    spoken: true,
    raisedAfterTurn: (bridge as unknown as { turnSeq: number }).turnSeq,
    deciding: false,
    late: (text: string) => sent.push(text),
  });
  // …and only then does that same turn's final caption arrive.
  bridge.userTurnFinal("yes");
  assert.deepEqual(answers(toClient), []);
  bridge.userTurnOpened();
  bridge.userTurnFinal("yes");
  assert.deepEqual(answers(toClient), ["allow_once"]);
  assert.deepEqual(sent, []);
});

test("a yes heard over the model's own voice is never an approval; a no still declines", () => {
  const sent: string[] = [];
  const toClient: ServerMessage[] = [];
  const bridge = bridgeFor(toClient);
  (bridge as unknown as { pending: Map<string, unknown> }).pending.set("rcpt_9", {
    callId: "c9",
    approval: approval("rcpt_9", "external_write"),
    spoken: true,
    raisedAfterTurn: 0,
    deciding: false,
    late: (text: string) => sent.push(text),
  });
  // The model says "yes" while its audio plays; a mic without echo
  // cancellation transcribes it as the person.
  bridge.userTurnOpened(true);
  bridge.userTurnFinal("Yes.");
  assert.deepEqual(answers(toClient), []);
  assert.deepEqual(sent, [OVERLAPPED_YES_TEXT]);
  bridge.userTurnOpened(true);
  bridge.userTurnFinal("no");
  assert.deepEqual(answers(toClient), ["deny"]);
});

test("the relay counts a turn as heard over the model while its speech is still playing", async () => {
  const opened: boolean[] = [];
  const { session } = await startCall();
  try {
    const internals = session as unknown as {
      toolBridge: { userTurnOpened(over?: boolean): void };
      assistantAudioEndsAtMs: number;
      userTurnOpen: boolean;
      openUserTurn(): void;
    };
    internals.toolBridge.userTurnOpened = (over = false) => void opened.push(over);
    internals.assistantAudioEndsAtMs = Date.now() + 2_000;
    internals.openUserTurn();
    internals.userTurnOpen = false;
    internals.assistantAudioEndsAtMs = Date.now() - 5_000;
    internals.openUserTurn();
    assert.deepEqual(opened, [true, false]);
  } finally {
    await session.destroy();
  }
});

test("an action that cannot be undone takes the card: a spoken yes is answered with 'tap Approve', a no still declines", async () => {
  const { juno, ws, session } = await startCall();
  try {
    await session.handleText(JSON.stringify({ type: "input.text", text: "call gcal__delete_event {}" }));
    await flush();
    // Juno says spoken is allowed here, but the listing says screen: the stricter one wins.
    juno.line("mock_call_1", { type: "approval", approval: approval("rcpt_2", "destructive_or_sensitive"), spoken: true });
    await flush();
    assert.equal(ws.tools().at(-1)?.spoken, false);
    await session.handleText(JSON.stringify({ type: "input.text", text: "yes" }));
    await flush();
    assert.deepEqual(ws.spoken(), []);
    assert.ok(sentToModel.includes(SCREEN_ONLY_TEXT));
    await session.handleText(JSON.stringify({ type: "input.text", text: "no, don't" }));
    await flush();
    assert.deepEqual(ws.spoken(), [{ type: "tool.spoken", id: "mock_call_1", approvalId: "rcpt_2", decision: "deny" }]);
  } finally {
    await session.destroy();
  }
});

test("nothing a connector holds, and none of the relay's own callback tokens, reaches the client or the model", async () => {
  const { juno, ws, session } = await startCall();
  try {
    await session.handleText(JSON.stringify({ type: "input.text", text: 'call gcal__create_event {"title":"Dentist"}' }));
    await flush();
    juno.line("mock_call_1", { type: "approval", approval: approval("rcpt_3", "external_write"), spoken: true });
    await flush();
    juno.finish("mock_call_1", { type: "result", status: "succeeded", text: "Done." });
    await flush();
    const toClient = JSON.stringify(ws.frames);
    const toModel = JSON.stringify(seeds) + JSON.stringify(sentToModel);
    assert.ok(juno.requests.length >= 2);
    for (const payload of [toClient, toModel]) {
      assert.equal(payload.includes(OAUTH), false);
      assert.equal(payload.includes("mcp.calendar.example"), false);
      // The relay's bearer tokens to Juno are minted per request and go to Juno only.
      for (const request of juno.requests) {
        assert.equal(payload.includes(request.token), false, request.url);
        assert.equal(payload.includes(request.token.split(".")[1]), false, request.url);
      }
    }
    assert.equal(/Bearer /.test(toClient), false);
  } finally {
    await session.destroy();
  }
});

test("ending the call cancels what is running, and a waiting card is not answered afterwards", async () => {
  const { juno, ws, session } = await startCall();
  await session.handleText(JSON.stringify({ type: "input.text", text: 'call gcal__create_event {"title":"Dentist"}' }));
  await flush();
  juno.line("mock_call_1", { type: "approval", approval: approval("rcpt_4", "external_write"), spoken: true });
  await flush();
  await session.destroy();
  const after = ws.frames.length;
  await session.handleText(JSON.stringify({ type: "input.text", text: "yes" })).catch(() => undefined);
  await flush();
  assert.deepEqual(ws.spoken(), []);
  assert.equal(ws.frames.length, after);
});

// ---------------------------------------------------------------------------
// What the model is told
// ---------------------------------------------------------------------------

test("a call with tools is told it has them, that a change waits for the person, and still that it cannot run code", () => {
  const text = withToolsLimit(`You are Alevr. ${VOICE_TOOL_LIMIT} Pick up naturally.`, "Your tools include Google Calendar.");
  assert.ok(!text.includes(VOICE_TOOL_LIMIT));
  assert.ok(text.includes(VOICE_TOOL_LIMIT_WITH_TOOLS));
  assert.match(text, /cannot run code or scripts/);
  assert.match(text, /never say it is done until you are told it happened/);
  assert.ok(text.endsWith("Your tools include Google Calendar."));
  assert.match(pendingApprovalText("Send it?", true), /has not happened yet/);
  assert.match(pendingApprovalText("Delete it?", false), /a spoken yes is not enough/);
});
