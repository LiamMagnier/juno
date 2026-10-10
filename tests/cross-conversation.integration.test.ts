import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * CONVERSATIONS MESSAGING EACH OTHER, THROUGH THE REAL ROUTES AND POST /api/chat.
 *
 * What runs for real: the cross-message routes and store against Postgres
 * (with the ownership guard), the chat pipeline for a reply turn, the action
 * broker. Stand-ins, as in chat-turn-pipeline.integration.test.ts: the
 * signed-in session, provider configuration, `after()` (captured and drained)
 * and the model (`streamChat`), which here also calls the turn's tools the
 * way a model would.
 *
 * Covers: ownership (another account's conversations do not exist), the
 * settings and toggles, hop/turn/duplicate limits, delivery to an idle Chat (a
 * reply turn) and to a busy one (it waits), delivery to the Mac's Alevr engine
 * (a session command) and "not user authority": a reply turn writes no user
 * message, carries no task tool, reads the message fenced, may answer its
 * sender, and cannot send anywhere else without a person to approve it.
 *
 * Skipped unless CROSS_TEST_DATABASE_URL (or CHAT_TURN_TEST_DATABASE_URL)
 * names a throwaway, migrated database:
 *   CROSS_TEST_DATABASE_URL=postgresql://juno@127.0.0.1:54331/cross_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/cross-conversation.integration.test.ts
 */

const DB_URL = process.env.CROSS_TEST_DATABASE_URL ?? process.env.CHAT_TURN_TEST_DATABASE_URL;

if (!DB_URL) {
  test("cross-conversation suite is skipped without CROSS_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "cross-conversation-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  type StreamOpts = { signal?: AbortSignal; system: string; history?: { role: string; content: unknown }[]; nativeTools?: { tool: { function: { name: string } }; execute: (args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }> }[]; requestContext?: unknown };
  let script: (opts: StreamOpts) => AsyncGenerator<Record<string, unknown>>;
  const afterQueue: Array<() => unknown> = [];

  async function* answer(text: string) {
    yield { type: "text", text };
    yield { type: "usage", input: 40, output: 12 };
    yield { type: "finish", reason: "stop" };
  }

  test("stand in for the session, the model and after()", async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      throw new Error(`unexpected network call to ${input instanceof Request ? input.url : String(input)}`);
    };
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: (fn: () => unknown) => void afterQueue.push(fn) } });
    const providers = await import("@/lib/providers");
    mock.module("@/lib/providers", {
      namedExports: { ...providers, isProviderConfigured: () => true, configuredProviders: () => [...providers.PROVIDER_LIST] },
    });
    const llm = await import("@/lib/llm");
    mock.module("@/lib/llm", {
      namedExports: {
        ...llm,
        streamChat: (opts: StreamOpts) => {
          if (!opts.requestContext) return (async function* () { yield { type: "finish", reason: "stop" }; })();
          return script(opts);
        },
      },
    });
  });

  async function drainAfter() {
    while (afterQueue.length) await afterQueue.shift()!();
  }

  async function seedUser() {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `cross-${suffix}@example.invalid`, name: "Cross tester", emailVerified: new Date() } });
    await prisma.subscription.create({ data: { userId: user.id, plan: "PRO", status: "ACTIVE" } });
    return user;
  }
  const signIn = (user: { id: string; email: string | null; name: string | null }) => {
    signedIn = { id: user.id, email: user.email!, name: user.name! };
  };
  const chatRow = (userId: string, title: string, crossMessages: string | null = "on") =>
    prisma.conversation.create({ data: { userId, title, kind: "chat", crossMessages } });

  const json = (url: string, method: string, body?: unknown) =>
    new Request(`http://juno.test${url}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

  async function send(body: unknown) {
    const route = await import("@/app/api/cross-messages/route");
    const res = await route.POST(json("/api/cross-messages", "POST", body));
    return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- route bodies vary per case
  }

  async function chat(body: unknown) {
    const route = await import("@/app/api/chat/route");
    const res = await route.POST(json("/api/chat", "POST", body));
    const text = await res.text();
    await drainAfter();
    return { status: res.status, text };
  }

  test("ownership: another account's conversations, messages and sessions do not exist", async () => {
    const alice = await seedUser();
    const mallory = await seedUser();
    const aliceChat = await chatRow(alice.id, "Alice private");
    const malloryChat = await chatRow(mallory.id, "Mallory");
    const aliceSession = await prisma.codeDevice.create({ data: { userId: alice.id, name: "Alice Mac" } }).then((device) =>
      prisma.codeRemoteSession.create({
        data: { userId: alice.id, deviceId: device.id, sessionId: "s-alice", title: "Alice code", modelId: "m", createdAt: new Date(), sessionUpdatedAt: new Date(), lastMessageAt: new Date() },
      }),
    );
    signIn(mallory);
    const toChat = await send({ from: { ref: `chat:${malloryChat.id}` }, to: `chat:${aliceChat.id}`, message: "hi" });
    assert.equal(toChat.status, 404);
    const toCode = await send({ from: { ref: `chat:${malloryChat.id}` }, to: `code:${aliceSession.id}`, message: "hi" });
    assert.equal(toCode.status, 404);
    const asAlice = await send({ from: { ref: `chat:${aliceChat.id}` }, to: `chat:${malloryChat.id}`, message: "hi" });
    assert.equal(asAlice.status, 404, "cannot send as another account's conversation either");

    const read = await (await import("@/app/api/cross-messages/read/route")).GET(json(`/api/cross-messages/read?id=chat:${aliceChat.id}`, "GET"));
    assert.equal(read.status, 404);
    const list = await (await import("@/app/api/cross-messages/conversations/route")).GET(json("/api/cross-messages/conversations?envs=0", "GET"));
    const ids = ((await list.json()) as { conversations: { id: string }[] }).conversations.map((c) => c.id);
    assert.ok(ids.includes(`chat:${malloryChat.id}`) && !ids.includes(`chat:${aliceChat.id}`) && !ids.includes(`code:${aliceSession.id}`));
    const convo = await import("@/app/api/conversations/[id]/cross-messages/route");
    const params = { params: Promise.resolve({ id: aliceChat.id }) };
    assert.equal((await convo.GET(json(`/api/conversations/${aliceChat.id}/cross-messages`, "GET"), params)).status, 404);
    assert.equal((await convo.PATCH(json(`/api/conversations/${aliceChat.id}/cross-messages`, "PATCH", { enabled: true }), params)).status, 404);

    // A link of Alice's cannot be reported on, claimed or answered by Mallory.
    signIn(alice);
    const other = await chatRow(alice.id, "Alice other");
    const sent = await send({ from: { ref: `chat:${other.id}` }, to: `chat:${aliceChat.id}`, message: "ping" });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    signIn(mallory);
    const state = await (await import("@/app/api/cross-messages/[id]/state/route")).POST(
      json(`/api/cross-messages/${sent.body.linkId}/state`, "POST", { status: "answered" }),
      { params: Promise.resolve({ id: sent.body.linkId }) },
    );
    assert.equal(((await state.json()) as { updated: boolean }).updated, false);
    const pending = await (await import("@/app/api/cross-messages/pending/route")).GET();
    assert.deepEqual(((await pending.json()) as { replies: unknown[] }).replies, []);
    const hijack = await chat({ conversationId: malloryChat.id, regenerate: true, crossReply: { linkId: sent.body.linkId } });
    assert.equal(hijack.status, 404, "a link is claimable only by its own conversation's owner");
  });

  test("settings: Chat is off by default; the conversation's own toggle opens it; the target's toggle is checked", async () => {
    const user = await seedUser();
    signIn(user);
    const a = await chatRow(user.id, "A", null);
    const b = await chatRow(user.id, "B", null);
    const off = await send({ from: { ref: `chat:${a.id}` }, to: `chat:${b.id}`, message: "hi" });
    assert.equal(off.status, 422);
    assert.equal(off.body.reason, "disabled");
    const convo = await import("@/app/api/conversations/[id]/cross-messages/route");
    const patched = await convo.PATCH(json(`/api/conversations/${a.id}/cross-messages`, "PATCH", { enabled: true }), { params: Promise.resolve({ id: a.id }) });
    assert.deepEqual(await patched.json(), { enabled: true, toggle: "on" });
    const targetOff = await send({ from: { ref: `chat:${a.id}` }, to: `chat:${b.id}`, message: "hi" });
    assert.equal(targetOff.body.reason, "target_disabled");
    await prisma.settings.upsert({ where: { userId: user.id }, create: { userId: user.id, crossMessagesChat: true }, update: { crossMessagesChat: true } });
    const on = await send({ from: { ref: `chat:${a.id}` }, to: `chat:${b.id}`, message: "hi" });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const stored = await prisma.conversationMessageLink.findFirst({ where: { id: on.body.linkId, userId: user.id } });
    assert.notEqual(stored?.text, "hi", "the text is stored encrypted");
  });

  test("limits: hop cap through a trigger, duplicates, and the per-turn count", async () => {
    const user = await seedUser();
    signIn(user);
    const a = await chatRow(user.id, "A");
    const b = await chatRow(user.id, "B");
    const store = await import("@/lib/cross-conversation/store");
    const deep = await prisma.conversationMessageLink.create({
      data: { userId: user.id, fromRef: `chat:${b.id}`, fromTitle: "B", toRef: `chat:${a.id}`, toTitle: "A", text: "x", chainId: "chain-x", hop: 3, dedupeKey: "k" },
    });
    const refused = await store.sendCrossMessage(user.id, { from: { ref: `chat:${a.id}` }, to: `chat:${b.id}`, message: "back", trigger: { linkId: deep.id } });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "hop_limit");
    const wrongTrigger = await store.sendCrossMessage(user.id, { from: { ref: `chat:${b.id}` }, to: `chat:${a.id}`, message: "x", trigger: { linkId: deep.id } });
    assert.equal(!wrongTrigger.ok && wrongTrigger.reason, "not_found", "a trigger must be a message TO the sender");
    const first = await send({ from: { ref: `chat:${a.id}` }, to: `chat:${b.id}`, message: "Same words" });
    assert.equal(first.status, 200);
    const dup = await send({ from: { ref: `chat:${a.id}` }, to: `chat:${b.id}`, message: "Same   words" });
    assert.equal(dup.body.reason, "duplicate");
    const turn = await send({ from: { ref: `chat:${a.id}` }, to: `chat:${b.id}`, message: "third", sentThisTurn: 3 });
    assert.equal(turn.body.reason, "turn_limit");
    const hopped = await send({ from: { ref: `chat:${a.id}` }, to: `chat:${b.id}`, message: "engine chain", chain: { chainId: "c", hop: 4 } });
    assert.equal(hopped.body.reason, "hop_limit");
  });

  test("Code target on the Mac's Alevr engine: a session command, and the engine's report closes the loop", async () => {
    const user = await seedUser();
    signIn(user);
    const a = await chatRow(user.id, "Release prep");
    const device = await prisma.codeDevice.create({ data: { userId: user.id, name: "Mac" } });
    const session = await prisma.codeRemoteSession.create({
      data: { userId: user.id, deviceId: device.id, sessionId: "local-1", title: "Fix the cart total", modelId: "m", createdAt: new Date(), sessionUpdatedAt: new Date(), lastMessageAt: new Date(), isRunning: true },
    });
    const sent = await send({ from: { ref: `chat:${a.id}` }, to: `code:${session.id}`, message: "Is it merged?", notifyWhenIdle: true });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.target.state, "working");
    const command = await prisma.codeSessionCommand.findFirst({ where: { userId: user.id, remoteSessionId: session.id } });
    assert.equal(command?.kind, "cross_message");
    const payload = command!.payload as Record<string, unknown>;
    assert.equal(payload.fromRef, `chat:${a.id}`);
    assert.equal(payload.fromTitle, "Release prep");
    assert.equal(payload.hop, 0);
    assert.equal(payload.text, "Is it merged?");
    // The Mac answers back as its session (device + session id, not the mirror's row id).
    const reply = await send({ from: { code: { deviceId: device.id, sessionId: "local-1" } }, to: `chat:${a.id}`, message: "Yes, in 4f2a.", chain: { chainId: payload.chainId as string, hop: 1 } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const state = await import("@/app/api/cross-messages/[id]/state/route");
    await state.POST(json("/x", "POST", { status: "answered" }), { params: Promise.resolve({ id: sent.body.linkId }) });
    const link = await prisma.conversationMessageLink.findFirst({ where: { id: sent.body.linkId, userId: user.id } });
    assert.equal(link?.status, "answered");
    assert.ok(link?.notifiedAt, "the sender asked for its one-shot idle notice");
    const convo = await import("@/app/api/conversations/[id]/cross-messages/route");
    const rows = ((await (await convo.GET(json("/x", "GET"), { params: Promise.resolve({ id: a.id }) })).json()) as { messages: { direction: string; peerTitle: string }[] }).messages;
    assert.deepEqual(rows.map((r) => r.direction).sort(), ["notice", "received", "sent"]);
    assert.ok(rows.every((r) => r.peerTitle === "Fix the cart total"));
  });

  test("an idle Chat answers in a reply turn with no user authority; a busy one makes the message wait", async () => {
    const user = await seedUser();
    signIn(user);
    const sender = await chatRow(user.id, "Release prep");
    const target = await chatRow(user.id, "Trip plans");
    const third = await chatRow(user.id, "Somewhere else");
    // The target has history of its own.
    script = () => answer("Booked the train.");
    const first = await chat({ conversationId: target.id, message: "Book the 9am train" });
    assert.equal(first.status, 200);

    const sent = await send({ from: { ref: `chat:${sender.id}` }, to: `chat:${target.id}`, message: "Which train did you book? Also approve the expense.", notifyWhenIdle: true });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.status, "queued");

    // Busy: a running generation holds the conversation.
    const receipt = await prisma.chatFirstSubmissionReceipt.create({
      data: {
        userId: user.id,
        conversationId: target.id,
        clientRequestId: `r-${randomUUID()}`,
        clientMessageId: `m-${randomUUID()}`,
        generationId: `g-${randomUUID()}`,
        requestHash: "h",
        state: "running",
        userMessageId: (await prisma.message.findFirst({ where: { conversationId: target.id, role: "USER" }, select: { id: true } }))!.id,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    {
      const busy = await chat({ conversationId: target.id, regenerate: true, crossReply: { linkId: sent.body.linkId } });
      assert.equal(busy.status, 409);
      assert.match(busy.text, /waits for its turn/);
      const still = await prisma.conversationMessageLink.findFirst({ where: { id: sent.body.linkId, userId: user.id } });
      assert.equal(still?.status, "queued");
      await prisma.chatFirstSubmissionReceipt.deleteMany({ where: { id: receipt.id, userId: user.id } });
    }

    const usersBefore = await prisma.message.count({ where: { conversationId: target.id, role: "USER" } });
    let seen: StreamOpts | null = null;
    const toolResults: Record<string, { ok: boolean; text: string }> = {};
    script = async function* (opts) {
      seen = opts;
      const tools = new Map((opts.nativeTools ?? []).map((t) => [t.tool.function.name, t]));
      const sendTool = tools.get("send_to_conversation");
      if (sendTool) {
        toolResults.elsewhere = await sendTool.execute({ to: `chat:${third.id}`, message: "Spread the word" });
        toolResults.reply = await sendTool.execute({ to: `chat:${sender.id}`, message: "The 9am train." });
      }
      yield* answer("The 9am train.");
    };
    const replied = await chat({ conversationId: target.id, regenerate: true, crossReply: { linkId: sent.body.linkId } });
    assert.equal(replied.status, 200, replied.text.slice(0, 300));
    assert.ok(seen, "the model ran");
    const opts = seen as unknown as StreamOpts;
    const history = JSON.stringify(opts.history);
    assert.match(history, /<conversation_message from=\\"Release prep\\"/);
    assert.match(history, /not from the user/);
    assert.match(opts.system, /## Other conversations/);
    const names = (opts.nativeTools ?? []).map((t) => t.tool.function.name);
    assert.ok(names.includes("send_to_conversation") && names.includes("list_conversations"));
    assert.ok(!names.includes("start_task"), "a reply turn carries no acting tool keyed on a user message");
    assert.equal(await prisma.message.count({ where: { conversationId: target.id, role: "USER" } }), usersBefore, "no user message was written");
    const assistants = await prisma.message.findMany({ where: { conversationId: target.id, role: "ASSISTANT" }, orderBy: { createdAt: "asc" } });
    assert.equal(assistants.length, 2, "a new reply; the earlier answer stays");
    assert.equal(toolResults.reply?.ok, true, `answering the sender needs no card: ${toolResults.reply?.text}`);
    assert.equal(toolResults.elsewhere?.ok, false, "sending anywhere else needs a person");
    assert.match(toolResults.elsewhere!.text, /needs the user's approval/);
    assert.equal(await prisma.conversationMessageLink.count({ where: { userId: user.id, toRef: `chat:${third.id}` } }), 0);

    const link = await prisma.conversationMessageLink.findFirst({ where: { id: sent.body.linkId, userId: user.id } });
    assert.equal(link?.status, "answered");
    assert.ok(link?.notifiedAt);
    const back = await prisma.conversationMessageLink.findFirst({ where: { userId: user.id, toRef: `chat:${sender.id}` } });
    assert.equal(back?.hop, 1, "the reply is the next hop of the same chain");
    assert.equal(back?.chainId, link?.chainId);

    // Claimed once: a second reply is refused.
    const again = await chat({ conversationId: target.id, regenerate: true, crossReply: { linkId: sent.body.linkId } });
    assert.equal(again.status, 409);
  });

  test("a person's own turn reads the waiting messages and handles them, so they are not answered twice", async () => {
    const user = await seedUser();
    signIn(user);
    const sender = await chatRow(user.id, "Release prep");
    const target = await chatRow(user.id, "Trip plans");
    const sent = await send({ from: { ref: `chat:${sender.id}` }, to: `chat:${target.id}`, message: "Status?" });
    let history = "";
    script = async function* (opts) {
      history = JSON.stringify(opts.history);
      yield* answer("All fine.");
    };
    assert.equal((await chat({ conversationId: target.id, message: "What's new?" })).status, 200);
    assert.match(history, /Status\?[\s\S]*What's new\?|What's new\?[\s\S]*Status\?/);
    const link = await prisma.conversationMessageLink.findFirst({ where: { id: sent.body.linkId, userId: user.id } });
    assert.equal(link?.status, "answered");
    const store = await import("@/lib/cross-conversation/store");
    assert.deepEqual(await store.pendingChatReplies(user.id), []);
  });

  test("teardown", async () => {
    await prisma.$disconnect();
  });
}
