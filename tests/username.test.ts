import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import {
  checkUsername,
  displayHandle,
  normalizeUsername,
  RESERVED_USERNAMES,
  usernameSchema,
  USERNAME_MAX,
} from "../src/lib/username";
import { profileHandle } from "../src/lib/profile-activity";

/*
 * THE @USERNAME: its rules (src/lib/username.ts), the route that reads and
 * sets it (src/app/api/account/username/route.ts) and the profile's fallback
 * to an email-derived handle until one is chosen.
 */

test("valid names pass, normalised to the stored lowercase form", () => {
  for (const name of ["liam", "liam.magnier", "l1am_m-25", "abc", "9lives", "a".repeat(USERNAME_MAX)]) {
    const result = checkUsername(name);
    assert.deepEqual(result, { ok: true, username: name }, name);
  }
  assert.deepEqual(checkUsername("  @Liam.Magnier "), { ok: true, username: "liam.magnier" });
  assert.equal(normalizeUsername("@@Maren"), "maren");
});

test("each rule refuses with its own friendly reason", () => {
  const problem = (raw: string) => {
    const r = checkUsername(raw);
    return r.ok ? "ok" : r.problem;
  };
  assert.equal(problem("ab"), "too_short");
  assert.equal(problem(""), "too_short");
  assert.equal(problem("a".repeat(USERNAME_MAX + 1)), "too_long");
  assert.equal(problem("liam magnier"), "characters");
  assert.equal(problem("liam!"), "characters");
  assert.equal(problem("zoë"), "characters");
  assert.equal(problem("liam@home"), "characters");
  assert.equal(problem(".liam"), "start");
  assert.equal(problem("_liam"), "start");
  assert.equal(problem("-liam"), "start");
  assert.equal(problem("liam..m"), "dots");
  assert.equal(problem("liam."), "dots");
  assert.equal(problem("liam.m"), "ok");
  assert.equal(problem("liam__m"), "ok");
  const refused = checkUsername("ab");
  assert.ok(!refused.ok && /at least 3/.test(refused.message));
});

test("reserved names are refused, whatever the case", () => {
  for (const name of ["admin", "Alevr", "JUNO", "support", "help", "api", "settings", "profile", "root", "system", "owner", "null", "undefined", "@Settings"]) {
    const result = checkUsername(name);
    assert.ok(!result.ok && result.problem === "reserved", name);
    assert.ok(!result.ok && result.message === "That name is reserved.");
  }
});

test("every top-level route under src/app is reserved", () => {
  const app = path.join(process.cwd(), "src/app");
  const segments = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (!statSync(path.join(dir, entry)).isDirectory()) continue;
      // A route group "(app)" adds no segment: its children are top level.
      if (/^\(.+\)$/.test(entry)) walk(path.join(dir, entry));
      else segments.add(entry.toLowerCase());
    }
  };
  walk(app);
  const missing = [...segments].filter((s) => checkUsername(s).ok);
  assert.deepEqual(missing, [], `add these route names to RESERVED_USERNAMES: ${missing.join(", ")}`);
  assert.ok(RESERVED_USERNAMES.has("sign-in"));
});

test("the zod schema yields the normalised name or the rule's message", () => {
  assert.equal(usernameSchema.parse("@Liam"), "liam");
  const bad = usernameSchema.safeParse("liam..m");
  assert.equal(bad.success, false);
  assert.equal(bad.error?.issues[0]?.message, "Dots can’t sit next to each other or end the name.");
  assert.equal(usernameSchema.safeParse(42).success, false);
  assert.equal(usernameSchema.safeParse(null).success, false);
});

test("the profile shows the chosen username, else the email-derived handle", () => {
  assert.equal(displayHandle({ username: "liam", name: "Liam", email: "liam.magnier25@example.com" }), "liam");
  assert.equal(displayHandle({ username: null, name: "Liam", email: "liam.magnier25@example.com" }), "liam.magnier25");
  assert.equal(profileHandle({ name: "Liam", email: "Liam.Magnier+alevr@example.com" }), "liam.magnier");
  assert.equal(profileHandle({ username: "maren", name: "Liam", email: "liam@example.com" }), "maren");
  assert.equal(profileHandle({ username: null, name: null, email: null }), "you");
});

