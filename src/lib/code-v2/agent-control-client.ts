/**
 * The browser side of a person's agent controls (REA backlog 10).
 *
 * Over the hosted device link every control goes to the agent-control route,
 * which audits, rate-limits and pins the request key (agent-control.ts). In
 * the Mac app's own web view the page talks to the local env server directly,
 * and the same key rides as `requestId` so the env server applies a retried
 * control once.
 *
 * One key per press: a retry after a lost answer (a 502/503/504 or a network
 * error) reuses it, so the press is applied once whichever attempt landed.
 */
import type { AgentControlResult, ClientCommandParams, ClientCommandResults, ClientCommandType } from "./contracts";
import type { AgentControlAction } from "./agent-control";

export interface AgentControlInput {
  sessionId: string;
  agentId?: string;
  action: AgentControlAction;
  text?: string;
  tokens?: number;
  usd?: number;
}

export interface AgentControlTransport {
  /** The Mac's device id when the page reaches it through the hosted link; null for a direct socket. */
  linkDeviceId: string | null;
  request<T extends ClientCommandType>(type: T, params: ClientCommandParams[T]): Promise<ClientCommandResults[T]>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function newControlKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `agent-control:${id}`;
}

export class AgentControlError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const RETRYABLE = new Set([502, 503, 504]);

export async function sendAgentControl(
  transport: AgentControlTransport,
  input: AgentControlInput,
  options: { key?: string; fetcher?: FetchLike; retries?: number } = {},
): Promise<AgentControlResult> {
  const key = options.key ?? newControlKey();
  if (transport.linkDeviceId) {
    const fetcher = options.fetcher ?? ((i, init) => fetch(i, init));
    const body = JSON.stringify({ ...input, idempotencyKey: key });
    let attempt = 0;
    const retries = options.retries ?? 1;
    for (;;) {
      let res: Response | null = null;
      try {
        res = await fetcher(`/api/code/v2/link/${encodeURIComponent(transport.linkDeviceId)}/agents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch {
        res = null;
      }
      if (res && !RETRYABLE.has(res.status)) {
        const payload = (await res.json().catch(() => ({}))) as Partial<AgentControlResult> & { error?: string };
        if (!res.ok) throw new AgentControlError(payload.message ?? payload.error ?? "That did not go through. Try again.", res.status);
        return { accepted: payload.accepted !== false, ...payload } as AgentControlResult;
      }
      if (attempt >= retries) {
        const payload = res ? ((await res.json().catch(() => ({}))) as { message?: string }) : {};
        throw new AgentControlError(payload.message ?? "Could not reach your Mac. Try again.", res?.status);
      }
      attempt += 1;
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  // Direct socket (the Mac app's web view): the env server dedupes by requestId.
  const { sessionId, agentId } = input;
  const target = agentId ? { agentId } : {};
  switch (input.action) {
    case "steer": {
      const r = await transport.request("agent.message", { sessionId, agentId: agentId!, text: input.text ?? "", requestId: key });
      return { accepted: r.accepted, ...(r.message ? { message: r.message } : {}) };
    }
    case "stop":
      if (agentId) await transport.request("agent.interrupt", { sessionId, agentId, requestId: key });
      else await transport.request("turn.interrupt", { sessionId });
      return { accepted: true };
    case "pause":
      return transport.request("agent.pause", { sessionId, ...target, requestId: key });
    case "resume":
      return transport.request("agent.resume", { sessionId, ...target, requestId: key });
    case "top_up":
      return transport.request("agent.topUp", {
        sessionId,
        ...target,
        ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
        ...(input.usd === undefined ? {} : { usd: input.usd }),
        requestId: key,
      });
  }
}
