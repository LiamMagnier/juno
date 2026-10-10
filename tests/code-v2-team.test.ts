import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_ROLE_VALUES,
  ROLE_PRESET_VALUES,
  TEAM_PHASE_VALUES,
  type ModelSelection,
  type RoleRouting,
} from "@/lib/code-v2/contracts";
import {
  TEAM_ROLE_SLOT,
  adoptTeam,
  loadTeam,
  saveTeam,
  shortModelName,
  teamPhaseOf,
  teamPresetOf,
  teamRoleSelection,
  teamSize,
  teamSummary,
  withBudget,
  withBuilderCount,
  withTeamEffort,
  withTeamPreset,
  withTeamRole,
  type TeamStorage,
} from "@/lib/code-v2/team";
import { estimateRunUsd, orchestrateLabel } from "@/lib/code-v2/orchestrate";
import { catalogModel } from "@/lib/code-v2/code-models";
import { routingSelections, validateRoleRouting } from "@/lib/code-v2/role-routing";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const lead: ModelSelection = { instanceId: "alevr", model: "anthropic:claude-sonnet-5-5", effort: "medium" };
const opus: ModelSelection = { instanceId: "alevr", model: "anthropic:claude-opus-5-5", effort: "high" };
const gpt: ModelSelection = { instanceId: "codex:default", model: "gpt-6.1-sol", effort: "high" };
const solo: RoleRouting = { preset: "solo", orchestrator: lead };

test("the contract carries the architect role, the team preset and the three phases, additively", () => {
  assert.deepEqual([...ROLE_PRESET_VALUES], ["solo", "lead-workers", "best-of-n", "plan-build-verify"]);
  assert.deepEqual([...AGENT_ROLE_VALUES].slice(0, 5), ["orchestrator", "worker", "reviewer", "explorer", "compaction"], "existing roles keep their order");
  assert.equal(AGENT_ROLE_VALUES.at(-1), "architect");
  assert.deepEqual([...TEAM_PHASE_VALUES], ["plan", "build", "verify"]);
});

test("every copy of the contract is the same file (drift check)", () => {
  const source = read("src/lib/code-v2/contracts.ts");
  assert.equal(read("runner/agent-core/src/contracts/code-v2.ts"), source);
  assert.equal(read("runner/env-server/src/contracts/code-v2.ts"), source);
  const schema = JSON.parse(read("contracts/code/alevr-code-v2.schema.json")) as {
    definitions: Record<string, { enum?: string[]; properties?: Record<string, unknown> }>;
  };
  assert.ok(schema.definitions.RoleRouting!.properties!.architect, "the schema knows the Architect");
  assert.deepEqual(schema.definitions.TeamPhase!.enum, [...TEAM_PHASE_VALUES]);
  assert.ok(schema.definitions.AgentRole!.enum!.includes("architect"));
  const swift = read("native/Packages/JunoCode/Sources/JunoCodeCore/CodeV2Contracts.swift");
  assert.match(swift, /public var architect: ModelSelection\?/);
  assert.match(swift, /case planBuildVerify = "plan-build-verify"/);
  assert.match(swift, /public var phase: TeamPhase\?/);
});

test("roles map onto RoleRouting: Architect → architect, Builder → workers, Verifier → reviewer, Explorer → explorer", () => {
  assert.deepEqual(TEAM_ROLE_SLOT, { architect: "architect", builder: "workers", verifier: "reviewer", explorer: "explorer" });
  let team = withTeamPreset(solo, "plan-build-verify");
  assert.equal(team.preset, "plan-build-verify");
  assert.equal(team.workers?.length, 2, "two builders by default");
  assert.deepEqual(team.architect, lead, "every role starts on the lead");
  assert.deepEqual(team.reviewer, lead);
  assert.deepEqual(team.budget, { maxUsd: 4 }, "a $4 cap by default");

  team = withTeamRole(team, "architect", opus);
  team = withTeamRole(team, "verifier", gpt);
  team = withBuilderCount(team, 3);
  team = withTeamRole(team, "builder", { instanceId: "alevr", model: "google:gemini-3.8-flash" });
  assert.deepEqual(team.architect, opus);
  assert.deepEqual(team.reviewer, gpt);
  assert.equal(team.workers?.length, 3);
  assert.ok(team.workers!.every((w) => w.model === "google:gemini-3.8-flash"), "every builder takes the builder model");
  assert.deepEqual(team.orchestrator, lead, "the lead stays the composer's model");

  team = withTeamEffort(team, "architect", "max");
  assert.equal(team.architect?.effort, "max");
  assert.equal(teamRoleSelection(team, "architect")?.model, opus.model, "effort keeps the model");
  team = withTeamRole(team, "explorer", { instanceId: "alevr", model: "anthropic:claude-haiku-4-5" });
  assert.equal(team.explorer?.model, "anthropic:claude-haiku-4-5");
  team = withTeamRole(team, "explorer", undefined);
  assert.equal(team.explorer, undefined, "the Explorer is optional");

  team = withBudget(team, 2.5);
  assert.deepEqual(team.budget, { maxUsd: 2.5 });
  assert.equal(withBudget(team, undefined).budget, undefined);

  assert.equal(teamPresetOf(team), "plan-build-verify");
  assert.equal(teamPresetOf({ ...team, preset: "lead-workers" }), "plan-build-verify");
  assert.equal(teamPresetOf(undefined), "solo");
  assert.equal(teamPresetOf(withTeamPreset(team, "best-of-n")), "best-of-n");
  assert.equal(withTeamPreset(team, "solo").preset, "solo");
  assert.equal(teamSize(team), 5, "architect, three builders, verifier");
  assert.equal(orchestrateLabel(team), "Team of 5");
});

