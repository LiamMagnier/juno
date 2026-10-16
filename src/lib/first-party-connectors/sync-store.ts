import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { FirstPartyClient } from "./client";
import { firstPartyAccessToken } from "./tokens";
import { isFirstPartyId, type FirstPartyId } from "./providers";
import { readSlackSyncPage, readSyncPage, type SyncCursor } from "./sync";
import type { ConnectorTriggerEvent } from "@/lib/work/triggers";
import { authorizeExternalAction, completeExternalAction } from "@/lib/action-approval-store";
import { recordToolInvocation, settleToolInvocation } from "@/lib/tool-audit";

/** Commit events and the next cursor together; a failed page is safe to retry. */
export async function syncFirstParty(userId: string, provider: FirstPartyId, stream = "primary", fetcher: typeof fetch = fetch) {
  if (stream.length > 256 || !stream.trim()) throw new Error("Invalid sync stream");
  const functionName = `${provider}__read_changes`;
  const auditId = await recordToolInvocation({ userId, connectorId: provider, toolName: "read_changes", functionName, access: "read", args: { stream }, derivedFromUntrusted: false, status: "pending" });
  const authorization = await authorizeExternalAction({
    userId, connectorId: provider, connectorLabel: provider, toolName: "read_changes", functionName,
    surface: "trigger", sessionId: `connector-sync:${provider}:${stream}`, callId: randomUUID(),
    annotations: { readOnlyHint: true }, args: { stream }, unattended: true,
    provenance: { source: "connector_sync", sourceKind: "connector_event", derivedFromUntrusted: false },
  });
  if (authorization.kind !== "authorized") {
    await settleToolInvocation(auditId, { status: "denied", error: "Connector sync is not permitted by your app permissions" });
    throw new Error("Connector sync is not permitted by your app permissions");
  }
  try {
    const result = await syncAuthorized(userId, provider, stream, fetcher);
    await completeExternalAction({ userId, receiptId: authorization.receiptId, ok: true, result: JSON.stringify(result) });
    await settleToolInvocation(auditId, { status: "executed" });
    return result;
  } catch (error) {
    await completeExternalAction({ userId, receiptId: authorization.receiptId, ok: false, result: "Connector sync failed" });
    await settleToolInvocation(auditId, { status: "failed", error: "Connector sync failed" });
    throw error;
  }
}

async function syncAuthorized(userId: string, provider: FirstPartyId, stream: string, fetcher: typeof fetch) {
  const access = await firstPartyAccessToken(userId, provider);
  if (!access) throw new Error("Reconnect this app to sync it");
  return prisma.$transaction(async (tx) => {
    // Connection is also the ownership proof. Serialize publication for this
    // connection so a later cursor cannot commit ahead of an earlier page.
    const connections = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Connection" WHERE "userId"=${userId} AND "provider"=${provider} FOR UPDATE`;
    const connection = connections[0];
    if (!connection) throw new Error("App is not connected");
    const states = await tx.$queryRaw<Array<{ state: string }>>`SELECT s."state" FROM "ConnectorSyncState" s JOIN "Connection" c ON c."id"=s."connectionId" WHERE c."userId"=${userId} AND c."id"=${connection.id} AND s."stream"=${stream}`;
    // Corrupt/unreadable state fails closed, never silently replays old data.
    const cursor: SyncCursor = states[0] ? JSON.parse(decryptSecret(states[0].state)) : {};
    const client = new FirstPartyClient(provider, access, fetcher);
    const page = provider === "slack" ? await readSlackSyncPage(client, cursor, stream) : await readSyncPage(client, cursor, stream);
    let inserted = 0;
    for (const change of page.changes) {
      const key = createHash("sha256").update(change.key).digest("hex");
      inserted += await tx.$executeRaw`INSERT INTO "ConnectorSyncEvent" ("connectionId","stream","eventKey","eventType","resourceId","payload") VALUES (${connection.id},${stream},${key},${change.type},${change.resourceId},${encryptSecret(JSON.stringify(change.payload))}) ON CONFLICT ("connectionId","stream","eventKey") DO NOTHING`;
    }
    await tx.$executeRaw`INSERT INTO "ConnectorSyncState" ("connectionId","stream","state","updatedAt") VALUES (${connection.id},${stream},${encryptSecret(JSON.stringify(page.cursor))},now()) ON CONFLICT ("connectionId","stream") DO UPDATE SET "state"=EXCLUDED."state", "updatedAt"=now()`;
    return { inserted, more: page.more, reset: page.reset === true };
  }, { timeout: 45_000, maxWait: 10_000 });
}

/** Producer seam for the existing Work poller: no admission or dedupe bypass. */
export async function readConnectorTriggerEvents(userId: string, provider: string, position: string | undefined, stream = "primary") {
  if (!isFirstPartyId(provider)) throw new Error("This app does not have an event source");
  await syncFirstParty(userId, provider, stream);
  const source = `connector:${provider}:${stream}`;
  if (position === undefined) {
    const latest = await prisma.$queryRaw<Array<{ id: bigint | null }>>`SELECT max(e."id") AS "id" FROM "ConnectorSyncEvent" e JOIN "Connection" c ON c."id"=e."connectionId" WHERE c."userId"=${userId} AND c."provider"=${provider} AND e."stream"=${stream}`;
    return { events: [], cursorSource: source, cursorPosition: String(latest[0]?.id ?? 0n), establishing: true };
  }
  if (!/^\d{1,20}$/.test(position)) throw new Error("Invalid event cursor");
  const rows = await prisma.$queryRaw<Array<{ id: bigint; eventType: string; resourceId: string; createdAt: Date }>>`SELECT e."id",e."eventType",e."resourceId",e."createdAt" FROM "ConnectorSyncEvent" e JOIN "Connection" c ON c."id"=e."connectionId" WHERE c."userId"=${userId} AND c."provider"=${provider} AND e."stream"=${stream} AND e."id">${BigInt(position)} ORDER BY e."id" ASC LIMIT 100`;
  const events: ConnectorTriggerEvent[] = rows.map((r) => ({ kind: "connector_event", connector: provider, event: r.eventType, eventKey: `${source}:${r.id}`, occurredAt: r.createdAt, attributes: { resourceId: r.resourceId, stream } }));
  return { events, cursorSource: source, cursorPosition: String(rows.at(-1)?.id ?? position), establishing: false };
}
