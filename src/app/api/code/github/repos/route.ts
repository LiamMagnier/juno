import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { decryptSecret } from "@/lib/crypto";

export const runtime = "nodejs";

/**
 * The signed-in user's GitHub repositories (for the Cloud Code repo picker),
 * straight from GitHub with the stored connector token — same Connection row +
 * decrypt path as lib/mcp.ts / the pulls route. User-session authed (NOT a task
 * token). No fake data: an unlinked connector returns an honest error.
 *
 *   GET → 200 { repos: RepoItem[] }
 *         401 { error: "Unauthorized" }         no session
 *         400 { error: "github_not_connected" } no GitHub connection / unusable token
 *         401 { error: "github_unauthorized" }  token revoked/expired — relink
 *         502 { error: "github_unreachable" }   GitHub errored/rate-limited
 *
 *   RepoItem = { owner, name, fullName, private, defaultBranch, updatedAt }
 */
export interface GitHubRepoItem {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

type RepoNode = {
  name?: string;
  full_name?: string;
  private?: boolean;
  default_branch?: string;
  updated_at?: string;
  owner?: { login?: string };
};

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const connection = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accessToken: true },
  });
  if (!connection) return NextResponse.json({ error: "github_not_connected" }, { status: 400 });

  let token: string;
  try {
    token = decryptSecret(connection.accessToken);
  } catch {
    // Key rotated / corrupt ciphertext — the link is unusable; the user relinks.
    return NextResponse.json({ error: "github_not_connected" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch("https://api.github.com/user/repos?sort=updated&per_page=100", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Juno",
      },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
  }

  if (res.status === 401) return NextResponse.json({ error: "github_unauthorized" }, { status: 401 });
  if (!res.ok) return NextResponse.json({ error: "github_unreachable" }, { status: 502 });

  const raw = (await res.json().catch(() => null)) as RepoNode[] | null;
  if (!Array.isArray(raw)) return NextResponse.json({ error: "github_unreachable" }, { status: 502 });

  const repos: GitHubRepoItem[] = [];
  for (const node of raw) {
    if (!node?.owner?.login || !node.name || !node.full_name) continue;
    repos.push({
      owner: node.owner.login,
      name: node.name,
      fullName: node.full_name,
      private: node.private === true,
      defaultBranch: node.default_branch ?? "main",
      updatedAt: node.updated_at ?? "",
    });
  }

  return NextResponse.json({ repos });
}
