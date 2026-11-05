import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";

import { HOOKS_MAX_BYTES, hashHooksBytes, parseHooksConfig, summarizeHooks, trustedHookHashesFor } from "@/lib/code-hook-trust";

const require = createRequire(import.meta.url);
// agent-core's own parser and reader: the server must accept and hash exactly
// what a run accepts and hashes (dist is built by `npm run test:prepare`).
const core = require("../runner/agent-core/dist/hooks.js") as {
  parseProjectHooks(raw: string): unknown;
  readProjectHooks(cwd: string): { hash: string } | null;
};

const VALID = `{
  "version": 1,
  "hooks": {
    "PreToolUse": [{ "matcher": ["write_file", "edit_file"], "command": "npm run check-policy", "timeoutMs": 10000 }],
    "Stop": [{ "command": "npm run verify" }]
  }
}
`;

const FIXTURES: string[] = [
  VALID,
  `{"version":1,"hooks":{}}`,
  `{"version":1,"hooks":{"PostToolUse":[{"matcher":["*"],"command":"npm run lint","timeoutMs":60000}]}}`,
  `{"version":2,"hooks":{}}`,
  `{"version":1}`,
  `{"version":1,"hooks":[]}`,
  `{"version":1,"hooks":{},"extra":true}`,
  `{"version":1,"hooks":{"PreTool":[]}}`,
  `{"version":1,"hooks":{"Stop":{}}}`,
  `{"version":1,"hooks":{"Stop":[{"command":""}]}}`,
  `{"version":1,"hooks":{"Stop":[{"command":"   "}]}}`,
  `{"version":1,"hooks":{"Stop":[{"command":"x","shell":"zsh"}]}}`,
  `{"version":1,"hooks":{"Stop":[{"command":"x","timeoutMs":50}]}}`,
  `{"version":1,"hooks":{"Stop":[{"command":"x","timeoutMs":60001}]}}`,
  `{"version":1,"hooks":{"Stop":[{"command":"x","timeoutMs":1.5}]}}`,
  `{"version":1,"hooks":{"PreToolUse":[{"command":"x","matcher":["bad name"]}]}}`,
  `{"version":1,"hooks":{"PreToolUse":[{"command":"x","matcher":"write_file"}]}}`,
  `{"version":1,"hooks":{"Stop":[${Array.from({ length: 13 }, () => `{"command":"x"}`).join(",")}]}}`,
  `{"version":1,"hooks":{"Stop":[{"command":"${"x".repeat(4097)}"}]}}`,
  `not json`,
  `[]`,
  `null`,
];

test("the server accepts exactly the hook files agent-core accepts", () => {
  for (const raw of FIXTURES) {
    let coreOk = true;
    try {
      core.parseProjectHooks(raw);
    } catch {
      coreOk = false;
    }
    const ours = parseHooksConfig(raw);
    assert.equal(ours.ok, coreOk, `disagreement on ${raw.slice(0, 80)}`);
    if (!ours.ok) assert.ok(ours.message.length > 0);
  }
});

test("the hash is the hash a run computes over its clone's file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-trust-"));
  try {
    fs.mkdirSync(path.join(dir, ".alevr"));
    // CRLF and a trailing newline are bytes too: the hash covers them.
    const bytes = Buffer.from(VALID.replace(/\n/g, "\r\n"), "utf8");
    fs.writeFileSync(path.join(dir, ".alevr", "hooks.json"), bytes);
    assert.equal(hashHooksBytes(bytes), core.readProjectHooks(dir)?.hash);
    assert.notEqual(hashHooksBytes(Buffer.from(VALID)), hashHooksBytes(bytes));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the summary lists commands in run order with their defaults", () => {
  const parsed = parseHooksConfig(VALID);
  assert.ok(parsed.ok);
  assert.deepEqual(summarizeHooks(parsed.config), [
    { event: "PreToolUse", command: "npm run check-policy", matcher: ["write_file", "edit_file"], timeoutMs: 10000 },
    { event: "Stop", command: "npm run verify", matcher: null, timeoutMs: 10000 },
  ]);
});

