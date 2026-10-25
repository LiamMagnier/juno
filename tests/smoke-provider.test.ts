import assert from "node:assert/strict";
import test from "node:test";
import { classifyErrorFinishReason, isAbortLike } from "../src/lib/chat-responses";
import { verifyAndRepairChatArtifacts } from "../src/lib/chat-artifact-verification";
import {
  SMOKE_ARTIFACT_BODY,
  SMOKE_ARTIFACT_TITLE,
  SMOKE_ARTIFACT_TOKEN,
  SMOKE_SLOW_END,
  SMOKE_SLOW_START,
  streamDeterministicSmokeResponse,
} from "../src/lib/chat/turn/model-streams";
import { deterministicSmokeProviderAllowed, isQaRunnerDatabaseUrl } from "../src/lib/chat/turn/smoke-provider-gate";
import { parseArtifacts } from "../src/lib/message-content";
import { parseQaDatabaseUrl } from "../scripts/qa/lib/safe-env.mjs";
import type { LlmEvent } from "../src/types/llm";

/*
 * The deterministic smoke provider: when the chat route may use it (the gate),
 * and what it streams (the journey's lifecycles). Ledger P1-5: the browser
 * journey runs on the QA runner's production build, so the gate admits that
 * one production process — and must keep refusing every other.
 */

const QA_URL = "postgresql://postgres@127.0.0.1:55439/alevr_journey_test";
const QA = { JUNO_E2E_SMOKE_PROVIDER: "1", NODE_ENV: "production", ALEVR_QA_RUNNER: "1", DATABASE_URL: QA_URL, DIRECT_URL: QA_URL };

test("outside production the explicit opt-in alone enables the smoke provider, as before", () => {
  assert.equal(deterministicSmokeProviderAllowed({ JUNO_E2E_SMOKE_PROVIDER: "1", NODE_ENV: "development" }), true);
  assert.equal(deterministicSmokeProviderAllowed({ JUNO_E2E_SMOKE_PROVIDER: "1", NODE_ENV: "test" }), true);
  assert.equal(deterministicSmokeProviderAllowed({ JUNO_E2E_SMOKE_PROVIDER: "1" }), true);
  assert.equal(deterministicSmokeProviderAllowed({ NODE_ENV: "development" }), false);
  assert.equal(deterministicSmokeProviderAllowed({ JUNO_E2E_SMOKE_PROVIDER: "true", NODE_ENV: "development" }), false, "only the literal 1");
});

test("a production process gets it only under the QA runner, against its disposable database", () => {
  assert.equal(deterministicSmokeProviderAllowed(QA), true);
  assert.equal(deterministicSmokeProviderAllowed({ ...QA, DIRECT_URL: undefined }), true, "DIRECT_URL is optional");
  assert.equal(deterministicSmokeProviderAllowed({ ...QA, JUNO_E2E_SMOKE_PROVIDER: undefined }), false);
  assert.equal(deterministicSmokeProviderAllowed({ ...QA, ALEVR_QA_RUNNER: undefined }), false);
  assert.equal(deterministicSmokeProviderAllowed({ ...QA, ALEVR_QA_RUNNER: "true" }), false);
  assert.equal(deterministicSmokeProviderAllowed({ ...QA, DATABASE_URL: undefined }), false);
});

test("a production-shaped database never qualifies, even with both opt-ins set", () => {
  for (const url of [
    "postgresql://juno:s3cret@127.0.0.1:5432/juno",
    "postgresql://postgres@127.0.0.1:5432/juno_test",
    "postgresql://postgres:pw@127.0.0.1:55439/alevr_journey_test",
    "postgresql://postgres@db.internal:55439/alevr_journey_test",
    "postgresql://postgres@127.0.0.1:55439/production",
    "postgresql://postgres@127.0.0.1:55439/alevr_journey_test?host=db.internal",
    "postgres://postgres@127.0.0.1:55439/alevr_journey_test",
  ]) {
    assert.equal(deterministicSmokeProviderAllowed({ ...QA, DATABASE_URL: url, DIRECT_URL: undefined }), false, url);
  }
  // A safe DATABASE_URL with an unsafe DIRECT_URL is refused too.
  assert.equal(deterministicSmokeProviderAllowed({ ...QA, DIRECT_URL: "postgresql://juno:pw@10.0.0.5:5432/juno" }), false);
});

