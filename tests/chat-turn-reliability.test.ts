import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRetryableGeminiStatus, isGeminiAuthStatus } from "@/lib/gemini-network";
import { turnModule } from "./chat-turn-source";

/*
 * Reliability of the chat turn (BRIEF §48), the parts that are wiring.
 *
 * The behavioural half — a disconnect that still saves, a resume that ends on
 * `done`, a 429 that is reported once and refunded, a stall, a Stop — runs
 * through the real route in tests/chat-turn-pipeline.integration.test.ts.
 * What is pinned here is what keeps external writes from being replayed:
 *
 *  1. No hidden replay of a billable model call. The Anthropic and
 *     OpenAI-compatible SDK clients run with `maxRetries: 0`; Gemini's own
 *     retry is bounded and happens only before the stream starts.
 *  2. A connector or acting tool call is keyed by the generation and the
 *     provider's call id (action-approval-store.ts `actionIdempotencyKey`), so
 *     a second ask for the same call finds the first receipt instead of
 *     executing twice.
 *  3. The turn is detached from the HTTP request: `req.signal` never reaches
 *     the model, so a closed tab cannot abort a half-done external write; only
 *     the explicit cancel (registry or durable poll) stops a generation.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("no SDK replays a streamed, billable request behind the ledger", () => {
  assert.match(read("src/lib/anthropic.ts"), /new Anthropic\(\{[\s\S]*?maxRetries: 0,/);
  assert.match(read("src/lib/openai-compat.ts"), /new OpenAI\(\{[^\n]*maxRetries: 0 \}\)/);
  assert.match(read("src/lib/openai-responses.ts"), /new OpenAI\(\{[^\n]*maxRetries: 0 \}\)/);
});

test("Gemini retries only weather, at most four times, before the stream exists", () => {
  for (const status of [429, 500, 502, 503, 504, 529]) assert.equal(isRetryableGeminiStatus(status), true, String(status));
  for (const status of [400, 401, 403, 404, 413]) assert.equal(isRetryableGeminiStatus(status), false, String(status));
  assert.equal(isGeminiAuthStatus(401), true);
  const network = read("src/lib/gemini-network.ts");
  assert.match(network, /Math\.min\(4, dependencies\.maxAttempts \?\? 4\)/);
  assert.match(network, /if \(response\.ok && response\.body\) return response;/, "a started stream is returned, never retried");
});

test("an acting tool call is idempotent on (generation, call id)", () => {
  const store = read("src/lib/action-approval-store.ts");
  assert.match(store, /const idempotencyKey = actionIdempotencyKey\(request\.sessionId, request\.callId\);/);
  assert.match(store, /findFirst\(\{\s*where: \{ userId: request\.userId, idempotencyKey \},/);
  // The chat turn hands the broker its generation id as that session.
  const run = turnModule("run-turn");
  assert.match(run, /audit: \{[\s\S]*?sessionId: generationId,[\s\S]*?onApprovalRequest: requestApproval,/);
});

test("the generation is detached from the request; only an explicit cancel stops it", () => {
  const run = turnModule("run-turn");
  // (Comments may name it; no code passes it.)
  assert.doesNotMatch(run, /signal: req\.signal|\(req\.signal\)|req\.signal\.add/);
  assert.match(run, /signal: generationController\.signal,/);
  assert.match(turnModule("durable-receipt"), /cancelGeneration\(receiptGenerationId, userId\)/);
});

test("every terminal path releases the spend hold or settles it", () => {
  const run = turnModule("run-turn");
  // The turn's own finally, and the outer catch for a throw before its try.
  assert.equal(run.split("await releaseSpend(user.id, generationId).catch(() => {});").length - 1, 2);
  assert.match(turnModule("private-turn"), /if \(!spendRecorded\) \{\s*await releaseSpend\(user\.id, generationId\)/);
});
