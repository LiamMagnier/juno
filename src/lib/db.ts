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
 *
 * tests/ownership-guard.test.ts reads prisma/schema.prisma and fails when a
 * model carrying an ownership column is in neither list — so this stops being a
 * thing anyone has to remember.
 *
 * Known gap: GUARDED_OPERATIONS covers reads, updates and deletes but not
 * `upsert`, `count`, `aggregate` or `groupBy`, all of which take a `where`.
 * Closing it is its own audit rather than a one-line addition — the sync PUT in
 * api/code/devices/[deviceId]/sessions/route.ts upserts by the
 * `deviceId_sessionId` key with no userId in the where, and would start
 * throwing in development the moment `upsert` joins the set.
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
  // Reservations gate a paid quota, so an unscoped read here is a cross-account
  // billing leak rather than a tidiness problem. Every call site in
  // src/lib/usage.ts scopes by userId.
  ["CodeUsageReservation", "userId"],
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
  ["ActionApprovalReceipt", "userId"],
  ["ActionApprovalGrant", "userId"],
  // Knowledge, Research and the spend ceiling. Every one of these holds content
  // derived from a single person's files or a single person's money, so they are
  // exactly the tables where a missing scope would be a leak rather than a bug.
  // ResearchClaimLink is deliberately absent: it is a pure join between two rows
  // that are themselves scoped, and it carries no userId to check.
  ["SpendPeriod", "userId"],
  ["SpendReservation", "userId"],
  ["KnowledgeDocument", "userId"],
  ["KnowledgeBlock", "userId"],
  ["KnowledgeChunk", "userId"],
  ["KnowledgeIndexJob", "userId"],
  ["ResearchRun", "userId"],
  ["ResearchSource", "userId"],
  ["ResearchPassage", "userId"],
  ["ResearchClaim", "userId"],
  ["ResearchEvent", "userId"],
  // The last eight. Each had call sites that reached the database without a
  // userId — not leaks (every one was already behind an ownership check, an
  // owner-only admin gate, or a capability like a share token), but nothing
  // stopped the next one from being a leak. The genuinely global paths now say
  // so with prismaUnguarded: public share pages, PKCE redemption, the admin
  // moderation queue, and the cross-user scheduler sweep. Everything else had
  // the userId in hand already and now puts it in the where.
  ["Share", "userId"],
  ["ScheduledTask", "userId"],
  ["ModerationFlag", "userId"],
  ["CodeRemoteSession", "userId"],
  ["CodeRemoteSessionEvent", "userId"],
  ["CodeSessionCommand", "userId"],
  ["NativeDeviceSession", "userId"],
  ["NativeAuthorizationCode", "userId"],
  // Juno Work. Guarded from the first commit rather than retrofitted, because
  // this is the subsystem where an unscoped read is worst: a WorkEvent carries
  // what an agent did with someone's files, and a WorkFileGrant is the thing
  // that says whose files they were.
  //
  // The scheduler and the host-claim endpoints legitimately sweep across
  // accounts. Those use prismaUnguarded explicitly (src/lib/work/scheduler.ts,
  // src/lib/work/relay.ts) rather than being waived here — the whole point of
  // the guard is that a cross-user query has to say so.
  ["WorkSession", "userId"],
  ["WorkSessionConnector", "userId"],
  ["WorkRun", "userId"],
  ["WorkEvent", "userId"],
  ["WorkApproval", "userId"],
  ["WorkArtifact", "userId"],
  ["WorkFileGrant", "userId"],
  ["WorkHost", "userId"],
  ["WorkCommand", "userId"],
  ["WorkSkill", "userId"],
  ["WorkSchedule", "userId"],
  ["WorkTrigger", "userId"],
  ["WorkAuditEvent", "userId"],
]);

/**
 * User-owned models that are deliberately NOT guarded yet, and why.
 *
 * A waiver in code rather than a silence: tests/ownership-guard.test.ts asserts
 * that every model carrying an ownership column is either guarded or listed
 * here, so a new one cannot be added without someone making this choice.
 *
 * Empty, and worth keeping empty. The eight models that used to sit here are
 * all guarded now; adding a name back is a deliberate act that needs a reason
 * on the same line.
 */
export const UNGUARDED_OWNED_MODELS = new Set<string>([]);

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
