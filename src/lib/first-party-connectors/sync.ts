import { ConnectorApiError, FirstPartyClient } from "./client";

export interface ConnectorChange {
  key: string;
  type: string;
  resourceId: string;
  payload: Record<string, unknown>;
}
export interface SyncCursor { position?: string; page?: string; newest?: string; established?: boolean; }
export interface SyncPage { cursor: SyncCursor; changes: ConnectorChange[]; more: boolean; reset?: boolean; }
interface Resource { id: string; [key: string]: unknown; }

/** One bounded page. Establish a baseline without firing events for old data. */
export async function readSyncPage(client: FirstPartyClient, state: SyncCursor, stream = "primary"): Promise<SyncPage> {
  const provider = client.provider;
  if (provider === "slack") throw new Error("Slack sync needs a channel stream");
  if (provider === "gmail") {
    if (!state.position) {
      const profile = await client.json<{ historyId: string }>("/gmail/v1/users/me/profile");
      if (!profile.historyId) throw new Error("Gmail did not return a history cursor");
      return { cursor: { position: profile.historyId, established: true }, changes: [], more: false };
    }
    try {
      const q = new URLSearchParams({ startHistoryId: state.position, maxResults: "100", ...(state.page ? { pageToken: state.page } : {}) });
      const data = await client.json<{ historyId: string; nextPageToken?: string; history?: Array<{ id: string; messagesAdded?: Array<{ message: Resource }>; messagesDeleted?: Array<{ message: Resource }>; labelsAdded?: Array<{ message: Resource }>; labelsRemoved?: Array<{ message: Resource }> }> }>(`/gmail/v1/users/me/history?${q}`);
      const changes = (data.history ?? []).flatMap((h) => (["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"] as const).flatMap((kind) => (h[kind] ?? []).map(({ message }) => ({ key: `${h.id}:${kind}:${message.id}`, type: kind === "messagesAdded" ? "message_received" : kind === "messagesDeleted" ? "message_deleted" : "message_changed", resourceId: message.id, payload: message }))));
      return { cursor: { established: true, position: data.nextPageToken ? state.position : data.historyId, page: data.nextPageToken }, changes, more: !!data.nextPageToken };
    } catch (error) {
      if (!(error instanceof ConnectorApiError) || error.status !== 404) throw error;
      return { ...(await readSyncPage(client, {}, stream)), reset: true };
    }
  }
  if (provider === "google-drive") {
    if (!state.position) {
      const start = await client.json<{ startPageToken: string }>("/drive/v3/changes/startPageToken");
      if (!start.startPageToken) throw new Error("Drive did not return a change cursor");
      return { cursor: { position: start.startPageToken, established: true }, changes: [], more: false };
    }
    const q = new URLSearchParams({ pageToken: state.position, pageSize: "100", fields: "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,modifiedTime,trashed,webViewLink))" });
    const data = await client.json<{ nextPageToken?: string; newStartPageToken?: string; changes?: Array<{ fileId: string; removed?: boolean; time?: string; file?: Resource }> }>(`/drive/v3/changes?${q}`);
    const next = data.nextPageToken ?? data.newStartPageToken;
    if (!next) throw new Error("Drive did not return the next change cursor");
    return { cursor: { position: next, established: true }, changes: (data.changes ?? []).map((c) => ({ key: `${state.position}:${c.fileId}:${c.time ?? ""}:${!!c.removed}`, type: c.removed || c.file?.trashed ? "file_deleted" : "file_changed", resourceId: c.fileId, payload: c.file ?? { id: c.fileId, removed: true } })), more: !!data.nextPageToken };
  }
  if (provider === "google-calendar") {
    const q = new URLSearchParams({ maxResults: "100", showDeleted: "true", ...(state.position ? { syncToken: state.position } : {}), ...(state.page ? { pageToken: state.page } : {}) });
    try {
      const data = await client.json<{ nextPageToken?: string; nextSyncToken?: string; items?: Resource[] }>(`/calendar/v3/calendars/${encodeURIComponent(stream)}/events?${q}`);
      if (!data.nextPageToken && !data.nextSyncToken) throw new Error("Calendar did not return a sync cursor");
      const established = state.established === true;
      return { cursor: { position: data.nextSyncToken ?? state.position, page: data.nextPageToken, established: established || !data.nextPageToken }, changes: established ? (data.items ?? []).map((r) => ({ key: `${r.id}:${r.etag ?? r.updated ?? state.position}`, type: r.status === "cancelled" ? "event_deleted" : "event_changed", resourceId: r.id, payload: r })) : [], more: !!data.nextPageToken };
    } catch (error) {
      if (!(error instanceof ConnectorApiError) || error.status !== 410) throw error;
      return { ...(await readSyncPage(client, {}, stream)), reset: true };
    }
  }
  // Microsoft next/delta links are followed verbatim after origin validation by
  // FirstPartyClient, preserving the opaque server state and query options.
  const initial = provider === "outlook" ? "/v1.0/me/mailFolders/inbox/messages/delta?$top=50&$select=id,subject,receivedDateTime,lastModifiedDateTime" : "/v1.0/me/drive/root/delta?$top=50&$select=id,name,file,folder,lastModifiedDateTime,deleted";
  try {
    const data = await client.json<{ "@odata.nextLink"?: string; "@odata.deltaLink"?: string; value?: Resource[] }>(state.page ?? state.position ?? initial);
    const next = data["@odata.nextLink"], delta = data["@odata.deltaLink"];
    if (!next && !delta) throw new Error("Microsoft did not return a delta cursor");
    return { cursor: { page: next, position: delta ?? state.position, established: state.established === true || !next }, changes: state.established ? (data.value ?? []).map((r) => ({ key: `${r.id}:${r.lastModifiedDateTime ?? JSON.stringify(r)}`, type: provider === "outlook" ? r["@removed"] ? "message_deleted" : "message_changed" : r.deleted ? "file_deleted" : "file_changed", resourceId: r.id, payload: r })) : [], more: !!next };
  } catch (error) {
    if (!(error instanceof ConnectorApiError) || ![404, 410].includes(error.status) || (!state.position && !state.page)) throw error;
    return { ...(await readSyncPage(client, {}, stream)), reset: true };
  }
}

