import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import {
  detectFormats,
  toDocx,
  toXlsx,
  toPptx,
  contentTypeFor,
  extensionFor,
  type OfficeFormat,
} from "@/lib/office-export";
import { exportVerificationMessage, verifyOfficeExport } from "@/lib/office-export-verify";

// docx/exceljs/pptxgenjs are Node libraries — they do not run on Edge.
export const runtime = "nodejs";
export const maxDuration = 60;

const formatSchema = z.enum(["docx", "xlsx", "pptx"]);

const BUILDERS: Record<OfficeFormat, (md: string, title: string) => Promise<Buffer>> = {
  docx: toDocx,
  xlsx: toXlsx,
  pptx: toPptx,
};

// Path separators, quotes, shell/Windows-reserved punctuation and control chars —
// anything that could break out of the filename or the Content-Disposition header.
const UNSAFE_NAME = /[\x00-\x1f\x7f"'\\/:*?<>|]/g;

function sanitizeName(raw: string): string {
  return raw
    .replace(UNSAFE_NAME, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "") // a leading dot would make it a hidden/extension-less file
    .slice(0, 80)
    .trim();
}

/** attr-char per RFC 5987 — encodeURIComponent leaves a few chars this grammar forbids. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Render an artifact's latest markdown as a real Office file.
 *
 * GET ?format=docx|xlsx|pptx -> the binary. Omit `format` and it answers with the
 * formats this artifact's content can actually produce, so the client can offer
 * only those without pulling the (heavy, Node-only) converters into the bundle.
 *
 * Nothing is streamed until it has been re-opened and read back. See
 * `verifyOfficeExport`: the builder finishing is not the same claim as the file
 * opening, and this route serves the second one.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const raw = new URL(req.url).searchParams.get("format");

  if (!isOwnerEmail(user.email)) {
    // Detection is one indexed read; generation is CPU-bound. Separate budgets so
    // browsing the canvas can never exhaust the export allowance.
    const limit = raw
      ? await rateLimit({ key: `artifact-export:${user.id}`, limit: 60, windowSec: 3600 })
      : await rateLimit({ key: `artifact-export-detect:${user.id}`, limit: 400, windowSec: 3600 });
    if (!limit.success) {
      return NextResponse.json({ error: "Export limit reached. Try again later." }, { status: 429 });
    }
  }

  // An artifact id alone must never grant access — join through the owning conversation.
  const artifact = await prisma.artifact.findFirst({
    where: { id, conversation: { userId: user.id } },
    select: {
      identifier: true,
      title: true,
      type: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { content: true } },
    },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const content = artifact.versions[0]?.content ?? "";
  // Office export is a markdown->document conversion; other types have their own shapes.
  const available = artifact.type === "MARKDOWN" ? detectFormats(content) : [];

  if (raw === null) {
    return NextResponse.json({ formats: available }, { headers: { "Cache-Control": "no-store" } });
  }

  const parsed = formatSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Invalid format" }, { status: 400 });
  const format = parsed.data;

  if (!available.includes(format)) {
    return NextResponse.json(
      { error: `This artifact can’t be exported as ${format}.` },
      { status: 400 }
    );
  }

  let buffer: Buffer;
  try {
    buffer = await BUILDERS[format](content, artifact.title);
  } catch (err) {
    console.error("[artifacts/export] conversion failed", { id, format, err });
    return NextResponse.json({ error: "Could not build the file." }, { status: 500 });
  }

  // The builder returning a Buffer is not evidence the file opens, and this
  // route used to treat it as though it were: a docx whose word/document.xml is
  // missing, or a deck that came out with no slides, streamed with a 200 and an
  // Office content type and failed on the reader's machine. Re-open it with a
  // reader that had no part in writing it — the same check the Work pipeline
  // applies to the same three formats — and refuse rather than serve.
  const verification = await verifyOfficeExport(format, buffer);
  if (!verification.ok) {
    // The report is what makes this diagnosable after the fact: which build's
    // rules judged it, what the reader found, and how big the file was. It goes
    // to the log in full and to the client alongside the message, because the
    // person who hit it is the only one who can say which artifact and which
    // edit produced it, and asking them to reproduce it later loses that.
    console.error("[artifacts/export] verification failed", { id, format, verification });
    return NextResponse.json(
      { error: exportVerificationMessage(format), verification },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const base = sanitizeName(artifact.title) || sanitizeName(artifact.identifier) || "artifact";
  const ext = extensionFor(format);
  const fileName = `${base}.${ext}`;
  // filename= must stay ASCII for old clients; filename* carries the real title.
  const asciiBase =
    base.replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim() ||
    sanitizeName(artifact.identifier).replace(/[^\x20-\x7e]/g, "").trim() ||
    "artifact";

  // Copy into a plain view: Buffer.buffer can be a shared pool slab, which would
  // leak unrelated memory into the response body.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": contentTypeFor(format),
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `attachment; filename="${asciiBase}.${ext}"; filename*=UTF-8''${encodeRfc5987(fileName)}`,
      "Cache-Control": "no-store",
      // Which build's rules cleared these bytes. A download that arrives with no
      // such header came from a deployment that did not check, and telling those
      // two apart from a saved response is the whole reason it is stamped here
      // rather than only written to a log the file outlives.
      "X-Juno-Export-Validator": verification.validator,
    },
  });
}
