import "server-only";
import OpenAI, { toFile } from "openai";
import { providerApiKey, providerBaseUrl, PROVIDERS } from "@/lib/providers";
import { imageEditSupport, type ModelInfo } from "@/lib/models";
import type { GenerateEditPayload } from "@/types/chat";

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  ext: string;
}

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

type GoogleContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

// Gemini ("Nano Banana") generates images via the native generateContent API,
// not the OpenAI-compatible /images endpoint — so it gets its own path.
async function googleImageRequest(model: ModelInfo, parts: GoogleContentPart[]): Promise<GeneratedImage> {
  const key = providerApiKey("google");
  if (!key) throw new Error("Google API key is not configured.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.providerModel}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
    signal: AbortSignal.timeout(110_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini image generation failed (${res.status}). ${text.slice(0, 160)}`);
  }
  const data = await res.json();
  const outParts: Array<{ inlineData?: { data: string; mimeType?: string } }> =
    data?.candidates?.[0]?.content?.parts ?? [];
  const inline = outParts.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline) throw new Error("Gemini returned no image — try rephrasing your prompt.");
  const mimeType = inline.mimeType ?? "image/png";
  return { bytes: Buffer.from(inline.data, "base64"), mimeType, ext: extFor(mimeType) };
}

async function generateGoogleImage(model: ModelInfo, prompt: string): Promise<GeneratedImage> {
  return googleImageRequest(model, [{ text: prompt }]);
}

async function editGoogleImage(
  model: ModelInfo,
  prompt: string,
  source: SourceImage,
  opts: ImageEditOptions
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
  return googleImageRequest(model, parts);
}

async function minimaxImageRequest(payload: Record<string, unknown>): Promise<GeneratedImage> {
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
  const b64 = data.data?.image_base64?.[0] ?? data.data?.images?.find((i) => i.b64_json || i.base64)?.b64_json ?? data.data?.images?.find((i) => i.base64)?.base64;
  if (b64) return { bytes: Buffer.from(b64, "base64"), mimeType: "image/png", ext: "png" };
  const url = data.data?.image_urls?.[0] ?? data.data?.images?.find((i) => i.url)?.url;
  if (url) return { bytes: await downloadBytes(url), mimeType: "image/png", ext: "png" };
  throw new Error("MiniMax returned no image — try rephrasing your prompt.");
}

async function generateMiniMaxImage(model: ModelInfo, prompt: string): Promise<GeneratedImage> {
  return minimaxImageRequest({
    model: model.providerModel,
    prompt: prompt.slice(0, 1500),
    aspect_ratio: "1:1",
    response_format: "url",
    n: 1,
    prompt_optimizer: true,
  });
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
  return minimaxImageRequest({
    model: model.providerModel,
    prompt: fullPrompt.slice(0, 1500),
    subject_reference: [
      { type: "character", image_file: `data:${source.mimeType};base64,${source.bytes.toString("base64")}` },
    ],
    response_format: "url",
    n: 1,
    prompt_optimizer: true,
  });
}

// OpenAI + xAI (and other OpenAI-compatible labs) expose /images/generations.
async function generateOpenAICompatImage(model: ModelInfo, prompt: string): Promise<GeneratedImage> {
  const apiKey = providerApiKey(model.provider);
  if (!apiKey) throw new Error(`${PROVIDERS[model.provider].label} API key is not configured.`);
  const client = new OpenAI({ apiKey, baseURL: providerBaseUrl(model.provider), maxRetries: 1 });

  const params: OpenAI.Images.ImageGenerateParams = { model: model.providerModel, prompt, n: 1 };
  if (model.provider === "openai") params.size = "1024x1024";

  const result = await client.images.generate(params);
  const item = result.data?.[0];
  if (item?.b64_json) return { bytes: Buffer.from(item.b64_json, "base64"), mimeType: "image/png", ext: "png" };
  if (item?.url) return { bytes: await downloadBytes(item.url), mimeType: "image/png", ext: "png" };
  throw new Error("No image was returned.");
}

// OpenAI-compatible /images/edits: image + optional mask (transparent = edit here).
async function editOpenAICompatImage(
  model: ModelInfo,
  prompt: string,
  source: SourceImage,
  opts: ImageEditOptions
): Promise<GeneratedImage> {
  const apiKey = providerApiKey(model.provider);
  if (!apiKey) throw new Error(`${PROVIDERS[model.provider].label} API key is not configured.`);
  const client = new OpenAI({ apiKey, baseURL: providerBaseUrl(model.provider), maxRetries: 1 });

  // Without a pixel mask the region constraint has to travel in the prompt.
  const fullPrompt = !opts.maskPng && opts.region ? `${prompt}\n\n${regionInstruction(opts.region)}` : prompt;
  const params: OpenAI.Images.ImageEditParams = {
    model: model.providerModel,
    image: await toFile(source.bytes, `source.${extFor(source.mimeType)}`, { type: source.mimeType }),
    prompt: fullPrompt,
    n: 1,
  };
  if (opts.maskPng) params.mask = await toFile(opts.maskPng, "mask.png", { type: "image/png" });

  const result = await client.images.edit(params);
  const item = result.data?.[0];
  if (item?.b64_json) return { bytes: Buffer.from(item.b64_json, "base64"), mimeType: "image/png", ext: "png" };
  if (item?.url) return { bytes: await downloadBytes(item.url), mimeType: "image/png", ext: "png" };
  throw new Error("No edited image was returned.");
}

export async function generateImage(model: ModelInfo, prompt: string): Promise<GeneratedImage> {
  if (model.provider === "google") return generateGoogleImage(model, prompt);
  if (model.provider === "minimax") return generateMiniMaxImage(model, prompt);
  return generateOpenAICompatImage(model, prompt);
}

/** Region/mask-based edit of an existing image. Throws a friendly capability
 * error for providers that can't edit (see imageEditSupport in models.ts). */
export async function editImage(
  model: ModelInfo,
  prompt: string,
  source: SourceImage,
  opts: ImageEditOptions = {}
): Promise<GeneratedImage> {
  if (model.modality !== "image" || imageEditSupport(model.provider) === "none") {
    throw new Error(`${model.name} can't edit images — try GPT Image, Nano Banana, or Grok Imagine.`);
  }
  if (model.provider === "google") return editGoogleImage(model, prompt, source, opts);
  if (model.provider === "minimax") return editMiniMaxImage(model, prompt, source, opts);
  return editOpenAICompatImage(model, prompt, source, opts);
}
