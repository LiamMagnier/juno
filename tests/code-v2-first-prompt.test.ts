/**
 * The /code landing's first prompt on the v2 route (src/lib/code-v2/first-prompt.ts):
 * it waits for the thread to know where it runs, waits for the skills list when
 * a `/name` or a selection needs it, goes exactly once, keeps the hand-off
 * until the run accepts it, and a cloud thread never re-sends.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createFirstPromptHandoff, firstPromptNeedsSkills, firstPromptRoute, splitFirstPrompt, type FirstPromptGate } from "@/lib/code-v2/first-prompt";
import { choiceFromLocal, type CodeSkillChoice } from "@/lib/code-v2/skills";

const repoRules = choiceFromLocal({ name: "repo-rules", description: "The repo's rules", source: "project", origin: "alevr", path: "/p/.alevr/skills/repo-rules/SKILL.md" });

const closed: FirstPromptGate = { metaLoaded: false, isCloud: false, envReady: false, envProbed: false, legacyTarget: false, skillsLoaded: false };
const envOpen: FirstPromptGate = { ...closed, metaLoaded: true, envReady: true, envProbed: true, legacyTarget: true, skillsLoaded: true };

function harness(text: string | null, accept = true) {
  const sent: { route: string; text: string }[] = [];
  const armed: CodeSkillChoice[] = [];
  let cleared = 0;
  let peeks = 0;
  const handoff = createFirstPromptHandoff({
    peek: () => {
      peeks++;
      return text;
    },
    clear: () => {
      cleared++;
    },
    arm: (s) => armed.push(s),
    send: async (route, t) => {
      sent.push({ route, text: t });
      return accept;
    },
  });
  return { handoff, sent, armed, cleared: () => cleared, peeks: () => peeks };
}

test("the route waits for the thread's kind, the probe and the skills list", () => {
  assert.equal(firstPromptRoute(closed, false), "wait");
  assert.equal(firstPromptRoute({ ...closed, metaLoaded: true }, false), "wait");
  assert.equal(firstPromptRoute({ ...closed, metaLoaded: true, isCloud: true }, false), "drop");
  assert.equal(firstPromptRoute({ ...envOpen, skillsLoaded: false }, true), "wait");
  assert.equal(firstPromptRoute({ ...envOpen, skillsLoaded: false }, false), "env");
  assert.equal(firstPromptRoute(envOpen, true), "env");
  // No env server on that Mac: the CodeTask path, once the probe has failed.
  assert.equal(firstPromptRoute({ ...closed, metaLoaded: true, legacyTarget: true }, false), "wait");
  assert.equal(firstPromptRoute({ ...closed, metaLoaded: true, envProbed: true, legacyTarget: true }, false), "legacy");
  // Mac offline: it waits.
  assert.equal(firstPromptRoute({ ...closed, metaLoaded: true, envProbed: false, legacyTarget: false }, false), "wait");
});

test("a /name or a selection needs the skills list", () => {
  assert.equal(firstPromptNeedsSkills("/repo-rules fix the build", []), true);
  assert.equal(firstPromptNeedsSkills("fix the build", ["account:abc"]), true);
  assert.equal(firstPromptNeedsSkills("fix the build", []), false);
  assert.equal(firstPromptNeedsSkills("/Users/liam is the path", []), false);
});

test("a leading /name that names a skill arms it and leaves the rest as the message", () => {
  assert.deepEqual(splitFirstPrompt("/repo-rules fix the build", [repoRules]), { text: "fix the build", once: repoRules });
  assert.deepEqual(splitFirstPrompt("/unknown fix the build", [repoRules]), { text: "/unknown fix the build", once: null });
  assert.deepEqual(splitFirstPrompt("/repo-rules", [repoRules]), { text: "/repo-rules", once: null });
});

test("the landing's prompt is sent exactly once, with its /name skill armed, and cleared once accepted", async () => {
  const h = harness("/repo-rules fix the build");
  assert.equal(h.handoff.tick(closed, [], []), null);
  assert.equal(h.handoff.tick({ ...envOpen, skillsLoaded: false }, [], []), null, "waits for the skills list");
  const first = h.handoff.tick(envOpen, [repoRules], []);
  assert.ok(first);
  assert.equal(h.handoff.tick(envOpen, [repoRules], []), null, "a second render does not send again");
  assert.equal(await first, true);
  assert.equal(h.handoff.tick(envOpen, [repoRules], []), null);
  assert.deepEqual(h.sent, [{ route: "env", text: "fix the build" }]);
  assert.deepEqual(h.armed, [repoRules]);
  assert.equal(h.cleared(), 1);
  assert.equal(h.peeks(), 1, "sessionStorage is read once");
  assert.equal(h.handoff.pending(), null);
});

test("selected skills hold the send until the list has loaded", async () => {
  const h = harness("fix the build");
  assert.equal(h.handoff.tick({ ...envOpen, skillsLoaded: false }, [], ["account:abc"]), null);
  await h.handoff.tick(envOpen, [], ["account:abc"]);
  assert.deepEqual(h.sent, [{ route: "env", text: "fix the build" }]);
});

test("the CodeTask path gets the text as typed", async () => {
  const h = harness("/repo-rules fix the build");
  await h.handoff.tick({ ...closed, metaLoaded: true, envProbed: true, legacyTarget: true }, [repoRules], []);
  assert.deepEqual(h.sent, [{ route: "legacy", text: "/repo-rules fix the build" }]);
  assert.deepEqual(h.armed, []);
});

test("a refused send keeps the hand-off for a reload, and does not retry on its own", async () => {
  const h = harness("fix the build", false);
  assert.equal(await h.handoff.tick(envOpen, [], []), false);
  assert.equal(h.cleared(), 0);
  assert.equal(h.handoff.tick(envOpen, [], []), null);
  assert.equal(h.sent.length, 1);
});

test("a cloud thread or no hand-off sends nothing", () => {
  const cloud = harness("fix the build");
  assert.equal(cloud.handoff.tick({ ...envOpen, isCloud: true }, [], []), null);
  assert.equal(cloud.handoff.tick(envOpen, [], []), null);
  assert.equal(cloud.sent.length, 0);
  const none = harness(null);
  assert.equal(none.handoff.tick(envOpen, [], []), null);
  assert.equal(none.handoff.pending(), null);
});
