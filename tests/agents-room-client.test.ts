import test from "node:test";
import assert from "node:assert/strict";
import {
  ROOM_CLIENT_MAX_DISPATCHES_PER_MESSAGE,
  liveRoomSpeaker,
  roomDispatchKey,
  roomMembersLine,
  roomSpeakersByMessage,
  roomTurnToDispatch,
} from "../src/lib/agents/room-client";
import { ROOM_MAX_TURNS_PER_MESSAGE } from "../src/lib/agents/rooms";
import type { ClientRoomDetail, ClientRoomTurn } from "../src/lib/agents/room-types";
import type { ClientAgent } from "../src/lib/agents/types";

function agent(id: string, name: string): ClientAgent {
  return { id, name, role: "", avatar: { shape: "petal", tone: "violet", eyes: "wide", mark: "none" }, state: "idle" } as unknown as ClientAgent;
}

function turn(partial: Partial<ClientRoomTurn> & Pick<ClientRoomTurn, "agentId" | "status">): ClientRoomTurn {
  return { id: `t-${partial.agentId}`, userMessageId: "u1", fromAgentId: null, reason: "routed", handoffSentence: null, messageId: null, ...partial };
}

function detail(turns: ClientRoomTurn[], next: ClientRoomDetail["next"]): ClientRoomDetail {
  return {
    room: { conversationId: "c1", title: "Launch review", members: [agent("a-mira", "Mira"), agent("a-scout", "Scout"), agent("a-quill", "Quill")], lastMessageAt: "", createdAt: "" },
    turns,
    next,
  };
}

test("the client never dispatches more turns per message than the server allows", () => {
  assert.equal(ROOM_CLIENT_MAX_DISPATCHES_PER_MESSAGE, ROOM_MAX_TURNS_PER_MESSAGE);
});

test("a pending next turn is dispatched once; busy, done and repeated reads dispatch nothing", () => {
  const d = detail([turn({ agentId: "a-mira", status: "answered", messageId: "m1" }), turn({ agentId: "a-scout", status: "pending" })], { agentId: "a-scout", userMessageId: "u1" });
  const dispatched = new Set<string>();
  const first = roomTurnToDispatch({ detail: d, busy: false, dispatched });
  assert.deepEqual(first, { agentId: "a-scout", userMessageId: "u1", key: "u1:a-scout" });
  dispatched.add(first!.key);
  assert.equal(roomTurnToDispatch({ detail: d, busy: false, dispatched }), null, "a reload of the same detail does not ask twice");
  assert.equal(roomTurnToDispatch({ detail: d, busy: true, dispatched: new Set() }), null, "one agent at a time");
  assert.equal(roomTurnToDispatch({ detail: detail([], null), busy: false, dispatched: new Set() }), null);
  assert.equal(roomTurnToDispatch({ detail: null, busy: false, dispatched: new Set() }), null);
});

test("a server that kept naming new turns for one message is still cut off at the bound", () => {
  const dispatched = new Set<string>();
  const agents = ["a1", "a2", "a3", "a4", "a5", "a6"];
  let ran = 0;
  for (const id of agents) {
    const t = roomTurnToDispatch({ detail: detail([], { agentId: id, userMessageId: "u9" }), busy: false, dispatched });
    if (t) {
      dispatched.add(t.key);
      ran += 1;
    }
  }
  assert.equal(ran, ROOM_CLIENT_MAX_DISPATCHES_PER_MESSAGE);
  assert.ok(roomTurnToDispatch({ detail: detail([], { agentId: "a1", userMessageId: "u10" }), busy: false, dispatched }), "a new message starts fresh");
  assert.equal(roomDispatchKey({ agentId: "a", userMessageId: "u" }), "u:a");
});

test("every answered reply is attributed to its member, with the handoff line on asked turns", () => {
  const d = detail(
    [
      turn({ agentId: "a-mira", status: "answered", messageId: "m1" }),
      turn({ agentId: "a-quill", status: "answered", messageId: "m2", reason: "asked", fromAgentId: "a-mira", handoffSentence: "Mira asked Quill to check the signup path" }),
      turn({ agentId: "a-ghost", status: "answered", messageId: "m3" }),
    ],
    null
  );
  const map = roomSpeakersByMessage(d);
  assert.equal(map.get("m1")?.name, "Mira");
  assert.equal(map.get("m1")?.handoff, null);
  assert.equal(map.get("m2")?.handoff, "Mira asked Quill to check the signup path");
  assert.equal(map.has("m3"), false, "a member who left is not invented");
  assert.equal(roomSpeakersByMessage(null).size, 0);
});

test("the live speaker is the running turn, or the member this tab just dispatched", () => {
  const running = detail([turn({ agentId: "a-mira", status: "running" })], null);
  assert.equal(liveRoomSpeaker(running, null)?.name, "Mira");
  assert.equal(liveRoomSpeaker(running, null)?.state, "working");
  const asked = detail([turn({ agentId: "a-mira", status: "answered", messageId: "m1" }), turn({ agentId: "a-scout", status: "pending", handoffSentence: "Mira asked Scout to check pricing" })], { agentId: "a-scout", userMessageId: "u1" });
  assert.equal(liveRoomSpeaker(asked, "a-scout")?.handoff, "Mira asked Scout to check pricing");
  assert.equal(liveRoomSpeaker(asked, null), null);
  assert.equal(roomMembersLine(running), "Mira, Scout and Quill");
});
