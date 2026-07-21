import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ApiV1Error, apiV1Error, apiV1Json } from "@/lib/api-v1";
import { requireNativeRequest } from "@/lib/native-request";
import { prismaUnguarded } from "@/lib/prisma";
import { isModelId } from "@/lib/models";
import { mutationRequestSchema, type MutationOperation } from "@/lib/sync-mutations";

export const runtime = "nodejs";

const hashRequest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function POST(request: Request) {
  let receiptLookup: {
    accountId: string;
    authenticatedDeviceId: string;
    clientMutationId: string;
    requestHash: string;
  } | null = null;
  try {
    const current = await requireNativeRequest(request);
    const body = mutationRequestSchema.parse(await request.json());
    const requestHash = hashRequest(body);
    receiptLookup = {
      accountId: current.user.id,
      authenticatedDeviceId: current.deviceSession.id,
      clientMutationId: body.clientMutationId,
      requestHash,
    };

    const result = await prismaUnguarded.$transaction(async (tx) => {
      const key = { accountId_authenticatedDeviceId_clientMutationId: {
        accountId: current.user.id, authenticatedDeviceId: current.deviceSession.id, clientMutationId: body.clientMutationId,
      } };
      const prior = await tx.mutationReceipt.findUnique({ where: key });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ApiV1Error("idempotency_key_reused", 409, "This mutation identifier was already used for different work.");
        return prior.result;
      }

      const output = await executeMutation(tx, current.user.id, body.baseRevision, body.operation);
      await tx.mutationReceipt.create({ data: {
        accountId: current.user.id, authenticatedDeviceId: current.deviceSession.id,
        clientMutationId: body.clientMutationId, requestHash, status: 200,
        result: output as Prisma.InputJsonValue,
      } });
      return output;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return apiV1Json(result);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && receiptLookup) {
      const prior = await prismaUnguarded.mutationReceipt.findUnique({
        where: { accountId_authenticatedDeviceId_clientMutationId: {
          accountId: receiptLookup.accountId,
          authenticatedDeviceId: receiptLookup.authenticatedDeviceId,
          clientMutationId: receiptLookup.clientMutationId,
        } },
      });
      if (prior?.requestHash === receiptLookup.requestHash) return apiV1Json(prior.result);
      if (prior) return apiV1Error(new ApiV1Error("idempotency_key_reused", 409, "This mutation identifier was already used for different work."));
      return apiV1Error(new ApiV1Error("revision_conflict", 409, "The mutation raced with another device. Refresh and retry."));
    }
    return apiV1Error(error);
  }
}

type Tx = Prisma.TransactionClient;
type Operation = MutationOperation;

async function requireRevision(tx: Tx, accountId: string, entityType: string, entityId: string, baseRevision: number) {
  const state = await tx.entityRevision.findUnique({ where: { accountId_entityType_entityId: { accountId, entityType, entityId } } });
  const revision = state?.revision ?? 0;
  if (state?.deletedAt) throw new ApiV1Error("revision_conflict", 409, "This item was deleted on another device.", false, { currentRevision: revision, deleted: true });
  if (revision !== baseRevision) throw new ApiV1Error("revision_conflict", 409, "This item changed on another device.", false, { currentRevision: revision });
}

async function nextRevision(tx: Tx, accountId: string, entityType: string, entityId: string) {
  return (await tx.entityRevision.findUnique({ where: { accountId_entityType_entityId: { accountId, entityType, entityId } }, select: { revision: true } }))?.revision ?? 0;
}

