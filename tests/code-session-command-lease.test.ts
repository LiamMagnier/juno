import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ACKNOWLEDGEABLE_COMMAND,
  COMMAND_CLAIM_LEASE_MS,
  COMMAND_LEASE_EXHAUSTED_ERROR,
  COMMAND_MAX_CLAIMS,
  COMMAND_REQUEUE_WINDOW_MS,
  commandLeaseDisposition,
  sweepExpiredCommandClaims,
  type CommandLeaseStore,
} from "../src/lib/code-session-command-lease";

/*
 * THE CLAIM LEASE ON CODE SESSION COMMANDS.
 *
 * A command a Mac claimed and never acknowledged used to stay `claimed`
 * forever. These pin the replacement: an expired claim goes back to `pending`
 * a bounded number of times and is then failed with a reason, and a claim that
 * ran out long ago is failed rather than handed an old prompt to a Mac that
 * has just woken.
 */

const now = new Date("2026-09-22T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

test("a claim inside its lease is left alone", () => {
  assert.equal(
    commandLeaseDisposition({ status: "claimed", claimedAt: ago(COMMAND_CLAIM_LEASE_MS - 1_000), attempts: 1 }, now),
    "keep",
  );
});

test("an expired claim with claims left goes back to pending", () => {
  assert.equal(
    commandLeaseDisposition({ status: "claimed", claimedAt: ago(COMMAND_CLAIM_LEASE_MS + 1_000), attempts: 1 }, now),
    "requeue",
  );
});

test("an expired claim out of claims is failed, so retries are bounded", () => {
  assert.equal(
    commandLeaseDisposition(
      { status: "claimed", claimedAt: ago(COMMAND_CLAIM_LEASE_MS + 1_000), attempts: COMMAND_MAX_CLAIMS },
      now,
    ),
    "fail",
  );
});

test("a claim that ran out long ago is failed, not replayed at a waking Mac", () => {
  assert.equal(
    commandLeaseDisposition({ status: "claimed", claimedAt: ago(COMMAND_REQUEUE_WINDOW_MS + 1_000), attempts: 1 }, now),
    "fail",
  );
  // Rows stuck before the lease existed start at zero claims; they are old,
  // so they fail with a reason rather than firing now.
  assert.equal(
    commandLeaseDisposition({ status: "claimed", claimedAt: ago(7 * 24 * 60 * 60_000), attempts: 0 }, now),
    "fail",
  );
});

test("pending and settled commands are never touched by the lease", () => {
  for (const status of ["pending", "completed", "failed"]) {
    assert.equal(commandLeaseDisposition({ status, claimedAt: ago(COMMAND_REQUEUE_WINDOW_MS * 2), attempts: 9 }, now), "keep");
  }
});

/** A store that applies the sweep's `where` to rows the way Postgres would. */
function fakeStore(rows: Array<{ id: string; userId: string; deviceId: string; status: string; claimedAt: Date | null; attempts: number; error?: string }>) {
  const matches = (row: (typeof rows)[number], where: Record<string, unknown>): boolean => {
    for (const [key, condition] of Object.entries(where)) {
      if (key === "OR") {
        if (!(condition as Record<string, unknown>[]).some((branch) => matches(row, branch))) return false;
        continue;
      }
      const value = (row as Record<string, unknown>)[key];
      if (condition === null) {
        if (value !== null) return false;
      } else if (typeof condition === "object" && !(condition instanceof Date)) {
        const bounds = condition as { lt?: Date | number; gte?: Date | number; gt?: number };
        const numeric = value instanceof Date ? value.getTime() : (value as number | null);
        if (numeric === null || numeric === undefined) return false;
        const at = (bound: Date | number) => (bound instanceof Date ? bound.getTime() : bound);
        if (bounds.lt !== undefined && !(numeric < at(bounds.lt))) return false;
        if (bounds.gte !== undefined && !(numeric >= at(bounds.gte))) return false;
        if (bounds.gt !== undefined && !(numeric > bounds.gt)) return false;
      } else if (value !== condition) {
        return false;
      }
    }
    return true;
  };
  const store: CommandLeaseStore = {
    codeSessionCommand: {
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of rows) {
          if (!matches(row, where as unknown as Record<string, unknown>)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
    },
  };
  return { rows, store, matches };
}

test("the sweep settles each claim exactly as the disposition says, for one device only", async () => {
  const { rows, store } = fakeStore([
    { id: "fresh", userId: "u", deviceId: "mac", status: "claimed", claimedAt: ago(10_000), attempts: 1 },
    { id: "requeue", userId: "u", deviceId: "mac", status: "claimed", claimedAt: ago(COMMAND_CLAIM_LEASE_MS + 5_000), attempts: 1 },
    { id: "exhausted", userId: "u", deviceId: "mac", status: "claimed", claimedAt: ago(COMMAND_CLAIM_LEASE_MS + 5_000), attempts: COMMAND_MAX_CLAIMS },
    { id: "ancient", userId: "u", deviceId: "mac", status: "claimed", claimedAt: ago(COMMAND_REQUEUE_WINDOW_MS + 5_000), attempts: 0 },
    { id: "other-mac", userId: "u", deviceId: "other", status: "claimed", claimedAt: ago(COMMAND_CLAIM_LEASE_MS + 5_000), attempts: 1 },
    { id: "other-user", userId: "v", deviceId: "mac", status: "claimed", claimedAt: ago(COMMAND_CLAIM_LEASE_MS + 5_000), attempts: 1 },
  ]);
  const expected = new Map(rows.map((row) => [row.id, commandLeaseDisposition(row, now)]));

  const result = await sweepExpiredCommandClaims(store, { userId: "u", deviceId: "mac" }, now);

  assert.deepEqual(result, { requeued: 1, failed: 2 });
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("fresh")?.status, "claimed");
  assert.equal(byId.get("requeue")?.status, "pending");
  assert.equal(byId.get("requeue")?.claimedAt, null);
  assert.equal(byId.get("exhausted")?.status, "failed");
  assert.equal(byId.get("exhausted")?.error, COMMAND_LEASE_EXHAUSTED_ERROR);
  assert.equal(byId.get("ancient")?.status, "failed");
  assert.equal(byId.get("other-mac")?.status, "claimed", "another device's claims are its own poll's business");
  assert.equal(byId.get("other-user")?.status, "claimed", "never another account's rows");
  for (const id of ["fresh", "requeue", "exhausted", "ancient"]) {
    const outcome = { keep: "claimed", requeue: "pending", fail: "failed" }[expected.get(id)!];
    assert.equal(byId.get(id)?.status, outcome, `${id} follows commandLeaseDisposition`);
  }
});

test("a late acknowledgement settles a command the lease already re-queued", () => {
  const { matches } = fakeStore([]);
  const requeued = { id: "c", userId: "u", deviceId: "mac", status: "pending", claimedAt: null, attempts: 1 };
  const neverClaimed = { id: "d", userId: "u", deviceId: "mac", status: "pending", claimedAt: null, attempts: 0 };
  const done = { id: "e", userId: "u", deviceId: "mac", status: "completed", claimedAt: null, attempts: 1 };
  const where = ACKNOWLEDGEABLE_COMMAND as unknown as Record<string, unknown>;
  assert.equal(matches(requeued, where), true);
  assert.equal(matches(neverClaimed, where), false, "a command no host ever took cannot be acknowledged");
  assert.equal(matches(done, where), false, "a settled command stays settled");
});

const route = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/code/devices/[deviceId]/commands/route.ts"),
  "utf8",
);

test("the claim route sweeps before it claims and counts every claim", () => {
  const sweep = route.indexOf("sweepExpiredCommandClaims(prisma");
  const claim = route.indexOf('status: "claimed", claimedAt: new Date(), attempts: { increment: 1 }');
  assert.notEqual(sweep, -1, "the long poll must settle expired claims");
  assert.notEqual(claim, -1, "a claim must count toward the bound");
  assert.ok(sweep < claim, "expired claims are settled before new work is looked for");
  assert.match(route, /\.\.\.ACKNOWLEDGEABLE_COMMAND/);
});
