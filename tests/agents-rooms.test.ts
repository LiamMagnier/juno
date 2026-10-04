/**
 * Rooms (src/lib/agents/rooms.ts, room-store.ts): two to six agents in one
 * chat, bounded per message of the person's.
 *
 * The first half is the pure rules: @Name / @all addressing, routing when
 * nobody is addressed, the per-message turn cap, the loop guard on
 * ask_room_member, member resolution and the words the room shows.
 *
 * The second half drives the store against a real Postgres, because the cap
 * and the loop guard are also database unique keys and a race is only proven
 * by the database refusing it. Opt-in, never a developer database:
 *
 *   ORBIT_TEST_DATABASE_URL=postgresql://…/juno_orbit_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test tests/agents-rooms.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ROOM_MAX_MEMBERS,
  ROOM_MAX_TURNS_PER_MESSAGE,
  ROOM_MIN_MEMBERS,
  ROOM_TURN_STALE_MS,
  buildRoomPromptBlock,
  canAskMember,
  findAddressedMembers,
  labelRoomHistory,
  memberByName,
  nextRoomTurn,
  parseAskArgs,
  parseRoomAgentNames,
  planRoomTurns,
  resolveRoomMembers,
  roomHandoffSentence,
  roomNamesTitle,
  roomTitle,
  type RoomMemberInfo,
} from "../src/lib/agents/rooms";

const mira: RoomMemberInfo = { agentId: "a-mira", name: "Mira", role: "Product lead", about: "Owns launch reviews and onboarding" };
const scout: RoomMemberInfo = { agentId: "a-scout", name: "Scout", role: "Research analyst", about: "Tracks competitor pricing and benchmarks" };
const quill: RoomMemberInfo = { agentId: "a-quill", name: "Quill", role: "Engineering", about: "Reads the repository and reviews code" };
const nova: RoomMemberInfo = { agentId: "a-nova", name: "Nova", role: "Design", about: "Interface and visual design" };
const team = [mira, scout, quill, nova];

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

test("@Name addresses members in the order they are named, once each", () => {
  assert.deepEqual(findAddressedMembers("@Scout check pricing, then @Mira decide. @Scout again", team), ["a-scout", "a-mira"]);
  assert.deepEqual(findAddressedMembers("@scout lower case works", team), ["a-scout"]);
});

test("@Name matches whole names only and the longer name wins where two overlap", () => {
  assert.deepEqual(findAddressedMembers("@Scouting is not a member", team), []);
  assert.deepEqual(findAddressedMembers("email me at mira@example.com", team), [], "an e-mail address is not a mention");
  const bell: RoomMemberInfo = { agentId: "a-bell", name: "Mira Bell", role: "Legal" };
  assert.deepEqual(findAddressedMembers("@Mira Bell please read the contract", [mira, bell]), ["a-bell"]);
  assert.deepEqual(findAddressedMembers("@Mira and @Mira Bell", [mira, bell]), ["a-mira", "a-bell"]);
});

test("@all and @everyone address every active member, and paused members never answer", () => {
  assert.deepEqual(findAddressedMembers("@all thoughts?", team), team.map((m) => m.agentId));
  assert.deepEqual(findAddressedMembers("@everyone", team), team.map((m) => m.agentId));
  const paused = [mira, { ...scout, paused: true }, quill];
  assert.deepEqual(findAddressedMembers("@all", paused), ["a-mira", "a-quill"]);
  assert.deepEqual(findAddressedMembers("@Scout are you there", paused), []);
});

// ---------------------------------------------------------------------------
// Planning: who answers a new message
// ---------------------------------------------------------------------------

test("@all is still capped at the per-message turn limit", () => {
  const plan = planRoomTurns({ text: "@all review the onboarding", members: team });
  assert.equal(plan.length, ROOM_MAX_TURNS_PER_MESSAGE);
  assert.ok(plan.every((turn) => turn.reason === "addressed"));
  assert.deepEqual(plan.map((t) => t.agentId), ["a-mira", "a-scout", "a-quill"]);
});

test("with nobody addressed exactly one member answers: the best fit, not everyone", () => {
  const plan = planRoomTurns({ text: "Compare competitor pricing benchmarks", members: team });
  assert.deepEqual(plan, [{ agentId: "a-scout", reason: "routed" }]);
  const design = planRoomTurns({ text: "Is the visual design of the interface ok?", members: team });
  assert.deepEqual(design, [{ agentId: "a-nova", reason: "routed" }]);
});

test("a name said without @ counts most when routing", () => {
  const plan = planRoomTurns({ text: "Quill, what do you think about pricing?", members: team });
  assert.deepEqual(plan, [{ agentId: "a-quill", reason: "routed" }]);
});

test("nobody fits: the conversation stays with the last speaker, else the first active member", () => {
  assert.deepEqual(planRoomTurns({ text: "ok thanks", members: team, lastSpeakerId: "a-quill" }), [{ agentId: "a-quill", reason: "routed" }]);
  assert.deepEqual(planRoomTurns({ text: "ok thanks", members: team }), [{ agentId: "a-mira", reason: "routed" }]);
  assert.deepEqual(planRoomTurns({ text: "ok", members: [{ ...mira, paused: true }, scout] }), [{ agentId: "a-scout", reason: "routed" }]);
  assert.deepEqual(planRoomTurns({ text: "hi", members: [{ ...mira, paused: true }] }), [], "a fully paused room plans nothing");
});

// ---------------------------------------------------------------------------
// Asking another member: cap and loop guard
// ---------------------------------------------------------------------------

test("an agent may ask a member that has not spoken, at the next position", () => {
  const verdict = canAskMember({ fromAgentId: "a-mira", targetAgentId: "a-scout", members: team, turns: [{ agentId: "a-mira" }] });
  assert.deepEqual(verdict, { ok: true, position: 1 });
});

test("ask refusals: self, non-member, paused, already answering (the loop guard), cap reached", () => {
  const turns = [{ agentId: "a-mira" }];
  assert.deepEqual(canAskMember({ fromAgentId: "a-mira", targetAgentId: "a-mira", members: team, turns }), { ok: false, reason: "self" });
  assert.deepEqual(canAskMember({ fromAgentId: "a-mira", targetAgentId: "a-stranger", members: team, turns }), { ok: false, reason: "not_member" });
  assert.deepEqual(
    canAskMember({ fromAgentId: "a-mira", targetAgentId: "a-scout", members: [mira, { ...scout, paused: true }], turns }),
    { ok: false, reason: "paused" }
  );
  // Scout was asked by Mira and answered; Scout now tries to ask Mira back.
  assert.deepEqual(
    canAskMember({ fromAgentId: "a-scout", targetAgentId: "a-mira", members: team, turns: [{ agentId: "a-mira" }, { agentId: "a-scout" }] }),
    { ok: false, reason: "already_answering" }
  );
  const full = [{ agentId: "a-mira" }, { agentId: "a-scout" }, { agentId: "a-quill" }];
  assert.deepEqual(canAskMember({ fromAgentId: "a-quill", targetAgentId: "a-nova", members: team, turns: full }), { ok: false, reason: "cap_reached" });
});

test("a handoff chain cannot exceed the cap or revisit anyone, whatever the agents ask", () => {
  // Simulate the worst case: every answering agent asks whoever it can.
  const turns: { agentId: string }[] = [{ agentId: "a-mira" }];
  for (let step = 0; step < 20; step++) {
    const from = turns[turns.length - 1]!.agentId;
    let asked = false;
    for (const target of team) {
      const verdict = canAskMember({ fromAgentId: from, targetAgentId: target.agentId, members: team, turns });
      if (verdict.ok) {
        assert.equal(verdict.position, turns.length);
        turns.push({ agentId: target.agentId });
        asked = true;
        break;
      }
    }
    if (!asked) break;
  }
  assert.equal(turns.length, ROOM_MAX_TURNS_PER_MESSAGE);
  assert.equal(new Set(turns.map((t) => t.agentId)).size, turns.length, "no agent answers twice");
});

// ---------------------------------------------------------------------------
// What runs next
// ---------------------------------------------------------------------------

test("next turn: one at a time, in position order; a stale running turn no longer blocks", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const fresh = new Date(now.getTime() - 1000);
  const stale = new Date(now.getTime() - ROOM_TURN_STALE_MS - 1);
  const pending = (position: number) => ({ position, status: "pending", updatedAt: fresh });
  assert.equal(nextRoomTurn([{ position: 0, status: "running", updatedAt: fresh }, pending(1)], now), null);
  assert.equal(nextRoomTurn([{ position: 0, status: "running", updatedAt: stale }, pending(2), pending(1)], now)?.position, 1);
  assert.equal(nextRoomTurn([{ position: 0, status: "answered", updatedAt: fresh }], now), null);
  assert.equal(nextRoomTurn([], now), null);
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

test("a room has two to six members; unknown and ambiguous names refuse rather than guess", () => {
  assert.equal(ROOM_MIN_MEMBERS, 2);
  assert.equal(ROOM_MAX_MEMBERS, 6);
  const ok = resolveRoomMembers(["@Mira", "scout", "Mira"], team);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.members.map((m) => m.agentId), ["a-mira", "a-scout"], "duplicates collapse");
  assert.deepEqual(resolveRoomMembers(["Mira"], team), { ok: false, reason: "too_few" });
  assert.deepEqual(resolveRoomMembers(["Mira", "Ghost"], team), { ok: false, reason: "unknown", name: "Ghost" });
  const twins = [...team, { agentId: "a-mira-2", name: "mira", role: "Other" }];
  assert.deepEqual(resolveRoomMembers(["Mira", "Scout"], twins), { ok: false, reason: "ambiguous", name: "Mira" });
  const seven = Array.from({ length: 7 }, (_, i) => ({ agentId: `a-${i}`, name: `Agent${i}`, role: "" }));
  assert.deepEqual(resolveRoomMembers(seven.map((m) => m.name), seven), { ok: false, reason: "too_many" });
  assert.equal(memberByName("@scout", team)?.agentId, "a-scout");
  assert.equal(memberByName("Mira", [mira, { ...mira, agentId: "x" }]), null);
});

test("create_room arguments: an array or one comma/and-separated string", () => {
  assert.deepEqual(parseRoomAgentNames(["@Mira", " Scout "]), ["Mira", "Scout"]);
  assert.deepEqual(parseRoomAgentNames("Mira, Scout and Quill & Nova"), ["Mira", "Scout", "Quill", "Nova"]);
  assert.deepEqual(parseRoomAgentNames(42), []);
  assert.equal(parseRoomAgentNames(Array.from({ length: 20 }, (_, i) => `A${i}`)).length, ROOM_MAX_MEMBERS + 2);
});

// ---------------------------------------------------------------------------
// Words the room shows
// ---------------------------------------------------------------------------

test("handoff lines read as work: 'Mira asked Scout to check the pricing'", () => {
  assert.equal(roomHandoffSentence("Mira", "Scout", "To check the pricing."), "Mira asked Scout to check the pricing");
  assert.equal(roomHandoffSentence("Mira", "Scout", "Verify Apple's specs"), "Mira asked Scout to verify Apple's specs");
  assert.equal(roomHandoffSentence("Mira", "Scout", null), "Mira asked Scout to pick this up");
  assert.deepEqual(parseAskArgs({ member: "@Scout", request: "  check   pricing " }), { member: "Scout", request: "check pricing" });
  assert.equal(parseAskArgs({ member: "Scout" }), null);
});

test("room titles name the members or the topic", () => {
  assert.equal(roomNamesTitle(["Mira", "Scout"]), "Mira and Scout");
  assert.equal(roomNamesTitle(["Mira", "Scout", "Quill"]), "Mira, Scout and Quill");
  assert.equal(roomTitle(["Mira", "Scout"], "Launch review"), "Launch review");
  assert.ok(roomTitle(["Mira"], "x".repeat(200)).length <= 80);
});

test("history labels other members' replies and never the answering agent's own", () => {
  const history = [
    { id: "u1", role: "USER", content: "Review onboarding" },
    { id: "m1", role: "ASSISTANT", content: "Copy is long." },
    { id: "m2", role: "ASSISTANT", content: "Pricing is $20." },
  ];
  const speakers = new Map([
    ["m1", { agentId: "a-mira", name: "Mira" }],
    ["m2", { agentId: "a-scout", name: "Scout" }],
  ]);
  const asScout = labelRoomHistory(history, speakers, "a-scout");
  assert.equal(asScout[1]!.content, "[Mira] Copy is long.");
  assert.equal(asScout[2]!.content, "Pricing is $20.");
  assert.equal(asScout[0]!.content, "Review onboarding");
});

test("the room prompt names the others, says why this agent answers and offers asking only when allowed", () => {
  const block = buildRoomPromptBlock({ self: { agentId: "a-scout", name: "Scout" }, members: team, personName: "Liam", asked: { fromName: "Mira", request: "check the pricing" }, canAsk: false });
  assert.match(block, /You are Scout/);
  assert.match(block, /Mira asked you to: check the pricing/);
  assert.doesNotMatch(block, /- Scout/);
  assert.doesNotMatch(block, /ask_room_member/);
  assert.match(buildRoomPromptBlock({ self: { agentId: "a-mira", name: "Mira" }, members: team, canAsk: true }), /ask_room_member/);
});

// ---------------------------------------------------------------------------
// The store against Postgres: ownership, duplicate turns, caps under races,
// follow-up dispatch and reload.
// ---------------------------------------------------------------------------

const url = process.env.ORBIT_TEST_DATABASE_URL;

test("room store: plan, follow-up dispatch, ask, cap, duplicate prevention, ownership and reload", { skip: !url }, async () => {
  assert.match(url!, /\/juno_[a-z_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "orbit-rooms-isolated-integration-test-key";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const store = await import("../src/lib/agents/room-store");
  const owner = `rooms-${randomUUID()}`;
  const stranger = `rooms-${randomUUID()}`;
  try {
    for (const id of [owner, stranger]) await db.user.create({ data: { id, email: `${id}@example.invalid` } });
    const mk = (name: string, role: string, userId = owner) => db.agent.create({ data: { userId, name, role, instructions: `${name} is the ${role}.` } });
    const [dbMira, dbScout, dbQuill, dbNova] = [await mk("Mira", "Product lead"), await mk("Scout", "Research pricing analyst"), await mk("Quill", "Engineering"), await mk("Nova", "Design")];
    const foreign = await mk("Spy", "Other account", stranger);
    const actor = { id: owner, name: "Owner" } as Parameters<typeof store.createRoomForUser>[0];

    // Membership limits and ownership at creation.
    assert.equal((await store.createRoomForUser(actor, { agentIds: [dbMira.id] })).ok, false);
    const crossAccount = await store.createRoomForUser(actor, { agentIds: [dbMira.id, foreign.id] });
    assert.equal(crossAccount.ok, false, "another account's agent cannot be added");
    const created = await store.createRoomForUser(actor, { agentIds: [dbMira.id, dbScout.id, dbQuill.id, dbNova.id], title: "Launch review" });
    assert.ok(created.ok);
    const conversationId = created.ok ? created.room.conversationId : "";
    assert.equal(created.ok && created.room.title, "Launch review");
    assert.deepEqual(created.ok && created.room.members.map((m) => m.name), ["Mira", "Scout", "Quill", "Nova"]);

    // Ownership on read: another account sees nothing.
    assert.equal(await store.loadRoomDetail(stranger, conversationId), null);
    assert.equal(await store.readRoomMembers(stranger, conversationId), null);
    assert.equal((await store.listRoomsForUser(stranger)).length, 0);
    assert.equal((await store.listRoomsForUser(owner)).length, 1);

    // A new message addressed to two members: Mira answers now, Scout waits.
    const text = "@Mira and @Scout: review onboarding pricing before launch";
    const setup = await store.prepareRoomTurn({ userId: owner, conversationId, message: text, regenerate: false, roomTurnAgentId: null });
    assert.ok(setup && !("status" in setup));
    assert.equal(setup && !("status" in setup) && setup.speaker.name, "Mira");
    const plan = setup && !("status" in setup) && setup.mode.kind === "new" ? setup.mode.plan : [];
    assert.deepEqual(plan.map((p) => p.agentId), [dbMira.id, dbScout.id]);
    const userMessage = await db.message.create({ data: { conversationId, role: "USER", content: text } });
    const firstTurnId = await store.recordRoomPlan({ userId: owner, conversationId, userMessageId: userMessage.id, plan });
    assert.ok(firstTurnId);
    // A retried request for the same message writes nothing new.
    assert.equal(await store.recordRoomPlan({ userId: owner, conversationId, userMessageId: userMessage.id, plan }), firstTurnId);
    assert.equal(await db.agentRoomTurn.count({ where: { userMessageId: userMessage.id } }), 2);

    // While Mira runs, nobody else is next, and a follow-up for Scout is refused.
    assert.equal((await store.loadRoomDetail(owner, conversationId))?.next, null);
    const early = await store.prepareRoomTurn({ userId: owner, conversationId, message: null, regenerate: true, roomTurnAgentId: dbScout.id });
    assert.ok(early && "status" in early && early.status === 409);

    // Mira answers and asks Quill; Quill is queued after Scout.
    const miraReply = await db.message.create({ data: { conversationId, role: "ASSISTANT", content: "Onboarding copy is long." } });
    await store.markRoomTurn(owner, firstTurnId!, "answered", miraReply.id);
    const members = (await store.readRoomMembers(owner, conversationId))!.members;
    const asked = await store.askRoomMember({ userId: owner, conversationId, userMessageId: userMessage.id, fromAgentId: dbMira.id, fromName: "Mira", targetAgentId: dbQuill.id, request: "check the signup code path", members });
    assert.deepEqual(asked, { ok: true, toName: "Quill", sentence: "Mira asked Quill to check the signup code path" });
    // Loop guard: Scout is already planned for this message; asking again refuses.
    assert.deepEqual(
      await store.askRoomMember({ userId: owner, conversationId, userMessageId: userMessage.id, fromAgentId: dbMira.id, fromName: "Mira", targetAgentId: dbScout.id, request: "again", members }),
      { ok: false, reason: "already_answering" }
    );
    // Cap: three turns exist; Nova cannot be added.
    assert.deepEqual(
      await store.askRoomMember({ userId: owner, conversationId, userMessageId: userMessage.id, fromAgentId: dbMira.id, fromName: "Mira", targetAgentId: dbNova.id, request: "look at visuals", members }),
      { ok: false, reason: "cap_reached" }
    );

    // The client reads next = Scout and dispatches it; two tabs racing get one turn.
    const detail = await store.loadRoomDetail(owner, conversationId);
    assert.deepEqual(detail?.next, { agentId: dbScout.id, userMessageId: userMessage.id });
    const race = await Promise.all([1, 2, 3].map(() => store.prepareRoomTurn({ userId: owner, conversationId, message: null, regenerate: true, roomTurnAgentId: dbScout.id })));
    const won = race.filter((r) => r && !("status" in r));
    assert.equal(won.length, 1, "exactly one dispatch claims Scout's turn");
    assert.ok(race.filter((r) => r && "status" in r).every((r) => r && "status" in r && r.status === 409));
    const scoutTurn = won[0] && !("status" in won[0]) && won[0].mode.kind === "follow_up" ? won[0].mode.turnId : "";
    // A reload while Scout runs: nothing to dispatch, so no duplicate responder.
    assert.equal((await store.loadRoomDetail(owner, conversationId))?.next, null);
    const scoutReply = await db.message.create({ data: { conversationId, role: "ASSISTANT", content: "Pricing page is consistent." } });
    await store.markRoomTurn(owner, scoutTurn, "answered", scoutReply.id);

    // Then Quill, with the handoff sentence visible on reload.
    const after = await store.loadRoomDetail(owner, conversationId);
    assert.deepEqual(after?.next, { agentId: dbQuill.id, userMessageId: userMessage.id });
    const quillTurn = after?.turns.find((t) => t.agentId === dbQuill.id);
    assert.equal(quillTurn?.reason, "asked");
    assert.equal(quillTurn?.handoffSentence, "Mira asked Quill to check the signup code path");
    const quillSetup = await store.prepareRoomTurn({ userId: owner, conversationId, message: null, regenerate: true, roomTurnAgentId: dbQuill.id });
    assert.ok(quillSetup && !("status" in quillSetup) && quillSetup.mode.kind === "follow_up" && quillSetup.mode.request === "check the signup code path");
    const quillReply = await db.message.create({ data: { conversationId, role: "ASSISTANT", content: "Signup path validated." } });
    await store.markRoomTurn(owner, (quillSetup as { mode: { turnId: string } }).mode.turnId, "answered", quillReply.id);

    // Done: nothing is next, every reply has a named speaker, nobody answered twice.
    const final = await store.loadRoomDetail(owner, conversationId);
    assert.equal(final?.next, null);
    const answered = final!.turns.filter((t) => t.userMessageId === userMessage.id && t.status === "answered");
    assert.deepEqual(answered.map((t) => t.agentId), [dbMira.id, dbScout.id, dbQuill.id]);
    const speakers = await store.roomSpeakers(owner, conversationId, members);
    assert.equal(speakers.get(scoutReply.id)?.name, "Scout");
    assert.equal(speakers.get(quillReply.id)?.name, "Quill");
    // Even a forged follow-up after the plan is done is refused.
    const forged = await store.prepareRoomTurn({ userId: owner, conversationId, message: null, regenerate: true, roomTurnAgentId: dbNova.id });
    assert.ok(forged && "status" in forged && forged.status === 409);
    // And a follow-up from another account reads as "not a room".
    const foreignFollowUp = await store.prepareRoomTurn({ userId: stranger, conversationId, message: null, regenerate: true, roomTurnAgentId: dbScout.id });
    assert.ok(foreignFollowUp && "status" in foreignFollowUp && foreignFollowUp.error === "not_a_room");

    // The database itself refuses a fourth position and a second turn for one agent.
    await assert.rejects(db.agentRoomTurn.create({ data: { userId: owner, conversationId, userMessageId: userMessage.id, agentId: dbNova.id, reason: "asked", position: 2 } }));
    await assert.rejects(db.agentRoomTurn.create({ data: { userId: owner, conversationId, userMessageId: userMessage.id, agentId: dbMira.id, reason: "asked", position: 9 } }));

    // A paused member is skipped: routing goes elsewhere.
    await db.agent.update({ where: { id: dbScout.id }, data: { status: "paused" } });
    const pausedSetup = await store.prepareRoomTurn({ userId: owner, conversationId, message: "@Scout pricing?", regenerate: false, roomTurnAgentId: null });
    assert.ok(pausedSetup && !("status" in pausedSetup) && pausedSetup.speaker.agentId !== dbScout.id);
  } finally {
    await db.agentRoomTurn.deleteMany({ where: { userId: { in: [owner, stranger] } } }).catch(() => {});
    await db.agentRoomMember.deleteMany({ where: { userId: { in: [owner, stranger] } } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [owner, stranger] } } }).catch(() => {});
    await db.$disconnect();
  }
});
