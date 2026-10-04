import "server-only";
import { openAIImageUsageCostMicroUsd, type OpenAIImageUsage } from "@/lib/metering/unit-prices";
import OpenAI, { toFile } from "openai";
import { providerApiKey, providerBaseUrl, PROVIDERS } from "@/lib/providers";
import { imageEditSupport, type ModelInfo } from "@/lib/models";
import type { GenerateEditPayload } from "@/types/chat";
import type { MediaWire } from "@/lib/media-params";
import {
  imageFrom,
  minimaxImageBody,
  minimaxImageItems,
  openAIImageEditExtras,
  openAIImageGenerateBody,
  openAIImageItems,
  requestGeminiImage,
  type GeneratedImage,
  type GoogleContentPart,
} from "@/lib/media-gen-core";

export type { GeneratedImage } from "@/lib/media-gen-core";

export interface SourceImage {
  bytes: Buffer;
  mimeType: string;
}

export interface ImageEditOptions {
  /** PNG mask at the source's natural size — transparent pixels mark the area to edit. */
  maskPng?: Buffer;
  region?: NonNullable<GenerateEditPayload["region"]>;
}

async function downloadBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not download the generated image.");
  return Buffer.from(await res.arrayBuffer());
}

function extFor(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

/** Turn a normalized 0..1 region into a plain-language edit constraint. */
function regionInstruction(region: NonNullable<ImageEditOptions["region"]>): string {
  const pct = (n: number) => `${Math.round(Math.min(Math.max(n, 0), 1) * 100)}%`;
  return (
    `Edit ONLY the rectangular region spanning ${pct(region.x)}–${pct(region.x + region.w)} of the image width ` +
    `and ${pct(region.y)}–${pct(region.y + region.h)} of the image height, measured from the top-left corner. ` +
    `Preserve everything outside that region exactly as it is.`
  );
}

// Gemini ("Nano Banana") generates images via the native generateContent API,
// not the OpenAI-compatible /images endpoint — so it gets its own path
// (media-gen-core.ts requestGeminiImage, where the tests reach it).
async function googleImageRequest(
  model: ModelInfo,
  parts: GoogleContentPart[],
  wire: MediaWire | null,
  opts: { edit?: boolean } = {}
): Promise<GeneratedImage> {
  const key = providerApiKey("google");
  if (!key) throw new Error("Google API key is not configured.");
  return requestGeminiImage(model, parts, wire, { apiKey: key }, opts);
}

async function generateGoogleImage(model: ModelInfo, prompt: string, wire: MediaWire | null): Promise<GeneratedImage[]> {
  return [await googleImageRequest(model, [{ text: prompt }], wire)];
}

async function editGoogleImage(
  model: ModelInfo,
  prompt: string,
  source: SourceImage,
  opts: ImageEditOptions,
  wire: MediaWire | null
): Promise<GeneratedImage> {
  const parts: GoogleContentPart[] = [
    { inlineData: { mimeType: source.mimeType, data: source.bytes.toString("base64") } },
  ];
  let instruction: string;
  if (opts.maskPng) {
    parts.push({ inlineData: { mimeType: "image/png", data: opts.maskPng.toString("base64") } });
    instruction =
      `The first image is the source photo. The second image is a mask: its transparent pixels mark the ONLY area to change. ` +
      `Apply this edit inside the masked area: ${prompt}. ` +
      `Everything outside the masked area must be preserved pixel-exactly — identical composition, colors, and detail.`;
  } else if (opts.region) {
    instruction = `Edit the provided image: ${prompt}. ${regionInstruction(opts.region)}`;
  } else {
    instruction = `Edit the provided image: ${prompt}`;
  }
  parts.push({ text: instruction });
  return googleImageRequest(model, parts, wire, { edit: true });
}

async function minimaxImageRequest(payload: Record<string, unknown>, max = 1): Promise<GeneratedImage[]> {
  const apiKey = providerApiKey("minimax");
  if (!apiKey) throw new Error("MiniMax API key is not configured.");
  const base = (providerBaseUrl("minimax") ?? "https://api.minimax.io/v1").replace(/\/$/, "");
  const res = await fetch(`${base}/image_generation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(110_000),
  });
  const text = await res.text();
  let data: {
    data?: { image_urls?: string[]; image_base64?: string[]; images?: Array<{ url?: string; b64_json?: string; base64?: string }> };
    base_resp?: { status_code?: number; status_msg?: string };
  } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok || (data.base_resp?.status_code != null && data.base_resp.status_code !== 0)) {
    throw new Error(`MiniMax image generation failed (${res.status}). ${(data.base_resp?.status_msg || text).slice(0, 160)}`);
  }
  const items = minimaxImageItems(data, max);
  if (!items.length) throw new Error("MiniMax returned no image — try rephrasing your prompt.");
  return Promise.all(items.map(async (item) => imageFrom(item.b64 ? Buffer.from(item.b64, "base64") : await downloadBytes(item.url!), "png")));
}

async function generateMiniMaxImage(model: ModelInfo, prompt: string, wire: MediaWire | null, count: number): Promise<GeneratedImage[]> {
  return minimaxImageRequest(minimaxImageBody(model.providerModel, prompt, wire), count);
}

// MiniMax has no mask endpoint — the source goes in as a subject reference and
// the region (if any) is conveyed in the prompt text.
async function editMiniMaxImage(
  model: ModelInfo,
  prompt: string,
  source: SourceImage,
  opts: ImageEditOptions
): Promise<GeneratedImage> {
  const fullPrompt = opts.region ? `${prompt}\n\n${regionInstruction(opts.region)}` : prompt;
  const [image] = await minimaxImageRequest({
    model: model.providerModel,
    prompt: fullPrompt.slice(0, 1500),
    subject_reference: [
      { type: "character", image_file: `data:${source.mimeType};base64,${source.bytes.toString("base64")}` },
    ],
    response_format: "url",
    n: 1,
    prompt_optimizer: true,
  });
  return image;
}

/** Stamp the response's token cost on its first image (OpenAI GPT Image only). */
function withProviderCost(model: ModelInfo, images: GeneratedImage[], usage: OpenAIImageUsage | undefined): GeneratedImage[] {
  if (model.provider !== "openai" || images.length === 0) return images;
  const cost = openAIImageUsageCostMicroUsd(model.id, usage);
  if (cost == null) return images;
  return [{ ...images[0], providerCostMicroUsd: cost }, ...images.slice(1)];
}

// OpenAI + xAI (and other OpenAI-compatible labs) expose /images/generations.
async function generateOpenAICompatImage(model: ModelInfo, prompt: string, wire: MediaWire | null, count: number): Promise<GeneratedImage[]> {
  const apiKey = providerApiKey(model.provider);
  if (!apiKey) throw new Error(`${PROVIDERS[model.provider].label} API key is not configured.`);
  // Image generation is a paid, non-idempotent operation. Do not let the SDK
  // silently create a second image when the first request's response is lost.
  const client = new OpenAI({ apiKey, baseURL: providerBaseUrl(model.provider), maxRetries: 0 });

  // Extra fields (xAI's aspect_ratio / resolution, Muse's reasoning_strength)
  // are not in the SDK's types; the SDK posts the body as given.
  const params = openAIImageGenerateBody(model, prompt, wire) as unknown as OpenAI.Images.ImageGenerateParamsNonStreaming;
  const format = typeof wire?.body.output_format === "string" ? wire.body.output_format : null;

  const result = await client.images.generate(params);
  const items = openAIImageItems(result, count);
  if (!items.length) throw new Error("No image was returned.");
  // The bytes say what the file is; the format asked for is only the fallback.
  const images = await Promise.all(
    items.map(async (item) => imageFrom(item.b64 ? Buffer.from(item.b64, "base64") : await downloadBytes(item.url!), format))
  );
  return withProviderCost(model, images, (result as { usage?: OpenAIImageUsage }).usage);
}

// OpenAI-compatible /images/edits: image + optional mask (transparent = edit here).
async function editOpenAICompatImage(
  model: ModelInfo,
  prompt: string,
  source: SourceImage,
  opts: ImageEditOptions,
  wire: MediaWire | null
): Promise<GeneratedImage> {
  const apiKey = providerApiKey(model.provider);
  if (!apiKey) throw new Error(`${PROVIDERS[model.provider].label} API key is not configured.`);
  // Image edits are also non-idempotent; retries must be explicit and metered.
  const client = new OpenAI({ apiKey, baseURL: providerBaseUrl(model.provider), maxRetries: 0 });

  // A mask only travels when the provider can read one. This path is shared by
  // "mask" providers (OpenAI, xAI, Z.ai) and, since Muse Image, by a "prompt"
  // one — and Meta's /v1/images/edits documents a prompt plus reference images,
  // no `mask` field. Posting one anyway is a multipart part the endpoint never
  // asked for, and it would silently take the place of the region instruction
  // that IS the only way to scope an edit there.
  const usableMask = imageEditSupport(model.provider) === "mask" ? opts.maskPng : undefined;
  // Without a pixel mask the region constraint has to travel in the prompt.
  const fullPrompt = !usableMask && opts.region ? `${prompt}\n\n${regionInstruction(opts.region)}` : prompt;
  const params: OpenAI.Images.ImageEditParams = {
    model: model.providerModel,
    image: await toFile(source.bytes, `source.${extFor(source.mimeType)}`, { type: source.mimeType }),
    prompt: fullPrompt,
    n: 1,
  };
  if (usableMask) params.mask = await toFile(usableMask, "mask.png", { type: "image/png" });
  const extras = openAIImageEditExtras(model, wire);
  Object.assign(params, extras);
  const format = typeof extras.output_format === "string" ? extras.output_format : null;

  const result = await client.images.edit(params as OpenAI.Images.ImageEditParamsNonStreaming);
  const [item] = openAIImageItems(result, 1);
  const usage = (result as { usage?: OpenAIImageUsage }).usage;
  if (item?.b64) return withProviderCost(model, [imageFrom(Buffer.from(item.b64, "base64"), format)], usage)[0];
  if (item?.url) return withProviderCost(model, [imageFrom(await downloadBytes(item.url), format)], usage)[0];
  throw new Error("No edited image was returned.");
}

/**
 * Generate one or more images. `wire` carries the person's choices
 * (media-params.ts wireParams); null sends today's request unchanged. `count`
 * caps how many results are kept: the provider is asked for that many through
 * `n` in `wire`, and a provider that returns more is not trusted to bill less.
 */
export async function generateImage(
  model: ModelInfo,
  prompt: string,
  wire: MediaWire | null = null,
  count = 1
): Promise<GeneratedImage[]> {
  if (model.provider === "google") return generateGoogleImage(model, prompt, wire);
  if (model.provider === "minimax") return generateMiniMaxImage(model, prompt, wire, count);
  return generateOpenAICompatImage(model, prompt, wire, count);
}

/** Region/mask-based edit of an existing image. Throws a friendly capability
 * error for providers that can't edit (see imageEditSupport in models.ts). */
export async function editImage(
  model: ModelInfo,
  prompt: string,
  source: SourceImage,
  opts: ImageEditOptions = {},
  wire: MediaWire | null = null
): Promise<GeneratedImage> {
  if (model.modality !== "image" || imageEditSupport(model.provider) === "none") {
    throw new Error(`${model.name} can't edit images — try GPT Image, Nano Banana, or Grok Imagine.`);
  }
  if (model.provider === "google") return editGoogleImage(model, prompt, source, opts, wire);
  if (model.provider === "minimax") return editMiniMaxImage(model, prompt, source, opts);
  return editOpenAICompatImage(model, prompt, source, opts, wire);
}
