/**
 * `/a/{id}` and the routes that now lead to it (04-MERGE-PLAN.md §5, contract
 * 4 of First light).
 *
 * The address grammar and the "what does this URL draw" decision are pure
 * functions in src/lib/artifact-links.ts and are checked directly. The page
 * itself runs for real against a stand-in Prisma client, with the two windows
 * it can return (the design editor and the read-only view) replaced by named
 * stubs, so each case asserts which window it chose and what it handed over —
 * and that the only artifact it ever reads is one the reader owns.
 *
 * The redirects are checked by calling the page functions and reading the
 * error Next throws for `redirect()`, whose digest carries the target and the
 * status: `NEXT_REDIRECT;replace;/artifacts?type=DESIGN;307;`.
 *
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/artifact-routes.test.ts
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
// Next's react-server build of next/navigation, which the bundler swaps in for
// server components. Plain Node resolves `next/navigation` to the client build,
// which needs React's client context API, so the page is handed the one it
// gets in production. The redirect and 404 errors are Next's own.
import * as serverNavigation from "next/dist/client/components/navigation.react-server";
import * as React from "react";

import {
  ARTIFACT_NOUN,
  DESIGNS_HOME,
  adjacentVersions,
  artifactPath,
  chatArtifactPath,
  latestVersion,
  madeInConversations,
  parseVersionParam,
  resolveArtifactView,
  versionPath,
} from "@/lib/artifact-links";
import { titleForPath } from "@/lib/route-title";
import { runUnifiedSearch, type SearchExecutor } from "@/lib/search/engine";
import type { ArtifactType } from "@/lib/message-content";

// ---------------------------------------------------------------------------
// Stand-ins for the page's dependencies. Registered before the page is first
// imported (every import of it below is dynamic), which is what makes them
// the modules it sees.
// ---------------------------------------------------------------------------

const OWNER = "user-owner";
const STRANGER = "user-stranger";
let reader = OWNER;

type Row = {
  id: string;
  identifier: string;
  title: string;
  type: ArtifactType;
  language: string | null;
  currentVersion: number;
  conversationId: string;
  ownerId: string;
  bodies: Record<number, string>;
};
let rows: Row[] = [];
const reads: { op: string; args: Record<string, unknown> }[] = [];

const prisma = {
  artifact: {
    // Honours ownership the way Postgres would: a row comes back only when the
    // `where` names its owner (the artifact's own userId) and asks for a live,
    // untrashed row.
    findFirst: async (args: { where: { id: string; userId?: string; deletedAt?: unknown }; select?: unknown }) => {
      reads.push({ op: "artifact.findFirst", args });
      const row = rows.find((r) => r.id === args.where.id && r.ownerId === args.where.userId && args.where.deletedAt === null);
      if (!row) return null;
      const { bodies, ownerId: _ownerId, ...rest } = row;
      void _ownerId;
      return {
        ...rest,
        draft: null,
        versions: Object.keys(bodies)
          .map(Number)
          .sort((a, b) => a - b)
          .map((version) => ({ version })),
      };
    },
  },
  artifactVersion: {
    findUnique: async (args: { where: { artifactId_version: { artifactId: string; version: number } } }) => {
      reads.push({ op: "artifactVersion.findUnique", args });
      const { artifactId, version } = args.where.artifactId_version;
      const content = rows.find((r) => r.id === artifactId)?.bodies[version];
      return content === undefined ? null : { version, content, createdAt: new Date("2026-09-24T10:00:00Z") };
    },
  },
};

function DesignWorkspace() {
  return null;
}
function ArtifactReadView() {
  return null;
}

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so there the pure tests still run and the ones that
// drive a page skip rather than fail (as tests/account-delete-deliverables.test.ts
// does).
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const pageTest = canMockModules ? test : test.skip;

if (canMockModules) {
  mock.module("next/navigation", { namedExports: { ...serverNavigation } });
  mock.module("@/lib/prisma", { namedExports: { prisma } });
  mock.module("@/lib/session", { namedExports: { requireUser: async () => ({ id: reader }) } });
  mock.module("@/components/design/design-workspace", { namedExports: { DesignWorkspace } });
  mock.module("@/app/(app)/a/[id]/artifact-read-view", { namedExports: { ArtifactReadView } });
}

type Element = { type: unknown; props: Record<string, unknown> };

/**
 * The page, called the way Next calls it. `tsx` compiles JSX the classic way
 * (the repo's tsconfig says `preserve`, which is Next's to handle), so a page
 * that never imports React, as a Next page need not, looks for it globally —
 * the same arrangement as tests/download-feed.test.ts.
 */
