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
 * WHAT IS FETCHED, AND WHEN. A skill directory may also hold `scripts/`,
 * `references/` and `assets/` — Anthropic's "level 3", read by an agent with a
 * filesystem and a shell. The preview reads only the `SKILL.md` files and
 * reports the rest from the tree listing ("keeps 4 files, 1 script") without a
 * single extra request. The IMPORT then fetches the chosen skills' folders
 * (`fetchGithubSkillBundle`) at the commit the preview read, and keeps them as
 * bundles: scanned, consented to when an imported one carries a script, and
 * only ever run inside the no-network sandbox (docs/rework/TOOL_RUNTIME_DESIGN.md
 * §6.8, reversing docs/skills-audit.md §4.3 on the owner's decision). A symlink
 * in the folder, an oversized file or too many files refuse that skill before
 * any byte is fetched, from the tree alone.
 *
 * NO `server-only` AND NO PRISMA. `fetch` is injected, so
 * `tests/skills-github.test.ts` drives the whole discovery path — URL parsing,
 * ref resolution, tree walking, refusal mapping — against a scripted transport
 * with no network and no database.
 */

import { parseSkillMd, SKILL_MD_FILENAME, type ParsedSkillMd, type SkillMdRefusal } from "@/lib/skills/skill-md";
import { PRODUCT_NAME } from "@/lib/brand/names";
import {
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_FILES,
  buildSkillBundle,
  checkBundlePath,
  isBundleJunk,
  type SkillBundle,
  type SkillBundleProblem,
} from "@/lib/skills/bundle";

export const GITHUB_API_BASE = "https://api.github.com";

/**
 * How many `SKILL.md` files one walk reads.
 *
 * High enough to take the public collections people install whole in one
 * walk, which matters now that a repository is installed and updated as one
 * source: a cap that cut a collection in half would install half a source and
 * then report the rest as new on every update check. Past the cap `more` says
 * so, and an update check passes what is installed as `prefer` so the cap can
 * never drop those.
 */
export const MAX_DISCOVERED_SKILLS = 100;
/** Entries in one tree response before the walk stops looking. */
export const MAX_TREE_ENTRIES = 40_000;
/** A ref written with slashes (`release/2026-09`) is resolved in this many tries. */
const MAX_REF_SEGMENTS = 3;
/** One request's ceiling. Generous for a Markdown file, closed for a tarball. */
const MAX_FILE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * `SKILL.md` reads in flight at once. A hundred files one after another is
 * half a minute of a person watching a spinner; GitHub asks integrations not
 * to fan out widely, and a handful at a time sits well inside that.
 */
const FILE_READ_CONCURRENCY = 6;

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
    `GitHub has no repository there, or it is private and ${PRODUCT_NAME} cannot see it. Connect GitHub on the Connections page to import from a private repository.`,
  unauthorized:
    `GitHub refused the credential ${PRODUCT_NAME} used. Reconnect GitHub on the Connections page and try again.`,
  rate_limited:
    `GitHub is rate-limiting ${PRODUCT_NAME} right now. Connecting your GitHub account raises the limit considerably; otherwise this clears on its own within the hour.`,
  tree_truncated:
    "This repository is too large to list in one pass. Paste a link to the folder the skills are in (the tree or blob URL from GitHub's own file browser works).",
  no_skills:
    `${PRODUCT_NAME} walked the repository and found no SKILL.md. A skill is a folder with a SKILL.md at its head; this repository has none where it looked.`,
  not_a_skill_file: `That link points at a file that is not a ${SKILL_MD_FILENAME}. Link the skill's folder, or the ${SKILL_MD_FILENAME} inside it.`,
  unreachable: `${PRODUCT_NAME} could not reach GitHub. Nothing was imported.`,
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
  /**
   * The same files with what the tree says about each: size, blob id and
   * whether git stored it as a symlink. What `bundlePreflight` and
   * `fetchGithubSkillBundle` work from. Not capped at 50 like the list above:
   * a folder over the bundle limit has to be seen to be over it.
   */
  companionEntries: GithubCompanionEntry[];
  /** The SKILL.md exactly as read, for the bundle's own copy. */
  raw: string;
}

/** One file beside a SKILL.md, as the git tree describes it. */
export interface GithubCompanionEntry {
  /** Relative to the skill's folder. */
  path: string;
  size: number;
  /** The git blob id. Two trees with the same ids hold the same bytes. */
  sha: string;
  /** Mode 120000: git stored a symbolic link, not a file. */
  symlink: boolean;
}

