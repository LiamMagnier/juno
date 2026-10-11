import "server-only";
import { Prisma, type ChatLocalToolCall } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptSecretBound, decryptSecretBound } from "@/lib/crypto";
import {
  MAX_LOCAL_TOOL_OUTPUT_CHARS, localToolResultContext, type LocalToolStore, type LocalToolRecord,
  type LocalToolResult,
} from "./local-folder-bridge";

const context = localToolResultContext;
const bounded = (result: LocalToolResult): LocalToolResult => ({ outcome: result.outcome, output: result.output.slice(0, MAX_LOCAL_TOOL_OUTPUT_CHARS) });
type ReceiptDatabase = {
  chatLocalToolCall: {
    create(args: { data: Prisma.ChatLocalToolCallUncheckedCreateInput }): Promise<ChatLocalToolCall>;
    findFirst(args: { where: Prisma.ChatLocalToolCallWhereInput }): Promise<ChatLocalToolCall | null>;
    findUnique(args: { where: Prisma.ChatLocalToolCallWhereUniqueInput }): Promise<ChatLocalToolCall | null>;
    updateMany(args: { where: Prisma.ChatLocalToolCallWhereInput; data: Prisma.ChatLocalToolCallUpdateManyMutationInput }): Promise<{ count: number }>;
    deleteMany(args: { where: Prisma.ChatLocalToolCallWhereInput }): Promise<{ count: number }>;
  };
};

/** Small result receipt, not another execution queue: the Mac remains the only
 * execution authority. Results are encrypted with account/call-bound AAD using
 * the existing rotating secret-key registry. Pending and terminal CAS updates
 * work across processes. No plaintext document contents are logged or stored. */
export function createDurableLocalToolStore(db: ReceiptDatabase): LocalToolStore {
  return {
    async create(row) {
      // Validate encryption before a request can leave the backend.
      encryptSecretBound("", context(row));
      // Short-lived handoff data. Cleanup is account-scoped and only removes
      // receipts whose execution window ended over a day ago; no live call or
      // response retry within that window can lose its identity.
      await db.chatLocalToolCall.deleteMany({ where: {
        userId: row.userId, expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      } });
      try {
        await db.chatLocalToolCall.create({ data: {
          id: row.callId, userId: row.userId, generationId: row.generationId,
          expiresAt: new Date(row.expiresAt),
        } });
        return true;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
        throw error;
      }
    },
    async read(identity) {
      const row = await db.chatLocalToolCall.findFirst({ where: {
        id: identity.callId, userId: identity.userId, generationId: identity.generationId,
      } });
      if (!row) return null;
      const result = row.sealedResult ? JSON.parse(decryptSecretBound(row.sealedResult, context(identity))) as LocalToolResult : undefined;
      return {
        ...identity, status: row.status as LocalToolRecord["status"], expiresAt: row.expiresAt.getTime(), result,
      };
    },
    async deliver(input) {
      const row = await db.chatLocalToolCall.findFirst({ where: {
        id: input.callId, userId: input.userId,
        ...(input.generationId ? { generationId: input.generationId } : {}),
      } });
      if (!row) return "unknown";
      const identity = { callId: row.id, userId: row.userId, generationId: row.generationId };
      const result = bounded(input.result);
      const serialized = JSON.stringify(result);
      const changed = await db.chatLocalToolCall.updateMany({ where: {
        id: row.id, userId: row.userId, generationId: row.generationId,
        status: "pending", expiresAt: { gt: new Date() },
      }, data: { status: "completed", sealedResult: encryptSecretBound(serialized, context(identity)), completedAt: new Date() } });
      if (changed.count === 1) return "accepted";
      const terminal = await db.chatLocalToolCall.findUnique({ where: { id: row.id, userId: row.userId, generationId: row.generationId } });
      // A retry may acknowledge the same result, never replace it. Comparing
      // decrypted bounded payloads avoids persisting a hash of sensitive text.
      return terminal?.status === "completed" && terminal.sealedResult
        && decryptSecretBound(terminal.sealedResult, context(identity)) === serialized
        ? "accepted" : "unknown";
    },
    async end(identity, status) {
      await db.chatLocalToolCall.updateMany({ where: {
        id: identity.callId, userId: identity.userId, generationId: identity.generationId,
        status: "pending", ...(status === "expired" ? { expiresAt: { lte: new Date() } } : {}),
      }, data: { status, completedAt: new Date() } });
    },
  };
}
export const durableLocalToolStore = createDurableLocalToolStore(prisma);