async function executeMutation(tx: Tx, accountId: string, baseRevision: number, op: Operation) {
  switch (op.type) {
    case "conversation.create": {
      if (baseRevision !== 0) throw new ApiV1Error("invalid_request", 400, "Create mutations must start at revision zero.");
      if (op.model !== undefined && !isModelId(op.model)) throw new ApiV1Error("invalid_request", 400, "The model is unknown.");
      if (op.projectId) {
        const project = await tx.project.findFirst({ where: { id: op.projectId, userId: accountId }, select: { id: true } });
        if (!project) throw new ApiV1Error("not_found", 404, "The project was not found.");
      }
      const row = await tx.conversation.create({ data: {
        userId: accountId,
        ...(op.title ? { title: op.title, titleSource: "user" } : {}),
        ...(op.kind ? { kind: op.kind } : {}),
        ...(op.model ? { model: op.model } : {}),
        ...(op.projectId ? { projectId: op.projectId } : {}),
      } });
      return { entityMappings: op.clientEntityId ? { [op.clientEntityId]: row.id } : {}, entity: { id: row.id, revision: await nextRevision(tx, accountId, "conversation", row.id) } };
    }
    case "conversation.rename": {
      await requireRevision(tx, accountId, "conversation", op.entityId, baseRevision);
      const updated = await tx.conversation.updateMany({ where: { id: op.entityId, userId: accountId }, data: { title: op.title, titleSource: "user" } });
      if (!updated.count) throw new ApiV1Error("not_found", 404, "The conversation was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "conversation", op.entityId) } };
    }
    case "conversation.update": {
      await requireRevision(tx, accountId, "conversation", op.entityId, baseRevision);
      if (op.patch.model !== undefined && !isModelId(op.patch.model)) {
        throw new ApiV1Error("invalid_request", 400, "The model is unknown.");
      }
      await requireOwnedConversationReferences(tx, accountId, op.patch);
      const updated = await tx.conversation.updateMany({ where: { id: op.entityId, userId: accountId }, data: {
        ...op.patch,
        ...(op.patch.title !== undefined ? { titleSource: "user" } : {}),
      } });
      if (!updated.count) throw new ApiV1Error("not_found", 404, "The conversation was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "conversation", op.entityId) } };
    }
    case "conversation.archive": {
      await requireRevision(tx, accountId, "conversation", op.entityId, baseRevision);
      const existing = await tx.conversation.findFirst({ where: { id: op.entityId, userId: accountId }, select: { id: true } });
      if (!existing) throw new ApiV1Error("not_found", 404, "The conversation was not found.");
      if (op.archived) {
        // Stamp archivedAt only on the null→now transition so re-archiving
        // never resets "when" (same semantics as the web PATCH).
        await tx.conversation.updateMany({ where: { id: op.entityId, userId: accountId, archivedAt: null }, data: { archivedAt: new Date() } });
      } else {
        await tx.conversation.updateMany({ where: { id: op.entityId, userId: accountId, archivedAt: { not: null } }, data: { archivedAt: null } });
      }
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "conversation", op.entityId) } };
    }
    case "conversation.delete": {
      await requireRevision(tx, accountId, "conversation", op.entityId, baseRevision);
      const deleted = await tx.conversation.deleteMany({ where: { id: op.entityId, userId: accountId } });
      if (!deleted.count) throw new ApiV1Error("not_found", 404, "The conversation was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "conversation", op.entityId), deleted: true } };
    }
    case "folder.create": {
      if (baseRevision !== 0) throw new ApiV1Error("invalid_request", 400, "Create mutations must start at revision zero.");
      const row = await tx.folder.create({ data: { userId: accountId, name: op.name } });
      return { entityMappings: op.clientEntityId ? { [op.clientEntityId]: row.id } : {}, entity: { id: row.id, revision: await nextRevision(tx, accountId, "folder", row.id) } };
    }
    case "folder.rename": {
      await requireRevision(tx, accountId, "folder", op.entityId, baseRevision);
      const updated = await tx.folder.updateMany({ where: { id: op.entityId, userId: accountId }, data: { name: op.name } });
      if (!updated.count) throw new ApiV1Error("not_found", 404, "The folder was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "folder", op.entityId) } };
    }
    case "folder.delete": {
      await requireRevision(tx, accountId, "folder", op.entityId, baseRevision);
      const deleted = await tx.folder.deleteMany({ where: { id: op.entityId, userId: accountId } });
      if (!deleted.count) throw new ApiV1Error("not_found", 404, "The folder was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "folder", op.entityId), deleted: true } };
    }
    case "project.create": {
      if (baseRevision !== 0) throw new ApiV1Error("invalid_request", 400, "Create mutations must start at revision zero.");
      const row = await tx.project.create({ data: { userId: accountId, name: op.name, nameSource: "user", instructions: op.instructions } });
      return { entityMappings: op.clientEntityId ? { [op.clientEntityId]: row.id } : {}, entity: { id: row.id, revision: await nextRevision(tx, accountId, "project", row.id) } };
    }
    case "project.update": {
      await requireRevision(tx, accountId, "project", op.entityId, baseRevision);
      const updated = await tx.project.updateMany({ where: { id: op.entityId, userId: accountId }, data: { ...(op.name !== undefined ? { name: op.name, nameSource: "user" } : {}), ...(op.instructions !== undefined ? { instructions: op.instructions } : {}) } });
      if (!updated.count) throw new ApiV1Error("not_found", 404, "The project was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "project", op.entityId) } };
    }
    case "project.delete": {
      await requireRevision(tx, accountId, "project", op.entityId, baseRevision);
      const deleted = await tx.project.deleteMany({ where: { id: op.entityId, userId: accountId } });
      if (!deleted.count) throw new ApiV1Error("not_found", 404, "The project was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "project", op.entityId), deleted: true } };
    }
    case "memory.create": {
      if (baseRevision !== 0) throw new ApiV1Error("invalid_request", 400, "Create mutations must start at revision zero.");
      const row = await tx.memoryEntry.create({ data: { userId: accountId, content: op.content, source: "MANUAL", sourceRef: "native" } });
      return { entityMappings: op.clientEntityId ? { [op.clientEntityId]: row.id } : {}, entity: { id: row.id, revision: await nextRevision(tx, accountId, "memory", row.id) } };
    }
    case "memory.update": {
      await requireRevision(tx, accountId, "memory", op.entityId, baseRevision);
      const updated = await tx.memoryEntry.updateMany({ where: { id: op.entityId, userId: accountId }, data: { content: op.content, source: "MANUAL" } });
      if (!updated.count) throw new ApiV1Error("not_found", 404, "The memory was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "memory", op.entityId) } };
    }
    case "memory.delete": {
      await requireRevision(tx, accountId, "memory", op.entityId, baseRevision);
      const deleted = await tx.memoryEntry.deleteMany({ where: { id: op.entityId, userId: accountId } });
      if (!deleted.count) throw new ApiV1Error("not_found", 404, "The memory was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "memory", op.entityId), deleted: true } };
    }
    case "settings.update": {
      const current = await tx.settings.findUnique({ where: { userId: accountId } });
      if (current) await requireRevision(tx, accountId, "settings", current.id, baseRevision);
      else if (baseRevision !== 0) throw new ApiV1Error("revision_conflict", 409, "Settings changed on another device.", false, { currentRevision: 0 });
      const row = await tx.settings.upsert({ where: { userId: accountId }, create: { userId: accountId, ...op.patch }, update: op.patch });
      return { entity: { id: row.id, revision: await nextRevision(tx, accountId, "settings", row.id) } };
    }
  }
}

async function requireOwnedConversationReferences(
  tx: Tx,
  accountId: string,
  patch: { projectId?: string | null; folderId?: string | null },
) {
  if (patch.projectId) {
    const project = await tx.project.findFirst({ where: { id: patch.projectId, userId: accountId }, select: { id: true } });
    if (!project) throw new ApiV1Error("not_found", 404, "The project was not found.");
  }
  if (patch.folderId) {
    const folder = await tx.folder.findFirst({ where: { id: patch.folderId, userId: accountId }, select: { id: true } });
    if (!folder) throw new ApiV1Error("not_found", 404, "The folder was not found.");
  }
}
