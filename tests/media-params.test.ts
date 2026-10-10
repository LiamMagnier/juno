import test from "node:test";
import assert from "node:assert/strict";
import { GEN_MODELS } from "@/lib/models";
import {
  MEDIA_CAPABILITY_IDS,
  allowedValues,
  applyParamChange,
  capabilitiesFor,
  defaultParams,
  normalizeParams,
  optionValues,
  paramsForModelSwitch,
  wireParams,
  type MediaParamKey,
} from "@/lib/media-params";

/*
 * media-params.ts decides which generation controls the composer shows and
 * what the server lets through to a provider. These tests pin the contract:
 * every live media model has an entry, defaults are real choices, bad input
 * never reaches a provider, and a model switch keeps what still applies.
 */

test("every current image, video and audio model in the catalog has a capability entry", () => {
  const media = GEN_MODELS.filter((m) => m.modality !== "chat" && m.status === "current");
  assert.ok(media.length > 0);
  const missing = media.filter((m) => !capabilitiesFor(m.id)).map((m) => m.id);
  assert.deepEqual(missing, []);
});

test("every entry belongs to a model the catalog knows, with the same modality", () => {
  const known = new Map(GEN_MODELS.map((m) => [m.id, m.modality]));
  for (const id of MEDIA_CAPABILITY_IDS) {
    // Retired models drop out of GEN_MODELS by date; a stray entry is harmless
    // but a mismatched modality would put video controls on an image model.
    if (!known.has(id)) continue;
    assert.equal(capabilitiesFor(id)?.kind, known.get(id), id);
  }
});

test("defaults are members of their allowed sets and satisfy the rules", () => {
  for (const id of MEDIA_CAPABILITY_IDS) {
    const caps = capabilitiesFor(id)!;
    const defaults = defaultParams(id);
    for (const [key, option] of Object.entries(caps.options)) {
      assert.ok(optionValues(option).includes(option.default), `${id} ${key} default ${String(option.default)}`);
      const allowed = allowedValues(id, key as MediaParamKey, defaults);
      assert.ok(allowed.includes(defaults[key as MediaParamKey] as never), `${id} ${key} default breaks a rule`);
    }
    // The defaults are already normal.
    assert.deepEqual(normalizeParams(id, defaults), defaults, id);
  }
});

test("labels are plain: no em dash in anything a person reads", () => {
  for (const id of MEDIA_CAPABILITY_IDS) {
    for (const option of Object.values(capabilitiesFor(id)!.options)) {
      assert.ok(!option.label.includes("—"), `${id} ${option.label}`);
      if (option.kind === "select") {
        for (const c of option.choices) assert.ok(!`${c.label}${c.detail ?? ""}`.includes("—"), `${id} ${c.label}`);
      }
    }
  }
});

test("composed size tables cover every combination the rules allow", () => {
  for (const id of MEDIA_CAPABILITY_IDS) {
    const caps = capabilitiesFor(id)!;
    if (!caps.composed) continue;
    const [first, second] = caps.composed.from;
    for (const a of optionValues(caps.options[first]!)) {
      if (a === "auto") continue;
      const seconds = second ? allowedValues(id, second, { [first]: a }) : [undefined];
      for (const b of seconds) {
        const key = second ? `${a}|${b}` : String(a);
        assert.ok(caps.composed.table[key], `${id} has no ${caps.composed.field} for ${key}`);
      }
    }
  }
});

test("GPT Image 2.x sizes stay inside OpenAI's documented custom-size limits", () => {
  const table = capabilitiesFor("openai:gpt-image-2.5-sunburst")!.composed!.table;
  for (const size of Object.values(table)) {
    const [w, h] = size.split("x").map(Number);
    assert.equal(w % 16, 0, size);
    assert.equal(h % 16, 0, size);
    assert.ok(Math.max(w, h) / Math.min(w, h) <= 3, size);
    assert.ok(w * h >= 655_360 && w * h <= 8_294_400, size);
    assert.ok(Math.max(w, h) <= 3840, size);
  }
});

test("normalize drops unknown keys and replaces invalid values with defaults", () => {
  const veo = "google:veo-3.1-generate-preview";
  const out = normalizeParams(veo, { aspect: "4:3", resolution: "8K", durationSec: 6, audio: false, count: 4, hack: "x" });
  assert.deepEqual(out, { aspect: "16:9", resolution: "720p", durationSec: 6 });

  // Wrong types fall back too.
  assert.deepEqual(normalizeParams("openai:gpt-image-2.5-flare", { quality: 3, count: "10", outputFormat: "gif" }), {
    aspect: "1:1",
    quality: "auto",
    outputFormat: "png",
    count: 1,
    resolution: "1K",
    background: "auto",
  });

  // Garbage input and unknown models never throw.
  assert.deepEqual(normalizeParams(veo, null), defaultParams(veo));
  assert.deepEqual(normalizeParams("openai:gpt-5", { aspect: "1:1" }), {});
});

