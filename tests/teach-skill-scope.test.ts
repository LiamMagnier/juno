import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_SKILL_TOOLS,
  applyChatSkill,
  narrowConnectorsForSkill,
  narrowRuntimeToolsForSkill,
  scopeTurnToSkill,
  skillDeclaresWholeSurface,
  type ChatSkillApplication,
  type ChatSkillCapabilities,
} from "@/lib/chat/skills";
import { DRAFT_SKILL_TOOL_ID, taughtProvenance } from "@/lib/skills/teach";
import { emptySkillContract, type SkillCandidate, type WorkSkillContract } from "@/lib/work/skills";
import { wrapUntrusted } from "@/lib/untrusted-content";
import { CHAT_ROUTE_PATH, turnModule } from "./chat-turn-source";

const ROOT = new URL("..", import.meta.url).pathname;
// `START_TASK_TOOL_ID` (src/lib/chat/task-tool.ts), spelled out so this file
// does not load the task tool's server half.
const START_TASK_TOOL_ID = "start_task";

/*
 * What a taught skill may use, at run time, in a chat.
 *
 * The Teach page tells the person "When you run it, Alevr uses just what's
 * listed here, and only what that chat already has on". These are the rules
 * that make the sentence true, driven through `applyChatSkill` the way the
 * chat route applies a skill the person picked:
 *
 *   - apps the skill names are the only apps the turn keeps (every skill);
 *   - a taught skill that lists anything keeps to its list: tools, apps, web
 *     search and the canvas it did not list are not used;
 *   - a taught skill that lists nothing narrows nothing (the page says so);
 *   - a skill that was not taught keeps today's rule: each kind narrows only
 *     when it names at least one of it.
 */

const TURN: ChatSkillCapabilities = {
  webSearch: true,
  canvas: true,
  documents: true,
  images: true,
  connectors: ["composio:gmail", "notion"],
  chats: true,
  time: true,
  calculate: true,
};

const CONNECTORS = [
  { id: "composio:gmail", label: "Gmail" },
  { id: "notion", label: "Notion" },
];

/** Every runtime tool id a chat turn could carry, as the narrowing reads them. */
const ALLOWLIST = [
  CHAT_SKILL_TOOLS.webSearch,
  CHAT_SKILL_TOOLS.webFetch,
  CHAT_SKILL_TOOLS.documents,
  CHAT_SKILL_TOOLS.images,
  CHAT_SKILL_TOOLS.code,
  CHAT_SKILL_TOOLS.calculate,
  START_TASK_TOOL_ID,
  "use_skill",
  "read_skill_file",
];

const candidate: SkillCandidate = {
  id: "skill_1",
  slug: "file-invoices",
  name: "File invoices",
  description: "Files the month's invoices.",
  enabled: true,
  trust: "user_authored",
  autoSelect: false,
  currentVersion: 1,
  projectId: null,
};

const TAUGHT = taughtProvenance({ source: { via: "walkthrough", conversationId: null }, now: new Date("2026-10-25T10:00:00Z") });

function apply(opts: { tools?: string[]; connectors?: string[]; taught?: boolean }): ChatSkillApplication {
  const contract: WorkSkillContract = {
    ...emptySkillContract(),
    requestedConnectors: opts.connectors ?? [],
    provenance: opts.taught ? TAUGHT : {},
  };
  const outcome = applyChatSkill({
    slug: candidate.slug,
    candidates: [candidate],
    version: {
      version: 1,
      instructions: "## Steps\n1. Open the Invoices label.",
      contract,
      requestedTools: opts.tools ?? [],
      securityStatus: "clear",
      requiresConsent: false,
    },
    capabilities: TURN,
    wrapUntrusted,
  });
  if (!outcome.applied) throw new Error(`not applied: ${outcome.reason}`);
  return outcome.application;
}

const turn = { webSearch: true, alevrSearch: true, canvas: true, connectors: CONNECTORS };
const ids = (connectors: readonly { id: string }[]) => connectors.map((c) => c.id);

test("a taught skill is marked as declaring its surface; any other skill is not", () => {
  assert.equal(apply({ taught: true, tools: ["web_search"] }).declaredSurface, true);
  assert.equal(apply({ tools: ["web_search"] }).declaredSurface, undefined);
  assert.equal(skillDeclaresWholeSurface(apply({ taught: true })), false, "a taught skill listing nothing narrows nothing");
  assert.equal(skillDeclaresWholeSurface(apply({ taught: true, connectors: ["notion"] })), true);
});

test("apps: a skill that names apps keeps only those of the turn's, taught or not", () => {
  for (const taught of [true, false]) {
    const application = apply({ taught, connectors: ["composio:gmail"] });
    assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, application)), ["composio:gmail"], `taught=${taught}`);
  }
  // Never widened: an app the turn does not have is not added by naming it.
  const asksForSlack = apply({ taught: true, connectors: ["slack"] });
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, asksForSlack)), []);
  assert.deepEqual(asksForSlack.resolved.withheld.connectors, ["slack"], "and the model is told it did not get it");
});

test("apps: a skill naming none keeps the turn's apps, unless it is taught and lists tools", () => {
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, null)), ids(CONNECTORS), "no skill");
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, apply({ tools: ["web_search"] }))), ids(CONNECTORS), "imported");
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, apply({ taught: true }))), ids(CONNECTORS), "taught, nothing listed");
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, apply({ taught: true, tools: ["web_search"] }))), [], "taught, tools only");
});