/** A `SKILL.md` that was found and could not be read. Reported, not dropped. */
export interface GithubSkillProblem {
  path: string;
  reason: SkillMdRefusal;
}

export interface GithubDiscovery {
  /** As GitHub spells them when it said so, otherwise as the source was written. */
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  /**
   * The folder the walk was scoped to; "" is the whole repository. A `blob`
   * link scopes to the folder its file is in. This is what a source records as
   * its `path`, so an update check walks the same folder the import did.
   */
  scope: string;
  /**
   * Every `SKILL.md` in scope, read or not, sorted. An update check needs the
   * whole list to tell "removed upstream" from "not read this time".
   */
  paths: string[];
  candidates: GithubSkillCandidate[];
  problems: GithubSkillProblem[];
  /** True when more than `MAX_DISCOVERED_SKILLS` files matched. */
  more: boolean;
}

export interface GithubDiscoveryOptions {
  /**
   * Read the tree at this commit rather than at the ref's head. The ref is
   * still resolved, for its name and for the scope a slashed branch leaves
   * behind, so an import pinned to what its preview showed still records the
   * branch it tracks rather than a bare SHA.
   */
  commit?: string;
  /**
   * Paths to read before any other when the cap applies. An update check
   * passes what is installed, so those are always compared, however many
   * other skills the repository has grown.
   */
  prefer?: readonly string[];
  /**
   * Report a walk that matched nothing as an empty discovery rather than as
   * `no_skills`. For an import that is a refusal; for an update check of an
   * installed source it is the answer: everything it held was removed.
   */
  allowEmpty?: boolean;
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
  /** GitHub's own spelling of the repository, when a response carried it. */
  canonical: { owner: string; repo: string } | null;
}

/**
 * GitHub's spelling of `owner/repo`, taken only when it differs by case.
 *
 * The API answers `Anthropics/Skills` for `anthropics/skills`, and a library
 * showing whichever spelling somebody typed first looks careless. A name that
 * differs by more than case means GitHub followed a rename or a transfer, and
 * adopting it would quietly move an installed source to a different identity,
 * so that is left alone.
 */
function canonicalName(
  source: Pick<GithubSkillSource, "owner" | "repo">,
  owner: string | undefined,
  repo: string | undefined
): { owner: string; repo: string } | null {
  if (!owner || !repo) return null;
  if (owner.toLowerCase() !== source.owner.toLowerCase()) return null;
  if (repo.toLowerCase() !== source.repo.toLowerCase()) return null;
  return { owner, repo };
}

