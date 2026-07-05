import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getConnector } from "@/lib/connectors";
import { verifyConnectorToken } from "@/lib/connector-token";
import { decryptSecret } from "@/lib/crypto";
import * as caldav from "@/lib/apple/caldav";
import * as mail from "@/lib/apple/mail";
import * as music from "@/lib/apple/music";

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
}

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
    },
    {
      name: "list_events",
      description: `List events in a time range. Defaults to all calendars, from now to +${DEFAULT_RANGE_DAYS} days. Times are ISO 8601. Recurring events are flagged, not expanded.`,
      inputSchema: obj({
        calendar: { type: "string", description: "Calendar name; omit to search every calendar." },
        from: { type: "string", description: "Range start, ISO 8601. Defaults to now." },
        to: { type: "string", description: `Range end, ISO 8601. Defaults to ${DEFAULT_RANGE_DAYS} days from the start.` },
        limit: { type: "number", description: "Max events to return (default 25, max 50)." },
      }),
    },
    {
      name: "create_event",
      description: "Create a calendar event. Times are ISO 8601 (converted to UTC).",
      inputSchema: obj(
        {
          calendar: { type: "string", description: "Calendar name; defaults to the first calendar." },
          title: { type: "string" },
          start: { type: "string", description: "Start time, ISO 8601." },
          end: { type: "string", description: "End time, ISO 8601." },
          location: { type: "string" },
          notes: { type: "string" },
        },
        ["title", "start", "end"]
      ),
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
    },
  ],
  "apple-mail": [
    {
      name: "list_mailboxes",
      description: "List the user's iCloud Mail mailboxes (folders).",
      inputSchema: obj({}),
    },
    {
      name: "search_messages",
      description: "Search messages in a mailbox (default INBOX). Returns up to 25 newest matches with UIDs.",
      inputSchema: obj({
        mailbox: { type: "string", description: "Mailbox path; defaults to INBOX." },
        query: { type: "string", description: "Text to match in the subject or body." },
        from: { type: "string", description: "Match the From address." },
        since: { type: "string", description: "Only messages received on/after this date (ISO 8601)." },
        limit: { type: "number", description: "Max results (default 25, max 25)." },
      }),
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
    },
    {
      name: "unread_count",
      description: "Count unread messages in a mailbox (default INBOX).",
      inputSchema: obj({ mailbox: { type: "string", description: "Mailbox path; defaults to INBOX." } }),
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
    },
    {
      name: "list_playlists",
      description: "List the playlists in the user's Apple Music library.",
      inputSchema: obj({}),
    },
    {
      name: "recently_played",
      description: "List the user's recently played tracks.",
      inputSchema: obj({}),
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

async function resolveCalendar(creds: caldav.CalDavCredentials, name?: string): Promise<caldav.CalDavCalendar> {
  const calendars = await caldav.listCalendars(creds);
  if (calendars.length === 0) throw new Error("No calendars found on this iCloud account.");
  if (!name) return calendars[0];
  const t = name.toLowerCase();
  const hit = calendars.find((c) => c.name.toLowerCase() === t) ?? calendars.find((c) => c.name.toLowerCase().includes(t));
  if (!hit) throw new Error(`No calendar named “${name}”. Available: ${calendars.map((c) => c.name).join(", ")}.`);
  return hit;
}

function formatEvent(e: caldav.CalDavEvent, calendarName: string): string {
  const when = e.end ? `${e.start} → ${e.end}` : e.start;
  const extras = [e.location, e.recurring ? "recurring" : undefined].filter(Boolean).join(" · ");
  return `• ${e.summary} — ${when}${extras ? ` (${extras})` : ""} · uid: ${e.uid} · calendar: ${calendarName}`;
}

async function callCalendarTool(name: string, args: Record<string, unknown>, creds: StoredCredentials): Promise<string> {
  const c = appleCreds(creds);
  switch (name) {
    case "list_calendars": {
      const calendars = await caldav.listCalendars(c);
      if (calendars.length === 0) return "No calendars found on this iCloud account.";
      return `Calendars (${calendars.length}):\n${calendars.map((cal) => `• ${cal.name}`).join("\n")}`;
    }
    case "list_events": {
      const from = argStr(args, "from") ?? new Date().toISOString();
      const to = argStr(args, "to") ?? new Date(new Date(from).getTime() + DEFAULT_RANGE_DAYS * 86_400_000).toISOString();
      const limit = Math.min(Math.max(argNum(args, "limit") ?? 25, 1), 50);
      const calendarName = argStr(args, "calendar");
      const calendars = calendarName ? [await resolveCalendar(c, calendarName)] : await caldav.listCalendars(c);
      const results = await Promise.all(
        calendars.map(async (cal) => (await caldav.listEvents(c, cal.url, from, to)).map((e) => ({ e, cal: cal.name })))
      );
      const merged = results
        .flat()
        .sort((a, b) => a.e.start.localeCompare(b.e.start))
        .slice(0, limit);
      if (merged.length === 0) return `No events between ${from} and ${to}.`;
      return `Events between ${from} and ${to} (${merged.length}):\n${merged.map(({ e, cal }) => formatEvent(e, cal)).join("\n")}`;
    }
    case "create_event": {
      const cal = await resolveCalendar(c, argStr(args, "calendar"));
      const title = requireStr(args, "title");
      const { uid } = await caldav.createEvent(c, cal.url, {
        title,
        start: requireStr(args, "start"),
        end: requireStr(args, "end"),
        location: argStr(args, "location"),
        notes: argStr(args, "notes"),
      });
      return `Created “${title}” on ${cal.name} (uid: ${uid}).`;
    }
    case "delete_event": {
      const cal = await resolveCalendar(c, requireStr(args, "calendar"));
      const uid = requireStr(args, "uid");
      await caldav.deleteEvent(c, cal.url, uid);
      return `Deleted event ${uid} from ${cal.name}.`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function callMailTool(name: string, args: Record<string, unknown>, creds: StoredCredentials): Promise<string> {
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
      const since = sinceStr ? new Date(sinceStr) : undefined;
      if (since && Number.isNaN(since.getTime())) throw new Error(`Invalid ISO 8601 date: ${sinceStr}`);
      const mailbox = argStr(args, "mailbox") ?? "INBOX";
      const messages = await mail.searchMessages(c, {
        mailbox,
        query: argStr(args, "query"),
        from: argStr(args, "from"),
        since,
        limit: argNum(args, "limit"),
      });
      if (messages.length === 0) return `No matching messages in ${mailbox}.`;
      return `Messages in ${mailbox} (${messages.length}, newest first):\n${messages
        .map((m) => `• [uid ${m.uid}] ${m.subject} — from ${m.from ?? "unknown"}${m.date ? ` · ${m.date}` : ""}${m.seen ? "" : " · unread"}`)
        .join("\n")}`;
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

async function callTool(connectorId: string, name: string, args: Record<string, unknown>, creds: StoredCredentials): Promise<string> {
  if (connectorId === "apple-calendar") return callCalendarTool(name, args, creds);
  if (connectorId === "apple-mail") return callMailTool(name, args, creds);
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

async function handleMessage(msg: JsonRpcMessage, connectorId: string, creds: StoredCredentials): Promise<object | null> {
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
        const text = await callTool(connectorId, name, args, creds);
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

  // JSON response mode per the MCP streamable-http spec — no SSE stream needed.
  if (Array.isArray(body)) {
    const responses = (
      await Promise.all(body.map((m) => handleMessage(m as JsonRpcMessage, connector, creds)))
    ).filter((r): r is object => r !== null);
    if (responses.length === 0) return new Response(null, { status: 202 });
    return NextResponse.json(responses);
  }

  const response = await handleMessage(body as JsonRpcMessage, connector, creds);
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
