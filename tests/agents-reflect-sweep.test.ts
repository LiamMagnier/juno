import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  announcedIdeaIds,
  goalCheckInDue,
  GOAL_CHECK_IN_DAILY_MS,
  GOAL_CHECK_IN_WEEKLY_MS,
  GOAL_DEADLINE_WINDOW_MS,
  ideasAnnouncement,
  parseReflection,
  REFLECTION_ANNOUNCED_IDEAS,
  reflectionUserMessage,
} from "@/lib/agents/reflection";

/*
 * Agents thinking between visits (docs/design/AGENTS.md §8).
 *
 * An unattended job spending on a person's behalf has to earn every call, and
 * one that then taps them on the shoulder has to earn that too. So this file
 * holds three things to account: which goals a reflection may check in on (the
 * cadence the person picked), what the person is told when a sweep leaves
 * ideas (titles only, once per agent, quietly), and the wiring that keeps the
 * sweep inside each account's usage windows and out of its logs. The sweep and
 * the reflection are `server-only`, so their wiring is pinned as text.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const NOW = new Date("2026-09-24T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Goal cadence
// ---------------------------------------------------------------------------

test("a goal set to no check-ins is never due, not even at its deadline", () => {
  assert.equal(goalCheckInDue({ cadence: "none", lastCheckInAt: null, dueAt: null }, NOW), false);
  assert.equal(goalCheckInDue({ cadence: "none", lastCheckInAt: ago(30 * DAY), dueAt: ahead(HOUR) }, NOW), false);
});

test("a daily goal is due after most of a day, a weekly one after most of a week", () => {
  assert.equal(goalCheckInDue({ cadence: "daily", lastCheckInAt: null, dueAt: null }, NOW), true);
  assert.equal(goalCheckInDue({ cadence: "daily", lastCheckInAt: ago(GOAL_CHECK_IN_DAILY_MS - HOUR), dueAt: null }, NOW), false);
  assert.equal(goalCheckInDue({ cadence: "daily", lastCheckInAt: ago(GOAL_CHECK_IN_DAILY_MS), dueAt: null }, NOW), true);
  // A pass a little early still counts: at a full day it would slip six hours.
  assert.equal(goalCheckInDue({ cadence: "daily", lastCheckInAt: ago(DAY - 20 * 60_000), dueAt: null }, NOW), true);

  assert.equal(goalCheckInDue({ cadence: "weekly", lastCheckInAt: null, dueAt: null }, NOW), true);
  assert.equal(goalCheckInDue({ cadence: "weekly", lastCheckInAt: ago(2 * DAY), dueAt: null }, NOW), false);
  assert.equal(goalCheckInDue({ cadence: "weekly", lastCheckInAt: ago(GOAL_CHECK_IN_WEEKLY_MS - HOUR), dueAt: null }, NOW), false);
  assert.equal(goalCheckInDue({ cadence: "weekly", lastCheckInAt: ago(GOAL_CHECK_IN_WEEKLY_MS), dueAt: null }, NOW), true);
});

test("a deadline within two days makes a goal due, whatever its last check-in", () => {
  const fresh = ago(HOUR);
  assert.equal(goalCheckInDue({ cadence: "weekly", lastCheckInAt: fresh, dueAt: ahead(DAY) }, NOW), true);
  assert.equal(goalCheckInDue({ cadence: "daily", lastCheckInAt: fresh, dueAt: ahead(GOAL_DEADLINE_WINDOW_MS) }, NOW), true);
  assert.equal(goalCheckInDue({ cadence: "weekly", lastCheckInAt: fresh, dueAt: ago(DAY) }, NOW), true);
  // Further out, or long past, the cadence decides again.
  assert.equal(goalCheckInDue({ cadence: "weekly", lastCheckInAt: fresh, dueAt: ahead(3 * DAY) }, NOW), false);
  assert.equal(goalCheckInDue({ cadence: "weekly", lastCheckInAt: fresh, dueAt: ago(3 * DAY) }, NOW), false);
});

test("an unknown cadence reads as the column's default, weekly", () => {
  assert.equal(goalCheckInDue({ cadence: "hourly", lastCheckInAt: ago(2 * DAY), dueAt: null }, NOW), false);
  assert.equal(goalCheckInDue({ cadence: "", lastCheckInAt: ago(8 * DAY), dueAt: null }, NOW), true);
});

test("a reflection only keeps check-ins on goals that are due one, and ideas may serve any goal", () => {
  const text = JSON.stringify({
    ideas: [{ title: "Outline the Q4 plan", detail: "", prompt: "Outline it", goal: 1 }],
    checkIns: [
      { goal: 0, note: "Two new drafts this week." },
      { goal: 1, note: "Nothing booked yet." },
    ],
    notes: [],
  });
  const context = { goalCount: 2, openIdeas: [], dismissedIdeas: [], knownNotes: [] };
  const due = parseReflection(text, { ...context, checkInGoals: [0] });
  assert.ok(due);
  assert.deepEqual(due.checkIns, [{ goalIndex: 0, note: "Two new drafts this week." }]);
  assert.equal(due.ideas[0].goalIndex, 1);

  assert.deepEqual(parseReflection(text, { ...context, checkInGoals: [] })?.checkIns, []);
  // Left out, every goal is due: the behaviour before cadence was read.
  assert.equal(parseReflection(text, context)?.checkIns.length, 2);
});

test("the model is shown every goal, which are due a check-in, and any deadline", () => {
  const message = reflectionUserMessage({
    agentName: "Scout",
    role: "Research",
    instructions: "",
    goals: [
      { title: "Track the EU AI Act", detail: "", lastCheckInNote: null, checkInDue: true, dueAt: "2026-09-25" },
      { title: "Learn Spanish", detail: "", lastCheckInNote: "Two lessons done.", checkInDue: false, dueAt: null },
    ],
    notes: [],
    tasks: [],
    openIdeas: [],
    dismissedIdeas: [],
    today: "2026-09-24",
  });
  assert.match(message, /^0\. Track the EU AI Act \(deadline: 2026-09-25\) \[check-in due\]$/m);
  assert.match(message, /^1\. Learn Spanish \(last check-in: Two lessons done\.\)$/m);
});

// ---------------------------------------------------------------------------
// What the person is told
// ---------------------------------------------------------------------------

test("one idea is named, several are counted, and the lock screen leads with the first", () => {
  const one = ideasAnnouncement("Quill", ["Research flight prices for October"]);
  assert.equal(one.title, "Quill has an idea");
  assert.equal(one.body, "Research flight prices for October");
  assert.equal(one.pushBody, "Has an idea: Research flight prices for October");

  const three = ideasAnnouncement("Quill", ["Research flight prices", "Outline the Q4 plan", "Draft the digest"]);
  assert.equal(three.title, "Quill has 3 ideas");
  assert.equal(three.body, "Research flight prices; Outline the Q4 plan; and 1 more");
  assert.equal(three.pushBody, "Has 3 ideas: Research flight prices, and 2 more");
  for (const copy of [one, three]) {
    assert.doesNotMatch(Object.values(copy).join(" "), /oops|!/i);
  }
});

test("the copy stays short enough for a lock screen and a payload", () => {
  const long = "Summarise ".repeat(40);
  const copy = ideasAnnouncement("An agent with a very long name that nobody would read in full at all", [long, long, long]);
  assert.ok(copy.title.length <= 80, copy.title);
  assert.ok(copy.body.length <= 280);
  assert.ok(copy.pushBody.length <= 178);
  assert.equal(ideasAnnouncement("  ", ["Outline the plan"]).title, "Your agent has an idea");
});

test("an unread announcement's ideas carry over, and junk in its JSON does not", () => {
  assert.deepEqual(announcedIdeaIds({ ideaIds: ["cmidea1", "cmidea2"] }), ["cmidea1", "cmidea2"]);
  assert.deepEqual(announcedIdeaIds({ ideaIds: ["cmidea1", 7, null, "has space", "../x", "a".repeat(65)] }), ["cmidea1"]);
  for (const junk of [null, undefined, "cmidea1", [], { ideaIds: "cmidea1" }]) assert.deepEqual(announcedIdeaIds(junk), []);
  const many = Array.from({ length: 40 }, (_, i) => `cmidea${i}`);
  assert.equal(announcedIdeaIds({ ideaIds: many }).length, REFLECTION_ANNOUNCED_IDEAS);
});

// ---------------------------------------------------------------------------
// Wiring: reflect.ts
// ---------------------------------------------------------------------------

const reflect = src("src/lib/agents/reflect.ts");
const announce = reflect.slice(reflect.indexOf("async function announceIdeas"));

test("only the sweep announces ideas; the page and the button never do", () => {
  const calls = reflect.match(/announceIdeas\(/g) ?? [];
  assert.equal(calls.length, 2, "one definition, one call");
  assert.match(reflect, /if \(options\.origin === "sweep" && ideaIds\.length > 0\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*await announceIdeas\(/);
  assert.equal((reflect.match(/notifyUser\(/g) ?? []).length, 1);
  assert.ok(reflect.indexOf("notifyUser(") > reflect.indexOf("async function announceIdeas"));

  const route = src("src/app/api/agents/[id]/reflect/route.ts");
  assert.match(route, /reflectAgent\(user, id, \{ force, origin: force \? "button" : "page" \}\)/);
});

test("an announcement is a quiet update about the agent, collapsed per agent, opening its page", () => {
  for (const pin of [
    /type: "agent_ideas"/,
    /priority: "low"/,
    /channel: "updates"/,
    /sourceType: "agent"/,
    /sourceId: agent\.id/,
    /path: agentPath\(agent\.id\)/,
    /const collapseKey = `agent-ideas:\$\{agent\.id\}`/,
    /threadId: `agent-\$\{agent\.id\}`/,
    /collapseId: `agent-ideas-\$\{agent\.id\}`/,
    /interruption: "passive"/,
    /data: \{ agentId: agent\.id \}/,
  ]) {
    assert.match(announce, pin);
  }
  // Ideas still waiting, and the person's own only: the count never includes
  // one they already started or dismissed.
  assert.match(announce, /prisma\.agentIdea\.findMany\(\{\s*where: \{ userId, agentId: agent\.id, status: "new", id: \{ in: order \} \}/);
  assert.match(announce, /prisma\.notification\.findFirst\(\{\s*where: \{ userId, readAt: null,/);
});

test("what an agent knows never rides a notification", () => {
  // Notes are sealed (field-crypto) and stay inside the account; the
  // announcement reads idea titles and nothing else.
  assert.doesNotMatch(announce, /agentNote|decryptField|knownNotes|\.detail|\.prompt/);
  assert.match(announce, /select: \{ id: true, title: true \}/);
});

test("a reflection never starts work", () => {
  for (const file of ["src/lib/agents/reflect.ts", "src/lib/agents/reflect-sweep.ts", "scripts/agent-reflector.ts"]) {
    assert.doesNotMatch(src(file), /startAgentTask|startWorkRun|createWorkSession|dispatchRun|work\/dispatch/, file);
  }
});

test("a reflection hands the parser the goals that are due a check-in", () => {
  assert.match(reflect, /goals\.flatMap\(\(goal, index\) => \(goalCheckInDue\(goal, now\) \? \[index\] : \[\]\)\)/);
  assert.match(reflect, /knownNotes,\s*checkInGoals,\s*\}\)/);
});

// ---------------------------------------------------------------------------
// Wiring: the sweep
// ---------------------------------------------------------------------------

const sweep = src("src/lib/agents/reflect-sweep.ts");
const sweepFn = sweep.slice(sweep.indexOf("export async function sweepAgentReflections"));
const finder = sweep.slice(sweep.indexOf("export async function findAgentsToReflect"), sweep.indexOf("export interface AgentSweepOutcome"));

test("the sweep checks each account's usage windows before it claims anything", () => {
  const windows = sweepFn.indexOf("checkUsageWindows(userId, await getUserPlan(userId), null, undefined, { now })");
  const reflects = sweepFn.indexOf("reflectAgent(");
  assert.ok(windows > -1 && reflects > windows, "usage windows must be checked before the reflection claims and spends");
  // Out of window is deferred, never claimed: the loop moves on before reflectAgent.
  assert.match(sweepFn, /if \(!inWindow\) \{\s*outcome\.deferred\+\+;\s*continue;\s*\}/);
  assert.match(sweepFn, /reflectAgent\(\{ id: userId \}, agentId, \{ now, origin: "sweep", llm: options\.llm \}\)/);
});

test("the sweep is bounded per tick and per account, and stops between agents on shutdown", () => {
  assert.match(sweep, /export const AGENT_SWEEP_PER_TICK = 8;/);
  assert.match(sweep, /export const AGENT_SWEEP_PER_ACCOUNT = 2;/);
  assert.match(sweep, /export const AGENT_SWEEP_INTERVAL_MS = 10 \* 60_000;/);
  assert.match(sweepFn, /if \(attempted >= limit \|\| options\.shouldStop\?\.\(\)\) break;/);
  assert.match(finder, /WHERE ranked\."place" <= \$\{AGENT_SWEEP_PER_ACCOUNT\}/);
});

test("only proactive, active agents of present people, with something to think about, are offered", () => {
  for (const clause of [
    /a\."deletedAt" IS NULL/,
    /a\."status" = 'active'/,
    /a\."proactive" = true/,
    /a\."lastReflectedAt" IS NULL OR a\."lastReflectedAt" < \$\{dueBefore\}/,
    /u\."bannedAt" IS NULL/,
    /c\."userId" = a\."userId" AND c\."lastMessageAt" > \$\{activeSince\}/,
    /g\."agentId" = a\."id" AND g\."status" = 'active'/,
    /w\."userId" = a\."userId" AND w\."agentId" = a\."id" AND w\."deletedAt" IS NULL/,
    /ORDER BY ranked\."lastReflectedAt" ASC NULLS FIRST/,
  ]) {
    assert.match(finder, clause);
  }
  assert.match(finder, /new Date\(now\.getTime\(\) - AGENT_REFLECT_INTERVAL_MS\)/);
  // The one cross-account read; everything after it is reflectAgent's guarded client.
  assert.equal((sweep.match(/prismaUnguarded\./g) ?? []).length, 1);
  assert.match(finder, /prismaUnguarded\.\$queryRaw/);
});

// ---------------------------------------------------------------------------
// Wiring: the worker
// ---------------------------------------------------------------------------

const worker = src("scripts/agent-reflector.ts");

test("the worker logs counts and ids, never what an agent thought", () => {
  const files = { "scripts/agent-reflector.ts": worker, "src/lib/agents/reflect-sweep.ts": sweep, "src/lib/agents/reflect.ts": reflect };
  for (const [file, body] of Object.entries(files)) {
    const logs = body.match(/console\.(log|error|warn|info)\([\s\S]*?\);/g) ?? [];
    for (const line of logs) {
      for (const leak of ["title", "Title", "content", "detail", "prompt", "note", "Note", "goal", "name", "body"]) {
        assert.equal(line.includes(leak), false, `a log line in ${file} mentions ${leak}: ${line}`);
      }
    }
  }
  assert.match(worker, /console\.log\(\s*`\[agent-reflector\] considered=\$\{outcome\.considered\} reflected=/);
});

test("the worker ticks one at a time, waits a little before the first, and stops cleanly", () => {
  assert.match(worker, /inFlight \?\?= sweep\(\)/);
  assert.match(worker, /setTimeout\(\(\) => void tick\(\), AGENT_SWEEP_FIRST_TICK_MS\)/);
  assert.match(worker, /setInterval\(\(\) => void tick\(\), AGENT_SWEEP_INTERVAL_MS\)/);
  assert.match(worker, /process\.once\("SIGTERM"/);
  assert.match(worker, /process\.once\("SIGINT"/);
  assert.match(worker, /process\.argv\.includes\("--once"\)/);
  assert.match(worker, /if \(!ok\) process\.exitCode = 1;/);
  assert.match(worker, /shouldStop: \(\) => stopping/);
});

test("the worker is deployed and runnable by name", () => {
  const ecosystem = src("deploy/ecosystem.config.js");
  // It runs inside juno-sweepers (scripts/sweepers.ts), one process for the
  // small loops.
  assert.match(ecosystem, /name: "juno-sweepers"/);
  assert.match(src("scripts/sweepers.ts"), /import "\.\/agent-reflector";/);
  const { apps } = createRequire(import.meta.url)("../deploy/ecosystem.config.js") as {
    apps: { name: string; script?: string }[];
  };
  assert.match(apps.find((app) => app.name === "juno-sweepers")?.script ?? "", /scripts\/sweepers\.ts$/);
  const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> };
  // react-server, so the `server-only` modules it reaches load.
  assert.equal(pkg.scripts["agents:reflector"], "NODE_OPTIONS=--conditions=react-server tsx scripts/agent-reflector.ts");
});
