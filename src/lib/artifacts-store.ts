import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ARTIFACT_CLIENT_INCLUDE, serializeArtifact } from "@/lib/serializers";
import { normalizeDesignArtifact } from "@/lib/design/authoring";
import { CHAT_ARTIFACT_MAX_CHARS } from "@/lib/chat-artifact-verification";
import { DesignValidationError } from "@/lib/design/schema";
import { reemitGuardEnabled } from "@/lib/artifact-flags";
import {
  decideReemit,
  PROPOSAL_STATUS,
  readProposalPayload,
  type ProposalPayload,
  type ReemitDecision,
} from "@/lib/artifact-proposals";
import type { ParsedArtifact } from "@/lib/message-content";
import type { ClientArtifact } from "@/types/chat";

/**
 * The stored form of each parsed artifact, computed once per object. The chat
 * route hands the same verified artifacts to `planHeldReemits` and then to
 * `persistArtifacts`, and a DESIGN's expansion runs the whole operation layer;
 * doing it once also logs its placeholder count once. Keyed by object, so it
 * holds nothing once the turn's artifacts are gone.
 */
const storedForms = new WeakMap<ParsedArtifact, ParsedArtifact | null>();

/**
 * A DESIGN artifact is stored as a full `DesignDocument`, but the model writes
 * the compact authoring form — so it is expanded here, once, on the way in.
 *
 * A body that cannot be expanded is dropped rather than stored: an artifact the
 * editor cannot open is worse than no artifact, because it reads as data loss.
 * The failure is logged with its reason so it is diagnosable rather than silent.
 */
function normalizeForStorage(artifact: ParsedArtifact): ParsedArtifact | null {
  if (artifact.type !== "DESIGN") return artifact;
  if (storedForms.has(artifact)) return storedForms.get(artifact) ?? null;
  const stored = expandForStorage(artifact);
  storedForms.set(artifact, stored);
  return stored;
}

function expandForStorage(artifact: ParsedArtifact): ParsedArtifact | null {
  try {
    const content = normalizeDesignArtifact(artifact.content, artifact.identifier);
    // Checked again after expansion, for callers that skip chat verification:
    // an over-limit row is refused by every later edit and blanks the native
    // libraries, so it is worse than no row.
    if (content.length > CHAT_ARTIFACT_MAX_CHARS) {
      console.warn(
        `[artifacts] dropped design artifact "${artifact.identifier}": ${content.length} characters once expanded, above ${CHAT_ARTIFACT_MAX_CHARS}`
      );
      return null;
    }
    return { ...artifact, content };
  } catch (error) {
    const detail = error instanceof DesignValidationError ? error.issues.join("; ") : String(error);
    console.warn(`[artifacts] dropped an unreadable design artifact "${artifact.identifier}": ${detail}`);
    return null;
  }
}

export class ArtifactVersionConflictError extends Error {
  constructor() {
    super("The artifact changed while this edit was being prepared.");
    this.name = "ArtifactVersionConflictError";
  }
}

/**
 * Let go of the artifacts a message first emitted, without deleting them.
 *
 * An artifact outlives the answer that made it: by the time that answer is
 * edited away or regenerated, the row can carry hand edits, design
 * checkpoints and public share links, all of which cascade from it. So
 * `messageId` is never a delete key. The row stays, with every version and
 * share, and is detached; the next emission of its identifier appends to it
 * (see `persistArtifacts`). A deleted message detaches its artifacts on its
 * own through the foreign key's `SetNull`; an answer overwritten in place by
 * a regenerate has to be let go of explicitly, which is this.
 *
 * Returned unawaited so it can join a batch `$transaction`.
 */
export function detachArtifactsFromMessage(messageId: string) {
  return prisma.artifact.updateMany({ where: { messageId }, data: { messageId: null } });
}

/**
 * The handle an artifact keeps when a re-emission of its identifier brings a
 * different type: `{identifier}~{last six characters of its id}`. The id is
 * the artifact's identity and never changes; the identifier is only the
 * conversation's handle for the model, so it passes to the new artifact.
 */