/** Slack timestamps remain decimal strings; Number would lose their precision. */
export async function readSlackSyncPage(client: FirstPartyClient, state: SyncCursor, channel: string, nowMs = Date.now()): Promise<SyncPage> {
  if (!/^[A-Z0-9]{2,64}$/.test(channel)) throw new Error("Invalid Slack channel");
  if (!state.position) return { cursor: { position: `${Math.floor(nowMs / 1000)}.${String(nowMs % 1000).padStart(3, "0")}000`, established: true }, changes: [], more: false };
  const q = new URLSearchParams({ channel, oldest: state.position, inclusive: "false", limit: "100", ...(state.page ? { cursor: state.page } : {}) });
  const data = await client.json<{ messages?: Array<{ ts: string; [key: string]: unknown }>; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(`/api/conversations.history?${q}`);
  const messages = data.messages ?? [];
  const next = data.response_metadata?.next_cursor || undefined;
  if (data.has_more && !next) throw new Error("Slack did not return a continuation cursor");
  // While paging newest-first, retain the baseline and newest observed value.
  // The store buffers all pages before advancing the baseline (see sync-store).
  const newest = state.newest ?? messages[0]?.ts ?? state.position;
  return { cursor: { position: next ? state.position : newest, page: next, newest: next ? newest : undefined, established: true }, changes: messages.map((r) => ({ key: `${channel}:${r.ts}`, type: "message_received", resourceId: `${channel}:${r.ts}`, payload: { ...r, channel } })), more: !!next };
}
