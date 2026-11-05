import test from "node:test";
import assert from "node:assert/strict";

import {
  EMBED_CHUNKS_PER_USER_PER_HOUR,
  runEmbedSweep,
  sweepDocument,
  type ClaimedDocument,
  type EmbedSweepDeps,
  type EmbedSweepStore,
  type SweepChunk,
} from "@/lib/knowledge/embed-sweep";
import type { BackgroundProviderPolicy } from "@/lib/background-provider-policy";
import type { PackedChunk } from "@/lib/knowledge/chunk";

/*
 * PRJ-1's embedding sweep, over a fake store and a fake transport: vectors
 * are filled off the upload path, under the account's background-provider
 * policy, reusing what was already bought.
 */

type Finish = Parameters<EmbedSweepStore["finish"]>[2];

function fakeSweepStore(seed: {
  chunks?: SweepChunk[];
  blocks?: Array<{ id: string; ordinal: number; type: string; text: string; heading?: string[] }>;
  dominant?: string | null;
  reusable?: Map<string, number[]>;
  claim?: ClaimedDocument[];
}) {
  const finishes: Finish[] = [];
  const written: Array<{ model: string; ids: string[] }> = [];
  let chunks = seed.chunks ?? [];
  let replaced: PackedChunk[] | null = null;
  const owners = new Set<string>();
  const store: EmbedSweepStore = {
    async claim() {
      return seed.claim ?? [];
    },
    async blocksOf(userId) {
      owners.add(userId);
      return seed.blocks ?? [];
    },
    async replaceChunks(userId, _documentId, next) {
      owners.add(userId);
      replaced = next;
      chunks = next.map((chunk, index) => ({ id: `c${index}`, text: chunk.text, textHash: `h:${chunk.text.length}:${index}` }));
    },
    async chunksToEmbed(userId) {
      owners.add(userId);
      return chunks;
    },
    async dominantModel() {
      return seed.dominant ?? null;
    },
    async reusableVectors(_userId, hashes, model) {
      const out = new Map<string, number[]>();
      if (model !== seed.dominant) return out;
      for (const hash of hashes) if (seed.reusable?.has(hash)) out.set(hash, seed.reusable.get(hash)!);
      return out;
    },
    async writeVectors(userId, model, rows) {
      owners.add(userId);
      written.push({ model, ids: rows.map((row) => row.id) });
    },
    async finish(userId, _documentId, patch) {
      owners.add(userId);
      finishes.push(patch);
    },
  };
  return { store, finishes, written, owners, get replaced() { return replaced; } };
}

const sameProvider: BackgroundProviderPolicy = { mode: "same_provider", allowedProviders: null, selectedProvider: null } as never;
const anyAllowed: BackgroundProviderPolicy = { mode: "any_allowed_provider", allowedProviders: null, selectedProvider: null } as never;

function deps(store: EmbedSweepStore, over: Partial<EmbedSweepDeps> & { calls?: Array<{ texts: string[]; conversationProvider: null; preferModelId: string | null }> } = {}): EmbedSweepDeps {
  const calls = over.calls ?? [];
  return {
    store,
    loadPolicy: async () => anyAllowed,
    embed: async (options) => {
      calls.push({ texts: options.texts, conversationProvider: options.conversationProvider, preferModelId: options.preferModelId });
      return { ok: true, model: { id: "openai:text-embedding-3-small" }, vectors: options.texts.map(() => [0.1, 0.2]) };
    },
    now: () => new Date("2026-11-01T10:00:00Z"),
    ...over,
  };
}

const doc = (over: Partial<ClaimedDocument> = {}): ClaimedDocument => ({ id: "d1", userId: "u1", projectId: "p1", chunkCount: 2, ...over });

test("pending chunks get vectors and the document is marked embedded with its model", async () => {
  const fake = fakeSweepStore({ chunks: [{ id: "a", text: "refund window", textHash: "h1" }, { id: "b", text: "exchanges", textHash: "h2" }] });
  const calls: Array<{ texts: string[]; conversationProvider: null; preferModelId: string | null }> = [];
  const result = await sweepDocument(deps(fake.store, { calls }), doc());
  assert.equal(result.state, "embedded");
  assert.equal(result.embedded, 2);
  assert.deepEqual(fake.written, [{ model: "openai:text-embedding-3-small", ids: ["a", "b"] }]);
  assert.deepEqual(fake.finishes.at(-1), { embeddingState: "embedded", embeddingModel: "openai:text-embedding-3-small", embeddingReason: null });
  assert.equal(calls[0].conversationProvider, null, "no conversation is in progress");
  assert.deepEqual([...fake.owners], ["u1"]);
});

