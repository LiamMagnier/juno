import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SKILL_NOT_EDITABLE,
  WORK_CONTEXT_CHANGES,
  WORK_CONTEXT_EFFECTS,
  WORK_CONTEXT_FIELDS,
  describeGrantChange,
  describeSettingChange,
  patchSessionContextSchema,
  patchSessionSchema,
  type WorkContextFieldResult,
} from "@/app/api/work/protocol";

/*
 * Editing a task's context after it exists, and the one promise that has to be
 * right.
 *
 * The route can be wrong in two directions and only one of them is visible. If
 * it refuses a change, the reader presses the button again. If it accepts a
 * change and reports that it took hold when it did not, the reader believes a
 * running task can no longer read a document it can still read — and there is
 * nothing on any surface that would tell them otherwise. So almost every case
 * below is about the sentence and the promise attached to a write, not about
 * the write.
 *
 * Nothing here opens a connection. The decisions live in `protocol.ts` for the
 * same reason the rest of that module does: a check that can only be exercised
 * against a live Postgres is a check that is exercised once, by hand, on the day
 * it is written. The two facts that genuinely live in the route — that it is
 * scoped to the owner, and that a replay is not an error — are asserted against
 * its source at the bottom.
 */

const ROUTE = new URL("../src/app/api/work/sessions/[id]/context/route.ts", import.meta.url);

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

test("patchSessionContextSchema refuses a save that changes nothing", () => {
  assert.equal(patchSessionContextSchema.safeParse({ connectorIds: [] }).success, true);
  assert.equal(patchSessionContextSchema.safeParse({}).success, false);
  // Unknown keys are stripped by zod before the refine sees them, so a client
  // that sends `{ files: [...] }` instead of `{ attachmentIds: [...] }` is told,
  // rather than getting a 200 and a task whose files were never touched.
  assert.equal(patchSessionContextSchema.safeParse({ files: ["a1"] }).success, false);
});

test("patchSessionContextSchema will not accept the goal, under any name", () => {
  // The goal is what every plan is validated against. A context edit that could
  // rewrite it would leave the attempt checked against a sentence nobody wrote —
  // and because unknown keys are stripped, sending it is a refusal rather than a
  // silent no-op.
  assert.equal(patchSessionContextSchema.safeParse({ goal: "Something else" }).success, false);
  assert.equal(patchSessionContextSchema.safeParse({ title: "Renamed" }).success, false);
  // Renaming still has a route; it is just not this one.
  assert.equal(patchSessionSchema.safeParse({ title: "Renamed" }).success, true);
});

test("patchSessionContextSchema keeps absent and empty apart", () => {
  // The whole set, never a delta. `[]` is a reader who switched every app off,
  // which is a real answer; absent is a client with nothing to say about apps,
  // which must leave the task as it was. A schema that defaulted one to the
  // other would have every save strip the connectors it did not mention.
  const emptied = patchSessionContextSchema.safeParse({ connectorIds: [] });
  assert.equal(emptied.success, true);
  assert.deepEqual(emptied.data?.connectorIds, []);

  const silent = patchSessionContextSchema.safeParse({ model: "anthropic:claude" });
  assert.equal(silent.success, true);
  assert.equal(silent.data?.connectorIds, undefined);
  assert.equal(silent.data?.attachmentIds, undefined);
});

test("patchSessionContextSchema takes null for the two fields that can be cleared", () => {
  // `null` and absent mean different things for both. Absent leaves the task
  // alone; null is the reader unfiling it, or turning extra thinking back off.
  assert.equal(patchSessionContextSchema.safeParse({ projectId: null }).success, true);
  assert.equal(patchSessionContextSchema.safeParse({ reasoningEffort: null }).success, true);
  assert.equal(patchSessionContextSchema.safeParse({ reasoningEffort: "medium" }).success, true);
  assert.equal(patchSessionContextSchema.safeParse({ reasoningEffort: "hard" }).success, false);
  assert.equal(patchSessionContextSchema.safeParse({ permissionPolicy: "yolo" }).success, false);
  // A model id is passed through unchecked against the catalog, exactly as the
  // create route does it: the executor may substitute, and a rolling deploy
  // legitimately sees ids this build does not carry. The plan gate is the
  // route's, not the schema's.
  assert.equal(patchSessionContextSchema.safeParse({ model: "some:model-v9" }).success, true);
  assert.equal(patchSessionContextSchema.safeParse({ model: "  " }).success, false);
});