test("the app's QA-database check gives the harness's verdict on every URL", () => {
  const cases = [
    QA_URL,
    `${QA_URL}?schema=public`,
    `${QA_URL}?schema=Public`,
    `${QA_URL}?sslmode=disable`,
    `${QA_URL}#frag`,
    "postgresql://postgres@127.0.0.1:55439/a_test",
    "postgresql://postgres@127.0.0.1:55439/_test",
    "postgresql://postgres@127.0.0.1:55439/Alevr_test",
    "postgresql://postgres@127.0.0.1:55439/alevr_test/extra",
    "postgresql://postgres@127.0.0.1:55439/",
    "postgresql://postgres@localhost:55439/alevr_test",
    "postgresql://other@127.0.0.1:55439/alevr_test",
    "postgresql://postgres:x@127.0.0.1:55439/alevr_test",
    "postgresql://postgres@127.0.0.1/alevr_test",
    "mysql://postgres@127.0.0.1:55439/alevr_test",
    "not a url",
    "",
  ];
  for (const url of cases) {
    assert.equal(isQaRunnerDatabaseUrl(url), parseQaDatabaseUrl(url).ok, url);
  }
});

async function collect(stream: AsyncGenerator<LlmEvent>): Promise<{ events: LlmEvent[]; text: string }> {
  const events: LlmEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, text: events.map((event) => (event.type === "text" ? event.text : "")).join("") };
}

test("the default answer still echoes the prompt's last JUNO_ token in two chunks", async () => {
  const { events, text } = await collect(streamDeterministicSmokeResponse("reply with JUNO_HEALTHY_CHAT_OK please"));
  assert.equal(text, "JUNO_HEALTHY_CHAT_OK");
  assert.deepEqual(
    events.map((event) => event.type),
    ["text", "text", "usage", "finish"]
  );
  assert.equal((await collect(streamDeterministicSmokeResponse("nothing to echo"))).text, "JUNO_E2E_SMOKE_OK");
});

test("the artifact directive answers with one closed markdown artifact that chat verification accepts", async () => {
  const { text } = await collect(streamDeterministicSmokeResponse("Write a note. JUNO_E2E_ARTIFACT"));
  assert.match(text, new RegExp(SMOKE_ARTIFACT_TOKEN));
  const parsed = parseArtifacts(text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, "MARKDOWN");
  assert.equal(parsed[0].title, SMOKE_ARTIFACT_TITLE);
  assert.equal(parsed[0].incomplete, undefined, "closed, so it can become a version");
  assert.match(parsed[0].content, new RegExp(SMOKE_ARTIFACT_BODY));
  const verified = verifyAndRepairChatArtifacts(parsed);
  assert.deepEqual(verified.report.refused, []);
  assert.equal(verified.artifacts.length, 1);
});

test("the slow directive streams start, words and end when nobody stops it", async () => {
  const { events, text } = await collect(streamDeterministicSmokeResponse("JUNO_E2E_SLOW_STREAM", undefined, { intervalMs: 1, totalMs: 5 }));
  assert.ok(text.startsWith(SMOKE_SLOW_START));
  assert.ok(text.endsWith(SMOKE_SLOW_END));
  assert.match(text, /word1 word2 word3 word4 word5 /);
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["usage", "finish"]);
});

test("Stop ends the slow stream mid-answer with an abort the turn records as user_stopped", async () => {
  const controller = new AbortController();
  const stream = streamDeterministicSmokeResponse("JUNO_E2E_SLOW_STREAM", controller.signal, { intervalMs: 20, totalMs: 10_000 });
  const seen: string[] = [];
  const started = Date.now();
  await assert.rejects(
    (async () => {
      for await (const event of stream) {
        if (event.type === "text") seen.push(event.text);
        if (seen.length === 3) controller.abort();
      }
    })(),
    (error: unknown) => {
      assert.equal(isAbortLike(error), true);
      assert.equal(classifyErrorFinishReason(error), "user_stopped");
      return true;
    }
  );
  assert.ok(Date.now() - started < 2_000, "the abort ends the pause at once, not at the next tick of a 10s stream");
  assert.equal(seen[0], `${SMOKE_SLOW_START} `);
  assert.ok(!seen.join("").includes(SMOKE_SLOW_END), "a stopped answer never reaches its end marker");
});

test("an already-aborted generation streams nothing past its first chunk", async () => {
  const controller = new AbortController();
  controller.abort();
  const stream = streamDeterministicSmokeResponse("JUNO_E2E_SLOW_STREAM", controller.signal, { intervalMs: 5, totalMs: 50 });
  const first = await stream.next();
  assert.equal(first.done, false);
  await assert.rejects(stream.next(), (error: unknown) => isAbortLike(error));
});
