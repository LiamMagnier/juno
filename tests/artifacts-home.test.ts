import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  HOME_TYPE_ORDER,
  artifactHref,
  conversationArtifactHref,
  effectiveHomeFilter,
  homeHrefForType,
  homeNewFromParam,
  homeTypeChips,
  homeTypeFromParam,
} from "@/lib/artifacts-home";
import { DESIGN_PRESETS, START_DESIGN_ERROR, UNTITLED_DESIGN, startDesign } from "@/lib/design/presets";

/*
 * THE ARTIFACTS HOME, WITH DESIGN AS A TYPE.
 *
 * `/design` is closing (04-MERGE-PLAN §4.1: design is a type, not a place).
 * Its traffic lands on `/artifacts?type=DESIGN`, its presets move into the
 * home's New menu, and a design opens at `/a/{id}` like every other artifact.
 * What is pinned here is the part of that which lives in plain functions — the
 * URL grammar, the chip rules, the presets and the create call — plus three
 * source-level facts about the page and the tile that a refactor could quietly
 * undo: the untrue lede, the link target, and a design never previewed as JSON.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Source with its comments taken out, so an assertion about CODE is not
 *  tripped by a comment that explains the code by naming what it replaced. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── ?type= ─────────────────────────────────────────────────────────────────

test("?type= reads the enum in any case, and anything else as All", () => {
  assert.equal(homeTypeFromParam("DESIGN"), "DESIGN");
  // The plan writes the registry noun (`?type=design`); the contract writes
  // the enum. One link either way.
  assert.equal(homeTypeFromParam("design"), "DESIGN");
  assert.equal(homeTypeFromParam(" Design "), "DESIGN");
  assert.equal(homeTypeFromParam("mermaid"), "MERMAID");
  for (const junk of [null, undefined, "", "ALL", "designs", "__proto__", "toString", "HTML,REACT"]) {
    assert.equal(homeTypeFromParam(junk), "ALL", `${String(junk)} is not a filter`);
  }
});

test("a chip writes ?type= into the URL and All takes it out, keeping the rest", () => {
  assert.equal(homeHrefForType("", "DESIGN"), "/artifacts?type=DESIGN");
  assert.equal(homeHrefForType("?type=DESIGN", "ALL"), "/artifacts");
  assert.equal(homeHrefForType("?type=DESIGN&q=hero", "ALL"), "/artifacts?q=hero");
  assert.equal(homeHrefForType("?type=HTML", "MERMAID"), "/artifacts?type=MERMAID");
  assert.equal(homeHrefForType("?q=hero", "SVG"), "/artifacts?q=hero&type=SVG");
});

test("?new=design is the only New request understood today", () => {
  assert.equal(homeNewFromParam("design"), "design");
  assert.equal(homeNewFromParam("DESIGN"), "design");
  for (const other of [null, undefined, "", "1", "app", "doc"]) {
    assert.equal(homeNewFromParam(other), null);
  }
});

// ── Chips and the filter actually applied ─────────────────────────────────

test("the chip order names every artifact type exactly once, Designs first", () => {
  const source = read("src/lib/message-content.ts");
  const union = source.match(/export type ArtifactType\s*=\s*([^;]+);/);
  assert.ok(union, "ArtifactType is declared as a string union in message-content.ts");
  const declared = [...union[1].matchAll(/"([A-Z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual([...HOME_TYPE_ORDER].sort(), declared);
  assert.equal(new Set(HOME_TYPE_ORDER).size, HOME_TYPE_ORDER.length);
  assert.equal(HOME_TYPE_ORDER[0], "DESIGN");
});

test("Designs always has a chip; every other kind only while it has something", () => {
  assert.deepEqual(homeTypeChips([]), ["DESIGN"]);
  assert.deepEqual(homeTypeChips(["MERMAID", "HTML", "HTML"]), ["DESIGN", "HTML", "MERMAID"]);
  assert.deepEqual(homeTypeChips(["DESIGN"]), ["DESIGN"]);
  // A Map's keys, which is what the page hands over.
  assert.deepEqual(homeTypeChips(new Map([["SVG", 2], ["REACT", 1]] as const).keys()), ["DESIGN", "REACT", "SVG"]);
});

test("a filter whose chip has gone reads as All, so no row hides behind it (L31)", () => {
  assert.equal(effectiveHomeFilter("REACT", ["DESIGN"]), "ALL");
  assert.equal(effectiveHomeFilter("REACT", ["DESIGN", "REACT"]), "REACT");
  assert.equal(effectiveHomeFilter("ALL", ["DESIGN", "REACT"]), "ALL");
  // The /design redirect's filter survives an account with no designs yet:
  // that is where the pinned presets and "No designs yet" are drawn.
  assert.equal(effectiveHomeFilter("DESIGN", homeTypeChips([])), "DESIGN");
  assert.equal(effectiveHomeFilter("DESIGN", homeTypeChips(["HTML"])), "DESIGN");
});

// ── Where things open ──────────────────────────────────────────────────────

test("an artifact opens at /a/{id}; its chat keeps the panel link", () => {
  assert.equal(artifactHref("clx0abc123"), "/a/clx0abc123");
  assert.equal(artifactHref("a/b"), "/a/a%2Fb");
  assert.equal(conversationArtifactHref("c1", "sign-in screen"), "/chat/c1?artifact=sign-in%20screen");
});

// ── The presets ────────────────────────────────────────────────────────────

test("the presets are the four /design offered, each describing its own frame", () => {
  assert.deepEqual(
    DESIGN_PRESETS.map((p) => [p.key, p.label, p.detail]),
    [
      ["phone", "Phone", "375 × 812"],
      ["tablet", "Tablet", "834 × 1194"],
      ["desktop", "Desktop", "1440 × 900"],
      ["square", "Square", "1080 × 1080"],
    ]
  );
  assert.equal(new Set(DESIGN_PRESETS.map((p) => p.key)).size, DESIGN_PRESETS.length);
  for (const preset of DESIGN_PRESETS) {
    assert.equal(preset.detail, `${preset.width} × ${preset.height}`, `${preset.key}'s detail is its size`);
  }
});

test("every preset is one the create route accepts, at the size the route draws", () => {
  // Read as text: the route imports Prisma and cannot be loaded here, and a
  // preset the route's enum refuses is a menu item that answers "Invalid input".
  const route = read("src/app/api/design/route.ts");
  const enumMatch = route.match(/preset:\s*z\.enum\(\[([^\]]*)\]\)/);
  assert.ok(enumMatch, "POST /api/design declares its preset enum");
  const accepted = [...enumMatch[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(DESIGN_PRESETS.map((p) => p.key).sort(), [...accepted].sort());

  for (const preset of DESIGN_PRESETS) {
    const frame = route.match(new RegExp(`${preset.key}:\\s*\\{\\s*width:\\s*([\\d_]+),\\s*height:\\s*([\\d_]+)`));
    assert.ok(frame, `the route sizes ${preset.key}`);
    assert.equal(Number(frame[1].replace(/_/g, "")), preset.width, `${preset.key} width`);
    assert.equal(Number(frame[2].replace(/_/g, "")), preset.height, `${preset.key} height`);
  }
});

// ── startDesign ────────────────────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit | undefined };

async function withFetch<T>(
  respond: (call: FetchCall) => Response,
  run: (calls: FetchCall[]) => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("startDesign posts the preset and answers the new artifact's id, not the route's url", async () => {
  await withFetch(
    () => json({ artifactId: "art_1", conversationId: "c_1", url: "/design/art_1" }),
    async (calls) => {
      assert.equal(await startDesign("tablet"), "art_1");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/design");
      assert.equal(calls[0].init?.method, "POST");
      assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { title: UNTITLED_DESIGN, preset: "tablet" });
    }
  );
});

test("startDesign takes a preset object as well as its key, and a title", async () => {
  await withFetch(
    () => json({ artifactId: "art_2" }),
    async (calls) => {
      const square = DESIGN_PRESETS.find((p) => p.key === "square");
      assert.ok(square);
      assert.equal(await startDesign(square, { title: "Poster" }), "art_2");
      assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { title: "Poster", preset: "square" });
    }
  );
});

test("startDesign throws the route's reason when it gives one, else the generic line", async () => {
  await withFetch(
    () => json({ error: "Your plan does not include the canvas." }, 403),
    async () => {
      await assert.rejects(startDesign("phone"), { message: "Your plan does not include the canvas." });
    }
  );
  await withFetch(
    () => new Response("<html>502</html>", { status: 502 }),
    async () => {
      await assert.rejects(startDesign("phone"), { message: START_DESIGN_ERROR });
    }
  );
  // A 200 with no id is not a design anyone can open.
  await withFetch(
    () => json({ url: "/design/x" }),
    async () => {
      await assert.rejects(startDesign("phone"), { message: START_DESIGN_ERROR });
    }
  );
});

// ── Facts about the page and the tile ─────────────────────────────────────

test("the home no longer claims to hold everything, and opens every row at /a/{id}", () => {
  const page = code("src/app/(app)/artifacts/page.tsx");
  // X-list "Lede copy": generated images and task files are not listed here.
  assert.doesNotMatch(page, /Everything Juno built with you/);
  // Grid tile and list row, both.
  assert.equal(page.match(/href=\{artifactHref\(item\.id\)\}/g)?.length, 2);
  // No link into the closed door, and no trusting the create route's url.
  assert.doesNotMatch(page, /["'`]\/design[/"'`?]/);
  assert.doesNotMatch(page, /data\.url/);
  // The DESIGN chip's word.
  assert.match(page, /DESIGN: "Designs"/);
});

test("a design tile never falls through to its source (X-20, L30)", () => {
  const preview = read("src/components/artifacts/artifact-preview.tsx");
  // The source excerpt is never computed for a design…
  assert.match(preview, /if \(!preview \|\| svg \|\| design\) return \[\];/);
  // …its picture is the server's poster, through the shared URL helper…
  assert.match(preview, /designPosterUrl\(artifactId, version\)/);
  assert.match(preview, /loading="lazy"/);
  assert.match(preview, /decoding="async"/);
  assert.match(preview, /object-contain/);
  // …and a failed poster falls back to the glyph, not to anything else.
  assert.match(preview, /onError=\{\(\) => setFailed\(src\)\}/);
});
