import assert from "node:assert/strict";
import test from "node:test";

import {
  GeminiProviderError,
  geminiErrorFromResponse,
  requestGeminiStream,
} from "@/lib/gemini-network";

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
      if (calls < 3) {
        return new Response(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "High demand" } }), {
          status: 503,
        });
      }
      return new Response("data: {}\n", { status: 200 });
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 750]);
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
