/*
 * What each media model lets a person choose before it generates: aspect
 * ratio, resolution, quality, length, sound, how many, file format.
 *
 * This file is the single source of truth for those choices. The composer
 * reads it to decide which controls to show (and which values each control
 * offers), and the server reads it to clean whatever a client sent before it
 * reaches a provider, so a stale or hand-crafted request can never ask a
 * provider for something it would reject. Nothing here is a guess: every
 * option was read off the provider's own docs on 2026-10-03 (URLs on each
 * entry). Where a doc was silent, the option is left OUT and the gap is listed
 * under `unverified` on that entry, because a control that 400s is worse than
 * a control that isn't there.
 *
 * Values are canonical across providers ("1K", "1080p", "4K", "jpg", "16:9")
 * so a choice survives a model switch wherever the next model has it too.
 * Each choice carries its own `wire` literal for the cases where a provider
 * spells it differently ("4k", "768P", "512", "jpeg", "adaptive").
 *
 * Client-safe: no server-only imports, no models.ts import (ids are the
 * canonical "provider:providerModel" strings).
 */

/** The choices a person can make for one generation. Every key is optional: a model only takes the keys it supports. */
export interface MediaParams {
  /** "16:9", "1:1", or "auto" (the provider picks, from the prompt or the input image). */
  aspect?: string;
  /** Canonical tier: images "0.5K" | "1K" | "2K" | "4K"; video "360p" | "480p" | "512p" | "720p" | "768p" | "1080p" | "4K". */
  resolution?: string;
  /** Provider quality tier, e.g. "auto" | "low" | "medium" | "high" | "xhigh" | "max" | "standard" | "fast". */
  quality?: string;
  /** Length in whole seconds, or "auto" where the provider can pick the length itself. */
  durationSec?: number | "auto";
  /** Native soundtrack on or off. */
  audio?: boolean;
  /** How many outputs one request returns. */
  count?: number;
  /** File format: "png" | "jpg" | "webp" | "mp4" | "mov" | "mp3" | "wav". */
  outputFormat?: string;
  /** Frames per second. */
  fps?: number;
  /** "auto" | "opaque" | "transparent" (GPT Image 2.5 only). */
  background?: string;
  /** Music without vocals. */
  instrumental?: boolean;
}

export type MediaParamKey = keyof MediaParams;
export type MediaKind = "image" | "video" | "audio";

export interface MediaChoice {
  value: string | number;
  /** Short, user-facing name ("Widescreen", "HD", "8s"). */
  label: string;
  /** Secondary text, e.g. the ratio under a friendly aspect name, or "Experimental". */
  detail?: string;
  /** What actually goes on the wire when it differs from `value`. */
  wire?: unknown;
  /** True when choosing this value means sending nothing at all (the provider default). */
  omit?: boolean;
}

interface OptionBase {
  label: string;
  /**
   * Dot path of the request field this option sets, e.g. "size",
   * "generationConfig.imageConfig.aspectRatio", "parameters.durationSeconds".
   * Absent when the option is folded into a composed field (see `composed`)
   * or travels in the prompt.
   */
  field?: string;
  /** How the option reaches the provider, in words, for the plumbing step. */
  wireNote?: string;
}

export interface SelectOption extends OptionBase {
  kind: "select";
  choices: MediaChoice[];
  default: string | number;
}

export interface RangeOption extends OptionBase {
  kind: "range";
  min: number;
  max: number;
  step: number;
  unit: "s" | "outputs";
  default: number | "auto";
  /** Present when the provider can choose the value itself. */
  auto?: { label: string; wire: unknown };
}

export interface ToggleOption extends OptionBase {
  kind: "toggle";
  default: boolean;
  /** Prompt-steered toggles: the sentence appended to the prompt when on. */
  promptSuffix?: string;
}

export type MediaOption = SelectOption | RangeOption | ToggleOption;

/** When `when.key` holds one of `when.in`, `allow.key` may only take one of `allow.in`. */
export interface MediaRule {
  when: { key: MediaParamKey; in: Array<string | number> };
  allow: { key: MediaParamKey; in: Array<string | number | "auto"> };
}

export interface MediaCapabilities {
  modelId: string;
  kind: MediaKind;
  /** The request this maps onto, for the plumbing step. */
  endpoint: string;
  options: Partial<Record<MediaParamKey, MediaOption>>;
  rules?: MediaRule[];
  /** One request field built from several options, e.g. OpenAI's `size` from aspect + resolution. */
  composed?: { field: string; from: MediaParamKey[]; table: Record<string, string> };
  /** Facts the person can't change, worth showing as plain text ("Audio is always on"). */
  fixed?: { audio?: boolean; durationSec?: number; count?: number };
  sources: string[];
  /** What the docs did not settle; each one is left out of `options`. */
  unverified?: string[];
}

// ---------------------------------------------------------------------------
// Shared labels
// ---------------------------------------------------------------------------

// The friendly names Grok's own picker uses where it has one; the ratio rides
// along as `detail` so two "Portrait" entries are never ambiguous.
const ASPECT_NAMES: Record<string, string> = {
  auto: "Auto",
  "1:1": "Square",
  "2:3": "Portrait",
  "3:2": "Landscape",
  "3:4": "Portrait",
  "4:3": "Landscape",
  "4:5": "Portrait",
  "5:4": "Landscape",
  "9:16": "Story",
  "16:9": "Widescreen",
  "21:9": "Cinematic",
  "1:2": "Tall",
  "2:1": "Banner",
  "9:19.5": "Phone",
  "19.5:9": "Phone landscape",
  "9:20": "Tall phone",
  "20:9": "Wide phone",
  "5:2": "Wide banner",
  "1:4": "Tall strip",
  "4:1": "Strip",
  "1:8": "Skyscraper",
  "8:1": "Panorama",
};

function aspects(values: string[], wire?: Record<string, unknown>): MediaChoice[] {
  return values.map((v) => ({
    value: v,
    label: ASPECT_NAMES[v] ?? v,
    detail: v === "auto" ? "Model decides" : v,
    ...(wire && v in wire ? { wire: wire[v] } : {}),
  }));
}

