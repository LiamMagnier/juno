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
 * Ownership is not always `userId`: the native sync tables key on `accountId`,
 * which the guard could not express at all before — it looked for a literal
 * `userId` key, so those three models were unguardable rather than unguarded.
 *
 * Not guarded, on purpose:
 *  - Models scoped through a parent (Message, MessageVersion, Artifact,
 *    ArtifactVersion, CodeTaskEvent, NativeRefreshToken, ScheduledTaskRun —
 *    reached via an ownership-checked Conversation / CodeTask / parent row).
 *  - Auth-adapter models (User, Account, Session, VerificationToken), which
 *    NextAuth queries by provider identifiers before a session exists.
 *  - FeatureRequest and FeatureComment, owned via `authorId` and deliberately
 *    world-readable (the public roadmap).
 *  - The models in UNGUARDED_OWNED_MODELS below, which are staged work rather
 *    than a decision that they are safe.
 *
 * tests/ownership-guard.test.ts reads prisma/schema.prisma and fails when a
 * model carrying an ownership column is in neither list — so this stops being a
 * thing anyone has to remember.
 *
 * Known gap: GUARDED_OPERATIONS covers reads, updates and deletes but not
 * `upsert`, `count`, `aggregate` or `groupBy`, all of which take a `where`.
 */

/**
 * Guarded models and the column that carries ownership.
 *
 * A map rather than a set because ownership is not always `userId`: the native
 * sync tables key on `accountId`. Pairing each model with its own column stops
 * a query on one model from being accepted because it happened to filter on the
 * other model's ownership column.
 */
export const OWNER_COLUMN = new Map<string, "userId" | "accountId">([
  ["Conversation", "userId"],
  ["Folder", "userId"],
  ["Project", "userId"],
  ["MemoryEntry", "userId"],
  ["MemorySummary", "userId"],
  ["ConversationMemory", "userId"],
  ["Attachment", "userId"],
  ["Usage", "userId"],
  ["Subscription", "userId"],
  ["Settings", "userId"],
  ["Connection", "userId"],
  ["CodeDevice", "userId"],
  ["CodeTask", "userId"],
  ["ApiSpend", "userId"],
  ["ChatFirstSubmissionReceipt", "userId"],
  ["FeatureVote", "userId"],
  ["AnnouncementDismissal", "userId"],
  // Every query against these three already scopes by userId — verified call
  // site by call site — so guarding them is a pure tripwire with no behaviour
  // change.
  ["SavedPrompt", "userId"],
  ["VoiceTranscriptSession", "userId"],
  ["CodeWorkspace", "userId"],
  // The native sync feed. All call sites already scope through the
  // `accountId_*` compound uniques, and the pruner already uses
  // prismaUnguarded, so this is likewise a no-op addition.
  ["AccountChange", "accountId"],
  ["EntityRevision", "accountId"],
  ["MutationReceipt", "accountId"],
  // Added by the tool-audit work; its only unscoped write is a settle-by-primary-key
  // that deliberately uses prismaUnguarded (see src/lib/tool-audit.ts).
  ["ToolInvocation", "userId"],
]);

/**
 * User-owned models that are deliberately NOT guarded yet, and why.
 *
 * A waiver in code rather than a silence: tests/ownership-guard.test.ts asserts
 * that every model carrying an ownership column is either guarded or listed
 * here, so a new one cannot be added without someone making this choice.
 *
 * These eight all carry `userId` and every current call site is scoped, behind
 * an owner-only admin gate, or genuinely global — no known leak. What they lack
 * is the dev-time tripwire. Guarding them requires converting ~17 call sites in
 * the same commit (the native bearer-token path among them, which would
 * otherwise break every native client against a dev server), so it is staged
 * separately rather than bundled in here.
 */
export const UNGUARDED_OWNED_MODELS = new Set([
  "Share", // public /s/<token> pages resolve by token, before any user exists
  "ScheduledTask", // the worker scans and claims across all users
  "ModerationFlag", // owner-only admin surface
  "CodeRemoteSession",
  "CodeRemoteSessionEvent",
  "CodeSessionCommand",
  "NativeDeviceSession", // bearer auth identifies the user FROM the session row
  "NativeAuthorizationCode", // PKCE redemption identifies the user FROM the code
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

/** True when the where clause constrains the given ownership column somewhere
 *  (top-level, nested compound unique, relation filter, or inside AND/OR/NOT
 *  arrays). The column is per-model — see OWNER_COLUMN. */
function whereHasOwner(where: unknown, column: "userId" | "accountId", depth = 0): boolean {
  if (depth > 6 || where === null || typeof where !== "object") return false;
  if (Array.isArray(where)) return where.some((w) => whereHasOwner(w, column, depth + 1));
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === column && value !== undefined) return true;
    if (whereHasOwner(value, column, depth + 1)) return true;
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
        const ownerColumn = OWNER_COLUMN.get(model);
        if (ownerColumn && GUARDED_OPERATIONS.has(operation)) {
          const where = (args as { where?: unknown }).where;
          if (!whereHasOwner(where, ownerColumn)) {
            const err = new Error(
              `[ownership-guard] ${model}.${operation} executed without a ${ownerColumn} filter — ` +
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