test("the phases follow the contract roles", () => {
  assert.equal(teamPhaseOf("architect"), "plan");
  assert.equal(teamPhaseOf("worker"), "build");
  assert.equal(teamPhaseOf("reviewer"), "verify");
  assert.equal(teamPhaseOf("explorer"), undefined);
});

test("a Plan → Build → Verify routing validates, and the Architect is a selection the server checks", () => {
  const team = withTeamRole(withTeamPreset(solo, "plan-build-verify"), "architect", opus);
  const ctx = { resolve: catalogModel, byokProviders: null };
  const v = validateRoleRouting(team, ctx);
  assert.ok(v.ok, JSON.stringify(!v.ok && v.errors));
  assert.equal(v.routing.architect?.model, "anthropic:claude-opus-5-5");
  assert.ok(routingSelections(v.routing).some((s) => s === v.routing.architect));
  const bad = validateRoleRouting({ ...team, architect: { instanceId: "alevr", model: "not-a-model" } }, ctx);
  assert.ok(!bad.ok && bad.errors.some((e) => e.startsWith("architect:")));
  const noBuilders = validateRoleRouting({ ...team, workers: [] }, ctx);
  assert.ok(!noBuilders.ok && noBuilders.errors.some((e) => /builder/.test(e)));
  const soloDropsArchitect = validateRoleRouting({ ...solo, architect: opus }, ctx);
  assert.ok(soloDropsArchitect.ok && soloDropsArchitect.routing.architect === undefined);
});

test("the estimate counts the Architect", () => {
  const rates = () => ({ inputPerMTok: 1, outputPerMTok: 1 });
  const team = withTeamPreset(solo, "plan-build-verify");
  const withoutArchitect = estimateRunUsd({ ...team, preset: "lead-workers", architect: undefined }, rates).usd;
  assert.ok(estimateRunUsd(team, rates).usd > 0);
  assert.notEqual(estimateRunUsd(team, rates).usd, withoutArchitect);
});

test("the chip's words match the shared fixture (Mac reads the same file)", () => {
  const fixture = JSON.parse(read("contracts/code/team-summaries.json")) as {
    names: [string, string][];
    summaries: { routing: RoleRouting; max?: number; summary: string | null }[];
  };
  for (const [id, name] of fixture.names) assert.equal(shortModelName(id), name, id);
  for (const c of fixture.summaries) assert.equal(teamSummary(c.routing, c.max), c.summary, JSON.stringify(c.routing.preset));
  assert.equal(teamSummary(undefined), null, "Solo shows nothing extra");
});

test("persistence: a thread keeps its own team; a new thread starts from the project's default", () => {
  const map = new Map<string, string>();
  const storage: TeamStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  const team = withTeamRole(withTeamPreset(solo, "plan-build-verify"), "verifier", gpt);
  assert.equal(loadTeam(storage, { session: "t1", project: "juno" }), null);
  saveTeam(storage, { session: "t1", project: "juno" }, team);
  assert.deepEqual(loadTeam(storage, { session: "t1", project: "juno" }), team);
  assert.deepEqual(loadTeam(storage, { session: "t2", project: "juno" }), team, "the project default seeds a new thread");
  assert.equal(loadTeam(storage, { session: "t3", project: "other" }), null);

  const soloAgain = withTeamPreset(team, "solo");
  saveTeam(storage, { session: "t2", project: "juno" }, soloAgain);
  assert.equal(loadTeam(storage, { session: "t1" })?.preset, "plan-build-verify", "t1 keeps its own");
  assert.equal(loadTeam(storage, { project: "juno" })?.preset, "solo", "the last edit is the project's default");

  map.set("alevr.code.team.session:broken", "{not json");
  assert.equal(loadTeam(storage, { session: "broken" }), null);
  const adopted = adoptTeam(team, opus);
  assert.deepEqual(adopted?.orchestrator, opus, "the lead follows the composer's model");
  assert.equal(adoptTeam(null, opus), null);
});
