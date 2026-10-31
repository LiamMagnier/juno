import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import type { ModelInfo } from "@/lib/models";
import type { RecordSpendInput } from "@/lib/spend";
import type { RuntimeAccessDeps } from "@/lib/artifact-ai/access";
import type { ArtifactCompletionDeps } from "@/lib/artifact-ai/complete";
import { createArtifactStorage, type ArtifactStorageStore, type StorageScope } from "@/lib/artifact-ai/storage";

/*
 * The two routes behind window.alevr, run for real with their production
 * wiring (src/lib/artifact-ai/server.ts) replaced by fakes built on the same
 * rules: who is signed in, which artifacts exist and whose they are, what the
 * account may spend, and an in-memory store. What this checks is the route's
 * own part — refusals and their status, that the viewer (never the owner) is
 * who is admitted, billed and stored for, and the NDJSON it streams.
 */

const OWNER = { id: "user-owner", email: "owner@example.com" };
const VISITOR = { id: "user-visitor", email: "visitor@example.com" };
const TOKEN = "S".repeat(32);
const APP_ID = "art-app";

let viewer: { id: string; email: string } | null = null;
let budgetAllows = true;
let rateLimited = false;
const admitted: string[] = [];
const billed: RecordSpendInput[] = [];
const accessLookups: string[] = [];

const accessDeps: RuntimeAccessDeps = {
  async findOwnedArtifact(viewerId, artifactId) {
    accessLookups.push(`owned:${viewerId}:${artifactId}`);
    return viewerId === OWNER.id && artifactId === APP_ID ? { id: APP_ID, type: "REACT", language: "tsx" } : null;
  },
  async findLinkedArtifact(token) {
    accessLookups.push(`link:${token}`);
    return token === TOKEN ? { id: APP_ID, type: "REACT", language: "tsx" } : null;
  },
  publicScriptsEnabled: () => true,
};

const model = {
  id: "openai:test-artifact",
  provider: "openai",
  providerModel: "gpt-4.1-mini",
  name: "Route fixture",
  family: "gpt",
  minPlan: "FREE",
  cost: 1,
  modality: "chat",
} as ModelInfo;

function completionDeps(): ArtifactCompletionDeps {
  return {
    resolveModels: async () => [model],
    admit: async ({ userId }) => {
      admitted.push(userId);
      return budgetAllows
        ? { allowed: true, remainingMicroUsd: 1_000_000 }
        : { allowed: false, body: { error: "You've used up your plan's usage budget.", code: "QUOTA_EXCEEDED" } };
    },
    reserve: async () => ({ allowed: true }),
    settle: async () => undefined,
    stream: async function* () {
      yield { type: "text", text: "Hello " };
      yield { type: "text", text: "there" };
      yield { type: "usage", input: 12, output: 2 };
    },
    record: async (input) => {
      billed.push(input);
    },
    rates: () => ({ input: 1, output: 4 }),
    newRef: () => "ref",
  };
}

const rows = new Map<string, string>();
const keyOf = (scope: StorageScope, key: string) => `${scope.artifactId}|${scope.userId}|${key}`;
const store: ArtifactStorageStore = {
  async get(scope, key) {
    const stored = rows.get(keyOf(scope, key));
    return stored === undefined ? null : { stored };
  },
  async list(scope, prefix) {
    const head = `${scope.artifactId}|${scope.userId}|`;
    return [...rows.keys()].filter((k) => k.startsWith(head + prefix)).map((k) => k.slice(head.length)).sort();
  },
  async put(scope, entry, decide) {
    const verdict = decide({ existingKey: rows.has(keyOf(scope, entry.key)), existingBytes: 0, artifactBytes: 0, artifactKeys: 0, accountBytes: 0 });
    if (verdict.ok) rows.set(keyOf(scope, entry.key), entry.stored);
    return verdict;
  },
  async delete(scope, key) {
    return rows.delete(keyOf(scope, key));
  },
};

const flags: { userId: string; severity: string }[] = [];

