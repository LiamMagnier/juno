import "server-only";
import OpenAI from "openai";
import { providerApiKey, providerBaseUrl, PROVIDERS } from "@/lib/providers";
import type { ModelInfo } from "@/lib/models";

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  ext: string;
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

// Gemini ("Nano Banana") generates images via the native generateContent API,
// not the OpenAI-compatible /images endpoint — so it gets its own path.
async function generateGoogleImage(model: ModelInfo, prompt: string): Promise<GeneratedImage> {
  const key = providerApiKey("google");
  if (!key) throw new Error("Google API key is not configured.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.providerModel}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini image generation failed (${res.status}). ${text.slice(0, 160)}`);
  }
  const data = await res.json();
  const parts: Array<{ inlineData?: { data: string; mimeType?: string } }> =
    data?.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline) throw new Error("Gemini returned no image — try rephrasing your prompt.");
  const mimeType = inline.mimeType ?? "image/png";
  return { bytes: Buffer.from(inline.data, "base64"), mimeType, ext: extFor(mimeType) };
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

export async function generateImage(model: ModelInfo, prompt: string): Promise<GeneratedImage> {
  if (model.provider === "google") return generateGoogleImage(model, prompt);
  return generateOpenAICompatImage(model, prompt);
}