export function retiredIdentifier(identifier: string, artifactId: string): string {
  return `${identifier}~${artifactId.slice(-6)}`;
}

/**
 * The client inside `prisma.$transaction(async (tx) => …)` on the guarded
 * client, or a plain `Prisma.TransactionClient` (the unguarded client's, or a
 * caller's). They answer every call made here identically and differ only in
 * how TypeScript spells their generics; `asClient` names the shape they share.
 */
type GuardedTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type ArtifactStoreTransaction = GuardedTransaction | Prisma.TransactionClient;
type Db = Prisma.TransactionClient;

function asClient(tx: ArtifactStoreTransaction): Db {
  return tx as Db;
}

/**
 * Run `write` in the caller's transaction when there is one, else in a fresh
 * interactive transaction of its own. With a caller's transaction nothing here
 * opens another: Prisma has no nested transactions, and a second one would
 * commit on its own schedule, which is exactly what the caller asked not to
 * happen.
 */
function inTransaction<T>(tx: ArtifactStoreTransaction | undefined, write: (db: Db) => Promise<T>): Promise<T> {
  if (tx) return write(asClient(tx));
  return prisma.$transaction((inner) => write(asClient(inner)));
}

/** Raised inside a write to roll it back and read the row again; never escapes. */
class ArtifactWriteRaced extends Error {}

/**
 * Another writer got there between this write's read and its insert: a person
 * saved (the `(artifactId, version)` unique key, P2002), the row was trashed or
 * moved on (the guarded update found nothing, P2025, or `ArtifactWriteRaced`),
 * or another turn created the same identifier first (P2002 again).
 */
function isWriteRace(error: unknown): boolean {
  if (error instanceof ArtifactWriteRaced) return true;
  const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
  return code === "P2002" || code === "P2025";
}

/** One read and one decision are enough to settle any race a person can cause. */
const WRITE_ATTEMPTS = 3;

type ExistingArtifact = { id: string; type: string; currentVersion: number };

/**
 * `decideReemit` for one live, same-type row, read through `db`.
 *
 * The current version's body is read only for a DESIGN, the one type whose
 * rule compares structure; for everything else the origin decides and a
 * 200 000-character body stays in the database.
 */
async function decideForRow(db: Db, existing: ExistingArtifact, next: ParsedArtifact): Promise<ReemitDecision> {
  const enabled = reemitGuardEnabled();
  if (!enabled) return { action: "append" };
  const current = await db.artifactVersion.findUnique({
    where: { artifactId_version: { artifactId: existing.id, version: existing.currentVersion } },
    select: { origin: true, content: existing.type === "DESIGN" },
  });
  return decideReemit({
    type: existing.type,
    currentOrigin: current?.origin ?? null,
    currentContent: (current as { content?: string } | null)?.content ?? null,
    nextContent: next.content,
    enabled,
  });
}

/**
 * Which of a turn's re-emits the re-emit guard will hold, decided BEFORE the
 * message is saved, so the message can be saved in its held form
 * (`holdArtifactBodies`): the body goes into the proposal, not the transcript.
 *
 * Read-only. Returns identifier → the id the proposal will be written with, a
 * fresh `crypto.randomUUID()`, so the held tag can name its proposal before the
 * proposal exists. Decided on the STORED form (`normalizeForStorage`), the
 * same body `persistArtifacts` decides on, so a design's structure is compared
 * as it will be stored, not as the model abbreviated it.
 *
 * Advisory: `persistArtifacts` decides again inside its write. A person who
 * saves between the two is still protected; see `held_unplanned` there.
 */
