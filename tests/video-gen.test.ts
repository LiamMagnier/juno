import test from "node:test";
import assert from "node:assert/strict";
import { isGoogleOmniModel, parseGoogleOmniInteraction } from "../src/lib/video-gen-core";
import { hasRetired, migrateModelId, resolveModel } from "../src/lib/models";

test("Gemini Omni and Veo Lite are callable video catalog entries", () => {
  const veoLite = resolveModel("google:veo-3.1-lite-generate-preview");
  assert.ok(veoLite);
  assert.equal(isGoogleOmniModel(veoLite), false);
  // The GA model runs on the Omni path.
  const omniGa = resolveModel("google:gemini-omni-1.1-flash");
  assert.ok(omniGa);
  assert.equal(isGoogleOmniModel(omniGa), true);
  // The preview retired on 30 Sep 2026: from then on it migrates to the GA
  // model, and the Omni code path still recognises its provider model id.
  assert.equal(isGoogleOmniModel({ provider: "google", providerModel: "gemini-omni-flash-preview" }), true);
  if (hasRetired({ retiresOn: "2026-09-30" })) {
    assert.equal(migrateModelId("google:gemini-omni-flash-preview"), "google:gemini-omni-1.1-flash");
  } else {
    const omni = resolveModel("google:gemini-omni-flash-preview");
    assert.ok(omni);
    assert.equal(isGoogleOmniModel(omni), true);
  }
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
