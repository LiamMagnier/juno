/**
 * The face of an agent inside a run: the lead, its workers, explorers,
 * reviewers, verifiers and any custom subagent type a provider names.
 *
 * Run agents are not hired, so nobody chose their face and nothing stores it.
 * It is derived instead, from two things that do not change while the run
 * lives: the agent's ROLE (which picks the body family and the accessory, so a
 * reviewer reads as a reviewer across runs) and its ID (which picks the tone,
 * the shape within the family and the eyes). Siblings are then kept apart: no
 * two agents of one run share a tone while a free tone remains, and never a
 * shape and a tone together while a free pair remains.
 *
 * The vocabulary is the shipped face's (`avatar.ts`), so a run agent is drawn
 * by the same `AgentFace` the Orbit roster draws, in the same brand tones, and
 * reads as one of the same characters. Docs: docs/design/AGENTS.md §4.4.
 *
 * Pure. `JunoAgentRunAvatar.swift` is its bit-for-bit twin; both are held to
 * `tests/fixtures/agent-run-avatars.json`.
 */
import { AGENT_EYES, type AgentAvatar, type AgentEyes, type AgentMark, type AgentShape, type AgentTone } from "./avatar";
import type { AgentState } from "./domain";

export const RUN_AGENT_ROLES = ["lead", "worker", "explorer", "reviewer", "verifier", "architect", "compaction", "custom"] as const;
export type RunAgentRole = (typeof RUN_AGENT_ROLES)[number];

/**
 * Each role's body family and accessory. Families overlap a little so a large
 * team still has room, but each role's first shape is its own, and the marks
 * (drawn from 28px up) say the role where there is room for it.
 */
export const RUN_ROLE_LOOK: Record<RunAgentRole, { shapes: readonly AgentShape[]; mark: AgentMark }> = {
  // The lead wears Orbit's open ring: it is the one the others orbit.
  lead: { shapes: ["halo", "orb"], mark: "ring" },
  worker: { shapes: ["pebble", "tile", "capsule", "orb"], mark: "none" },
  explorer: { shapes: ["spark", "petal", "capsule"], mark: "antenna" },
  reviewer: { shapes: ["prism", "bloom", "pebble"], mark: "visor" },
  verifier: { shapes: ["prism", "tile", "orb"], mark: "spark" },
  architect: { shapes: ["bloom", "tile", "halo"], mark: "leaf" },
  compaction: { shapes: ["orb", "pebble"], mark: "none" },
  custom: { shapes: ["orb", "pebble", "capsule", "petal", "bloom", "spark", "tile", "halo", "prism"], mark: "none" },
};

/**
 * The tones a run agent may take: the brand's agent tones less coral, which
 * the crew rules keep off every default (it reads as another lab's colour;
 * src/app/dev/design/juno/crew/RATIONALE.md §3). Coral stays a person's choice
 * for a hired agent.
 */
export const RUN_TONES: readonly AgentTone[] = ["juniper", "teal", "violet", "amber", "sage"];

/**
 * Reads whatever a provider calls the agent's role into the run vocabulary.
 * `orchestrator` is the lead; a reviewer in the Verify phase is a verifier;
 * anything unknown (a custom subagent type such as "db-migrator") is custom.
 */
export function runAgentRole(role: string | undefined | null, phase?: string | null): RunAgentRole {
  const r = (role ?? "").trim().toLowerCase();
  if (r === "orchestrator" || r === "lead") return "lead";
  if (r === "verifier" || (r === "reviewer" && phase === "verify")) return "verifier";
  if (r === "worker" || r === "builder") return "worker";
  if (r === "explorer" || r === "explore") return "explorer";
  if (r === "reviewer") return "reviewer";
  if (r === "architect" || r === "planner") return "architect";
  if (r === "compaction") return "compaction";
  return "custom";
}

/** FNV-1a over UTF-16 code units, the same hash `avatar.ts` and the Swift face use. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface RunAgentInput {
  id: string;
  /** The provider's role word (`orchestrator`, `worker`, a custom type…). */
  role?: string | null;
  /** The team phase, when the run has one (`plan`, `build`, `verify`). */
  phase?: string | null;
}

/** One agent's face with no siblings to keep apart from. */
export function runAgentAvatar(agent: RunAgentInput): AgentAvatar {
  return runAgentAvatars([agent]).get(agent.id)!;
}

/**
 * Every agent of one run, kept apart. Agents are taken in the order given —
 * arrival order, which only ever appends — so a new agent never changes the
 * face of one already on screen.
 */
export function runAgentAvatars(agents: readonly RunAgentInput[]): Map<string, AgentAvatar> {
  const out = new Map<string, AgentAvatar>();
  const usedTones = new Set<AgentTone>();
  const usedPairs = new Set<string>();
  for (const agent of agents) {
    if (out.has(agent.id)) continue;
    const role = runAgentRole(agent.role, agent.phase);
    const look = RUN_ROLE_LOOK[role];
    const h = hash(`${role}:${agent.id || "agent"}`);
    const tones = RUN_TONES;
    const shapes = look.shapes;
    const baseTone = h % tones.length;
    const baseShape = Math.floor(h / 7) % shapes.length;
    const eyes: AgentEyes = AGENT_EYES[Math.floor(h / 53) % AGENT_EYES.length];
    const total = tones.length * shapes.length;
    const at = (j: number): { tone: AgentTone; shape: AgentShape } => ({
      tone: tones[(baseTone + j) % tones.length],
      shape: shapes[(baseShape + Math.floor(j / tones.length)) % shapes.length],
    });
    const candidates = Array.from({ length: total }, (_, j) => at(j));
    const pick =
      candidates.find((c) => !usedTones.has(c.tone)) ??
      candidates.find((c) => !usedPairs.has(`${c.shape}/${c.tone}`)) ??
      candidates[0]!;
    usedTones.add(pick.tone);
    usedPairs.add(`${pick.shape}/${pick.tone}`);
    out.set(agent.id, { shape: pick.shape, tone: pick.tone, eyes, mark: look.mark });
  }
  return out;
}

/* ———————————————————————— Run state → face state ———————————————————————— */

/** The Agents tree's node states (src/lib/code-v2/agent-tree.ts), restated so this file stays pure. */
export type RunAgentNodeState = "thinking" | "tool" | "waiting" | "queued" | "paused" | "done" | "failed" | "stopped";

/**
 * What the face shows for each run state (AGENTS.md §4.4):
 * thinking → thinking; using a tool → working; needs approval → waiting;
 * queued → idle (resting, nothing loops); paused → sleeping (eyes closed,
 * resting: the paused look); done → done; failed → blocked; stopped → idle,
 * because a person's stop is not a failure and must not look like one. The
 * words beside the face always name the real state.
 */
export const RUN_FACE_STATE: Record<RunAgentNodeState, AgentState> = {
  thinking: "thinking",
  tool: "working",
  waiting: "waiting",
  queued: "idle",
  paused: "sleeping",
  done: "done",
  failed: "blocked",
  stopped: "idle",
};

export function runFaceState(state: RunAgentNodeState): AgentState {
  return RUN_FACE_STATE[state];
}

/** A subagent item's status (contracts.ts `SubagentStatus`) as a face state. */
export function subagentFaceState(status: string, paused?: boolean): AgentState {
  if (paused && (status === "running" || status === "waiting")) return "sleeping";
  switch (status) {
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "blocked";
    default:
      return "idle";
  }
}

/** Face states that move on their own (a loop), and so take an animation slot. */
export const ANIMATED_FACE_STATES: ReadonlySet<AgentState> = new Set(["thinking", "working", "waiting"]);
