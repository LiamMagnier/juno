/**
 * Browser-side request validation for the hosted web ↔ Mac env-server relay
 * (`POST /api/code/v2/link/[deviceId]`), the server half of
 * `DeviceLinkTransport` (env-client.ts). The relay itself is the in-memory
 * hub in env-link-hub.ts; the Mac pulls relayed commands from and pushes its
 * env server's answers to `/api/code/v2/link/[deviceId]/host`
 * (docs/code-v2/DEVICE-LINK.md).
 *
 *   web  POST {kind:"rpc", command}               → hub → Mac pull → env server
 *   web  POST {kind:"poll", cursors, globalCursor} → events the Mac pushed after those cursors
 *   web  ← LinkReply {responses?, events?} or {offline:true, message}
 *
 * This file only parses and validates what the browser sends (strictly, so a
 * malformed request is a 4xx before it reaches the hub) and words the offline
 * reply. Pure; the route does the I/O.
 */
import { isClientCommandType, type ClientCommand } from "@/lib/code-v2/contracts";
import type { LinkReply } from "@/lib/code-v2/env-link-hub";

/** Commands the browser may never send (they carry secrets meant for the local app only). */
export const LOCAL_ONLY_COMMANDS = new Set(["env.configure"]);

/**
 * Commands only Alevr's backend sends over the link, never a browser: a
 * message from another conversation is written by the cross-conversation hub
 * (src/lib/cross-conversation/store.ts) after its ownership, hop and rate
 * checks, so a page cannot forge one.
 */
export const BACKEND_ONLY_COMMANDS = new Set(["conversation.deliver"]);

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
    if (BACKEND_ONLY_COMMANDS.has(c.type)) return { ok: false, status: 403, error: "Only another conversation can send that." };
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

/** The hub's offline reply, worded with the computer's own name. */
export function offlineReply(deviceName?: string): LinkReply {
  return { offline: true, message: `${deviceName ?? "Your Mac"} did not answer. Open Alevr on it, or check that it is awake.` };
}
