import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { getObjectBytes } from "@/lib/storage";
import { serializeArtifact } from "@/lib/work/serializers";
import { contentHashFor } from "@/lib/work/deliverables";
import { buildSpreadsheetPreview } from "@/lib/work/deliverables/spreadsheet-preview";

export const runtime = "nodejs";

/**
 * A spreadsheet deliverable as a grid of text, for looking at in the browser.
 *
 * ── Why this is a route and not a client-side parse ─────────────────────────
 *
 * The site previewer downloads the zip and inflates it in the browser, because
 * a site bundle is HTML that has to reach an iframe anyway. A workbook is not:
 * turning one into a table means exceljs, which is a writer this app already
 * ships on the server and a dependency no chat bundle should grow for a preview
 * of a file most readers download. So the parse happens where the library
 * already lives, and the browser receives rows.
 *
 * ── The hash check is not optional here either ──────────────────────────────
 *
 * Identical to the download route's, and for the identical reason: the object
 * under this version's key may not be the object the run produced — a restored
 * bucket, a lifecycle rule, a key collision — and a table drawn from bytes
 * nobody verified is a table a reviewer will act on. A preview is exactly where
 * somebody decides the numbers are right. If the file Juno recorded and the
 * file it has are different, this says so and shows nothing.
 *
 * Nothing is cached. These are the reader's own generated figures, and a shared
 * cache holding them is a copy of their work outside the account it belongs to.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const artifact = await prisma.workArtifact.findFirst({
    where: { id, userId: user.id, deletedAt: null },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // `serializeArtifact` is the one place the TEXT column is narrowed back to
  // the vocabulary, so the kind is asked of it rather than read raw.
  const { kind } = serializeArtifact(artifact);
  if (kind !== "spreadsheet") {
    return NextResponse.json(
      {
        error: "kind_not_previewable",
        message: "Only a spreadsheet can be previewed as a table. Download this one instead.",
      },
      { status: 415 }
    );
  }

  // Refused rather than defaulted to the current version, the same way the
  // download route refuses it: a typo in a version number must not quietly
  // hand back a different file's figures.
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
    // The row exists and its object does not: Juno's inconsistency rather than
    // a request the caller got wrong, so the key goes to the log and not into
    // the response.
    console.error("[work/artifacts/preview] stored object unreadable", {
      artifactId: artifact.id,
      version: version.version,
      err,
    });
    return NextResponse.json({ error: "bytes_unavailable" }, { status: 502 });
  }

  const view = Buffer.from(stored.bytes.buffer, stored.bytes.byteOffset, stored.bytes.byteLength);
  const actualHash = contentHashFor(view);
  if (actualHash !== version.contentHash) {
    return NextResponse.json(
      {
        error: "content_hash_mismatch",
        message:
          `The stored bytes for version ${version.version} do not match the SHA-256 recorded ` +
          `when it was produced, so this is not the file Juno made. Nothing has been shown. ` +
          `Regenerate the deliverable.`,
        expected: version.contentHash,
        actual: actualHash,
      },
      { status: 409 }
    );
  }

  let preview;
  try {
    preview = await buildSpreadsheetPreview(stored.bytes);
  } catch (err) {
    // Bytes that hashed correctly and still will not open. That is a real
    // answer — it is what `validate.ts` exists to catch before a file is ever
    // stored — and it must not be dressed up as an empty sheet, which reads as
    // "the run produced nothing" rather than "this file is broken".
    console.error("[work/artifacts/preview] workbook unreadable", {
      artifactId: artifact.id,
      version: version.version,
      err,
    });
    return NextResponse.json(
      {
        error: "preview_unavailable",
        message: "This workbook could not be opened for preview. The download is unaffected.",
      },
      { status: 422 }
    );
  }

  return NextResponse.json(
    { version: version.version, ...preview },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