const RES_LABELS: Record<string, string> = {
  "0.5K": "0.5K",
  "1K": "1K",
  "2K": "2K",
  "4K": "4K",
  "360p": "360p",
  "480p": "480p",
  "512p": "512p",
  "720p": "720p",
  "768p": "768p",
  "1080p": "1080p",
};

function resolutions(values: string[], wire: Record<string, unknown>, details: Record<string, string> = {}): MediaChoice[] {
  return values.map((v) => ({
    value: v,
    label: RES_LABELS[v] ?? v,
    wire: wire[v] ?? v,
    ...(details[v] ? { detail: details[v] } : {}),
  }));
}

function seconds(values: number[]): MediaChoice[] {
  return values.map((v) => ({ value: v, label: `${v}s` }));
}

function count(max: number, field = "n"): RangeOption {
  return { kind: "range", label: "Images", min: 1, max, step: 1, unit: "outputs", default: 1, field };
}

// ---------------------------------------------------------------------------
// OpenAI GPT Image
// POST https://api.openai.com/v1/images/generations (OpenAI SDK images.generate)
// ---------------------------------------------------------------------------

const OPENAI_SOURCES = [
  "https://developers.openai.com/api/docs/guides/image-generation",
  "https://developers.openai.com/api/reference/resources/images/methods/generate",
];

// Sizes kept to the ones OpenAI names (the three standard sizes, the 2K/4K
// "popular sizes" and the `1536x864` custom-size example), every one inside the
// documented custom-size limits: edges multiples of 16, ratio within 1:3..3:1,
// 655,360..8,294,400 pixels, longest edge <= 3840. Anything above 2560x1440 is
// "experimental" per OpenAI, hence the 4K detail.
const GPT_IMAGE_2_SIZES: Record<string, string> = {
  "1:1|1K": "1024x1024",
  "1:1|2K": "2048x2048",
  "2:3|1K": "1024x1536",
  "3:2|1K": "1536x1024",
  "16:9|1K": "1536x864",
  "16:9|2K": "2048x1152",
  "16:9|4K": "3840x2160",
  "9:16|1K": "864x1536",
  "9:16|2K": "1152x2048",
  "9:16|4K": "2160x3840",
};

const GPT_IMAGE_1_SIZES: Record<string, string> = {
  "1:1|1K": "1024x1024",
  "2:3|1K": "1024x1536",
  "3:2|1K": "1536x1024",
};

const OPENAI_FORMATS: SelectOption = {
  kind: "select",
  label: "Format",
  field: "output_format",
  default: "png",
  choices: [
    { value: "png", label: "PNG" },
    { value: "jpg", label: "JPG", wire: "jpeg", detail: "Fastest" },
    { value: "webp", label: "WebP" },
  ],
};

function gptImage(modelId: string, generation: "2.5" | "2" | "1"): MediaCapabilities {
  const sizes = generation === "1" ? GPT_IMAGE_1_SIZES : GPT_IMAGE_2_SIZES;
  const quality: MediaChoice[] = [
    { value: "auto", label: "Auto" },
    { value: "low", label: "Low", detail: "Quick drafts" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ];
  if (generation === "2.5") quality.push({ value: "xhigh", label: "Extra high" }, { value: "max", label: "Max" });

  const options: Partial<Record<MediaParamKey, MediaOption>> = {
    aspect: {
      kind: "select",
      label: "Aspect ratio",
      wireNote: "Folded into `size` with resolution.",
      // 1:1 at 1K is exactly what image-gen.ts sends today (`size: "1024x1024"`).
      default: "1:1",
      choices: aspects(generation === "1" ? ["1:1", "2:3", "3:2"] : ["1:1", "2:3", "3:2", "16:9", "9:16"]),
    },
    quality: { kind: "select", label: "Quality", field: "quality", default: "auto", choices: quality },
    outputFormat: { ...OPENAI_FORMATS, wireNote: "`output_compression` (0-100) also applies to jpeg/webp; not exposed." },
    count: count(10),
  };
  if (generation !== "1") {
    options.resolution = {
      kind: "select",
      label: "Resolution",
      wireNote: "Folded into `size` with aspect.",
      default: "1K",
      choices: resolutions(["1K", "2K", "4K"], {}, { "4K": "Experimental" }),
    };
  }
  if (generation === "2.5") {
    // "gpt-image-2.5-sunburst and gpt-image-2.5-flare ... support opaque and
    // transparent backgrounds"; transparency needs png or webp.
    options.background = {
      kind: "select",
      label: "Background",
      field: "background",
      default: "auto",
      choices: [
        { value: "auto", label: "Auto" },
        { value: "opaque", label: "Opaque" },
        { value: "transparent", label: "Transparent" },
      ],
    };
  }

  const rules: MediaRule[] = [];
  if (generation !== "1") {
    rules.push(
      { when: { key: "aspect", in: ["2:3", "3:2"] }, allow: { key: "resolution", in: ["1K"] } },
      { when: { key: "aspect", in: ["1:1"] }, allow: { key: "resolution", in: ["1K", "2K"] } },
    );
  }
  if (generation === "2.5") {
    rules.push({ when: { key: "background", in: ["transparent"] }, allow: { key: "outputFormat", in: ["png", "webp"] } });
  }

  return {
    modelId,
    kind: "image",
    endpoint: "POST /v1/images/generations (OpenAI SDK client.images.generate)",
    options,
    rules,
    composed: {
      field: "size",
      from: generation === "1" ? ["aspect"] : ["aspect", "resolution"],
      // gpt-image-1.x only takes the three standard sizes, so its key is the aspect alone.
      table: generation === "1" ? Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k.split("|")[0], v])) : sizes,
    },
    sources: OPENAI_SOURCES,
    unverified:
      generation === "2"
        ? ["background: transparent is 'in preview' for gpt-image-2, so it is not offered."]
        : generation === "1"
          ? ["background: the reference only says transparency is 'available for supported GPT Image models' without naming gpt-image-1.x."]
          : undefined,
  };
}

// ---------------------------------------------------------------------------
// Google Nano Banana (Gemini image)
// POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// ---------------------------------------------------------------------------

const GEMINI_IMAGE_SOURCES = [
  "https://ai.google.dev/gemini-api/docs/image-generation",
  "https://ai.google.dev/api/generate-content#ImageConfig",
];

