import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isOwnerEmail } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { buildObjectKey, putObject } from "@/lib/storage";
import { WORK_ARTIFACT_KINDS } from "@/lib/work/domain";
import { serializeArtifact } from "@/lib/work/serializers";
import {
  DeliverableError,
  attachmentDisposition,
  deliverableRequestSchema,
  generateDeliverable,
  provenanceForStorage,
  statusForDeliverableError,
  type DeliverableValidation,
  type GeneratedDeliverable,
} from "@/lib/work/deliverables";

export const runtime = "nodejs";
/**
 * Packing a .pptx or a large .xlsx is CPU-bound and single-threaded, and the
 * platform default cuts a 300-slide deck off part-way through — which returns a
 * 504 to the caller after the work was already done and paid for.
 */
export const maxDuration = 60;

const MAX_ID_CHARS = 200;
const MAX_IDENTIFIER_CHARS = 120;

const LIST_DEFAULT_LIMIT = 30;
const LIST_MAX_LIMIT = 100;

/**
 * How many times to re-derive the version number when another writer takes it
 * first. Two runs finishing the same deliverable at once is the realistic case
 * and it settles in one extra pass. Follows the allocation loop in
 * `/api/work/skills/[id]/versions`, which solves the identical problem.
 */
const VERSION_ALLOCATION_TRIES = 4;

/** Deliverables a user may generate per minute. Each one is real CPU. */
const GENERATE_RATE_LIMIT = 20;

/**
 * The shape an identifier may take.
 *
 * Narrow because this string is load-bearing in three places: it is half of the
 * `(sessionId, identifier)` unique key, it is the fallback filename in
 * `Content-Disposition` when a title sanitises away to nothing, and it is a
 * component of the object key. A slug cannot carry a path separator into any of
 * them, which is the failure that turns a naming convention into a traversal.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The body of a generate request.
 *
 * Built on `deliverableRequestSchema` rather than beside it, so the spec union
 * and the provenance bounds are defined once in the deliverables module and
 * this route cannot drift into accepting a spec the generators would refuse.
 *
 * There is no `title` field: the artifact's title is the spec's title. Every
 * generator writes that string into the file itself — into `docProps` for the
 * OOXML kinds, into the H1 for a report and a site — so a separate column would
 * be a second source of truth that renders next to a file saying something else.
 */
const createArtifactSchema = deliverableRequestSchema.extend({
  sessionId: z.string().trim().min(1).max(MAX_ID_CHARS),
  identifier: z.string().trim().min(1).max(MAX_IDENTIFIER_CHARS).regex(IDENTIFIER),
  /** The run that produced this. Absent for a deliverable made outside a run. */
  runId: z.string().trim().min(1).max(MAX_ID_CHARS).optional(),
});

const UNVALIDATED_WARNING =
  "This file was produced but could not be re-opened by the validator, so nothing has " +
  "confirmed that it opens. Check it before sending it to anyone.";

/**
 * The validator's verdict, as a JSON column value.
 *
 * Rebuilt key by key rather than cast, for the reason `provenanceForStorage`
 * gives: a detail this build did not measure must be absent from the column
 * rather than stored as `null`, or every later reader has to treat "missing" and
 * "measured as nothing" as two different states when they are one.
 */
function validationForStorage(validation: DeliverableValidation): Prisma.InputJsonValue {
  const details: Record<string, Prisma.InputJsonValue> = {};
  for (const [key, value] of Object.entries(validation.details)) {
    if (value !== undefined) details[key] = value;
  }
  return {
    ok: validation.ok,
    validator: validation.validator,
    checkedAt: validation.checkedAt,
    kind: validation.kind,
    byteSize: validation.byteSize,
    observations: [...validation.observations],
    problems: [...validation.problems],
    details,
  };
}

/**
 * When the head row may claim this deliverable has been validated.
 *
 * `WorkArtifact.validatedAt` describes the current version and nothing else, so
 * a version that failed must clear it rather than leave the stamp its
 * predecessor earned. Leaving it set is the specific failure the column exists
 * to prevent: a broken v2 presented with v1's clean bill of health.
 */
