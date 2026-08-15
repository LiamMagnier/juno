import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/*
 * The Work half of the native contract.
 *
 * `contracts/openapi/juno-native-v1.yaml` documented twenty-eight paths and not
 * one Work endpoint, while twenty-five route files under src/app/api/work were
 * being called by shipped Swift clients. The drift gate was real and it guarded
 * only the half that had never been at risk — which is worse than no gate,
 * because a green contract check reads as "the clients and the server agree".
 *
 * So this file derives the truth from the direction that can actually be wrong.
 * The authority is JunoWorkKit: whatever path literal a client sends is what the
 * server must answer and what the contract must describe. Enumerating the route
 * directory instead would document endpoints nothing calls and still miss one a
 * client added this morning.
 */

const CONTRACT = readFileSync("contracts/openapi/juno-native-v1.yaml", "utf8");
const WORK_KIT = "native/Packages/JunoNativeKit/Sources/JunoWorkKit";

/** Path parameters collapsed to `*`, so a Swift interpolation and a contract
 *  template compare as the same route regardless of what either named it. */
function shape(path: string): string {
  return path.replace(/\\\([^)]*\)/g, "*").replace(/\{[^}]*\}/g, "*");
}

/** Every `/api/work/...` literal in the shipped client sources. */
function clientPaths(): Set<string> {
  const paths = new Set<string>();
  for (const file of readdirSync(WORK_KIT).filter((name) => name.endsWith(".swift"))) {
    const source = readFileSync(join(WORK_KIT, file), "utf8");
    for (const [, literal] of source.matchAll(/"(\/api\/work[^"]*)"/g)) {
      paths.add(shape(literal));
    }
  }
  return paths;
}

/** Every `/work/...` path item the contract declares, as a route shape. */
function contractPaths(): Set<string> {
  return new Set(
    [...CONTRACT.matchAll(/^  (\/work\/\S*):$/gm)].map(([, path]) => shape(`/api${path}`))
  );
}

test("the client calls no Work endpoint the contract does not describe", () => {
  const undocumented = [...clientPaths()].filter((path) => !contractPaths().has(path)).sort();
  assert.deepEqual(
    undocumented,
    [],
    "JunoWorkKit calls these and contracts/openapi/juno-native-v1.yaml describes none of them"
  );
});

test("the contract describes no Work endpoint the client never calls", () => {
  // The other direction, and it matters as much. A contract that documents an
  // aspirational route is a contract a reader cannot trust to be the shipped
  // surface, which is how the Work half came to be missing in the first place —
  // nobody could tell what the document was claiming to cover.
  const uncalled = [...contractPaths()].filter((path) => !clientPaths().has(path)).sort();
  assert.deepEqual(uncalled, [], "documented but called by nothing in JunoWorkKit");
});

test("every Work operation is reachable under /api rather than /api/v1", () => {
  // Work predates the versioned surface and the clients address it directly.
  // The global `servers` entry is /api/v1, so each Work operation carries the
  // same per-operation override /chat and /code already use — and an operation
  // that forgets it is documented at a URL that has never existed.
  const section = CONTRACT.slice(CONTRACT.indexOf("\n  /work/hosts:"), CONTRACT.indexOf("\ncomponents:"));
  const operations = [...section.matchAll(/^    (get|post|patch|put|delete):$/gm)];
  const overrides = [...section.matchAll(/^      servers: \[\{ url: \/api \}\]$/gm)];
  assert.equal(operations.length, 26);
  assert.equal(overrides.length, operations.length);
});

test("Work vocabularies are named, never re-enumerated", () => {
  // Statuses, risks, decisions and the rest are generated into both the Swift
  // and the TypeScript halves from contracts/work/juno-work-v1.json. A second
  // copy inside this document would be a second source of truth that drifts in
  // silence — a client that cannot name a status renders the run as nothing at
  // all, which is exactly the failure the generated contract exists to prevent.
  const vocabularies = new Set(
    Object.keys(JSON.parse(readFileSync("contracts/work/juno-work-v1.json", "utf8")).vocabularies)
  );
  const referenced = [...CONTRACT.matchAll(/x-juno-work-vocabulary: (\w+)/g)].map(([, id]) => id);
  assert.ok(referenced.length > 0);
  for (const id of referenced) {
    assert.ok(vocabularies.has(id), `the contract names vocabulary "${id}", which does not exist`);
  }
});

test("the drift gate now fails when the Work half is removed", () => {
  // The generator refuses a contract missing a named operation per Work surface.
  // Without this, deleting the whole Work section would regenerate cleanly, the
  // digest would move, the checked-in Swift would be regenerated to match, and
  // every gate would stay green over a contract that had lost a product.
  const generator = readFileSync("scripts/generate-native-swift-contract.mjs", "utf8");
  for (const operation of [
    "listNativeWorkHosts",
    "registerNativeWorkHost",
    "claimNextNativeWorkCommand",
    "appendNativeWorkHostEvents",
    "listNativeWorkSessions",
    "startNativeWorkRun",
    "streamNativeWorkEvents",
    "submitNativeWorkSubmission",
    "decideNativeWorkApproval",
    "downloadNativeWorkArtifact",
    "listNativeWorkSchedules",
  ]) {
    assert.match(generator, new RegExp(`operationId: ${operation}`));
    assert.match(CONTRACT, new RegExp(`operationId: ${operation}`));
  }
});

test("the native contract check also verifies the generated Work vocabulary", () => {
  // `work:contract:check` existed with no caller anywhere in CI, so the Swift
  // enums naming a run's status could drift from the JSON they are generated
  // from for as long as nobody ran it by hand. Chained into the check every gate
  // already invokes rather than added as a second workflow step, because a check
  // only some gates call is a check only some gates have.
  const checker = readFileSync("scripts/check-native-swift-contract.mjs", "utf8");
  assert.match(checker, /scripts\/check-work-contract\.mjs/);

  const result = spawnSync(process.execPath, ["scripts/check-native-swift-contract.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Swift Work contract matches/);
});