// ---------------------------------------------------------------------------
// Narrowing applies now; widening does not
// ---------------------------------------------------------------------------

test("removing a file from a running task takes effect now", () => {
  const result = describeGrantChange({
    field: "files",
    removed: 1,
    added: 0,
    runInFlight: true,
  });
  assert.equal(result.change, "narrowed");
  assert.equal(result.effect, "now");
  // And the promise is qualified, because it has to be. The executor reads the
  // attached text once, into the run's opening context, before the first turn —
  // so a document pulled off a live task is gone for every later attempt and is
  // still in the transcript of the one that is going. A control that said only
  // "removed" would have the reader believe the opposite of that.
  assert.ok(result.inFlightCaveat, "a live attempt must carry the caveat");
  assert.match(result.inFlightCaveat ?? "", /already read/);
});

test("removing a file when nothing is running carries no caveat", () => {
  const result = describeGrantChange({ field: "files", removed: 2, added: 0, runInFlight: false });
  assert.equal(result.change, "narrowed");
  assert.equal(result.effect, "now");
  assert.equal(result.inFlightCaveat, undefined);
  assert.match(result.explanation, /2 files/);
});

test("removing an app takes effect now and names what the running attempt keeps", () => {
  const result = describeGrantChange({
    field: "connectors",
    removed: 1,
    added: 0,
    runInFlight: true,
  });
  assert.equal(result.change, "narrowed");
  assert.equal(result.effect, "now");
  // `openConnectors` opens one MCP connection per app when the run starts and
  // holds it for the whole run. The grant is withdrawn immediately and binds
  // everything after this attempt; the socket the attempt already opened is not
  // something this route can reach into and close.
  assert.match(result.inFlightCaveat ?? "", /keeps them until it finishes/);
});

test("answering the app question for the first time is itself a narrowing", () => {
  // A task nobody had asked carries `taskAllowed: null`, which means every app
  // the account has linked. So the first answer can only shrink what the task
  // reaches, however many apps it names — and switching every app off is the
  // sharpest version of that, which a plain 0/0 `unchanged` would report as
  // nothing having happened.
  const none = describeGrantChange({
    field: "connectors",
    removed: 0,
    added: 0,
    runInFlight: false,
    firstAnswer: true,
  });
  assert.equal(none.change, "narrowed");
  assert.equal(none.effect, "now");
  assert.match(none.explanation, /no longer reach any/);

  // And naming apps is still a narrowing, not a widening: they were reachable a
  // moment ago as part of "everything", so deferring them would defer a promise
  // that was already true.
  const some = describeGrantChange({
    field: "connectors",
    removed: 0,
    added: 2,
    runInFlight: true,
    firstAnswer: true,
  });
  assert.equal(some.change, "narrowed");
  assert.equal(some.effect, "now");
  assert.match(some.explanation, /only the 2 apps you picked/);
  assert.ok(some.inFlightCaveat);
});

test("adding anything defers to the next attempt, running or not", () => {
  for (const runInFlight of [true, false]) {
    const files = describeGrantChange({ field: "files", removed: 0, added: 1, runInFlight });
    assert.equal(files.change, "widened");
    assert.equal(files.effect, "next_attempt");
    // No caveat on a widening: nothing was taken away, so there is nothing a
    // running attempt could be keeping that the reader needs warning about.
    assert.equal(files.inFlightCaveat, undefined);

    const apps = describeGrantChange({ field: "connectors", removed: 0, added: 3, runInFlight });
    assert.equal(apps.change, "widened");
    assert.equal(apps.effect, "next_attempt");
  }
});

test("a swap reports the pessimistic half and says both things happened", () => {
  // The common edit: a reader takes one document off and puts another on. The
  // removal really has landed and the sentence says so, but the field as a whole
  // is not in force until the addition is — and a control shown `now` would put
  // a green tick over a task that cannot yet read the file just attached.
  const result = describeGrantChange({ field: "files", removed: 1, added: 1, runInFlight: true });
  assert.equal(result.change, "mixed");
  assert.equal(result.effect, "next_attempt");
  assert.match(result.explanation, /no longer part of this task/);
  assert.match(result.explanation, /next attempt/);
  assert.ok(result.inFlightCaveat);
});