function validatedAtFor(validation: DeliverableValidation): Date | null {
  return validation.ok ? new Date(validation.checkedAt) : null;
}

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const params = new URL(req.url).searchParams;

  const sessionId = params.get("sessionId");
  if (sessionId !== null && (sessionId.length === 0 || sessionId.length > MAX_ID_CHARS)) {
    return NextResponse.json({ error: "Invalid input", parameter: "sessionId" }, { status: 400 });
  }

  // An unrecognised kind is refused rather than ignored, exactly as
  // `parseSessionListQuery` refuses an unknown status: a filter that is silently
  // dropped answers with a plausible list of the wrong artifacts, and nothing in
  // the response says the filter never applied.
  const kind = params.get("kind");
  if (kind !== null && !(WORK_ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "Invalid input", parameter: "kind" }, { status: 400 });
  }

  // Unparseable falls back to the default and anything parseable is clamped,
  // which is the repo's query-param idiom. The clamp is what stops `?limit=1e6`
  // from turning a list view into a full-table read.
  const rawLimit = Number(params.get("limit") ?? String(LIST_DEFAULT_LIMIT));
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), LIST_MAX_LIMIT)
    : LIST_DEFAULT_LIMIT;

  const artifacts = await prisma.workArtifact.findMany({
    where: {
      userId: user.id,
      // A soft-deleted artifact stays queryable for audit and is never listed:
      // the user asked for it to be gone from their list, and that instruction
      // is the whole content of the delete.
      deletedAt: null,
      ...(sessionId !== null ? { sessionId } : {}),
      ...(kind !== null ? { kind } : {}),
    },
    // The order `@@index([userId, updatedAt])` is built for. A new version bumps
    // `updatedAt`, so the deliverable that just changed is the one at the top.
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ artifacts: artifacts.map(serializeArtifact) });
}