async function openArtifact(id: string, v?: string | string[]): Promise<Element> {
  const scope = globalThis as { React?: typeof React };
  scope.React ??= React;
  const { default: ArtifactPage } = await import("@/app/(app)/a/[id]/page");
  return (await ArtifactPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(v === undefined ? {} : { v }),
  })) as unknown as Element;
}

/** The target and status of the `redirect()` a call threw, or a failure. */
async function redirectOf(run: () => unknown): Promise<{ to: string; status: number }> {
  try {
    await run();
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    const [code, , to, status] = digest.split(";");
    assert.equal(code, "NEXT_REDIRECT", `expected a redirect, got ${digest || String(error)}`);
    return { to, status: Number(status) };
  }
  assert.fail("expected a redirect, and the page rendered");
}

async function assertNotFound(run: () => unknown) {
  await assert.rejects(Promise.resolve().then(run), (error: { digest?: string }) => {
    assert.equal(error.digest, "NEXT_HTTP_ERROR_FALLBACK;404");
    return true;
  });
}

function seed() {
  reader = OWNER;
  reads.length = 0;
  rows = [
    {
      id: "art-page",
      identifier: "pricing-table",
      title: "Pricing table",
      type: "HTML",
      language: "html",
      currentVersion: 3,
      conversationId: "conv-1",
      ownerId: OWNER,
      bodies: { 1: "<p>one</p>", 2: "<p>two</p>", 3: "<p>three</p>" },
    },
    {
      id: "art-design",
      identifier: "sign-in",
      title: "Sign-in screen",
      type: "DESIGN",
      language: null,
      currentVersion: 3,
      conversationId: "conv-2",
      ownerId: OWNER,
      bodies: { 1: '{"v":1}', 2: '{"v":2}', 3: '{"v":3}' },
    },
  ];
}

// ---------------------------------------------------------------------------
// The address grammar
// ---------------------------------------------------------------------------

test("an artifact's address is /a/{id}, with ?v= only when a version is asked for", () => {
  assert.equal(artifactPath("ck123"), "/a/ck123");
  assert.equal(artifactPath("ck123", 4), "/a/ck123?v=4");
  assert.equal(artifactPath("ck123", null), "/a/ck123");
  assert.equal(artifactPath("a/b?c"), "/a/a%2Fb%3Fc", "an id can never break out of its segment");
});

test("Open in chat is the made-in conversation with its canvas on the artifact", () => {
  assert.equal(chatArtifactPath("conv-1", "pricing-table"), "/chat/conv-1?artifact=pricing-table");
  assert.equal(chatArtifactPath("conv-1", "a&b=c"), "/chat/conv-1?artifact=a%26b%3Dc");
});

test("?v= is a whole positive number or it is not a version", () => {
  assert.equal(parseVersionParam("3"), 3);
  assert.equal(parseVersionParam("12"), 12);
  assert.equal(parseVersionParam(["4", "5"]), 4, "a repeated key reads the first, as URLSearchParams.get does");
  for (const raw of [undefined, "", "0", "-1", "1.5", "3abc", "03", " 3", "1e3", "9999999999"]) {
    assert.equal(parseVersionParam(raw), null, `${JSON.stringify(raw)} names no version`);
  }
});

test("the latest version is currentVersion, or the highest stored one when that row is missing", () => {
  assert.equal(latestVersion([1, 2, 3], 3), 3);
  assert.equal(latestVersion([1, 2, 3], 2), 2, "a restore can make an older number current");
  assert.equal(latestVersion([1, 2], 5), 2);
  assert.equal(latestVersion([], 1), null);
});

test("the stepper steps between stored versions, and its last step is the bare address", () => {
  assert.deepEqual(adjacentVersions([1, 2, 3], 2), { previous: 1, next: 3 });
  assert.deepEqual(adjacentVersions([1, 2, 3], 1), { previous: null, next: 2 });
  assert.deepEqual(adjacentVersions([1, 2, 3], 3), { previous: 2, next: null });
  assert.deepEqual(adjacentVersions([3, 1, 5, 3], 3), { previous: 1, next: 5 }, "gaps and order do not matter");
  assert.deepEqual(adjacentVersions([1, 2], 7), { previous: null, next: null });
  assert.equal(versionPath("ck1", 3, 3), "/a/ck1");
  assert.equal(versionPath("ck1", 2, 3), "/a/ck1?v=2");
});

