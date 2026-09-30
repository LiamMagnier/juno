import type { Prisma } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
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
import {
  appendLocked,
  ArtifactVersionConflictError,
  asTx,
  isVersionRace,
  lockArtifact,
  sealArtifactDraft,
  sealDraftLocked,
  type ArtifactTx,
} from "@/lib/artifact-writes";
import type { ParsedArtifact } from "@/lib/message-content";
import type { ClientArtifact } from "@/types/chat";

export { ArtifactVersionConflictError } from "@/lib/artifact-writes";

/**
 * The stored form of each parsed artifact, computed once per object. The chat
 * route hands the same verified artifacts to `planHeldReemits` and then to
 * `persistArtifacts`, and a DESIGN's expansion runs the whole operation layer.
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
export function detachArtifactsFromMessage(messageId: string, userId: string) {
  return prisma.artifact.updateMany({ where: { messageId, userId }, data: { messageId: null } });
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

/** Who owns what a conversation makes, and in which project it lands. */
interface ConversationOwner {
  userId: string;
  projectId: string | null;
}

/**
 * The conversation's owner and project. By the caller's user when it has one
 * (the chat route); otherwise through the unguarded client, because the only
 * callers without one (the research audit) hold a conversation id they have
 * just written a message into, which is the ownership proof.
 */
async function conversationOwner(conversationId: string, userId?: string): Promise<ConversationOwner | null> {
  const row = userId
    ? await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { userId: true, projectId: true } })
    : await prismaUnguarded.conversation.findUnique({ where: { id: conversationId }, select: { userId: true, projectId: true } });
  return row ?? null;
}

type Db = Prisma.TransactionClient;

/**
 * Run `write` in the caller's transaction when there is one, else in a fresh
 * interactive transaction of its own. Prisma has no nested transactions.
 */
function inTransaction<T>(tx: ArtifactTx | undefined, write: (db: Db) => Promise<T>): Promise<T> {
  if (tx) return write(asTx(tx));
  return prisma.$transaction((inner) => write(asTx(inner)));
}

/** Raised inside a write to roll it back and read the row again; never escapes. */
class ArtifactWriteRaced extends Error {}

function isWriteRace(error: unknown): boolean {
  return error instanceof ArtifactWriteRaced || isVersionRace(error);
}

/** One read and one decision are enough to settle any race a person can cause. */
const WRITE_ATTEMPTS = 3;

type ExistingArtifact = { id: string; type: string; currentVersion: number };

/**
 * `decideReemit` for one live, same-type row, read through `db`.
 *
 * A pending draft is the person's editing: it decides as an `edit`, and for a
 * design its body is the one whose structure is compared. The current
 * version's body is read only for a DESIGN; for everything else the origin
 * decides and a 200 000-character body stays in the database.
 */
