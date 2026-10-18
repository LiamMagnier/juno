/**
 * Run-agent faces (src/lib/agents/run-avatar.ts): the deterministic avatar for
 * every agent of a Code run, the run-state → face-state map, and the Code
 * surfaces that draw them (Agents tree, thread team lines, Best of N) in place
 * of the old dots and marks. `tests/fixtures/agent-run-avatars.json` is shared
 * with the Swift twin (JunoAgentRunAvatarTests.swift).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentFace } from "@/components/agents/agent-face";
import { FACE_MOTION_SLOTS } from "@/components/agents/face-motion-slot";
import { AgentsTreePane } from "@/components/code/v2/agents-tree";
import { CodeWorkspace } from "@/components/code/v2/workspace";
import { AGENT_EYES, AGENT_SHAPES, AGENT_TONES } from "@/lib/agents/avatar";
import { AGENT_STATES } from "@/lib/agents/domain";
import {
  ANIMATED_FACE_STATES,
  RUN_AGENT_ROLES,
  RUN_FACE_STATE,
  RUN_ROLE_LOOK,
  RUN_TONES,
  runAgentAvatar,
  runAgentAvatars,
  runAgentRole,
  runFaceState,
  subagentFaceState,
  type RunAgentInput,
} from "@/lib/agents/run-avatar";
import { AGENT_NODE_STATE_LABEL } from "@/lib/code-v2/agent-tree";
import { SHELL } from "@/lib/design/tokens.generated";
import { STATES, makeActions } from "../src/app/dev/code-v2/fixtures";

(globalThis as unknown as { React: typeof React }).React = React;

interface Fixture {
  roles: { role: string | null; phase: string | null; expected: string }[];
  states: Record<string, string>;
  runs: { name: string; agents: (RunAgentInput & { expected: unknown })[] }[];
}
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/agent-run-avatars.json", import.meta.url), "utf8")) as Fixture;

test("fixture: every run derives exactly the faces the shared fixture records", () => {
  for (const run of FIXTURE.runs) {
    const faces = runAgentAvatars(run.agents);
    for (const a of run.agents) assert.deepEqual(faces.get(a.id), a.expected, `${run.name}: ${a.id || "(empty id)"}`);
  }
});

test("fixture: provider role words read into the run vocabulary", () => {
  for (const r of FIXTURE.roles) assert.equal(runAgentRole(r.role, r.phase), r.expected, `${r.role} / ${r.phase}`);
});

test("fixture: the state map is the fixture's, covers every tree state, and lands on real face states", () => {
  assert.deepEqual(RUN_FACE_STATE, FIXTURE.states);
  assert.deepEqual(Object.keys(RUN_FACE_STATE).sort(), Object.keys(AGENT_NODE_STATE_LABEL).sort());
  for (const s of Object.values(RUN_FACE_STATE)) assert.ok((AGENT_STATES as readonly string[]).includes(s));
});

test("state: thinking, a tool, needs-you, paused, done, failed and stopped each have their look", () => {
  assert.equal(runFaceState("thinking"), "thinking");
  assert.equal(runFaceState("tool"), "working");
  assert.equal(runFaceState("waiting"), "waiting");
  assert.equal(runFaceState("paused"), "sleeping", "paused rests with its eyes closed");
  assert.equal(runFaceState("done"), "done");
  assert.equal(runFaceState("failed"), "blocked");
  assert.equal(runFaceState("stopped"), "idle", "a person's stop is not drawn as a failure");
  assert.equal(subagentFaceState("running"), "working");
  assert.equal(subagentFaceState("running", true), "sleeping");
  assert.equal(subagentFaceState("waiting"), "waiting");
  assert.equal(subagentFaceState("completed"), "done");
  assert.equal(subagentFaceState("failed"), "blocked");
  assert.equal(subagentFaceState("interrupted"), "idle");
  assert.deepEqual([...ANIMATED_FACE_STATES].sort(), ["thinking", "waiting", "working"]);
});

test("avatar: deterministic, role-aware and inside the shipped vocabulary", () => {
  for (const role of RUN_AGENT_ROLES) {
    const look = RUN_ROLE_LOOK[role];
    for (const shape of look.shapes) assert.ok(AGENT_SHAPES.includes(shape));
    for (let i = 0; i < 40; i++) {
      const a = runAgentAvatar({ id: `${role}-${i}`, role });
      assert.deepEqual(a, runAgentAvatar({ id: `${role}-${i}`, role }));
      assert.ok(look.shapes.includes(a.shape), `${role} keeps to its body family`);
      assert.equal(a.mark, look.mark);
      assert.ok(RUN_TONES.includes(a.tone) && AGENT_TONES.includes(a.tone));
      assert.ok(AGENT_EYES.includes(a.eyes));
    }
  }
  assert.ok(!RUN_TONES.includes("coral"), "no run agent defaults to coral (crew rule)");
  assert.equal(runAgentAvatar({ id: "lead", role: "orchestrator" }).mark, "ring", "the lead wears Orbit's ring");
});

test("avatar: siblings are kept apart, and a new agent never changes one already shown", () => {
  const team = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, role: "worker" }));
  const faces = runAgentAvatars(team);
  const first5 = team.slice(0, 5).map((a) => faces.get(a.id)!.tone);
  assert.equal(new Set(first5).size, 5, "distinct tones while a tone is free");
  const pairs = team.map((a) => `${faces.get(a.id)!.shape}/${faces.get(a.id)!.tone}`);
  assert.equal(new Set(pairs).size, pairs.length, "never a shape and tone together while a pair is free");
  for (let n = 1; n < team.length; n++) {
    const prefix = runAgentAvatars(team.slice(0, n));
    for (const [id, face] of prefix) assert.deepEqual(faces.get(id), face, `adding agent ${n} kept ${id}`);
  }
});

test("face: `still` keeps the pose and drops the loop; the cap is the galaxy token", () => {
  const avatar = runAgentAvatar({ id: "w1", role: "worker" });
  assert.match(renderToStaticMarkup(React.createElement(AgentFace, { avatar, state: "working", size: "xs", still: true })), /data-still=""/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(AgentFace, { avatar, state: "working", size: "xs" })), /data-still/);
  assert.equal(FACE_MOTION_SLOTS, SHELL.galaxyMaxAnimating);
});

const fixture = (id: string) => {
  const s = STATES.find((x) => x.id === id);
  assert.ok(s, id);
  return { ...s, model: { ...s.model, actions: makeActions(() => undefined) } };
};

test("tree: every row carries its agent's face, states stay in words, and no status dot remains", () => {
  const f = fixture("subagents");
  const html = renderToStaticMarkup(React.createElement(AgentsTreePane, { model: f.model, selectedId: "w2", onSelect: () => undefined, modelLabel: (s) => s.model }));
  const rows = html.match(/role="treeitem"/g)?.length ?? 0;
  // One face per row, plus the selected agent's in the detail header.
  assert.equal(html.match(/<svg[^>]*class="agent-face /g)?.length, rows + 1);
  assert.doesNotMatch(html, /cv2-adot|cv2-amark/);
  // The paused helper rests with its eyes closed; the worker mid-command works.
  assert.match(html, /data-state="paused"[\s\S]*?data-state="sleeping"/);
  assert.match(html, /aria-label="Hook audit, Paused/);
  assert.match(html, /aria-label="Worker 3, Using a tool/);
  // Faces are decoration: hidden from assistive technology, words carry the state.
  assert.doesNotMatch(html, /class="agent-face [^"]*"[^>]*role="img"/);
  // On the server nothing has a motion slot yet: every face is drawn still.
  assert.doesNotMatch(html, /<svg(?![^>]*data-still)[^>]*class="agent-face /);
});

test("workspace: the thread's team lines and Best of N's candidates show faces, not galaxies", () => {
  const sub = fixture("subagents");
  const thread = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: sub.model, ui: { ...sub.ui, dockOpen: false } }));
  assert.match(thread, /class="cv2-agentline"[\s\S]*?class="agent-face /);
  const best = fixture("best-of-n");
  const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: best.model, ui: best.ui }));
  assert.match(html, /role="radiogroup" aria-label="Candidates"[\s\S]*?class="agent-face /);
  assert.match(html, /class="cv2-sr">Done</);
});
