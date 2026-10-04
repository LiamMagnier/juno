import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CONNECTOR_TIME_ZONE_HEADER, getConnector } from "@/lib/connectors";
import { verifyConnectorToken } from "@/lib/connector-token";
import { decryptSecret } from "@/lib/crypto";
import * as caldav from "@/lib/apple/caldav";
import * as mail from "@/lib/apple/mail";
import * as music from "@/lib/apple/music";
import { formatInZone, isIanaZone, parseUserInstant, resolveWindow } from "@/lib/apple/ical";
import { renderEventSearch, type CallContext } from "@/lib/apple/tool-text";

export const runtime = "nodejs";
export const maxDuration = 60;

/*
 * A minimal, stateless Streamable-HTTP MCP server for credentials-kind
 * connectors (Apple Calendar / Mail / Music). Speaks plain JSON-RPC over POST
 * (JSON response mode — allowed by the streamable-http spec) and implements
 * initialize, tools/list, and tools/call. Auth is a short-lived signed
 * connector token (lib/connector-token.ts); the real iCloud credential is
 * decrypted here, per call, and never leaves this process.
 */

const LATEST_PROTOCOL = "2025-06-18";
const KNOWN_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const DEFAULT_RANGE_DAYS = 14;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * MCP tool annotations. Declared on EVERY tool here, reads included: a client
   * cannot tell "this server says nothing about its tools" from "this server
   * says this tool is a write" unless the reads are labelled too. src/lib/mcp.ts
   * reads these back and src/lib/tool-access.ts classifies from them, so the
   * connectors Juno itself operates never fall through to the name heuristic.
   */
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
}

const READS = { readOnlyHint: true } as const;
/** A write that only adds. */
const WRITES = { readOnlyHint: false, destructiveHint: false } as const;
/** A write that removes or overwrites something the user already had. */
const DESTROYS = { readOnlyHint: false, destructiveHint: true } as const;

const obj = (properties: Record<string, unknown>, required?: string[]): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required && required.length > 0 ? { required } : {}),
});

