import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { decryptSecret } from "@/lib/crypto";
import { isUsableGitRef, parseRepoFullName } from "@/lib/code-branches";
import { listRepoSkills } from "@/lib/code-v2/repo-skills";
import { SKILL_MAX_BYTES } from "@/lib/code-v2/skill-parse";

export const runtime = "nodejs";

/**
 * A REPOSITORY'S OWN SKILLS, for a cloud run's Skills selector (skills lane).
 *
 * A cloud run reads `.alevr/skills`, `.juno/skills` and `.claude/skills` from
 * its clone (runner/agent-core/src/skills/cloud.ts). This lists the same
 * folders through GitHub's contents API with the reader's GitHub connection,
 * by the same parser, so the composer offers exactly what the run can read.
 *
 *   GET ?repo=owner/name[&ref=branch]   (or ?owner=&name=)
 *     → 200 { skills: LocalSkillSummary[] }   source "project", repo-relative paths, no bodies
 *       400 { error: "invalid_repo" | "invalid_ref" | "github_not_connected" }
 *       401 { error: "Unauthorized" | "github_unauthorized" }
 *       404 { error: "repo_not_found" }
 *       502 { error: "github_unreachable" }
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const repo =
    parseRepoFullName(searchParams.get("repo")) ??
    parseRepoFullName(`${searchParams.get("owner") ?? ""}/${searchParams.get("name") ?? ""}`);
  if (!repo) return NextResponse.json({ error: "invalid_repo" }, { status: 400 });
  const ref = searchParams.get("ref")?.trim() || null;
  if (ref && !isUsableGitRef(ref)) return NextResponse.json({ error: "invalid_ref" }, { status: 400 });

  const connection = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accessToken: true },
  });
  if (!connection) return NextResponse.json({ error: "github_not_connected" }, { status: 400 });
  let token: string;
  try {
    token = decryptSecret(connection.accessToken);
  } catch {
    return NextResponse.json({ error: "github_not_connected" }, { status: 400 });
  }

  const at = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const call = (path: string, accept = "application/vnd.github+json") =>
    fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}${at}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Juno" },
      cache: "no-store",
    });

  // The repository itself first, so "no such repository" is not "no skills".
  let probe: Response;
  try {
    probe = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Juno" },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
  }
  if (probe.status === 401) return NextResponse.json({ error: "github_unauthorized" }, { status: 401 });
  if (probe.status === 404) return NextResponse.json({ error: "repo_not_found" }, { status: 404 });
  if (!probe.ok) return NextResponse.json({ error: "github_unreachable" }, { status: 502 });

  try {
    const skills = await listRepoSkills({
      async list(dir) {
        const res = await call(dir);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`github ${res.status}`);
        const body = (await res.json().catch(() => null)) as unknown;
        return Array.isArray(body) ? body : null;
      },
      async read(file) {
        const res = await call(file, "application/vnd.github.raw");
        if (!res.ok) return null;
        const length = Number(res.headers.get("content-length") ?? "0");
        if (length > SKILL_MAX_BYTES) return null;
        return res.text();
      },
    });
    return NextResponse.json({ skills }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
  }
}