test("the four settings that bind at dispatch never claim to apply sooner", () => {
  for (const field of ["model", "reasoningEffort", "permissionPolicy", "project"] as const) {
    const result = describeSettingChange({ field, changed: true });
    assert.equal(result.change, "replaced");
    // Unconditionally, including when nothing is running. These are read at
    // exactly one moment; reporting `now` because the timing happened to be
    // quiet would make the promise depend on the request rather than on what
    // the executor does. When no attempt is in flight, "the next attempt" is
    // the run the reader is about to start, which is the right sentence anyway.
    assert.equal(result.effect, "next_attempt");
    assert.match(result.explanation, /next attempt/);
  }
});

test("the approval mode says why it cannot narrow in flight", () => {
  // Not a hedge. Every approval a run asks for is digested over the policy blob
  // it started with, so changing that blob under a live run would refuse the
  // card already on somebody's screen with `policy_changed` — failing closed, on
  // a question nobody had changed the answer to.
  const result = describeSettingChange({ field: "permissionPolicy", changed: true });
  assert.match(result.explanation, /signed against the mode it started under/);
});

// ---------------------------------------------------------------------------
// A replay is not an error
// ---------------------------------------------------------------------------

test("re-sending the same context reports unchanged rather than failing", () => {
  // There is no idempotency key on this route and there should not be one: every
  // operation is a set assignment or a scalar assignment, so the second identical
  // save converges on the same state. What it must not do is 409, which would
  // present a task that is in exactly the state the reader asked for as a
  // failure — the same argument `classifyApprovalDecision` makes for its replay.
  const files = describeGrantChange({ field: "files", removed: 0, added: 0, runInFlight: true });
  assert.equal(files.change, "unchanged");
  assert.equal(files.effect, "none");
  assert.equal(files.inFlightCaveat, undefined);

  const apps = describeGrantChange({ field: "connectors", removed: 0, added: 0, runInFlight: false });
  assert.equal(apps.change, "unchanged");
  assert.equal(apps.effect, "none");

  for (const field of ["model", "reasoningEffort", "permissionPolicy", "project"] as const) {
    const result = describeSettingChange({ field, changed: false });
    assert.equal(result.change, "unchanged");
    assert.equal(result.effect, "none");
  }
});

test("the route does not answer a repeated save with a conflict", () => {
  const source = readFileSync(ROUTE, "utf8");
  assert.equal(/status:\s*409/.test(source), false, "a replay must not be a conflict");
});

// ---------------------------------------------------------------------------
// The skill, answered honestly
// ---------------------------------------------------------------------------

test("a skill change is refused in the result rather than in the status code", () => {
  assert.equal(SKILL_NOT_EDITABLE.field, "skill");
  assert.equal(SKILL_NOT_EDITABLE.change, "refused");
  assert.equal(SKILL_NOT_EDITABLE.effect, "none");
  // A refusal a client can read is a control it can disable with a sentence
  // beside it. A 400 on the whole request would also lose the model change a UI
  // saved in the same press, and would be indistinguishable from a client bug.
  assert.equal(patchSessionContextSchema.safeParse({ skillSlug: "tidy-downloads" }).success, true);
  assert.equal(patchSessionContextSchema.safeParse({ skillSlug: null }).success, true);
  assert.equal(patchSessionContextSchema.safeParse({ skillSlug: "" }).success, false);
  // The sentence has to say what to do instead, or it is a dead end.
  assert.match(SKILL_NOT_EDITABLE.explanation, /Start a new task/);
});