async function decideForRow(db: Db, existing: ExistingArtifact, userId: string, next: ParsedArtifact): Promise<ReemitDecision> {
  const enabled = reemitGuardEnabled();
  if (!enabled) return { action: "append" };
  const isDesign = existing.type === "DESIGN";
  const draft = await db.artifactDraft.findFirst({
    where: { artifactId: existing.id, userId },
    select: { baseVersion: true, content: isDesign },
  });
  const current = draft
    ? null
    : await db.artifactVersion.findUnique({
        where: { artifactId_version: { artifactId: existing.id, version: existing.currentVersion } },
        select: { origin: true, content: isDesign },
      });
  return decideReemit({
    type: existing.type,
    currentOrigin: draft ? "edit" : current?.origin ?? null,
    currentContent: ((draft ?? current) as { content?: string } | null)?.content ?? null,
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
 * fresh `crypto.randomUUID()`, so the held tag can name its proposal before
 * the proposal exists. Advisory: `persistArtifacts` decides again inside its
 * write, so a person who saves between the two is still protected.
 */
export async function planHeldReemits(
  conversationId: string,
  artifacts: ParsedArtifact[],
  userId?: string
): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  if (!reemitGuardEnabled()) return held;
  const owner = await conversationOwner(conversationId, userId);
  if (!owner) return held;
  for (const raw of artifacts) {
    if (raw.incomplete || held.has(raw.identifier)) continue;
    const next = normalizeForStorage(raw);
    if (!next) continue;
    const existing = await prisma.artifact.findFirst({
      where: { conversationId, identifier: next.identifier, userId: owner.userId },
      select: { id: true, type: true, currentVersion: true, deletedAt: true },
    });
    // No row, a trashed row or a different type: the turn makes a new
    // artifact, and a new artifact has nothing to protect.
    if (!existing || existing.deletedAt || existing.type !== next.type) continue;
    const decision = await decideForRow(prisma as unknown as Db, existing, owner.userId, next);
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
  tx?: ArtifactTx;
  /** "untrusted-input" when the turn read text Juno did not author; kept on a held proposal. */
  taint?: string | null;
  /** The signed-in owner, when the caller has one (the chat route). */
  userId?: string;
}

type WriteResult = { artifacts: ClientArtifact[]; proposalId?: string };

/**
 * Persist artifacts parsed from an assistant message. Reusing an existing
 * identifier within the conversation appends a new version to the same row,
 * so an artifact keeps its id, history and links across edits and
 * regenerates.
 *
 * Every row is written with its OWNER and its PROJECT (the conversation's), so
 * it survives the conversation (PRODUCT_REFOUNDATION §10).
 *
 * The type never changes on an existing row. A re-emission with a new type
 * makes a new artifact that takes the identifier, while the old one keeps its
 * id, versions and links under a retired handle; both rows are returned. A
 * TRASHED row with the identifier is treated the same way, so restoring it
 * later can never collide with the live one.
 *
 * THE RE-EMIT GUARD. A re-emit over a person's edit (a version they saved, or
 * a design draft they have not sealed), or one that would remove a design's
 * structure (`decideReemit`), is not appended. It is held as a PENDING
 * suggestion (`ArtifactProposal`) that the person applies or dismisses, and
 * the Artifact row is not touched at all, so nothing syncs and no link moves.
 */
export async function persistArtifacts(
  conversationId: string,
  messageId: string,
  parsed: ParsedArtifact[],
  opts: PersistArtifactsOptions = {}
): Promise<ClientArtifact[]> {
  const out: ClientArtifact[] = [];
  if (parsed.length === 0) return out;
  const owner = await conversationOwner(conversationId, opts.userId);
  if (!owner) return out;
  // A planned id names one proposal. The same identifier twice in one reply
  // is held twice (the second makes the first STALE), and the second needs an
  // id of its own.
  const usedProposalIds = new Set<string>();

  for (const raw of parsed) {
    // A block whose closing tag never arrived is never a version (X-07). The
    // chat path's verifier already refuses one; the check is repeated here so
    // a caller that skips verification cannot save a half-written body.
    if (raw.incomplete) continue;
    const a = normalizeForStorage(raw);
    if (!a) continue;
    const planned = opts.heldIds?.get(a.identifier);
    const proposalId = planned && !usedProposalIds.has(planned) ? planned : crypto.randomUUID();

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await inTransaction(opts.tx, (db) =>
          writeArtifact(db, { conversationId, messageId, owner, artifact: a, proposalId, planned: !!planned, taint: opts.taint ?? null })
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

async function readClientArtifact(db: Db, artifactId: string, userId: string) {
  const row = await db.artifact.findFirst({ where: { id: artifactId, userId }, include: ARTIFACT_CLIENT_INCLUDE });
  if (!row) throw new ArtifactWriteRaced();
  return serializeArtifact(row);
}

/** One artifact's write: create, retire-and-create, hold, or append. */
async function writeArtifact(
  db: Db,
  input: {
    conversationId: string;
    messageId: string;
    owner: ConversationOwner;
    artifact: ParsedArtifact;
    proposalId: string;
    planned: boolean;
    taint: string | null;
  }
): Promise<WriteResult> {
  const { conversationId, messageId, owner, artifact: a } = input;
  const newArtifact = async () => {
    const created = await db.artifact.create({
      data: {
        userId: owner.userId,
        projectId: owner.projectId,
        conversationId,
        messageId,
        identifier: a.identifier,
        title: a.title,
        type: a.type,
        language: a.language ?? null,
        currentVersion: 1,
        versions: { create: { version: 1, content: a.content, origin: "generated" } },
      },
      include: ARTIFACT_CLIENT_INCLUDE,
    });
    return serializeArtifact(created);
  };

  const existing = await db.artifact.findFirst({
    where: { conversationId, identifier: a.identifier, userId: owner.userId },
    select: { id: true, type: true, currentVersion: true, deletedAt: true, messageId: true },
  });

  if (!existing) return { artifacts: [await newArtifact()] };

  if (existing.deletedAt || existing.type !== a.type) {
    await db.artifact.update({
      where: { id: existing.id, userId: owner.userId },
      data: { identifier: retiredIdentifier(a.identifier, existing.id) },
    });
    const retired = await db.artifact.findFirst({
      where: { id: existing.id, userId: owner.userId },
      include: ARTIFACT_CLIENT_INCLUDE,
    });
    const created = await newArtifact();
    return { artifacts: [...(retired ? [serializeArtifact(retired)] : []), created] };
  }

  const locked = await lockArtifact(db, existing.id, { userId: owner.userId });
  if (!locked) throw new ArtifactWriteRaced();
  const decision = await decideForRow(db, locked, owner.userId, a);

  if (decision.action === "suggest") {
    // Unplanned: the plan said append and a person saved in between, or the
    // caller never planned (the research audit). The message was saved with
    // its full body, so it disagrees with the row until the suggestion is
    // applied or dismissed. Ids only in the log: titles are the person's.
    if (!input.planned) console.info("[artifacts] held_unplanned", { artifactId: locked.id, proposalId: input.proposalId });
    const resolvedAt = new Date();
    await db.artifactProposal.updateMany({
      where: { artifactId: locked.id, status: PROPOSAL_STATUS.pending },
      data: { status: PROPOSAL_STATUS.stale, resolvedAt },
    });
    const payload: ProposalPayload = { content: a.content, title: a.title, language: a.language ?? null };
    await db.artifactProposal.create({
      data: {
        id: input.proposalId,
        artifactId: locked.id,
        baseVersion: locked.currentVersion,
        payload: payload as unknown as Prisma.InputJsonValue,
        summary: decision.summary,
        messageId,
        taint: input.taint,
      },
    });
    // Read back, never written: the row, its versions, its draft and its sync
    // revision are exactly as the person left them.
    return { artifacts: [await readClientArtifact(db, locked.id, owner.userId)], proposalId: input.proposalId };
  }

  if (input.planned) console.info("[artifacts] planned_hold_appended", { artifactId: locked.id });

  // With the guard on, an append never meets a draft (a draft decides as an
  // edit). With it off, the person's draft is sealed first so Juno's version
  // lands on top of it rather than replacing it.
  await sealDraftLocked(db, locked);
  await appendLocked(
    db,
    locked,
    { content: a.content, origin: "generated" },
    {
      title: a.title,
      language: a.language ?? null,
      // messageId stays pinned to the message that first created the
      // artifact while that message is still there, so the inline card
      // in a later turn reads as an update. A detached row (its message
      // was edited away or regenerated) is claimed by this message.
      ...(existing.messageId ? {} : { message: { connect: { id: messageId } } }),
    }
  );
  return { artifacts: [await readClientArtifact(db, locked.id, owner.userId)] };
}

/**
 * Append a model-produced patch to one existing artifact without allowing the
 * model to choose an identifier or replace a newer version. Lock, compare,
 * append in one transaction; a stale base rolls everything back.
 *
 * Not held by the re-emit guard: a targeted edit names its base version
 * explicitly and the person chose to send it. The caller seals the draft
 * before it reads the base (the chat route does), so the base it names is the
 * working copy the person selected from.
 */
export async function persistTargetedArtifactEdit(
  artifactId: string,
  baseVersion: number,
  content: string,
  userId: string
): Promise<ClientArtifact> {
  const updated = await prisma.$transaction(async (tx) => {
    const locked = await lockArtifact(tx, artifactId, { userId });
    if (!locked) throw new ArtifactVersionConflictError();
    await sealDraftLocked(tx, locked);
    if (locked.currentVersion !== baseVersion) throw new ArtifactVersionConflictError(locked.currentVersion);
    await appendLocked(tx, locked, { content, origin: "generated" });
    return tx.artifact.findFirst({ where: { id: artifactId, userId }, include: ARTIFACT_CLIENT_INCLUDE });
  });
  if (!updated) throw new ArtifactVersionConflictError();
  return serializeArtifact(updated);
}

// ─── Suggestions (the re-emit guard's Apply and Dismiss) ───────────────────

/**
 * One of the user's suggestions, with the artifact it belongs to, or null. A
 * trashed artifact answers null: its suggestions wait with it in Recently
 * deleted and come back on restore.
 */
export async function loadOwnedProposal(userId: string, artifactId: string, proposalId: string) {
  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId, userId, deletedAt: null },
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
  /** `stale`: the artifact moved past the version the person compared. `resolved`: already applied, dismissed or superseded. `unsupported`: a payload this build cannot apply. */
  | { ok: false; error: "stale" | "resolved" | "unsupported"; artifact: ClientArtifact };

class ProposalRefused extends Error {
  constructor(readonly reason: "stale" | "resolved") {
    super(reason);
  }
}

async function currentClientArtifact(artifactId: string, userId: string): Promise<ClientArtifact | null> {
  const row = await prisma.artifact.findFirst({
    where: { id: artifactId, userId, deletedAt: null },
    include: ARTIFACT_CLIENT_INCLUDE,
  });
  return row ? serializeArtifact(row) : null;
}

/**
 * Apply a suggestion: its body becomes the next version, on top of the version
 * the person compared it against (`baseVersion`), or nothing happens.
 *
 * `baseVersion` is what the person's screen showed, which presents an unsealed
 * design draft as `currentVersion + 1`. So the draft is sealed first (its own
 * transaction, so it survives a refusal), and then everything else happens in
 * one locked transaction: the compare, the version, the suggestion marked
 * APPLIED and any other one still waiting marked STALE.
 *
 * The version's origin is "generated": it is Juno's work, and the installed Mac
 * and iPhone builds decode origin as a closed enum. The title does not change:
 * the person named the artifact, and Apply is about the body.
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
    const artifact = await currentClientArtifact(artifactId, userId);
    return artifact ? { ok: false, error, artifact } : { ok: false, error: "not_found" };
  };
  if (owned.proposal.status !== PROPOSAL_STATUS.pending) return refuse("resolved");
  const payload = owned.proposal.kind === "REWRITE" ? readProposalPayload(owned.proposal.payload) : null;
  if (!payload) return refuse("unsupported");

  await sealArtifactDraft(artifactId, userId);
  try {
    const applied = await prisma.$transaction(async (tx) => {
      const locked = await lockArtifact(tx, artifactId, { userId });
      if (!locked) throw new ProposalRefused("stale");
      await sealDraftLocked(tx, locked);
      if (locked.currentVersion !== baseVersion) throw new ProposalRefused("stale");
      const resolvedAt = new Date();
      // Guarded on PENDING, so two Applies of the same suggestion (two tabs)
      // cannot both land: the second finds nothing and rolls back.
      const marked = await tx.artifactProposal.updateMany({
        where: { id: proposalId, artifactId, status: PROPOSAL_STATUS.pending },
        data: { status: PROPOSAL_STATUS.applied, resolvedAt },
      });
      if (marked.count !== 1) throw new ProposalRefused("resolved");
      await appendLocked(tx, locked, { content: payload.content, origin: "generated" });
      await tx.artifactProposal.updateMany({
        where: { artifactId, status: PROPOSAL_STATUS.pending, id: { not: proposalId } },
        data: { status: PROPOSAL_STATUS.stale, resolvedAt },
      });
      return tx.artifact.findFirst({ where: { id: artifactId, userId }, include: ARTIFACT_CLIENT_INCLUDE });
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
 * suggestion already dismissed; one applied or superseded meanwhile answers
 * `resolved` with the artifact as it is now.
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
  const artifact = await currentClientArtifact(artifactId, userId);
  if (!artifact) return { ok: false, error: "not_found" };
  return dismissed ? { ok: true, artifact } : { ok: false, error: "resolved", artifact };
}
