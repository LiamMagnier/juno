import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";

/*
 * A ROOM THROUGH THE REAL CHAT ROUTE: POST /api/chat, the room plan, the real
 * Anthropic adapter and its tool loop, `ask_room_member`, the follow-up turns
 * the web client dispatches (`roomTurn`), and GET /api/agents/rooms/[id], all
 * against a throwaway Postgres. Two stand-ins only: the signed-in session and
 * THE MODEL, a local HTTP server speaking Anthropic's streaming wire format
 * with scripted replies. Which agent answers, what it is told, whether a
 * second dispatch is refused and what is stored are all Alevr's decisions.
 *
 *   ORBIT_TEST_DATABASE_URL=postgresql://…/juno_orbitrw_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/orbit-rooms-route.integration.test.ts
 */

const DB_URL = process.env.ORBIT_TEST_DATABASE_URL;

if (!DB_URL) {
  test("rooms route suite is skipped without ORBIT_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(DB_URL, /\/juno_[a-z_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "orbit-rooms-route-test-secret";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-local-only";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  type Reply = { text: string } | { tool: { name: string; input: Record<string, unknown> } };
  const requests: Array<{ body: Record<string, unknown> }> = [];
  let script: (body: Record<string, unknown>) => Reply = () => ({ text: "No script." });

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  function sse(res: ServerResponse, events: Array<{ event: string; data: unknown }>) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const entry of events) res.write(`event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
    res.end();
  }

  function reply(res: ServerResponse, out: Reply, model: string) {
    const start = { type: "message_start", message: { id: `msg_${randomBytes(6).toString("hex")}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 } } };
    if ("tool" in out) {
      sse(res, [
        { event: "message_start", data: start },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name: out.tool.name, input: {} } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(out.tool.input) } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
      return;
    }
    sse(res, [
      { event: "message_start", data: start },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: out.text } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
  }

  let lab: Server;

  /** The whole system prompt of a lab request, however the adapter split it. */
  function systemOf(body: Record<string, unknown>): string {
    const system = body.system;
    if (typeof system === "string") return system;
    if (Array.isArray(system)) return system.map((block) => (block as { text?: string }).text ?? "").join("\n");
    return "";
  }
  function speakerOf(body: Record<string, unknown>): string | null {
    return /You are (Mira|Scout|Quill|Nova)\./.exec(systemOf(body))?.[1] ?? null;
  }
  function toolNames(body: Record<string, unknown>): string[] {
    return ((body.tools ?? []) as Array<{ name?: string }>).map((tool) => tool.name ?? "");
  }
  function hasToolResult(body: Record<string, unknown>): boolean {
    const messages = body.messages as Array<{ content: unknown }>;
    const last = messages[messages.length - 1];
    return Array.isArray(last?.content) && (last.content as Array<{ type: string }>).some((block) => block.type === "tool_result");
  }
  function historyText(body: Record<string, unknown>): string {
    return JSON.stringify(body.messages);
  }

  type Frame = { type: string; [key: string]: unknown };
  async function post(body: Record<string, unknown>): Promise<{ status: number; frames: Frame[]; text: string }> {
    const route = await import("@/app/api/chat/route");
    const res = await route.POST(new Request("http://alevr.test/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const text = await res.text();
    const frames = res.status === 200
      ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Frame)
      : [];
    return { status: res.status, frames, text };
  }
  async function roomDetail(conversationId: string) {
    const route = await import("@/app/api/agents/rooms/[conversationId]/route");
    const res = await route.GET(new Request(`http://alevr.test/api/agents/rooms/${conversationId}`), { params: Promise.resolve({ conversationId }) });
    return { status: res.status, body: (await res.json()) as import("@/lib/agents/room-types").ClientRoomDetail };
  }

  test("stand in for the session, the model lab and the network", async () => {
    lab = createServer(async (req, res) => {
      const body = await readBody(req);
      if (!req.url?.endsWith("/v1/messages")) return void res.writeHead(404).end();
      requests.push({ body });
      reply(res, script(body), String(body.model));
    });
    await new Promise<void>((resolve) => lab.listen(0, "127.0.0.1", resolve));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(lab.address() as AddressInfo).port}`;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`unexpected network call to ${url.origin}`);
      return realFetch(input, init);
    };
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: () => {} } });
  });

  test("a room: addressed members answer in order, a handoff is asked and shown, follow-ups are single-flight, reload finds no second responder", async () => {
    const suffix = randomBytes(4).toString("hex");
    const user = await prisma.user.create({ data: { email: `rooms-route-${suffix}@example.invalid`, name: "Liam", emailVerified: new Date() } });
    await prisma.subscription.create({ data: { userId: user.id, plan: "PRO", status: "ACTIVE" } });
    signedIn = { id: user.id, email: user.email, name: user.name! };
    const agent = (name: string, role: string) => prisma.agent.create({ data: { userId: user.id, name, role, instructions: `${name} handles ${role.toLowerCase()}.` } });
    const mira = await agent("Mira", "Product");
    const scout = await agent("Scout", "Research and pricing");
    const quill = await agent("Quill", "Engineering");
    const nova = await agent("Nova", "Design");
    const { createRoomForUser } = await import("@/lib/agents/room-store");
    const created = await createRoomForUser({ id: user.id, name: user.name }, { agentIds: [mira.id, scout.id, quill.id, nova.id], title: "Launch review" });
    assert.ok(created.ok);
    const conversationId = created.ok ? created.room.conversationId : "";

    script = (body) => {
      const speaker = speakerOf(body);
      if (speaker === "Mira" && !hasToolResult(body)) {
        assert.ok(toolNames(body).includes("ask_room_member"), `Mira may ask a member: ${toolNames(body)}`);
        return { tool: { name: "ask_room_member", input: { member: "Quill", request: "check the signup code path" } } };
      }
      if (speaker === "Mira") return { text: "Onboarding copy is long; I asked Quill to check signup." };
      if (speaker === "Scout") return { text: "Pricing on step 3 is out of date." };
      if (speaker === "Quill") return { text: "The signup path validates correctly." };
      return { text: `Unexpected speaker ${speaker}` };
    };

    // 1. The person's message: Mira (addressed first) answers now.
    const first = await post({ conversationId, message: "@Mira and @Scout: review onboarding before launch", model: "claude-sonnet-5" });
    assert.equal(first.status, 200, first.text.slice(0, 400));
    assert.ok(first.frames.some((f) => f.type === "done"), "the turn settles");
    assert.equal(speakerOf(requests[0]!.body), "Mira");

    // 2. Reload: the room says Scout is next, then Quill (asked), with the handoff line.
    let detail = await roomDetail(conversationId);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.next?.agentId, scout.id);
    const asked = detail.body.turns.find((t) => t.agentId === quill.id);
    assert.equal(asked?.handoffSentence, "Mira asked Quill to check the signup code path");
    assert.equal(asked?.status, "pending");

    // 3. Two tabs dispatch Scout's turn at once: one answers, the other is refused.
    const before = requests.length;
    const [a, b] = await Promise.all([
      post({ conversationId, regenerate: true, roomTurn: { agentId: scout.id }, model: "claude-sonnet-5" }),
      post({ conversationId, regenerate: true, roomTurn: { agentId: scout.id }, model: "claude-sonnet-5" }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const scoutRequests = requests.slice(before).filter((r) => speakerOf(r.body) === "Scout");
    assert.equal(scoutRequests.length, 1, "Scout was asked once");
    assert.match(historyText(scoutRequests[0]!.body), /\[Mira\] Onboarding copy is long/, "Scout reads Mira's reply labelled with her name");

    // 4. Quill answers what Mira asked.
    detail = await roomDetail(conversationId);
    assert.deepEqual(detail.body.next?.agentId, quill.id);
    const quillTurn = await post({ conversationId, regenerate: true, roomTurn: { agentId: quill.id }, model: "claude-sonnet-5" });
    assert.equal(quillTurn.status, 200, quillTurn.text.slice(0, 300));
    const quillRequest = requests.filter((r) => speakerOf(r.body) === "Quill").at(-1)!;
    assert.match(systemOf(quillRequest.body), /Mira asked you to: check the signup code path/);
    assert.ok(!toolNames(quillRequest.body).includes("ask_room_member"), "the cap is reached: nobody else may be asked");

    // 5. Done: nothing next, three named replies, a forged fourth turn is refused.
    detail = await roomDetail(conversationId);
    assert.equal(detail.body.next, null);
    const answered = detail.body.turns.filter((t) => t.status === "answered");
    assert.deepEqual(answered.map((t) => t.agentId), [mira.id, scout.id, quill.id]);
    assert.ok(answered.every((t) => t.messageId));
    assert.equal(await prisma.message.count({ where: { conversationId, role: "ASSISTANT" } }), 3);
    const forged = await post({ conversationId, regenerate: true, roomTurn: { agentId: nova.id }, model: "claude-sonnet-5" });
    assert.equal(forged.status, 409);
    const again = await post({ conversationId, regenerate: true, roomTurn: { agentId: scout.id }, model: "claude-sonnet-5" });
    assert.equal(again.status, 409, "a reload that re-dispatches a finished turn gets nothing");
    assert.equal(await prisma.message.count({ where: { conversationId, role: "ASSISTANT" } }), 3);

    // 6. Another account cannot read the room.
    const other = await prisma.user.create({ data: { email: `rooms-other-${suffix}@example.invalid`, name: "Other", emailVerified: new Date() } });
    signedIn = { id: other.id, email: other.email, name: other.name! };
    assert.equal((await roomDetail(conversationId)).status, 404);
    signedIn = null;
  });

  test("close the lab", async () => {
    await new Promise<void>((resolve) => lab.close(() => resolve()));
    await prisma.$disconnect();
  });
}
