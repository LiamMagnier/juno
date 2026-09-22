/**
 * Importing skills from a GitHub repository.
 *
 * THE UNIT IS A REPOSITORY, NOT A FILE. That is the shape both ecosystems
 * converged on and the shape people actually hold: Claude Code's
 * `/plugin marketplace add anthropics/skills` treats the repo as the
 * marketplace with no publishing step in between, and the skill somebody wants
 * is a folder inside one, next to twenty others. So this module walks the tree
 * once and returns everything it found, and the route makes the reader choose —
 * rather than asking them to paste one `SKILL.md` URL at a time, which is the
 * design that makes people give up on the second skill.
 *
 * WHAT IS DELIBERATELY NOT FETCHED. A skill directory may also hold
 * `scripts/`, `references/` and `assets/` — Anthropic's "level 3", read by an
 * agent with a filesystem and a shell. Juno has neither in a chat turn, and a
 * `scripts/` directory pulled from a stranger's repository and executed
 * anywhere is precisely the exfiltration shape Anthropic's own security note
 * describes. The tree listing already says what else the folder held, so the
 * preview can report "also ships 4 scripts, not imported" without a single
 * extra request and without ever holding the bytes.
 *
 * NO `server-only` AND NO PRISMA. `fetch` is injected, so
 * `tests/skills-github.test.ts` drives the whole discovery path — URL parsing,
 * ref resolution, tree walking, refusal mapping — against a scripted transport
 * with no network and no database.
 */

import { parseSkillMd, SKILL_MD_FILENAME, type ParsedSkillMd, type SkillMdRefusal } from "@/lib/skills/skill-md";

export const GITHUB_API_BASE = "https://api.github.com";

/** How many `SKILL.md` files one import may consider. */
export const MAX_DISCOVERED_SKILLS = 25;
/** Entries in one tree response before the walk stops looking. */
export const MAX_TREE_ENTRIES = 40_000;
/** A ref written with slashes (`release/2026-09`) is resolved in this many tries. */
const MAX_REF_SEGMENTS = 3;
/** One request's ceiling. Generous for a Markdown file, closed for a tarball. */
const MAX_FILE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export interface GithubSkillSource {
  owner: string;
  repo: string;
  /** The branch, tag or SHA as written, or null to use the default branch. */
  ref: string | null;
  /** A directory to scope the walk to. Empty string means the whole repo. */
  path: string;
  /**
   * The URL pointed at one file rather than at a directory.
   *
   * Kept because it changes what "found nothing" means: a `blob` URL at a file
   * that is not a `SKILL.md` is a mistake worth naming, where an empty
   * directory is just an empty directory.
   */
  pointsAtFile: boolean;
}

/**
 * Reads the forms a person actually has in their clipboard.
 *
 *   anthropics/skills
 *   https://github.com/anthropics/skills
 *   https://github.com/anthropics/skills.git
 *   git@github.com:anthropics/skills.git
 *   https://github.com/anthropics/skills/tree/main/skills/pdf
 *   https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md
 *
 * Returns null for anything else — including a URL at another host. Restricting
 * this to github.com is not politeness about other forges: the fetches below go
 * to an API whose shape is GitHub's, and accepting a hostname it then ignores
 * would send somebody's self-hosted GitLab URL to github.com and report that
 * their repository does not exist.
 *
 * The `tree/<ref>/<path>` form is genuinely ambiguous — a branch may contain
 * slashes, so `tree/release/2026/skills` could be ref `release` with path
 * `2026/skills` or ref `release/2026` with path `skills`, and the URL carries
 * nothing that distinguishes them. The first segment is taken here and
 * `resolveRef` below tries progressively longer candidates against the API,
 * which is the only thing that can actually answer it.
 */
export function parseGithubSkillSource(raw: string): GithubSkillSource | null {
  const input = raw.trim();
  if (!input) return null;

  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(input);
  if (scp) return { owner: scp[1], repo: scp[2], ref: null, path: "", pointsAtFile: false };

  const shorthand = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/.exec(input);
  if (shorthand) {
    return { owner: shorthand[1], repo: shorthand[2], ref: null, path: "", pointsAtFile: false };
  }

  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (!owner || !repo) return null;

  const kind = segments[2];
  if (kind !== "tree" && kind !== "blob") {
    return { owner, repo, ref: null, path: "", pointsAtFile: false };
  }
  const rest = segments.slice(3);
  if (rest.length === 0) return { owner, repo, ref: null, path: "", pointsAtFile: false };
  return {
    owner,
    repo,
    ref: rest[0],
    path: rest.slice(1).join("/"),
    pointsAtFile: kind === "blob",
  };
}

