import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, buildSystemPromptSections } from "@/lib/chat/system-prompt";

/*
 * The system prompt's two cache tiers. The stable head is shared by every
 * user on the same feature toggles; the variable tail is this user's memory,
 * project and style. The split is only worth having if the head really is
 * byte-identical across users and the tail really is where their data goes.
 */

const base = {
  memoryEnabled: true,
  canvas: true,
  voiceMode: false,
} as const;

test("the stable head does not change when the user's memory, project or style change", () => {
  const a = buildSystemPromptSections({
    ...base,
    userName: "Ada",
    memorySummary: "Ada is a compiler engineer.",
    memories: ["Ada prefers terse answers."],
    projectContext: "# Project Pantry\nA meal planner.",
    customInstructions: "Answer in bullet points.",
    responseLanguage: "fr",
    personality: "concise",
  });
  const b = buildSystemPromptSections({
    ...base,
    userName: "Grace",
    memorySummary: "Grace runs a bakery.",
    memories: [],
    projectContext: "",
    customInstructions: "",
    responseLanguage: "auto",
    personality: "default",
  });
  assert.equal(a.stable, b.stable);
  assert.notEqual(a.variable, b.variable);
  assert.match(a.variable, /compiler engineer/);
  assert.match(a.variable, /Pantry/);
  assert.match(a.variable, /bullet points/);
  assert.match(a.variable, /respond in fr/);
  assert.doesNotMatch(a.stable, /compiler engineer|Project Pantry|Answer in bullet points/);
});

test("the stable head moves only with feature toggles", () => {
  const on = buildSystemPromptSections({ ...base, untrustedContent: true });
  const off = buildSystemPromptSections({ ...base, untrustedContent: false });
  assert.notEqual(on.stable, off.stable);
  assert.equal(on.variable, off.variable);
});

test("the joined prompt is the head, a blank line, then the tail — and starts with the head", () => {
  const opts = { ...base, memorySummary: "Ada is a compiler engineer.", customInstructions: "Be brief." };
  const { stable, variable } = buildSystemPromptSections(opts);
  const joined = buildSystemPrompt(opts);
  assert.ok(joined.startsWith(stable));
  assert.equal(joined, `${stable}\n\n${variable}`);
  // A prompt with nothing personal has no tail and no trailing blank line.
  const bare = buildSystemPromptSections({ ...base, memoryEnabled: false });
  assert.equal(bare.variable, "");
  assert.equal(buildSystemPrompt({ ...base, memoryEnabled: false }), bare.stable);
});
