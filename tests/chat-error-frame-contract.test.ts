import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schemaErrors } from "../bench/workflows/lib/validators/wire";
import type { StreamChunk } from "@/types/chat";

/*
 * Chat wire 1.1: the error frame gains errorClass, retryable,
 * retryAfterSeconds, suggestedModelId and suggestedModelName. Additive: a 1.0
 * frame stays valid, and the native API contract version does not move.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
const schema = read("contracts/chat/juno-chat-wire-v1.schema.json") as Record<string, unknown>;
const streamEvent = (schema.$defs as Record<string, unknown>).StreamEvent as Record<string, unknown>;
const fixtures = read("contracts/chat/error-frame.fixtures.json").frames as Record<string, Record<string, unknown>>;

test("the wire is versioned 1.1.0, and the version says what changed", () => {
  assert.equal(schema["x-wire-version"], "1.1.0");
  const changes = schema["x-wire-changes"] as Record<string, string>;
  assert.match(changes["1.1.0"], /errorClass/);
  assert.match(changes["1.1.0"], /suggestedModelId/);
});

test("the native API contract version did not move for an additive field", () => {
  // Installed apps compare it for equality; bumping it would sign them out.
  const api = readFileSync(path.join(ROOT, "src/lib/api-v1.ts"), "utf8");
  assert.match(api, /export const CONTRACT_VERSION = "1\.3\.0";/);
});

test("1.0 and 1.1 error frames are both valid on the wire", () => {
  assert.ok(Object.keys(fixtures).some((name) => name.startsWith("v1.0")));
  assert.ok(Object.keys(fixtures).some((name) => name.startsWith("v1.1")));
  for (const [name, frame] of Object.entries(fixtures)) {
    assert.deepEqual(schemaErrors(frame, streamEvent, schema), [], `${name} must validate`);
    // And they are what the web's own type says an error frame is.
    const typed: StreamChunk = frame as unknown as StreamChunk;
    assert.equal(typed.type, "error");
  }
});

test("an unknown error class or a mistyped hint is rejected", () => {
  const base = fixtures["v1.1-account-fault"];
  assert.ok(schemaErrors({ ...base, errorClass: "out_of_money" }, streamEvent, schema).length > 0);
  // The two account faults are one class on the wire: the stream never says
  // whether the platform's key was refused or its credit ran out.
  assert.equal(base.errorClass, "account");
  for (const precise of ["auth", "billing"]) {
    assert.ok(schemaErrors({ ...base, errorClass: precise }, streamEvent, schema).length > 0, `${precise} is not a wire class`);
  }
  assert.ok(schemaErrors({ ...base, retryAfterSeconds: "soon" }, streamEvent, schema).length > 0);
  assert.ok(schemaErrors({ ...base, retryable: "no" }, streamEvent, schema).length > 0);
});

test("every 1.1 field on the error frame is decoded by the Swift client", () => {
  const variants = (streamEvent.oneOf as Array<Record<string, unknown>>).filter(
    (variant) => ((variant.properties as Record<string, { const?: string }>).type.const) === "error",
  );
  assert.equal(variants.length, 1);
  const properties = variants[0].properties as Record<string, Record<string, unknown>>;
  for (const field of ["errorClass", "retryable", "retryAfterSeconds", "suggestedModelId", "suggestedModelName"]) {
    assert.equal(properties[field]?.["x-native"], "native", `${field} is decoded natively`);
  }
});
