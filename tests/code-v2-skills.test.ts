/**
 * Skills in the Code composer (src/lib/code-v2/skills.ts): the selector's
 * order and groups, search, a typed `/name`, the activations a message is
 * sent with (account skills carry their text, local ones never do), the
 * thread's selection seeded from the env server, and the session store
 * keeping it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { LocalSkillSummary, SessionSnapshot } from "@/lib/code-v2/contracts";
import {
  buildActivations,
  choiceFromAccount,
  choiceFromLocal,
  groupSkills,
  idsFromSnapshot,
  matchSkills,
  orderSkills,
  placeholderChoice,
  readCodeSkillInvocation,
  skillsChipLabel,
} from "@/lib/code-v2/skills";
import { sessionViewFromSnapshot } from "@/lib/code-v2/session-store";

const local: LocalSkillSummary[] = [
  { name: "repo-rules", description: "The repo's rules", source: "project", origin: "alevr", path: "/p/.alevr/skills/repo-rules/SKILL.md" },
  { name: "design-taste-frontend", description: "Anti-slop frontend", source: "user", origin: "claude", path: "/h/.claude/skills/design-taste-frontend/SKILL.md" },
  { name: "impeccable", description: "Design, critique and polish", source: "plugin", origin: "claude", path: "/h/p/SKILL.md", plugin: "impeccable" },
  { name: "codex-only", description: "From Codex", source: "user", origin: "codex", path: "/h/.codex/skills/codex-only/SKILL.md" },
];
const account = choiceFromAccount({ id: "sk_1", slug: "tidy-commits", name: "Tidy commits", description: "Squash fixups", sourceLabel: null });
const choices = orderSkills([...local.map(choiceFromLocal), account]);

test("skills: Yours, then this Mac's, then the project's, each labelled with where it came from", () => {
  assert.deepEqual(
    choices.map((c) => c.name),
    ["tidy-commits", "design-taste-frontend", "impeccable", "codex-only", "repo-rules"],
  );
  assert.deepEqual(
    groupSkills(choices).map((g) => [g.title, g.skills.length]),
    [["Yours", 1], ["Installed on this Mac", 3], ["Project", 1]],
  );
  const by = Object.fromEntries(choices.map((c) => [c.name, c]));
  assert.equal(by["design-taste-frontend"]!.originLabel, "Claude Code");
  assert.equal(by["impeccable"]!.originLabel, "impeccable plugin");
  assert.equal(by["codex-only"]!.originLabel, "Codex");
  assert.equal(by["tidy-commits"]!.title, "Tidy commits");
  assert.equal(orderSkills([...choices, ...choices]).length, choices.length, "each skill once");
});

test("skills: search puts name prefixes first and reads descriptions and origins", () => {
  assert.equal(matchSkills(choices, "des")[0]!.name, "design-taste-frontend");
  assert.deepEqual(matchSkills(choices, "polish").map((c) => c.name), ["impeccable"]);
  assert.deepEqual(matchSkills(choices, "codex").map((c) => c.name), ["codex-only"]);
  assert.equal(matchSkills(choices, "").length, choices.length);
});

test("skills: a typed /name arms that skill and keeps the rest as the message; paths and commands arm nothing", () => {
  const hit = readCodeSkillInvocation("/design-taste-frontend make the hero calmer", choices);
  assert.equal(hit?.skill.name, "design-taste-frontend");
  assert.equal(hit?.remainder, "make the hero calmer");
  assert.equal(readCodeSkillInvocation("  /tidy-commits", choices)?.remainder, "");
  assert.equal(readCodeSkillInvocation("/Users/liam/notes", choices), null);
  assert.equal(readCodeSkillInvocation("/plan the work", choices), null);
  assert.equal(readCodeSkillInvocation("use /impeccable here", choices), null, "only at the start");
});

test("skills: a message's activations carry account text, never local bodies; a /name one is marked once", async () => {
  const selected = [account, choices.find((c) => c.name === "impeccable")!];
  const once = choices.find((c) => c.name === "repo-rules")!;
  const reads: string[] = [];
  const activations = await buildActivations(selected, once, async (id) => (reads.push(id), id === "sk_1" ? "TIDY BODY" : null));
  assert.deepEqual(reads, ["sk_1"]);
  assert.deepEqual(activations, [
    { name: "tidy-commits", source: "account", title: "Tidy commits", instructions: "TIDY BODY" },
    { name: "impeccable", source: "plugin", path: "/h/p/SKILL.md" },
    { name: "repo-rules", source: "project", once: true, path: "/p/.alevr/skills/repo-rules/SKILL.md" },
  ]);
  const unreadable = await buildActivations([account], null, async () => null);
  assert.deepEqual(unreadable, [], "an account skill whose text could not be read is not sent empty");
  const dup = await buildActivations([once], once, async () => null);
  assert.equal(dup.length, 1, "a selected skill armed again is sent once, for the thread");
});

test("skills: the chip names what is on", () => {
  assert.equal(skillsChipLabel([], null), "Skills");
  assert.equal(skillsChipLabel([account], null), "Tidy commits");
  assert.equal(skillsChipLabel([], choices[1]!), "/design-taste-frontend");
  assert.equal(skillsChipLabel([account], choices[1]!), "2 skills");
});

test("skills: the thread's selection comes from the env server when this browser has none", () => {
  assert.deepEqual(idsFromSnapshot([{ name: "repo-rules", source: "project" }, { name: "x", source: "user", once: true }]), ["project:repo-rules"]);
  assert.deepEqual(placeholderChoice("user:design-taste-frontend")?.name, "design-taste-frontend");
  assert.equal(placeholderChoice("account:tidy"), null, "an account skill needs its text, so no placeholder");
  const snapshot = {
    id: "s1",
    cwd: "/repo",
    selection: { instanceId: "alevr", model: "anthropic:claude-opus-5-5" },
    runtimeMode: "auto-edit",
    interactionMode: "default",
    state: "idle",
    items: [],
    queue: [],
    skills: [{ name: "repo-rules", source: "project" }],
  } satisfies SessionSnapshot;
  assert.deepEqual(sessionViewFromSnapshot(snapshot, 3).skills, [{ name: "repo-rules", source: "project" }]);
});