test("a policy that permits no provider leaves the document lexical-only, with the reason", async () => {
  const fake = fakeSweepStore({ chunks: [{ id: "a", text: "refund window", textHash: "h1" }] });
  const result = await sweepDocument(
    deps(fake.store, {
      loadPolicy: async () => sameProvider,
      embed: async () => ({ ok: false, reason: "denied_by_policy", deniedReason: "no_candidate_for_conversation_provider" }),
    }),
    doc()
  );
  assert.equal(result.state, "lexical_only");
  assert.deepEqual(fake.written, []);
  assert.deepEqual(fake.finishes.at(-1), { embeddingState: "lexical_only", embeddingReason: "no_candidate_for_conversation_provider" });
});

test("an unchanged chunk reuses its vector by text hash, and the transport is not called", async () => {
  const fake = fakeSweepStore({
    chunks: [{ id: "a", text: "refund window", textHash: "h1" }],
    dominant: "openai:text-embedding-3-small",
    reusable: new Map([["h1", [0.5, 0.5]]]),
  });
  const calls: Array<{ texts: string[]; conversationProvider: null; preferModelId: string | null }> = [];
  const result = await sweepDocument(deps(fake.store, { calls }), doc());
  assert.equal(calls.length, 0);
  assert.equal(result.reused, 1);
  assert.equal(result.state, "embedded");
});

test("new chunks are embedded in the project's existing vector space", async () => {
  const fake = fakeSweepStore({ chunks: [{ id: "a", text: "new text", textHash: "h9" }], dominant: "openai:text-embedding-3-large" });
  const calls: Array<{ texts: string[]; conversationProvider: null; preferModelId: string | null }> = [];
  await sweepDocument(deps(fake.store, { calls }), doc());
  assert.equal(calls[0].preferModelId, "openai:text-embedding-3-large");
});

test("a document indexed before ingest wrote chunks is chunked from its stored blocks", async () => {
  const fake = fakeSweepStore({
    blocks: [
      { id: "b1", ordinal: 0, type: "heading", text: "Refunds", heading: [] },
      { id: "b2", ordinal: 1, type: "paragraph", text: "The refund window is thirty days.", heading: ["Refunds"] },
    ],
  });
  const result = await sweepDocument(deps(fake.store), doc({ chunkCount: 0 }));
  assert.equal(result.backfilled, true);
  assert.ok(fake.replaced && fake.replaced.length > 0);
  for (const chunk of fake.replaced!) for (const id of chunk.blockIds) assert.ok(["b1", "b2"].includes(id));
  const backfill = fake.finishes.find((patch) => typeof patch.chunkCount === "number")!;
  assert.equal(backfill.chunkCount, fake.replaced!.length);
  assert.equal(result.state, "embedded");
});

test("a document with no text at all is lexical-only, not retried forever", async () => {
  const fake = fakeSweepStore({ blocks: [] });
  const result = await sweepDocument(deps(fake.store), doc({ chunkCount: 0 }));
  assert.equal(result.state, "lexical_only");
  assert.equal(result.reason, "no_text");
});

test("an account past its hourly allowance goes back in the queue instead of being embedded", async () => {
  const fake = fakeSweepStore({ chunks: [{ id: "a", text: "x", textHash: "h" }] });
  const budget = new Map([["u1", { hour: Math.floor(new Date("2026-11-01T10:00:00Z").getTime() / 3_600_000), used: EMBED_CHUNKS_PER_USER_PER_HOUR }]]);
  const calls: Array<{ texts: string[]; conversationProvider: null; preferModelId: string | null }> = [];
  const result = await sweepDocument(deps(fake.store, { budget, calls }), doc());
  assert.equal(result.state, "pending");
  assert.equal(result.reason, "hourly_limit");
  assert.equal(calls.length, 0);
});

test("one failing document does not stop the tick", async () => {
  const fake = fakeSweepStore({ claim: [doc({ id: "bad" }), doc({ id: "good" })], chunks: [{ id: "a", text: "x", textHash: "h" }] });
  let first = true;
  const results = await runEmbedSweep(
    deps(fake.store, {
      embed: async (options) => {
        if (first) {
          first = false;
          throw new Error("boom");
        }
        return { ok: true, model: { id: "m" }, vectors: options.texts.map(() => [1]) };
      },
    })
  );
  assert.deepEqual(results.map((r) => r.documentId), ["good"]);
});
