import assert from "node:assert/strict";
import test from "node:test";

import {
  GeminiProviderError,
  geminiErrorFromResponse,
  requestGeminiStream,
} from "@/lib/gemini-network";
import { getGoogleApiKeys } from "@/lib/gemini-core";

const context = {
  requestId: "req_test",
  generationId: "gen_test",
  conversationId: "conv_test",
  modelId: "google:gemini-3.7-flash",
  providerModel: "gemini-3.7-flash",
  reasoningEffort: "medium",
  endpoint: "models/gemini-3.7-flash:streamGenerateContent",
};

test("Google error envelopes retain HTTP and machine-readable status", () => {
  const error = geminiErrorFromResponse(400, JSON.stringify({
    error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid thinking level" },
  }), context);
  assert.equal(error.status, 400);
  assert.equal(error.error.status, "INVALID_ARGUMENT");
  assert.equal(error.retryable, false);
});

test("Gemini retries bounded pre-stream 503 responses and then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const response = await requestGeminiStream({
    url: "https://example.invalid/gemini",
    init: { method: "POST" },
    context,
  }, {
    fetchImpl: async () => {
      calls += 1;
      if (calls < 4) {
        return new Response(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "High demand" } }), {
          status: 503,
        });
      }
      return new Response("data: {}\n", { status: 200 });
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [750, 2_000, 4_000]);
});

test("Gemini does not retry a model-specific 400", async () => {
  let calls = 0;
  await assert.rejects(
    requestGeminiStream({
      url: "https://example.invalid/gemini",
      init: { method: "POST" },
      context,
    }, {
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Bad request" } }), {
          status: 400,
        });
      },
      sleep: async () => { throw new Error("must not sleep"); },
    }),
    (error: unknown) => error instanceof GeminiProviderError && error.status === 400,
  );
  assert.equal(calls, 1);
});

test("a duplicate key stored WITH quotes is the same key, not a second one", async () => {
  // The retry rotation picks a different credential on an auth failure, so a
  // malformed duplicate used to be a live second "key" that could only 401.
  const previous = { google: process.env.GOOGLE_API_KEY, gemini: process.env.GEMINI_API_KEY };
  try {
    process.env.GOOGLE_API_KEY = '"AIza-same"';
    process.env.GEMINI_API_KEY = "AIza-same\n";
    assert.deepEqual(getGoogleApiKeys(), ["AIza-same"]);
    process.env.GEMINI_API_KEY = "AIza-other";
    assert.deepEqual(getGoogleApiKeys(), ["AIza-same", "AIza-other"]);
  } finally {
    if (previous.google === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previous.google;
    if (previous.gemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous.gemini;
  }
});

test("a retry after a 429 keeps the SAME key", async () => {
  // Rotating per attempt turned a rate limit on the working key into a 401 on
  // the spare one — and 401 is not retryable, so the whole turn died.
  const used: Array<string | undefined> = [];
  const response = await requestGeminiStream(
    {
      url: "https://example.invalid/gemini",
      init: { method: "POST" },
      context,
      apiKeys: ["key-one", "key-two"],
    },
    {
      fetchImpl: async (_url, init) => {
        used.push((init?.headers as Record<string, string> | undefined)?.["x-goog-api-key"]);
        if (used.length === 1) {
          return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
        }
        return new Response("data: {}\n", { status: 200 });
      },
      sleep: async () => {},
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(used, ["key-one", "key-one"]);
});

test("a rejected credential — and only that — moves to the next key", async () => {
  const used: Array<string | undefined> = [];
  const sleeps: number[] = [];
  const response = await requestGeminiStream(
    {
      url: "https://example.invalid/gemini",
      init: { method: "POST" },
      context,
      apiKeys: ["dead-key", "live-key"],
    },
    {
      fetchImpl: async (_url, init) => {
        used.push((init?.headers as Record<string, string> | undefined)?.["x-goog-api-key"]);
        if (used.length === 1) {
          return new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED" } }), { status: 401 });
        }
        return new Response("data: {}\n", { status: 200 });
      },
      sleep: async (ms) => { sleeps.push(ms); },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(used, ["dead-key", "live-key"]);
  // A different credential needs no backoff — nothing was rate limited.
  assert.deepEqual(sleeps, []);
});

test("a 401 with no spare key fails immediately rather than replaying itself", async () => {
  let calls = 0;
  await assert.rejects(
    requestGeminiStream(
      { url: "https://example.invalid/gemini", init: { method: "POST" }, context, apiKeys: ["only-key"] },
      {
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED" } }), { status: 401 });
        },
        sleep: async () => { throw new Error("must not sleep"); },
      },
    ),
    (error: unknown) => error instanceof GeminiProviderError && error.status === 401,
  );
  assert.equal(calls, 1);
});