// ---------------------------------------------------------------------------
// What /a/{id} draws
// ---------------------------------------------------------------------------

const view = (type: ArtifactType, requested: number | null, available = [1, 2, 3], currentVersion = 3) =>
  resolveArtifactView({ id: "ck1", type, available, currentVersion, requested });

test("a page, doc, diagram or code is the read-only window, at the version asked for", () => {
  for (const type of ["HTML", "REACT", "CODE", "MARKDOWN", "SVG", "MERMAID"] as const) {
    assert.deepEqual(view(type, null), { kind: "read", version: 3, latest: 3 }, type);
    assert.deepEqual(view(type, 2), { kind: "read", version: 2, latest: 3 }, type);
    // A search hit pins the version it matched, even when that is the latest.
    assert.deepEqual(view(type, 3), { kind: "read", version: 3, latest: 3 }, type);
  }
});

test("a design at its latest version is the editor, and only ever at the bare address", () => {
  assert.deepEqual(view("DESIGN", null), { kind: "editor", version: 3 });
  assert.deepEqual(view("DESIGN", 3), { kind: "redirect", to: "/a/ck1" }, "an editor under ?v=3 would lie after one edit");
  assert.deepEqual(view("DESIGN", 1), { kind: "read", version: 1, latest: 3 }, "an older design is a picture, not the editor");
  assert.deepEqual(view("DESIGN", null, [1, 2], 5), { kind: "editor", version: 2 });
});

test("a version that is not there moves to the bare address instead of drawing another under its name", () => {
  assert.deepEqual(view("HTML", 9), { kind: "redirect", to: "/a/ck1" });
  assert.deepEqual(view("DESIGN", 9), { kind: "redirect", to: "/a/ck1" });
});

test("an artifact with no stored version has nothing to draw", () => {
  assert.deepEqual(view("HTML", null, []), { kind: "missing" });
  assert.deepEqual(view("DESIGN", 2, []), { kind: "missing" });
});