const TOOLS: Record<string, ToolSpec[]> = {
  "apple-calendar": [
    {
      name: "list_calendars",
      description: "List the user's iCloud calendars by name.",
      inputSchema: obj({}),
      annotations: READS,
    },
    {
      name: "list_events",
      description:
        `List events in a time range across the user's iCloud calendars, including calendars they subscribed to with iCloud as the location. ` +
        `Recurring events are expanded: each occurrence in the range is listed on its own date. ` +
        `Give dates as the user means them: "2026-10-05" is that whole day on the user's clock, "2026-10-05T09:00" is 09:00 their time; ` +
        `an explicit Z or offset is taken as an exact instant. Results are shown in the user's time zone. ` +
        `Defaults to every calendar, from now to +${DEFAULT_RANGE_DAYS} days.`,
      inputSchema: obj({
        calendar: { type: "string", description: "Calendar name; omit to search every calendar." },
        from: { type: "string", description: "Range start: YYYY-MM-DD (start of that day, user's time) or ISO 8601. Defaults to now." },
        to: {
          type: "string",
          description: `Range end: YYYY-MM-DD (end of that day, inclusive, user's time) or ISO 8601. Defaults to ${DEFAULT_RANGE_DAYS} days after the start.`,
        },
        limit: { type: "number", description: `Max events to return (default ${DEFAULT_EVENT_LIMIT}, max ${MAX_EVENT_LIMIT}).` },
      }),
      annotations: READS,
    },
    {
      name: "create_event",
      description:
        "Create a calendar event. Times are ISO 8601; a time without Z or an offset is read on the user's clock (their time zone).",
      inputSchema: obj(
        {
          calendar: { type: "string", description: "Calendar name; defaults to the first calendar that accepts new events." },
          title: { type: "string" },
          start: { type: "string", description: "Start time, ISO 8601 (user's time unless it carries Z or an offset)." },
          end: { type: "string", description: "End time, ISO 8601 (user's time unless it carries Z or an offset)." },
          location: { type: "string" },
          notes: { type: "string" },
        },
        ["title", "start", "end"]
      ),
      annotations: WRITES,
    },
    {
      name: "delete_event",
      description: "Delete an event by UID from a named calendar.",
      inputSchema: obj(
        {
          calendar: { type: "string", description: "Calendar name the event lives in." },
          uid: { type: "string", description: "Event UID (from list_events)." },
        },
        ["calendar", "uid"]
      ),
      annotations: DESTROYS,
    },
  ],
  "apple-mail": [
    {
      name: "list_mailboxes",
      description: "List the user's iCloud Mail mailboxes (folders).",
      inputSchema: obj({}),
      annotations: READS,
    },
    {
      name: "search_messages",
      description:
        'Search messages in one mailbox (default INBOX), or in every mailbox except Trash, Junk and Drafts with mailbox "all". Returns the newest matches with their mailbox and UID.',
      inputSchema: obj({
        mailbox: {
          type: "string",
          description: 'Mailbox path or name ("Sent", "Archive" work too), or "all". Defaults to INBOX.',
        },
        query: { type: "string", description: "Text to match in the subject or body." },
        from: { type: "string", description: "Match the From address." },
        since: {
          type: "string",
          description: "Only messages received on/after this: YYYY-MM-DD (start of that day, user's time) or ISO 8601.",
        },
        limit: { type: "number", description: "Max results (default 25, max 50)." },
      }),
      annotations: READS,
    },
    {
      name: "read_message",
      description: "Read one message (headers + plain-text body) by UID.",
      inputSchema: obj(
        {
          mailbox: { type: "string", description: "Mailbox path the message lives in." },
          uid: { type: "number", description: "Message UID (from search_messages)." },
        },
        ["mailbox", "uid"]
      ),
      annotations: READS,
    },
    {
      name: "unread_count",
      description: "Count unread messages in a mailbox (default INBOX).",
      inputSchema: obj({ mailbox: { type: "string", description: "Mailbox path; defaults to INBOX." } }),
      annotations: READS,
    },
  ],
  "apple-music": [
    {
      name: "search_catalog",
      description: "Search the Apple Music catalog for songs, albums, artists, or playlists.",
      inputSchema: obj(
        {
          query: { type: "string" },
          types: {
            type: "array",
            items: { type: "string", enum: ["songs", "albums", "artists", "playlists"] },
            description: "Result types to include; defaults to all four.",
          },
        },
        ["query"]
      ),
      annotations: READS,
    },
    {
      name: "list_playlists",
      description: "List the playlists in the user's Apple Music library.",
      inputSchema: obj({}),
      annotations: READS,
    },
    {
      name: "recently_played",
      description: "List the user's recently played tracks.",
      inputSchema: obj({}),
      annotations: READS,
    },
    {
      name: "add_to_playlist",
      description: "Add catalog songs to one of the user's playlists.",
      inputSchema: obj(
        {
          playlistId: { type: "string", description: "Library playlist id (from list_playlists)." },
          songIds: { type: "array", items: { type: "string" }, description: "Catalog song ids (from search_catalog)." },
        },
        ["playlistId", "songIds"]
      ),
      annotations: WRITES,
    },
  ],
};

/* ---------- arg helpers ---------- */

function argStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function argStrArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const v = argStr(args, key);
  if (!v) throw new Error(`Missing required argument: ${key}`);
  return v;
}

/* ---------- tool dispatch ---------- */

interface StoredCredentials {
  appleId?: string;
  appPassword?: string;
  musicUserToken?: string;
}

function appleCreds(creds: StoredCredentials): { appleId: string; appPassword: string } {
  if (!creds.appleId || !creds.appPassword) throw new Error("This connection is missing its Apple credentials — reconnect it.");
  return { appleId: creds.appleId, appPassword: creds.appPassword };
}

