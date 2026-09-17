import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerTextFromPayload, answeredQuestionWhere } from "@/lib/work/answer-lookup";
import { PLAN_REVIEW_QUESTION_ID } from "@/lib/work/plan-review";

/*
 * Reading the answer to one question out of a run's event log.
 *
 * The executor polls this while a run waits on a person, and it used to take
 * the newest `question_answered` row for the run and check its id afterwards.
 * That was survivable while every question id was its tool call's id — a
 * replayed attempt minted a new one and simply asked again — and it became a
 * permanent stall the moment a question was asked under a FIXED id, because the
 * answer route keys its event `answer:<questionId>` and a re-claimed run keeps
 * its id and its whole log. Miss the answer once and every further press of the
 * button is dropped as a duplicate before it takes a sequence number, so the
 * run parks on the same gate for ever and the reader is shown two buttons that
 * do nothing. These cases are what stop that coming back.
 */

const RUNNER = readFileSync(new URL("../scripts/work-runner.ts", import.meta.url), "utf8");

test("the query asks for this question's answer, not for the newest one", () => {
  // The whole fix is that the id is tested in the WHERE clause. A poll that
  // selected on `{ runId, kind }` alone and compared afterwards returns null
  // as soon as the run has answered anything else more recently.
  const where = answeredQuestionWhere("run_1", PLAN_REVIEW_QUESTION_ID);
  assert.equal(where.runId, "run_1");
  assert.equal(where.kind, "question_answered");
  assert.deepEqual(where.payload, { path: ["questionId"], equals: PLAN_REVIEW_QUESTION_ID });
});

test("a later answer to another question does not hide this one", () => {
  // The stall, stated as the two rows that caused it: the plan review answered
  // on attempt one, then an ordinary question answered under its tool call's
  // id. The plan review's row is no longer the newest, and the gate has to
  // resolve from it anyway.
  const log = [
    { questionId: PLAN_REVIEW_QUESTION_ID, text: "Go ahead" },
    { questionId: "toolu_01abc", text: "the blue one" },
  ];
  const matching = log.filter(
    (row) => answeredQuestionWhere("run_1", PLAN_REVIEW_QUESTION_ID).payload.equals === row.questionId
  );
  assert.equal(matching.length, 1);
  assert.equal(answerTextFromPayload(matching[0], PLAN_REVIEW_QUESTION_ID), "Go ahead");
});

test("both spellings are read, and `text` wins", () => {
  // The answer route writes `text`; rows written before it did carry `answer`.
  // WorkEvent is append-only, so a reader that understood one spelling would
  // make every older row unreadable.
  assert.equal(answerTextFromPayload({ questionId: "q", text: "typed" }, "q"), "typed");
  assert.equal(answerTextFromPayload({ questionId: "q", answer: "older" }, "q"), "older");
  assert.equal(
    answerTextFromPayload({ questionId: "q", text: "typed", answer: "older" }, "q"),
    "typed"
  );
});

test("a row belonging to another question is not somebody else's reply", () => {
  assert.equal(answerTextFromPayload({ questionId: "other", text: "yes" }, "q"), null);
  assert.equal(answerTextFromPayload(null, "q"), null);
  assert.equal(answerTextFromPayload({ questionId: "q" }, "q"), null);
  // An empty answer is still an answer: the reader pressed something, and
  // turning that into null would leave the run waiting out its timeout.
  assert.equal(answerTextFromPayload({ questionId: "q", text: "" }, "q"), "");
});

test("the executor's poll goes through this module", () => {
  // The rule is only worth pinning while the one caller that matters uses it.
  // `scripts/work-runner.ts` imports "server-only" and cannot be imported here,
  // so its source is the only thing a test can hold.
  assert.match(RUNNER, /answeredQuestionWhere\(runId, questionId\)/);
  assert.match(RUNNER, /answerTextFromPayload\(event\.payload, questionId\)/);
  // And the shape that stalls must not come back: a `question_answered` query
  // that names neither the question nor this helper.
  assert.doesNotMatch(RUNNER, /where: \{ runId, kind: "question_answered" \}/);
});
