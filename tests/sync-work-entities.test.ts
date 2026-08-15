import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serializeGrantForRemote } from "@/lib/work/serializers";
import { serializeSchedule } from "@/lib/work/schedule";

/*
 * Juno Work on the sync contract.
 *
 * Work was the one product reachable only by polling. Everything else moves
 * through cursors, revisions and tombstones; sixteen `Work*` models had neither
 * an entity loader nor a change-capture trigger, so a task could not arrive at a
 * second device through /api/v1/changes at all.
 *
 * The pieces that close that gap live in three files that must agree and are
 * edited independently — the loaders in src/lib/sync-entities.ts, the trigger
 * function's resolution modes, and the triggers themselves. This file is where
 * a disagreement between them fails, because none of the three can detect it
 * alone: a trigger with no loader emits a change nothing can resolve, a loader
 * with no trigger is the state Work was already in, and a mode that reads a
 * column the table does not have fails at runtime inside a DELETE, which is the
 * worst place to find out.
 *
 * Everything here is read from source. `sync-entities.ts` imports `server-only`
 * and Prisma and cannot be loaded by this suite, and that is fine: the
 * invariants worth guarding are structural, and the two payload rules that are
 * not — no filesystem path on a synced grant, no embedded triggers on a synced
 * schedule — are checked against the real serializers.
 */

/**
 * Comments stripped, because this file greps for names that must not be shipped
 * and the loader file explains at length why it does not ship them. Grepping the
 * prose would make a correct explanation indistinguishable from a leak.
 */