function writableCalendars(calendars: caldav.CalDavCalendar[]): caldav.CalDavCalendar[] {
  // A subscription's events belong to its feed; iCloud refuses writes to it.
  return calendars.filter((c) => c.kind === "calendar");
}

async function resolveWritableCalendar(creds: caldav.CalDavCredentials, name?: string): Promise<caldav.CalDavCalendar> {
  const calendars = writableCalendars(await caldav.listCalendars(creds));
  if (calendars.length === 0) throw new Error("No calendars on this iCloud account accept new events.");
  return name ? caldav.pickCalendar(calendars, name) : calendars[0];
}

async function callCalendarTool(
  name: string,
  args: Record<string, unknown>,
  creds: StoredCredentials,
  ctx: CallContext
): Promise<string> {
  const c = appleCreds(creds);
  switch (name) {
    case "list_calendars": {
      const home = await caldav.listCalendarHome(c);
      if (home.calendars.length === 0) return "No event calendars found on this iCloud account.";
      const lines = home.calendars.map((cal) => `• ${cal.name}${cal.kind === "subscribed" ? " (subscribed, read-only)" : ""}`);
      const skipped = home.skipped.map((s) => `• ${s.name} — not listed: ${s.reason}`);
      return `Calendars (${home.calendars.length}):\n${[...lines, ...skipped].join("\n")}`;
    }
    case "list_events": {
      const window = resolveWindow(argStr(args, "from"), argStr(args, "to"), ctx.zone, Date.now(), DEFAULT_RANGE_DAYS);
      const limit = Math.min(Math.max(Math.floor(argNum(args, "limit") ?? DEFAULT_EVENT_LIMIT), 1), MAX_EVENT_LIMIT);
      const result = await caldav.searchEvents(c, {
        fromMs: window.fromMs,
        toMs: window.toMs,
        zone: ctx.zone,
        calendar: argStr(args, "calendar"),
      });
      return renderEventSearch(result, window, ctx, limit);
    }
    case "create_event": {
      const cal = await resolveWritableCalendar(c, argStr(args, "calendar"));
      const title = requireStr(args, "title");
      const startRaw = requireStr(args, "start");
      const endRaw = requireStr(args, "end");
      const startMs = parseUserInstant(startRaw, ctx.zone, "start");
      // A bare end date means "through that day".
      const endMs = parseUserInstant(endRaw, ctx.zone, "end");
      if (startMs === null) throw new Error(`Invalid start date: ${startRaw}`);
      if (endMs === null) throw new Error(`Invalid end date: ${endRaw}`);
      const { uid } = await caldav.createEvent(c, cal.url, {
        title,
        startMs,
        endMs,
        location: argStr(args, "location"),
        notes: argStr(args, "notes"),
      });
      return `Created “${title}” on ${cal.name}, ${formatInZone(startMs, ctx.zone)} → ${formatInZone(endMs, ctx.zone)} (uid: ${uid}).`;
    }
    case "delete_event": {
      const calendars = writableCalendars(await caldav.listCalendars(c));
      const cal = caldav.pickCalendar(calendars, requireStr(args, "calendar"));
      const uid = requireStr(args, "uid");
      await caldav.deleteEvent(c, cal.url, uid);
      return `Deleted event ${uid} from ${cal.name}.`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function callMailTool(
  name: string,
  args: Record<string, unknown>,
  creds: StoredCredentials,
  ctx: CallContext
): Promise<string> {
  const c = appleCreds(creds);
  switch (name) {
    case "list_mailboxes": {
      const boxes = await mail.listMailboxes(c);
      if (boxes.length === 0) return "No mailboxes found.";
      return `Mailboxes (${boxes.length}):\n${boxes
        .map((b) => `• ${b.path}${b.specialUse ? ` (${b.specialUse.replace(/^\\/, "")})` : ""}`)
        .join("\n")}`;
    }
    case "search_messages": {
      const sinceStr = argStr(args, "since");
      const sinceMs = sinceStr ? parseUserInstant(sinceStr, ctx.zone, "start") : null;
      if (sinceStr && sinceMs === null) throw new Error(`Invalid date: ${sinceStr}`);
      const result = await mail.searchMessages(c, {
        mailbox: argStr(args, "mailbox"),
        query: argStr(args, "query"),
        from: argStr(args, "from"),
        since: sinceMs === null ? undefined : new Date(sinceMs),
        limit: argNum(args, "limit"),
      });
      const where = result.searched.length === 1 ? result.searched[0] : `${result.searched.length} mailboxes`;
      if (result.messages.length === 0) {
        const others = result.available.filter((p) => !result.searched.includes(p));
        return [
          `No matching messages in ${where}.`,
          others.length > 0 && result.searched.length === 1
            ? `Not searched: ${others.join(", ")}. Pass mailbox (or "all") to look there.`
            : null,
        ]
          .filter(Boolean)
          .join("\n");
      }
      const more = result.total - result.messages.length;
      return [
        `Messages in ${where} (${result.messages.length}${more > 0 ? ` of ${result.total}` : ""}, newest first):`,
        ...result.messages.map(
          (m) =>
            `• [${result.searched.length > 1 ? `${m.mailbox} · ` : ""}uid ${m.uid}] ${m.subject} — from ${m.from ?? "unknown"}${
              m.date ? ` · ${formatInZone(Date.parse(m.date), ctx.zone)}` : ""
            }${m.seen ? "" : " · unread"}`
        ),
        ...(more > 0 ? [`…${more} older match${more === 1 ? "" : "es"} not shown; narrow the search to see them.`] : []),
      ].join("\n");
    }
    case "read_message": {
      const mailbox = requireStr(args, "mailbox");
      const uid = argNum(args, "uid");
      if (uid === undefined) throw new Error("Missing required argument: uid");
      const msg = await mail.readMessage(c, mailbox, uid);
      if (!msg) return `No message with uid ${uid} in ${mailbox}.`;
      const headers = [
        `Subject: ${msg.subject}`,
        `From: ${msg.from ?? "unknown"}`,
        msg.to ? `To: ${msg.to}` : null,
        msg.date ? `Date: ${msg.date}` : null,
      ].filter(Boolean);
      const body = msg.text ? msg.text.slice(0, 8000) : "(no readable text body)";
      return `${headers.join("\n")}\n\n${body}`;
    }
    case "unread_count": {
      const mailbox = argStr(args, "mailbox") ?? "INBOX";
      const count = await mail.unreadCount(c, mailbox);
      return `${count} unread message${count === 1 ? "" : "s"} in ${mailbox}.`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function callMusicTool(name: string, args: Record<string, unknown>, creds: StoredCredentials): Promise<string> {
  const token = creds.musicUserToken;
  if (!token) throw new Error("This connection is missing its Apple Music user token — reconnect it.");
  switch (name) {
    case "search_catalog": {
      const query = requireStr(args, "query");
      const results = await music.searchCatalog(token, query, argStrArray(args, "types"));
      const sections = Object.entries(results);
      if (sections.length === 0) return `No results for “${query}”.`;
      return sections
        .map(
          ([type, items]) =>
            `${type[0].toUpperCase()}${type.slice(1)}:\n${items
              .map((i) => `• ${i.name}${i.detail ? ` — ${i.detail}` : ""} · id: ${i.id}`)
              .join("\n")}`
        )
        .join("\n\n");
    }
    case "list_playlists": {
      const playlists = await music.listPlaylists(token);
      if (playlists.length === 0) return "No playlists in this library.";
      return `Playlists (${playlists.length}):\n${playlists.map((p) => `• ${p.name} · id: ${p.id}`).join("\n")}`;
    }
    case "recently_played": {
      const tracks = await music.getRecentlyPlayed(token);
      if (tracks.length === 0) return "No recently played tracks.";
      return `Recently played (${tracks.length}):\n${tracks.map((t) => `• ${t.name}${t.detail ? ` — ${t.detail}` : ""}`).join("\n")}`;
    }
    case "add_to_playlist": {
      const playlistId = requireStr(args, "playlistId");
      const songIds = argStrArray(args, "songIds");
      if (!songIds) throw new Error("Missing required argument: songIds");
      await music.addToPlaylist(token, playlistId, songIds);
      return `Added ${songIds.length} song${songIds.length === 1 ? "" : "s"} to the playlist.`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function callTool(
  connectorId: string,
  name: string,
  args: Record<string, unknown>,
  creds: StoredCredentials,
  ctx: CallContext
): Promise<string> {
  if (connectorId === "apple-calendar") return callCalendarTool(name, args, creds, ctx);
  if (connectorId === "apple-mail") return callMailTool(name, args, creds, ctx);
  if (connectorId === "apple-music") return callMusicTool(name, args, creds);
  throw new Error(`Unknown connector: ${connectorId}`);
}

/* ---------- JSON-RPC plumbing ---------- */

function rpcResult(id: number | string | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(
  msg: JsonRpcMessage,
  connectorId: string,
  creds: StoredCredentials,
  ctx: CallContext
): Promise<object | null> {
  const { method, params } = msg;
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined || method?.startsWith("notifications/");
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(id, {
        protocolVersion: KNOWN_PROTOCOLS.has(requested) ? requested : LATEST_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: `juno-${connectorId}`, version: "1.0.0" },
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS[connectorId] ?? [] });
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS[connectorId]?.some((t) => t.name === name)) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const text = await callTool(connectorId, name, args, creds, ctx);
        return rpcResult(id, { content: [{ type: "text", text: text.slice(0, 30_000) }] });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return rpcResult(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ connector: string }> }) {
  const { connector } = await params;
  const def = getConnector(connector);
  if (!def || def.kind !== "credentials") {
    return NextResponse.json(rpcError(null, -32600, "Unknown connector"), { status: 404 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const payload = bearer ? verifyConnectorToken(bearer) : null;
  if (!payload || payload.connectorId !== connector) {
    return NextResponse.json(rpcError(null, -32001, "Unauthorized"), { status: 401 });
  }

  const row = await prisma.connection.findUnique({
    where: { userId_provider: { userId: payload.userId, provider: connector } },
  });
  if (!row) return NextResponse.json(rpcError(null, -32001, "Connector is not linked"), { status: 401 });

  let creds: StoredCredentials;
  try {
    creds = JSON.parse(decryptSecret(row.accessToken)) as StoredCredentials;
  } catch {
    return NextResponse.json(rpcError(null, -32001, "Stored credentials are unreadable — reconnect this app"), { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  // The caller's zone (sent by lib/mcp.ts from the chat request) decides what
  // "the 5th" and "09:00" mean; without one, UTC stands in and the answer says so.
  const requestedZone = req.headers.get(CONNECTOR_TIME_ZONE_HEADER)?.trim() ?? "";
  const zoneKnown = requestedZone.length > 0 && requestedZone.length <= 64 && isIanaZone(requestedZone);
  const ctx: CallContext = { zone: zoneKnown ? requestedZone : "UTC", zoneKnown };

  // JSON response mode per the MCP streamable-http spec — no SSE stream needed.
  if (Array.isArray(body)) {
    const responses = (
      await Promise.all(body.map((m) => handleMessage(m as JsonRpcMessage, connector, creds, ctx)))
    ).filter((r): r is object => r !== null);
    if (responses.length === 0) return new Response(null, { status: 202 });
    return NextResponse.json(responses);
  }

  const response = await handleMessage(body as JsonRpcMessage, connector, creds, ctx);
  if (!response) return new Response(null, { status: 202 });
  return NextResponse.json(response);
}

// No server-initiated stream (GET) and no session to terminate (DELETE).
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
