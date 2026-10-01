import { PrismaClient } from "@prisma/client";

/**
 * Prisma client with an ownership guard.
 *
 * Every model that carries a `userId` column is "user-owned": reads and writes
 * must be scoped to the requesting user. The query extension below inspects the
 * `where` clause of read/mutate operations on those models and flags any call
 * that reaches the database without a `userId` filter (top-level, inside a
 * compound unique like `userId_period`, or via a relation filter). In
 * every environment the call throws before it reaches the database.
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
 *  - Models scoped through a parent (Message, MessageVersion,
 *    ArtifactVersion, ArtifactProposal, CodeTaskEvent, NativeRefreshToken,
 *    ScheduledTaskRun — reached via an ownership-checked Conversation /
 *    Artifact / CodeTask / parent row).
 *  - Auth-adapter models (User, Account, Session, VerificationToken), which
 *    NextAuth queries by provider identifiers before a session exists.
 *  - FeatureRequest and FeatureComment, owned via `authorId` and deliberately
 *    world-readable (the public roadmap).
 *
 * tests/ownership-guard.test.ts reads prisma/schema.prisma and fails when a
 * model carrying an ownership column is in neither list — so this stops being a
 * thing anyone has to remember.
 *
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
  // A project's custom-assistant config: persona, tool whitelist, which of the
  // project's files the model is fed. Guarded rather than waived because the
  // knowledge-file selection is a statement about someone's private documents,
  // and the whitelist is a permission decision — an unscoped read here leaks
  // both. The one write that legitimately upserts by the compound
  // `userId_projectId` key still carries userId, so the guard is satisfied by
  // the query it was already making.
  ["ProjectWorkspace", "userId"],
  ["MemoryEntry", "userId"],
  ["MemorySummary", "userId"],
  // One per (person, project). Keyed and filtered on userId like the account
  // summary: a shared project's members each have their own, and an unscoped
  // read would hand one member another's distilled project memory.
  ["ProjectMemorySummary", "userId"],
  ["ConversationMemory", "userId"],
  // The edit ledger records what a user asked memory to change, so an unscoped
  // read is a leak of instructions, not just rows. Every call site (routes +
  // src/app/api/memory/edits/ledger.ts) already filters on userId.
  ["MemoryEdit", "userId"],
  ["Attachment", "userId"],
  ["Usage", "userId"],
  // Reservations gate a paid quota, so an unscoped read here is a cross-account
  // billing leak rather than a tidiness problem. Every call site in
  // src/lib/usage.ts scopes by userId.
  ["CodeUsageReservation", "userId"],
  ["Subscription", "userId"],
  ["Settings", "userId"],
  ["Connection", "userId"],
  // User-registered remote MCP servers. Auth header is encrypted at rest and
  // every route scopes by userId; the guard is the tripwire that keeps it that way.
  ["UserMcpServer", "userId"],
  ["CustomConnector", "userId"],
  ["CodeDevice", "userId"],
  ["DevicePushToken", "userId"],
  ["WebPushSubscription", "userId"],
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
  ["ResearchFinding", "userId"],
  ["ResearchClaim", "userId"],
  ["ResearchEvent", "userId"],
  ["ResearchReportRevision", "userId"],
  // The last eight. Each had call sites that reached the database without a
  // userId — not leaks (every one was already behind an ownership check, an
  // owner-only admin gate, or a capability like a share token), but nothing
  // stopped the next one from being a leak. The genuinely global paths now say
  // so with prismaUnguarded: public share pages, PKCE redemption, the admin
  // moderation queue, and the cross-user scheduler sweep. Everything else had
  // the userId in hand already and now puts it in the where.
  ["Share", "userId"],
  // Artifacts own themselves (PRODUCT_REFOUNDATION §10): the chat is a
  // nullable pointer, so the old `conversation: { userId }` join no longer
  // reaches a detached artifact and every read scopes on the artifact's own
  // owner (src/lib/artifact-access.ts). The draft and the publication carry the
  // same owner. The public page and the admin tools resolve publications by
  // token through prismaUnguarded, like shares.
  ["Artifact", "userId"],
  ["ArtifactDraft", "userId"],
  ["ArtifactPublication", "userId"],
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
  // The repository a group of skills was installed from. Every call site
  // (src/lib/skills/store.ts, src/app/api/skills/**, the work skills routes)
  // already filters on userId, so guarding it is a tripwire, not a change.
  ["WorkSkillSource", "userId"],
  ["WorkSchedule", "userId"],
  ["WorkTrigger", "userId"],
  ["WorkAuditEvent", "userId"],
  ["ImportRun", "userId"],
  ["ImportObject", "userId"],
  ["Notification", "userId"],
  ["ProjectMember", "userId"],
  // Two-step recovery codes. Guarded even though every lookup already has the
  // user in hand: a codeHash is unique, so an unscoped findUnique on it would
  // silently accept one account's recovery code as another account's second
  // factor. The scope is what makes that impossible rather than unlikely.
  ["MfaRecoveryCode", "userId"],
  // A cloud Code environment holds encrypted environment variables and a setup
  // script that runs on the runner host. An unscoped read is one account's
  // secrets; an unscoped update is one account editing another's build step.
  // Every call site already carries userId, so guarding costs nothing and the
  // tripwire is worth having on a table like this one.
  ["CodeEnvironment", "userId"],
  // Auto-fix. The row is a standing permission — "answer GitHub on this pull
  // request by editing my branch" — so an unscoped update is one account
  // switching on a machine that pushes to another account's repository. The
  // webhook legitimately looks it up across accounts (it holds a repository and
  // a number and no user at all) and says so with prismaUnguarded; every other
  // call site has the userId in the compound unique already.
  //
  // CodeAutoFixDelivery is deliberately absent: it carries no ownership column
  // and is reachable only through a watch that does, which is the same reason
  // ResearchClaimLink is not here.
  ["CodeAutoFixWatch", "userId"],
  // Agents (docs/design/AGENTS.md). Guarded from the first commit, like Work:
  // an agent's brief, goals and notes are a statement about one person's life,
  // and its log is what it did on their behalf. Every call site in
  // src/lib/agents/ and src/app/api/agents/ carries the userId already.
  ["Agent", "userId"],
  ["AgentGoal", "userId"],
  ["AgentIdea", "userId"],
  ["AgentNote", "userId"],
  ["AgentEvent", "userId"],
  // An agent's persistent virtual desktop: encrypted containerRef and VNC/CDP
  // secrets, lease state, and runtime usage. Cross-account sweeps (idle
  // descanso/sleep and reboot reconciliation) use prismaUnguarded explicitly.
  ["AgentComputer", "userId"],
  // A crew member's setup changes asked for in its thread: before/after state
  // of its apps, approval mode, budget and routines. Every read is scoped by
  // the person's id (src/lib/agents/setup-changes-store.ts).
  ["AgentSetupChange", "userId"],
  // Single-use computer view links. The one lookup that cannot know the owner
  // first, spending a code by its hash, uses prismaUnguarded on purpose
  // (src/lib/computer/handoff.ts): the code is the authorization.
  ["AgentComputerHandoff", "userId"],
  // Rooms (src/lib/agents/rooms.ts): who is in a group chat of agents and the
  // per-message plan of who answers. A room's membership is a statement about
  // one person's agents, so it is guarded like the agents themselves.
  ["AgentRoomMember", "userId"],
  ["AgentRoomTurn", "userId"],
  // A linked phone number for iMessage (src/lib/channels). The webhook finds
  // the link by its HMAC through prismaUnguarded, on purpose and only there.
  ["ChannelLink", "userId"],
  // Payments (src/lib/payments): an agent's spending limit and the one-time
  // cards it was allowed. The Stripe webhook looks a card up by its provider
  // id through prismaUnguarded, like the billing webhook does.
  ["AgentSpendLimit", "userId"],
  ["AgentPayment", "userId"],
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
  "upsert",
  "count",
  "aggregate",
  "groupBy",
]);

/** Require a positive, bounded ownership constraint in every OR branch.
 * A NOT, `notIn`, undefined value or empty filter never supplies ownership.
 * AND needs one scoped branch; OR needs all branches scoped. */
export function whereHasOwner(where: unknown, column: "userId" | "accountId", depth = 0): boolean {
  if (depth > 12 || !where || typeof where !== "object" || Array.isArray(where)) return false;
  const clauses = where as Record<string, unknown>;
  for (const [key, value] of Object.entries(clauses)) {
    if (key === "NOT" || key === "none" || key === "every" || key === "isNot") continue;
    if (key === column && positiveOwner(value)) return true;
    if (key === "AND") {
      const parts = Array.isArray(value) ? value : [value];
      if (parts.some((part) => whereHasOwner(part, column, depth + 1))) return true;
    } else if (key === "OR") {
      if (Array.isArray(value) && value.length > 0 && value.every((part) => whereHasOwner(part, column, depth + 1))) return true;
    } else if (key !== column && whereHasOwner(value, column, depth + 1)) {
      return true;
    }
  }
  return false;
}

function positiveOwner(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const filter = value as Record<string, unknown>;
  return (typeof filter.equals === "string" && filter.equals.length > 0) ||
    (Array.isArray(filter.in) && filter.in.length > 0 && filter.in.every((id) => typeof id === "string" && id.length > 0));
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
            throw err;
          }
        }
        return query(args);
      },
    },
  },
});
