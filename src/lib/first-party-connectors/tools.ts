import { z } from "zod";
import { boundedText, FirstPartyClient } from "./client";
import type { FirstPartyId } from "./providers";

const id = z.string().trim().min(1).max(1024);
const page = { pageToken: z.string().max(8192).optional(), limit: z.number().int().min(1).max(100).default(25) };
const text = z.string().max(200_000);
const draft = z.strictObject({ to: z.array(z.email()).min(1).max(50), subject: z.string().max(500).refine((v) => !/[\r\n]/.test(v)), body: text });
const event = z.strictObject({ calendarId: id.default("primary"), title: z.string().min(1).max(500), start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }), description: text.optional() }).refine((v) => Date.parse(v.end) > Date.parse(v.start), { message: "End must follow start" });

interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  read: boolean;
  call(client: FirstPartyClient, args: unknown): Promise<unknown>;
}

const tool = <T extends z.ZodType>(name: string, description: string, schema: T, read: boolean, call: (c: FirstPartyClient, a: z.output<T>) => Promise<unknown>): Tool => ({ name, description, schema, read, call: (c, a) => call(c, schema.parse(a)) });
const query = (path: string, params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) q.set(key, String(value));
  return `${path}?${q}`;
};
const enc = encodeURIComponent;

export function gmailRawMessage(args: z.output<typeof draft>): string {
  const a = draft.parse(args);
  const subject = `=?UTF-8?B?${Buffer.from(a.subject).toString("base64")}?=`;
  const body = Buffer.from(a.body).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  return Buffer.from(`To: ${a.to.join(", ")}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`).toString("base64url");
}