test("the migration stores usernames lowercased under a unique index", () => {
  const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261003120000_user_username/migration.sql"), "utf8");
  assert.match(sql, /ADD COLUMN "username" TEXT;/);
  assert.match(sql, /CHECK \("username" = lower\("username"\)\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "User_username_key" ON "User"\("username"\);/);
});

// ---------------------------------------------------------------------------
// The route. `mock.module` needs --experimental-test-module-mocks; `npm test`
// runs this directory without it, so these skip there rather than failing.
// ---------------------------------------------------------------------------

const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const routeTest = canMockModules ? test : test.skip;

type Row = { id: string; username: string | null; name: string | null; email: string };
let currentUser: { id: string } | null = { id: "u1" };
let rows: Row[] = [];
let limited = false;
let raceOnUpdate = false;
const rateKeys: string[] = [];
const updates: unknown[] = [];

function reset() {
  currentUser = { id: "u1" };
  rows = [
    { id: "u1", username: null, name: "Liam", email: "liam.magnier25@example.com" },
    { id: "u2", username: "maren", name: "Maren", email: "maren@example.com" },
  ];
  limited = false;
  raceOnUpdate = false;
  rateKeys.length = 0;
  updates.length = 0;
}

const prisma = {
  user: {
    findUnique: async ({ where }: { where: { id?: string; username?: string } }) => {
      const row = rows.find((r) => (where.id !== undefined ? r.id === where.id : r.username === where.username));
      return row ? { ...row } : null;
    },
    update: async (args: { where: { id: string }; data: { username: string } }) => {
      updates.push(args);
      // The unique index is the arbiter: a name taken between the check and
      // the write fails the way Postgres fails it.
      if (raceOnUpdate || rows.some((r) => r.username === args.data.username && r.id !== args.where.id)) {
        throw Object.assign(new Error("Unique constraint failed on the fields: (`username`)"), { code: "P2002" });
      }
      const row = rows.find((r) => r.id === args.where.id)!;
      row.username = args.data.username;
      return { id: row.id };
    },
  },
};

if (canMockModules) {
  mock.module("@/lib/prisma", { namedExports: { prisma } });
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => currentUser } });
  mock.module("@/lib/rate-limit", {
    namedExports: {
      rateLimit: async ({ key }: { key: string }) => {
        rateKeys.push(key);
        return { success: !limited, remaining: limited ? 0 : 5, resetAt: new Date() };
      },
    },
  });
}

const patch = (body: unknown) =>
  new Request("http://test/api/account/username", { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

routeTest("signed out: 401 on every verb, and nothing is read or written", async () => {
  reset();
  currentUser = null;
  const { GET, PATCH } = await import("@/app/api/account/username/route");
  assert.equal((await GET(new Request("http://test/api/account/username"))).status, 401);
  assert.equal((await GET(new Request("http://test/api/account/username?check=liam"))).status, 401);
  assert.equal((await PATCH(patch({ username: "liam" }))).status, 401);
  assert.equal(updates.length, 0);
  assert.equal(rateKeys.length, 0);
});

routeTest("GET reads the username, falling back to the derived handle", async () => {
  reset();
  const { GET } = await import("@/app/api/account/username/route");
  const res = await GET(new Request("http://test/api/account/username"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { username: null, handle: "liam.magnier25" });
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
});

routeTest("the availability check: available, taken (any case), invalid, reserved, your own", async () => {
  reset();
  rows[0].username = "liam";
  const { GET } = await import("@/app/api/account/username/route");
  const check = async (name: string) => (await GET(new Request(`http://test/api/account/username?check=${encodeURIComponent(name)}`))).json();
  assert.deepEqual(await check("@Lumen"), { username: "lumen", available: true });
  assert.deepEqual(await check("MAREN"), { username: "maren", available: false, problem: "taken", message: "That username is taken." });
  assert.equal((await check("ab")).problem, "too_short");
  assert.equal((await check("settings")).problem, "reserved");
  assert.deepEqual(await check("Liam"), { username: "liam", available: true });
  assert.ok(rateKeys.every((k) => k === "username-check:u1"));
});

routeTest("PATCH sets the lowercased name, rate-limited per account", async () => {
  reset();
  const { PATCH } = await import("@/app/api/account/username/route");
  const res = await PATCH(patch({ username: "@Lumen.Writes" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, username: "lumen.writes", handle: "lumen.writes" });
  assert.equal(rows[0].username, "lumen.writes");
  assert.deepEqual(updates[0], { where: { id: "u1" }, data: { username: "lumen.writes" }, select: { id: true } });
  assert.deepEqual(rateKeys, ["username-change:u1"]);
});

routeTest("PATCH refuses invalid and reserved names with the rule's copy", async () => {
  reset();
  const { PATCH } = await import("@/app/api/account/username/route");
  const invalid = await PATCH(patch({ username: "liam..m" }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: "Dots can’t sit next to each other or end the name.",
    problem: "dots",
    field: "username",
  });
  const reserved = await PATCH(patch({ username: "Admin" }));
  assert.equal(reserved.status, 400);
  assert.equal((await reserved.json()).problem, "reserved");
  assert.equal((await PATCH(patch({}))).status, 400);
  assert.equal(updates.length, 0);
  assert.equal(rateKeys.length, 0);
});

routeTest("a name someone has is 409 taken, case-insensitively, without spending a change", async () => {
  reset();
  const { PATCH } = await import("@/app/api/account/username/route");
  const res = await PATCH(patch({ username: "Maren" }));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "That username is taken.", problem: "taken", field: "username" });
  assert.equal(updates.length, 0);
  assert.equal(rateKeys.length, 0);
});

routeTest("losing a race at the unique index (P2002) is answered as taken", async () => {
  reset();
  raceOnUpdate = true;
  const { PATCH } = await import("@/app/api/account/username/route");
  const res = await PATCH(patch({ username: "lumen" }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).problem, "taken");
  assert.equal(rows[0].username, null);
});

routeTest("past the change limit: 429, and nothing is written", async () => {
  reset();
  limited = true;
  const { PATCH } = await import("@/app/api/account/username/route");
  const res = await PATCH(patch({ username: "lumen" }));
  assert.equal(res.status, 429);
  assert.equal(updates.length, 0);
});

routeTest("saving the name you already have is a no-op success", async () => {
  reset();
  rows[0].username = "liam";
  const { PATCH } = await import("@/app/api/account/username/route");
  const res = await PATCH(patch({ username: "LIAM" }));
  assert.equal(res.status, 200);
  assert.equal(updates.length, 0);
  assert.equal(rateKeys.length, 0);
});
