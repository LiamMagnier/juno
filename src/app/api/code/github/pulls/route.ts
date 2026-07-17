import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { decryptSecret } from "@/lib/crypto";

export const runtime = "nodejs";

/**
 * The signed-in user's open pull requests, straight from GitHub with the
 * stored connector token (same Connection row + decrypt path the MCP bridge
 * uses — see lib/mcp.ts). No caching: the page owns refresh.
 *
 *   GET → 200 { account, created: PullItem[], involved: PullItem[] }
 *         401 { error: "github_unauthorized" }   token revoked/expired — relink
 *         404 { error: "github_not_connected" }  no GitHub connection
 *         502 { error: "github_unreachable" }    GitHub errored/rate-limited
 *
 *   PullItem = { repo, number, title, url, draft, state, updatedAt, headRef }
 *
 * One GraphQL request covers both sections (REST search/issues cannot return
 * head refs without a per-PR fanout).
 */
export interface GitHubPullItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  state: string;
  updatedAt: string;
  headRef: string | null;
}

type SearchNode = {
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  state?: string;
  updatedAt?: string;
  headRefName?: string | null;
  repository?: { nameWithOwner?: string };
};

const QUERY = /* GraphQL */ `
  query JunoOpenPulls {
    created: search(query: "is:pr is:open author:@me sort:updated-desc", type: ISSUE, first: 30) {
      nodes { ...PullFields }
    }
    involved: search(query: "is:pr is:open involves:@me -author:@me sort:updated-desc", type: ISSUE, first: 30) {
      nodes { ...PullFields }
    }
  }
  fragment PullFields on PullRequest {
    number
    title
    url
    isDraft
    state
    updatedAt
    headRefName
    repository { nameWithOwner }
  }
`;

function toPullItems(nodes: unknown): GitHubPullItem[] {
  if (!Array.isArray(nodes)) return [];
  const items: GitHubPullItem[] = [];
  for (const raw of nodes as SearchNode[]) {
    if (!raw || typeof raw.number !== "number" || !raw.url || !raw.repository?.nameWithOwner) continue;
    items.push({
      repo: raw.repository.nameWithOwner,
      number: raw.number,
      title: raw.title ?? "",
      url: raw.url,
      draft: raw.isDraft === true,
      state: typeof raw.state === "string" ? raw.state.toLowerCase() : "open",
      updatedAt: raw.updatedAt ?? "",
      headRef: typeof raw.headRefName === "string" ? raw.headRefName : null,
    });
  }
  return items;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const connection = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accessToken: true, accountLabel: true },
  });
  if (!connection) return NextResponse.json({ error: "github_not_connected" }, { status: 404 });

  let token: string;
  try {
    token = decryptSecret(connection.accessToken);
  } catch {
    // Key rotated / corrupt ciphertext — the link is unusable; treat as expired.
    return NextResponse.json({ error: "github_unauthorized" }, { status: 401 });
  }

  let res: Response;
  try {
    res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "Juno",
      },
      body: JSON.stringify({ query: QUERY }),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
  }

  if (res.status === 401) return NextResponse.json({ error: "github_unauthorized" }, { status: 401 });
  if (!res.ok) return NextResponse.json({ error: "github_unreachable" }, { status: 502 });

  const payload = (await res.json().catch(() => null)) as {
    data?: { created?: { nodes?: unknown }; involved?: { nodes?: unknown } };
    errors?: unknown[];
  } | null;
  if (!payload?.data || (Array.isArray(payload.errors) && payload.errors.length > 0 && !payload.data.created)) {
    return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
  }

  return NextResponse.json({
    account: connection.accountLabel ?? null,
    created: toPullItems(payload.data.created?.nodes),
    involved: toPullItems(payload.data.involved?.nodes),
  });
}
