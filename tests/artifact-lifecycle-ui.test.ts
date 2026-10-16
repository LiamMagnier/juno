import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diffLines, diffSegments, diffStats } from "@/lib/line-diff";
import { RESPONSE_COPY, errorMessageFor, readJsonResponse, requestJson } from "@/lib/artifact-response";
import { VERSION_ORIGIN_COPY, versionOriginLabel } from "@/lib/artifact-version-labels";
import { ARTIFACT_CHANGED_EVENT, OPEN_ARTIFACT_EVENT, requestOpenArtifact } from "@/lib/artifact-events";
import { serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * The artifact lifecycle the critic found wanting: Compare was two raw <pre>
 * blocks cut at 20k characters, History printed storage words, there was no
 * Rename, and a non-JSON error page surfaced as a parser error.
 */

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

test("the client helpers are client-safe", () => {
  for (const file of ["src/lib/line-diff.ts", "src/lib/artifact-response.ts", "src/lib/artifact-version-labels.ts", "src/lib/artifact-events.ts"]) {
    assert.deepEqual(serverOnlyIn(file), [], file);
  }
});

test("a one-line change in a long document folds to the change and its context", () => {
  const before = lines(400);
  const after = before.replace("line 200\n", "line two hundred\n");
  const diff = diffLines(before, after);
  assert.deepEqual(diffStats(diff), { added: 1, removed: 1 });
  const segments = diffSegments(diff, 3);
  assert.deepEqual(
    segments.map((s) => [s.kind, s.lines.length]),
    [
      ["gap", 196],
      ["lines", 8],
      ["gap", 197],
    ]
  );
  const shown = segments.find((s) => s.kind === "lines")!;
  assert.equal(shown.lines.filter((l) => l.type === "removed")[0].text, "line 200");
  assert.equal(shown.lines.filter((l) => l.type === "added")[0].text, "line two hundred");
});

test("nothing past 20,000 characters is cut off any more", () => {
  const before = "x".repeat(30_000) + "\nthe end";
  const after = "x".repeat(30_000) + "\nthe real end";
  const segments = diffSegments(diffLines(before, after));
  const changed = segments.flatMap((s) => s.lines).filter((l) => l.type !== "same").map((l) => l.text);
  assert.deepEqual(changed, ["the end", "the real end"]);
});

test("short unchanged stretches are shown rather than folded, and identical versions have no segments", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
  const after = ["A", "b", "c", "d", "e", "f", "g", "h", "i", "J"].join("\n");
  const segments = diffSegments(diffLines(before, after), 3, 4);
  assert.equal(segments.length, 1, "a 2-line gap between two changes is shown");
  assert.equal(segments[0].kind, "lines");
  assert.deepEqual(diffSegments(diffLines("same\ntext", "same\ntext")), []);
});

test("History says how each version came to be in words", () => {
  assert.deepEqual(versionOriginLabel("generated"), { short: "Generated", long: VERSION_ORIGIN_COPY.generatedLong });
  assert.equal(versionOriginLabel("edit")?.long, "Edited by you");
  assert.equal(versionOriginLabel("restore")?.long, "Restored from an earlier version");
  assert.equal(versionOriginLabel(null), null);
  assert.equal(versionOriginLabel("something-new"), null);
  assert.doesNotMatch(VERSION_ORIGIN_COPY.generatedLong, /juno/i);
});

test("an HTML error page reads as a sentence, never a parser error", async () => {
  const html = new Response("<!DOCTYPE html><html><body>Bad gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } });
  const result = await readJsonResponse(html);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, RESPONSE_COPY.server);
    assert.doesNotMatch(result.error, /token|JSON/i);
  }
  const empty = await readJsonResponse(new Response("", { status: 504 }));
  assert.equal(!empty.ok && empty.error, RESPONSE_COPY.server);
});

test("the server's own sentence is kept; terse codes are translated by status", async () => {
  const sentence = await readJsonResponse(Response.json({ error: "That version does not exist.", code: "x" }, { status: 400 }));
  assert.equal(!sentence.ok && sentence.error, "That version does not exist.");
  assert.equal(!sentence.ok && sentence.code, "x");
  assert.equal(errorMessageFor(404, { error: "Not found" }), RESPONSE_COPY.notFound);
  assert.equal(errorMessageFor(401, { error: "Unauthorized" }), RESPONSE_COPY.unauthorized);
  assert.equal(errorMessageFor(409, { error: "stale" }), RESPONSE_COPY.failed);
  assert.equal(errorMessageFor(429, null), RESPONSE_COPY.rateLimited);
  const ok = await readJsonResponse(Response.json({ url: "/a/1" }, { status: 201 }));
  assert.deepEqual(ok, { ok: true, status: 201, data: { url: "/a/1" } });
});

test("a network failure is the offline sentence", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  try {
    const result = await requestJson("/api/anything");
    assert.deepEqual(result, { ok: false, status: 0, error: RESPONSE_COPY.offline, code: null, data: null });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the artifact menu checks the status before it parses, and offers Rename", () => {
  const source = readFileSync("src/components/artifacts/artifact-lifecycle-actions.tsx", "utf8");
  assert.doesNotMatch(source, /response\.json\(\)|res\.json\(\)/, "every answer goes through requestJson");
  assert.match(source, /requestJson\(/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /LIFECYCLE_COPY\.rename/);
  // Compare is the line diff (or two posters for a design), not raw <pre> blocks.
  assert.doesNotMatch(source, /<pre|slice\(0, 20_000\)/);
  assert.match(source, /<VersionLineDiff/);
  assert.match(source, /<VersionPosterCompare/);
  // History prints readable labels.
  assert.match(source, /versionOriginLabel\(item\.origin\)\?\.long \?\? VERSION_ORIGIN_COPY\.saved/);
});

test("the design workspace keeps its own name field; Library rows reload after a menu change", () => {
  assert.match(readFileSync("src/components/design/design-workspace.tsx", "utf8"), /type="DESIGN" renamable=\{false\}/);
  const library = readFileSync("src/components/library/library-home.tsx", "utf8");
  assert.match(library, /window\.addEventListener\(ARTIFACT_CHANGED_EVENT, reload\)/);
  assert.equal(ARTIFACT_CHANGED_EVENT, "juno:artifact-changed");
});

test("Open in canvas reaches the chat on screen, and says when none did", () => {
  const seen: unknown[] = [];
  const listeners = new Map<string, (event: Event) => void>();
  const fakeWindow = {
    addEventListener: (name: string, fn: (event: Event) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
    dispatchEvent: (event: Event) => {
      seen.push(event.type);
      listeners.get(event.type)?.(event);
      return true;
    },
  };
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = fakeWindow;
  try {
    assert.equal(requestOpenArtifact("c1", "research-report-r1"), false, "nobody listening");
    fakeWindow.addEventListener(OPEN_ARTIFACT_EVENT, (event) => {
      const detail = (event as CustomEvent<{ identifier: string; opened?: boolean }>).detail;
      if (detail.identifier === "research-report-r1") detail.opened = true;
    });
    assert.equal(requestOpenArtifact("c1", "research-report-r1"), true);
    assert.equal(requestOpenArtifact("c1", "other"), false);
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
  assert.ok(seen.every((type) => type === OPEN_ARTIFACT_EVENT));
  const chat = readFileSync("src/components/chat/chat-view.tsx", "utf8");
  assert.match(chat, /window\.addEventListener\(OPEN_ARTIFACT_EVENT, open\)/);
  assert.match(chat, /detail\.opened = true;/);
});
