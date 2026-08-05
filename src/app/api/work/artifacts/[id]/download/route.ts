import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { getObjectBytes } from "@/lib/storage";
import { ARTIFACT_MIME } from "@/lib/work/domain";
import { serializeArtifact } from "@/lib/work/serializers";
import { attachmentDisposition, contentHashFor } from "@/lib/work/deliverables";

export const runtime = "nodejs";

const UNVALIDATED_WARNING =
  "This version has not been re-opened successfully by the validator. It is being served " +
  "because you asked for it, not because anything has confirmed that it opens.";

/**
 * Whether a stored verdict says this version's bytes were re-opened.
 *
 * Rebuilt from the JSON rather than trusted as a shape, the way
 * `degradationList` reads a degradation: the column is written by whichever
 * build produced the version, and a verdict this build cannot read is not a
 * pass. Everything that is not an explicit `ok: true` resolves to "not
 * validated", which is the direction that warns rather than the one that
 * reassures.
 */
function versionValidated(validation: Prisma.JsonValue): boolean {
  if (validation === null || typeof validation !== "object" || Array.isArray(validation)) return false;
  const record = validation as Record<string, Prisma.JsonValue | undefined>;
  return record.ok === true;
}

/**
 * Streams one version of a deliverable.
 *
 * The hash is checked before a single byte goes out, and a mismatch is a 409
 * rather than a download. What that catches is the case nobody has a recovery
 * for otherwise: the object under this version's key is not the object the run
 * produced. Whether that is a bucket restored from an older backup, a lifecycle
 * rule that rewrote it, or a key collision, the honest answer is the same — the
 * file Juno recorded and the file it has are different, and serving the second
 * one under the first one's name is how a report gets forwarded to a client
 * with content nobody in the loop has seen.
 *
 * Verifying means buffering the whole object, so this deliberately does not
 * stream in the incremental sense. That is the trade: a chunked response cannot
 * be un-sent when the last chunk turns out to make the hash wrong, and the
 * per-kind ceilings in `ARTIFACT_MAX_BYTES` are what keep the buffer bounded.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const artifact = await prisma.workArtifact.findFirst({
    where: { id, userId: user.id, deletedAt: null },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Refused rather than clamped or defaulted, unlike a list's `limit`: a
  // download of the wrong version is not a smaller answer to the question, it is
  // a different file, and a typo in a version number must not silently hand back
  // the current one.
  const requested = new URL(req.url).searchParams.get("version");
  let wanted = artifact.currentVersion;
  if (requested !== null) {
    const parsed = Number(requested);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return NextResponse.json({ error: "Invalid input", parameter: "version" }, { status: 400 });
    }
    wanted = parsed;
  }

  const version = await prisma.workArtifactVersion.findFirst({
    where: { artifactId: artifact.id, version: wanted },
  });
  if (!version) return NextResponse.json({ error: "version_not_found" }, { status: 404 });

  let stored: { bytes: Uint8Array };
  try {
    stored = await getObjectBytes(version.storageKey);
  } catch (err) {
    // The row exists and its object does not, which is Juno's inconsistency
    // rather than a request the caller got wrong — hence a 5xx, and hence the
    // key going to the log instead of into the response.
    console.error("[work/artifacts/download] stored object unreadable", {
      artifactId: artifact.id,
      version: version.version,
      err,
    });
    return NextResponse.json({ error: "bytes_unavailable" }, { status: 502 });
  }

  // A view rather than a copy: hashing a 100 MB deck must not hold it twice.
  const view = Buffer.from(stored.bytes.buffer, stored.bytes.byteOffset, stored.bytes.byteLength);
  const actualHash = contentHashFor(view);
  if (actualHash !== version.contentHash) {
    // No separate byte-length check: a different length is a different hash, and
    // a second comparison against `byteSize` would only add a way for a row
    // written before that column was populated to fail a check it cannot pass.
    return NextResponse.json(
      {
        error: "content_hash_mismatch",
        message:
          `The stored bytes for version ${version.version} do not match the SHA-256 recorded ` +
          `when it was produced, so this is not the file Juno made. Nothing has been served. ` +
          `Regenerate the deliverable.`,
        expected: version.contentHash,
        actual: actualHash,
      },
      { status: 409 }
    );
  }

  // The kind column is TEXT, and `serializeArtifact` is the one place in the
  // codebase that narrows it back to the vocabulary. Its fallback is `bundle`,
  // which downloads as a .zip — wrong, but inert, which is the right way to be
  // wrong about a content type.
  const { kind } = serializeArtifact(artifact);
  // From `ARTIFACT_MIME` rather than from the stored `mimeType` column. The map
  // is the single source of truth the extension is also taken from, so the two
  // cannot disagree; a stored column can, and a Content-Type that disagrees with
  // the bytes is how a browser decides to render a file inline that it should
  // have saved.
  const mimeType = ARTIFACT_MIME[kind];

  const validated =
    version.version === artifact.currentVersion
      ? // Both facts describe the current version. If they disagree, something
        // wrote one without the other, and the safe reading of a disagreement
        // about validation is that it did not happen.
        artifact.validatedAt !== null && versionValidated(version.validation)
      : versionValidated(version.validation);

  // The array from storage is sent as it is rather than copied into a fresh
  // one: both storage backends return a freshly allocated buffer, and a copy
  // here would hold a 100 MB deck in memory twice on the way out. The cast is
  // the same one `/api/files/[...key]` uses — `BodyInit` in this build's lib
  // types does not admit a `Uint8Array` whose backing store is not statically
  // an `ArrayBuffer`.
  return new NextResponse(stored.bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(view.byteLength),
      "Content-Disposition": attachmentDisposition(artifact.title, artifact.identifier, kind),
      // These are the user's own generated files; a shared cache holding them is
      // a copy of their work outside the account it belongs to.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Juno-Artifact-Version": String(version.version),
      /** The hash this response was verified against, for a client that re-checks. */
      "X-Juno-Content-Sha256": version.contentHash,
      // The warning a JSON body would carry, in the only place a byte stream has
      // for one. Both headers are constants: a validator's problem text is
      // library output, and library output in a header is a response-splitting
      // bug waiting for a message with a newline in it.
      "X-Juno-Validated": validated ? "true" : "false",
      ...(validated ? {} : { "X-Juno-Validation-Warning": UNVALIDATED_WARNING }),
    },
  });
}