export type GithubImportRefusal =
  /** No repository of that name, or none this credential can see. */
  | "not_found"
  /** GitHub refused the credential outright. */
  | "unauthorized"
  /** Secondary or primary rate limit. Naming it separately is the whole point. */
  | "rate_limited"
  /** The repo is bigger than one tree response, so the walk cannot be complete. */
  | "tree_truncated"
  /** The walk completed and found no `SKILL.md`. */
  | "no_skills"
  /** A `blob` URL at something that is not a skill file. */
  | "not_a_skill_file"
  /** Network, timeout, or a response GitHub should not have sent. */
  | "unreachable";

export const GITHUB_IMPORT_REFUSAL_MESSAGES: Record<GithubImportRefusal, string> = {
  not_found:
    "GitHub has no repository there, or it is private and Juno cannot see it. Connect GitHub on the Connections page to import from a private repository.",
  unauthorized:
    "GitHub refused the credential Juno used. Reconnect GitHub on the Connections page and try again.",
  rate_limited:
    "GitHub is rate-limiting Juno right now. Connecting your GitHub account raises the limit considerably; otherwise this clears on its own within the hour.",
  tree_truncated:
    "This repository is too large to list in one pass. Paste a link to the folder the skills are in — the tree or blob URL from GitHub's own file browser works.",
  no_skills:
    "Juno walked the repository and found no SKILL.md. A skill is a folder with a SKILL.md at its head; this repository has none where it looked.",
  not_a_skill_file: `That link points at a file that is not a ${SKILL_MD_FILENAME}. Link the skill's folder, or the ${SKILL_MD_FILENAME} inside it.`,
  unreachable: "Juno could not reach GitHub. Nothing was imported.",
};

/** Where a skill came from, kept so the question survives the import. */
export interface GithubSkillProvenance {
  owner: string;
  repo: string;
  /** The ref as resolved — a branch or tag name, or the SHA if that is what was given. */
  ref: string;
  /** The commit the import actually read. A branch moves; this does not. */
  commit: string;
  /** Repository-relative path of the `SKILL.md`. */
  path: string;
  /** A permalink at the commit, so the link keeps working after a force-push. */
  url: string;
}

export interface GithubSkillCandidate {
  /** Repository-relative path of the `SKILL.md` that produced this. */
  path: string;
  /** The directory it sits in — "" at the repository root. */
  directory: string;
  skill: ParsedSkillMd;
  provenance: GithubSkillProvenance;
  /**
   * What else the skill's folder holds, as paths relative to it.
   *
   * Listed from the tree, never fetched. The preview shows the count so a
   * reader importing a skill that ships four scripts learns that from Juno
   * rather than from the skill quietly not working.
   */
  companionFiles: string[];
}

/** A `SKILL.md` that was found and could not be read. Reported, not dropped. */
export interface GithubSkillProblem {
  path: string;
  reason: SkillMdRefusal;
}

export interface GithubDiscovery {
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  candidates: GithubSkillCandidate[];
  problems: GithubSkillProblem[];
  /** True when more than `MAX_DISCOVERED_SKILLS` files matched. */
  more: boolean;
}

export type GithubDiscoveryResult =
  | { ok: true; discovery: GithubDiscovery }
  | { ok: false; reason: GithubImportRefusal };

export interface GithubClient {
  fetch: typeof fetch;
  /** A user's OAuth token, when they have connected GitHub. Optional. */
  token?: string | null;
  signal?: AbortSignal;
}

function headers(client: GithubClient, accept: string): Record<string, string> {
  const out: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub refuses requests with no User-Agent, and a named one is what makes
    // an abuse report actionable for them rather than a mystery.
    "User-Agent": "Juno-Skill-Import",
  };
  if (client.token) out.Authorization = `Bearer ${client.token}`;
  return out;
}

type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: GithubImportRefusal };