const GEMINI_ASPECTS_10 = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const GEMINI_ASPECTS_14 = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
// ImageConfig.imageSize spells the 512px tier as plain "512"; the K must be uppercase.
const GEMINI_SIZE_WIRE = { "0.5K": "512", "1K": "1K", "2K": "2K", "4K": "4K" };

function geminiImage(modelId: string, aspectList: string[], sizes: string[]): MediaCapabilities {
  return {
    modelId,
    kind: "image",
    endpoint: "POST /v1beta/models/{model}:generateContent (generationConfig.imageConfig)",
    options: {
      // "otherwise generates 1:1 squares" when there is no input image to match.
      aspect: { kind: "select", label: "Aspect ratio", field: "generationConfig.imageConfig.aspectRatio", default: "1:1", choices: aspects(aspectList) },
      resolution: {
        kind: "select",
        label: "Resolution",
        field: "generationConfig.imageConfig.imageSize",
        default: "1K",
        choices: resolutions(sizes, GEMINI_SIZE_WIRE),
      },
    },
    sources: GEMINI_IMAGE_SOURCES,
    unverified: [
      "outputFormat: generateContent's ImageResponseFormat lists only image/jpeg, while the Interactions API lists jpeg and png; the generateContent path image-gen.ts uses is not settled, so no format control.",
      "count: no documented number-of-images field for image models (the guide warns the model 'won't always follow' a requested count).",
    ],
  };
}

// ---------------------------------------------------------------------------
// xAI Grok Imagine (image)
// POST https://api.x.ai/v1/images/generations (OpenAI-compatible)
// ---------------------------------------------------------------------------

const XAI_IMAGE_SOURCES = [
  "https://docs.x.ai/developers/model-capabilities/images/generation",
  "https://docs.x.ai/developers/rest-api-reference/inference/images",
  "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2",
];

const XAI_ASPECTS_BASE = ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20"];