/** `https://github.com/Owner/Repo/commit/<sha>` from a commit response, split. */
function nameFromCommitUrl(url: string | undefined): { owner?: string; repo?: string } {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\//.exec(url ?? "");
  return match ? { owner: match[1], repo: match[2] } : {};
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
    const repo = await call<{ default_branch?: string; name?: string; owner?: { login?: string } }>(
      client,
      base
    );
    if (!repo.ok) return repo;
    const branch = repo.value.default_branch;
    if (!branch) return { ok: false, reason: "unreachable" };
    const head = await call<{ sha?: string }>(client, `${base}/commits/${encodeURIComponent(branch)}`);
    if (!head.ok) return head;
    if (!head.value.sha) return { ok: false, reason: "unreachable" };
    return {
      ok: true,
      value: {
        ref: branch,
        commit: head.value.sha,
        extraPath: "",
        canonical: canonicalName(source, repo.value.owner?.login, repo.value.name),
      },
    };
  }

  const pathSegments = source.path ? source.path.split("/") : [];
  let lastFailure: GithubImportRefusal = "not_found";
  for (let extra = 0; extra < Math.min(MAX_REF_SEGMENTS, pathSegments.length + 1); extra++) {
    const candidate = [source.ref, ...pathSegments.slice(0, extra)].join("/");
    const head = await call<{ sha?: string; html_url?: string }>(
      client,
      `${base}/commits/${encodeURIComponent(candidate)}`
    );
    if (head.ok && head.value.sha) {
      const named = nameFromCommitUrl(head.value.html_url);
      return {
        ok: true,
        value: {
          ref: candidate,
          commit: head.value.sha,
          extraPath: pathSegments.slice(extra).join("/"),
          canonical: canonicalName(source, named.owner, named.repo),
        },
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
  mode?: string;
  sha?: string;
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
 * The ref's name and scope, with the commit the walk should read.
 *
 * Unpinned, that is the ref's head. Pinned, the ref is still resolved (its name
 * is what a source goes on tracking, and a slashed branch decides where the
 * scope starts) but the walk reads the pinned commit. When the branch has gone
 * since the preview, the commit alone still names the bytes the reader was
 * shown, so those are read and the commit becomes what is tracked.
 */
async function resolveWalk(
  client: GithubClient,
  source: GithubSkillSource,
  pin: string | undefined
): Promise<ApiResult<ResolvedRef>> {
  if (!pin) return resolveRef(client, source);
  const named = await resolveRef(client, source);
  if (!named.ok) {
    return named.reason === "not_found" ? resolveRef(client, { ...source, ref: pin }) : named;
  }
  if (named.value.commit.toLowerCase().startsWith(pin.toLowerCase())) return named;
  if (/^[0-9a-f]{40}$/i.test(pin)) return { ok: true, value: { ...named.value, commit: pin.toLowerCase() } };
  // A short SHA is not something the tree endpoint promises to accept.
  const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
  const pinned = await call<{ sha?: string }>(client, `${base}/commits/${encodeURIComponent(pin)}`);
  if (!pinned.ok) return pinned;
  if (!pinned.value.sha) return { ok: false, reason: "unreachable" };
  return { ok: true, value: { ...named.value, commit: pinned.value.sha } };
}

/**
 * Runs `read` over `items` a few at a time, keeping their order, and stops
 * starting new reads once `stop` says so.
 */
async function readInOrder<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
  stop: (result: R) => boolean
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let halted = false;
  const worker = async () => {
    while (!halted && next < items.length) {
      const index = next++;
      const result = await read(items[index]);
      out[index] = result;
      if (stop(result)) halted = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILE_READ_CONCURRENCY, items.length) }, worker));
  return out;
}

/**
 * Walks a repository and reads every skill in it.
 *
 * One tree request for the whole repository, then one content request per
 * `SKILL.md`, a few at a time. That is why the candidate cap exists: a
 * repository with five hundred skills would otherwise be five hundred requests
 * against a rate limit shared by every import on this deployment.
 *
 * A truncated tree is refused rather than served partially. GitHub truncates
 * the recursive listing on very large repositories, and a partial walk reports
 * "found 3 skills" for a repository with 30: a wrong answer that looks exactly
 * like a right one. The refusal tells the reader to link the folder instead,
 * which also makes the walk cheap. A rate limit met halfway through the reads
 * is refused for the same reason, rather than reported as fifty broken files.
 */