/**
 * One GitHub call, with every failure mode mapped to a refusal.
 *
 * 403 is split from 401 on the rate-limit headers rather than on the status,
 * because GitHub returns 403 for both "your token is not allowed to do that"
 * and "you have made too many requests", and those are different sentences for
 * the reader — one is fixed by connecting an account and the other by waiting.
 */
async function call<T>(
  client: GithubClient,
  url: string,
  accept = "application/vnd.github+json"
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  client.signal?.addEventListener("abort", onAbort);
  try {
    const response = await client.fetch(url, {
      headers: headers(client, accept),
      signal: controller.signal,
      redirect: "follow",
    });
    if (response.status === 404) return { ok: false, reason: "not_found" };
    if (response.status === 401) return { ok: false, reason: "unauthorized" };
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const retry = response.headers.get("retry-after");
      return {
        ok: false,
        reason: remaining === "0" || retry !== null || response.status === 429 ? "rate_limited" : "unauthorized",
      };
    }
    if (!response.ok) return { ok: false, reason: "unreachable" };

    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_FILE_BYTES) return { ok: false, reason: "unreachable" };

    if (accept.includes("raw")) {
      const text = await response.text();
      if (text.length > MAX_FILE_BYTES) return { ok: false, reason: "unreachable" };
      return { ok: true, value: text as unknown as T };
    }
    return { ok: true, value: (await response.json()) as T };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
    client.signal?.removeEventListener("abort", onAbort);
  }
}

interface ResolvedRef {
  ref: string;
  commit: string;
  /** Path segments the ref candidate consumed but the URL wrote as the path. */
  extraPath: string;
}

/**
 * Turns whatever the URL said into a commit.
 *
 * A branch name is not a version: `main` today and `main` next week are
 * different bytes, and a skill imported from one of them should record which.
 * Resolving to a SHA here is what makes `provenance.commit` a real answer and
 * the permalink survive a force-push.
 *
 * The loop over segment counts is the answer to the `tree/<ref>/<path>`
 * ambiguity documented on `parseGithubSkillSource`. It runs only when the
 * first candidate 404s, so the common case is one request.
 */
async function resolveRef(client: GithubClient, source: GithubSkillSource): Promise<ApiResult<ResolvedRef>> {
  const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;

  if (!source.ref) {
    const repo = await call<{ default_branch?: string }>(client, base);
    if (!repo.ok) return repo;
    const branch = repo.value.default_branch;
    if (!branch) return { ok: false, reason: "unreachable" };
    const head = await call<{ sha?: string }>(client, `${base}/commits/${encodeURIComponent(branch)}`);
    if (!head.ok) return head;
    if (!head.value.sha) return { ok: false, reason: "unreachable" };
    return { ok: true, value: { ref: branch, commit: head.value.sha, extraPath: "" } };
  }

  const pathSegments = source.path ? source.path.split("/") : [];
  let lastFailure: GithubImportRefusal = "not_found";
  for (let extra = 0; extra < Math.min(MAX_REF_SEGMENTS, pathSegments.length + 1); extra++) {
    const candidate = [source.ref, ...pathSegments.slice(0, extra)].join("/");
    const head = await call<{ sha?: string }>(client, `${base}/commits/${encodeURIComponent(candidate)}`);
    if (head.ok && head.value.sha) {
      return {
        ok: true,
        value: { ref: candidate, commit: head.value.sha, extraPath: pathSegments.slice(extra).join("/") },
      };
    }
    if (!head.ok) {
      // A rate limit or an auth failure is not evidence that a longer ref would
      // work, so stop rather than spending the remaining attempts finding out.
      if (head.reason !== "not_found") return head;
      lastFailure = head.reason;
    }
  }
  return { ok: false, reason: lastFailure };
}

interface TreeEntry {
  path?: string;
  type?: string;
  size?: number;
}

const directoryOf = (path: string) => {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
};

const basenameOf = (path: string) => {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
};

/** Is `path` inside `prefix`? An empty prefix is the whole repository. */
const within = (path: string, prefix: string) =>
  prefix === "" || path === prefix || path.startsWith(`${prefix}/`);

/**
 * Walks a repository and reads every skill in it.
 *
 * One tree request for the whole repository, then one content request per
 * `SKILL.md` — which is why the candidate cap exists: a repository with two
 * hundred skills would otherwise be two hundred requests against a rate limit
 * shared by every import on this deployment.
 *
 * A truncated tree is refused rather than served partially. GitHub truncates
 * the recursive listing on very large repositories, and a partial walk reports
 * "found 3 skills" for a repository with 30 — a wrong answer that looks exactly
 * like a right one. The refusal tells the reader to link the folder instead,
 * which also makes the walk cheap.
 */
