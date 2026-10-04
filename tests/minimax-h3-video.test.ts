import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesFor, defaultParams, wireParams } from "@/lib/media-params";
import { minimaxH3Body, minimaxV2Host, parseMinimaxH3Poll } from "@/lib/media-gen-core";
import { getModel } from "@/lib/models";
import { readFileSync } from "node:fs";

// platform.minimax.io/docs/api-reference/video-generation-v2-create + -query (2026-10-04).

test("H3 and H3 Max are video models with the V2 API's options", () => {
  for (const id of ["minimax:MiniMax-H3", "minimax:MiniMax-H3-Max"]) {
    const model = getModel(id)!;
    assert.equal(model.modality, "video", id);
    assert.ok(capabilitiesFor(id), id);
  }
  const h3 = capabilitiesFor("minimax:MiniMax-H3")!;
  const max = capabilitiesFor("minimax:MiniMax-H3-Max")!;
  const res = (caps: typeof h3) => (caps.options.resolution as { choices: Array<{ wire?: unknown }> }).choices.map((c) => c.wire);
  assert.deepEqual(res(h3), ["768P", "2K"]);
  assert.deepEqual(res(max), ["480P", "768P"]);
  assert.equal((h3.options.durationSec as { min: number }).min, 4);
  assert.equal((max.options.durationSec as { min: number }).min, 5, "H3 Max has no 4s");
  // Text-to-video needs a concrete ratio, so "adaptive" is never offered.
  const ratios = (h3.options.aspect as { choices: Array<{ value: string }> }).choices.map((c) => c.value);
  assert.ok(!ratios.includes("auto") && !ratios.includes("adaptive"));
});

test("the H3 request carries the prompt as a text item and every required field", () => {
  const wire = wireParams("minimax:MiniMax-H3", { ...defaultParams("minimax:MiniMax-H3"), resolution: "2K", durationSec: 8, aspect: "9:16" });
  assert.deepEqual(minimaxH3Body("MiniMax-H3", "a boy playing basketball", wire), {
    model: "MiniMax-H3",
    content: [{ type: "text", text: "a boy playing basketball" }],
    resolution: "2K",
    duration: 8,
    ratio: "9:16",
  });
  // No choices: the documented defaults still satisfy the required fields.
  assert.deepEqual(minimaxH3Body("MiniMax-H3-Max", "x", null), {
    model: "MiniMax-H3-Max",
    content: [{ type: "text", text: "x" }],
    resolution: "768P",
    duration: 5,
    ratio: "16:9",
  });
  assert.equal(minimaxV2Host("https://api.minimax.io/v1"), "https://api.minimax.io");
  assert.equal(minimaxV2Host("https://api.minimax.io/v1/"), "https://api.minimax.io");
});

test("the V2 query result is read from task.status and task.content.url", () => {
  assert.deepEqual(parseMinimaxH3Poll({ task: { status: "queued" } }), { status: "running", note: "queued" });
  assert.deepEqual(parseMinimaxH3Poll({ task: { status: "succeeded", content: { url: "https://cdn/x.mp4" } } }), {
    status: "done",
    url: "https://cdn/x.mp4",
    mimeType: "video/mp4",
  });
  assert.throws(
    () => parseMinimaxH3Poll({ task: { status: "failed", error: { code: "1026", message: "sensitive content" } } }),
    /sensitive content/,
  );
  assert.throws(() => parseMinimaxH3Poll({ task: { status: "succeeded", content: {} } }), /no video/);
});

test("H3 is metered per second at its 5s / 768P default", () => {
  // spend.ts is server-only, so its rule is read as source (as lyria-audio.test.ts does).
  const spend = readFileSync("src/lib/spend.ts", "utf8");
  const body = spend.slice(spend.indexOf("export function mediaRequestCost"));
  assert.match(body, /if \(id\.includes\("minimax-h3"\)\) return 400_000;/);
  // Before the generic per-tier fallbacks.
  assert.ok(body.indexOf('"minimax-h3"') < body.indexOf("/fast|mini|lite/"));
});
