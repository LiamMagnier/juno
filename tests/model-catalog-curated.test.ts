import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { CURATED_CHAT_MODELS, CURATED_GEN_MODELS, MODELS, MODEL_LIST } from "../src/lib/models";
import { PROVIDERS, PROVIDER_LIST } from "../src/lib/providers";

/**
 * The model catalog is curated by hand, from each model's documentation.
 *
 * Provider-listed ids used to be merged in automatically — at runtime from
 * every configured lab's GET /models, and nightly into models.generated.ts —
 * with guessed metadata. The guesses got the route and the thinking-effort
 * ladder wrong (GPT-6.1 Sol arrived with an Instant tier the API rejects and
 * without Extra high or Max), so the only way into the catalog is now a
 * hand-written entry in src/lib/models.ts.
 */

const curatedIds = new Set([...CURATED_CHAT_MODELS, ...CURATED_GEN_MODELS].map((m) => m.id));

test("every registered model is a curated entry", () => {
  for (const id of Object.keys(MODELS)) assert.ok(curatedIds.has(id), `${id} is registered but not curated`);
  for (const m of MODEL_LIST) assert.ok(curatedIds.has(m.id), `${m.id} is offered but not curated`);
});

test("the served chat catalog equals the curated chat models, provider by provider", () => {
  // loadAvailableModels is server-only, so it runs in a child with the
  // react-server condition. Every provider gets a dummy key so every lab is
  // "configured", and fetch is stubbed: a provider-health POST is allowed (and
  // fails harmlessly), but any GET — a model-list discovery call — is recorded.
  const script = `
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: (init && init.method) || "GET" });
      throw new Error("network disabled in test");
    };
    const { loadAvailableModels } = await import(${JSON.stringify(new URL("../src/lib/model-catalog-api.ts", import.meta.url).pathname)});
    const served = (await loadAvailableModels()).filter((m) => m.modality === "chat").map((m) => m.id);
    process.stdout.write(JSON.stringify({ served, gets: calls.filter((c) => c.method === "GET").map((c) => c.url) }));
    process.exit(0);
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "--conditions=react-server" };
  for (const p of PROVIDER_LIST) env[PROVIDERS[p].apiKeyEnv] = "test-key";
  const out = execFileSync("npx", ["tsx", "--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url).pathname,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  const { served, gets } = JSON.parse(out.slice(out.indexOf("{"))) as { served: string[]; gets: string[] };

  assert.deepEqual(gets, [], "loading the catalog must not list any provider's models");
  for (const provider of PROVIDER_LIST) {
    const expected = Object.values(MODELS)
      .filter((m) => m.provider === provider && m.modality === "chat")
      .map((m) => m.id)
      .sort();
    const actual = served.filter((id) => id.startsWith(`${provider}:`)).sort();
    assert.deepEqual(actual, expected, `${provider}: served chat models differ from the curated list`);
  }
  for (const id of served) assert.ok(curatedIds.has(id), `${id} is served but not curated`);
});