export async function planHeldReemits(conversationId: string, artifacts: ParsedArtifact[]): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  if (!reemitGuardEnabled()) return held;
  for (const raw of artifacts) {
    if (raw.incomplete || held.has(raw.identifier)) continue;
    const next = normalizeForStorage(raw);
    if (!next) continue;
    const existing = await prisma.artifact.findUnique({
      where: { conversationId_identifier: { conversationId, identifier: next.identifier } },
      select: { id: true, type: true, currentVersion: true, deletedAt: true },
    });
    // No row, a trashed row or a different type: the turn makes a new
    // artifact, and a new artifact has nothing to protect.
    if (!existing || existing.deletedAt || existing.type !== next.type) continue;
    // The plain client, outside any transaction: the plan only reads, and
    // the write decides again inside its own.
    const decision = await decideForRow(prisma as unknown as Db, existing, next);
    if (decision.action === "suggest") held.set(next.identifier, crypto.randomUUID());
  }
  return held;
}

export interface PersistArtifactsOptions {
  /**
   * `planHeldReemits`'s answer: the proposal id each held identifier's tag
   * already names in the saved message. Absent for a caller that saved the
   * message with its bodies (the research audit).
   */
  heldIds?: ReadonlyMap<string, string>;
  /**
   * Write through the caller's transaction instead of opening one per
   * artifact. Every read and write goes through it and none is retried: a lost
   * race aborts the caller's transaction in Postgres, so the caller decides.
   */
  tx?: ArtifactStoreTransaction;
  /** "untrusted-input" when the turn read text Juno did not author; kept on a held proposal. */
  taint?: string | null;
}

type WriteResult = { artifacts: ClientArtifact[]; proposalId?: string };

/**
 * Persist artifacts parsed from an assistant message. Reusing an existing
 * identifier within the conversation appends a new version to the same row,
 * so an artifact keeps its id, history and share links across edits and
 * regenerates.
 *
 * The type never changes on an existing row. A design that came back as an
 * HTML page would otherwise stop opening in the design editor, and every
 * earlier version would be read as the wrong kind. A re-emission with a new
 * type makes a new artifact that takes the identifier (so the model's next
 * tag reaches it), while the old one keeps its id, versions and share links
 * under a retired handle. Both rows are returned, so the client learns the
 * old row's new handle. The link between them is recoverable from the handle
 * and the creation order until it gets its own column. A TRASHED row with the
 * identifier is treated the same way: the re-emit makes a new artifact, and
 * the trashed one keeps its history under a retired handle, so restoring it
 * later can never collide with the live one.
 *
 * THE RE-EMIT GUARD. A re-emit over a person's edit, or one that would remove
 * a design's structure (`decideReemit`), is not appended. It is held as a
 * PENDING suggestion (`ArtifactProposal`) that the person applies or
 * dismisses, and the Artifact row is not touched at all, so nothing syncs and
 * no share or library entry moves. The decision is made again here, inside
 * the write, whatever `planHeldReemits` said.
 */
export async function persistArtifacts(
  conversationId: string,
  messageId: string,
  parsed: ParsedArtifact[],
  opts: PersistArtifactsOptions = {}
): Promise<ClientArtifact[]> {
  const out: ClientArtifact[] = [];
  // A planned id names one proposal. The same identifier twice in one reply
  // is held twice (the second makes the first STALE), and the second needs an
  // id of its own.
  const usedProposalIds = new Set<string>();

  for (const raw of parsed) {
    // A block whose closing tag never arrived is never a version (X-07). The
    // chat path's verifier already refuses one and filters it out before this
    // call; the check is repeated here so a caller that skips verification —
    // the research audit hands over `parseArtifacts(report)` directly — cannot
    // save a half-written body as the artifact's current version.
    if (raw.incomplete) continue;
    const a = normalizeForStorage(raw);
    if (!a) continue;
    const planned = opts.heldIds?.get(a.identifier);
    const proposalId = planned && !usedProposalIds.has(planned) ? planned : crypto.randomUUID();

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await inTransaction(opts.tx, (db) =>
          writeArtifact(db, { conversationId, messageId, artifact: a, proposalId, planned: !!planned, taint: opts.taint ?? null })
        );
        if (result.proposalId) usedProposalIds.add(result.proposalId);
        out.push(...result.artifacts);
        break;
      } catch (error) {
        if (!opts.tx && attempt < WRITE_ATTEMPTS && isWriteRace(error)) continue;
        throw error;
      }
    }
  }

  return out;
}