/**
 * Generates a deliverable and records it as a version.
 *
 * The order is the substance of this handler:
 *
 *   validate the spec -> generate -> store the bytes -> write the rows
 *
 * The spec is validated first because a schema failure must cost nothing: no
 * CPU, no object, no row. The bytes are written to object storage before the
 * rows that name them, because the two failure directions are not equally bad —
 * an object with no row is unreferenced garbage a sweeper can collect, while a
 * row with no object is a download that 500s forever and a version history with
 * a hole in it.
 *
 * A second POST for the same `(sessionId, identifier)` appends a version to the
 * artifact that is already there. It never creates a second artifact, and it
 * never rewrites the version that exists: history is append-only, because
 * "which file did we send the client on the 3rd" is a question that has to keep
 * its answer after somebody regenerates the deliverable on the 4th.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = createArtifactSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { sessionId, identifier, runId, spec, provenance } = parsed.data;

  // A session id in a body is a claim, and the only thing that makes it true is
  // a row that also carries this user's id.
  const session = await prisma.workSession.findFirst({
    where: { id: sessionId, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (runId) {
    // Scoped to this session as well as this user: a run id from another of the
    // caller's own sessions would file the provenance of this deliverable under
    // work that did not produce it.
    const run = await prisma.workRun.findFirst({
      where: { id: runId, userId: user.id, sessionId: session.id },
      select: { id: true },
    });
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  if (!isOwnerEmail(user.email)) {
    const limited = await rateLimit({
      key: `work-deliverable:${user.id}`,
      limit: GENERATE_RATE_LIMIT,
      windowSec: 60,
    });
    if (!limited.success) {
      return NextResponse.json(
        { error: "Too many deliverables generated. Try again shortly." },
        { status: 429 }
      );
    }
  }

  let generated: GeneratedDeliverable;
  try {
    generated = await generateDeliverable({ spec, provenance });
  } catch (err) {
    if (err instanceof DeliverableError) {
      // `build_failed` is Juno's fault and its message quotes a library's
      // internals, so the caller gets the status and nothing else while the
      // detail goes to the log. The other codes describe the caller's own spec
      // and are only actionable if the sentence comes back with them.
      if (err.code === "build_failed") {
        console.error("[work/artifacts] generation failed", { identifier, kind: spec.kind, err });
        return NextResponse.json({ error: err.code }, { status: 500 });
      }
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: statusForDeliverableError(err.code) }
      );
    }
    throw err;
  }

  // Read without the `deletedAt` filter: `@@unique([sessionId, identifier])`
  // covers soft-deleted rows too, so a create that ignored them would fail on
  // the index instead of on a check that can explain itself.
  const existing = await prisma.workArtifact.findFirst({
    where: { userId: user.id, sessionId: session.id, identifier },
    include: {
      versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, contentHash: true } },
    },
  });

  if (existing?.deletedAt) {
    // Appending here would silently undo a deletion the user asked for, and the
    // artifact would reappear in their list with no action of theirs behind it.
    return NextResponse.json(
      {
        error: "artifact_deleted",
        message:
          `"${identifier}" was deleted in this session. Restoring it is the user's decision, ` +
          `so generate this deliverable under a different identifier.`,
      },
      { status: 409 }
    );
  }

  if (existing && existing.kind !== generated.kind) {
    // `kind` and `mimeType` live on the head and describe every version under
    // it. Changing them to suit a new version would relabel every older version
    // too, and each of those would then download as a file type its bytes are
    // not.
    return NextResponse.json(
      {
        error: "kind_conflict",
        message:
          `"${identifier}" already exists in this session as a ${existing.kind}. A new version ` +
          `must be the same kind, because the kind describes every version of an artifact.`,
      },
      { status: 409 }
    );
  }

  const head = existing?.versions[0];
  if (existing && head && head.contentHash === generated.contentHash) {
    // The same bytes as the version already on top, which is what a retried
    // request whose response was lost produces. Appending would file an
    // identical file as a change and put a version in the history that nothing
    // happened in. `WorkArtifactVersion` has no idempotency-key column, and the
    // content hash is the better key anyway: every generator writes the title
    // into the file, so identical bytes really are the same deliverable rather
    // than a rename that went unnoticed.
    return NextResponse.json(
      {
        artifact: serializeArtifact(existing),
        version: { version: head.version, contentHash: head.contentHash },
        validation: generated.validation,
        replay: true,
      },
      { status: 200 }
    );
  }

  // A fresh key per version, never a key derived from the identifier alone.
  // Reusing one key would overwrite the bytes of the previous version, which is
  // exactly the mutation an append-only history exists to prevent — and it would
  // do it in a place no database constraint can see.
  const storageKey = buildObjectKey(user.id, `${identifier}.${generated.extension}`);
  // The disposition is stored on the object as well as sent by the download
  // route, so bytes fetched straight from the bucket by a presigned URL are
  // still saved rather than rendered. A site bundle or a report rendered inline
  // from a storage origin is content the user did not write executing on a
  // domain they have no reason to distrust.
  await putObject(
    storageKey,
    generated.bytes,
    generated.mimeType,
    attachmentDisposition(generated.title, identifier, generated.kind)
  );

  for (let attempt = 0; attempt < VERSION_ALLOCATION_TRIES; attempt++) {
    try {
      const written = await prisma.$transaction(async (tx) => {
        const current = await tx.workArtifact.findFirst({
          where: { userId: user.id, sessionId: session.id, identifier },
          select: { id: true, kind: true },
        });

        // Re-read inside the transaction, because the pre-check above raced with
        // any other request generating the same identifier. The kind is fixed at
        // creation, so the only thing this can catch is that race — but the
        // artifact it would corrupt is a real one.
        if (current && current.kind !== generated.kind) throw new Error("kind_conflict");

        const artifactId =
          current?.id ??
          (
            await tx.workArtifact.create({
              data: {
                sessionId: session.id,
                userId: user.id,
                identifier,
                title: generated.title,
                kind: generated.kind,
                mimeType: generated.mimeType,
                currentVersion: 1,
                validatedAt: validatedAtFor(generated.validation),
              },
              select: { id: true },
            })
          ).id;

        // The highest version that exists, never `currentVersion`: a pointer can
        // be moved by a restore, and minting from it would re-use a number the
        // unique index has already taken and break every later write.
        const highest = await tx.workArtifactVersion.findFirst({
          // A version row carries no owner column of its own, so the scope is
          // expressed through the head it hangs off. Written as a relation
          // filter rather than left implicit: this query runs on ids derived a
          // few statements up, and a reader should not have to reconstruct that
          // chain to see that it cannot read another account's history.
          where: { artifactId, artifact: { userId: user.id } },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const version = await tx.workArtifactVersion.create({
          data: {
            artifactId,
            version: (highest?.version ?? 0) + 1,
            storageKey,
            byteSize: generated.byteSize,
            contentHash: generated.contentHash,
            origin: "generated",
            provenance: provenanceForStorage(generated.provenance),
            validation: validationForStorage(generated.validation),
            runId: runId ?? null,
          },
        });

        // The pointer moves in the same transaction as the row it points at, so
        // a failure between the two cannot leave a head naming a version that
        // was never written.
        const artifact = await tx.workArtifact.update({
          where: { id: artifactId, userId: user.id },
          data: {
            currentVersion: version.version,
            title: generated.title,
            mimeType: generated.mimeType,
            validatedAt: validatedAtFor(generated.validation),
          },
        });

        return { artifact, version };
      });

      return NextResponse.json(
        {
          artifact: serializeArtifact(written.artifact),
          version: {
            version: written.version.version,
            byteSize: written.version.byteSize,
            contentHash: written.version.contentHash,
            origin: written.version.origin,
            runId: written.version.runId,
            createdAt: written.version.createdAt.toISOString(),
          },
          validation: generated.validation,
          // Stated in the response rather than left to be inferred from
          // `validatedAt: null`, because the caller is usually an agent about to
          // tell a user the deliverable is ready.
          ...(generated.validation.ok ? {} : { warning: UNVALIDATED_WARNING }),
        },
        { status: 201 }
      );
    } catch (err) {
      if (err instanceof Error && err.message === "kind_conflict") {
        return NextResponse.json({ error: "kind_conflict" }, { status: 409 });
      }
      // `(sessionId, identifier)` and `(artifactId, version)` are the two unique
      // constraints this write can violate, and both mean another writer got
      // there first. Re-deriving from a fresh read is the whole recovery.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    }
  }

  return NextResponse.json({ error: "version_conflict" }, { status: 409 });
}
