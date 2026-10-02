/**
 * Skill tools for a Work (Orbit) run: `use_skill` and `read_skill_file` in the
 * shape agent-core's `WorkAgentSession` drives (design §6.8 item 7).
 *
 * The runner already selects a skill (by `/slug` in the goal, or automatically
 * for one the person opted in), pins its version, checks scan and consent and
 * writes `skill_applied`. `skillToolsFor` adds what a run could not do before:
 * the applied skill's folder becomes readable and, when the run carries
 * `run_code`, mounted read-only at `/skills/<slug>` in the run's sandbox
 * session (keyed by the run id, `skillMountsFor("work", runId)`); and any other skill
 * offered to the run can be loaded by name, with the same rules and sentences
 * as chat (`workflow.ts`).
 *
 * WHY THE SHAPE IS MIRRORED. `runner/agent-core` is vendored and excluded from
 * this project's tsconfig, so `WorkToolDefinition` cannot be imported here (see
 * `src/lib/work/connectors.ts`). `SkillWorkTool` repeats exactly the fields the
 * session reads; the runner passes these objects where it passes its own tools,
 * and a field that drifted would fail the runner's own typecheck.
 *
 * PROVENANCE. A skill nobody vouched for is someone else's text: its tools
 * declare `trust: 'untrusted'`, so the session scans and envelopes what they
 * return. This module therefore does NOT envelope (the session would wrap a
 * second time and defang the inner markers); it passes an identity wrapper.
 */

import "server-only";

import type { WorkActor } from "@/lib/work/domain";
import { openSkillToolSession, type SkillToolSession } from "@/lib/skills/session";
import { skillToolDescription, type SkillDiscoveryPolicy } from "@/lib/skills/workflow";
import { coerceSkillTrust } from "@/lib/work/skills";
import { READ_SKILL_FILE_TOOL_ID, USE_SKILL_TOOL_ID, type ToolOutcome } from "@/lib/tools/types";

/** Mirrors agent-core `WorkProvenance`. */
interface SkillWorkProvenance {
  source: string;
  sourceKind: "connector" | "web" | "file" | "local_app" | "model" | "user";
  action: string;
  trust: "trusted" | "untrusted";
}

/** Mirrors agent-core `ToolResult`. */
interface SkillWorkToolResult {
  output: string;
  isError?: boolean;
}

/** Mirrors the fields of agent-core `WorkToolDefinition` these tools fill. */
export interface SkillWorkTool {
  spec: { name: string; description: string; inputSchema: Record<string, unknown> };
  kind: "read";
  tier: "structured_file";
  intents: readonly string[];
  intentFor(input: Record<string, unknown>): string;
  actionFor(input: Record<string, unknown>): string;
  riskFor(input: Record<string, unknown>): "safe";
  provenanceFor(input: Record<string, unknown>): SkillWorkProvenance;
  summarize(input: Record<string, unknown>): string;
  execute(input: Record<string, unknown>): Promise<SkillWorkToolResult>;
}

export interface SkillRunContext {
  userId: string;
  /** The Work run id: the sandbox session the mounts are registered under. */
  runId: string;
  projectId: string | null;
  /** The skill the runner already applied (and audited), when one is in force. */
  appliedSlug?: string | null;
  /** Whether `run_code` is among the run's tools. */
  codeExecution: boolean;
  policy?: SkillDiscoveryPolicy;
  actor?: WorkActor;
  /** Test seam. */
  deps?: Parameters<typeof openSkillToolSession>[0]["deps"];
}

export interface SkillRunTools {
  tools: SkillWorkTool[];
  /** A short section for the run's system prompt, or null. */
  promptSection: string | null;
  /** The session behind the tools (loaded skills, for the run's own records). */
  session: SkillToolSession;
  /** Drops the run's mounts. Call when the run's session ends. */
  close(): Promise<void>;
}

function outcomeToResult(outcome: ToolOutcome): SkillWorkToolResult {
  return outcome.status === "succeeded" ? { output: outcome.text } : { output: outcome.text, isError: true };
}

/**
 * The skill tools for a Work run, or none when there is nothing to offer.
 *
 * Returns an empty list (and still a session to close) when the person has no
 * skill on offer and none is applied, so the runner adds nothing to the toolset
 * of the many runs that use no skill.
 */
