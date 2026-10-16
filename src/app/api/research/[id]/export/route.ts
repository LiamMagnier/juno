import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import { contentTypeFor, toDocx } from "@/lib/office-export";
import { verifyOfficeExport } from "@/lib/office-export-verify";
import { exportFileSlug } from "@/lib/research/export";
import { isTerminalResearchState } from "@/lib/research/domain";

// docx is a Node library.
export const runtime = "nodejs";
export const maxDuration = 60;

/*
 * A finished research report as a Word document (G37).
 *
 * The reader builds the Markdown it exports — the report as it reads, the
 * model's own sources list stripped, the `<!-- … -->` section markers removed,
 * `[n]` kept and a numbered sources appendix added (src/lib/research/export.ts)
 * — because the citation numbering it shows is resolved in the browser from
 * the run, its sources and the citation audit. This route turns that Markdown
 * into a .docx with the same converter and the same open-it-again check the
 * artifact export uses, so the Word file is the document the person just read
 * and never a file that will not open.
 *
 * It is not a general converter: the run must be the caller's, finished, with
 * a report, and the body is bounded and rate-limited like the artifact export.
 * (The saved MARKDOWN artifact's own export is not used: its body still
 * carries the section markers and the model's sources list.)
 */

const MAX_MARKDOWN_CHARS = 400_000;

const bodySchema = z.object({
  format: z.literal("docx"),
  markdown: z.string().min(1).max(MAX_MARKDOWN_CHARS),
  title: z.string().trim().max(300).optional(),
});

/** attr-char per RFC 5987. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `research-export:${user.id}`, limit: 60, windowSec: 3600 });
    if (!limit.success) return NextResponse.json({ error: "Export limit reached. Try again later." }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "This report could not be exported." }, { status: 400 });

  const { id } = await params;
  const run = await prisma.researchRun.findFirst({
    where: { id, userId: user.id },
    select: { id: true, state: true, report: true, goal: true, finishedAt: true, createdAt: true },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isTerminalResearchState(run.state) || !run.report?.trim()) {
    return NextResponse.json({ error: "This research has no finished report yet." }, { status: 409 });
  }

  const title = parsed.data.title?.trim() || run.goal.trim() || "Research report";
  let buffer: Buffer;
  try {
    buffer = await toDocx(parsed.data.markdown, title);
  } catch (err) {
    console.error("[research/export] conversion failed", { id, err });
    return NextResponse.json({ error: "Couldn’t build the Word document. Try again, or download Markdown." }, { status: 500 });
  }
  const verification = await verifyOfficeExport("docx", buffer);
  if (!verification.ok) {
    console.error("[research/export] verification failed", { id, verification });
    return NextResponse.json(
      { error: "The Word document didn’t pass the check that it opens, so nothing was downloaded. Try again, or download Markdown." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const slug = exportFileSlug(title, run.finishedAt ?? run.createdAt);
  const fileName = `${slug}.docx`;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": contentTypeFor("docx"),
      "Content-Length": String(buffer.byteLength),
      // The slug is already ASCII; filename* repeats it for clients that prefer it.
      "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeRfc5987(fileName)}`,
      "Cache-Control": "no-store",
      "X-Juno-Export-Validator": verification.validator,
    },
  });
}
