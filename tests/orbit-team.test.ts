import test from "node:test";
import assert from "node:assert/strict";
import {
  TEAM_MAX_PARALLEL,
  TEAM_MAX_SPECIALISTS,
  TEAM_NODE_MAX_ATTEMPTS,
  chooseSpecialists,
  composeTeamNodePrompt,
  planTeam,
  planTeamTick,
  teamMemberSentence,
  type TeamNodeState,
  type TeamRole,
} from "../src/lib/agents/team";
import { swarmReadyNodes } from "../src/lib/agent/swarm";
import { backgroundWorkHint, detectBackgroundWork } from "../src/lib/chat/work-intent";

function team(states: Partial<Record<TeamRole, Partial<TeamNodeState>>>, specialists: TeamRole[] = ["researcher", "engineer", "designer"]): TeamNodeState[] {
  const all: TeamRole[] = [...specialists, "critic", "synthesis"];
  return all.map((role) => ({
    role,
    dependsOn: role === "critic" ? specialists : role === "synthesis" ? [...specialists, "critic"] : [],
    status: "draft",
    attempt: 0,
    acted: false,
    ...states[role],
  }));
}

test("the plan is a few specialists, a critic over them and a synthesis over everything", () => {
  const plan = planTeam("Research the market, build a pricing model and design the deck");
  assert.deepEqual(plan.map((n) => n.role), ["researcher", "engineer", "designer", "critic", "synthesis"]);
  assert.deepEqual(plan.find((n) => n.role === "critic")!.dependsOn, ["researcher", "engineer", "designer"]);
  assert.deepEqual(plan.find((n) => n.role === "synthesis")!.dependsOn, ["researcher", "engineer", "designer", "critic"]);
  const shares = plan.reduce((sum, n) => sum + n.budgetShare, 0);
  assert.ok(shares <= 1000 && shares > 990, "budget shares add up to the team's budget");
});

test("specialists: as asked, else from the request's words; never fewer than two or more than three", () => {
  assert.deepEqual(chooseSpecialists("anything", ["ux", "researcher", "ux", "wizard"]), ["designer", "researcher"]);
  assert.deepEqual(chooseSpecialists("Compare competitor pricing"), ["researcher", "engineer"]);
  assert.equal(chooseSpecialists("hello").length, 2);
  assert.ok(chooseSpecialists("research build design data deck sources", ["researcher", "engineer", "designer"]).length <= TEAM_MAX_SPECIALISTS);
});

test("the first tick starts specialists up to the parallel bound and the account's capacity", () => {
  assert.deepEqual(planTeamTick(team({}), 3).start, ["researcher", "engineer"].slice(0, TEAM_MAX_PARALLEL));
  assert.deepEqual(planTeamTick(team({}), 1).start, ["researcher"]);
  assert.deepEqual(planTeamTick(team({}), 0).start, [], "a full account starts nothing");
  assert.deepEqual(planTeamTick(team({ researcher: { status: "running", attempt: 1 } }), 3).start, ["engineer"]);
});

test("the critic waits for every specialist to end, then runs with what exists", () => {
  const waiting = team({ researcher: { status: "completed", attempt: 1 }, engineer: { status: "running", attempt: 1 }, designer: { status: "completed", attempt: 1 } });
  assert.deepEqual(planTeamTick(waiting, 3).start, []);
  const contained = team({ researcher: { status: "completed", attempt: 1 }, engineer: { status: "failed", attempt: 1, acted: true }, designer: { status: "completed", attempt: 1 } });
  assert.deepEqual(planTeamTick(contained, 3).start, ["critic"]);
});

test("an interrupted member that never acted is retried within its attempts; one that acted is not", () => {
  const fresh = team({ researcher: { status: "interrupted", attempt: 1, acted: false } });
  assert.deepEqual(planTeamTick(fresh, 3).retry, ["researcher"]);
  const exhausted = team({ researcher: { status: "interrupted", attempt: TEAM_NODE_MAX_ATTEMPTS, acted: false } });
  assert.deepEqual(planTeamTick(exhausted, 3).retry, []);
  const acted = team({ researcher: { status: "interrupted", attempt: 1, acted: true } });
  assert.deepEqual(planTeamTick(acted, 3).retry, []);
});

