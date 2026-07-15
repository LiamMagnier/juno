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
    },
  });
}