function grokImage(modelId: string, is20: boolean): MediaCapabilities {
  const options: Partial<Record<MediaParamKey, MediaOption>> = {
    aspect: {
      kind: "select",
      label: "Aspect ratio",
      field: "aspect_ratio",
      // `auto` is the documented default and what image-gen.ts gets today by sending nothing.
      default: "auto",
      // 21:9 and 5:2 are grok-imagine-image-2.0 additions (migration guide).
      choices: aspects(is20 ? [...XAI_ASPECTS_BASE, "21:9", "5:2"] : XAI_ASPECTS_BASE),
    },
    resolution: { kind: "select", label: "Resolution", field: "resolution", default: "1K", choices: resolutions(["1K", "2K"], { "1K": "1k", "2K": "2k" }) },
    count: count(10),
  };
  if (is20) {
    // "The parameter is only supported for grok-imagine-image-2.0."
    options.quality = {
      kind: "select",
      label: "Quality",
      field: "quality",
      default: "auto",
      choices: [
        { value: "auto", label: "Auto" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", detail: "Finer detail" },
      ],
    };
  }
  return {
    modelId,
    kind: "image",
    endpoint: "POST https://api.x.ai/v1/images/generations (OpenAI SDK; aspect_ratio/resolution/quality are extra body fields)",
    options,
    sources: XAI_IMAGE_SOURCES,
    unverified: [
      "resolution 1.5k: listed in the REST reference enum but not in the guide's 'currently supported' list (1k, 2k), so not offered.",
      "outputFormat: no output format field (only response_format url/b64_json).",
    ],
  };
}

// ---------------------------------------------------------------------------
// Z.AI GLM Image
// POST {zhipu base}/images/generations (OpenAI SDK)
// ---------------------------------------------------------------------------

const GLM_IMAGE: MediaCapabilities = {
  modelId: "zhipu:glm-image",
  kind: "image",
  endpoint: "POST /paas/v4/images/generations",
  options: {
    aspect: {
      kind: "select",
      label: "Aspect ratio",
      wireNote: "Folded into `size` (GLM Image's recommended sizes).",
      default: "1:1",
      choices: aspects(["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"]),
    },
    quality: {
      kind: "select",
      label: "Quality",
      field: "quality",
      default: "high",
      choices: [
        { value: "high", label: "HD", wire: "hd", detail: "About 20s" },
        { value: "standard", label: "Standard", wire: "standard", detail: "About 5 to 10s" },
      ],
    },
  },
  // The doc's recommended sizes, nearest named ratio for each (3:2 is
  // 1568x1056 = 1.48, 4:3 is 1472x1088 = 1.35, 16:9 is 1728x960 = 1.8).
  composed: {
    field: "size",
    from: ["aspect"],
    table: {
      "1:1": "1280x1280",
      "3:2": "1568x1056",
      "2:3": "1056x1568",
      "4:3": "1472x1088",
      "3:4": "1088x1472",
      "16:9": "1728x960",
      "9:16": "960x1728",
    },
  },
  sources: ["https://docs.z.ai/api-reference/image/generate-image", "https://docs.z.ai/guides/image/glm-image"],
  unverified: [
    "count: 'Currently, the array only contains one image', so no count control.",
  ],
};

// ---------------------------------------------------------------------------
// Meta Muse Image
// POST https://api.meta.ai/v1/images/generations (OpenAI-compatible)
// ---------------------------------------------------------------------------

const MUSE_IMAGE: MediaCapabilities = {
  modelId: "meta:muse-image-1.0",
  kind: "image",
  endpoint: "POST https://api.meta.ai/v1/images/generations",
  options: {
    aspect: {
      kind: "select",
      label: "Aspect ratio",
      wireNote: "`size` 'sets the aspect ratio, not the exact pixel size'; auto omits it.",
      default: "auto",
      choices: aspects(["auto", "1:1", "2:3", "3:2"]),
    },
    quality: {
      kind: "select",
      label: "Quality",
      field: "reasoning_strength",
      wireNote: "reasoning_strength: same price either way.",
      default: "high",
      choices: [
        { value: "high", label: "Refined", detail: "Several passes" },
        { value: "fast", label: "Fast", wire: "low", detail: "One pass" },
      ],
    },
    // Muse defaults to webp, which image-gen.ts currently labels image/png.
    outputFormat: {
      kind: "select",
      label: "Format",
      field: "output_format",
      default: "webp",
      choices: [
        { value: "webp", label: "WebP" },
        { value: "png", label: "PNG" },
        { value: "jpg", label: "JPG", wire: "jpeg" },
      ],
    },
    count: count(10),
  },
  composed: { field: "size", from: ["aspect"], table: { "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024" } },
  sources: ["https://dev.meta.ai/docs/image-generation", "https://dev.meta.ai/docs/api-reference/images/create-image"],
  unverified: [
    "aspect 16:9 / 9:16 and others: any 'WxH' sets the ratio, but the accepted ratio and size limits are not documented, so only the sizes Meta shows (1024x1536, 1536x1024) and square are offered.",
  ],
};

// ---------------------------------------------------------------------------
// MiniMax Image-01
// POST {minimax base}/image_generation
// ---------------------------------------------------------------------------

function minimaxImage(modelId: string, live: boolean): MediaCapabilities {
  return {
    modelId,
    kind: "image",
    endpoint: "POST https://api.minimax.io/v1/image_generation",
    options: {
      aspect: {
        kind: "select",
        label: "Aspect ratio",
        field: "aspect_ratio",
        // `1:1` is the documented default and what image-gen.ts sends today.
        default: "1:1",
        choices: aspects(["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"]),
      },
      count: count(9),
    },
    sources: ["https://platform.minimax.io/docs/api-reference/image-generation-t2i", "https://platform.minimax.io/docs/api-reference/image-generation-i2i"],
    unverified: [
      ...(live
        ? ["image-01-live appears only in the image-to-image schema; text-to-image lists image-01 alone. Aspect and count are taken from the image-to-image schema (same /image_generation endpoint)."]
        : []),
      "outputFormat / resolution: no field (custom width/height exists for image-01 only and is not exposed).",
    ],
  };
}

// ---------------------------------------------------------------------------
// Google Veo 3.1
// POST /v1beta/models/{model}:predictLongRunning  { instances: [{ prompt }], parameters: {...} }
// ---------------------------------------------------------------------------

function veo(modelId: string, lite: boolean): MediaCapabilities {
  return {
    modelId,
    kind: "video",
    endpoint: "POST /v1beta/models/{model}:predictLongRunning (parameters.*)",
    options: {
      aspect: { kind: "select", label: "Aspect ratio", field: "parameters.aspectRatio", default: "16:9", choices: aspects(["16:9", "9:16"]) },
      resolution: {
        kind: "select",
        label: "Resolution",
        field: "parameters.resolution",
        default: "720p",
        choices: resolutions(lite ? ["720p", "1080p"] : ["720p", "1080p", "4K"], { "4K": "4k" }),
      },
      durationSec: {
        kind: "select",
        label: "Length",
        field: "parameters.durationSeconds",
        // The parameter table quotes the values as strings ("4", "6", "8"); a
        // proto int field accepts the string form too, so strings are safe.
        wireNote: 'Sent as a string: "4" | "6" | "8".',
        default: 8,
        choices: seconds([4, 6, 8]).map((c) => ({ ...c, wire: String(c.value) })),
      },
    },
    // "1080p (only supports 8s duration), 4k (only supports 8s duration)".
    rules: [{ when: { key: "resolution", in: ["1080p", "4K"] }, allow: { key: "durationSec", in: [8] } }],
    // "Audio: Natively generates audio with video. Always on". One video per request.
    fixed: { audio: true, count: 1 },
    sources: ["https://ai.google.dev/gemini-api/docs/veo"],
    unverified: ["seed / negativePrompt / personGeneration: documented but not part of this pass."],
  };
}

// ---------------------------------------------------------------------------
// Google Gemini Omni Flash
// POST /v1beta/interactions  { model, input, response_format: { type: "video", aspect_ratio, resolution, delivery } }
// ---------------------------------------------------------------------------

// "aspect_ratio": "16:9" | "9:16" (landscape is the default); "resolution":
// "360p" | "720p" | "1080p" | "4k", 720p by default, 1080p and 4K upscaled.
// There is no length field: a clip runs 3-10s and the prompt steers it. Audio
// always comes with the video; one video per interaction.
function geminiOmni(modelId: string): MediaCapabilities {
  return {
    modelId,
    kind: "video",
    endpoint: "POST /v1beta/interactions (response_format.*)",
    options: {
      aspect: { kind: "select", label: "Aspect ratio", field: "response_format.aspect_ratio", default: "16:9", choices: aspects(["16:9", "9:16"]) },
      resolution: {
        kind: "select",
        label: "Resolution",
        field: "response_format.resolution",
        default: "720p",
        choices: resolutions(["360p", "720p", "1080p", "4K"], { "4K": "4k" }, { "360p": "Draft", "1080p": "Upscaled", "4K": "Upscaled" }),
      },
    },
    fixed: { audio: true, count: 1 },
    sources: [
      "https://ai.google.dev/gemini-api/docs/omni",
      "https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash",
    ],
    unverified: ["duration: output is 3-10s but the request has no length field (the prompt steers it), so no length control."],
  };
}

// ---------------------------------------------------------------------------
// xAI Grok Imagine Video
// POST https://api.x.ai/v1/videos/generations → GET /v1/videos/{request_id}
// ---------------------------------------------------------------------------

// Per-model resolutions come from each model page's "pricing per second based
// on resolution" table (docs.x.ai/developers/models/<id>, 2026-10-04): classic
// 480p/720p, 1.5 and 1.5 Lite 480p/720p/1080p.
type GrokVideoVariant = "classic" | "1.5" | "1.5-lite";

function grokVideo(modelId: string, variant: GrokVideoVariant): MediaCapabilities {
  const is15 = variant === "1.5";
  const options: Partial<Record<MediaParamKey, MediaOption>> = {
    aspect: {
      kind: "select",
      label: "Aspect ratio",
      field: "aspect_ratio",
      default: "16:9",
      choices: aspects(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]),
    },
    resolution: {
      kind: "select",
      label: "Resolution",
      field: "resolution",
      default: "480p",
      // "1080p is supported on grok-imagine-video-1.5 for text-to-video and
      // image-to-video"; 1.5 Lite prices 1080p too, so it takes the same three.
      choices: resolutions(variant === "classic" ? ["480p", "720p"] : ["480p", "720p", "1080p"], {}),
    },
    durationSec: { kind: "range", label: "Length", field: "duration", min: 1, max: 15, step: 1, unit: "s", default: 8 },
  };
  if (is15) {
    options.audio = { kind: "toggle", label: "Sound", field: "generate_audio", default: true };
  }
  return {
    modelId,
    kind: "video",
    endpoint: "POST https://api.x.ai/v1/videos/generations → GET /v1/videos/{request_id} (video-gen.ts xaiAdapter)",
    options,
    sources: [
      "https://docs.x.ai/developers/model-capabilities/video/generation",
      "https://docs.x.ai/developers/rest-api-reference/inference/videos",
      `https://docs.x.ai/developers/models/${modelId.slice("xai:".length)}`,
    ],
    unverified: is15
      ? undefined
      : [
          `audio: generate_audio is only documented with grok-imagine-video-1.5, so ${modelId.slice("xai:".length)} gets no sound toggle.`,
          ...(variant === "1.5-lite"
            ? ["inputs: the 1.5 Lite page lists text and image in only (no video editing/extension, no reference voices)."]
            : []),
        ],
  };
}

