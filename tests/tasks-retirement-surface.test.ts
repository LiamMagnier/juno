import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { catalogEntryMatchesModel } from "@/lib/models";

/*
 * Retiring a surface without lying to the clients that still call it.
 *
 * The web half of scheduled tasks is gone — `/tasks` redirects, the sidebar row
 * and the palette entry went with it — but the macOS and iOS Tasks screens are
 * shipped binaries that keep calling `/api/tasks`, and that route's answers
 * changed underneath them. Two failures follow, and neither shows up in a
 * TypeScript build because the affected code is Swift:
 *
 *   A "new task" button that is still enabled. POST answers 410, which
 *   `requireSuccess` surfaces as a bare status phrase.
 *
 *   A row whose switch cannot switch. PATCH and DELETE answer 409 for an
 *   adopted task, the sweep adopts every task and clears `enabled` as it goes,
 *   so the list shows every task off with no control that can turn one on.
 *
 * So this is a source guard, in the style of tests/native-work-contract.test.ts:
 * the server must SAY the surface is retired, and the clients must gate on what
 * it says rather than inferring it from a count. A reviewer can hold that rule
 * in their head and a grep can check it.
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/**
 * The same file with its whole-line comments removed.
 *
 * Every "this must not appear" assertion below is about what the code DOES, and
 * the comments beside that code quote the thing it stopped doing — which is the
 * point of them. Matching the raw file would make the explanation fail the test
 * that the explanation exists for.
 */