/** One artifact's write: create, retire-and-create, hold, or append. */
async function writeArtifact(
  db: Db,
  input: {
    conversationId: string;
    messageId: string;
    artifact: ParsedArtifact;
    proposalId: string;
    planned: boolean;
    taint: string | null;
  }
): Promise<WriteResult> {
  const { conversationId, messageId, artifact: a } = input;
  const newArtifact = () =>
    db.artifact.create({
      data: {
        conversationId,
        messageId,
        identifier: a.identifier,
        title: a.title,
        type: a.type,
        language: a.language ?? null,
        currentVersion: 1,
        versions: { create: { version: 1, content: a.content, origin: "generated" } },
      },
      include: { versions: true },
    });

  const existing = await db.artifact.findUnique({
    where: { conversationId_identifier: { conversationId, identifier: a.identifier } },
  });

  if (!existing) return { artifacts: [serializeArtifact(await newArtifact())] };

  if (existing.deletedAt || existing.type !== a.type) {
    const retired = await db.artifact.update({
      where: { id: existing.id },
      data: { identifier: retiredIdentifier(existing.identifier, existing.id) },
      include: ARTIFACT_CLIENT_INCLUDE,
    });
    const created = await newArtifact();
    return { artifacts: [serializeArtifact(retired), serializeArtifact(created)] };
  }

  const decision = await decideForRow(db, existing, a);

  if (decision.action === "suggest") {
    // Unplanned: the plan said append and a person saved in between, or the
    // caller never planned (the research audit). Either way the message was
    // saved with its full body, so it disagrees with the row until the
    // suggestion is applied or dismissed. Rare, harmless on the web (the card
    // reads the row), and worth counting. Ids only: titles are the person's.
    if (!input.planned) console.info("[artifacts] held_unplanned", { artifactId: existing.id, proposalId: input.proposalId });
    const resolvedAt = new Date();
    // Only the newest suggestion can be applied, so an older one still
    // waiting is superseded rather than left to be applied over this one.
    await db.artifactProposal.updateMany({
      where: { artifactId: existing.id, status: PROPOSAL_STATUS.pending },
      data: { status: PROPOSAL_STATUS.stale, resolvedAt },
    });
    const payload: ProposalPayload = { content: a.content, title: a.title, language: a.language ?? null };
    await db.artifactProposal.create({
      data: {
        id: input.proposalId,
        artifactId: existing.id,
        baseVersion: existing.currentVersion,
        payload: payload as unknown as Prisma.InputJsonValue,
        summary: decision.summary,
        messageId,
        taint: input.taint,
      },
    });
    // Read back, never written: the row, its versions and its sync revision
    // are exactly as the person left them.
    const held = await db.artifact.findUnique({ where: { id: existing.id }, include: ARTIFACT_CLIENT_INCLUDE });
    if (!held) throw new ArtifactWriteRaced();
    return { artifacts: [serializeArtifact(held)], proposalId: input.proposalId };
  }

  // The plan held it and the row has since moved on under Juno's own write
  // (another turn appended): the version is kept, and the message's empty tag
  // resolves to it by identifier. Logged for the same reason as above.
  if (input.planned) console.info("[artifacts] planned_hold_appended", { artifactId: existing.id });

  // The version insert comes first, as in every other writer, so two writers
  // always lock in the same order and cannot deadlock. A person who saved
  // since the read above trips the (artifactId, version) key; one who trashed
  // it makes the guarded update below find nothing. Either way the write rolls
  // back and is decided again from the row as it now is.
  const nextVersion = existing.currentVersion + 1;
  await db.artifactVersion.create({
    data: { artifactId: existing.id, version: nextVersion, content: a.content, origin: "generated" },
  });
  const updated = await db.artifact.update({
    where: { id: existing.id, currentVersion: existing.currentVersion, deletedAt: null },
    data: {
      title: a.title,
      language: a.language ?? null,
      currentVersion: nextVersion,
      // messageId stays pinned to the message that first created the
      // artifact while that message is still there, so the inline card
      // in a later turn reads as an update. A detached row (its message
      // was edited away or regenerated) is claimed by this message.
      ...(existing.messageId ? {} : { messageId }),
    },
    include: ARTIFACT_CLIENT_INCLUDE,
  });
  return { artifacts: [serializeArtifact(updated)] };
}

