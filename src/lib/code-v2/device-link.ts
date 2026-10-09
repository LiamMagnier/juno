/**
 * The hosted web ↔ Mac env-server relay (`/api/code/v2/link/[deviceId]`),
 * the server half of `DeviceLinkTransport` (env-client.ts). It rides the
 * existing device command queue (CodeSessionCommand, claimed by the Mac's
 * long-poll), so nothing new has to be reachable from the internet:
 *
 *   web  POST {kind:"rpc", command}               → queue `env.rpc`  {command}
 *   web  POST {kind:"poll", cursors, globalCursor} → queue `env.poll` {cursors, globalCursor, waitMs}
 *   Mac  claims the command, hands it to its local env server, and acks with
 *        result = LinkReply {responses?, events?}
 *   web  ← the ack's result, or {offline:true} when the Mac does not answer.
 *
 * Contract for the Mac host (mac lane): on `env.rpc`, send `payload.command`
 * to the env server and ack with `{responses:[<its response>], events:[…any
 * events it emitted for that session meanwhile…]}`; on `env.poll`, ack with
 * every event whose sequence is greater than `cursors[sessionId]` (session
 * streams) or `globalCursor` (global stream), waiting up to `waitMs` for at
 * least one. `env.configure` is local-only and refused here.
 *
 * Pure parsing and shaping; the route does the I/O.
 */
import { isClientCommandType, type ClientCommand, type ServerEventEnvelope, type ServerResponse } from "@/lib/code-v2/contracts";

export const LINK_RPC_KIND = "env.rpc";
export const LINK_POLL_KIND = "env.poll";
/** The CodeRemoteSession the relay's commands hang off (the queue requires one). */
export const LINK_SESSION_ID = "alevr-env-link";
/** How long the route waits for the Mac to answer an rpc / a poll. */
export const RPC_WAIT_MS = 20_000;
export const POLL_WAIT_MS = 20_000;
/** Commands the relay never forwards (they carry secrets meant for the local app only). */
export const LOCAL_ONLY_COMMANDS = new Set(["env.configure"]);

export type LinkRequest =
  | { kind: "rpc"; command: ClientCommand }
  | { kind: "poll"; cursors: Record<string, number>; globalCursor: number };

export type LinkParse = { ok: true; request: LinkRequest } | { ok: false; status: number; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseLinkRequest(body: unknown): LinkParse {
  if (!isRecord(body)) return { ok: false, status: 400, error: "Invalid input" };
  if (body.kind === "rpc") {
    const c = body.command;
    if (!isRecord(c) || typeof c.id !== "string" || !c.id || c.id.length > 200 || !isClientCommandType(c.type) || !isRecord(c.params)) {
      return { ok: false, status: 400, error: "Invalid command" };
    }
    if (LOCAL_ONLY_COMMANDS.has(c.type)) return { ok: false, status: 403, error: "That command only runs inside the Mac app." };
    return { ok: true, request: { kind: "rpc", command: c as unknown as ClientCommand } };
  }
  if (body.kind === "poll") {
    if (!isRecord(body.cursors)) return { ok: false, status: 400, error: "Invalid cursors" };
    const cursors: Record<string, number> = {};
    const entries = Object.entries(body.cursors);
    if (entries.length > 50) return { ok: false, status: 400, error: "Too many sessions" };
    for (const [k, v] of entries) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < -1 || k.length > 200) return { ok: false, status: 400, error: "Invalid cursors" };
      cursors[k] = v;
    }
    const g = body.globalCursor;
    const globalCursor = typeof g === "number" && Number.isInteger(g) && g >= -1 ? g : -1;
    return { ok: true, request: { kind: "poll", cursors, globalCursor } };
  }
  return { ok: false, status: 400, error: "Unknown kind" };
}

export interface LinkReplyBody {
  responses?: ServerResponse[];
  events?: ServerEventEnvelope[];
  offline?: boolean;
  message?: string;
}

/** Keep only well-formed responses/events from what the Mac acked. */
export function shapeReply(result: unknown): LinkReplyBody {
  if (!isRecord(result)) return {};
  const responses = Array.isArray(result.responses)
    ? (result.responses.filter((r) => isRecord(r) && r.type === "response" && typeof r.id === "string" && typeof r.ok === "boolean") as unknown as ServerResponse[])
    : undefined;
  const events = Array.isArray(result.events)
    ? (result.events.filter(
        (e) => isRecord(e) && e.type === "event" && typeof e.sequence === "number" && isRecord(e.event) && (e.stream === "session" || e.stream === "global"),
      ) as unknown as ServerEventEnvelope[])
    : undefined;
  return { ...(responses?.length ? { responses } : {}), ...(events?.length ? { events } : {}) };
}

export function offlineReply(deviceName?: string): LinkReplyBody {
  return { offline: true, message: `${deviceName ?? "Your Mac"} did not answer. Open Alevr on it, or check that it is awake.` };
}

/** The queue row for a request. Idempotency keys are unique per user. */
export function linkCommandRow(request: LinkRequest, nonce: string): { kind: string; payload: Record<string, unknown>; idempotencyKey: string } {
  if (request.kind === "rpc") return { kind: LINK_RPC_KIND, payload: { command: request.command }, idempotencyKey: `env-rpc:${request.command.id}:${nonce}` };
  return { kind: LINK_POLL_KIND, payload: { cursors: request.cursors, globalCursor: request.globalCursor, waitMs: POLL_WAIT_MS - 2_000 }, idempotencyKey: `env-poll:${nonce}` };
}
