import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * CONTEXT TOKENS THROUGH THE REAL CHAT ROUTE, AGAINST POSTGRES.
 *
 * Drives POST /api/chat with typed context tokens (src/lib/chat/context-tokens.ts)
 * and reads back what the database and the model were given:
 *
 *  - a Library file token becomes a clone claimed by the user message, in the
 *    same transaction (the "Add from library" mechanism);
 *  - a project, another chat and a crew member reach the model as context for
 *    this reply only, after the latest user turn, the chat inside the
 *    untrusted envelope;
 *  - an app token joins this turn's connectors without becoming sticky on
 *    the conversation, and one that cannot be used is a structured notice;
 *  - every id another account owns is dropped with `not_found` and
 *    contributes nothing — no clone, no connector, no text;
 *  - the receipt survives a reload (the serializer's whitelist), and a
 *    regenerate that sends no tokens re-resolves the ones it replaced,
 *    without cloning the file twice;
 *  - a durable first submission clones inside its acceptance transaction;
 *  - incognito writes nothing.
 *
 * Only the session and the model are stand-ins; a fetch tripwire proves
 * nothing leaves the process. Skipped unless CONTEXT_TOKENS_TEST_DATABASE_URL
 * names a throwaway database (it never falls back to DATABASE_URL):
 *
 *   initdb -D /tmp/pg-chatctx -U postgres --auth=trust   (unix_socket_directories = '',
 *     listen_addresses = '127.0.0.1', a spare port; start with LC_ALL=en_US.UTF-8)
 *   createdb -h 127.0.0.1 -p <port> -U postgres juno_ctx_test
 *   DATABASE_URL=… DIRECT_URL=… npx prisma migrate deploy
 *   CONTEXT_TOKENS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/juno_ctx_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/context-tokens-chat.integration.test.ts
 */

const DB_URL = process.env.CONTEXT_TOKENS_TEST_DATABASE_URL;

if (!DB_URL) {
  test("context-token chat database suite is skipped without CONTEXT_TOKENS_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "context-tokens-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  interface StreamCall {
    history: Array<{ role: string; content: string; attachments?: Array<{ id: string }> }>;
    connectors?: Array<{ id: string }>;
  }
  const calls: StreamCall[] = [];
  const outbound: string[] = [];

  test("stand in for the session and the model", async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      outbound.push(url);
      throw new Error(`unexpected network call to ${url}`);
    };
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: () => {} } });
    const providers = await import("@/lib/providers");
    mock.module("@/lib/providers", {
      namedExports: {
        ...providers,
        isProviderConfigured: () => true,
        configuredProviders: () => [...providers.PROVIDER_LIST],
      },
    });
    const llm = await import("@/lib/llm");
    mock.module("@/lib/llm", {
      namedExports: {
        ...llm,
        streamChat: async function* (opts: StreamCall) {
          calls.push({ history: opts.history, connectors: opts.connectors });
          yield { type: "text", text: "Noted." };
          yield { type: "usage", input: 12, output: 6 };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
  });

  const request = (body: unknown) =>
    new Request("http://juno.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  type Frame = { type: string; [key: string]: unknown };
  async function chat(body: unknown) {
    const route = await import("@/app/api/chat/route");
    const res = await route.POST(request(body));
    const text = await res.text();
    assert.equal(res.status, 200, `the turn is accepted: ${text}`);
    const frames = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Frame);
    const done = frames.find((frame) => frame.type === "done") as
      | (Frame & { message: { id: string; activity?: Array<Record<string, unknown>> } })
      | undefined;
    assert.ok(done, `the stream settles with a done frame; got ${frames.map((frame) => frame.type).join(", ")}`);
    const receiptFrame = frames.find(
      (frame) => frame.type === "activity" && (frame.event as Record<string, unknown>).contextReceipt
    );
    const receipt = receiptFrame
      ? ((receiptFrame.event as Record<string, unknown>).contextReceipt as {
          tokens: Array<{ kind: string; id: string; label: string; outcome: string; via?: string; code?: string; ranges?: unknown }>;
        })
      : null;
    return { frames, done, receipt };
  }

  const outcomeOf = (receipt: Awaited<ReturnType<typeof chat>>["receipt"], id: string) => {
    const entry = receipt?.tokens.find((token) => token.id === id);
    assert.ok(entry, `the receipt names ${id}`);
    return entry;
  };

  async function seed() {
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const me = await prisma.user.create({
      data: { email: `ctx-me-${suffix}@example.invalid`, name: "Context tester", emailVerified: new Date() },
    });
    const other = await prisma.user.create({
      data: { email: `ctx-other-${suffix}@example.invalid`, name: "Someone else", emailVerified: new Date() },
    });
    signedIn = { id: me.id, email: me.email!, name: me.name! };

    const libraryFile = await prisma.attachment.create({
      data: {
        userId: me.id,
        kind: "FILE",
        fileName: "Q3 Forecast.csv",
        mimeType: "text/csv",
        size: 42,
        storageKey: `test/${suffix}/q3.csv`,
        extractedText: "month,revenue\nJuly,10\nAugust,12",
        parserState: "ready",
      },
    });
    const theirFile = await prisma.attachment.create({
      data: {
        userId: other.id,
        kind: "FILE",
        fileName: "Their payroll.csv",
        mimeType: "text/csv",
        size: 9,
        storageKey: `test/${suffix}/payroll.csv`,
        extractedText: "SECRET PAYROLL",
        parserState: "ready",
      },
    });
    const project = await prisma.project.create({
      data: { userId: me.id, name: "Acme renewal", instructions: "Always cite the renewal date." },
    });
    const theirProject = await prisma.project.create({
      data: { userId: other.id, name: "Their project", instructions: "THEIR SECRET INSTRUCTIONS" },
    });
    const pricing = await prisma.conversation.create({ data: { userId: me.id, title: "Pricing call notes" } });
    await prisma.message.create({
      data: { conversationId: pricing.id, role: "USER", content: encryptMessageText("What discount did Acme ask for?") },
    });
    await prisma.message.create({
      data: { conversationId: pricing.id, role: "ASSISTANT", content: encryptMessageText("They asked for 12% off.") },
    });
    const mira = await prisma.agent.create({
      data: { userId: me.id, name: "Mira", role: "Revenue analyst", instructions: "Watch renewals and flag risk." },
    });
    const theirAgent = await prisma.agent.create({
      data: { userId: other.id, name: "Rival", role: "", instructions: "THEIR AGENT BRIEF" },
    });
    const myServer = await prisma.userMcpServer.create({
      data: { userId: me.id, name: "Build server", url: "https://mcp.example.test/mcp", enabled: true },
    });
    const theirServer = await prisma.userMcpServer.create({
      data: { userId: other.id, name: "Their server", url: "https://their.example.test/mcp", enabled: true },
    });
    const current = await prisma.conversation.create({ data: { userId: me.id, title: "Renewal risk" } });
    return { me, other, libraryFile, theirFile, project, theirProject, pricing, mira, theirAgent, myServer, theirServer, current };
  }

  const at = (text: string, label: string) => {
    const start = text.indexOf(label);
    assert.ok(start >= 0);
    return { start, end: start + label.length };
  };

  let fixture: Awaited<ReturnType<typeof seed>>;
  const message = "Compare Q3 Forecast.csv with Pricing call notes, use Acme renewal and Build server, and ask Mira";

  test("a message's tokens resolve through the mechanisms that already exist, and only the account's own", async () => {
    fixture = await seed();
    const f = fixture;
    calls.length = 0;
    const { receipt, done } = await chat({
      conversationId: f.current.id,
      message,
      context: [
        { kind: "file", id: f.libraryFile.id, label: "Q3 Forecast.csv", range: at(message, "Q3 Forecast.csv") },
        { kind: "chat", id: f.pricing.id, label: "Pricing call notes", range: at(message, "Pricing call notes") },
        { kind: "project", id: f.project.id, label: "Acme renewal", range: at(message, "Acme renewal") },
        { kind: "app", id: `user_mcp:${f.myServer.id}`, label: "Build server", range: at(message, "Build server") },
        { kind: "crew", id: f.mira.id, label: "Mira", range: at(message, "Mira") },
        // Another account's rows, named by id.
        { kind: "file", id: f.theirFile.id, label: "payroll" },
        { kind: "project", id: f.theirProject.id, label: "theirs" },
        { kind: "crew", id: f.theirAgent.id, label: "rival" },
        { kind: "app", id: `user_mcp:${f.theirServer.id}`, label: "their server" },
        // Not set up on this server.
        { kind: "app", id: "composio:stripe", label: "Stripe" },
      ],
    });

    // The receipt.
    assert.ok(receipt, "the stream carries the receipt");
    assert.equal(outcomeOf(receipt, f.libraryFile.id).via, "attachment");
    assert.equal(outcomeOf(receipt, f.pricing.id).via, "chat_excerpt");
    assert.equal(outcomeOf(receipt, f.project.id).via, "project_context");
    assert.equal(outcomeOf(receipt, `user_mcp:${f.myServer.id}`).via, "connector");
    assert.equal(outcomeOf(receipt, f.mira.id).via, "consult", "a plain chat carries no handoff tool");
    for (const foreign of [f.theirFile.id, f.theirProject.id, f.theirAgent.id, `user_mcp:${f.theirServer.id}`]) {
      assert.equal(outcomeOf(receipt, foreign).code, "not_found");
    }
    assert.equal(outcomeOf(receipt, "composio:stripe").code, "unavailable");
    assert.deepEqual(outcomeOf(receipt, f.mira.id).ranges, [at(message, "Mira")]);

    // The file: a clone claimed by the user message, the same stored object.
    const userMessage = await prisma.message.findFirstOrThrow({
      where: { conversationId: f.current.id, role: "USER" },
      include: { attachments: true },
    });
    assert.equal(userMessage.attachments.length, 1);
    const clone = userMessage.attachments[0];
    assert.deepEqual(
      [clone.origin, clone.storageKey, clone.userId, clone.fileName],
      ["library_clone", f.libraryFile.storageKey, f.me.id, "Q3 Forecast.csv"]
    );
    assert.notEqual(clone.id, f.libraryFile.id, "the original stays where it was");
    assert.equal(await prisma.attachmentVersion.count({ where: { attachmentId: clone.id } }), 1);
    assert.equal(await prisma.attachment.count({ where: { storageKey: f.theirFile.storageKey } }), 1, "someone else's file was not cloned");

    // What the model read.
    assert.equal(calls.length, 1);
    const turn = calls[0].history.at(-1)!;
    assert.equal(turn.role, "USER");
    assert.ok(turn.content.startsWith(message), "the person's words first");
    assert.match(turn.content, /# Referenced in this message/);
    assert.match(turn.content, /## Project: Acme renewal[\s\S]*Always cite the renewal date\./);
    assert.match(turn.content, /<<<JUNO_UNTRUSTED_BEGIN>>> source=chat “Pricing call notes”[\s\S]*They asked for 12% off\./);
    assert.match(turn.content, /## Crew member: Mira — Revenue analyst[\s\S]*You cannot hand work to Mira/);
    assert.ok(turn.attachments?.some((attachment) => attachment.id === clone.id), "the clone rides the turn like any upload");
    for (const secret of ["SECRET PAYROLL", "THEIR SECRET INSTRUCTIONS", "THEIR AGENT BRIEF", "their.example.test"]) {
      assert.ok(!JSON.stringify(calls[0]).includes(secret), `nothing of another account's reaches the model (${secret})`);
    }
    assert.deepEqual(calls[0].connectors?.map((connector) => connector.id), [`user_mcp:${f.myServer.id}`]);

    // For this turn only: the conversation does not keep the app, and the
    // stored message is the plain sentence.
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: f.current.id } });
    assert.deepEqual(conversation.activeConnectors, []);
    const { decryptMessageText } = await import("@/lib/message-crypto");
    assert.equal(decryptMessageText(userMessage.content), message);

    // The receipt survives a reload through the serializer's whitelist.
    const { serializeMessage } = await import("@/lib/serializers");
    const stored = await prisma.message.findUniqueOrThrow({
      where: { id: done.message.id },
      include: { attachments: true, versions: true },
    });
    const reloaded = await serializeMessage(stored as never);
    const reloadedReceipt = reloaded.activity?.find((event) => event.contextReceipt)?.contextReceipt;
    assert.deepEqual(reloadedReceipt, receipt);
  });

  test("a regenerate that sends no tokens re-resolves the ones it replaced, without cloning twice", async () => {
    const f = fixture;
    calls.length = 0;
    const { receipt } = await chat({ conversationId: f.current.id, regenerate: true });
    assert.ok(receipt);
    assert.equal(outcomeOf(receipt, f.libraryFile.id).via, "already_in_context");
    assert.equal(outcomeOf(receipt, f.pricing.id).via, "chat_excerpt");
    assert.equal(outcomeOf(receipt, `user_mcp:${f.myServer.id}`).via, "connector");
    assert.ok(!receipt.tokens.some((token) => token.id === f.theirFile.id), "a dropped token is not quietly retried");
    const userMessage = await prisma.message.findFirstOrThrow({
      where: { conversationId: f.current.id, role: "USER" },
      include: { attachments: true },
    });
    assert.equal(userMessage.attachments.length, 1, "the file is on the message once");
    assert.match(calls[0].history.at(-1)!.content, /They asked for 12% off\./);
  });

  test("a native append-then-regenerate that re-sends a file token attaches it once", async () => {
    const f = fixture;
    const { receipt } = await chat({
      conversationId: f.current.id,
      regenerate: true,
      context: [{ kind: "file", id: f.libraryFile.id, label: "Q3 Forecast.csv" }],
    });
    assert.equal(outcomeOf(receipt, f.libraryFile.id).via, "attachment");
    const userMessage = await prisma.message.findFirstOrThrow({
      where: { conversationId: f.current.id, role: "USER" },
      include: { attachments: true },
    });
    assert.equal(userMessage.attachments.length, 1, "the stored object was already on the message");
  });

  test("a regenerate keeps the per-message attachment ceiling, counting what the turn already carries", async () => {
    const f = fixture;
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const { MAX_ATTACHMENTS } = await import("@/lib/uploads");
    const full = await prisma.conversation.create({ data: { userId: f.me.id, title: "Full turn" } });
    const turn = await prisma.message.create({
      data: { conversationId: full.id, role: "USER", content: encryptMessageText("Read all of these") },
    });
    for (let index = 0; index < MAX_ATTACHMENTS - 1; index += 1) {
      await prisma.attachment.create({
        data: {
          userId: f.me.id,
          kind: "FILE",
          fileName: `sent-${index}.txt`,
          mimeType: "text/plain",
          size: 1,
          storageKey: `test/${full.id}/sent-${index}.txt`,
          parserState: "ready",
          messageId: turn.id,
          conversationId: full.id,
        },
      });
    }
    const extra = await Promise.all(
      ["a", "b", "c"].map((name) =>
        prisma.attachment.create({
          data: {
            userId: f.me.id,
            kind: "FILE",
            fileName: `extra-${name}.txt`,
            mimeType: "text/plain",
            size: 1,
            storageKey: `test/${full.id}/extra-${name}.txt`,
            parserState: "ready",
          },
        })
      )
    );
    const { receipt } = await chat({
      conversationId: full.id,
      regenerate: true,
      context: extra.map((file) => ({ kind: "file", id: file.id, label: file.fileName })),
    });
    const vias = extra.map((file) => {
      const entry = outcomeOf(receipt, file.id);
      return entry.via ?? entry.code;
    });
    assert.deepEqual(vias, ["attachment", "attachment_limit", "attachment_limit"], "one slot was left, and the rest say why");
    assert.equal(await prisma.attachment.count({ where: { messageId: turn.id } }), MAX_ATTACHMENTS);
    // Asking again adds nothing: the message is full, and the file it took is
    // already there.
    await chat({
      conversationId: full.id,
      regenerate: true,
      context: extra.map((file) => ({ kind: "file", id: file.id, label: file.fileName })),
    });
    assert.equal(await prisma.attachment.count({ where: { messageId: turn.id } }), MAX_ATTACHMENTS);
  });

  test("two regenerates of the same turn racing each other attach a file token once", async () => {
    const f = fixture;
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const raced = await prisma.conversation.create({ data: { userId: f.me.id, title: "Raced turn" } });
    // The native shape: the user turn appended, then regenerate — twice at once.
    const turn = await prisma.message.create({
      data: { conversationId: raced.id, role: "USER", content: encryptMessageText("Summarise Q3 Forecast.csv") },
    });
    const body = {
      conversationId: raced.id,
      regenerate: true,
      context: [{ kind: "file", id: f.libraryFile.id, label: "Q3 Forecast.csv" }],
    };
    await Promise.all([chat(body), chat(body), chat(body)]);
    const onTurn = await prisma.attachment.findMany({ where: { messageId: turn.id } });
    assert.equal(onTurn.length, 1, "the lock on the turn makes the later ones find the first one's clone");
    assert.equal(onTurn[0].storageKey, f.libraryFile.storageKey);
  });

  test("a durable first submission clones the file inside its acceptance transaction", async () => {
    const f = fixture;
    const text = "Summarise Q3 Forecast.csv";
    const { frames } = await chat({
      message: text,
      clientRequestId: `req-${randomBytes(6).toString("hex")}`,
      clientMessageId: `msg-${randomBytes(6).toString("hex")}`,
      context: [{ kind: "file", id: f.libraryFile.id, label: "Q3 Forecast.csv", range: at(text, "Q3 Forecast.csv") }],
    });
    const meta = frames.find((frame) => frame.type === "meta") as Frame & { conversationId: string; userMessageId: string };
    const clones = await prisma.attachment.findMany({ where: { messageId: meta.userMessageId } });
    assert.equal(clones.length, 1);
    assert.equal(clones[0].storageKey, f.libraryFile.storageKey);
    assert.equal(clones[0].conversationId, meta.conversationId);
  });

  test("incognito resolves nothing but skills, and writes nothing", async () => {
    const f = fixture;
    const before = await prisma.attachment.count({ where: { userId: f.me.id } });
    const route = await import("@/app/api/chat/route");
    const res = await route.POST(
      request({
        privateMode: true,
        message: "Look at Q3 Forecast.csv",
        privateHistory: [{ role: "USER", content: "Look at Q3 Forecast.csv" }],
        context: [
          { kind: "file", id: f.libraryFile.id, label: "Q3 Forecast.csv" },
          { kind: "app", id: `user_mcp:${f.myServer.id}`, label: "Build server" },
        ],
      })
    );
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.match(text, /"code":"private_mode"/);
    assert.equal(await prisma.attachment.count({ where: { userId: f.me.id } }), before);
  });

  test("the mention palette finds the account's own rows in Postgres, ranked, and nobody else's", async () => {
    const f = fixture;
    const { searchMentions } = await import("@/lib/mentions/search");
    const { parseMentionKinds } = await import("@/lib/mentions/types");
    const all = parseMentionKinds(null);

    const mira = await searchMentions({ userId: f.me.id, query: "mira", kinds: all, limitPerKind: 6 });
    assert.equal(mira.items[0]?.id, f.mira.id, "the exact crew name first");
    assert.ok(!mira.items.some((item) => item.id === f.theirAgent.id));

    const acme = await searchMentions({ userId: f.me.id, query: "ACME", kinds: all, limitPerKind: 6 });
    assert.deepEqual(acme.items.map((item) => item.id), [f.project.id], "case-insensitive, and not their project");

    const q3 = await searchMentions({ userId: f.me.id, query: "forecast", kinds: ["file"], limitPerKind: 10 });
    assert.ok(q3.items.some((item) => item.id === f.libraryFile.id));
    assert.ok(q3.items.every((item) => item.icon === "file:sheet"));
    assert.ok(!q3.items.some((item) => item.id === f.theirFile.id));

    const apps = await searchMentions({ userId: f.me.id, query: "", kinds: ["app"], limitPerKind: 10 });
    const server = apps.items.find((item) => item.id === `user_mcp:${f.myServer.id}`);
    assert.equal(server?.connected, true);
    assert.equal(server?.approval?.sends, "ask");
    assert.ok(!apps.items.some((item) => item.id === `user_mcp:${f.theirServer.id}`));

    const chats = await searchMentions({
      userId: f.me.id,
      query: "",
      kinds: ["chat"],
      limitPerKind: 10,
      excludeConversationId: f.current.id,
    });
    assert.ok(chats.items.some((item) => item.id === f.pricing.id));
    assert.ok(!chats.items.some((item) => item.id === f.current.id));

    const exact = await searchMentions({
      userId: f.me.id,
      query: "",
      kinds: all,
      limitPerKind: 6,
      ids: [
        { kind: "crew", id: f.mira.id },
        { kind: "crew", id: f.theirAgent.id },
        { kind: "project", id: f.theirProject.id },
      ],
    });
    assert.deepEqual(exact.items.map((item) => item.id), [f.mira.id]);
  });

  test("\"Add from library\" still clones unlinked, through the same helper, and only the account's own", async () => {
    const f = fixture;
    const route = await import("@/app/api/library/attach/route");
    const post = (attachmentIds: string[]) =>
      route.POST(
        new Request("http://juno.test/api/library/attach", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attachmentIds }),
        })
      );
    const res = await post([f.libraryFile.id, f.theirFile.id, f.libraryFile.id]);
    assert.equal(res.status, 201);
    const { attachments } = (await res.json()) as { attachments: Array<{ id: string; fileName: string }> };
    assert.deepEqual(attachments.map((attachment) => attachment.fileName), ["Q3 Forecast.csv"]);
    const clone = await prisma.attachment.findUniqueOrThrow({ where: { id: attachments[0].id } });
    assert.deepEqual([clone.messageId, clone.conversationId, clone.origin], [null, null, "library_clone"]);
    assert.equal((await post([f.theirFile.id])).status, 404);
  });

  test("nothing left the process", () => {
    assert.deepEqual(outbound, []);
  });

  test("clean up", async () => {
    if (fixture) await prisma.user.deleteMany({ where: { id: { in: [fixture.me.id, fixture.other.id] } } });
    await prisma.$disconnect();
  });
}