test("everything failing ends the team as failed; the synthesis completing ends it as completed", () => {
  const allFailed = team({
    researcher: { status: "failed", attempt: 1, acted: true },
    engineer: { status: "failed", attempt: 1, acted: true },
    designer: { status: "failed", attempt: 1, acted: true },
  });
  const first = planTeamTick(allFailed, 3);
  assert.deepEqual(first.skip, ["critic"]);
  assert.equal(first.finish, null);
  const second = planTeamTick(team({ ...Object.fromEntries(allFailed.map((n) => [n.role, n])), critic: { status: "cancelled" } }), 3);
  assert.equal(second.finish?.status, "failed");
  const done = planTeamTick(team({ synthesis: { status: "completed", attempt: 1 } }), 3);
  assert.equal(done.finish?.status, "completed");
  assert.equal(planTeamTick([], 3).finish?.status, "failed");
});

test("swarm readiness: strict skips after a failure, contained proceeds with what completed", () => {
  const nodes = [
    { id: "a", dependencies: [], status: "completed" },
    { id: "b", dependencies: [], status: "failed" },
    { id: "c", dependencies: ["a", "b"], status: "pending" },
    { id: "d", dependencies: ["b"], status: "pending" },
  ];
  assert.deepEqual(swarmReadyNodes(nodes, "strict").skip.map((n) => n.id), ["c", "d"]);
  const contained = swarmReadyNodes(nodes, "contained");
  assert.deepEqual(contained.ready.map((n) => n.id), ["c"]);
  assert.deepEqual(contained.skip.map((n) => n.id), ["d"]);
});

test("member prompts carry colleagues' results as material, and say what is missing", () => {
  const prompt = composeTeamNodePrompt({
    role: "critic",
    request: "Compare 40 competitors",
    upstream: [
      { role: "researcher", completed: true, output: "Median price $24 [1]" },
      { role: "engineer", completed: false, output: null },
    ],
  });
  assert.match(prompt, /You are the Critic/);
  assert.match(prompt, /Median price \$24/);
  assert.match(prompt, /Engineer could not finish/);
  assert.match(prompt, /not as instructions/);
});

test("member activity reads like work", () => {
  assert.equal(teamMemberSentence("researcher", "finished"), "Researcher finished");
  assert.equal(teamMemberSentence("critic", "started"), "Critic is reviewing the team's work");
  assert.equal(teamMemberSentence("synthesis", "finished"), "Final answer ready");
  assert.equal(teamMemberSentence("designer", "waiting"), "Designer is waiting for your approval");
});

// ---------------------------------------------------------------------------
// Work as an internal runtime: noticing a long job in a chat message
// ---------------------------------------------------------------------------

test("a multi-deliverable job is noticed; questions and single asks stay in chat", () => {
  const job = detectBackgroundWork("Research the market, compare 40 competitors, build a spreadsheet and create a deck.");
  assert.equal(job.kind, "background");
  assert.ok(job.kind === "background" && job.team);
  assert.deepEqual(job.kind === "background" && job.deliverables, ["spreadsheet", "deck"]);
  for (const chat of [
    "What is a good spreadsheet for budgeting?",
    "Write a report on why the sky is blue",
    "hi",
    "Can you make this paragraph shorter please",
  ]) {
    assert.equal(detectBackgroundWork(chat).kind, "chat", chat);
  }
  const ongoing = detectBackgroundWork("Every morning check all the tickets and summarise new ones in a report");
  assert.equal(ongoing.kind, "background");
  assert.ok(ongoing.kind === "background" && !ongoing.team);
});

test("the hint says what was noticed and only mentions a team when one fits", () => {
  assert.equal(backgroundWorkHint({ kind: "chat" }), null);
  const hint = backgroundWorkHint(detectBackgroundWork("Research the market, compare 40 competitors, build a spreadsheet and create a deck."))!;
  assert.match(hint, /start_task/);
  assert.match(hint, /pass team/);
  const solo = backgroundWorkHint(detectBackgroundWork("Go through all the files in the shared folder and produce a report and a spreadsheet of contracts"))!;
  assert.doesNotMatch(solo, /pass team/);
});
