import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_SKILL_TOOLS,
  SKILL_WITHHELD_RESEARCH,
  applyChatSkill,
  narrowConnectorsForSkill,
  narrowRuntimeToolsForSkill,
  scopeTurnToSkill,
  skillDeclaresWholeSurface,
  skillKeepsUnlistedSurfaces,
  type ChatSkillApplication,
  type ChatSkillCapabilities,
} from "@/lib/chat/skills";
import { chatAgentConfigToolsEnabled } from "@/lib/chat/agent-config-tools";
import { localFolderToolsEnabled } from "@/lib/chat/local-folder";
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
 *   - a taught skill that lists anything keeps to its list: tools, apps, web
 *     search and the canvas it did not list are not used;
 *   - a skill that was not taught keeps the turn's apps whatever it names: a
 *     contract written before Teach holds bare ids (`gmail`) that match none
 *     of the turn's namespaced ones (`composio:gmail`);
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

test("apps: a taught skill that names apps keeps only those of the turn's", () => {
  const application = apply({ taught: true, connectors: ["composio:gmail"] });
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, application)), ["composio:gmail"]);
  assert.deepEqual(ids(scopeTurnToSkill(application, turn).connectors), ["composio:gmail"]);
  // Never widened: an app the turn does not have is not added by naming it.
  const asksForSlack = apply({ taught: true, connectors: ["slack"] });
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, asksForSlack)), []);
  assert.deepEqual(asksForSlack.resolved.withheld.connectors, ["slack"], "and the model is told it did not get it");
});

test("apps: a skill that was not taught keeps the turn's apps, whatever its contract names", () => {
  // A contract written before Teach could hold only bare ids. Narrowing on
  // `gmail` against the turn's `composio:gmail` would match nothing and strip
  // every app, including one the person @-mentioned.
  const legacy = apply({ connectors: ["gmail"] });
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, legacy)), ids(CONNECTORS), "bare id");
  assert.deepEqual(ids(scopeTurnToSkill(legacy, turn).connectors), ids(CONNECTORS), "bare id, whole turn");
  assert.deepEqual(legacy.resolved.withheld.connectors, ["gmail"], "the unmatched name is still reported as withheld");
  // A namespaced id written through the Work skills API narrows nothing either.
  const named = apply({ connectors: ["composio:gmail"] });
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, named)), ids(CONNECTORS), "namespaced id");
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

test("an application that carries only tool lists still narrows tools, and leaves apps alone", () => {
  // The shape tests/tool-aliases.test.ts builds by hand: no connector lists at
  // all. Reading apps must not throw on it, and the tool rule is the old one.
  const toolsOnly = {
    resolved: { tools: ["browser_agent"], withheld: { tools: ["code_interpreter"] } },
  } as unknown as ChatSkillApplication;
  assert.deepEqual(narrowRuntimeToolsForSkill(["read_document", "run_code", "web_fetch"], toolsOnly), ["run_code", "web_fetch"]);
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, toolsOnly)), ids(CONNECTORS));
  assert.equal(skillDeclaresWholeSurface(toolsOnly), false);
  assert.deepEqual(ids(scopeTurnToSkill(toolsOnly, turn).connectors), ids(CONNECTORS));
  const taughtToolsOnly = { ...toolsOnly, declaredSurface: true } as ChatSkillApplication;
  assert.equal(skillDeclaresWholeSurface(taughtToolsOnly), true);
  assert.deepEqual(ids(narrowConnectorsForSkill(CONNECTORS, taughtToolsOnly)), [], "taught, tools only: no apps");
  const noLists = { resolved: {} } as unknown as ChatSkillApplication;
  assert.deepEqual(narrowRuntimeToolsForSkill(ALLOWLIST, noLists), ALLOWLIST, "nothing listed narrows nothing");
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
  assert.deepEqual(
    { ...off, connectors: ids(off.connectors) },
    { webSearch: false, alevrSearch: false, research: false, canvas: false, connectors: [] }
  );
});

test("the turn: deep research stays only for a taught skill that lists web search or page reading", () => {
  const researching = { ...turn, webSearch: false, alevrSearch: false, research: true };
  assert.equal(scopeTurnToSkill(apply({ taught: true, connectors: ["composio:gmail"] }), researching).research, false, "apps only");
  assert.equal(scopeTurnToSkill(apply({ taught: true, tools: ["canvas"] }), researching).research, false, "canvas only");
  assert.equal(scopeTurnToSkill(apply({ taught: true, tools: ["web_search"] }), researching).research, true);
  assert.equal(scopeTurnToSkill(apply({ taught: true, tools: ["web_fetch"] }), researching).research, true);
  // Unchanged for everything else, and never widened.
  for (const [label, application] of [
    ["no skill", null],
    ["taught, nothing listed", apply({ taught: true })],
    ["imported, tools listed", apply({ tools: ["run_code"] })],
  ] as const) {
    assert.equal(scopeTurnToSkill(application, researching).research, true, label);
  }
  assert.equal(scopeTurnToSkill(apply({ taught: true, tools: ["web_search"] }), { ...researching, research: false }).research, false);
  assert.equal(scopeTurnToSkill(null, turn).research, false, "a caller that passes no research has none");
});

test("research withheld by a skill answers with a notice that names the skill, not the plan", () => {
  assert.match(SKILL_WITHHELD_RESEARCH.notice, /skill you picked uses only what it lists/);
  assert.match(SKILL_WITHHELD_RESEARCH.notice, /Search the web/);
  assert.doesNotMatch(SKILL_WITHHELD_RESEARCH.notice, /plan|configured/);
  const stage = turnModule("research-stage");
  const withheld = stage.indexOf("researchRequested && researchWithheldBySkill");
  const generic = stage.indexOf("} else if (researchRequested) {");
  assert.ok(withheld > 0 && withheld < generic, "checked before the plan/deployment notice");
  assert.match(stage.slice(withheld, generic), /researchNotice = SKILL_WITHHELD_RESEARCH\.notice/);
  const runTurn = turnModule("run-turn");
  assert.match(runTurn, /researchWithheldBySkill,\s*\/\/ SPEC/);
});

