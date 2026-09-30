import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGENT_EYES, AGENT_MARKS, AGENT_SHAPES, AGENT_TONES, defaultAgentAvatar } from "@/lib/agents/avatar";
import { AGENT_STATES } from "@/lib/agents/domain";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";

/*
 * The agent face and the hiring starting points exist twice: in TypeScript for
 * the web, and in Swift for the Mac and the iPhone (JunoAgentFace.swift,
 * NativeAgentModels.swift). A face the server stores as `{shape: "petal"}` has
 * to be a face every client can draw, and a starting point added on the web
 * and not on the phone is a hire the phone cannot offer.
 *
 * This reads the Swift source rather than generating it, which is the same
 * trade `tests/native-work-contract.test.ts` makes: the Swift enums carry
 * labels, colours and geometry that a generator would flatten, and a test
 * that fails with the exact difference is enough to keep two hand-written
 * lists honest.
 */

const FACE = readFileSync(
  new URL("../native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoAgentFace.swift", import.meta.url),
  "utf8"
);
const MODELS = readFileSync(
  new URL("../native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/NativeAgentModels.swift", import.meta.url),
  "utf8"
);

/** The cases of `public enum <name>`, in declaration order, from `case a, b, c` lines. */
function swiftCases(source: string, name: string): string[] {
  const start = source.indexOf(`public enum ${name}`);
  assert.ok(start >= 0, `${name} is not declared in the Swift source`);
  const body = source.slice(start, source.indexOf("\n}", start));
  const cases: string[] = [];
  for (const match of body.matchAll(/^\s{4}case ([a-z][\w, ]*)$/gm)) {
    cases.push(...match[1].split(",").map((part) => part.trim()).filter(Boolean));
  }
  return cases;
}

test("the Swift face vocabulary is the web's, in the same order", () => {
  assert.deepEqual(swiftCases(FACE, "JunoAgentShape"), [...AGENT_SHAPES]);
  assert.deepEqual(swiftCases(FACE, "JunoAgentTone"), [...AGENT_TONES]);
  assert.deepEqual(swiftCases(FACE, "JunoAgentEyes"), [...AGENT_EYES]);
  assert.deepEqual(swiftCases(FACE, "JunoAgentMark"), [...AGENT_MARKS]);
  assert.deepEqual(swiftCases(FACE, "JunoAgentState"), [...AGENT_STATES]);
});

test("every tone has its generated colour on both clients", () => {
  const generated = readFileSync(
    new URL("../native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Generated/JunoGeneratedTokens.swift", import.meta.url),
    "utf8"
  );
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  for (const tone of AGENT_TONES) {
    const swiftName = `agent${tone[0].toUpperCase()}${tone.slice(1)}`;
    assert.match(generated, new RegExp(`public static let ${swiftName} = `), `${swiftName} is not generated`);
    assert.match(css, new RegExp(`--agent-${tone}:`), `--agent-${tone} is not declared`);
  }
  assert.match(generated, /public static let agentInk = /);
  assert.match(generated, /public static let agentMark = /);
});

test("the seeded default is the same algorithm on both clients", () => {
  // The Swift port is FNV-1a over UTF-16 code units with the same three
  // divisors; these are the constants it must carry for the faces to agree.
  // Swift allows `_` inside a literal, so the constants are read without it.
  const digits = FACE.replace(/(0x[0-9a-f_]+)/gi, (literal) => literal.replace(/_/g, "").toLowerCase());
  assert.match(digits, /0x811c9dc5|2166136261/);
  assert.match(digits, /0x01000193|0x1000193|16777619/);
  assert.match(FACE, /\/ 7\b/);
  assert.match(FACE, /\/ 53\b/);
  // And the TypeScript side is stable for the seeds the Swift test pins.
  assert.deepEqual(defaultAgentAvatar("agent_1"), defaultAgentAvatar("agent_1"));
});

test("every hiring starting point exists on the phone and the Mac, with the same face and autonomy", () => {
  for (const template of AGENT_TEMPLATES) {
    const at = MODELS.indexOf(`id: "${template.id}"`);
    assert.ok(at >= 0, `the Swift templates are missing ${template.id}`);
    const entry = MODELS.slice(at, MODELS.indexOf("NativeAgentTemplate(", at) > 0 ? MODELS.indexOf("NativeAgentTemplate(", at) : at + 2_000);
    assert.ok(entry.includes(`label: "${template.label}"`), `${template.id}: label differs`);
    assert.ok(entry.includes(`approvalMode: .${template.approvalMode}`), `${template.id}: autonomy differs`);
    assert.ok(entry.includes(`style: .${template.style}`), `${template.id}: style differs`);
    const { shape, tone, eyes, mark } = template.avatar;
    assert.ok(
      entry.includes(`JunoAgentAvatar(shape: .${shape}, tone: .${tone}, eyes: .${eyes}, mark: .${mark})`) ||
        entry.includes(`JunoAgentAvatar(shape: .${shape}, tone: .${tone}, eyes: .${eyes}, mark: JunoAgentMark.${mark})`),
      `${template.id}: face differs`
    );
  }
  const swiftIds = [...MODELS.matchAll(/^\s+id: "([a-z-]+)",$/gm)].map((match) => match[1]);
  assert.deepEqual(swiftIds, AGENT_TEMPLATES.map((template) => template.id));
});

test("the native client names only routes the server has", () => {
  const client = readFileSync(
    new URL("../native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/NativeAgentsClient.swift", import.meta.url),
    "utf8"
  );
  const routes = new Set([
    "/api/agents",
    "/api/agents/{id}",
    "/api/agents/{id}/starter",
    "/api/agents/{id}/duplicate",
    "/api/agents/{id}/thread",
    "/api/agents/{id}/goals",
    "/api/agents/{id}/goals/{id}",
    "/api/agents/{id}/notes",
    "/api/agents/{id}/notes/{id}",
    "/api/agents/{id}/ideas/{id}",
    "/api/agents/{id}/routines",
    "/api/agents/{id}/activity",
    "/api/agents/{id}/reflect",
    "/api/agents/{id}/tasks",
    "/api/agents/{id}/computer",
    "/api/agents/{id}/computer/view",
    "/api/agents/{id}/computer/heartbeat",
    "/api/agents/{id}/computer/poster",
  ]);
  const used = [...client.matchAll(/"(\/api\/agents[^"]*)"/g)].map((match) =>
    match[1].replace(/\\\([^)]*\)/g, "{id}")
  );
  assert.ok(used.length > 5, "expected the client to name the agents routes");
  for (const path of used) assert.ok(routes.has(path), `the native client calls ${path}, which the server does not serve`);
});