export async function skillToolsFor(run: SkillRunContext): Promise<SkillRunTools> {
  const session = await openSkillToolSession({
    userId: run.userId,
    surface: "work",
    sessionId: run.runId,
    projectId: run.projectId,
    armedSlug: run.appliedSlug ?? null,
    code: run.codeExecution,
    skillFiles: true,
    policy: run.policy,
    // The session envelopes anything a tool marks untrusted; see the header.
    wrapUntrusted: (_label, content) => content,
    actor: run.actor ?? "cloud_runner",
    generationId: run.runId,
    deps: run.deps,
  });

  const trustOf = (name: unknown): "trusted" | "untrusted" => {
    const wanted = String(name ?? "").trim().replace(/^\/+/, "").toLowerCase();
    const row =
      session.loaded().find((skill) => skill.row.slug === wanted)?.row ??
      session.offered.find((candidate) => candidate.slug === wanted);
    // Unknown or unvouched-for: untrusted. A refusal sentence is ours, but
    // enveloping it costs nothing and guessing wrong the other way would not.
    return row && coerceSkillTrust(row.trust) !== "untrusted" ? "trusted" : "untrusted";
  };

  const tools: SkillWorkTool[] = [];
  if (session.offered.length > 0) {
    tools.push({
      spec: {
        name: USE_SKILL_TOOL_ID,
        description: skillToolDescription(session.offered),
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", description: "The skill's name exactly as listed in this tool's description." } },
          required: ["name"],
        },
      },
      kind: "read",
      tier: "structured_file",
      intents: ["skill.use"],
      intentFor: () => "skill.use",
      actionFor: () => "work.skill.use",
      riskFor: () => "safe",
      provenanceFor: (input) => ({
        source: `skill ${String(input.name ?? "").slice(0, 64)}`,
        sourceKind: "file",
        action: "work.skill.use",
        trust: trustOf(input.name),
      }),
      summarize: (input) => `Load the ${String(input.name ?? "").slice(0, 64)} skill`,
      async execute(input) {
        const name = typeof input.name === "string" ? input.name : "";
        if (!name.trim()) return { output: "Name the skill to load, exactly as listed. Nothing was loaded.", isError: true };
        return outcomeToResult(await session.loadSkill(name));
      },
    });
  }
  if (session.offered.length > 0 || session.armed?.version.bundle) {
    tools.push({
      spec: {
        name: READ_SKILL_FILE_TOOL_ID,
        description:
          "Read a file that a loaded skill keeps beside its instructions (a reference, a template, a script's source). " +
          "Use the skill's name and the path as listed. Long files come back in pages of 40,000 characters; pass the " +
          "offset the previous page gave you to read on.",
        inputSchema: {
          type: "object",
          properties: {
            skill: { type: "string", description: "The loaded skill's name." },
            path: { type: "string", description: "The file's path inside the skill, as listed." },
            offset: { type: "integer", description: "Character offset for the next page. Default 0." },
          },
          required: ["skill", "path"],
        },
      },
      kind: "read",
      tier: "structured_file",
      intents: ["skill.read_file"],
      intentFor: () => "skill.read_file",
      actionFor: () => "work.skill.read_file",
      riskFor: () => "safe",
      provenanceFor: (input) => ({
        source: `skill ${String(input.skill ?? "").slice(0, 64)}`,
        sourceKind: "file",
        action: "work.skill.read_file",
        trust: trustOf(input.skill),
      }),
      summarize: (input) => `Read ${String(input.path ?? "").slice(0, 120)} from the ${String(input.skill ?? "").slice(0, 64)} skill`,
      async execute(input) {
        const skill = typeof input.skill === "string" ? input.skill.trim() : "";
        const path = typeof input.path === "string" ? input.path.trim() : "";
        if (!skill || !path) return { output: "Name the loaded skill and the file's path inside it. Nothing was read.", isError: true };
        const offset = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 0;
        return outcomeToResult(await session.readSkillFile({ skill, path, offset }));
      },
    });
  }

  return {
    tools,
    promptSection: tools.length > 0 ? session.promptSection ?? null : null,
    session,
    close: () => session.close(),
  };
}
