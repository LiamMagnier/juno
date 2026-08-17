import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDlpPolicy } from "../src/lib/security/dlp.js";

test("DLP Policy Engine: Block mode blocks payloads with sensitive secrets", () => {
  const secretPayload = "Please use this AWS key: AKIAIOSFODNN7EXAMPLE to configure storage.";
  const result = evaluateDlpPolicy(secretPayload, "model_provider", { mode: "block" });

  assert.equal(result.allowed, false);
  assert.equal(result.actionTaken, "blocked");
  assert.ok(result.detectedTypes.includes("AWS_ACCESS_KEY_ID"));
  assert.ok(result.reason?.includes("Payload blocked by DLP policy"));
});

test("DLP Policy Engine: Warn mode sanitizes secrets and emits structured audit event", () => {
  const payload = "My Anthropic key is sk-ant-api03-abcdef12345678901234567890.";
  const result = evaluateDlpPolicy(payload, "model_provider", { mode: "warn" });

  assert.equal(result.allowed, true);
  assert.equal(result.actionTaken, "sanitized");
  assert.ok(result.sanitizedContent.includes("[REDACTED_ANTHROPIC_KEY]"));
  assert.equal(result.auditEvent.actionTaken, "sanitized");
  assert.equal(result.auditEvent.violationCount, 1);
});

test("DLP Policy Engine: Allow mode allows payload through with audit recording", () => {
  const payload = "Here is a public test token: sk-proj-abcdef123456789012345678.";
  const result = evaluateDlpPolicy(payload, "external_tool", { mode: "allow" });

  assert.equal(result.allowed, true);
  assert.equal(result.actionTaken, "allowed");
  assert.equal(result.sanitizedContent, payload);
  assert.equal(result.auditEvent.mode, "allow");
});
