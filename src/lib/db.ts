import { PrismaClient } from "@prisma/client";

/**
 * Prisma client with an ownership guard.
 *
 * Every model that carries a `userId` column is "user-owned": reads and writes
 * must be scoped to the requesting user. The query extension below inspects the
 * `where` clause of read/mutate operations on those models and flags any call
 * that reaches the database without a `userId` filter (top-level, inside a
 * compound unique like `userId_period`, or via a relation filter). In
 * development the call throws so the bug is caught immediately; in production
 * it logs a loud error with a stack trace and lets the query proceed.
 *
 * Legitimate global queries (owner/admin surfaces, webhook lookups keyed by an
 * external id) must use `prismaUnguarded` — the raw client — so the intent is
 * explicit at the call site.
 *
 * Models scoped through a parent rather than a `userId` column (Message,
 * Artifact, ArtifactVersion, CodeTaskEvent — all reached via an
 * ownership-checked Conversation/CodeTask) and auth-adapter models
 * (User, Account, Session, VerificationToken) are intentionally not guarded.
 */

const GUARDED_MODELS = new Set([
  "Conversation",
  "Folder",
  "Project",
  "MemoryEntry",
  "MemorySummary",
  "ConversationMemory",
  "Attachment",
  "Usage",
  "Subscription",
  "Settings",
  "Connection",
  "CodeDevice",
  "CodeTask",
  "ApiSpend",
  "FeatureVote",
  "AnnouncementDismissal",
]);

const GUARDED_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

/** True when the where clause constrains userId somewhere (top-level, nested
 *  compound unique, relation filter, or inside AND/OR/NOT arrays). */
function whereHasUserId(where: unknown, depth = 0): boolean {
  if (depth > 6 || where === null || typeof where !== "object") return false;
  if (Array.isArray(where)) return where.some((w) => whereHasUserId(w, depth + 1));
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === "userId" && value !== undefined) return true;
    if (whereHasUserId(value, depth + 1)) return true;
  }
  return false;
}

// Reuse a single PrismaClient across hot reloads / serverless invocations.
const globalForPrisma = globalThis as unknown as { prismaBase?: PrismaClient };

/** Raw client — ONLY for intentionally global queries (owner/admin surfaces,
 *  Stripe-webhook lookups by customer id, auth internals). Everything else
 *  should use `prisma` so unscoped access to user data gets flagged. */
export const prismaUnguarded =
  globalForPrisma.prismaBase ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaBase = prismaUnguarded;

/** Guarded client — the default import for all application code. */
export const prisma = prismaUnguarded.$extends({
  name: "ownership-guard",
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        if (GUARDED_MODELS.has(model) && GUARDED_OPERATIONS.has(operation)) {
          const where = (args as { where?: unknown }).where;
          if (!whereHasUserId(where)) {
            const err = new Error(
              `[ownership-guard] ${model}.${operation} executed without a userId filter — ` +
                `scope the query to the requesting user or use prismaUnguarded for intentional global access.`
            );
            if (process.env.NODE_ENV === "development") throw err;
            console.error(err.stack ?? err.message);
          }
        }
        return query(args);
      },
    },
  },
});
