/**
 * An inbound text: whether to take it, and which agent answers it.
 *
 * `admitInbound` is the gate every provider's webhook runs after its own
 * authentication (Sendblue's shared secret). In this order, each one cheap
 * before the next:
 *
 *   1. the line: a text sent to some other number than ours is dropped;
 *   2. the clock: `sentAt` must be within `INBOUND_WINDOW_MS` of now, either
 *      way, so a captured request cannot be played back later;
 *   3. the rate: `INBOUND_LIMIT` texts per number per window, counted for
 *      unknown numbers too, so a stranger cannot flood the ledger or the
 *      lookups;
 *   4. the replay ledger: the provider's message handle, hashed, is claimed
 *      once; a second delivery of the same text (a retry, or a replay inside
 *      the window) is dropped;
 *   5. the link: only a `verified` number reaches anything. An unknown or
 *      pending number gets no reply at all, so the line does not confirm to a
 *      stranger that it is anyone's.
 *
 * `answerInbound` then picks the agent (@Name, else the link's default, else
 * the first active agent), has it answer without tools, mirrors both turns
 * into that agent's thread, and texts the answer back. It has no approval
 * dependency and its reply has no tools, so no text, whatever it says
 * ("yes", "approve", "1"), can approve, start or change anything. The approval
 * texts (notice.ts) say so and link to the card instead.
 *
 * Pure: everything it touches is an `InboundDeps` / `AnswerDeps` call.
 */

import { findAddressedMembers } from "@/lib/agents/rooms";
import { HANDLE_HASH_DOMAIN, PHONE_HASH_DOMAIN } from "@/lib/channels/link";
import type { ChannelProvider, ChannelProviderId, InboundText } from "@/lib/channels/types";

/** How far a text's `date_sent` may be from the server's clock, either way. */
export const INBOUND_WINDOW_MS = 5 * 60 * 1000;
export const INBOUND_LIMIT = 20;
export const INBOUND_LIMIT_WINDOW_SEC = 10 * 60;
/** What a text may carry into the agent's thread and the model. */
export const MAX_INBOUND_CHARS = 4_000;

export type InboundIgnoredReason =
  | "wrong_line"
  | "no_date"
  | "stale"
  | "rate_limited"
  | "replayed"
  | "unknown_number";

export interface AdmittedText {
  linkId: string;
  userId: string;
  defaultAgentId: string | null;
  phone: string;
  text: string;
  handleHash: string;
}

export interface InboundDeps {
  now(): Date;
  mac(domain: string, value: string): string;
  /** Our own line, E.164; texts to any other number are dropped. */
  ownNumber: string | null;
  rateLimit(key: string, limit: number, windowSec: number): Promise<boolean>;
  /** Inserts the handle into the ledger; false when it was already there. */
  claimHandle(provider: ChannelProviderId, handleHash: string): Promise<boolean>;
  findVerifiedLink(
    provider: ChannelProviderId,
    phoneHash: string
  ): Promise<{ id: string; userId: string; defaultAgentId: string | null } | null>;
}