test("what no skill can list: kept for every skill except a taught one that lists anything", () => {
  assert.equal(skillKeepsUnlistedSurfaces(null), true, "no skill");
  assert.equal(skillKeepsUnlistedSurfaces(apply({ tools: ["web_search"] })), true, "imported, tools listed");
  assert.equal(skillKeepsUnlistedSurfaces(apply({ connectors: ["notion"] })), true, "imported, apps listed");
  assert.equal(skillKeepsUnlistedSurfaces(apply({ taught: true })), true, "taught, nothing listed");
  assert.equal(skillKeepsUnlistedSurfaces(apply({ taught: true, tools: ["calculate"] })), false, "taught, a tool listed");
  assert.equal(skillKeepsUnlistedSurfaces(apply({ taught: true, connectors: ["notion"] })), false, "taught, an app listed");

  // The gates those surfaces ride really close on it.
  const openGate = {
    privateMode: false,
    voiceMode: false,
    regenerate: false,
    userMessageId: "msg_1",
    researchActive: false,
    artifactEdit: false,
    conversationKind: "chat",
    agenticTools: true,
    functionToolsReachModel: true,
    lockdown: false,
  };
  assert.equal(chatAgentConfigToolsEnabled({ ...openGate, skillPermits: true }), true);
  assert.equal(chatAgentConfigToolsEnabled({ ...openGate, skillPermits: false }), false);
  const folderGate = {
    clientDeclares: true,
    folder: { name: "Invoices", access: "read" },
    privateMode: false,
    voiceMode: false,
    lockdown: false,
    functionToolsReachModel: true,
    agenticTools: true,
    conversationKind: "chat",
    artifactEdit: false,
    researchActive: false,
  } as unknown as Parameters<typeof localFolderToolsEnabled>[0];
  assert.equal(localFolderToolsEnabled({ ...folderGate, skillPermits: true }), true);
  assert.equal(localFolderToolsEnabled({ ...folderGate, skillPermits: false }), false);
});

test("the turn wires what no skill can list to the taught scope, tool and prompt together", () => {
  const approvals = turnModule("approvals");
  const agentGate = approvals.slice(approvals.indexOf("const agentConfigToolsOn = chatAgentConfigToolsEnabled({"));
  assert.match(agentGate.slice(0, 200), /skillPermits: skillKeepsUnlistedSurfaces\(appliedSkill\)/);
  const folderGate = approvals.slice(approvals.indexOf("const localFolderOn = localFolderToolsEnabled({"));
  assert.match(folderGate.slice(0, 700), /skillPermits: skillKeepsUnlistedSurfaces\(appliedSkill\)/);
  assert.doesNotMatch(approvals, /skillPermits: true/, "no acting surface is exempt from an applied skill any more");
  assert.doesNotMatch(approvals, /as a connector is/, "connectors are narrowed by a skill now; the old rationale is gone");

  // A room member's ask_room_member: the tool and the prompt's invitation read the same answer.
  const tools = turnModule("tools");
  assert.match(tools, /roomMayAsk\(roomSetup, roomMessageId, skillKeepsUnlistedSurfaces\(appliedSkill\)\)/);
  const prompt = turnModule("prompt");
  assert.match(prompt, /roomPromptBlock\(\s*roomSetup,\s*user\.name,\s*roomMessageId,\s*skillKeepsUnlistedSurfaces\(appliedSkill\)\s*\)/);
  const identity = turnModule("identity");
  assert.match(identity, /skillPermits &&\s*!!roomMessageId/);
  assert.match(identity, /canAsk: roomMayAsk\(setup, roomMessageId, skillPermits\)/);

  // Cross-conversation: decided once, so the tools and their prompt section go together.
  const route = readFileSync(join(ROOT, CHAT_ROUTE_PATH), "utf8");
  const cross = route.slice(route.indexOf("resolveCrossConversation({"));
  assert.match(cross.slice(0, 400), /skillPermits: skillKeepsUnlistedSurfaces\(appliedSkill\)/);
  assert.match(turnModule("cross"), /input\.skillPermits !== false && \(await chatConversationEnabled/);
});

test("the turn: nothing listed, no skill, or a skill that was not taught leaves web search, the canvas and apps alone", () => {
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
  // A skill that was not taught keeps the turn's apps, whether it names some or not.
  assert.deepEqual(ids(scopeTurnToSkill(apply({ tools: ["run_code"] }), turn).connectors), ids(CONNECTORS));
  assert.deepEqual(ids(scopeTurnToSkill(apply({ connectors: ["notion"] }), turn).connectors), ids(CONNECTORS));
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
  assert.match(
    route.slice(scoped),
    /webSearch: offeredWebSearch,\s*alevrSearch: offeredAlevrSearch,\s*research: offeredResearch,\s*canvas: offeredCanvas,\s*connectors: offeredConnectors,/
  );
  assert.match(route, /researchActive: offeredResearch,/, "the capability is renamed, so only the scoped value is researchActive");
  assert.match(route, /research: researchActive,\s*canvas: canvasOn,/);
  assert.match(route, /researchWithheldBySkill: offeredResearch && !researchActive/);
  for (const name of ["activeConnectors", "useWebSearch", "useAlevrSearch", "canvasOn", "researchActive"]) {
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