test("the route never claims to have stored a skill", () => {
  const source = readFileSync(ROUTE, "utf8");
  // `applySkill` resolves the skill from the goal and from nowhere else, so a
  // column written here would be a control that looks like a permission and
  // grants nothing. The route may read `skillSlug` off the body to answer about
  // it; it must not put it into an update.
  assert.equal(/skillSlug:\s*body\.skillSlug/.test(source), false);
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

test("an unowned session is refused before anything is written", () => {
  const source = readFileSync(ROUTE, "utf8");

  // The session is looked up scoped to the signed-in account and to rows that
  // are not soft-deleted, and a miss is a 404 — the same answer a session that
  // never existed gets, so this route cannot be used as an oracle for which ids
  // are real.
  assert.match(source, /workSession\.findFirst\(\{\s*where:\s*\{\s*id,\s*userId:\s*user\.id,\s*deletedAt:\s*null/);
  assert.match(source, /if \(!session\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/);

  // And the refusal comes before the writes. `reconcileSessionAttachments` and
  // `reconcileSessionConnectors` take a session id and trust it, deliberately —
  // the check belongs at the route, where the caller's identity exists — so a
  // lookup ordered after them would be a check made too late to matter.
  const guard = source.indexOf('{ error: "Not found" }');
  assert.ok(guard > 0);
  for (const write of ["reconcileSessionAttachments(", "reconcileSessionConnectors(", "workSession.update("]) {
    assert.ok(source.indexOf(write) > guard, `${write} must come after the ownership guard`);
  }
});

test("every query in the route is scoped to the signed-in account", () => {
  // The repo-wide scanner in work-security.test.ts already walks every route
  // under /api/work for this, so the useful thing to assert here is narrower and
  // harder to satisfy by accident: this route reads four other tables, and each
  // read is a claim in the body being checked against a row that carries the
  // user's id. An id accepted on trust would let a task be handed somebody
  // else's upload, or a project it does not belong to.
  const source = readFileSync(ROUTE, "utf8");
  for (const table of ["project.findFirst", "attachment.findMany", "connection.findMany", "workRun.findFirst"]) {
    const at = source.indexOf(table);
    assert.ok(at > 0, `${table} should be in this route`);
    const clause = source.slice(at, at + 400);
    assert.match(clause, /userId: user\.id/, `${table} must be scoped to the user`);
  }
});

// ---------------------------------------------------------------------------
// The vocabulary a client decodes
// ---------------------------------------------------------------------------

test("every result a client can receive uses a value the vocabulary names", () => {
  // The generated Swift clients decode these as closed enums, so a value outside
  // the published list does not degrade a badge — it fails the decode of the
  // whole response and the reader sees nothing at all.
  const results: WorkContextFieldResult[] = [
    SKILL_NOT_EDITABLE,
    describeGrantChange({ field: "files", removed: 1, added: 1, runInFlight: true }),
    describeGrantChange({ field: "connectors", removed: 0, added: 0, runInFlight: false }),
    describeSettingChange({ field: "model", changed: true }),
    describeSettingChange({ field: "project", changed: false }),
  ];
  for (const result of results) {
    assert.ok((WORK_CONTEXT_FIELDS as readonly string[]).includes(result.field));
    assert.ok((WORK_CONTEXT_CHANGES as readonly string[]).includes(result.change));
    assert.ok((WORK_CONTEXT_EFFECTS as readonly string[]).includes(result.effect));
    // A verdict with no sentence is a UI guessing, which is the thing this whole
    // shape exists to prevent.
    assert.ok(result.explanation.trim().length > 0);
  }
});

test("nothing but a narrowing may claim to be in force already", () => {
  // The invariant the route is built on, asserted over the whole space rather
  // than case by case: `now` appears only where a permission was taken away.
  for (const removed of [0, 1, 2]) {
    for (const added of [0, 1, 2]) {
      for (const field of ["files", "connectors"] as const) {
        for (const firstAnswer of [true, false]) {
          const result = describeGrantChange({ field, removed, added, runInFlight: true, firstAnswer });
          if (result.effect !== "now") continue;
          assert.equal(result.change, "narrowed");
          // Either rows were taken away and none added, or this is the first
          // answer — which replaces "everything the account has linked" with a
          // list, and is a narrowing whatever the counts say.
          assert.ok(firstAnswer || (removed > 0 && added === 0));
        }
      }
    }
  }
  for (const field of ["model", "reasoningEffort", "permissionPolicy", "project"] as const) {
    for (const changed of [true, false]) {
      assert.notEqual(describeSettingChange({ field, changed }).effect, "now");
    }
  }
});
