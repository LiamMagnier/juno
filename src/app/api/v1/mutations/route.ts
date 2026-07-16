import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiV1Error, apiV1Error, apiV1Json } from "@/lib/api-v1";
import { requireNativeRequest } from "@/lib/native-request";
import { prismaUnguarded } from "@/lib/prisma";

export const runtime = "nodejs";

const operation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conversation.create"), clientEntityId: z.string().uuid().optional(), title: z.string().trim().min(1).max(200).optional() }).strict(),
  z.object({ type: z.literal("conversation.rename"), entityId: z.string().min(1).max(200), title: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal("conversation.update"), entityId: z.string().min(1).max(200), patch: z.object({
    title: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional(),
    projectId: z.string().min(1).max(200).nullable().optional(), folderId: z.string().min(1).max(200).nullable().optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal("conversation.delete"), entityId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("project.create"), clientEntityId: z.string().uuid().optional(), name: z.string().trim().min(1).max(160), instructions: z.string().max(50_000).default("") }).strict(),
  z.object({ type: z.literal("project.update"), entityId: z.string().min(1).max(200), name: z.string().trim().min(1).max(160).optional(), instructions: z.string().max(50_000).optional() }).strict(),
  z.object({ type: z.literal("project.delete"), entityId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("memory.create"), clientEntityId: z.string().uuid().optional(), content: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal("memory.update"), entityId: z.string().min(1).max(200), content: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal("memory.delete"), entityId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("settings.update"), patch: z.object({
    theme: z.enum(["LIGHT", "DARK", "SYSTEM"]).optional(), accent: z.string().min(1).max(40).optional(),
    defaultModel: z.string().min(1).max(200).optional(), customInstructions: z.string().max(50_000).optional(),
    responseLanguage: z.string().min(1).max(80).optional(), uiLocale: z.string().min(1).max(40).optional(),
    personality: z.string().min(1).max(80).optional(), memoryEnabled: z.boolean().optional(),
    voiceId: z.string().max(200).nullable().optional(), favoriteModels: z.array(z.string().max(200)).max(100).optional(),
  }).strict() }).strict(),
]);
const requestSchema = z.object({
  clientMutationId: z.string().uuid(),
  baseRevision: z.number().int().min(0),
  operation,
}).strict();

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
    const body = requestSchema.parse(await request.json());
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
type Operation = z.infer<typeof operation>;

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
      const row = await tx.conversation.create({ data: { userId: accountId, ...(op.title ? { title: op.title, titleSource: "user" } : {}) } });
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
      await requireOwnedConversationReferences(tx, accountId, op.patch);
      const updated = await tx.conversation.updateMany({ where: { id: op.entityId, userId: accountId }, data: {
        ...op.patch,
        ...(op.patch.title !== undefined ? { titleSource: "user" } : {}),
      } });
      if (!updated.count) throw new ApiV1Error("not_found", 404, "The conversation was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "conversation", op.entityId) } };
    }
    case "conversation.delete": {
      await requireRevision(tx, accountId, "conversation", op.entityId, baseRevision);
      const deleted = await tx.conversation.deleteMany({ where: { id: op.entityId, userId: accountId } });
      if (!deleted.count) throw new ApiV1Error("not_found", 404, "The conversation was not found.");
      return { entity: { id: op.entityId, revision: await nextRevision(tx, accountId, "conversation", op.entityId), deleted: true } };
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