test("every type has a noun, and it is the reader's word rather than the enum", () => {
  const types: ArtifactType[] = ["HTML", "REACT", "CODE", "MARKDOWN", "SVG", "MERMAID", "DESIGN"];
  for (const type of types) assert.ok(ARTIFACT_NOUN[type], type);
  assert.equal(ARTIFACT_NOUN.SVG, "Image");
  assert.equal(ARTIFACT_NOUN.MARKDOWN, "Doc");
  assert.equal(ARTIFACT_NOUN.REACT, "App");
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

pageTest("the page reads the artifact by its own owner, and one body only", async () => {
  seed();
  const element = await openArtifact("art-page");
  assert.equal(element.type, ArtifactReadView);
  assert.deepEqual(element.props, {
    id: "art-page",
    type: "HTML",
    title: "Pricing table",
    language: "html",
    version: 3,
    latest: 3,
    versions: [1, 2, 3],
    content: "<p>three</p>",
    chatHref: "/chat/conv-1?artifact=pricing-table",
  });
  const [first, second] = reads;
  assert.deepEqual((first.args as { where: unknown }).where, { id: "art-page", userId: OWNER, deletedAt: null });
  const select = (first.args as { select: { versions: { select: unknown } } }).select;
  assert.deepEqual(select.versions.select, { version: true }, "version numbers only; no body rides the first read");
  assert.deepEqual((second.args as { where: unknown }).where, { artifactId_version: { artifactId: "art-page", version: 3 } });
  assert.equal(reads.length, 2);
});

pageTest("?v= draws that version, and names the latest for the bar", async () => {
  seed();
  const element = await openArtifact("art-page", "1");
  assert.equal(element.type, ArtifactReadView);
  assert.equal(element.props.version, 1);
  assert.equal(element.props.latest, 3);
  assert.equal(element.props.content, "<p>one</p>");
});

pageTest("someone else's artifact is the same 404 as one that never existed", async () => {
  seed();
  reader = STRANGER;
  await assertNotFound(() => openArtifact("art-page"));
  assert.equal(reads.filter((r) => r.op === "artifactVersion.findUnique").length, 0, "no body is read for a stranger");
  reader = OWNER;
  await assertNotFound(() => openArtifact("art-missing"));
});

pageTest("a design opens in the design editor, as /design/{id} drew it", async () => {
  seed();
  const element = await openArtifact("art-design");
  assert.equal(element.type, DesignWorkspace);
  assert.deepEqual(element.props, {
    artifactId: "art-design",
    title: "Sign-in screen",
    version: 3,
    content: '{"v":3}',
    conversationId: "conv-2",
  });
});

pageTest("an older design version is drawn read-only, and its JSON never reaches the page", async () => {
  seed();
  const element = await openArtifact("art-design", "2");
  assert.equal(element.type, ArtifactReadView);
  assert.equal(element.props.type, "DESIGN");
  assert.equal(element.props.version, 2);
  assert.equal(element.props.content, "");
});

pageTest("the page redirects rather than drawing under a wrong address", async () => {
  seed();
  assert.deepEqual(await redirectOf(() => openArtifact("art-page", "9")), { to: "/a/art-page", status: 307 });
  assert.deepEqual(await redirectOf(() => openArtifact("art-design", "3")), { to: "/a/art-design", status: 307 });
});

pageTest("a version that goes away between the two reads is a 404, not an empty window", async () => {
  seed();
  const original = prisma.artifactVersion.findUnique;
  prisma.artifactVersion.findUnique = async () => null;
  try {
    await assertNotFound(() => openArtifact("art-page"));
  } finally {
    prisma.artifactVersion.findUnique = original;
  }
});

// ---------------------------------------------------------------------------
// The routes that lead here
// ---------------------------------------------------------------------------

pageTest("/design is a 307 to Artifacts, filtered to designs", async () => {
  const { default: DesignRedirect } = await import("@/app/(app)/design/page");
  assert.equal(DESIGNS_HOME, "/artifacts?type=DESIGN");
  assert.deepEqual(await redirectOf(() => DesignRedirect()), { to: "/artifacts?type=DESIGN", status: 307 });
});

pageTest("/design/{id} is a 307 to /a/{id}, without a read of its own", async () => {
  seed();
  const { default: DesignArtifactRedirect } = await import("@/app/(app)/design/[artifactId]/page");
  assert.deepEqual(
    await redirectOf(() => DesignArtifactRedirect({ params: Promise.resolve({ artifactId: "art-design" }) })),
    { to: "/a/art-design", status: 307 }
  );
  assert.equal(reads.length, 0, "/a/{id} is the one place that decides who may open it");
});

test("the tab reads Artifact on /a/{id}, and the prefix catches nothing else", () => {
  assert.equal(titleForPath("/a/ck123"), "Artifact");
  assert.equal(titleForPath("/artifacts"), "Made by Alevr");
  assert.equal(titleForPath("/admin"), "Admin");
  assert.equal(titleForPath("/design"), "Alevr", "a redirect draws no window to caption");
});

test("a search hit opens the artifact's own address at the version that matched", async () => {
  const executor: SearchExecutor = {
    async run<T>(statement: Prisma.Sql): Promise<T[]> {
      if (!statement.text.includes('FROM "ArtifactVersion" v')) return [];
      return [
        {
          id: "art-page",
          identifier: "pricing-table",
          title: "Pricing table",
          conversationId: "conv-1",
          projectId: null,
          version: 2,
          snippetSource: "pricing table tiers",
          updatedAt: new Date("2026-09-24T10:00:00Z"),
          rank: 0.5,
        },
      ] as T[];
    },
  };
  const result = await runUnifiedSearch(
    { userId: OWNER, query: "pricing", types: ["artifact"] },
    { executor, decryptMessage: (s) => s }
  );
  const hit = result.groups.find((g) => g.type === "artifact")?.hits[0];
  assert.equal(hit?.href, "/a/art-page?v=2");
  assert.equal(hit?.locator, "v2");
});

test("a project's artifacts are the ones made in its chats", () => {
  const items = [
    { id: "a1", conversationId: "c-in" },
    { id: "a2", conversationId: "c-out" },
    { id: "a3", conversationId: "c-in-2" },
  ];
  assert.deepEqual(
    madeInConversations(items, ["c-in", "c-in-2"]).map((a) => a.id),
    ["a1", "a3"]
  );
  assert.deepEqual(madeInConversations(items, []), [], "a project with no chats has no artifacts");
  assert.deepEqual(madeInConversations(items, new Set(["c-out"])).map((a) => a.id), ["a2"]);
});
