import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { decryptSecret } from "@/lib/crypto";
import { isUsableGitRef, parseRepoFullName, type CodeRepoRef } from "@/lib/code-branches";
import {
  HOOKS_MAX_BYTES,
  HOOKS_PATH,
  MAX_HOOK_TRUSTS_PER_REPO,
  hashHooksBytes,
  hookTrustRepoKey,
  isHookHash,
  parseHooksConfig,
  summarizeHooks,
} from "@/lib/code-hook-trust";

export const runtime = "nodejs";

/**
 * PROJECT HOOKS A CLOUD RUN MAY RUN WITHOUT A PERSON (see src/lib/code-hook-trust.ts).
 *
 *   GET                         → { approvals }           every reviewed version, newest first
 *   GET ?repo=owner/name[&ref=] → { repo, ref, file, approvals }
 *        file: { present: false } | { present: true, hash, valid, message?, hooks, text, approved }
 *   POST { repo, ref?, hash }   → 201 { approval }        reads the file again; approves only those bytes
 *   DELETE ?id=                 → { removed: true }
 *
 * Errors: 400 invalid_repo | invalid_ref | invalid_hash | github_not_connected
 *         | hooks_missing | hooks_invalid; 401 Unauthorized | github_unauthorized;
 *         404 repo_not_found | not_found; 409 hooks_changed; 502 github_unreachable.
 */

const APPROVAL_SELECT = {
  id: true,
  repoOwner: true,
  repoName: true,
  configHash: true,
  config: true,
  ref: true,
  createdAt: true,
} as const;

type ApprovalRow = {
  id: string;
  repoOwner: string;
  repoName: string;
  configHash: string;
  config: string;
  ref: string | null;
  createdAt: Date;
};

function serializeApproval(row: ApprovalRow) {
  const parsed = parseHooksConfig(row.config);
  return {
    id: row.id,
    repo: `${row.repoOwner}/${row.repoName}`,
    hash: row.configHash,
    ref: row.ref,
    createdAt: row.createdAt.toISOString(),
    hooks: parsed.ok ? summarizeHooks(parsed.config) : [],
  };
}

const err = (error: string, status: number) => NextResponse.json({ error }, { status });

async function githubToken(userId: string): Promise<string | null> {
  const connection = await prisma.connection.findFirst({
    where: { userId, provider: "github" },
    select: { accessToken: true },
  });
  if (!connection) return null;
  try {
    return decryptSecret(connection.accessToken);
  } catch {
    return null;
  }
}

type HooksRead =
  | { kind: "present"; bytes: Uint8Array }
  | { kind: "absent" }
  | { kind: "too_large" }
  | { kind: "error"; error: string; status: number };

/** The file's raw bytes at `ref` (default branch when null), as the clone would hold them. */
async function readHooksFile(token: string, repo: CodeRepoRef, ref: string | null): Promise<HooksRead> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Juno",
  };
  let probe: Response;
  try {
    probe = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`, {
      headers: { ...headers, Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
  } catch {
    return { kind: "error", error: "github_unreachable", status: 502 };
  }
  if (probe.status === 401) return { kind: "error", error: "github_unauthorized", status: 401 };
  if (probe.status === 404) return { kind: "error", error: "repo_not_found", status: 404 };
  if (!probe.ok) return { kind: "error", error: "github_unreachable", status: 502 };

  const at = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/contents/.alevr/hooks.json${at}`, {
      headers: { ...headers, Accept: "application/vnd.github.raw" },
      cache: "no-store",
    });
  } catch {
    return { kind: "error", error: "github_unreachable", status: 502 };
  }
  if (res.status === 404) return { kind: "absent" };
  if (!res.ok) return { kind: "error", error: "github_unreachable", status: 502 };
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > HOOKS_MAX_BYTES) return { kind: "too_large" };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > HOOKS_MAX_BYTES) return { kind: "too_large" };
  return { kind: "present", bytes };
}

