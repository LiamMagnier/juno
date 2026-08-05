import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OWNER_COLUMN, UNGUARDED_OWNED_MODELS } from "@/lib/db";

/*
 * Drift test for the Prisma ownership guard.
 *
 * The guard only protects models someone remembered to list. Eleven user-owned
 * models had been added over time without being added to it — not because
 * anyone decided they were safe, but because nothing forced the decision.
 *
 * This reads prisma/schema.prisma directly rather than the generated DMMF, so
 * it stays authoritative even if someone edits the schema without re-running
 * `prisma generate`. It touches no database and instantiates no client.
 */

const SCHEMA = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

/** Models in the schema, with the ownership column each declares (if any). */
function ownedModels(): Map<string, "userId" | "accountId"> {
  const owned = new Map<string, "userId" | "accountId">();
  for (const m of SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = m;
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      // Skip blanks, comments, and block attributes — `@@unique([userId, ...])`
      // and `@@index([userId])` are not field declarations and would otherwise
      // make a model look owned when it is not.
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const field = /^(\w+)\s+\S/.exec(line);
      if (!field) continue;
      if (field[1] === "userId") owned.set(name, "userId");
      else if (field[1] === "accountId" && !owned.has(name)) owned.set(name, "accountId");
    }
  }
  return owned;
}

test("the schema parse finds a plausible number of owned models", () => {
  // A sanity check on the regex itself: if this collapses to 0 the assertions
  // below would all pass vacuously.
  const owned = ownedModels();
  assert.ok(owned.size > 20, `expected many owned models, parsed ${owned.size}`);
  assert.equal(owned.get("Conversation"), "userId");
  assert.equal(owned.get("AccountChange"), "accountId");
});

test("every user-owned model is either guarded or explicitly waived", () => {
  const owned = ownedModels();
  // Auth-adapter models: NextAuth owns these rows and queries them by provider
  // identifiers before any session exists.
  const authAdapter = new Set(["Account", "Session"]);

  const undecided = [...owned.keys()].filter(
    (m) => !OWNER_COLUMN.has(m) && !UNGUARDED_OWNED_MODELS.has(m) && !authAdapter.has(m)
  );

  assert.deepEqual(
    undecided,
    [],
    `These models carry an ownership column but are neither guarded nor waived.\n` +
      `Add them to OWNER_COLUMN in src/lib/db.ts, or to UNGUARDED_OWNED_MODELS with a reason:\n  ` +
      undecided.join("\n  ")
  );
});

test("the guard names the column each model actually declares", () => {
  const owned = ownedModels();
  for (const [model, column] of OWNER_COLUMN) {
    const actual = owned.get(model);
    assert.ok(actual, `${model} is guarded but has no ownership column in the schema`);
    assert.equal(
      column,
      actual,
      `${model} is guarded on "${column}" but the schema declares "${actual}"`
    );
  }
});

test("a waived model is a real model that really is owned", () => {
  const owned = ownedModels();
  for (const model of UNGUARDED_OWNED_MODELS) {
    assert.ok(
      owned.has(model),
      `${model} is waived but is not a user-owned model — stale waiver, remove it`
    );
    assert.ok(
      !OWNER_COLUMN.has(model),
      `${model} is both guarded and waived; the waiver is dead and should be removed`
    );
  }
});

test("the sync tables are guarded on accountId, not userId", () => {
  // These three were unguardable before: the guard only ever looked for a
  // literal `userId` key, so a query on them could never satisfy it.
  for (const model of ["AccountChange", "EntityRevision", "MutationReceipt"]) {
    assert.equal(OWNER_COLUMN.get(model), "accountId", `${model} must be guarded on accountId`);
  }
});
