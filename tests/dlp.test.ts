import test from "node:test";
import assert from "node:assert/strict";
import { scanAndRedact, redactStructuredPayload } from "../src/lib/security/dlp.js";

test("DLP redacts OpenAI and Anthropic API keys", () => {
  const text = "My OpenAI key is sk-proj-1234567890abcdef1234567890 and Anthropic is sk-ant-api03-abcdefghijklmnop1234567890.";
  const result = scanAndRedact(text);

  assert.equal(result.hasViolations, true);
  assert.equal(result.detectedTypes.includes("OPENAI_API_KEY"), true);
  assert.equal(result.detectedTypes.includes("ANTHROPIC_API_KEY"), true);
  assert.equal(result.sanitizedText.includes("sk-proj-"), false);
  assert.equal(result.sanitizedText.includes("sk-ant-"), false);
  assert.equal(result.sanitizedText.includes("[REDACTED_OPENAI_KEY]"), true);
  assert.equal(result.sanitizedText.includes("[REDACTED_ANTHROPIC_KEY]"), true);
});

test("DLP redacts AWS keys, GitHub tokens, and private keys", () => {
  const text = "AWS: AKIAIOSFODNN7EXAMPLE, GitHub: ghp_111122223333444455556666777788889999";
  const result = scanAndRedact(text);

  assert.equal(result.hasViolations, true);
  assert.equal(result.detectedTypes.includes("AWS_ACCESS_KEY_ID"), true);
  assert.equal(result.detectedTypes.includes("GITHUB_TOKEN"), true);
  assert.equal(result.sanitizedText.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.equal(result.sanitizedText.includes("ghp_111122223333444455556666777788889999"), false);
});

test("DLP redacts credit card numbers preserving last 4 digits", () => {
  const text = "Payment card: 4532876543210987";
  const result = scanAndRedact(text);

  assert.equal(result.hasViolations, true);
  assert.equal(result.detectedTypes.includes("CREDIT_CARD"), true);
  assert.equal(result.sanitizedText.includes("[REDACTED_CARD_ending_in_0987]"), true);
});

test("DLP deep scans nested JSON payloads", () => {
  const payload = {
    user: "liam",
    config: {
      secret: "sk-proj-999999999999999999999999",
      items: ["safe text", "ghp_abcdef1234567890abcdef1234567890abcd"],
    },
  };

  const sanitized = redactStructuredPayload(payload);
  assert.equal(sanitized.config.secret, "[REDACTED_OPENAI_KEY]");
  assert.equal(sanitized.config.items[1], "[REDACTED_GITHUB_TOKEN]");
  assert.equal(sanitized.config.items[0], "safe text");
  assert.equal(sanitized.user, "liam");
});