test("runner hashes are scoped to the owner and the lower-cased repository, and malformed rows are dropped", async () => {
  let seen: unknown;
  const db = {
    codeHookTrust: {
      findMany: async (args: unknown) => {
        seen = args;
        return [{ configHash: "a".repeat(64) }, { configHash: "not-a-hash" }];
      },
    },
  };
  assert.deepEqual(await trustedHookHashesFor(db, "owner", "LiamMagnier", "Juno"), ["a".repeat(64)]);
  assert.deepEqual((seen as { where: unknown }).where, { userId: "owner", repoOwner: "liammagnier", repoName: "juno" });
});

// ─── The route, against a stub GitHub and an in-memory table ────────────────

type Row = { id: string; userId: string; repoOwner: string; repoName: string; configHash: string; config: string; ref: string | null; createdAt: Date };
let rows: Row[] = [];
let currentUser: { id: string } | null = { id: "owner" };
let fileBytes: Buffer | null = Buffer.from(VALID);
let nextId = 1;
const pick = (r: Row) => ({ id: r.id, repoOwner: r.repoOwner, repoName: r.repoName, configHash: r.configHash, config: r.config, ref: r.ref, createdAt: r.createdAt });
const matches = (r: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) =>
    k === "id" && v && typeof v === "object" && "in" in (v as object) ? (v as { in: string[] }).in.includes(r.id) : (r as Record<string, unknown>)[k] === v,
  );
const table = {
  findMany: async (args: { where: Record<string, unknown>; skip?: number; take?: number }) => {
    const list = rows.filter((r) => matches(r, args.where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return list.slice(args.skip ?? 0, args.take ? (args.skip ?? 0) + args.take : undefined).map(pick);
  },
  upsert: async (args: { where: { userId_repoOwner_repoName_configHash: Record<string, string> }; create: Omit<Row, "id" | "createdAt"> }) => {
    const key = args.where.userId_repoOwner_repoName_configHash;
    const existing = rows.find((r) => matches(r, key));
    if (existing) return pick(existing);
    const row = { ...args.create, id: `t${nextId++}`, createdAt: new Date(Date.now() + nextId) };
    rows.push(row);
    return pick(row);
  },
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    const before = rows.length;
    rows = rows.filter((r) => !matches(r, args.where));
    return { count: before - rows.length };
  },
};
const prisma = {
  codeHookTrust: table,
  connection: { findFirst: async () => ({ accessToken: "sealed" }) },
  $transaction: async (fn: (tx: unknown) => unknown) => fn({ codeHookTrust: table }),
};

const modules = Module as unknown as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const original = modules._load;
modules._load = function (name, parent, isMain) {
  if (name === "server-only") return {};
  if (name === "@/lib/prisma") return { prisma };
  if (name === "@/lib/session") return { getCurrentUser: async () => currentUser };
  if (name === "@/lib/crypto") return { decryptSecret: () => "gh-token" };
  return original.call(this, name, parent, isMain);
};
const route = require("../src/app/api/code/hooks/route") as typeof import("@/app/api/code/hooks/route");
modules._load = original;

const realFetch = globalThis.fetch;
const githubCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  githubCalls.push(url);
  assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer gh-token");
  if (!url.startsWith("https://api.github.com/repos/LiamMagnier/juno")) return new Response("{}", { status: 404 });
  if (url.includes("/contents/.alevr/hooks.json")) {
    return fileBytes ? new Response(new Uint8Array(fileBytes), { status: 200 }) : new Response("{}", { status: 404 });
  }
  return new Response("{}", { status: 200 });
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

const url = (q = "") => `https://alevr.example/api/code/hooks${q}`;
const post = async (body: unknown): Promise<Response> => (await route.POST(new Request(url(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })))!;

test("review shows the file's commands and hash; approval binds those exact bytes", async () => {
  rows = [];
  fileBytes = Buffer.from(VALID);
  const reviewed = await (await route.GET(new Request(url("?repo=LiamMagnier/juno")))).json();
  assert.equal(reviewed.file.present, true);
  assert.equal(reviewed.file.valid, true);
  assert.equal(reviewed.file.hash, hashHooksBytes(fileBytes));
  assert.equal(reviewed.file.approved, false);
  assert.equal(reviewed.file.hooks.length, 2);

  const created = await post({ repo: "LiamMagnier/juno", hash: reviewed.file.hash });
  assert.equal(created.status, 201);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.repoOwner, "liammagnier");
  assert.equal(rows[0]!.config, VALID);

  const again = await (await route.GET(new Request(url("?repo=LiamMagnier/juno")))).json();
  assert.equal(again.file.approved, true);
  assert.equal(again.approvals.length, 1);
});

