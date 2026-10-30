import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRetryableGeminiStatus, isGeminiAuthStatus } from "@/lib/gemini-network";
import { turnModule } from "./chat-turn-source";

/*
 * Reliability of the chat turn (BRIEF §48), the parts that are wiring.
 *
 * The behavioural half — a disconnect that still saves, a resume that ends on
 * `done`, a 429 before the first byte that is asked once more and then
 * reported once and refunded, a stall, a Stop — runs through the real route in
 * tests/chat-turn-pipeline.integration.test.ts. What is pinned here is what
 * keeps external writes from being replayed:
 *
 *  1. No hidden replay of a billable model call. The Anthropic and
 *     OpenAI-compatible SDK clients run with `maxRetries: 0`; Gemini's own
 *     retry is bounded and happens only before the stream starts; the turn's
 *     one retry (chat/turn/pre-stream-retry.ts) asks again only when the
 *     attempt's stream yielded nothing at all.
 *  2. A connector or acting tool call is keyed by the generation and the
 *     provider's call id (action-approval-store.ts `actionIdempotencyKey`), so
 *     a second ask for the same call finds the first receipt instead of
 *     executing twice.
 *  3. The turn is detached from the HTTP request: `req.signal` never reaches
 *     the model, so a closed tab cannot abort a half-done external write; only
 *     the explicit cancel (registry, or the durable cancel the per-process
 *     signal pump reads) stops a generation.
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
  // The durable half of that cancel reaches every generation a process holds,
  // receipt or not, and goes through the registry so it ends as a user Stop.
  const registry = read("src/lib/generation-cancel.ts");
  assert.match(registry, /onCancel: \(ref\) => \{\s*if \(registry\.cancel\(ref\.generationId, ref\.userId\)\)/);
  assert.match(read("src/lib/chat/generation-signals-store.ts"), /"cancelRequestedAt" IS NOT NULL/, "the receipt flag is still read");
});

test("every terminal path releases the spend hold or settles it", () => {
  const run = turnModule("run-turn");
  // The outer catch, for a throw before the turn's try: no retry can have
  // happened, so the hold is the generation's own.
  assert.equal(run.split("await releaseSpend(user.id, generationId).catch(() => {});").length - 1, 1);
  // The turn's own finally releases whichever hold is still open: the
  // generation's, or attempt 2's after a retry before the first byte.
  assert.match(run, /if \(!spendRecorded\) \{\s*await releaseSpend\(user\.id, activeSpendRef\)\.catch\(\(\) => \{\}\);/);
  // That retry releases attempt 1's hold before taking attempt 2's own, and
  // does not retry at all when that release did not happen: two holds are
  // never open at once.
  assert.match(
    run,
    /const released = await releaseSpend\(user\.id, activeSpendRef\)[\s\S]{0,40}?if \(!released\) \{[\s\S]{0,200}?return false;[\s\S]{0,300}?reserveSpend\(\{[^}]*ref: retryRef/,
  );
  // And every charge the turn records settles the hold that is open.
  assert.equal(run.split("recordTurnSpend({").length - 1, 3);
  assert.equal(run.split("reservationRef: activeSpendRef,").length - 1, 3);
  assert.match(turnModule("private-turn"), /if \(!spendRecorded\) \{\s*await releaseSpend\(user\.id, generationId\)/);
});

test("the turn's one retry is counted on what the attempt's stream yielded, and only the provider stream retries", () => {
  const run = turnModule("run-turn");
  assert.match(run, /const counted = countingStream\(openModelStream\(attempt\)\);/);
  assert.match(run, /if \(!\(await retryBeforeFirstByte\(err, attempt, counted\.received\(\)\)\)\) throw err;/);
  // A research notice and the smoke provider are pumped once, outside the loop.
  assert.match(run, /if \(researchNotice\) \{\s*await pump\(streamResearchNotice\(researchNotice\)\);/);
  // The policy reads what arrived before it reads the error.
  const policy = read("src/lib/chat/turn/pre-stream-retry.ts");
  const outputCheck = policy.indexOf('return refuse("output_received")');
  assert.ok(outputCheck > 0 && outputCheck < policy.indexOf("classifyProviderError(input.err)"));
});