/**
 * Append a model-produced patch to one existing artifact without allowing the
 * model to choose an identifier or replace a newer version. The compare-and-
 * bump and version insert share one interactive transaction; throwing on a
 * stale base rolls both operations back.
 *
 * Not held by the re-emit guard: a targeted edit names its base version
 * explicitly and the person chose to send it, so there is nothing to protect
 * them from. A trashed artifact is not a base (`deletedAt: null`).
 */
export async function persistTargetedArtifactEdit(
  artifactId: string,
  baseVersion: number,
  content: string
): Promise<ClientArtifact> {
  const nextVersion = baseVersion + 1;
  const updated = await prisma.$transaction(async (tx) => {
    const bumped = await tx.artifact.updateMany({
      where: { id: artifactId, currentVersion: baseVersion, deletedAt: null },
      data: { currentVersion: nextVersion },
    });
    if (bumped.count !== 1) throw new ArtifactVersionConflictError();

    await tx.artifactVersion.create({
      data: { artifactId, version: nextVersion, content, origin: "generated" },
    });
    const artifact = await tx.artifact.findUnique({
      where: { id: artifactId },
      include: ARTIFACT_CLIENT_INCLUDE,
    });
    if (!artifact) throw new ArtifactVersionConflictError();
    return artifact;
  });
  return serializeArtifact(updated);
}

/**
 * One of the user's suggestions, with the artifact it belongs to, or null.
 *
 * Owned through the artifact's conversation, as every artifact route is (an
 * anchored artifact's conversation is the account anchor, which carries the
 * owner's userId, so it resolves too). A trashed artifact answers null: its
 * suggestions wait with it in Recently deleted and come back on restore.
 */
export async function loadOwnedProposal(userId: string, artifactId: string, proposalId: string) {
  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId, deletedAt: null, conversation: { userId } },
    select: { id: true, type: true, title: true, currentVersion: true },
  });
  if (!artifact) return null;
  const proposal = await prisma.artifactProposal.findFirst({ where: { id: proposalId, artifactId: artifact.id } });
  if (!proposal) return null;
  return { artifact, proposal };
}

export type ProposalResolution =
  | { ok: true; artifact: ClientArtifact }
  | { ok: false; error: "not_found" }
  /** `stale`: the artifact is no longer at the version the person compared. `resolved`: the suggestion was already applied, dismissed or superseded. `unsupported`: a payload this build cannot apply. */
  | { ok: false; error: "stale" | "resolved" | "unsupported"; artifact: ClientArtifact };

/** Raised inside Apply's transaction to roll it back with a reason; never escapes. */
class ProposalRefused extends Error {
  constructor(readonly reason: "stale" | "resolved") {
    super(reason);
  }
}

async function currentClientArtifact(artifactId: string): Promise<ClientArtifact | null> {
  const row = await prisma.artifact.findFirst({
    where: { id: artifactId, deletedAt: null },
    include: ARTIFACT_CLIENT_INCLUDE,
  });
  return row ? serializeArtifact(row) : null;
}

/**
 * Apply a suggestion: its body becomes the next version, on top of the version
 * the person compared it against (`baseVersion`), or nothing happens.
 *
 * All in one transaction: the version, the compare-and-bump of
 * `currentVersion`, the suggestion marked APPLIED and every other one still
 * waiting marked STALE (they were written against what is now an older
 * version). Refusals roll the whole thing back.
 *
 * The version is inserted BEFORE the bump, the order every other writer uses
 * (POST /api/artifacts/[id], design checkpoints, `persistArtifacts`), so two
 * writers always take their locks in the same order and cannot deadlock; a
 * person's save that got there first trips the `(artifactId, version)` key,
 * which is the same "stale" as a bump that finds a moved `currentVersion`.
 *
 * The version's origin is "generated". It is Juno's work, and the installed
 * Mac and iPhone builds decode origin as a closed enum, so no new value can be
 * written in this release. The title and language do not change: the person
 * named the artifact, and Apply is about the body.
 */