export async function admitInbound(
  provider: ChannelProviderId,
  message: InboundText,
  deps: InboundDeps
): Promise<{ kind: "ignored"; reason: InboundIgnoredReason } | { kind: "admitted"; text: AdmittedText }> {
  if (deps.ownNumber && message.to && message.to !== deps.ownNumber) return { kind: "ignored", reason: "wrong_line" };
  if (!message.sentAt) return { kind: "ignored", reason: "no_date" };
  if (Math.abs(deps.now().getTime() - message.sentAt.getTime()) > INBOUND_WINDOW_MS) return { kind: "ignored", reason: "stale" };

  const phoneHash = deps.mac(PHONE_HASH_DOMAIN, message.from);
  if (!(await deps.rateLimit(`channel:inbound:${phoneHash}`, INBOUND_LIMIT, INBOUND_LIMIT_WINDOW_SEC))) {
    return { kind: "ignored", reason: "rate_limited" };
  }
  const handleHash = deps.mac(HANDLE_HASH_DOMAIN, `${provider}\n${message.handle}`);
  if (!(await deps.claimHandle(provider, handleHash))) return { kind: "ignored", reason: "replayed" };

  const link = await deps.findVerifiedLink(provider, phoneHash);
  if (!link) return { kind: "ignored", reason: "unknown_number" };
  return {
    kind: "admitted",
    text: {
      linkId: link.id,
      userId: link.userId,
      defaultAgentId: link.defaultAgentId,
      phone: message.from,
      text: message.text.slice(0, MAX_INBOUND_CHARS),
      handleHash,
    },
  };
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

export interface ChannelAgent {
  id: string;
  name: string;
  role: string;
  /** "active" answers; anything else is paused. */
  status: string;
}

export const INBOUND_REPLY_COPY = {
  noAgents: (product: string, url: string) => `You have no active agents in ${product} yet. Hire one here: ${url}`,
  paused: (name: string, url: string) => `${name} is paused. Resume them here: ${url}`,
  failed: (name: string, url: string) => `${name} could not answer just now. Your text is in their thread: ${url}`,
} as const;

export type AnswerOutcome =
  | { kind: "answered"; agentId: string }
  | { kind: "declined"; reason: "no_agents" | "paused" | "no_answer"; agentId: string | null };

export interface AnswerDeps {
  provider: ChannelProvider;
  productName: string;
  /** An absolute link into the app. */
  appUrl(path: string): string;
  /** The account's agents (not retired), in roster order. */
  listAgents(userId: string): Promise<ChannelAgent[]>;
  /** The agent's answer, with no tools; null when it could not answer (budget, provider, policy). */
  reply(input: { userId: string; agentId: string; text: string }): Promise<string | null>;
  /** Writes the text and the answer (when there is one) into the agent's thread. */
  mirror(input: { userId: string; agentId: string; text: string; reply: string | null; handleHash: string }): Promise<void>;
  /** Marks the link used and records `channel_message` on the agent's log (no content). */
  record(input: { userId: string; linkId: string; agentId: string; answered: boolean }): Promise<void>;
}

/**
 * Which agent a text is for: the first one it names with @Name (paused ones
 * included, so "@Scout" to a paused Scout says Scout is paused rather than
 * quietly reaching someone else), else the link's default while active, else
 * the first active agent. One agent answers a text; "@all" reaches the first.
 */
export function pickAgent(
  text: string,
  agents: readonly ChannelAgent[],
  defaultAgentId: string | null
): { agent: ChannelAgent | null; addressed: boolean } {
  const named = findAddressedMembers(
    text,
    agents.map((agent) => ({ agentId: agent.id, name: agent.name, role: agent.role }))
  );
  const addressed = named.length > 0 ? agents.find((agent) => agent.id === named[0]) ?? null : null;
  if (addressed) return { agent: addressed, addressed: true };
  const active = agents.filter((agent) => agent.status === "active");
  const fallback = active.find((agent) => agent.id === defaultAgentId) ?? active[0] ?? null;
  return { agent: fallback, addressed: false };
}

export async function answerInbound(admitted: AdmittedText, deps: AnswerDeps): Promise<AnswerOutcome> {
  const agents = await deps.listAgents(admitted.userId);
  const { agent } = pickAgent(admitted.text, agents, admitted.defaultAgentId);
  if (!agent) {
    await deps.provider.send(admitted.phone, INBOUND_REPLY_COPY.noAgents(deps.productName, deps.appUrl("/agents")));
    return { kind: "declined", reason: "no_agents", agentId: null };
  }
  const agentUrl = deps.appUrl(`/agents/${encodeURIComponent(agent.id)}`);
  if (agent.status !== "active") {
    await deps.provider.send(admitted.phone, INBOUND_REPLY_COPY.paused(agent.name, agentUrl));
    return { kind: "declined", reason: "paused", agentId: agent.id };
  }

  const reply = await deps.reply({ userId: admitted.userId, agentId: agent.id, text: admitted.text });
  await deps.mirror({ userId: admitted.userId, agentId: agent.id, text: admitted.text, reply, handleHash: admitted.handleHash });
  await deps.record({ userId: admitted.userId, linkId: admitted.linkId, agentId: agent.id, answered: reply !== null });
  if (reply === null) {
    await deps.provider.send(admitted.phone, INBOUND_REPLY_COPY.failed(agent.name, agentUrl));
    return { kind: "declined", reason: "no_answer", agentId: agent.id };
  }
  await deps.provider.send(admitted.phone, reply);
  return { kind: "answered", agentId: agent.id };
}
