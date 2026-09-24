/**
 * Design posters (X-20 static): the picture a design is, outside its editor.
 *
 * Three layers, tested where each can fail:
 *  - `designPosterSvg` turns a stored body into the SVG of its first page, or
 *    null — never a throw, never JSON, never an owner-only path;
 *  - `posterResponse` serves it under the headers the contract names;
 *  - the two routes resolve access exactly as their siblings do — the owner's
 *    through the conversation join, the public one through the share page's
 *    own two calls, so it can only draw the version that page shows.
 *
 * The routes run against stand-in Prisma, session and rate-limit modules, so
 * no database is needed.
 *
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/design-poster.test.ts
 */

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { serializeDesignDocument } from "../src/lib/design/migrations";
import { designPosterUrl, sharedDesignPosterUrl } from "../src/lib/design/poster-url";
import { PAGE_ID, run, signInDocument } from "./design-fixtures";
import type { DesignDocument } from "../src/lib/design/types";

// ---------------------------------------------------------------------------
// Stand-ins for the modules the routes reach
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let currentUser: { id: string; email: string | null } | null = null;
let limited = false;
const rateKeys: string[] = [];

/** Artifacts, as the owner route's `findFirst` would find them. */
let artifacts: Array<{ id: string; userId: string; type: string; currentVersion: number; title: string; language: string | null }> = [];
/** Versions, keyed `${artifactId}:${version}`. */
let versions = new Map<string, { content: string; createdAt: Date }>();
let shares: Row[] = [];
const artifactWheres: Row[] = [];
let shareViewBumps = 0;

const versionRows = (artifactId: string) =>
  [...versions.entries()]
    .filter(([key]) => key.startsWith(`${artifactId}:`))
    .map(([key, row]) => ({ version: Number(key.split(":")[1]), ...row }));

const prisma = {
  artifact: {
    findFirst: async (args: { where: Row; select?: Row }) => {
      artifactWheres.push(args.where);
      const where = args.where as { id: string; type?: string; conversation?: { userId: string } };
      const hit = artifacts.find(
        (a) => a.id === where.id && (!where.type || a.type === where.type) && (!where.conversation || a.userId === where.conversation.userId)
      );
      return hit ? { currentVersion: hit.currentVersion } : null;
    },
    findUnique: async (args: { where: { id: string } }) => {
      const hit = artifacts.find((a) => a.id === args.where.id);
      return hit ? { title: hit.title, type: hit.type, language: hit.language } : null;
    },
  },
  artifactVersion: {
    findUnique: async (args: { where: { artifactId_version: { artifactId: string; version: number } } }) => {
      const { artifactId, version } = args.where.artifactId_version;
      const row = versions.get(`${artifactId}:${version}`);
      return row ? { content: row.content } : null;
    },
    findFirst: async (args: { where: { artifactId: string; createdAt?: { lte: Date } }; orderBy: { version: "asc" | "desc" } }) => {
      const rows = versionRows(args.where.artifactId)
        .filter((row) => !args.where.createdAt || row.createdAt <= args.where.createdAt.lte)
        .sort((a, b) => (args.orderBy.version === "desc" ? b.version - a.version : a.version - b.version));
      return rows[0] ?? null;
    },
  },
};

const prismaUnguarded = {
  share: {
    // As `findActiveShare` reads it since share governance: the owner's ban
    // comes along, and a taken-down share is not served.
    findUnique: async (args: { where: { token: string } }) => {
      const found = shares.find((s) => s.token === args.where.token);
      if (!found) return null;
      const { ownerBannedAt, ...share } = found as typeof found & { ownerBannedAt?: Date | null };
      return { takenDownAt: null, ...share, user: { bannedAt: ownerBannedAt ?? null } };
    },
    update: () => {
      shareViewBumps += 1;
      return Promise.resolve({});
    },
  },
};

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so there the poster's own tests still run and the
// route tests skip rather than fail (as tests/account-delete-deliverables.test.ts
// does).
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const routeTest = canMockModules ? test : test.skip;

