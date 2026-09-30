import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import {
  artifactFileName,
  artifactFileStem,
  artifactMimeType,
  buildArtifactZip,
  isMultiFileType,
} from "@/lib/artifact-bundle";
import { downloadDisposition } from "@/lib/design/export";

export const runtime = "nodejs";

/** How many versions `history=1` reads at most. */
const HISTORY_VERSIONS = 100;

/**
 * Download an artifact (src/lib/artifact-bundle.ts).
 *
 *   ?version=n        the version (default: the current one)
 *   ?format=file|zip  one source file, or a ZIP bundle; by default a ZIP for
 *                     a multi-file artifact (a design) and a file otherwise
 *   ?history=1        (ZIP) every earlier version too, under history/
 *
 * Sealed versions only: a design's unsealed draft is the editor's, and a
 * download is a record of a version.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "download");
  if (limited) return limited;

  const url = new URL(req.url);
  const rawVersion = url.searchParams.get("version");
  const format = url.searchParams.get("format");
  if (format !== null && format !== "file" && format !== "zip") {
    return NextResponse.json({ error: "Unknown format" }, { status: 400 });
  }
  if (rawVersion !== null && !/^\d+$/.test(rawVersion)) {
    return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  }

  const { id } = await params;
  const artifact = await prisma.artifact.findFirst({
    where: ownedArtifactWhere(user.id, { id }),
    select: {
      id: true,
      identifier: true,
      title: true,
      type: true,
      language: true,
      currentVersion: true,
      derivedFromId: true,
      derivedFromVersion: true,
    },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const version = rawVersion ? Number(rawVersion) : artifact.currentVersion;
  const body = await prisma.artifactVersion.findUnique({
    where: { artifactId_version: { artifactId: artifact.id, version } },
    select: { content: true },
  });
  if (!body) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const zip = format === "zip" || (format === null && isMultiFileType(artifact.type));
  if (!zip) {
    return new NextResponse(body.content, {
      headers: {
        "Content-Type": artifactMimeType(artifact.type),
        "Content-Disposition": downloadDisposition(artifactFileName(artifact)),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // An HTML or SVG body is the owner's (or Juno's) page, served from the
        // app's own origin. `attachment` already makes browsers save it; the
        // sandbox is the backstop so it can never run script as Juno if one
        // renders it anyway.
        "Content-Security-Policy": "sandbox",
      },
    });
  }

  // The newest HISTORY_VERSIONS versions at most, so a long history cannot
  // pull every body into memory; the bundle's own budget trims further.
  const history =
    url.searchParams.get("history") === "1"
      ? (
          await prisma.artifactVersion.findMany({
            where: { artifactId: artifact.id },
            orderBy: { version: "desc" },
            take: HISTORY_VERSIONS,
            select: { version: true, content: true, origin: true, createdAt: true },
          })
        ).reverse()
      : [];
  const archive = await buildArtifactZip({ artifact, version, content: body.content, history });
  return new NextResponse(Buffer.from(archive), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": downloadDisposition(`${artifactFileStem(artifact)}.zip`),
      "Cache-Control": "no-store",
    },
  });
}