// ---------------------------------------------------------------------------
// ByteDance Seedance (BytePlus ModelArk)
// POST {ark base}/contents/generations/tasks  (params as top-level body fields)
// ---------------------------------------------------------------------------

const SEEDANCE_SOURCES = [
  "https://docs.byteplus.com/en/docs/ModelArk/1520757",
  "https://docs.byteplus.com/en/docs/modelark/video-generation-tutorial",
];

interface SeedanceSpec {
  resolutions: string[];
  defaultResolution: string;
  min: number;
  max: number;
  defaultDuration: number | "auto";
  autoDuration: boolean;
  adaptive: boolean;
  audio: boolean;
  mov?: boolean;
}

function seedance(modelId: string, s: SeedanceSpec): MediaCapabilities {
  const ratioList = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
  const options: Partial<Record<MediaParamKey, MediaOption>> = {
    aspect: {
      kind: "select",
      label: "Aspect ratio",
      field: "ratio",
      default: s.adaptive ? "auto" : "16:9",
      choices: aspects(s.adaptive ? ["auto", ...ratioList] : ratioList, { auto: "adaptive" }),
    },
    resolution: {
      kind: "select",
      label: "Resolution",
      field: "resolution",
      default: s.defaultResolution,
      choices: resolutions(s.resolutions, { "4K": "4k" }),
    },
    durationSec: {
      kind: "range",
      label: "Length",
      field: "duration",
      min: s.min,
      max: s.max,
      step: 1,
      unit: "s",
      default: s.defaultDuration,
      ...(s.autoDuration ? { auto: { label: "Auto", wire: -1 } } : {}),
    },
  };
  if (s.audio) options.audio = { kind: "toggle", label: "Sound", field: "generate_audio", default: true };
  if (s.mov) {
    options.outputFormat = {
      kind: "select",
      label: "Format",
      field: "output_format",
      default: "mp4",
      choices: [
        { value: "mp4", label: "MP4" },
        // H.264 4:4:4 + PCM audio: for post-production, and many browsers won't play it.
        { value: "mov", label: "MOV", detail: "For editing software" },
      ],
    };
  }
  return {
    modelId,
    kind: "video",
    endpoint: "POST /api/v3/contents/generations/tasks (ratio, resolution, duration, generate_audio, output_format as body fields)",
    options,
    sources: SEEDANCE_SOURCES,
    unverified: ["draft mode / seed / camera_fixed / watermark: documented but not part of this pass."],
  };
}

// ---------------------------------------------------------------------------
// Z.AI CogVideoX-3
// POST {zhipu base}/videos/generations
// ---------------------------------------------------------------------------

const COGVIDEOX: MediaCapabilities = {
  modelId: "zhipu:cogvideox-3",
  kind: "video",
  endpoint: "POST /paas/v4/videos/generations",
  options: {
    aspect: { kind: "select", label: "Aspect ratio", wireNote: "Folded into `size` with resolution.", default: "16:9", choices: aspects(["16:9", "9:16", "1:1"]) },
    resolution: {
      kind: "select",
      label: "Resolution",
      wireNote: "Folded into `size` with aspect.",
      // Omitting size gives a 1080 short side, so 1080p keeps today's output.
      default: "1080p",
      choices: resolutions(["720p", "1080p", "4K"], {}),
    },
    quality: {
      kind: "select",
      label: "Mode",
      field: "quality",
      default: "fast",
      choices: [
        { value: "fast", label: "Fast", wire: "speed" },
        { value: "high", label: "Quality", wire: "quality" },
      ],
    },
    durationSec: { kind: "select", label: "Length", field: "duration", default: 5, choices: seconds([5, 10]) },
    audio: { kind: "toggle", label: "Sound effects", field: "with_audio", default: false },
    fps: {
      kind: "select",
      label: "Frame rate",
      field: "fps",
      default: 30,
      choices: [
        { value: 30, label: "30 fps" },
        { value: 60, label: "60 fps" },
      ],
    },
  },
  rules: [
    { when: { key: "aspect", in: ["1:1"] }, allow: { key: "resolution", in: ["1080p"] } },
    { when: { key: "aspect", in: ["9:16"] }, allow: { key: "resolution", in: ["720p", "1080p"] } },
  ],
  // The documented size enum. 1:1 has a single size (1024x1024), filed under
  // 1080p so the resolution control simply has one choice there.
  composed: {
    field: "size",
    from: ["aspect", "resolution"],
    table: {
      "16:9|720p": "1280x720",
      "16:9|1080p": "1920x1080",
      "16:9|4K": "3840x2160",
      "9:16|720p": "720x1280",
      "9:16|1080p": "1080x1920",
      "1:1|1080p": "1024x1024",
    },
  },
  sources: ["https://docs.z.ai/api-reference/video/generate-video", "https://docs.z.ai/guides/video/cogvideox-3"],
  unverified: [
    "size 2048x1080: in the enum but neither a standard ratio nor explained, so not offered.",
  ],
};

// ---------------------------------------------------------------------------
// MiniMax Hailuo
// POST {minimax base}/video_generation
// ---------------------------------------------------------------------------