export async function discoverGithubSkills(
  client: GithubClient,
  source: GithubSkillSource
): Promise<GithubDiscoveryResult> {
  const resolved = await resolveRef(client, source);
  if (!resolved.ok) return resolved;
  const { ref, commit, extraPath } = resolved.value;

  const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
  const tree = await call<{ tree?: TreeEntry[]; truncated?: boolean }>(
    client,
    `${base}/git/trees/${encodeURIComponent(commit)}?recursive=1`
  );
  if (!tree.ok) return tree;
  if (tree.value.truncated) return { ok: false, reason: "tree_truncated" };

  const entries = (tree.value.tree ?? []).slice(0, MAX_TREE_ENTRIES);
  const blobs = entries.filter((entry) => entry.type === "blob" && typeof entry.path === "string");

  // A `blob` URL names the file directly; scope the search to its directory so
  // the reader who linked one skill is offered that one and not its 40 siblings.
  const scope = source.pointsAtFile ? directoryOf(extraPath) : extraPath;
  if (source.pointsAtFile && basenameOf(extraPath).toLowerCase() !== SKILL_MD_FILENAME.toLowerCase()) {
    return { ok: false, reason: "not_a_skill_file" };
  }

  const matches = blobs
    .map((entry) => entry.path as string)
    .filter((path) => basenameOf(path).toLowerCase() === SKILL_MD_FILENAME.toLowerCase())
    .filter((path) => (source.pointsAtFile ? path === extraPath : within(path, scope)))
    .sort();

  if (matches.length === 0) return { ok: false, reason: "no_skills" };
  const selected = matches.slice(0, MAX_DISCOVERED_SKILLS);

  const candidates: GithubSkillCandidate[] = [];
  const problems: GithubSkillProblem[] = [];

  for (const path of selected) {
    const raw = await call<string>(
      client,
      `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(commit)}`,
      "application/vnd.github.raw"
    );
    if (!raw.ok) {
      // One unreadable file does not sink an import of twelve. It is reported
      // in `problems` with the path, which is the only thing the reader can act
      // on, and the rest of the walk continues.
      problems.push({ path, reason: "no_frontmatter" });
      continue;
    }
    const parsed = parseSkillMd(raw.value);
    if (!parsed.ok) {
      problems.push({ path, reason: parsed.reason });
      continue;
    }
    const directory = directoryOf(path);
    candidates.push({
      path,
      directory,
      skill: parsed.skill,
      provenance: {
        owner: source.owner,
        repo: source.repo,
        ref,
        commit,
        path,
        url: `https://github.com/${source.owner}/${source.repo}/blob/${commit}/${path}`,
      },
      companionFiles: blobs
        .map((entry) => entry.path as string)
        .filter((other) => other !== path && within(other, directory))
        .map((other) => (directory ? other.slice(directory.length + 1) : other))
        .slice(0, 50),
    });
  }

  if (candidates.length === 0 && problems.length > 0) {
    // Everything that matched was unreadable. `no_skills` would be a lie — the
    // files are there — so the problems are returned and the caller shows them.
    return {
      ok: true,
      discovery: { owner: source.owner, repo: source.repo, ref, commit, candidates, problems, more: false },
    };
  }

  return {
    ok: true,
    discovery: {
      owner: source.owner,
      repo: source.repo,
      ref,
      commit,
      candidates,
      problems,
      more: matches.length > selected.length,
    },
  };
}

/**
 * The provenance record as it is stored on a skill version's contract.
 *
 * A flat string map, because `WorkSkillContract.metadata`-shaped storage is
 * where this has to live and because every value here is already a string. The
 * `source` prefix keeps it distinguishable from a skill author's own
 * `metadata:` keys, which arrive from the same file and are equally arbitrary.
 */
export function provenanceRecord(provenance: GithubSkillProvenance): Record<string, string> {
  return {
    "source.kind": "github",
    "source.owner": provenance.owner,
    "source.repo": provenance.repo,
    "source.ref": provenance.ref,
    "source.commit": provenance.commit,
    "source.path": provenance.path,
    "source.url": provenance.url,
  };
}
