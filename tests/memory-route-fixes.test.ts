import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as nextServer from "next/server";
import { forgetPlan } from "@/lib/memory-undo";
import { memoryUpdateActivity } from "@/lib/memory-lifecycle";
import { readMemoryWrite, serializeActivity } from "@/lib/chat/run-record";
import { undoRequests } from "@/lib/chat/memory-receipts";
import { MemoryUpdatedNotice } from "@/components/chat/memory-updated-notice";
import type { ClientActivityEvent } from "@/types/chat";

// The components are compiled with the classic JSX runtime under tsx.
(globalThis as { React?: typeof React }).React = React;

/*
 * Memory route behaviour, through the real route handlers over a fixture
 * database. Two open defects from docs/quality/memory-and-tools-2026-11.md:
 *
 *   3. Undo on a fact a turn BELIEVED AGAIN block-listed a statement the
 *      person made before that turn. It now returns the row to history and
 *      believes again what it had taken the slot back from.
 *   7. The account reset's "mark every chat read" insert had no
 *      skipDuplicates, so a first extraction landing mid-reset made the route
 *      answer 500 after the erase had committed.
 *
 * And the receipt that carries "believed again" to the Undo, the chat
 * notice's one-press Undo for a turn that saved more than one fact, and
 * "Keep this one" for two memories the page flagged (memory-overlaps.ts).
 */

const OWNER = "user-owner";

interface Entry {
  id: string;
  userId: string;
  content: string;
  kind: "FACT" | "SUPPRESSION";
  source: "AUTO" | "MANUAL";
  status: string;
  supersededById: string | null;
  reason: string | null;
  normalized: string | null;
  projectId: string | null;
  sourceRef: string | null;
  updatedAt: Date;
  lastVerifiedAt?: Date | null;
  confidence?: number;
}

let entries: Entry[] = [];
let conversations: { id: string; userId: string }[] = [];
let readMarks: { userId: string; conversationId: string }[] = [];
/** Set to make the next conversation read land a first extraction's row "concurrently". */
let extractionLandsMidReset = false;
let seq = 0;

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, want] of Object.entries(where)) {
    const have = row[key];
    if (want && typeof want === "object" && !(want instanceof Date)) {
      if ("in" in want && Array.isArray(want.in)) {
        if (!want.in.includes(have)) return false;
        continue;
      }
      return false;
    }
    if (have !== want) return false;
  }
  return true;
}

const memoryEntry = {
  findFirst: async ({ where }: { where: Record<string, unknown> }) => entries.find((row) => matches({ ...row }, where)) ?? null,
  findMany: async ({ where }: { where: Record<string, unknown> }) =>
    entries.filter((row) => matches({ ...row }, where)).map((row) => ({ ...row })),
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Entry> }) => {
    const hit = entries.filter((row) => matches({ ...row }, where));
    for (const row of hit) Object.assign(row, data, { updatedAt: new Date() });
    return { count: hit.length };
  },
  create: async ({ data }: { data: Partial<Entry> }) => {
    const row = {
      id: `s${++seq}`,
      status: "active",
      supersededById: null,
      reason: null,
      normalized: null,
      projectId: null,
      sourceRef: null,
      updatedAt: new Date(),
      ...data,
    } as Entry;
    entries.push(row);
    return row;
  },
  deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
    const before = entries.length;
    entries = entries.filter((row) => !matches({ ...row }, where));
    return { count: before - entries.length };
  },
};