export async function discoverGithubSkills(
  client: GithubClient,
  source: GithubSkillSource,
  options: GithubDiscoveryOptions = {}
): Promise<GithubDiscoveryResult> {
  const resolved = await resolveWalk(client, source, options.commit);
  if (!resolved.ok) return resolved;
  const { ref, commit, extraPath } = resolved.value;
  const owner = resolved.value.canonical?.owner ?? source.owner;
  const repo = resolved.value.canonical?.repo ?? source.repo;

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

  if (matches.length === 0 && !options.allowEmpty) return { ok: false, reason: "no_skills" };
  // Preferred paths first, so the cap never drops what a caller has to compare;
  // then everything else in path order.
  const preferred = new Set(options.prefer ?? []);
  const selected = [
    ...matches.filter((path) => preferred.has(path)),
    ...matches.filter((path) => !preferred.has(path)),
  ].slice(0, MAX_DISCOVERED_SKILLS);

  const reads = await readInOrder(
    selected,
    (path) =>
      call<string>(
        client,
        `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(commit)}`,
        "application/vnd.github.raw"
      ),
    (result) => !result.ok && result.reason === "rate_limited"
  );
  if (reads.some((result) => result && !result.ok && result.reason === "rate_limited")) {
    return { ok: false, reason: "rate_limited" };
  }

  const candidates: GithubSkillCandidate[] = [];
  const problems: GithubSkillProblem[] = [];

  selected.forEach((path, index) => {
    const raw = reads[index];
    if (!raw.ok) {
      // One unreadable file does not sink an import of twelve. It is reported
      // in `problems` with the path, which is the only thing the reader can act
      // on, and the rest of the walk continues.
      problems.push({ path, reason: "no_frontmatter" });
      return;
    }
    const parsed = parseSkillMd(raw.value);
    if (!parsed.ok) {
      problems.push({ path, reason: parsed.reason });
      return;
    }
    const directory = directoryOf(path);
    // A skill folder nested inside this one owns its own files.
    const nestedDirs = matches.map(directoryOf).filter((dir) => dir !== directory && within(dir, directory));
    const companionEntries = blobs
      .filter((entry) => entry.path !== path && within(entry.path as string, directory))
      .filter((entry) => !nestedDirs.some((dir) => within(entry.path as string, dir)))
      .slice(0, MAX_BUNDLE_FILES + 1)
      .map((entry) => ({
        path: directory ? (entry.path as string).slice(directory.length + 1) : (entry.path as string),
        size: typeof entry.size === "number" ? entry.size : 0,
        sha: typeof entry.sha === "string" ? entry.sha : "",
        symlink: entry.mode === "120000",
      }));
    candidates.push({
      path,
      directory,
      skill: parsed.skill,
      provenance: {
        owner,
        repo,
        ref,
        commit,
        path,
        url: `https://github.com/${owner}/${repo}/blob/${commit}/${path}`,
      },
      companionFiles: blobs
        .map((entry) => entry.path as string)
        .filter((other) => other !== path && within(other, directory))
        .map((other) => (directory ? other.slice(directory.length + 1) : other))
        .slice(0, 50),
      companionEntries,
      raw: raw.value,
    });
  });

  // Everything that matched may have been unreadable. `no_skills` would be a
  // lie then (the files are there), so the problems are returned and the caller
  // shows them.
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    ok: true,
    discovery: {
      owner,
      repo,
      ref,
      commit,
      scope,
      paths: matches,
      candidates: candidates.sort(byPath),
      problems: problems.sort(byPath),
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


// ---------------------------------------------------------------------------
// The folder, kept
// ---------------------------------------------------------------------------

/** Provenance key for the companion files' identity at the commit read. */
export const PROVENANCE_FILES_KEY = "source.files";

/** Companion entries the bundle would consider (no dotfiles, no resource forks). */
function keptEntries(candidate: Pick<GithubSkillCandidate, "companionEntries">): GithubCompanionEntry[] {
  return candidate.companionEntries.filter((entry) => !isBundleJunk(entry.path));
}

/**
 * The identity of a skill's companion files from the tree alone: their paths,
 * blob ids and link flags. Stored in provenance, so an update check can tell
 * "the scripts changed upstream" without fetching them. Empty string for a
 * folder with nothing beside its SKILL.md.
 */
export function companionTreeDigest(candidate: Pick<GithubSkillCandidate, "companionEntries">): string {
  const entries = keptEntries(candidate);
  if (entries.length === 0) return "";
  const line = entries
    .map((entry) => `${entry.path}\0${entry.sha}\0${entry.symlink ? "l" : "f"}`)
    .sort()
    .join("\n");
  // FNV-1a over the canonical listing, twice with different seeds: no crypto
  // import (this module stays usable without Node built-ins) and the value is a
  // change detector, not a security boundary — the bundle digest is that.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${entries.length}:${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/**
 * Refuses a folder from what the tree says, before any byte is fetched: a
 * symlink, a path that cannot be held, too many files, a file or a total over
 * the bundle limits. Null when the folder may be fetched.
 */
export function bundlePreflight(candidate: Pick<GithubSkillCandidate, "companionEntries">): SkillBundleProblem | null {
  const all = candidate.companionEntries;
  const link = all.find((entry) => entry.symlink);
  if (link) return { reason: "symlink", path: link.path };
  for (const entry of all) {
    const checked = checkBundlePath(entry.path);
    if (!checked.ok) return { reason: checked.reason, path: entry.path };
  }
  const entries = keptEntries(candidate);
  if (entries.length + 1 > MAX_BUNDLE_FILES) return { reason: "too_many_files" };
  const large = entries.find((entry) => entry.size > MAX_BUNDLE_FILE_BYTES);
  if (large) return { reason: "file_too_large", path: large.path };
  if (entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_BUNDLE_BYTES) return { reason: "too_large" };
  return null;
}

/** Companion files one import (or one update) fetches, across all its skills. */
export const MAX_IMPORT_BUNDLE_FILES = 500;
/** Companion bytes one import (or one update) fetches, across all its skills. */
export const MAX_IMPORT_BUNDLE_BYTES = 25 * 1024 * 1024;

/**
 * A running total over one request's folder fetches, from the tree's own sizes.
 *
 * One skill is bounded by the bundle limits; a request choosing a hundred
 * skills is not, and would spend a shared GitHub rate limit and the web
 * process's time on twenty thousand reads. Past the budget a skill is skipped
 * with a sentence telling the reader to import it on its own.
 */
export function createBundleFetchBudget(limits = { files: MAX_IMPORT_BUNDLE_FILES, bytes: MAX_IMPORT_BUNDLE_BYTES }) {
  let files = 0;
  let bytes = 0;
  return {
    /** Reserves the folder's fetches, or says it does not fit. */
    admit(candidate: Pick<GithubSkillCandidate, "companionEntries">): boolean {
      const entries = keptEntries(candidate);
      const size = entries.reduce((sum, entry) => sum + entry.size, 0);
      if (entries.length === 0) return true;
      if (files + entries.length > limits.files || bytes + size > limits.bytes) return false;
      files += entries.length;
      bytes += size;
      return true;
    },
  };
}

export const BUNDLE_BUDGET_MESSAGE =
  "This import already fetched as many skill files as one import may, so this skill's folder was not fetched. Import it on its own.";

/** One file's bytes, bounded while they stream. */
async function fetchBytes(client: GithubClient, url: string, limit: number): Promise<ApiResult<Uint8Array>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  client.signal?.addEventListener("abort", onAbort);
  try {
    const response = await client.fetch(url, {
      headers: headers(client, "application/vnd.github.raw"),
      signal: controller.signal,
      redirect: "follow",
    });
    if (response.status === 404) return { ok: false, reason: "not_found" };
    if (response.status === 401) return { ok: false, reason: "unauthorized" };
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const retry = response.headers.get("retry-after");
      return { ok: false, reason: remaining === "0" || retry !== null || response.status === 429 ? "rate_limited" : "unauthorized" };
    }
    if (!response.ok) return { ok: false, reason: "unreachable" };
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: "unreachable" };
    const reader = response.body?.getReader();
    if (!reader) return { ok: true, value: new Uint8Array(0) };
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "unreachable" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: bytes };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
    client.signal?.removeEventListener("abort", onAbort);
  }
}