const stubs: Record<string, unknown> = {
  "server-only": {},
  // The real pre-screen's test token, without the classifier's provider walk.
  "@/lib/moderation-ai": {
    quickScreen: (text: string) =>
      /\bXMODTEST_CRITICAL_CSAM\b/.test(text) ? { severity: "critical", category: "csam", detail: "Pre-filter test token matched." } : null,
  },
  "@/lib/moderation": {
    recordFlag: async (input: { userId: string; severity: string }) => {
      flags.push({ userId: input.userId, severity: input.severity });
      return null;
    },
  },
  "@/lib/session": { getCurrentUser: async () => viewer },
  "@/lib/usage": { getUserPlan: async () => "PRO" },
  "@/lib/artifact-ai/server": {
    runtimeAccessDeps: accessDeps,
    artifactCompletionDeps: () => completionDeps(),
    artifactStorage: createArtifactStorage({ store, seal: (plain) => `sealed:${plain}`, open: (s) => (s.startsWith("sealed:") ? s.slice(7) : null) }),
  },
  "@/lib/artifact-ai/rate-limits": {
    artifactCompletionLimited: async () =>
      rateLimited ? Response.json({ error: "Too often.", code: "rate_limited" }, { status: 429 }) : null,
    artifactStorageLimited: async () => null,
  },
};
const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let completeRoute: typeof import("@/app/api/artifact-runtime/complete/route");
let storageRoute: typeof import("@/app/api/artifact-runtime/storage/route");
try {
  completeRoute = require("../src/app/api/artifact-runtime/complete/route");
  storageRoute = require("../src/app/api/artifact-runtime/storage/route");
} finally {
  loader._load = originalLoad;
}

// The routes are the feature; they run with ARTIFACT_AI_ENABLED on except in
// the test that shows them off.
process.env.ARTIFACT_AI_ENABLED = "1";

function post(body: unknown): Request {
  return new Request("http://localhost/api/artifact-runtime/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function reset(as: typeof viewer) {
  viewer = as;
  budgetAllows = true;
  rateLimited = false;
  admitted.length = 0;
  billed.length = 0;
  accessLookups.length = 0;
}

test("with ARTIFACT_AI_ENABLED off (the default) both routes refuse before anything is looked up, stored or spent", async () => {
  reset({ id: "viewer-off", email: "viewer-off@example.test" });
  delete process.env.ARTIFACT_AI_ENABLED;
  try {
    const res = await completeRoute.POST(post({ target: { shareToken: TOKEN }, prompt: "hi" }));
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "not_enabled");
    const stored = await storageRoute.POST(post({ target: { shareToken: TOKEN }, op: "set", key: "k", value: 1 }));
    assert.equal(stored.status, 404);
    assert.deepEqual(accessLookups, []);
    assert.deepEqual(admitted, []);
    assert.deepEqual(billed, []);
  } finally {
    process.env.ARTIFACT_AI_ENABLED = "1";
  }
});