test("a file that changed after review is not approved, and neither is a hash the browser made up", async () => {
  rows = [];
  fileBytes = Buffer.from(VALID);
  const shown = hashHooksBytes(fileBytes);
  fileBytes = Buffer.from(VALID.replace("verify", "deploy"));
  const changed = await post({ repo: "LiamMagnier/juno", hash: shown });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, "hooks_changed");
  assert.equal((await post({ repo: "LiamMagnier/juno", hash: "b".repeat(64) })).status, 409);
  assert.equal((await post({ repo: "LiamMagnier/juno", hash: "short" })).status, 400);
  assert.equal(rows.length, 0);
});

test("invalid, oversized and missing files are reported and never approved", async () => {
  rows = [];
  fileBytes = Buffer.from(`{"version":1,"hooks":{"PreTool":[]}}`);
  const invalid = await (await route.GET(new Request(url("?repo=LiamMagnier/juno")))).json();
  assert.equal(invalid.file.valid, false);
  assert.match(invalid.file.message, /PreTool/);
  assert.equal((await post({ repo: "LiamMagnier/juno", hash: hashHooksBytes(fileBytes) })).status, 400);

  fileBytes = Buffer.alloc(HOOKS_MAX_BYTES + 1, 0x20);
  const big = await (await route.GET(new Request(url("?repo=LiamMagnier/juno")))).json();
  assert.equal(big.file.valid, false);
  assert.equal(big.file.hash, null);

  fileBytes = null;
  const missing = await (await route.GET(new Request(url("?repo=LiamMagnier/juno")))).json();
  assert.deepEqual(missing.file, { present: false });
  assert.equal((await post({ repo: "LiamMagnier/juno", hash: "c".repeat(64) })).status, 400);
  assert.equal(rows.length, 0);
});

test("approvals belong to their owner: another account cannot list or remove them", async () => {
  rows = [];
  fileBytes = Buffer.from(VALID);
  await post({ repo: "LiamMagnier/juno", hash: hashHooksBytes(fileBytes) });
  const id = rows[0]!.id;

  currentUser = { id: "intruder" };
  assert.equal((await (await route.GET(new Request(url()))).json()).approvals.length, 0);
  assert.equal((await route.DELETE(new Request(url(`?id=${id}`), { method: "DELETE" }))).status, 404);
  assert.equal(rows.length, 1);

  currentUser = null;
  assert.equal((await route.GET(new Request(url()))).status, 401);
  assert.equal((await post({ repo: "LiamMagnier/juno", hash: "a".repeat(64) })).status, 401);

  currentUser = { id: "owner" };
  assert.equal((await route.DELETE(new Request(url(`?id=${id}`), { method: "DELETE" }))).status, 200);
  assert.equal(rows.length, 0);
});

test("each repository keeps at most ten reviewed versions, dropping the oldest", async () => {
  rows = [];
  for (let i = 0; i < 12; i++) {
    fileBytes = Buffer.from(VALID.replace("verify", `verify-${i}`));
    assert.equal((await post({ repo: "LiamMagnier/juno", hash: hashHooksBytes(fileBytes) })).status, 201);
  }
  assert.equal(rows.length, 10);
  assert.ok(!rows.some((r) => r.config.includes("verify-0\"")));
  assert.ok(!rows.some((r) => r.config.includes("verify-1\"")));
});

test("bad input is refused before GitHub is called", async () => {
  githubCalls.length = 0;
  assert.equal((await route.GET(new Request(url("?repo=not-a-repo")))).status, 400);
  assert.equal((await route.GET(new Request(url("?repo=LiamMagnier/juno&ref=..bad")))).status, 400);
  assert.equal(githubCalls.length, 0);
  assert.equal((await route.GET(new Request(url("?repo=someone/else")))).status, 404);
});