test("tools: a taught skill that lists only apps keeps no tools beyond its own skill tools", () => {
  const appsOnly = apply({ taught: true, connectors: ["composio:gmail"] });
  assert.deepEqual(narrowRuntimeToolsForSkill(ALLOWLIST, appsOnly), ["use_skill", "read_skill_file"]);
  // The native acting tools are gated by the same function.
  assert.deepEqual(narrowRuntimeToolsForSkill([START_TASK_TOOL_ID], appsOnly), []);
  assert.deepEqual(narrowRuntimeToolsForSkill([DRAFT_SKILL_TOOL_ID], appsOnly), []);
});

test("tools: listing nothing narrows nothing, for taught skills as for every other", () => {
  assert.deepEqual(narrowRuntimeToolsForSkill(ALLOWLIST, apply({ taught: true })), ALLOWLIST);
  assert.deepEqual(narrowRuntimeToolsForSkill(ALLOWLIST, apply({})), ALLOWLIST);
  // An imported skill that names only apps keeps the turn's tools (unchanged rule).
  assert.deepEqual(narrowRuntimeToolsForSkill(ALLOWLIST, apply({ connectors: ["notion"] })), ALLOWLIST);
});

test("tools: a listed tool narrows to it, as before", () => {
  assert.deepEqual(narrowRuntimeToolsForSkill(ALLOWLIST, apply({ taught: true, tools: ["calculate"] })), [
    "calculate",
    "use_skill",
    "read_skill_file",
  ]);
});

test("the turn: a taught skill keeps web search and the canvas only when it lists them", () => {
  const appsOnly = scopeTurnToSkill(apply({ taught: true, connectors: ["composio:gmail"] }), turn);
  assert.deepEqual(
    { webSearch: appsOnly.webSearch, alevrSearch: appsOnly.alevrSearch, canvas: appsOnly.canvas, connectors: ids(appsOnly.connectors) },
    { webSearch: false, alevrSearch: false, canvas: false, connectors: ["composio:gmail"] }
  );

  const searches = scopeTurnToSkill(apply({ taught: true, tools: ["web_search"] }), turn);
  assert.deepEqual(
    { webSearch: searches.webSearch, alevrSearch: searches.alevrSearch, canvas: searches.canvas, connectors: ids(searches.connectors) },
    { webSearch: true, alevrSearch: true, canvas: false, connectors: [] }
  );

  const readsPages = scopeTurnToSkill(apply({ taught: true, tools: ["web_fetch", "canvas"] }), turn);
  assert.equal(readsPages.webSearch, true, "Open web pages keeps the web, as it does for Alevr Search's tools");
  assert.equal(readsPages.canvas, true);

  // Never widened: a skill cannot switch on what the turn had off.
  const off = scopeTurnToSkill(apply({ taught: true, tools: ["web_search", "canvas"] }), {
    webSearch: false,
    alevrSearch: false,
    canvas: false,
    connectors: [],
  });
  assert.deepEqual({ ...off, connectors: ids(off.connectors) }, { webSearch: false, alevrSearch: false, canvas: false, connectors: [] });
});

test("the turn: nothing listed, no skill, or a skill that was not taught leaves web search and the canvas alone", () => {
  for (const [label, application] of [
    ["no skill", null],
    ["taught, nothing listed", apply({ taught: true })],
    ["imported, tools listed", apply({ tools: ["run_code"] })],
  ] as const) {
    const scoped = scopeTurnToSkill(application, turn);
    assert.equal(scoped.webSearch, true, label);
    assert.equal(scoped.alevrSearch, true, label);
    assert.equal(scoped.canvas, true, label);
  }
  // The imported skill still loses apps it does not name only when it names some.
  assert.deepEqual(ids(scopeTurnToSkill(apply({ tools: ["run_code"] }), turn).connectors), ids(CONNECTORS));
  assert.deepEqual(ids(scopeTurnToSkill(apply({ connectors: ["notion"] }), turn).connectors), ["notion"]);
});

test("the chat route narrows the turn once, right after the skill applies, and the private branch does too", () => {
  const route = readFileSync(join(ROOT, CHAT_ROUTE_PATH), "utf8");
  const applied = route.indexOf("const { appliedSkill } = skill;");
  const scoped = route.indexOf("scopeTurnToSkill(appliedSkill");
  assert.ok(applied > 0 && scoped > applied, "scoped after the skill is resolved");
  // The skill is granted what the turn OFFERED; everything after reads the scoped values.
  const grant = route.slice(route.indexOf("const skill = await resolveSkills("), applied);
  assert.match(grant, /connectors: offeredConnectors\.map/);
  assert.match(grant, /canvas: offeredCanvas/);
  assert.match(route.slice(scoped), /webSearch: offeredWebSearch,\s*alevrSearch: offeredAlevrSearch,\s*canvas: offeredCanvas,\s*connectors: offeredConnectors,/);
  for (const name of ["activeConnectors", "useWebSearch", "useAlevrSearch", "canvasOn"]) {
    // Property keys (`activeConnectors: offeredConnectors`) are renames, not reads.
    const before = route.slice(0, scoped).match(new RegExp(`\\b${name}\\b(?!:)`, "g"))?.length ?? 0;
    // Bound once by the scope destructure (just before the call) and never read above it.
    assert.ok(before <= 1, `${name} is not read before the skill narrows it (${before} uses above)`);
  }

  const privateBranch = turnModule("private-turn");
  assert.match(privateBranch, /const useWebSearch = scopeTurnToSkill\(privateSkillBlock/);
  assert.ok(
    privateBranch.indexOf("scopeTurnToSkill(privateSkillBlock") < privateBranch.indexOf("buildSystemPromptSections("),
    "the private prompt reads the narrowed search"
  );
});