function parseTarget(repoValue: unknown, refValue: unknown) {
  const repo = parseRepoFullName(typeof repoValue === "string" ? repoValue : null);
  if (!repo) return { error: err("invalid_repo", 400) } as const;
  const ref = typeof refValue === "string" && refValue.trim() ? refValue.trim() : null;
  if (ref && !isUsableGitRef(ref)) return { error: err("invalid_ref", 400) } as const;
  return { repo, ref } as const;
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  if (!searchParams.get("repo")) {
    const rows = await prisma.codeHookTrust.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: APPROVAL_SELECT,
    });
    return NextResponse.json({ approvals: rows.map(serializeApproval) }, { headers: { "Cache-Control": "no-store" } });
  }

  const target = parseTarget(searchParams.get("repo"), searchParams.get("ref"));
  if ("error" in target) return target.error;
  const { repo, ref } = target;

  const token = await githubToken(user.id);
  if (!token) return err("github_not_connected", 400);
  const read = await readHooksFile(token, repo, ref);
  if (read.kind === "error") return err(read.error, read.status);

  const rows = await prisma.codeHookTrust.findMany({
    where: { userId: user.id, ...hookTrustRepoKey(repo.owner, repo.name) },
    orderBy: { createdAt: "desc" },
    select: APPROVAL_SELECT,
  });
  const approvals = rows.map(serializeApproval);

  let file;
  if (read.kind === "absent") file = { present: false as const };
  else if (read.kind === "too_large") {
    file = { present: true as const, valid: false, message: `${HOOKS_PATH} is larger than 32 KB, so runs refuse it.`, hooks: [], text: null, hash: null, approved: false };
  } else {
    const text = new TextDecoder().decode(read.bytes);
    const hash = hashHooksBytes(read.bytes);
    const parsed = parseHooksConfig(text);
    file = {
      present: true as const,
      hash,
      valid: parsed.ok,
      ...(parsed.ok ? {} : { message: parsed.message }),
      hooks: parsed.ok ? summarizeHooks(parsed.config) : [],
      text,
      approved: approvals.some((a) => a.hash === hash),
    };
  }

  return NextResponse.json(
    { repo: repo.fullName, ref, file, approvals },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return err("Unauthorized", 401);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return err("invalid_repo", 400);
  const target = parseTarget(body.repo, body.ref);
  if ("error" in target) return target.error;
  const { repo, ref } = target;
  const shown = typeof body.hash === "string" ? body.hash.toLowerCase() : "";
  if (!isHookHash(shown)) return err("invalid_hash", 400);

  const token = await githubToken(user.id);
  if (!token) return err("github_not_connected", 400);
  // Read again: the approval is for the bytes the repository holds now, and
  // only when they are the bytes the person was shown.
  const read = await readHooksFile(token, repo, ref);
  if (read.kind === "error") return err(read.error, read.status);
  if (read.kind !== "present") return err("hooks_missing", 400);
  const hash = hashHooksBytes(read.bytes);
  if (hash !== shown) return err("hooks_changed", 409);
  const text = new TextDecoder().decode(read.bytes);
  if (!parseHooksConfig(text).ok) return err("hooks_invalid", 400);

  const key = hookTrustRepoKey(repo.owner, repo.name);
  const approval = await prisma.$transaction(async (tx) => {
    const row = await tx.codeHookTrust.upsert({
      where: { userId_repoOwner_repoName_configHash: { userId: user.id, ...key, configHash: hash } },
      create: { userId: user.id, ...key, configHash: hash, config: text, ref },
      update: {},
      select: APPROVAL_SELECT,
    });
    // Bounded per repository: the oldest reviewed versions go first.
    const stale = await tx.codeHookTrust.findMany({
      where: { userId: user.id, ...key },
      orderBy: { createdAt: "desc" },
      skip: MAX_HOOK_TRUSTS_PER_REPO,
      select: { id: true },
    });
    if (stale.length) await tx.codeHookTrust.deleteMany({ where: { id: { in: stale.map((s) => s.id) }, userId: user.id } });
    return row;
  });

  return NextResponse.json({ approval: serializeApproval(approval) }, { status: 201 });
}

export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user) return err("Unauthorized", 401);
  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (!id) return err("not_found", 404);
  const { count } = await prisma.codeHookTrust.deleteMany({ where: { id, userId: user.id } });
  if (count === 0) return err("not_found", 404);
  return NextResponse.json({ removed: true });
}
