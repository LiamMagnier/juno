import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { parseBundleManifest } from "@/lib/skills/bundle-manifest";
import { loadSkillBundleFiles } from "@/lib/skills/bundle-store";

export const runtime = "nodejs";

/** At most this much of one file is returned for reading on the page. */
const MAX_TEXT_CHARS = 200_000;

/**
 * One file of a version's kept folder, for the skill's page: what the reader
 * reviews before approving an imported skill's scripts.
 *
 * `?path=scripts/build.py`. Text kinds (instructions, references, scripts)
 * come back as text, cut at 200,000 characters with `truncated`; an asset is
 * described (kind, type, size) and its bytes are not served here. The bytes are
 * read from the stored bundle and checked against the digest the version was
 * scanned under, so what the reader reviews is what the sandbox would mount.
 *
 * Owner only: the version is reached through a head row matched on the
 * signed-in user, as every version read is.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; version: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, version: rawVersion } = await params;
  const versionNumber = Number(rawVersion);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    return NextResponse.json({ error: "invalid_version" }, { status: 400 });
  }
  const path = new URL(req.url).searchParams.get("path") ?? "";
  if (!path || path.length > 300) return NextResponse.json({ error: "invalid_path" }, { status: 400 });

  const skill = await prisma.workSkill.findFirst({ where: { id, userId: user.id, deletedAt: null }, select: { id: true } });
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const version = await prisma.workSkillVersion.findFirst({
    where: { skillId: skill.id, skill: { userId: user.id }, version: versionNumber },
    select: { bundleKey: true, bundleDigest: true, bundleManifest: true },
  });
  if (!version?.bundleKey || !version.bundleDigest) return NextResponse.json({ error: "no_files" }, { status: 404 });
  const manifest = parseBundleManifest(version.bundleManifest);
  const entry = manifest?.files.find((file) => file.path === path);
  if (!manifest || manifest.digest !== version.bundleDigest || !entry) {
    return NextResponse.json({ error: "file_not_found" }, { status: 404 });
  }
  const described = { path: entry.path, kind: entry.kind, mime: entry.mime, size: entry.size, sha256: entry.sha256 };
  if (entry.kind === "asset") {
    return NextResponse.json({ file: { ...described, text: null, truncated: false } }, { headers: { "Cache-Control": "private, no-store" } });
  }
  let files: Map<string, Uint8Array>;
  try {
    files = await loadSkillBundleFiles({ bundleKey: version.bundleKey, bundleDigest: version.bundleDigest });
  } catch {
    return NextResponse.json(
      { error: "bundle_unavailable", message: "This skill's files couldn't be read right now. Try again shortly." },
      { status: 503 }
    );
  }
  const text = new TextDecoder().decode(files.get(entry.path) ?? new Uint8Array());
  return NextResponse.json(
    { file: { ...described, text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS } },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