test("a signed-out visitor is refused before anything is looked up or spent", async () => {
  reset(null);
  const res = await completeRoute.POST(post({ target: { shareToken: TOKEN }, prompt: "hi" }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "sign_in_required");
  const stored = await storageRoute.POST(post({ target: { shareToken: TOKEN }, op: "get", key: "k" }));
  assert.equal(stored.status, 401);
  assert.deepEqual(accessLookups, []);
  assert.deepEqual(admitted, []);
});

test("a malformed call is a 400, a stranger's artifact a 404", async () => {
  reset(VISITOR);
  assert.equal((await completeRoute.POST(post("{not json"))).status, 400);
  assert.equal((await completeRoute.POST(post({ target: { artifactId: APP_ID }, prompt: "   " }))).status, 400);
  assert.equal((await completeRoute.POST(post({ target: { artifactId: APP_ID }, prompt: "hi", maxTokens: 99_999 }))).status, 400);
  assert.equal((await completeRoute.POST(post({ target: { artifactId: APP_ID, shareToken: TOKEN }, prompt: "hi" }))).status, 400);
  const stranger = await completeRoute.POST(post({ target: { artifactId: APP_ID }, prompt: "hi" }));
  assert.equal(stranger.status, 404);
  assert.deepEqual(accessLookups, [`owned:${VISITOR.id}:${APP_ID}`]);
  assert.deepEqual(admitted, []);
});

test("on a shared link the visitor is admitted and billed, never the owner, and the reply streams as NDJSON", async () => {
  reset(VISITOR);
  const res = await completeRoute.POST(post({ target: { shareToken: TOKEN }, prompt: "Greet me", maxTokens: 20 }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    { type: "text", text: "Hello " },
    { type: "text", text: "there" },
    { type: "done", model: model.id },
  ]);
  assert.deepEqual(admitted, [VISITOR.id]);
  assert.equal(billed.length, 1);
  assert.equal(billed[0].userId, VISITOR.id);
  assert.doesNotMatch(JSON.stringify([admitted, billed]), new RegExp(OWNER.id));
});

test("a spent budget is a 402 before any model, and a rate limit a 429", async () => {
  reset(VISITOR);
  budgetAllows = false;
  const spent = await completeRoute.POST(post({ target: { shareToken: TOKEN }, prompt: "hi" }));
  assert.equal(spent.status, 402);
  const body = await spent.json();
  assert.equal(body.code, "budget_exceeded");
  assert.equal(body.error, "You've used up your plan's usage budget.");
  assert.equal(billed.length, 0);

  reset(OWNER);
  rateLimited = true;
  const limited = await completeRoute.POST(post({ target: { artifactId: APP_ID }, prompt: "hi" }));
  assert.equal(limited.status, 429);
  assert.deepEqual(admitted, [], "a limited call is never admitted");
});

test("the moderation pre-screen refuses and flags before any spend", async () => {
  reset(VISITOR);
  flags.length = 0;
  const res = await completeRoute.POST(post({ target: { shareToken: TOKEN }, prompt: "XMODTEST_CRITICAL_CSAM" }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "policy_violation");
  assert.deepEqual(flags, [{ userId: VISITOR.id, severity: "critical" }]);
  assert.deepEqual(admitted, []);
});

test("storage is the viewer's own: a visitor's data on a shared link is not the owner's", async () => {
  rows.clear();
  reset(VISITOR);
  const set = await storageRoute.POST(post({ target: { shareToken: TOKEN }, op: "set", key: "score", value: { best: 42 } }));
  assert.equal(set.status, 200);
  assert.deepEqual([...rows.entries()], [[`${APP_ID}|${VISITOR.id}|score`, 'sealed:{"best":42}']]);

  const mine = await storageRoute.POST(post({ target: { shareToken: TOKEN }, op: "get", key: "score" }));
  assert.deepEqual(await mine.json(), { found: true, value: { best: 42 } });
  const keys = await storageRoute.POST(post({ target: { shareToken: TOKEN }, op: "list" }));
  assert.deepEqual(await keys.json(), { keys: ["score"] });

  reset(OWNER);
  const owners = await storageRoute.POST(post({ target: { artifactId: APP_ID }, op: "get", key: "score" }));
  assert.deepEqual(await owners.json(), { found: false, value: null });
  const ownerDelete = await storageRoute.POST(post({ target: { artifactId: APP_ID }, op: "delete", key: "score" }));
  assert.deepEqual(await ownerDelete.json(), { ok: true, deleted: false });
  assert.equal(rows.size, 1, "the owner cannot delete the visitor's data");

  reset(VISITOR);
  const missingValue = await storageRoute.POST(post({ target: { shareToken: TOKEN }, op: "set", key: "k" }));
  assert.equal(missingValue.status, 400);
  const badKey = await storageRoute.POST(post({ target: { shareToken: TOKEN }, op: "get", key: "" }));
  assert.equal(badKey.status, 400);
  const tooBig = await storageRoute.POST(post({ target: { shareToken: TOKEN }, op: "set", key: "k", value: "x".repeat(5 * 1024 * 1024 + 20_000) }));
  assert.equal(tooBig.status, 413);
});