export type GithubBundleResult =
  | { ok: true; bundle: SkillBundle | null }
  | { ok: false; problem: SkillBundleProblem }
  | { ok: false; reason: GithubImportRefusal };

/**
 * Fetches a skill's folder at the commit the walk read and packs it.
 *
 * Null for a folder with nothing beside its SKILL.md. A rate limit or an
 * unreachable file fails the whole skill rather than importing it with a hole
 * in its folder: a skill missing one of its scripts looks complete and breaks
 * the first time it runs.
 */
export async function fetchGithubSkillBundle(
  client: GithubClient,
  discovery: Pick<GithubDiscovery, "owner" | "repo" | "commit">,
  candidate: Pick<GithubSkillCandidate, "directory" | "path" | "raw" | "companionEntries">
): Promise<GithubBundleResult> {
  const refused = bundlePreflight(candidate);
  if (refused) return { ok: false, problem: refused };
  const entries = keptEntries(candidate);
  if (entries.length === 0) return { ok: true, bundle: null };

  const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(discovery.owner)}/${encodeURIComponent(discovery.repo)}`;
  const prefix = candidate.directory ? `${candidate.directory}/` : "";
  const reads = await readInOrder(
    entries,
    (entry) =>
      fetchBytes(
        client,
        `${base}/contents/${`${prefix}${entry.path}`.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(discovery.commit)}`,
        MAX_BUNDLE_FILE_BYTES
      ),
    (result) => !result.ok && result.reason === "rate_limited"
  );
  const failed = reads.find((result) => !result || !result.ok);
  if (failed && !failed.ok) return { ok: false, reason: failed.reason === "not_found" ? "unreachable" : failed.reason };
  if (reads.some((result) => !result)) return { ok: false, reason: "rate_limited" };

  const skillName = candidate.path.slice(prefix.length);
  const built = buildSkillBundle([
    { path: skillName, bytes: new TextEncoder().encode(candidate.raw) },
    ...entries.map((entry, index) => ({ path: entry.path, bytes: (reads[index] as { ok: true; value: Uint8Array }).value })),
  ]);
  return built.ok ? { ok: true, bundle: built.bundle } : { ok: false, problem: built.problem };
}
