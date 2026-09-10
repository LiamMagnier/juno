import test from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_NOT_EDITABLE,
  describeGrantChange,
  describeSettingChange,
} from "@/app/api/work/protocol";
import { readWorkSessionContextUpdate } from "@/components/work/work-transport";

/*
 * The client half of `PATCH /api/work/sessions/[id]/context`.
 *
 * `tests/work-session-context.test.ts` proves the route writes the right
 * verdict for every field. This file proves the composer can READ it, which
 * was the half nobody had tested: the route answers in the reader's nouns
 * (`files`, `connectors`, `skill`, `project`) and states timing as `effect`,
 * while the transport recognised only its own request keys and never looked at
 * `effect`. The result was invisible in the browser — every verdict about apps,
 * files, the project or the skill was dropped and a fallback sentence printed
 * in its place, including the one case that mattered most, the caveat that a
 * live run keeps a file it has already read.
 *
 * So the body below is not hand-written. It is built from the same functions
 * the route calls, and fed through the same picker the composer uses.
 */

function response(applied: unknown[]): Record<string, unknown> {
  return {
    session: null,
    context: { connectorIds: ["gmail"], attachmentIds: ["a1"], skillSlug: "brief" },
    applied,
  };
}

test("every field the route can answer about survives the client's reader", () => {
  const update = readWorkSessionContextUpdate(
    response([
      describeGrantChange({ field: "files", removed: 1, added: 0, runInFlight: true }),
      describeGrantChange({ field: "connectors", removed: 0, added: 1, runInFlight: false }),
      describeSettingChange({ field: "model", changed: true }),
      describeSettingChange({ field: "reasoningEffort", changed: true }),
      describeSettingChange({ field: "permissionPolicy", changed: false }),
      describeSettingChange({ field: "project", changed: true }),
      SKILL_NOT_EDITABLE,
    ])
  );
  // Nothing dropped: a verdict the client cannot name is a note the composer
  // cannot print, and before this test four of the seven were being dropped.
  assert.deepEqual(
    update.changes.map((change) => change.field),
    [
      "attachmentIds",
      "connectorIds",
      "model",
      "reasoningEffort",
      "permissionPolicy",
      "projectId",
      "skillSlug",
    ]
  );
});

test("timing is read from the route's `effect`, and only a narrowing is `now`", () => {
  const revoked = describeGrantChange({ field: "files", removed: 1, added: 0, runInFlight: true });
  const granted = describeGrantChange({ field: "connectors", removed: 0, added: 1, runInFlight: true });
  const model = describeSettingChange({ field: "model", changed: true });
  const same = describeSettingChange({ field: "project", changed: false });
  const [files, apps, modelChange, project] = readWorkSessionContextUpdate(
    response([revoked, granted, model, same])
  ).changes;

  assert.equal(revoked.effect, "now");
  assert.equal(files.timing, "now");
  assert.equal(granted.effect, "next_attempt");
  assert.equal(apps.timing, "next_attempt");
  assert.equal(modelChange.timing, "next_attempt");
  // `none` is the server's word and is kept as such rather than folded into
  // `unstated`: one means "nothing to land", the other "did not say".
  assert.equal(same.effect, "none");
  assert.equal(project.timing, "none");
});

test("the in-flight caveat and the explanation reach the composer verbatim", () => {
  const revoked = describeGrantChange({ field: "connectors", removed: 1, added: 0, runInFlight: true });
  assert.ok(revoked.inFlightCaveat, "the fixture must carry a caveat for this test to mean anything");
  const [apps] = readWorkSessionContextUpdate(response([revoked])).changes;
  assert.equal(apps.explanation, revoked.explanation);
  assert.equal(apps.inFlightCaveat, revoked.inFlightCaveat);
  assert.equal(apps.refused, false);

  // No caveat when nothing is running: the client must not invent one.
  const idle = describeGrantChange({ field: "connectors", removed: 1, added: 0, runInFlight: false });
  const [idleApps] = readWorkSessionContextUpdate(response([idle])).changes;
  assert.equal(idleApps.inFlightCaveat, null);
});

test("a refused skill change is flagged so the optimistic value can be rolled back", () => {
  const [skill] = readWorkSessionContextUpdate(response([SKILL_NOT_EDITABLE])).changes;
  assert.equal(skill.field, "skillSlug");
  assert.equal(skill.refused, true);
  assert.equal(skill.timing, "none");
  assert.equal(skill.explanation, SKILL_NOT_EDITABLE.explanation);
});

test("the context values come through under the request keys", () => {
  const update = readWorkSessionContextUpdate(response([]));
  assert.deepEqual(update.context.connectorIds, ["gmail"]);
  assert.deepEqual(update.context.attachmentIds, ["a1"]);
  assert.equal(update.context.skillSlug, "brief");
  assert.equal(update.session, null);
});

test("an unknown field or a malformed entry is dropped, never thrown", () => {
  const update = readWorkSessionContextUpdate(
    response([{ field: "budget", change: "replaced", effect: "now", explanation: "x" }, null, 3, "s"])
  );
  assert.deepEqual(update.changes, []);
  assert.deepEqual(readWorkSessionContextUpdate({}).changes, []);
});
