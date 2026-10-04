/*
 * WHO MAY READ WHICH MEMORY — the layer boundaries, as one pure rule.
 *
 * Memory has four readers, and each sees a different slice:
 *
 *   account   an ordinary chat. Account-wide facts only.
 *   project   a chat filed in a project. That project's facts only, in
 *             isolation (the default since shared projects): the account's
 *             personal facts stay out, so a project's context never carries
 *             something its owner said elsewhere.
 *   agent     an Orbit agent's thread, task or room turn. The agent's own
 *             notes always (they live in AgentNote, keyed by agentId, and are
 *             not this module's business). Of the person's memory, only what
 *             the agent's `memoryAccess` grants — and the default grants the
 *             durable PROFILE, not everything: an agent does not inherit
 *             relationships, studies, temporary context, sensitive facts or
 *             another project's knowledge just because its owner has them.
 *   member    someone else in a shared project. Nobody's memory but their own:
 *             every read is keyed by the reader's userId at the query, so this
 *             module never sees another member's rows at all. It is listed so
 *             the boundary is named in one place; tests/memory-scope-db.test.ts
 *             proves it against Postgres.
 *
 * Pure on purpose: the same rule runs in getMemoryProfile (server), in the
 * evaluation suite (memory-eval.ts) and in the agent settings copy, and a
 * boundary with two implementations is a boundary with two answers.
 */

import { sensitiveTopicOf } from "@/lib/memory-sensitive";

export const AGENT_MEMORY_ACCESS = ["none", "profile", "full"] as const;
export type AgentMemoryAccess = (typeof AGENT_MEMORY_ACCESS)[number];

/** What a new agent gets: enough to sound like it knows you, nothing private. */
export const DEFAULT_AGENT_MEMORY_ACCESS: AgentMemoryAccess = "profile";

export function isAgentMemoryAccess(value: unknown): value is AgentMemoryAccess {
  return typeof value === "string" && (AGENT_MEMORY_ACCESS as readonly string[]).includes(value);
}

/** Unknown or missing values read as the default, never as "full". */
export function agentMemoryAccessOf(value: unknown): AgentMemoryAccess {
  return isAgentMemoryAccess(value) ? value : DEFAULT_AGENT_MEMORY_ACCESS;
}

/**
 * The categories the profile grant covers: how the person likes to work and
 * be spoken to. Everything else — who they are close to, what they study,
 * what is happening this week, what they are building elsewhere — needs the
 * person to grant "full" to that one agent.
 */
export const AGENT_PROFILE_CATEGORIES: ReadonlySet<string> = new Set(["preferences", "workflows", "identity"]);

export const AGENT_MEMORY_ACCESS_META: Record<AgentMemoryAccess, { label: string; description: string }> = {
  none: { label: "Its own notes only", description: "Uses only what it learned itself. Nothing from your memory." },
  profile: {
    label: "Your profile",
    description: "Your preferences, how you work and who you are. Not relationships, studies, sensitive topics or other projects.",
  },
  full: {
    label: "Everything you share with chats",
    description: "The same memory an ordinary chat in its project would use.",
  },
};

export type MemoryReader =
  | { kind: "account" }
  | { kind: "project"; projectId: string }
  | { kind: "agent"; agentId: string; access: AgentMemoryAccess; projectId: string | null };

/**
 * Whether one stored fact may reach this reader. The fact is assumed to be the
 * reader's own (userId is enforced by the query) and believed (status/expiry
 * are enforced by retrieval); this decides scope and grant only.
 */
export function readerMayUse(
  entry: { projectId: string | null; category: string | null; content: string },
  reader: MemoryReader
): boolean {
  switch (reader.kind) {
    case "account":
      return entry.projectId === null;
    case "project":
      return entry.projectId === reader.projectId;
    case "agent": {
      if (reader.access === "none") return false;
      // An agent filed in a project reads that project's facts the way a
      // project chat does — isolated; an unfiled agent reads account facts.
      const scopeOk = reader.projectId ? entry.projectId === reader.projectId : entry.projectId === null;
      if (!scopeOk) return false;
      if (reader.access === "full") return true;
      if (sensitiveTopicOf(entry.content) !== null) return false;
      return entry.category !== null && AGENT_PROFILE_CATEGORIES.has(entry.category);
    }
  }
}

/**
 * Whether the consolidated prose summary may be injected for this reader.
 * A summary mixes every category, so the profile grant cannot honour its
 * exclusions through prose: agents with "profile" read ranked facts only.
 */
export function readerMayUseSummary(reader: MemoryReader): boolean {
  return reader.kind !== "agent" || reader.access === "full";
}