test("normalize clamps numbers into a range instead of discarding them", () => {
  assert.equal(normalizeParams("xai:grok-imagine-video-1.5", { durationSec: 40 }).durationSec, 15);
  assert.equal(normalizeParams("xai:grok-imagine-video-1.5", { durationSec: 0 }).durationSec, 1);
  assert.equal(normalizeParams("openai:gpt-image-2", { count: 50 }).count, 10);
  assert.equal(normalizeParams("minimax:image-01", { count: 10 }).count, 9);
  // "auto" is only a length where the provider can choose one.
  assert.equal(normalizeParams("seedance:dreamina-seedance-2-5-260628", { durationSec: "auto" }).durationSec, "auto");
  assert.equal(normalizeParams("seedance:seedance-1-0-pro-250528", { durationSec: "auto" }).durationSec, 5);
});

test("normalize enforces cross-option rules", () => {
  // Veo: 1080p and 4K are 8s only.
  assert.equal(normalizeParams("google:veo-3.1-generate-preview", { resolution: "4K", durationSec: 4 }).durationSec, 8);
  // Hailuo: 1080P is 6s only.
  assert.equal(normalizeParams("minimax:MiniMax-Hailuo-2.3", { resolution: "1080p", durationSec: 10 }).durationSec, 6);
  // GPT Image: 3:2 has no 4K size.
  assert.equal(normalizeParams("openai:gpt-image-2.5-sunburst", { aspect: "3:2", resolution: "4K" }).resolution, "1K");
  // Transparency needs png or webp.
  assert.equal(normalizeParams("openai:gpt-image-2.5-sunburst", { background: "transparent", outputFormat: "jpg" }).outputFormat, "png");
});

test("a person's latest pick wins over the option that rules it out", () => {
  const veo = "google:veo-3.1-generate-preview";
  const next = applyParamChange(veo, { resolution: "1080p", durationSec: 8 }, "durationSec", 4);
  assert.equal(next.durationSec, 4);
  assert.equal(next.resolution, "720p");
});

test("a picked resolution is kept: the aspect only moves to a ratio that has it, the closest one", () => {
  const gpt = "openai:gpt-image-2.5-sunburst";
  // 1:1 caps at 2K; 2:3 and 3:2 cap at 1K. The escape is 16:9 (the first of the two equally close wides).
  const at4K = applyParamChange(gpt, defaultParams(gpt), "resolution", "4K");
  assert.equal(at4K.resolution, "4K");
  assert.equal(at4K.aspect, "16:9");
  assert.ok(capabilitiesFor(gpt)!.composed!.table[`${at4K.aspect}|4K`], "the kept pair is a real size");
  // From portrait 2:3, 2K moves to the closest portrait-ish ratio that has 2K: 1:1, not 16:9.
  const portrait2K = applyParamChange(gpt, { ...defaultParams(gpt), aspect: "2:3" }, "resolution", "2K");
  assert.deepEqual([portrait2K.aspect, portrait2K.resolution], ["1:1", "2K"]);
  // From 2:3, 4K moves to 9:16 (tall stays tall), not 16:9.
  const portrait4K = applyParamChange(gpt, { ...defaultParams(gpt), aspect: "2:3" }, "resolution", "4K");
  assert.deepEqual([portrait4K.aspect, portrait4K.resolution], ["9:16", "4K"]);
  const landscape4K = applyParamChange(gpt, { ...defaultParams(gpt), aspect: "3:2" }, "resolution", "4K");
  assert.deepEqual([landscape4K.aspect, landscape4K.resolution], ["16:9", "4K"]);
});

test("options that a model does not have are absent, not disabled", () => {
  assert.equal(capabilitiesFor("google:veo-3.1-lite-generate-preview")!.options.resolution!.kind, "select");
  assert.ok(!optionValues(capabilitiesFor("google:veo-3.1-lite-generate-preview")!.options.resolution!).includes("4K"));
  assert.equal(capabilitiesFor("google:veo-3.1-generate-preview")!.options.audio, undefined);
  assert.equal(capabilitiesFor("google:veo-3.1-generate-preview")!.fixed?.audio, true);
  assert.equal(capabilitiesFor("xai:grok-imagine-image")!.options.quality, undefined);
  assert.equal(capabilitiesFor("google:lyria-3-clip-preview")!.options.outputFormat, undefined);
});