export async function applyArtifactProposal(
  userId: string,
  artifactId: string,
  proposalId: string,
  baseVersion: number
): Promise<ProposalResolution> {
  const owned = await loadOwnedProposal(userId, artifactId, proposalId);
  if (!owned) return { ok: false, error: "not_found" };
  const refuse = async (error: "stale" | "resolved" | "unsupported"): Promise<ProposalResolution> => {
    const artifact = await currentClientArtifact(artifactId);
    return artifact ? { ok: false, error, artifact } : { ok: false, error: "not_found" };
  };
  if (owned.proposal.status !== PROPOSAL_STATUS.pending) return refuse("resolved");
  const payload = owned.proposal.kind === "REWRITE" ? readProposalPayload(owned.proposal.payload) : null;
  if (!payload) return refuse("unsupported");
  // The common stale case, answered before any write: the transaction below
  // settles the rare one where a save lands in between.
  if (owned.artifact.currentVersion !== baseVersion) return refuse("stale");

  const nextVersion = baseVersion + 1;
  try {
    const applied = await prisma.$transaction(async (tx) => {
      await tx.artifactVersion.create({
        data: { artifactId, version: nextVersion, content: payload.content, origin: "generated" },
      });
      const bumped = await tx.artifact.updateMany({
        where: { id: artifactId, currentVersion: baseVersion, deletedAt: null },
        data: { currentVersion: nextVersion },
      });
      if (bumped.count !== 1) throw new ProposalRefused("stale");
      const resolvedAt = new Date();
      // Guarded on PENDING, so two Applies of the same suggestion (two tabs)
      // cannot both land: the second finds nothing and rolls back.
      const marked = await tx.artifactProposal.updateMany({
        where: { id: proposalId, artifactId, status: PROPOSAL_STATUS.pending },
        data: { status: PROPOSAL_STATUS.applied, resolvedAt },
      });
      if (marked.count !== 1) throw new ProposalRefused("resolved");
      await tx.artifactProposal.updateMany({
        where: { artifactId, status: PROPOSAL_STATUS.pending, id: { not: proposalId } },
        data: { status: PROPOSAL_STATUS.stale, resolvedAt },
      });
      return tx.artifact.findUnique({ where: { id: artifactId }, include: ARTIFACT_CLIENT_INCLUDE });
    });
    if (!applied) return { ok: false, error: "not_found" };
    return { ok: true, artifact: serializeArtifact(applied) };
  } catch (error) {
    if (error instanceof ProposalRefused) return refuse(error.reason);
    if (isWriteRace(error)) return refuse("stale");
    throw error;
  }
}

/**
 * Dismiss a suggestion: DISCARDED, and nothing else changes. Idempotent for a
 * suggestion already dismissed (a retried click); one that was applied or
 * superseded meanwhile answers `resolved` with the artifact as it is now,
 * which carries any newer suggestion, so the caller can show that instead.
 */
export async function dismissArtifactProposal(
  userId: string,
  artifactId: string,
  proposalId: string
): Promise<ProposalResolution> {
  const owned = await loadOwnedProposal(userId, artifactId, proposalId);
  if (!owned) return { ok: false, error: "not_found" };
  const marked = await prisma.artifactProposal.updateMany({
    where: { id: proposalId, artifactId, status: PROPOSAL_STATUS.pending },
    data: { status: PROPOSAL_STATUS.discarded, resolvedAt: new Date() },
  });
  const dismissed =
    marked.count === 1 ||
    (await prisma.artifactProposal.findFirst({ where: { id: proposalId, artifactId }, select: { status: true } }))
      ?.status === PROPOSAL_STATUS.discarded;
  const artifact = await currentClientArtifact(artifactId);
  if (!artifact) return { ok: false, error: "not_found" };
  return dismissed ? { ok: true, artifact } : { ok: false, error: "resolved", artifact };
}