if (canMockModules) {
  mock.module("@/lib/prisma", { namedExports: { prisma, prismaUnguarded } });
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => currentUser } });
  mock.module("@/lib/rate-limit", {
    namedExports: {
      rateLimit: async ({ key }: { key: string }) => {
        rateKeys.push(key);
        return { success: !limited, remaining: limited ? 0 : 1, resetAt: new Date() };
      },
      ipFromHeaders: () => "203.0.113.9",
    },
  });
}

const poster = () => import("@/lib/design/poster");
const ownerRoute = () => import("@/app/api/artifacts/[id]/poster/route");
const publicRoute = () => import("@/app/share/[token]/poster/route");

function reset() {
  currentUser = { id: "u1", email: "person@example.com" };
  limited = false;
  rateKeys.length = 0;
  artifactWheres.length = 0;
  shareViewBumps = 0;
  artifacts = [];
  versions = new Map();
  shares = [];
}

const stored = (doc: DesignDocument) => serializeDesignDocument(doc);

/** The fixture with the title reworded, so two versions draw differently. */
const retitled = (text: string) => run(signInDocument(), [{ op: "updateNode", nodeId: "title", patch: { characters: text } }]).document;

// ---------------------------------------------------------------------------
// The poster itself
// ---------------------------------------------------------------------------

test("a stored design becomes the SVG of its first page, fitted to what it draws", async () => {
  const { designPosterSvg } = await poster();
  const svg = designPosterSvg(stored(signInDocument()));
  assert.ok(svg);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="375" height="812" viewBox="0 0 375 812">/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, />Welcome back</, "the words on the design are drawn");
  // A picture for an <img>, not an editor surface and not the document.
  assert.doesNotMatch(svg, /data-juno-node/);
  assert.doesNotMatch(svg, /schemaVersion/);
  assert.doesNotMatch(svg, /<script|\son[a-z]+=/i);
});

test("a design moved far from the origin is still a picture of the design", async () => {
  const { designPosterSvg } = await poster();
  const moved = run(signInDocument(), [{ op: "updateNode", nodeId: "screen", patch: { x: 3000, y: 1200 } }]).document;
  assert.match(designPosterSvg(stored(moved)) ?? "", /viewBox="3000 1200 375 812"/);
});

test("anything that is not a readable design is null, never a throw", async () => {
  const { designPosterSvg, MAX_POSTER_SOURCE_CHARS } = await poster();
  const newer = JSON.parse(stored(signInDocument()));
  newer.schemaVersion = 999;
  for (const junk of [
    "",
    "not json",
    "{}",
    "[]",
    "null",
    '{"schemaVersion":1}',
    "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    JSON.stringify(newer),
    stored(signInDocument()).slice(0, 200),
  ]) {
    assert.equal(designPosterSvg(junk), null, `junk: ${junk.slice(0, 40)}`);
  }
  // Past the cap it is not even parsed.
  assert.equal(designPosterSvg(" ".repeat(MAX_POSTER_SOURCE_CHARS + 1)), null);
});

test("only the first page is drawn", async () => {
  const { designPosterSvg } = await poster();
  const twoPages = run(signInDocument(), [
    { op: "createPage", pageId: "page2", name: "Second" },
    {
      op: "createNode",
      parentId: null,
      pageId: "page2",
      node: { type: "text", id: "elsewhere", name: "Elsewhere", patch: { characters: "Second page only" } },
    },
  ]).document;
  const svg = designPosterSvg(stored(twoPages)) ?? "";
  assert.match(svg, /Welcome back/);
  assert.doesNotMatch(svg, /Second page only/);
});

test("an empty design is a blank page, not a failure", async () => {
  const { designPosterSvg } = await poster();
  const empty = run(signInDocument(), [{ op: "deleteNodes", nodeIds: ["screen"] }]).document;
  const svg = designPosterSvg(stored(empty));
  assert.ok(svg);
  assert.match(svg, /<rect [^>]*fill="rgba\(245, 245, 247, 1\)"\/>/);
});

