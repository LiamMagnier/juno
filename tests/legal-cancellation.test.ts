import test from "node:test";
import assert from "node:assert/strict";
import { cancellationEmail, contractReference, formatEndDate, type CancellationRecap } from "../src/lib/cancellation";

const recap: CancellationRecap = {
  reference: contractReference("sub_123"),
  name: "Camille",
  email: "camille@example.test",
  planName: "Pro",
  interval: "month",
  endsAt: "2026-10-31T10:00:00.000Z",
};

test("the confirmation states receipt, the end date and the effects, in French then English (L215-1-1 al. 3)", () => {
  const mail = cancellationEmail(recap, "Alevr");
  assert.match(mail.subject, /Résiliation/);
  assert.match(mail.text, /bien reçu/);
  assert.match(mail.text, /prend fin le 31 octobre 2026/);
  assert.match(mail.text, /sub_123/);
  assert.match(mail.text, /offre Free/);
  assert.match(mail.text, /ends on 31 October 2026/);
  assert.ok(mail.text.indexOf("bien reçu") < mail.text.indexOf("We received"), "French, the contract language, comes first");
});

test("without a known end date it still says when, in words", () => {
  const mail = cancellationEmail({ ...recap, endsAt: null }, "Alevr");
  assert.match(mail.text, /au terme de la période de facturation en cours/);
});

test("dates are read in Paris time", () => {
  assert.equal(formatEndDate("2026-10-31T23:30:00.000Z", "fr"), "1 novembre 2026");
});