test("switching models keeps compatible values and moves the rest to the nearest fit", () => {
  const fromVeo = { aspect: "9:16", resolution: "4K", durationSec: 8 };
  // Veo Lite has no 4K: nearest is 1080p, which still allows 8s.
  assert.deepEqual(paramsForModelSwitch(fromVeo, "google:veo-3.1-lite-generate-preview"), {
    aspect: "9:16",
    resolution: "1080p",
    durationSec: 8,
  });

  // Veo to Seedance 2.0 Fast: aspect kept, 4K becomes 720p, 8s is inside 4..15, audio defaults on.
  assert.deepEqual(paramsForModelSwitch(fromVeo, "seedance:dreamina-seedance-2-0-fast-260128"), {
    aspect: "9:16",
    resolution: "720p",
    durationSec: 8,
    audio: true,
  });

  // Long Grok clip onto Veo: 12s has no Veo match, nearest is 8s.
  const grok = { aspect: "16:9", resolution: "720p", durationSec: 12, audio: false };
  assert.deepEqual(paramsForModelSwitch(grok, "google:veo-3.1-fast-generate-preview"), {
    aspect: "16:9",
    resolution: "720p",
    durationSec: 8,
  });

  // Image: Nano Banana 2 at 21:9 4K onto GPT Image 2.5 (no 21:9) keeps the 4K tier only where it fits.
  const banana = { aspect: "21:9", resolution: "4K" };
  const gpt = paramsForModelSwitch(banana, "openai:gpt-image-2.5-flare");
  assert.equal(gpt.aspect, "1:1");
  assert.equal(gpt.resolution, "2K"); // 1:1 tops out at 2K
  // And Nano Banana 2 Lite only has 1K.
  assert.equal(paramsForModelSwitch(banana, "google:gemini-3.1-flash-lite-image").resolution, "1K");
  assert.equal(paramsForModelSwitch(banana, "google:gemini-3.1-flash-lite-image").aspect, "21:9");

  // To a model with nothing to choose.
  assert.deepEqual(paramsForModelSwitch(banana, "anthropic:claude-opus-4-8"), {});
});

test("wire mapping speaks each provider's dialect", () => {
  assert.deepEqual(wireParams("openai:gpt-image-2.5-sunburst", { aspect: "16:9", resolution: "4K", quality: "max", outputFormat: "jpg", count: 2 }).body, {
    quality: "max",
    output_format: "jpeg",
    n: 2,
    background: "auto",
    size: "3840x2160",
  });
  assert.deepEqual(wireParams("openai:gpt-image-1-mini", {}).body, { quality: "auto", output_format: "png", n: 1, size: "1024x1024" });

  assert.deepEqual(wireParams("google:gemini-3.1-flash-image", { aspect: "4:1", resolution: "0.5K" }).body, {
    generationConfig: { imageConfig: { aspectRatio: "4:1", imageSize: "512" } },
  });

  assert.deepEqual(wireParams("google:veo-3.1-generate-preview", { aspect: "9:16", resolution: "4K" }).body, {
    parameters: { aspectRatio: "9:16", resolution: "4k", durationSeconds: "8" },
  });

  assert.deepEqual(wireParams("xai:grok-imagine-image-2.0", { resolution: "2K", quality: "medium" }).body, {
    aspect_ratio: "auto",
    resolution: "2k",
    n: 1,
    quality: "medium",
  });

  assert.deepEqual(wireParams("xai:grok-imagine-video-1.5", { durationSec: 12, audio: false, resolution: "1080p" }).body, {
    aspect_ratio: "16:9",
    resolution: "1080p",
    duration: 12,
    generate_audio: false,
  });

  assert.deepEqual(wireParams("seedance:dreamina-seedance-2-5-260628", {}).body, {
    ratio: "adaptive",
    resolution: "720p",
    duration: -1,
    generate_audio: true,
    output_format: "mp4",
  });

  assert.deepEqual(wireParams("minimax:MiniMax-Hailuo-2.3", { resolution: "1080p" }).body, { resolution: "1080P", duration: 6 });

  assert.deepEqual(wireParams("zhipu:cogvideox-3", { aspect: "9:16", resolution: "720p", quality: "high", audio: true }).body, {
    quality: "quality",
    duration: 5,
    with_audio: true,
    fps: 30,
    size: "720x1280",
  });

  assert.deepEqual(wireParams("zhipu:glm-image", { aspect: "16:9", quality: "standard" }).body, { quality: "standard", size: "1728x960" });

  // Muse at auto sends no size at all.
  assert.deepEqual(wireParams("meta:muse-image-1.0", { quality: "fast" }).body, { reasoning_strength: "low", output_format: "webp", n: 1 });

  // Lyria: MP3 is the default and sends nothing; WAV sets response_format; instrumental rides in the prompt.
  assert.deepEqual(wireParams("google:lyria-3.5", {}), { body: {} });
  assert.deepEqual(wireParams("google:lyria-3.5", { outputFormat: "wav", instrumental: true }), {
    body: { response_format: { type: "audio", mime_type: "audio/wav" } },
    promptSuffix: "Instrumental only, no vocals.",
  });
});