function hailuo(modelId: string, imageOnly: boolean): MediaCapabilities {
  return {
    modelId,
    kind: "video",
    endpoint: "POST https://api.minimax.io/v1/video_generation",
    options: {
      resolution: {
        kind: "select",
        label: "Resolution",
        field: "resolution",
        default: "768p",
        choices: resolutions(["768p", "1080p"], { "768p": "768P", "1080p": "1080P" }),
      },
      durationSec: { kind: "select", label: "Length", field: "duration", default: 6, choices: seconds([6, 10]) },
    },
    rules: [{ when: { key: "resolution", in: ["1080p"] }, allow: { key: "durationSec", in: [6] } }],
    sources: ["https://platform.minimax.io/docs/api-reference/video-generation-t2v", "https://platform.minimax.io/docs/api-reference/video-generation-i2v"],
    unverified: [
      "aspect: no aspect ratio field on Hailuo (output follows the model or the first frame).",
      "audio: not documented.",
      ...(imageOnly
        ? ["MiniMax-Hailuo-2.3-Fast is listed only for image-to-video (first_frame_image required); a text-only request is not documented to work. Options are from the image-to-video schema."]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// MiniMax H3 / H3 Max — the V2 video API
// POST https://api.minimax.io/v2/video_generation  { model, content[], resolution, duration, ratio }
// ---------------------------------------------------------------------------

function minimaxH3(modelId: string, fast: boolean): MediaCapabilities {
  // Text-to-video (all Juno sends) requires a concrete ratio: "adaptive" is
  // only for image- and reference-to-video, so it is not offered.
  const ratios = ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"];
  return {
    modelId,
    kind: "video",
    endpoint: "POST https://api.minimax.io/v2/video_generation (resolution, duration, ratio as body fields)",
    options: {
      aspect: { kind: "select", label: "Aspect ratio", field: "ratio", default: "16:9", choices: aspects(ratios) },
      resolution: {
        kind: "select",
        label: "Resolution",
        field: "resolution",
        default: "768p",
        choices: fast
          ? resolutions(["480p", "768p"], { "480p": "480P", "768p": "768P" })
          : resolutions(["768p", "2K"], { "768p": "768P", "2K": "2K" }),
      },
      durationSec: {
        kind: "range",
        label: "Length",
        field: "duration",
        min: fast ? 5 : 4,
        max: 15,
        step: 1,
        unit: "s",
        default: 5,
      },
    },
    sources: [
      "https://platform.minimax.io/docs/api-reference/video-generation-v2-create",
      "https://platform.minimax.io/docs/api-reference/video-generation-v2-query",
    ],
    unverified: [
      "image / reference input: the V2 API takes first/last frames and reference image, video and audio in `content`; Juno sends the text prompt only.",
      ...(fast ? ["extra.prompt_expansion_mode (disabled | balanced | quality): documented for H3 Max, left at its `balanced` default."] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Google Lyria (music)
// POST /v1beta/interactions  { model, input, response_format? }
// ---------------------------------------------------------------------------

const LYRIA_SOURCES = ["https://ai.google.dev/gemini-api/docs/music-generation", "https://ai.google.dev/api/interactions-api"];

// The guide's own instrumental prompt ends with exactly this sentence; Lyria
// has no instrumental field, the prompt is the control.
const INSTRUMENTAL: ToggleOption = {
  kind: "toggle",
  label: "Instrumental",
  default: false,
  promptSuffix: "Instrumental only, no vocals.",
  wireNote: "Prompt-steered: appended to the prompt when on.",
};

function lyria(modelId: string, variant: "3.5" | "pro" | "clip"): MediaCapabilities {
  const options: Partial<Record<MediaParamKey, MediaOption>> = { instrumental: INSTRUMENTAL };
  if (variant === "3.5") {
    options.outputFormat = {
      kind: "select",
      label: "Format",
      field: "response_format",
      default: "mp3",
      choices: [
        { value: "mp3", label: "MP3", omit: true },
        // AudioResponseFormat.mime_type "audio/wav". A full song as WAV is tens of MB of base64.
        { value: "wav", label: "WAV", detail: "Lossless, much larger", wire: { type: "audio", mime_type: "audio/wav" } },
      ],
    };
  }
  return {
    modelId,
    kind: "audio",
    endpoint: "POST /v1beta/interactions",
    options,
    fixed: variant === "clip" ? { durationSec: 30 } : undefined,
    sources: LYRIA_SOURCES,
    unverified: [
      "durationSec: no field; Lyria 3.5 length is 'controllable using prompt' only, and the range is not documented.",
      ...(variant === "pro" ? ["outputFormat: the guide names WAV for Lyria 3.5 only, and Lyria 3 Pro is no longer in the guide's model table."] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const ENTRIES: MediaCapabilities[] = [
  gptImage("openai:gpt-image-2.5-sunburst", "2.5"),
  gptImage("openai:gpt-image-2.5-flare", "2.5"),
  gptImage("openai:gpt-image-2", "2"),
  gptImage("openai:gpt-image-1.5", "1"),
  gptImage("openai:gpt-image-1-mini", "1"),
  gptImage("openai:gpt-image-1", "1"),
  geminiImage("google:gemini-3-pro-image", GEMINI_ASPECTS_10, ["1K", "2K", "4K"]),
  // Nano Banana 2.1: "1K, 2K, and 4K output resolutions (default 1K)" and the
  // wide 1:4 / 4:1 / 1:8 / 8:1 ratios (its model page, 2026-10-10).
  geminiImage("google:gemini-nano-banana-2.1", GEMINI_ASPECTS_14, ["1K", "2K", "4K"]),
  geminiImage("google:gemini-3.1-flash-image", GEMINI_ASPECTS_14, ["0.5K", "1K", "2K", "4K"]),
  // "Gemini 3.1 Flash Lite image model only supports 1K images."
  geminiImage("google:gemini-3.1-flash-lite-image", GEMINI_ASPECTS_10, ["1K"]),
  grokImage("xai:grok-imagine-image-2.0", true),
  // Retired by xAI on 2026-11-02 (then served by 2.0 at quality low).
  grokImage("xai:grok-imagine-image-quality", false),
  grokImage("xai:grok-imagine-image", false),
  GLM_IMAGE,
  MUSE_IMAGE,
  minimaxImage("minimax:image-01", false),
  minimaxImage("minimax:image-01-live", true),

  veo("google:veo-3.1-generate-preview", false),
  veo("google:veo-3.1-fast-generate-preview", false),
  veo("google:veo-3.1-lite-generate-preview", true),
  geminiOmni("google:gemini-omni-1.1-flash"),
  grokVideo("xai:grok-imagine-video", "classic"),
  grokVideo("xai:grok-imagine-video-1.5", "1.5"),
  grokVideo("xai:grok-imagine-video-1.5-lite", "1.5-lite"),
  seedance("seedance:dreamina-seedance-2-5-260628", {
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    min: 4,
    max: 30,
    defaultDuration: "auto",
    autoDuration: true,
    adaptive: true,
    audio: true,
    mov: true,
  }),
  seedance("seedance:dreamina-seedance-2-0-260128", {
    resolutions: ["480p", "720p", "1080p", "4K"],
    defaultResolution: "720p",
    min: 4,
    max: 15,
    defaultDuration: 5,
    autoDuration: true,
    adaptive: true,
    audio: true,
  }),
  seedance("seedance:dreamina-seedance-2-0-fast-260128", {
    resolutions: ["480p", "720p"],
    defaultResolution: "720p",
    min: 4,
    max: 15,
    defaultDuration: 5,
    autoDuration: true,
    adaptive: true,
    audio: true,
  }),
  seedance("seedance:dreamina-seedance-2-0-mini-260615", {
    resolutions: ["480p", "720p"],
    defaultResolution: "720p",
    min: 4,
    max: 15,
    defaultDuration: 5,
    autoDuration: true,
    adaptive: true,
    audio: true,
  }),
  seedance("seedance:seedance-1-5-pro-251215", {
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    min: 4,
    max: 12,
    defaultDuration: 5,
    autoDuration: true,
    adaptive: true,
    audio: true,
  }),
  // Seedance 1.0: text-to-video "Does not support adaptive" and has no generate_audio.
  seedance("seedance:seedance-1-0-pro-250528", {
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "1080p",
    min: 2,
    max: 12,
    defaultDuration: 5,
    autoDuration: false,
    adaptive: false,
    audio: false,
  }),
  seedance("seedance:seedance-1-0-pro-fast-251015", {
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "1080p",
    min: 2,
    max: 12,
    defaultDuration: 5,
    autoDuration: false,
    adaptive: false,
    audio: false,
  }),
  COGVIDEOX,
  hailuo("minimax:MiniMax-Hailuo-2.3", false),
  hailuo("minimax:MiniMax-Hailuo-2.3-Fast", true),
  hailuo("minimax:MiniMax-Hailuo-02", false),
  minimaxH3("minimax:MiniMax-H3", false),
  minimaxH3("minimax:MiniMax-H3-Max", true),

  lyria("google:lyria-3.5", "3.5"),
  lyria("google:lyria-3-pro-preview", "pro"),
  lyria("google:lyria-3-clip-preview", "clip"),
];

const BY_ID: ReadonlyMap<string, MediaCapabilities> = new Map(ENTRIES.map((e) => [e.modelId, e]));

/** Every model with a capability entry, for tests and tooling. */
export const MEDIA_CAPABILITY_IDS: readonly string[] = ENTRIES.map((e) => e.modelId);

/** The options a model offers, or null for a model with nothing to choose (chat models, unknown ids). */
export function capabilitiesFor(modelId: string): MediaCapabilities | null {
  return BY_ID.get(modelId) ?? null;
}

// ---------------------------------------------------------------------------
// Values, defaults, normalisation
// ---------------------------------------------------------------------------

function allowedByOption(option: MediaOption, value: unknown): boolean {
  if (option.kind === "toggle") return typeof value === "boolean";
  if (option.kind === "select") return option.choices.some((c) => c.value === value);
  if (value === "auto") return !!option.auto;
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= option.min &&
    value <= option.max &&
    Number.isInteger((value - option.min) / option.step)
  );
}

/** The values one option can take, before any rule applies. */
export function optionValues(option: MediaOption): Array<string | number | boolean> {
  if (option.kind === "toggle") return [false, true];
  if (option.kind === "select") return option.choices.map((c) => c.value);
  const out: Array<string | number> = option.auto ? ["auto"] : [];
  for (let v = option.min; v <= option.max; v += option.step) out.push(v);
  return out;
}

/** Every option at its default. */
export function defaultParams(modelId: string): MediaParams {
  const caps = capabilitiesFor(modelId);
  if (!caps) return {};
  const out: Record<string, unknown> = {};
  for (const [key, option] of Object.entries(caps.options)) out[key] = option.default;
  return applyRules(caps, out as MediaParams);
}

// Ranks for "nearest" when a value has to move: resolution tiers and seconds.
const RES_RANK: Record<string, number> = {
  "0.5K": 512,
  "360p": 360,
  "480p": 480,
  "512p": 512,
  "720p": 720,
  "768p": 768,
  "1K": 1024,
  "1080p": 1080,
  "2K": 2048,
  "4K": 4096,
};

function rankOf(key: MediaParamKey, value: unknown): number | null {
  if (typeof value === "number") return value;
  if (key === "resolution" && typeof value === "string" && value in RES_RANK) return RES_RANK[value];
  return null;
}

/** The candidate closest to `wanted` (by resolution tier or number), or null when they can't be compared. */
function nearest<T>(key: MediaParamKey, wanted: unknown, candidates: T[]): T | null {
  const target = rankOf(key, wanted);
  if (target == null) return null;
  let best: T | null = null;
  let bestGap = Infinity;
  for (const c of candidates) {
    const r = rankOf(key, c);
    if (r == null) continue;
    const gap = Math.abs(r - target);
    // On a tie, prefer the lower value: cheaper and faster, never a surprise bill.
    if (gap < bestGap || (gap === bestGap && best != null && (rankOf(key, best) ?? 0) > r)) {
      best = c;
      bestGap = gap;
    }
  }
  return best;
}

function clampToRange(option: RangeOption, value: number): number {
  const stepped = option.min + Math.round((value - option.min) / option.step) * option.step;
  return Math.min(option.max, Math.max(option.min, stepped));
}

/**
 * Bring dependent options back inside the rules (Veo 1080p means 8s, GPT Image
 * 3:2 means 1K...). The `when` side wins: it is the coarser, more deliberate
 * choice, and the dependent value moves to its nearest allowed neighbour.
 */
function applyRules(caps: MediaCapabilities, params: MediaParams): MediaParams {
  const out: Record<string, unknown> = { ...params };
  for (const rule of caps.rules ?? []) {
    if (!rule.when.in.includes(out[rule.when.key] as string | number)) continue;
    const current = out[rule.allow.key];
    if (current === undefined || rule.allow.in.includes(current as string | number)) continue;
    const option = caps.options[rule.allow.key];
    const fallback = option && rule.allow.in.includes(option.default as string | number) ? option.default : rule.allow.in[0];
    out[rule.allow.key] = nearest(rule.allow.key, current, rule.allow.in) ?? fallback;
  }
  return out as MediaParams;
}

/**
 * The params a provider will accept for this model: every supported option
 * present, unknown keys dropped, invalid values replaced by the default (a
 * number outside a range is clamped into it), and the cross-option rules
 * applied. The server runs this on whatever the client sent.
 */
export function normalizeParams(modelId: string, input: unknown): MediaParams {
  const caps = capabilitiesFor(modelId);
  if (!caps) return {};
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, option] of Object.entries(caps.options) as Array<[MediaParamKey, MediaOption]>) {
    const value = raw[key];
    if (allowedByOption(option, value)) out[key] = value;
    else if (option.kind === "range" && typeof value === "number" && Number.isFinite(value)) out[key] = clampToRange(option, value);
    else out[key] = option.default;
  }
  return applyRules(caps, out as MediaParams);
}

/**
 * Carry choices across a model switch: a value the new model has is kept, a
 * resolution or length it lacks moves to the nearest one it has (4K on Veo
 * becomes 1080p on Veo Lite, 12s becomes 8s), and anything else falls back to
 * the new model's default.
 */
export function paramsForModelSwitch(fromParams: MediaParams, toModelId: string): MediaParams {
  const caps = capabilitiesFor(toModelId);
  if (!caps) return {};
  const out: Record<string, unknown> = {};
  for (const [key, option] of Object.entries(caps.options) as Array<[MediaParamKey, MediaOption]>) {
    const value = fromParams[key];
    if (value === undefined) out[key] = option.default;
    else if (allowedByOption(option, value)) out[key] = value;
    else if (option.kind === "range" && typeof value === "number") out[key] = clampToRange(option, value);
    else out[key] = nearest(key, value, optionValues(option)) ?? option.default;
  }
  return applyRules(caps, out as MediaParams);
}

/**
 * The values `key` may take given the rest of `params`, for greying out a
 * choice that the current combination rules out (Veo 4s while 4K is on).
 */
export function allowedValues(modelId: string, key: MediaParamKey, params: MediaParams): Array<string | number | boolean> {
  const caps = capabilitiesFor(modelId);
  const option = caps?.options[key];
  if (!caps || !option) return [];
  let values = optionValues(option);
  for (const rule of caps.rules ?? []) {
    if (rule.allow.key !== key) continue;
    if (!rule.when.in.includes(params[rule.when.key] as string | number)) continue;
    values = values.filter((v) => rule.allow.in.includes(v as string | number));
  }
  return values;
}

/**
 * Set one option the way a person means it: the value they picked wins, and an
 * option that rules it out moves instead. Picking 4s on Veo at 1080p drops the
 * resolution to 720p rather than snapping the length back to 8s.
 */
export function applyParamChange(modelId: string, params: MediaParams, key: MediaParamKey, value: unknown): MediaParams {
  const caps = capabilitiesFor(modelId);
  if (!caps) return {};
  const next: Record<string, unknown> = { ...normalizeParams(modelId, params), [key]: value };
  for (const rule of caps.rules ?? []) {
    if (rule.allow.key !== key) continue;
    if (rule.allow.in.includes(value as string | number)) continue;
    if (!rule.when.in.includes(next[rule.when.key] as string | number)) continue;
    const blocker = caps.options[rule.when.key];
    if (!blocker) continue;
    const escapes = optionValues(blocker).filter((v) => !rule.when.in.includes(v as string | number));
    const pick = escapes.includes(blocker.default) ? blocker.default : (nearest(rule.when.key, next[rule.when.key], escapes) ?? escapes[0]);
    if (pick !== undefined) next[rule.when.key] = pick;
  }
  return normalizeParams(modelId, next);
}

// ---------------------------------------------------------------------------
// Wire mapping
// ---------------------------------------------------------------------------

export interface MediaWire {
  /** Fields to deep-merge into the provider request body (nested by the option's dot path). */
  body: Record<string, unknown>;
  /** Text to append to the prompt (prompt-steered options such as Lyria's instrumental). */
  promptSuffix?: string;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== "object") node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * The provider request fields for a set of choices, after normalising them.
 * Plumbing deep-merges `body` into the request it already builds and appends
 * `promptSuffix` to the prompt.
 */
export function wireParams(modelId: string, input: unknown): MediaWire {
  const caps = capabilitiesFor(modelId);
  if (!caps) return { body: {} };
  const params = normalizeParams(modelId, input) as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  const suffixes: string[] = [];

  for (const [key, option] of Object.entries(caps.options) as Array<[MediaParamKey, MediaOption]>) {
    const value = params[key];
    if (option.kind === "toggle") {
      if (option.promptSuffix) {
        if (value === true) suffixes.push(option.promptSuffix);
      } else if (option.field) setPath(body, option.field, value);
      continue;
    }
    if (!option.field) continue;
    if (option.kind === "range") {
      setPath(body, option.field, value === "auto" ? option.auto?.wire : value);
      continue;
    }
    const choice = option.choices.find((c) => c.value === value);
    if (!choice || choice.omit) continue;
    setPath(body, option.field, choice.wire ?? choice.value);
  }

  if (caps.composed) {
    const tableKey = caps.composed.from.map((k) => String(params[k])).join("|");
    const composed = caps.composed.table[tableKey];
    // No entry means "auto" (Muse) or a combination the rules already prevent:
    // either way the provider default is the right thing to send, i.e. nothing.
    if (composed) setPath(body, caps.composed.field, composed);
  }

  return suffixes.length ? { body, promptSuffix: suffixes.join(" ") } : { body };
}
