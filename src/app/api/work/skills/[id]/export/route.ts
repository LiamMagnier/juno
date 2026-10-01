import JSZip from "jszip";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { formatSkillMd } from "@/lib/skills/package";
import { parseSkillContract } from "@/lib/work/skills";

export const runtime = "nodejs";

/**
 * A skill as a portable file: `?format=md` (default) is its SKILL.md;
 * `?format=zip` is `<name>/SKILL.md` zipped, the shape claude.ai and Claude
 * Code install from. The current version, unless `?version=` names another.
 *
 * Only the instructions travel. Files attached to a skill are the reader's
 * library items, which another host could not open by id anyway, so the
 * export says what it carries rather than pretending to be complete.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const skill = await prisma.workSkill.findFirst({ where: { id, userId: user.id, deletedAt: null, kind: "skill" } });
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const asked = Number(url.searchParams.get("version"));
  const versionNumber = Number.isInteger(asked) && asked > 0 ? asked : skill.currentVersion;
  // Reached only through a head row already matched on userId (see the skill route).
  const version = await prisma.workSkillVersion.findFirst({ where: { skillId: skill.id, version: versionNumber } });
  if (!version) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const requestedTools = Array.isArray(version.requestedTools)
    ? version.requestedTools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const markdown = formatSkillMd({
    slug: skill.slug,
    description: skill.description,
    instructions: version.instructions,
    requestedTools,
    provenance: parseSkillContract(version.contract).provenance,
  });

  if (url.searchParams.get("format") === "zip") {
    const zip = new JSZip();
    zip.file(`${skill.slug}/SKILL.md`, markdown);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${skill.slug}.zip"`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="SKILL.md"`,
      "Cache-Control": "private, no-store",
    },
  });
}
