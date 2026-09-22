import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DISCOVERED_SKILLS,
  discoverGithubSkills,
  parseGithubSkillSource,
  provenanceRecord,
} from "@/lib/skills/github";

/*
 * Walking a repository for skills.
 *
 * `fetch` is injected, so the whole path — URL parsing, ref resolution, the
 * tree walk, the per-file read and every refusal — runs here against a scripted
 * transport with no network, no token and no database.
 *
 * The cases that matter are the ones a real repository produces and a naive
 * implementation gets wrong: a branch name with a slash in it (the `tree/` URL
 * cannot distinguish ref from path, so the API has to), a truncated tree (a
 * partial walk reports "3 skills" for a repository with 30, and a wrong answer
 * that looks like a right one is the worst outcome available), and a 403 that
 * is a rate limit rather than an authorisation failure — because one is fixed
 * by connecting an account and the other by waiting, and telling somebody the
 * wrong one wastes their afternoon.
 */

const SKILL_MD = `---
name: tidy-inbox
description: Sorts an inbox. Use when the user mentions email.
---

Move anything older than a month into Archive.`;

const SECOND_SKILL = `---
name: file-invoices
description: Files invoices by vendor. Use when the user mentions invoices.
---

Rename to the invoice number, then file under the vendor.`;

interface Route {
  /** Matched with `includes`, so tests name the distinguishing fragment. */
  match: string;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** A `fetch` that answers from a table and records what was asked. */
function transport(routes: Route[]) {
  const seen: string[] = [];
  const fn = (async (url: string | URL) => {
    const href = String(url);
    seen.push(href);
    const route = routes.find((entry) => href.includes(entry.match));
    if (!route) {
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    const headers = new Headers(route.headers ?? {});
    const body = route.text !== undefined ? route.text : JSON.stringify(route.json ?? {});
    return new Response(body, { status: route.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { fetch: fn, seen };
}

const tree = (paths: string[], truncated = false) => ({
  truncated,
  tree: paths.map((path) => ({ path, type: "blob" as const })),
});

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

test("reads the forms people actually paste", () => {
  assert.deepEqual(parseGithubSkillSource("anthropics/skills"), {
    owner: "anthropics",
    repo: "skills",
    ref: null,
    path: "",
    pointsAtFile: false,
  });
  assert.deepEqual(parseGithubSkillSource("https://github.com/anthropics/skills.git"), {
    owner: "anthropics",
    repo: "skills",
    ref: null,
    path: "",
    pointsAtFile: false,
  });
  assert.deepEqual(parseGithubSkillSource("git@github.com:anthropics/skills.git"), {
    owner: "anthropics",
    repo: "skills",
    ref: null,
    path: "",
    pointsAtFile: false,
  });
  assert.deepEqual(parseGithubSkillSource("https://github.com/openai/skills/tree/main/skills/pdf"), {
    owner: "openai",
    repo: "skills",
    ref: "main",
    path: "skills/pdf",
    pointsAtFile: false,
  });
  assert.deepEqual(
    parseGithubSkillSource("https://github.com/openai/skills/blob/main/skills/pdf/SKILL.md"),
    { owner: "openai", repo: "skills", ref: "main", path: "skills/pdf/SKILL.md", pointsAtFile: true }
  );
});

test("refuses anything that is not github.com", () => {
  // Not politeness about other forges: every request below speaks GitHub's API,
  // so accepting a hostname and then ignoring it would send somebody's GitLab
  // URL to github.com and report that their repository does not exist.
  assert.equal(parseGithubSkillSource("https://gitlab.com/foo/bar"), null);
  assert.equal(parseGithubSkillSource("https://github.evil.com/foo/bar"), null);
  assert.equal(parseGithubSkillSource("not a url at all!"), null);
  assert.equal(parseGithubSkillSource(""), null);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("walks a repository and reads every skill in it", async () => {
  const { fetch: f } = transport([
    { match: "/repos/o/r/commits/main", json: { sha: "abc123" } },
    { match: "/repos/o/r/git/trees/", json: tree(["skills/a/SKILL.md", "skills/b/SKILL.md", "README.md"]) },
    { match: "/contents/skills/a/SKILL.md", text: SKILL_MD },
    { match: "/contents/skills/b/SKILL.md", text: SECOND_SKILL },
    { match: "/repos/o/r", json: { default_branch: "main" } },
  ]);

  const result = await discoverGithubSkills({ fetch: f }, parseGithubSkillSource("o/r")!);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.discovery.commit, "abc123");
  assert.deepEqual(
    result.discovery.candidates.map((c) => c.skill.name),
    ["tidy-inbox", "file-invoices"]
  );
  assert.equal(result.discovery.problems.length, 0);
  assert.equal(result.discovery.more, false);
});

test("a branch is resolved to a commit, so provenance survives the branch moving", async () => {
  const { fetch: f } = transport([
    { match: "/repos/o/r/commits/main", json: { sha: "deadbeef" } },
    { match: "/repos/o/r/git/trees/", json: tree(["s/SKILL.md"]) },
    { match: "/contents/s/SKILL.md", text: SKILL_MD },
    { match: "/repos/o/r", json: { default_branch: "main" } },
  ]);
  const result = await discoverGithubSkills({ fetch: f }, parseGithubSkillSource("o/r")!);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const provenance = result.discovery.candidates[0].provenance;
  assert.equal(provenance.ref, "main");
  assert.equal(provenance.commit, "deadbeef");
  // The permalink is at the COMMIT, not the branch, so it keeps resolving after
  // a force-push.
  assert.equal(provenance.url, "https://github.com/o/r/blob/deadbeef/s/SKILL.md");
  assert.equal(provenanceRecord(provenance)["source.commit"], "deadbeef");
});

test("a ref containing a slash is resolved by asking, because the URL cannot say", async () => {
  // `tree/release/2026/skills` is ref `release` + path `2026/skills`, or ref
  // `release/2026` + path `skills`. Only the API knows.
  const { fetch: f, seen } = transport([
    { match: "/repos/o/r/commits/release%2F2026", json: { sha: "cafe" } },
    { match: "/repos/o/r/commits/release", status: 404 },
    { match: "/repos/o/r/git/trees/", json: tree(["skills/a/SKILL.md"]) },
    { match: "/contents/skills/a/SKILL.md", text: SKILL_MD },
  ]);
  const source = parseGithubSkillSource("https://github.com/o/r/tree/release/2026/skills")!;
  assert.equal(source.ref, "release");
  assert.equal(source.path, "2026/skills");

  const result = await discoverGithubSkills({ fetch: f }, source);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.discovery.ref, "release/2026");
  assert.equal(result.discovery.candidates.length, 1);
  // The short candidate was tried first and only then the longer one.
  assert.ok(seen.some((url) => url.includes("commits/release")));
});

test("a folder link narrows the walk to that folder", async () => {
  const { fetch: f } = transport([
    { match: "/repos/o/r/commits/main", json: { sha: "abc" } },
    {
      match: "/repos/o/r/git/trees/",
      json: tree(["skills/a/SKILL.md", "other/b/SKILL.md"]),
    },
    { match: "/contents/skills/a/SKILL.md", text: SKILL_MD },
    { match: "/contents/other/b/SKILL.md", text: SECOND_SKILL },
  ]);
  const result = await discoverGithubSkills(
    { fetch: f },
    parseGithubSkillSource("https://github.com/o/r/tree/main/skills")!
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.discovery.candidates.map((c) => c.path), ["skills/a/SKILL.md"]);
});

test("a blob link resolves to that one file, and refuses a blob that is not one", async () => {
  const routes: Route[] = [
    { match: "/repos/o/r/commits/main", json: { sha: "abc" } },
    { match: "/repos/o/r/git/trees/", json: tree(["skills/a/SKILL.md", "skills/a/REFERENCE.md"]) },
    { match: "/contents/skills/a/SKILL.md", text: SKILL_MD },
  ];
  const hit = await discoverGithubSkills(
    { fetch: transport(routes).fetch },
    parseGithubSkillSource("https://github.com/o/r/blob/main/skills/a/SKILL.md")!
  );
  assert.equal(hit.ok, true);
  if (hit.ok) assert.equal(hit.discovery.candidates.length, 1);

  const miss = await discoverGithubSkills(
    { fetch: transport(routes).fetch },
    parseGithubSkillSource("https://github.com/o/r/blob/main/skills/a/REFERENCE.md")!
  );
  assert.deepEqual(miss, { ok: false, reason: "not_a_skill_file" });
});

test("companion files are listed from the tree and never fetched", async () => {
  const { fetch: f, seen } = transport([
    { match: "/repos/o/r/commits/main", json: { sha: "abc" } },
    {
      match: "/repos/o/r/git/trees/",
      json: tree(["s/SKILL.md", "s/scripts/run.py", "s/REFERENCE.md", "elsewhere/x.py"]),
    },
    { match: "/contents/s/SKILL.md", text: SKILL_MD },
    { match: "/repos/o/r", json: { default_branch: "main" } },
  ]);
  const result = await discoverGithubSkills({ fetch: f }, parseGithubSkillSource("o/r")!);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.discovery.candidates[0].companionFiles.sort(), [
    "REFERENCE.md",
    "scripts/run.py",
  ]);
  // The point of the listing is that Juno never holds these bytes: a script
  // pulled from a stranger's repository is the exfiltration shape the whole
  // feature is bounded against.
  assert.ok(!seen.some((url) => url.includes("run.py")));
  assert.ok(!seen.some((url) => url.includes("REFERENCE.md")));
});

test("an unreadable SKILL.md is reported, and does not sink the others", async () => {
  const { fetch: f } = transport([
    { match: "/repos/o/r/commits/main", json: { sha: "abc" } },
    { match: "/repos/o/r/git/trees/", json: tree(["a/SKILL.md", "b/SKILL.md"]) },
    { match: "/contents/a/SKILL.md", text: SKILL_MD },
    { match: "/contents/b/SKILL.md", text: "# no frontmatter here" },
    { match: "/repos/o/r", json: { default_branch: "main" } },
  ]);
  const result = await discoverGithubSkills({ fetch: f }, parseGithubSkillSource("o/r")!);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.discovery.candidates.length, 1);
  assert.deepEqual(result.discovery.problems, [{ path: "b/SKILL.md", reason: "no_frontmatter" }]);
});

test("a truncated tree is refused rather than served as a partial answer", async () => {
  const { fetch: f } = transport([
    { match: "/repos/o/r/commits/main", json: { sha: "abc" } },
    { match: "/repos/o/r/git/trees/", json: tree(["a/SKILL.md"], true) },
    { match: "/repos/o/r", json: { default_branch: "main" } },
  ]);
  const result = await discoverGithubSkills({ fetch: f }, parseGithubSkillSource("o/r")!);
  // "Found 1 skill" for a repository with 30 is a wrong answer that looks
  // exactly like a right one.
  assert.deepEqual(result, { ok: false, reason: "tree_truncated" });
});

test("more matches than the cap sets `more`, and the cap holds", async () => {
  const paths = Array.from({ length: MAX_DISCOVERED_SKILLS + 5 }, (_, i) => `s${i}/SKILL.md`);
  const { fetch: f } = transport([
    { match: "/repos/o/r/commits/main", json: { sha: "abc" } },
    { match: "/repos/o/r/git/trees/", json: tree(paths) },
    { match: "/SKILL.md", text: SKILL_MD },
    { match: "/repos/o/r", json: { default_branch: "main" } },
  ]);
  const result = await discoverGithubSkills({ fetch: f }, parseGithubSkillSource("o/r")!);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.discovery.candidates.length, MAX_DISCOVERED_SKILLS);
  assert.equal(result.discovery.more, true);
});

test("a repository with no SKILL.md says so rather than returning nothing", async () => {
  const { fetch: f } = transport([
    { match: "/repos/o/r/commits/main", json: { sha: "abc" } },
    { match: "/repos/o/r/git/trees/", json: tree(["README.md", "src/index.ts"]) },
    { match: "/repos/o/r", json: { default_branch: "main" } },
  ]);
  const result = await discoverGithubSkills({ fetch: f }, parseGithubSkillSource("o/r")!);
  assert.deepEqual(result, { ok: false, reason: "no_skills" });
});

test("403 is split into rate-limited and unauthorised, because the remedies differ", async () => {
  const limited = transport([
    {
      match: "/repos/o/r/commits/",
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
      json: {},
    },
    { match: "/repos/o/r", json: { default_branch: "main" } },
  ]);
  assert.deepEqual(await discoverGithubSkills({ fetch: limited.fetch }, parseGithubSkillSource("o/r")!), {
    ok: false,
    reason: "rate_limited",
  });

  const forbidden = transport([
    { match: "/repos/o/r/commits/", status: 403, headers: { "x-ratelimit-remaining": "58" }, json: {} },
    { match: "/repos/o/r", json: { default_branch: "main" } },
  ]);
  assert.deepEqual(await discoverGithubSkills({ fetch: forbidden.fetch }, parseGithubSkillSource("o/r")!), {
    ok: false,
    reason: "unauthorized",
  });
});

test("a missing repository is not_found, and a rate limit mid-ref-walk is not mistaken for one", async () => {
  const missing = transport([]);
  assert.deepEqual(await discoverGithubSkills({ fetch: missing.fetch }, parseGithubSkillSource("o/r")!), {
    ok: false,
    reason: "not_found",
  });

  // A 429 while trying candidate refs must stop the walk: a longer ref is not
  // going to work either, and spending the remaining attempts finding that out
  // makes the rate limit worse.
  const throttled = transport([
    { match: "/repos/o/r/commits/", status: 429, json: {} },
  ]);
  assert.deepEqual(
    await discoverGithubSkills(
      { fetch: throttled.fetch },
      parseGithubSkillSource("https://github.com/o/r/tree/a/b/c")!
    ),
    { ok: false, reason: "rate_limited" }
  );
});

test("a token is sent when there is one, and the request is never anonymous by accident", async () => {
  const calls: Record<string, string | null>[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), auth: headers.get("authorization") });
    if (String(url).includes("/commits/")) return new Response(JSON.stringify({ sha: "abc" }));
    if (String(url).includes("/git/trees/")) return new Response(JSON.stringify(tree(["a/SKILL.md"])));
    return new Response(SKILL_MD);
  }) as unknown as typeof fetch;

  await discoverGithubSkills({ fetch: f, token: "ghp_x" }, parseGithubSkillSource("o/r")!);
  assert.ok(calls.length > 0);
  for (const call of calls) assert.equal(call.auth, "Bearer ghp_x");
});
