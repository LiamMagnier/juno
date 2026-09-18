import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { decryptSecret } from "@/lib/crypto";
import { orderBranches, parseRepoFullName } from "@/lib/code-branches";
import type { GitHubRepoItem } from "@/app/api/code/github/repos/route";

export const runtime = "nodejs";

/**
 * ONE REPOSITORY, AND THE BRANCHES A RUN COULD START FROM.
 *
 * The composer has always sent `baseRef` and the runner has always cloned it;
 * what the web lacked was the list, so the base branch was a text field whose
 * only validation was a cloud run failing at `git clone` a minute later. This
 * is that list, straight from GitHub with the stored connector token — the same
 * Connection row + decrypt path as the repos and pulls routes beside it. (The
 * seventh copy of those twelve lines, and it stays a copy on purpose: pulling
 * them into a helper is a change to six routes this package does not own.)
 *
 *   GET ?owner=&name=  (or ?repo=owner/name)
 *     → 200 { repo: GitHubRepoItem, branches: string[], truncated: boolean }
 *       400 { error: "invalid_repo" }          not a repository name
 *       401 { error: "Unauthorized" }          no session
 *       400 { error: "github_not_connected" }  no GitHub connection / dead token
 *       401 { error: "github_unauthorized" }   token revoked/expired — relink
 *       404 { error: "repo_not_found" }        no such repo for THIS token
 *       502 { error: "github_unreachable" }    GitHub errored/rate-limited
 *
 * WHY THE REPOSITORY RIDES ALONG WITH ITS BRANCHES. Both callers need the same
 * probe. The picker knows the repo already (it came from the list) and needs
 * only the branches; a prefilled link (`/code?repositories=owner/name`) knows
 * the two path segments and nothing else — not the default branch, not whether
 * the token can even see it. Asking `GET /repos/{owner}/{repo}` twice from two
 * routes would be two copies of one question and two chances to disagree about
 * what "can't see it" means, so the answer to "tell me about this repository"
 * is one route with one error vocabulary.
 *
 * `repo_not_found` is GitHub's 404 relayed honestly and deliberately not
 * softened: GitHub answers 404 rather than 403 for a private repository the
 * token cannot read, precisely so a probe cannot enumerate private names. This
 * route inherits that property by not trying to tell the two apart.
 */

/** GitHub caps `per_page` at 100; three pages is the ceiling we ask for. */
const BRANCH_PAGE_SIZE = 100;
const MAX_BRANCH_PAGES = 3;

type RepoNode = {
  name?: string;
  full_name?: string;
  private?: boolean;
  default_branch?: string;
  updated_at?: string;
  owner?: { login?: string };
};

type BranchNode = { name?: string };

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const ref =
    parseRepoFullName(searchParams.get("repo")) ??
    parseRepoFullName(`${searchParams.get("owner") ?? ""}/${searchParams.get("name") ?? ""}`);
  if (!ref) return NextResponse.json({ error: "invalid_repo" }, { status: 400 });

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

  const call = (path: string) =>
    fetch(`https://api.github.com/repos/${ref.owner}/${ref.name}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Juno",
      },
      cache: "no-store",
    });

  let repoRes: Response;
  try {
    repoRes = await call("");
  } catch {
    return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
  }
  if (repoRes.status === 401) return NextResponse.json({ error: "github_unauthorized" }, { status: 401 });
  if (repoRes.status === 404) return NextResponse.json({ error: "repo_not_found" }, { status: 404 });
  if (!repoRes.ok) return NextResponse.json({ error: "github_unreachable" }, { status: 502 });

  const node = (await repoRes.json().catch(() => null)) as RepoNode | null;
  if (!node?.owner?.login || !node.name || !node.full_name) {
    return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
  }
  const repo: GitHubRepoItem = {
    owner: node.owner.login,
    name: node.name,
    fullName: node.full_name,
    private: node.private === true,
    defaultBranch: node.default_branch ?? "main",
    updatedAt: node.updated_at ?? "",
  };

  /*
   * Up to three pages, and `truncated` when a fourth would exist.
   *
   * A repository with four hundred branches is a real thing and paging all of
   * them is a request per hundred on a popover open. Three is the compromise;
   * what makes it honest is that the flag reaches the picker, which says the
   * list is partial and keeps the field that names a ref it did not list — a
   * list silently missing the branch someone is looking for is the failure
   * this control was built to end, not one to re-create at a different size.
   */
  const names: string[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
    let res: Response;
    try {
      res = await call(`/branches?per_page=${BRANCH_PAGE_SIZE}&page=${page}`);
    } catch {
      return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
    }
    if (res.status === 401) return NextResponse.json({ error: "github_unauthorized" }, { status: 401 });
    if (!res.ok) return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
    const raw = (await res.json().catch(() => null)) as BranchNode[] | null;
    if (!Array.isArray(raw)) return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
    for (const branch of raw) if (typeof branch?.name === "string") names.push(branch.name);
    if (raw.length < BRANCH_PAGE_SIZE) break;
    if (page === MAX_BRANCH_PAGES) truncated = true;
  }

  return NextResponse.json({ repo, branches: orderBranches(names, repo.defaultBranch), truncated });
}