const gmailTools = [
  tool("search_messages", "Search Gmail. Returns message IDs and a page cursor; read a message for its content.", z.strictObject({ query: z.string().max(2000).default(""), ...page }), true,
    (c, a) => c.json(query("/gmail/v1/users/me/messages", { q: a.query, maxResults: a.limit, pageToken: a.pageToken }))),
  tool("read_message", "Read a Gmail message and its MIME parts.", z.strictObject({ messageId: id }), true,
    (c, a) => c.json(`/gmail/v1/users/me/messages/${enc(a.messageId)}?format=full`)),
  tool("draft_message", "Create a Gmail draft. This does not send it.", draft, false,
    (c, a) => c.json("/gmail/v1/users/me/drafts", { message: { raw: gmailRawMessage(a) } })),
  tool("send_draft", "Send an existing Gmail draft. Requires the user's approval.", z.strictObject({ draftId: id }), false,
    (c, a) => c.json("/gmail/v1/users/me/drafts/send", { id: a.draftId })),
];
const calendarTools = [
  tool("list_calendars", "List Google calendars.", z.strictObject({ ...page }), true,
    (c, a) => c.json(query("/calendar/v3/users/me/calendarList", { maxResults: a.limit, pageToken: a.pageToken }))),
  tool("search_events", "List Google calendar events in a time range.", z.strictObject({ calendarId: id.default("primary"), query: z.string().max(2000).optional(), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(), ...page }), true,
    (c, a) => c.json(query(`/calendar/v3/calendars/${enc(a.calendarId)}/events`, { q: a.query, timeMin: a.from, timeMax: a.to, maxResults: a.limit, pageToken: a.pageToken, singleEvents: "true" }))),
  tool("read_event", "Read a Google calendar event.", z.strictObject({ calendarId: id.default("primary"), eventId: id }), true,
    (c, a) => c.json(`/calendar/v3/calendars/${enc(a.calendarId)}/events/${enc(a.eventId)}`)),
  tool("create_event", "Create an event on a Google calendar, with your permission.", event, false,
    (c, a) => c.json(`/calendar/v3/calendars/${enc(a.calendarId)}/events`, { summary: a.title, start: { dateTime: a.start }, end: { dateTime: a.end }, description: a.description })),
];
const driveTools = [
  tool("search_files", "Search Google Drive using the Drive query syntax. Returns file IDs and a page cursor.", z.strictObject({ query: z.string().max(2000).default("trashed = false"), ...page }), true,
    (c, a) => c.json(query("/drive/v3/files", { q: a.query, pageSize: a.limit, pageToken: a.pageToken, fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,trashed)" }))),
  tool("read_file", "Read a Google Drive file. Exports Google Docs and Slides as text, Sheets as CSV. Other text files are downloaded with a size limit.", z.strictObject({ fileId: id }), true, async (c, a) => {
    const meta = await c.json<{ mimeType: string; name: string }>(`/drive/v3/files/${enc(a.fileId)}?fields=id,name,mimeType,size`);
    const format = meta.mimeType === "application/vnd.google-apps.spreadsheet" ? "text/csv" : "text/plain";
    const native = ["application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", "application/vnd.google-apps.presentation"].includes(meta.mimeType);
    if (!native && !meta.mimeType.startsWith("text/") && meta.mimeType !== "application/json") return { ...meta, note: "This file format cannot be read as text." };
    const res = await c.request(native ? `/drive/v3/files/${enc(a.fileId)}/export?mimeType=${enc(format)}` : `/drive/v3/files/${enc(a.fileId)}?alt=media`);
    return { name: meta.name, text: await boundedText(res) };
  }),
];
const outlookTools = [
  tool("search_messages", "Search Outlook mail. Returns a continuation URL when there are more results.", z.strictObject({ query: z.string().max(2000).optional(), ...page }), true,
    (c, a) => c.json(a.pageToken ?? query("/v1.0/me/messages", { "$search": a.query ? JSON.stringify(a.query) : undefined, "$top": a.limit, "$select": "id,subject,from,receivedDateTime,bodyPreview,isDraft,webLink" }))),
  tool("read_message", "Read an Outlook message.", z.strictObject({ messageId: id }), true,
    (c, a) => c.json(`/v1.0/me/messages/${enc(a.messageId)}`)),
  tool("draft_message", "Create an Outlook draft. This does not send it.", draft, false,
    (c, a) => c.json("/v1.0/me/messages", { subject: a.subject, body: { contentType: "Text", content: a.body }, toRecipients: a.to.map((address) => ({ emailAddress: { address } })) })),
  tool("send_draft", "Send an existing Outlook draft. Requires the user's approval.", z.strictObject({ draftId: id }), false,
    (c, a) => c.json(`/v1.0/me/messages/${enc(a.draftId)}/send`, {})),
  tool("list_calendars", "List Outlook calendars.", z.strictObject({ ...page }), true, (c, a) => c.json(a.pageToken ?? query("/v1.0/me/calendars", { "$top": a.limit }))),
  tool("search_events", "Read events in an Outlook calendar time range.", z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), ...page }), true,
    (c, a) => c.json(a.pageToken ?? query("/v1.0/me/calendarView", { startDateTime: a.from, endDateTime: a.to, "$top": a.limit }))),
  tool("create_event", "Create an Outlook calendar event, with your permission.", event, false,
    (c, a) => c.json(a.calendarId === "primary" ? "/v1.0/me/events" : `/v1.0/me/calendars/${enc(a.calendarId)}/events`, { subject: a.title, start: { dateTime: new Date(a.start).toISOString().replace(/Z$/, ""), timeZone: "UTC" }, end: { dateTime: new Date(a.end).toISOString().replace(/Z$/, ""), timeZone: "UTC" }, body: { contentType: "Text", content: a.description ?? "" } })),
];
const microsoftTools = [
  tool("search_files", "Search your OneDrive files.", z.strictObject({ query: z.string().min(1).max(1000), ...page }), true,
    (c, a) => c.json(a.pageToken ?? query(`/v1.0/me/drive/root/search(q='${enc(a.query.replace(/'/g, "''"))}')`, { "$top": a.limit }))),
  tool("search_sites", "Search SharePoint sites you can access.", z.strictObject({ query: z.string().min(1).max(1000) }), true,
    (c, a) => c.json(query("/v1.0/sites", { search: a.query }))),
  tool("list_files", "List files in OneDrive or a SharePoint drive. Use a site's drives to choose its drive ID.", z.strictObject({ driveId: id.optional(), folderId: id.default("root"), ...page }), true,
    (c, a) => c.json(a.pageToken ?? query(`/v1.0/${a.driveId ? `drives/${enc(a.driveId)}` : "me/drive"}/${a.folderId === "root" ? "root" : `items/${enc(a.folderId)}`}/children`, { "$top": a.limit }))),
  tool("read_file", "Read a OneDrive or SharePoint text file, or metadata for other formats, including its browser link.", z.strictObject({ driveId: id.optional(), fileId: id }), true, async (c, a) => {
    const path = `/v1.0/${a.driveId ? `drives/${enc(a.driveId)}` : "me/drive"}/items/${enc(a.fileId)}`;
    const meta = await c.json<{ name: string; file?: { mimeType?: string }; size?: number }>(`${path}?$select=id,name,size,webUrl,file,folder,lastModifiedDateTime`);
    const mime = meta.file?.mimeType ?? "";
    if (!mime.startsWith("text/") && mime !== "application/json") return { ...meta, note: "This file format cannot be read as text." };
    if (meta.size && meta.size > 500_000) throw new Error("This file is too large to read");
    return { ...meta, text: await boundedText(await c.request(`${path}/content`, undefined, "GET", true)) };
  }),
  tool("list_site_drives", "List a SharePoint site's document libraries.", z.strictObject({ siteId: id }), true, (c, a) => c.json(`/v1.0/sites/${enc(a.siteId)}/drives`)),
];
const slackTools = [
  tool("search_messages", "Search Slack messages visible to your connected account.", z.strictObject({ query: z.string().min(1).max(2000), page: z.number().int().min(1).max(100).default(1), limit: z.number().int().min(1).max(100).default(25) }), true,
    (c, a) => c.json(query("/api/search.messages", { query: a.query, page: a.page, count: a.limit }))),
  tool("list_channels", "List Slack conversations visible to your connected account.", z.strictObject({ ...page }), true,
    (c, a) => c.json(query("/api/conversations.list", { types: "public_channel,private_channel,mpim,im", cursor: a.pageToken, limit: a.limit }))),
  tool("read_channel", "Read a page of Slack channel history.", z.strictObject({ channelId: id, ...page }), true,
    (c, a) => c.json(query("/api/conversations.history", { channel: a.channelId, cursor: a.pageToken, limit: a.limit }))),
  tool("post_message", "Post a Slack message. Requires the user's approval.", z.strictObject({ channelId: id, text: z.string().min(1).max(40_000), threadTs: z.string().regex(/^\d+\.\d+$/).optional() }), false,
    (c, a) => c.json("/api/chat.postMessage", { channel: a.channelId, text: a.text, thread_ts: a.threadTs, unfurl_links: false, unfurl_media: false })),
];

const tools: Record<FirstPartyId, Tool[]> = { gmail: gmailTools, "google-calendar": calendarTools, "google-drive": driveTools, outlook: outlookTools, "microsoft-365": microsoftTools, slack: slackTools };
export function firstPartyTools(provider: FirstPartyId) {
  return tools[provider].map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema, { io: "input" }), annotations: { readOnlyHint: t.read, destructiveHint: false, openWorldHint: !t.read } }));
}
export async function callFirstPartyTool(client: FirstPartyClient, name: string, args: unknown): Promise<unknown> {
  const found = tools[client.provider].find((t) => t.name === name);
  if (!found) throw new Error("Unknown connected app tool");
  return found.call(client, args);
}
