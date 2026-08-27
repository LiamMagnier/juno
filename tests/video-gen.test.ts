import test from "node:test";
import assert from "node:assert/strict";
import { isGoogleOmniModel, parseGoogleOmniInteraction } from "../src/lib/video-gen-core";
import { resolveModel } from "../src/lib/models";

test("Gemini Omni and Veo Lite are callable video catalog entries", () => {
  const omni = resolveModel("google:gemini-omni-flash-preview");
  const veoLite = resolveModel("google:veo-3.1-lite-generate-preview");

  assert.ok(omni);
  assert.ok(veoLite);
  assert.equal(isGoogleOmniModel(omni), true);
  assert.equal(isGoogleOmniModel(veoLite), false);
});

test("Gemini Omni parser handles a completed base64 video step", () => {
  const bytes = Buffer.from("omni-video");
  const result = parseGoogleOmniInteraction({
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [{ type: "video", mime_type: "video/webm", data: bytes.toString("base64") }],
      },
    ],
  });

  assert.equal(result.status, "done");
  assert.equal(result.mimeType, "video/webm");
  assert.deepEqual(result.bytes, bytes);
});

test("Gemini Omni parser handles a completed URI video output", () => {
  const result = parseGoogleOmniInteraction({
    status: "completed",
    outputs: [{ type: "video", video: { uri: "https://generativelanguage.googleapis.com/video/123", mime_type: "video/mp4" } }],
  });

  assert.deepEqual(result, {
    status: "done",
    url: "https://generativelanguage.googleapis.com/video/123",
    mimeType: "video/mp4",
  });
});

test("Gemini Omni parser reports in-progress and failed interactions honestly", () => {
  assert.deepEqual(parseGoogleOmniInteraction({ status: "in_progress" }), {
    status: "running",
    note: "in_progress",
  });
  assert.throws(
    () => parseGoogleOmniInteraction({ status: "failed", error: { message: "blocked by safety policy" } }),
    /blocked by safety policy/
  );
});