function code(relative: string): string {
  return source(relative)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

const ROUTE = "src/app/api/tasks/route.ts";
const STORE = "native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeScheduledTaskStore.swift";
const DESKTOP = "native/macOS/JunoDesktop/App/DesktopTasksScreen.swift";
const MOBILE = "native/iOS/JunoMobile/App/JunoMobileTasksView.swift";

// ---------------------------------------------------------------------------
// The server says it out loud
// ---------------------------------------------------------------------------

test("GET /api/tasks states the retirement as flags, not as a limit of zero", () => {
  const route = source(ROUTE);
  assert.match(route, /creatable: false/);
  assert.match(route, /readOnly: true/);
  // `limit: 0` stays for an old client's decoder, but nothing may go back to
  // reading a retirement out of it.
  assert.match(route, /limit: 0/);
  assert.match(route, /movedToScheduleId: byTask\.get\(task\.id\) \?\? null/);
});

test("the route's docblock describes what the clients actually render", () => {
  // The claim this replaced said `limit: 0` renders as "a disabled new task
  // button". It did not, for any account with a task — which is every account
  // this retirement is about. A docblock that asserts a client behaviour has to
  // be checkable against the client.
  const route = source(ROUTE);
  assert.match(route, /creatable: false` disables the "new task" control/);
  assert.match(route, /movedToScheduleId`, per row/);
  assert.doesNotMatch(route, /a disabled\s*\n?\s*\* "new task" button, and that is the correct control/);
});

// ---------------------------------------------------------------------------
// The clients gate on what it says
// ---------------------------------------------------------------------------

test("the store reads both flags and never infers a lock from the limit", () => {
  const store = source(STORE);
  assert.match(store, /let creatable: Bool\?/);
  assert.match(store, /let readOnly: Bool\?/);
  assert.match(store, /let movedToScheduleId: String\?/);
  assert.match(store, /isCreatable = result\.isCreatable/);
  assert.match(store, /isReadOnly = result\.isReadOnly/);
  // The derivation that made this defect: `limit == 0 && tasks.isEmpty` was
  // false for exactly the accounts the retirement is about.
  assert.doesNotMatch(code(STORE), /isPlanLocked/);
  assert.doesNotMatch(code(STORE), /limit == 0 && tasks\.isEmpty/);
});

test("the store refuses a write the server would refuse, rather than sending it", () => {
  const store = source(STORE);
  // A `canEdit` the views call, and the same check inside the mutations, so a
  // view that forgets cannot produce a switch that springs back.
  assert.match(store, /public func canEdit\(_ task: NativeScheduledTask\) -> Bool \{\s*\n\s*!isReadOnly && !task\.isReadOnly/);
  assert.match(store, /guard canEdit\(tasks\[index\]\) else \{ return \}/);
  assert.match(store, /guard isCreatable else \{ return false \}/);
  // A row adopted between two refreshes still answers 409; re-reading is what
  // disables the control that just failed.
  assert.match(store, /case \.server\(409, _\) = refusal/);
});

test("both Tasks screens gate creation on the server's answer", () => {
  assert.match(source(DESKTOP), /model\.isCreatable && !model\.isAtLimit/);
  assert.match(source(MOBILE), /!model\.isCreatable \|\| model\.isAtLimit/);
  for (const file of [DESKTOP, MOBILE]) {
    assert.doesNotMatch(code(file), /isPlanLocked/, file);
  }
});

test("both Tasks screens disable a row's own controls once it has moved", () => {
  const desktop = source(DESKTOP);
  // The switch, Edit, Delete and the ⌫ command — every path that writes.
  assert.match(desktop, /\.disabled\(model\.isMutating \|\| !model\.canEdit\(task\)\)/);
  assert.match(desktop, /let editable = model\.canEdit\(task\)/);
  assert.match(desktop, /model\.canEdit\(\$0\) \? \$0 : nil/);

  const mobile = source(MOBILE);
  assert.match(mobile, /editable: model\.canEdit\(task\)/);
  assert.match(mobile, /\.disabled\(busy \|\| !editable\)/);
  assert.match(mobile, /\.disabled\(!editable\)/);
});

test("neither screen still says the reason is Pro", () => {
  // The plan ceiling went with the surface: what a person may spend is their
  // usage window, not a count of schedules. "Tasks are part of Pro" would send
  // somebody to a purchase that changes nothing.
  assert.match(source(DESKTOP), /These moved to Automations/);
  assert.doesNotMatch(code(DESKTOP), /Tasks are part of Pro/);
  assert.match(source(MOBILE), /tasks\.moved\.title/);
  assert.doesNotMatch(code(MOBILE), /tasks\.locked/);
  const catalog = JSON.parse(source("native/iOS/JunoMobile/Resources/Localizable.xcstrings")) as {
    strings: Record<string, { localizations?: Record<string, unknown> }>;
  };
  for (const key of ["tasks.moved.title", "tasks.moved.detail", "tasks.status.moved"]) {
    const entry = catalog.strings[key];
    assert.ok(entry, `${key} is used by the view but missing from the catalog`);
    assert.deepEqual(Object.keys(entry.localizations ?? {}).sort(), ["en", "fr"], key);
  }
  assert.equal(catalog.strings["tasks.locked.title"], undefined);
  assert.equal(catalog.strings["tasks.locked.detail"], undefined);
});

// ---------------------------------------------------------------------------
// The model a picker chose is the model the runner is offered first
// ---------------------------------------------------------------------------

test("a canonical model id matches the catalog entry that spells it bare", () => {
  // The defect this closes: `CodeTask.model` holds `"provider:providerModel"`
  // — what `def()` builds and what every picker stores — while a
  // `BackendAgentModel` carries the bare provider id. `===` between them is
  // always false, so the chosen model was dropped and the runner took
  // first-available, silently, for the composer and the routine editor alike.
  const entry = { provider: "anthropic", model: "claude-sonnet-4-5" };
  assert.equal(catalogEntryMatchesModel(entry, "anthropic:claude-sonnet-4-5"), true);
  // The bare spelling still matches, so a caller holding either form works.
  assert.equal(catalogEntryMatchesModel(entry, "claude-sonnet-4-5"), true);
});

test("a model that is not this entry does not match it", () => {
  const entry = { provider: "anthropic", model: "claude-sonnet-4-5" };
  assert.equal(catalogEntryMatchesModel(entry, "openai:claude-sonnet-4-5"), false);
  assert.equal(catalogEntryMatchesModel(entry, "anthropic:something-else"), false);
  assert.equal(catalogEntryMatchesModel(entry, ""), false);
  assert.equal(catalogEntryMatchesModel(entry, null), false);
  assert.equal(catalogEntryMatchesModel(entry, undefined), false);
});

test("the runner-context route orders the catalog through the shared matcher", () => {
  // Reordering IS the choice — the runner picks the first available entry — so
  // a comparison that never matches is a picker that never takes effect.
  const route = source("src/app/api/code/tasks/[id]/runner-context/route.ts");
  assert.match(route, /catalogEntryMatchesModel\(entry, task\.model\)/);
  assert.doesNotMatch(route, /entry\.model === task\.model/);
});

// ---------------------------------------------------------------------------
// The fire URL meters the requests it refuses
// ---------------------------------------------------------------------------

test("the fire route throttles before it looks the routine up", () => {
  // The per-routine limit only ever ran on a request that had already
  // authenticated, so a caller presenting a wrong token was never throttled and
  // every attempt still cost a `workSchedule` read with two relations included
  // — on a URL that is public by design.
  const route = source("src/app/api/work/schedules/[id]/fire/route.ts");
  const attempt = route.indexOf("work-fire-attempt:");
  const lookup = route.indexOf("prismaUnguarded.workSchedule.findFirst");
  const perRoutine = route.indexOf("work-fire:");
  assert.ok(attempt > 0 && lookup > 0 && perRoutine > 0, "the fire route's shape moved");
  assert.ok(attempt < lookup, "the attempt limiter must run before the lookup");
  assert.ok(lookup < perRoutine, "the per-routine limiter still belongs after the token check");
  // Keyed by caller, because the routine id is the part an attacker varies.
  assert.match(route, /key: `work-fire-attempt:\$\{ipFromHeaders\(req\.headers\)\}`/);
});