test("an owner-only image never reaches a poster; inline images do", async () => {
  const { designPosterSvg } = await poster();
  const inline = "data:image/png;base64,iVBORw0KGgo=";
  const doc = run(signInDocument(), [
    { op: "createAsset", asset: { id: "lib", kind: "image", url: "/api/files/users/u1/2026/secret-key.png", width: 10, height: 10, mimeType: "image/png" } },
    { op: "createAsset", asset: { id: "inl", kind: "image", url: inline, width: 10, height: 10, mimeType: "image/png" } },
    { op: "createNode", parentId: "screen", pageId: PAGE_ID, node: { type: "image", id: "photo", name: "Photo", patch: { x: 0, y: 0, width: 375, height: 180, assetId: "lib" } } },
    { op: "createNode", parentId: "screen", pageId: PAGE_ID, node: { type: "image", id: "logo", name: "Logo", patch: { x: 10, y: 10, width: 40, height: 40, assetId: "inl" } } },
  ]).document;
  const svg = designPosterSvg(stored(doc)) ?? "";
  // The storage key would be published on a public share, and an image-mode
  // SVG could not have fetched it anyway.
  assert.doesNotMatch(svg, /\/api\/files|secret-key/);
  assert.match(svg, /href="data:image\/svg\+xml,/, "the Library image becomes the quiet placeholder");
  assert.ok(svg.includes(`href="${inline}"`), "an inline image is kept as drawn");
});

test("the response carries the contract's headers and a working ETag", async () => {
  const { posterResponse, POSTER_CSP, POSTER_CACHE_IMMUTABLE } = await poster();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

  const first = posterResponse(svg, new Request("https://juno.test/p"), POSTER_CACHE_IMMUTABLE);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/svg+xml");
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  assert.equal(first.headers.get("content-security-policy"), "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  assert.equal(POSTER_CSP, first.headers.get("content-security-policy"));
  assert.equal(first.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(await first.text(), svg);

  const etag = first.headers.get("etag");
  assert.match(etag ?? "", /^"[\w-]+"$/);
  for (const header of [etag!, `W/${etag}`, `"other", ${etag}`, "*"]) {
    const again = posterResponse(svg, new Request("https://juno.test/p", { headers: { "if-none-match": header } }), POSTER_CACHE_IMMUTABLE);
    assert.equal(again.status, 304, header);
    assert.equal(await again.text(), "");
  }
  const changed = posterResponse(svg.replace('width="1"', 'width="2"'), new Request("https://juno.test/p", { headers: { "if-none-match": etag! } }), POSTER_CACHE_IMMUTABLE);
  assert.equal(changed.status, 200, "a different drawing is a different tag");
});

test("the client URLs are the contract's", () => {
  assert.equal(designPosterUrl("ck123"), "/api/artifacts/ck123/poster");
  assert.equal(designPosterUrl("ck123", 4), "/api/artifacts/ck123/poster?v=4&r=1");
  // A version that is not one is dropped rather than sent to 404.
  assert.equal(designPosterUrl("ck123", 0), "/api/artifacts/ck123/poster");
  assert.equal(designPosterUrl("ck123", 2.5), "/api/artifacts/ck123/poster");
  assert.equal(designPosterUrl("a/b"), "/api/artifacts/a%2Fb/poster");
  assert.equal(sharedDesignPosterUrl("tok_abc-123"), "/share/tok_abc-123/poster");
});

// ---------------------------------------------------------------------------
// GET /api/artifacts/{id}/poster
// ---------------------------------------------------------------------------

function seedOwnedDesign() {
  artifacts = [
    { id: "d1", userId: "u1", type: "DESIGN", currentVersion: 3, title: "Sign in", language: null },
    { id: "h1", userId: "u1", type: "HTML", currentVersion: 1, title: "Page", language: null },
    { id: "d2", userId: "someone-else", type: "DESIGN", currentVersion: 1, title: "Theirs", language: null },
  ];
  versions.set("d1:1", { content: stored(retitled("Version one")), createdAt: new Date("2026-09-01T00:00:00Z") });
  versions.set("d1:2", { content: stored(retitled("Version two")), createdAt: new Date("2026-09-02T00:00:00Z") });
  versions.set("d1:3", { content: stored(retitled("Version three")), createdAt: new Date("2026-09-03T00:00:00Z") });
  versions.set("h1:1", { content: "<p>hi</p>", createdAt: new Date("2026-09-01T00:00:00Z") });
  versions.set("d2:1", { content: stored(signInDocument()), createdAt: new Date("2026-09-01T00:00:00Z") });
}

async function getOwner(id: string, query = "", headers: Record<string, string> = {}) {
  const { GET } = await ownerRoute();
  return GET(new Request(`https://juno.test/api/artifacts/${id}/poster${query}`, { headers }), { params: Promise.resolve({ id }) });
}

routeTest("owner: the current version when no version is named, revalidated", async () => {
  reset();
  seedOwnedDesign();
  const res = await getOwner("d1");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml");
  assert.equal(res.headers.get("cache-control"), "private, no-cache");
  assert.match(await res.text(), />Version three</);
  // The same ownership join as every other artifact route, and DESIGN only.
  assert.deepEqual(artifactWheres[0], { id: "d1", type: "DESIGN", conversation: { userId: "u1" } });
  assert.deepEqual(rateKeys, ["artifact-poster:u1"]);
});

routeTest("owner: a superseded version is immutable; the current one is not", async () => {
  reset();
  seedOwnedDesign();
  const old = await getOwner("d1", "?v=2");
  assert.equal(old.status, 200);
  assert.equal(old.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.match(await old.text(), />Version two</);

  // v3 is current, and edits fold into the current row in place, so naming
  // it must not pin its drawing for a year.
  const current = await getOwner("d1", "?v=3");
  assert.equal(current.headers.get("cache-control"), "private, no-cache");

  const etag = current.headers.get("etag")!;
  const unchanged = await getOwner("d1", "?v=3", { "if-none-match": etag });
  assert.equal(unchanged.status, 304);
});

routeTest("owner: everything that is not a readable design of yours is a 404", async () => {
  reset();
  seedOwnedDesign();
  versions.set("d1:1", { content: "{ not a design", createdAt: new Date() });
  for (const [id, query] of [
    ["d2", ""], // someone else's
    ["h1", ""], // not a design
    ["nope", ""], // not there
    ["d1", "?v=9"], // no such version
    ["d1", "?v=1"], // unreadable body
    ["d1", "?v=abc"],
    ["d1", "?v=0"],
    ["d1", "?v=-1"],
    ["d1", "?v=1.5"],
    ["d1", "?v=02"],
  ]) {
    const res = await getOwner(id, query);
    assert.equal(res.status, 404, `${id}${query}`);
  }
});

routeTest("owner: signed out is 401, and the rate limiter is applied", async () => {
  reset();
  seedOwnedDesign();
  currentUser = null;
  assert.equal((await getOwner("d1")).status, 401);

  currentUser = { id: "u1", email: "person@example.com" };
  limited = true;
  assert.equal((await getOwner("d1")).status, 429);
});

// ---------------------------------------------------------------------------
// GET /share/{token}/poster
// ---------------------------------------------------------------------------

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

async function getPublic(token: string) {
  const { GET } = await publicRoute();
  return GET(new Request(`https://juno.test/share/${token}/poster`), { params: Promise.resolve({ token }) });
}

routeTest("public: the version the share page shows, publicly cached, without counting a view", async () => {
  reset();
  seedOwnedDesign();
  // Shared between v2 and v3: the page shows v2, so the poster must too.
  shares = [{ id: "s1", token: TOKEN, userId: "u1", kind: "ARTIFACT", artifactId: "d1", conversationId: null, revokedAt: null, snapshotAt: new Date("2026-09-02T12:00:00Z") }];

  const res = await getPublic(TOKEN);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  const svg = await res.text();
  assert.match(svg, />Version two</);
  assert.doesNotMatch(svg, /Version three/);
  assert.equal(shareViewBumps, 0, "fetching the picture is not another view of the page");
  assert.deepEqual(rateKeys, ["share-poster:203.0.113.9"]);
});

routeTest("public: revoked, taken-down, banned-owner, unknown, chat and non-design shares are a 404", async () => {
  reset();
  seedOwnedDesign();
  shares = [
    { id: "s1", token: `${TOKEN}r`, userId: "u1", kind: "ARTIFACT", artifactId: "d1", conversationId: null, revokedAt: new Date(), snapshotAt: new Date() },
    { id: "s2", token: `${TOKEN}c`, userId: "u1", kind: "CHAT", artifactId: null, conversationId: "c1", revokedAt: null, snapshotAt: new Date() },
    { id: "s3", token: `${TOKEN}h`, userId: "u1", kind: "ARTIFACT", artifactId: "h1", conversationId: null, revokedAt: null, snapshotAt: new Date() },
    { id: "s4", token: `${TOKEN}t`, userId: "u1", kind: "ARTIFACT", artifactId: "d1", conversationId: null, revokedAt: null, takenDownAt: new Date(), snapshotAt: new Date() },
    { id: "s5", token: `${TOKEN}b`, userId: "u1", kind: "ARTIFACT", artifactId: "d1", conversationId: null, revokedAt: null, ownerBannedAt: new Date(), snapshotAt: new Date() },
  ];
  // Taken down and banned-owner shares too: the poster answers exactly as
  // the share page does.
  for (const token of [`${TOKEN}r`, `${TOKEN}c`, `${TOKEN}h`, `${TOKEN}t`, `${TOKEN}b`, `${TOKEN}x`, "short"]) {
    assert.equal((await getPublic(token)).status, 404, token);
  }
});

routeTest("public: a shared design this build cannot read is a 404, and the limiter holds", async () => {
  reset();
  seedOwnedDesign();
  versions.set("d1:1", { content: "garbage", createdAt: new Date("2026-09-01T00:00:00Z") });
  shares = [{ id: "s1", token: TOKEN, userId: "u1", kind: "ARTIFACT", artifactId: "d1", conversationId: null, revokedAt: null, snapshotAt: new Date("2026-09-01T12:00:00Z") }];
  assert.equal((await getPublic(TOKEN)).status, 404);

  limited = true;
  assert.equal((await getPublic(TOKEN)).status, 429);
});

// ---------------------------------------------------------------------------
// Wiring the routes depend on, read as source
// ---------------------------------------------------------------------------

test("the page CSP is not stamped over the public poster's own policy", async () => {
  // Middleware runs on the Edge runtime and cannot be loaded here, so its rule
  // is read as text (as tests/security-regressions.test.ts does). Next keeps a
  // header the middleware already set, so without the exemption the poster
  // would go out under the page policy instead of POSTER_CSP.
  const { readFileSync } = await import("node:fs");
  const middleware = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
  const pattern = middleware.match(/const SHARE_POSTER_PATH = \/(.+)\/;/)?.[1];
  assert.ok(pattern, "the poster path is named in the middleware");
  const path = new RegExp(pattern);
  assert.ok(path.test(sharedDesignPosterUrl(TOKEN)), "the public poster is exempt");
  for (const page of [`/share/${TOKEN}`, `/share/${TOKEN}/poster/x`, "/share/poster", "/api/artifacts/a1/poster"]) {
    assert.ok(!path.test(page), `${page} keeps its usual handling`);
  }
  assert.match(middleware, /withRequestContext\(req, !SHARE_POSTER_PATH\.test\(pathname\)\)/);
});

test("the share page sends a design's poster, never its document", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/app/share/[token]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /content=\{artifact\.type === "DESIGN" \? "" : artifact\.content\}/);
  assert.match(page, /posterUrl=\{artifact\.type === "DESIGN" \? sharedDesignPosterUrl\(token\) : undefined\}/);
});