function code(source: string): string {
  // Line comments first. A `//` comment that mentions a route glob — the loader
  // file has `/api/work/*` in one — carries a `/*` that a block-comment pass run
  // first will happily treat as an opening delimiter and swallow the rest of the
  // file up to the next `*/`, which silently empties every assertion below.
  return source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const LOADERS = code(readFileSync("src/lib/sync-entities.ts", "utf8"));
const SCHEMA = readFileSync("prisma/schema.prisma", "utf8");
const TRIGGER_MIGRATION = readFileSync(
  "prisma/migrations-pending/20260815141000_work_change_capture_triggers/migration.sql",
  "utf8"
);
const FUNCTION_MIGRATION = readFileSync(
  "prisma/migrations/20260815140000_work_change_capture_functions/migration.sql",
  "utf8"
);

/** The loader keys, read off the object literal rather than imported. */
function loaderKeys(): string[] {
  return [...LOADERS.matchAll(/^  ([a-z_]+): async \(accountId, ids\) => \{$/gm)].map(
    (match) => match[1]
  );
}

/** Every `CREATE TRIGGER … juno_record_account_change('<type>', '<mode>')`. */
function capturedEntities(sql: string): Array<{ table: string; type: string; mode: string }> {
  return [
    ...sql.matchAll(
      /ON "(\w+)" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change\('([a-z_]+)', '([a-z_]+)'\)/g
    ),
  ].map((match) => ({ table: match[1], type: match[2], mode: match[3] }));
}

/** The columns a Prisma model declares, so a mode can be checked against one. */
function modelFields(model: string): Set<string> {
  const body = SCHEMA.match(new RegExp(`^model ${model} \\{$([\\s\\S]*?)^\\}$`, "m"));
  assert.ok(body, `prisma/schema.prisma has no model ${model}`);
  return new Set(
    [...body[1].matchAll(/^\s{2}(\w+)\s+\S/gm)].map((match) => match[1])
  );
}

/** Which column each resolution mode reads off the row it fired for. */
const MODE_PARENT_COLUMN: Record<string, string | null> = {
  direct: null,
  work_session: "sessionId",
  work_run: "runId",
  work_schedule: "scheduleId",
  work_artifact: "artifactId",
  work_skill: "skillId",
};

/** Modes whose owner comes from the row itself rather than from a head row. */
const OWNER_ON_ROW = new Set(["direct", "work_session", "work_run", "work_schedule"]);

const WORK_ENTITY_TYPES = [
  "work_session",
  "work_run",
  "work_approval",
  "work_artifact",
  "work_artifact_version",
  "work_host",
  "work_file_grant",
  "work_session_connector",
  "work_skill",
  "work_skill_version",
  "work_schedule",
  "work_trigger",
];

test("every Work loader has a change-capture trigger, and every trigger a loader", () => {
  const loaded = loaderKeys().filter((key) => key.startsWith("work_"));
  const captured = capturedEntities(TRIGGER_MIGRATION).map((entry) => entry.type);

  assert.deepEqual([...loaded].sort(), [...WORK_ENTITY_TYPES].sort());
  assert.deepEqual([...captured].sort(), [...WORK_ENTITY_TYPES].sort());
});

test("the models left off the sync contract stay off it, on purpose", () => {
  // WorkEvent has its own SSE transport with a per-run seq cursor; WorkCommand
  // is leased relay control plane where a replay is an action taken twice;
  // WorkRunIO is provenance nothing reads on its own; WorkAuditEvent is the
  // security log and outlives the session it describes. Adding one of these is
  // a decision, not a tidy-up, so it has to break this test first.
  const captured = new Set(capturedEntities(TRIGGER_MIGRATION).map((entry) => entry.table));
  for (const model of ["WorkEvent", "WorkCommand", "WorkRunIO", "WorkAuditEvent"]) {
    assert.ok(!captured.has(model), `${model} was given change capture without a decision`);
  }
});

test("every resolution mode a Work trigger names is implemented by the function migration", () => {
  for (const { type, mode } of capturedEntities(TRIGGER_MIGRATION)) {
    assert.ok(
      mode in MODE_PARENT_COLUMN,
      `${type} uses resolution mode "${mode}", which this test does not know about`
    );
    if (mode === "direct") continue;
    assert.match(
      FUNCTION_MIGRATION,
      new RegExp(`TG_ARGV\\[1\\] = '${mode}'`),
      `resolution mode "${mode}" is used by a trigger but never defined`
    );
  }
});

test("each Work trigger's resolution mode reads a column its table actually has", () => {
  // The failure this prevents is silent until a delete: plpgsql resolves
  // `row_data."sessionId"` at execution time, so a mode pointed at the wrong
  // table raises inside a cascade, which is where nobody is watching.
  for (const { table, type, mode } of capturedEntities(TRIGGER_MIGRATION)) {
    const fields = modelFields(table);
    const parent = MODE_PARENT_COLUMN[mode];
    if (parent !== null) {
      assert.ok(fields.has(parent), `${type}: ${table} has no "${parent}" for mode "${mode}"`);
    }
    if (OWNER_ON_ROW.has(mode)) {
      assert.ok(fields.has("userId"), `${type}: ${table} has no "userId" for mode "${mode}"`);
    } else {
      assert.ok(
        !fields.has("userId"),
        `${type}: ${table} has its own "userId", so the cheaper mode would do`
      );
    }
  }
});

test("Work loaders scope every query to the authenticated account", () => {
  // Ownership is enforced in the query, never checked after the fact: an id
  // belonging to another account has to fail to resolve, not resolve and then be
  // filtered. The two version tables have no owner column and must reach it
  // through their head row.
  const blocks = [...LOADERS.matchAll(/^  (work_[a-z_]+): async \(accountId, ids\) => \{([\s\S]*?)^  \},$/gm)];
  assert.equal(blocks.length, WORK_ENTITY_TYPES.length);
  for (const [, name, body] of blocks) {
    assert.match(body, /where: \{ id: \{ in: ids \}/, `${name} does not filter by the requested ids`);
    if (name === "work_artifact_version") {
      assert.match(body, /artifact: \{ userId: accountId \}/);
    } else if (name === "work_skill_version") {
      assert.match(body, /skill: \{ userId: accountId \}/);
    } else {
      assert.match(body, /userId: accountId/, `${name} is not scoped to the account`);
    }
  }
});

test("a synced file grant carries no filesystem path", () => {
  // The loader ships `serializeGrantForRemote` plus two columns of its own. A
  // synced entity is on every signed-in device by definition, so this is the one
  // loader where reaching for the unqualified `serializeGrant` — which is bound
  // to the safe half — would still be the wrong instinct to rely on.
  const payload = {
    ...serializeGrantForRemote({
      id: "grant_1",
      userId: "user_1",
      sessionId: "sess_1",
      hostId: "host_1",
      kind: "local_folder",
      displayName: "Downloads",
      localPath: "/Users/liam/Downloads",
      remoteRef: null,
      accessMode: "read_write",
      resolvedRealPath: "/Users/liam/Downloads",
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    }),
    sessionId: "sess_1",
    createdAt: new Date("2026-08-01T10:00:00.000Z").toISOString(),
  };

  assert.ok(!JSON.stringify(payload).includes("/Users/"));
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["accessMode", "createdAt", "displayName", "hostId", "id", "kind", "lastUsedAt", "revokedAt", "sessionId"]
  );

  assert.match(LOADERS, /serializeGrantForRemote\(row\)/);
  assert.ok(!LOADERS.includes("serializeGrantForHost"));
});

test("a synced schedule normalises its triggers into their own entity", () => {
  // Embedding them would leave a trigger edit with nothing to bump: it would
  // either have to raise the schedule's revision from another table's trigger,
  // which resurrects a schedule tombstoned in the same cascade, or change
  // nothing and never reach the device.
  const row = {
    id: "sched_1",
    userId: "user_1",
    sessionId: "sess_1",
    name: "Monday digest",
    enabled: true,
    instructions: "Summarise the week",
    instructionsVersion: 1,
    target: "cloud",
    hostId: null,
    timezone: "Europe/London",
    runConfig: {},
    runConfigVersion: 1,
    maxCostMicroUsd: 0,
    maxTokens: 0,
    maxRuntimeMs: 0,
    unattendedPolicy: "pause_for_approval",
    hostOfflinePolicy: "skip",
    maxConcurrentRuns: 1,
    notifyPolicy: "on_attention",
    missedRunPolicy: "run_once",
    retryPolicy: {},
    lastRunAt: null,
    nextRunAt: new Date("2026-08-17T08:00:00.000Z"),
    lockedUntil: new Date("2026-08-17T08:00:00.000Z"),
    legacyScheduledTaskId: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-02T10:00:00.000Z"),
  };

  const { triggers, ...schedule } = serializeSchedule(row, []);
  assert.deepEqual(triggers, []);
  assert.ok(!("triggers" in schedule));
  assert.ok(!("lockedUntil" in schedule));
  assert.equal(schedule.nextRunAt, "2026-08-17T08:00:00.000Z");
});

test("synced Work payloads withhold what their REST shapes already withhold", () => {
  const block = (name: string) => {
    const match = LOADERS.match(
      new RegExp(`^  ${name}: async \\(accountId, ids\\) => \\{([\\s\\S]*?)^  \\},$`, "m")
    );
    assert.ok(match, `no ${name} loader`);
    return match[1];
  };

  // An object-storage address. The only sanctioned route to the bytes re-checks
  // contentHash before serving them, and a key on the wire routes around that.
  assert.ok(!block("work_artifact_version").includes("storageKey"));

  // A producer's handle on somebody's specific email or calendar entry. Shipping
  // either tells every device which message a trigger last matched.
  for (const withheld of ["lastEventKey", "cursor:", "lastPollError"]) {
    assert.ok(!block("work_trigger").includes(withheld), `work_trigger leaks ${withheld}`);
  }
});

test("no entity type is half-rolled-out across the two client allowlists", () => {
  /*
   * `requireEntityType` throws on a string it does not know, and that aborts the
   * whole page rather than skipping a row — an unknown type does not degrade, it
   * stops that account syncing on that device for everything. So the two clients
   * must never disagree: a type in one list and not the other means one platform
   * is already receiving something the other will choke on.
   *
   * This is also the gate on the Work rollout. The trigger migration is
   * deliberately not applied and its header says why: unlike project_workspace,
   * whose table was empty when its string shipped, every Work table already has
   * rows, so the first Work write after that migration lands reaches clients
   * that have never heard of `work_session`.
   */
  const swift = readFileSync(
    "native/Packages/JunoNativeKit/Sources/JunoSync/NativeSyncAPIClient.swift",
    "utf8"
  );
  const electron = readFileSync("native/desktop-electron/src/main/sync/types.ts", "utf8");

  const swiftList = swift.match(/entityTypes: Set<String> = \[([\s\S]*?)\]/);
  assert.ok(swiftList, "NativeSyncAPIClient no longer declares entityTypes as a set literal");
  const swiftTypes = new Set([...swiftList[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));

  const electronList = electron.match(/SYNC_ENTITY_TYPES = \[([\s\S]*?)\] as const;/);
  assert.ok(electronList, "the Electron sync types list is no longer a plain array literal");
  const electronTypes = new Set([...electronList[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

  const disagreements = [...new Set([...swiftTypes, ...electronTypes])].filter(
    (type) => swiftTypes.has(type) !== electronTypes.has(type)
  );
  assert.deepEqual(
    disagreements.sort(),
    // Empty, and it must stay empty.
    //
    // `project_workspace` used to be the documented exception — added to the
    // Swift client ahead of its writer, against an empty table, so the string
    // would already be in the field. The Electron client simply never got it,
    // and encoding that here turned a one-sided omission into an expected
    // value. It is now in both, so the exception is gone and the honest
    // assertion is that the two clients agree exactly.
    //
    // A deliberate ahead-of-writer addition is still allowed; it just has to go
    // into BOTH lists, which is the whole point of this test.
    [],
    "an entity type reached one client and not the other"
  );
});
