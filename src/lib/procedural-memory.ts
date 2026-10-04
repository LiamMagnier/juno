/*
 * PROCEDURAL MEMORY (Layer G) — how the person gets things done, as distinct
 * from what is known about them.
 *
 * Memory is what is known; a Skill is how to do something. When the person's
 * own Work runs succeed at the same kind of task, with the same tools, three
 * times or more, that repetition is a method worth keeping — but only as a
 * PROPOSAL. Nothing here creates, enables or auto-selects a skill: the person
 * reads the proposal on the Memory page and either makes it a skill (which
 * lands with auto-selection off, editable like any other) or says no, and a
 * "no" is remembered so it is never proposed again.
 *
 * Deterministic and model-free: clustering is token overlap over the runs'
 * own goals, the title is one the runs already carried, and the draft is a
 * template over the person's own requests and the tools those runs used. A
 * proposal that invented its method would be exactly the "memory that makes
 * things up" this program refuses.
 */

import { createHash } from "node:crypto";
import { recallTokens } from "@/lib/recall/index-core";

export interface MethodRun {
  sessionId: string;
  title: string;
  goal: string;
  projectId: string | null;
  finishedAt: Date;
  /** Tools the run finished without error, in any order. */
  tools: readonly string[];
}

export interface MethodCandidate {
  key: string;
  title: string;
  projectId: string | null;
  examples: string[];
  tools: string[];
  sessionIds: string[];
  lastSeenAt: Date;
}

/** Runs of one method before it is worth proposing. */
export const MIN_METHOD_RUNS = 3;
/** Goal overlap (Jaccard over recall tokens) for two runs to be the same kind of task. */
export const METHOD_SIMILARITY = 0.5;
const MAX_EXAMPLES = 3;
const EXAMPLE_CHARS = 200;

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

export function detectRepeatedMethods(
  runs: readonly MethodRun[],
  opts: { minRuns?: number; similarity?: number } = {}
): MethodCandidate[] {
  const minRuns = opts.minRuns ?? MIN_METHOD_RUNS;
  const similarity = opts.similarity ?? METHOD_SIMILARITY;
  const ordered = [...runs].sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());
  const clusters: { seed: Set<string>; projectId: string | null; members: MethodRun[] }[] = [];
  for (const run of ordered) {
    const tokens = new Set(recallTokens(`${run.title} ${run.goal}`, 40));
    if (tokens.size === 0) continue;
    const home = clusters.find((c) => c.projectId === run.projectId && jaccard(c.seed, tokens) >= similarity);
    if (home) home.members.push(run);
    else clusters.push({ seed: tokens, projectId: run.projectId, members: [run] });
  }
  const out: MethodCandidate[] = [];
  for (const cluster of clusters) {
    if (cluster.members.length < minRuns) continue;
    // Tools most of the runs used: the method, as far as the runs show it.
    const counts = new Map<string, number>();
    for (const member of cluster.members) for (const tool of new Set(member.tools)) counts.set(tool, (counts.get(tool) ?? 0) + 1);
    const needed = Math.ceil((cluster.members.length * 2) / 3);
    const tools = [...counts].filter(([, n]) => n >= needed).map(([tool]) => tool).sort();
    if (tools.length === 0) continue; // the same words, but no shared way of doing it
    const titleCounts = new Map<string, number>();
    for (const member of cluster.members) titleCounts.set(member.title, (titleCounts.get(member.title) ?? 0) + 1);
    const title = [...titleCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const seedKey = [...cluster.seed].sort().slice(0, 12).join(" ");
    out.push({
      key: createHash("sha256").update(`${cluster.projectId ?? ""}\u0000${seedKey}\u0000${tools.join(",")}`).digest("hex").slice(0, 32),
      title,
      projectId: cluster.projectId,
      examples: cluster.members.slice(0, MAX_EXAMPLES).map((m) => m.goal.replace(/\s+/g, " ").trim().slice(0, EXAMPLE_CHARS)),
      tools,
      sessionIds: cluster.members.map((m) => m.sessionId),
      lastSeenAt: cluster.members[0].finishedAt,
    });
  }
  return out;
}

/**
 * The skill a proposal becomes when the person accepts it: their own requests
 * and the tools their runs used, laid out for them to edit. No step is written
 * that the runs did not show.
 */
export function skillDraftFromCandidate(candidate: Pick<MethodCandidate, "title" | "examples" | "tools">): {
  name: string;
  description: string;
  instructions: string;
} {
  const name = candidate.title.trim().slice(0, 80) || "Repeated task";
  return {
    name,
    description: `A method from your own runs: ${name}.`,
    instructions: [
      `Use this for requests like:`,
      ...candidate.examples.map((example) => `- ${example}`),
      ``,
      `The runs this came from used: ${candidate.tools.join(", ")}.`,
      ``,
      `These steps were drafted from your past runs. Edit them into the method you want followed.`,
    ].join("\n"),
  };
}
