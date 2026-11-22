/**
 * The Team orchestrator for subscription agents (team lane).
 *
 * Alevr's own engine runs a Plan → Build → Verify team itself (agent-core
 * `runTeam`). A vendor agent (Claude, Codex, an ACP runtime) leads the team
 * through the Alevr MCP server instead: this brief, sent ahead of the
 * person's request, tells it to call spawn_subagent with role architect, then
 * one builder per worker, then the verifier, in that order, and the tool
 * routes each role to the model the person chose for it.
 */
import type { InteractionMode, ModelSelection, ProviderKind, RoleRouting, TeamPhase, UserInput } from "../contracts/code-v2.js";

/** The phase a subagent of this role runs in. */
export function phaseOfRole(role: string): TeamPhase | undefined {
  if (role === "architect") return "plan";
  if (role === "worker") return "build";
  if (role === "reviewer") return "verify";
  return undefined;
}

const name = (s: ModelSelection | undefined) => (s ? `${s.model} (${s.instanceId})` : "the thread's model");

/** The brief, or undefined when the routing is not a team or the lead is Alevr's own engine. */
export function teamBrief(routing: RoleRouting | undefined, leadKind: ProviderKind | null): string | undefined {
  if (!routing || !leadKind || leadKind === "alevr" || leadKind === "byok") return undefined;
  const builders = Math.max(1, routing.workers?.length ?? 1);
  const budget = routing.budget?.maxUsd !== undefined ? ` The run's budget is $${routing.budget.maxUsd.toFixed(2)}; spawn_subagent refuses work once it is spent, so stop and report.` : "";
  if (routing.preset === "lead-workers") {
    return [
      "<alevr_team>",
      `You lead this run. For independent tasks, use the alevr MCP tool spawn_subagent with role "worker" and omit model and instanceId to use the configured worker. Run no more than ${builders} workers at once.`,
      "Give each worker a self-contained brief with its own scope and expected result. Keep overlapping edits sequential. Use wait_subagent to collect the results before summarizing.",
      ...(routing.explorer ? ['Use role "explorer" for read-only codebase research when it helps.'] : []),
      ...(routing.reviewer ? ['Use role "reviewer" to check the changes when a separate review would help.'] : []),
      `Keep small tasks with the lead and report any incomplete or failed work.${budget}`,
      "</alevr_team>",
    ].join("\n");
  }
  if (routing.preset !== "plan-build-verify") return undefined;
  return [
    "<alevr_team>",
    "You lead a team in Alevr. Work in three phases, in order, using the alevr MCP tools (spawn_subagent, then wait_subagent):",
    `1. Plan: spawn_subagent with role "architect" (it runs on ${name(routing.architect ?? routing.orchestrator)}). Give it the whole request and ask for a plan split into at most ${builders} independent parts. Wait for it.`,
    `2. Build: for each part, spawn_subagent with role "worker" (${builders} builder${builders === 1 ? "" : "s"} on ${name(routing.workers?.[0])}), all before waiting, so they build in parallel. Wait for every one.`,
    `3. Verify: spawn_subagent with role "reviewer" (it runs on ${name(routing.reviewer ?? routing.orchestrator)}) with the request, the plan and what the builders reported; it reviews and tests the result. Wait for it.`,
    `Do not write the implementation yourself unless a builder failed. Finish by telling the person what was planned, built and verified.${budget}`,
    "</alevr_team>",
  ].join("\n");
}

/** The turn's input as the vendor agent receives it: the brief, then the request. Plan mode skips the team. */
export function withTeamBrief(input: UserInput, routing: RoleRouting | undefined, leadKind: ProviderKind | null, interactionMode: InteractionMode): UserInput {
  if (interactionMode === "plan") return input;
  const brief = teamBrief(routing, leadKind);
  return brief ? { ...input, text: `${brief}\n\n${input.text}` } : input;
}