const ok = async () => ({ count: 0 });
const fakePrisma = {
  memoryEntry,
  memorySummary: { deleteMany: ok },
  projectMemorySummary: { deleteMany: ok },
  memoryEdit: { deleteMany: ok, findMany: async () => [] },
  conversation: {
    findMany: async ({ where }: { where: { userId: string } }) => {
      const uncovered = conversations.filter(
        (chat) => chat.userId === where.userId && !readMarks.some((mark) => mark.conversationId === chat.id)
      );
      if (extractionLandsMidReset) {
        // The chat's first extraction creates its read mark between this read
        // and the insert below.
        for (const chat of uncovered) readMarks.push({ userId: chat.userId, conversationId: chat.id });
      }
      return uncovered.map((chat) => ({ id: chat.id }));
    },
  },
  conversationMemory: {
    updateMany: ok,
    createMany: async ({ data, skipDuplicates }: { data: { userId: string; conversationId: string }[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of data) {
        if (readMarks.some((mark) => mark.conversationId === row.conversationId)) {
          if (skipDuplicates) continue;
          throw Object.assign(new Error("Unique constraint failed on the fields: (`conversationId`)"), { code: "P2002" });
        }
        readMarks.push(row);
        count++;
      }
      return { count };
    },
  },
  $transaction: async (work: unknown) =>
    typeof work === "function" ? (work as (tx: typeof fakePrisma) => Promise<unknown>)(fakePrisma) : Promise.all(work as Promise<unknown>[]),
};

const refreshed: (string | null)[][] = [];
const stubs: Record<string, unknown> = {
  "server-only": {},
  // `after` runs its work at once, so the summaries a change asks to rebuild are seen.
  "next/server": { ...nextServer, after: (work: () => unknown) => void work() },
  "@/lib/prisma": { prisma: fakePrisma, prismaUnguarded: fakePrisma },
  "@/lib/session": { getCurrentUser: async () => ({ id: OWNER }) },
  "@/lib/memory": {
    deleteMemoryEntries: async () => undefined,
    embedMemoryEntries: async () => undefined,
    getSuppressions: async () => entries.filter((row) => row.kind === "SUPPRESSION").map((row) => row.content),
    refreshSummaries: async (_userId: string, scopes: (string | null)[]) => {
      refreshed.push(scopes);
    },
    settleRewrittenFact: async () => [],
    getMemorySummary: async () => null,
    listProjectMemorySummaries: async () => [],
    sweepExpiredMemories: async () => 0,
    writeManualFact: async () => ({ ok: false, reason: "empty" }),
  },
  "@/lib/memory-view": {
    MEMORY_ENTRY_SELECT: {},
    loadProvenanceConversations: async () => new Map(),
    serializeMemoryEntry: (row: unknown) => row,
  },
};
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let entryRoute: typeof import("@/app/api/memory/[id]/route");
let listRoute: typeof import("@/app/api/memory/route");
try {
  entryRoute = require("../src/app/api/memory/[id]/route");
  listRoute = require("../src/app/api/memory/route");
} finally {
  moduleLoader._load = originalLoad;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown) =>
  new Request("http://x/api/memory/id", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const fact = (id: string, content: string, over: Partial<Entry> = {}): Entry => ({
  id,
  userId: OWNER,
  content,
  kind: "FACT",
  source: "AUTO",
  status: "active",
  supersededById: null,
  reason: null,
  normalized: content.toLowerCase(),
  projectId: null,
  sourceRef: "chat0000000001",
  updatedAt: new Date("2026-11-01T00:00:00Z"),
  confidence: 0.8,
  ...over,
});

/**
 * The doc's repro, as the rows stand after the third turn: "lives in Lisbon",
 * then "lives in Porto", then "Lisbon" again. Lisbon was reinstated by that
 * turn and took the slot back from Porto.
 */
function lisbonAgain() {
  entries = [
    fact("lisbon", "The user lives in Lisbon.", { reason: "You said this again, more recently than what had replaced it." }),
    fact("porto", "The user lives in Porto.", { status: "superseded", supersededById: "lisbon", reason: "Replaced by something newer you said about where you live." }),
  ];
  refreshed.length = 0;
}

const row = (id: string) => entries.find((entry) => entry.id === id)!;
const blockList = () => entries.filter((entry) => entry.kind === "SUPPRESSION");

test("forgetPlan: a reinstated row's Undo un-believes it; everything else forgets", () => {
  assert.deepEqual(forgetPlan({ status: "active" }, { undo: true, reinstated: true }), { kind: "unbelieve" });
  // Already history or forgotten since: nothing to take back.
  assert.deepEqual(forgetPlan({ status: "superseded" }, { undo: true, reinstated: true }), { kind: "nothing" });
  assert.deepEqual(forgetPlan({ status: "suppressed" }, { undo: true, reinstated: true }), { kind: "nothing" });
  // A created fact's Undo, while believed, brings back what it replaced.
  assert.deepEqual(forgetPlan({ status: "active" }, { undo: true }), { kind: "forget", restoreReplaced: true });
  assert.deepEqual(forgetPlan({ status: "superseded" }, { undo: true }), { kind: "forget", restoreReplaced: false });
  // The memory page's Forget never restores anything.
  assert.deepEqual(forgetPlan({ status: "active" }, {}), { kind: "forget", restoreReplaced: false });
});

test("Undo on a fact the turn believed again puts memory back as it was, and block-lists nothing", async () => {
  lisbonAgain();
  const res = await entryRoute.PATCH(patch({ forget: true, undo: true, reinstated: true }), params("lisbon"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, status: "superseded", restored: 1 });
  // Lisbon is history again, behind Porto, and can be learned again.
  assert.equal(row("lisbon").status, "superseded");
  assert.equal(row("lisbon").supersededById, "porto");
  assert.equal(blockList().length, 0, "nothing the person said before that turn is block-listed");
  // Porto is believed again.
  assert.equal(row("porto").status, "active");
  assert.equal(row("porto").supersededById, null);
  assert.deepEqual(refreshed, [[null]]);

  // Pressed again after a reload: already history, nothing changes.
  const again = await entryRoute.PATCH(patch({ forget: true, undo: true, reinstated: true }), params("lisbon"));
  assert.deepEqual(await again.json(), { ok: true, status: "superseded", restored: 0 });
  assert.equal(row("porto").status, "active");
  assert.equal(blockList().length, 0);
});

test("Undo on a fact the turn created still forgets it for good", async () => {
  lisbonAgain();
  const res = await entryRoute.PATCH(patch({ forget: true, undo: true }), params("lisbon"));
  assert.equal(res.status, 200);
  assert.equal(row("lisbon").status, "suppressed");
  assert.equal(blockList().length, 1);
  assert.equal(blockList()[0].content, "The user lives in Lisbon.");
  assert.equal(row("porto").status, "active", "what it replaced is believed again");
});

test("'reinstated' is refused without an Undo, so it cannot soften a plain Forget", async () => {
  lisbonAgain();
  const res = await entryRoute.PATCH(patch({ forget: true, reinstated: true }), params("lisbon"));
  assert.equal(res.status, 400);
  assert.equal(row("lisbon").status, "active");
  assert.equal(blockList().length, 0);
});

test("the receipt says which facts were believed again, and the flag survives a reload", () => {
  const activity = memoryUpdateActivity({ created: 2, superseded: 1 }, ["The user lives in Lisbon."], [
    { id: "lisbon", content: "The user lives in Lisbon.", category: "identity", reinstated: true },
    { id: "m2", content: "The user is training for a marathon.", category: "goals" },
  ]);
  assert.deepEqual(activity?.memoryWrite?.saved, [
    { id: "lisbon", content: "The user lives in Lisbon.", category: "identity", reinstated: true },
    { id: "m2", content: "The user is training for a marathon.", category: "goals" },
  ]);
  const event: ClientActivityEvent = {
    id: "a1",
    kind: "context",
    title: "Memory updated",
    createdAt: "2026-11-16T10:00:00.000Z",
    memoryWrite: activity!.memoryWrite,
  };
  const restored = serializeActivity([event]);
  assert.equal(restored?.[0].memoryWrite?.saved[0].reinstated, true);
  assert.equal(restored?.[0].memoryWrite?.saved[1].reinstated, undefined);
  // Only a literal true is read as the flag.
  assert.equal(readMemoryWrite({ saved: [{ id: "x", content: "y", reinstated: "yes" }] })?.saved[0].reinstated, undefined);
  assert.deepEqual(undoRequests(restored![0].memoryWrite!.saved), [
    { id: "lisbon", reinstated: true },
    { id: "m2", reinstated: false },
  ]);
});

test("a turn that saved two facts offers one Undo for both, beside Edit", () => {
  const html = renderToStaticMarkup(
    React.createElement(MemoryUpdatedNotice, {
      write: {
        saved: [
          { id: "m1", content: "The user lives in Lisbon.", reinstated: true },
          { id: "m2", content: "The user is training for a marathon." },
        ],
      },
      onDismiss: () => undefined,
    })
  );
  assert.match(html, />Undo all</);
  assert.match(html, />Edit</);
  assert.doesNotMatch(html, /Edit or undo/);
  const one = renderToStaticMarkup(
    React.createElement(MemoryUpdatedNotice, {
      write: { saved: [{ id: "m3", content: "The user is training for a marathon." }] },
      onDismiss: () => undefined,
    })
  );
  assert.match(one, />Undo</);
  assert.doesNotMatch(one, />Undo all</);
});

test("a reset that races a first extraction still succeeds, and marks every chat read", async () => {
  entries = [fact("lisbon", "The user lives in Lisbon.")];
  conversations = [
    { id: "chat-new", userId: OWNER },
    { id: "chat-old", userId: OWNER },
  ];
  readMarks = [];
  extractionLandsMidReset = true;
  try {
    const res = await listRoute.DELETE(new Request("http://x/api/memory", { method: "DELETE" }));
    assert.equal(res.status, 200, "the erase committed, so the page must not be told it failed");
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    extractionLandsMidReset = false;
  }
  assert.equal(entries.length, 0);
  assert.deepEqual(readMarks.map((mark) => mark.conversationId).sort(), ["chat-new", "chat-old"]);
});

test("keeping one of two flagged memories retires the other behind it, and block-lists nothing", async () => {
  entries = [
    fact("short", "Prefers short answers that lead with the recommendation", { source: "MANUAL", sourceRef: "manual" }),
    fact("short2", "Prefers short answers, leading with the recommendation first", { source: "MANUAL", sourceRef: "manual" }),
    fact("elsewhere", "Prefers short answers that lead with the recommendation", { projectId: "p1" }),
  ];
  refreshed.length = 0;
  const res = await entryRoute.PATCH(patch({ replacedBy: "short", because: "duplicate" }), params("short2"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, status: "superseded", replacedBy: "short" });
  assert.equal(row("short2").status, "superseded");
  assert.equal(row("short2").supersededById, "short");
  assert.match(row("short2").reason ?? "", /^Merged: you kept “Prefers short answers that lead with the recommendation”/);
  assert.equal(row("short").status, "active");
  assert.ok(row("short").lastVerifiedAt instanceof Date, "keeping it counts as saying it again");
  assert.equal(blockList().length, 0);
  assert.deepEqual(refreshed, [[null]]);

  // A stale page: the kept one is history now, or lives in another scope.
  const stale = await entryRoute.PATCH(patch({ replacedBy: "short2", because: "duplicate" }), params("short"));
  assert.equal(stale.status, 409);
  const scoped = await entryRoute.PATCH(patch({ replacedBy: "elsewhere", because: "conflict" }), params("short"));
  assert.equal(scoped.status, 409);
  assert.equal(row("short").status, "active");
  // Not itself, not without a reason, not mixed with another change.
  assert.equal((await entryRoute.PATCH(patch({ replacedBy: "short", because: "duplicate" }), params("short"))).status, 400);
  assert.equal((await entryRoute.PATCH(patch({ replacedBy: "short" }), params("elsewhere"))).status, 400);
  assert.equal((await entryRoute.PATCH(patch({ replacedBy: "short", because: "duplicate", forget: true }), params("elsewhere"))).status, 400);
  assert.equal((await entryRoute.PATCH(patch({ replacedBy: "missing", because: "duplicate" }), params("short"))).status, 404);
});
