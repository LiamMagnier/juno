import type { ModelInfo } from "@/lib/models";

export const GOOGLE_OMNI_MODEL_ID = "gemini-omni-flash-preview";

export type GoogleOmniVideoPoll =
  | { status: "running"; note?: string }
  | { status: "done"; bytes?: Buffer; url?: string; mimeType?: string; downloadHeaders?: Record<string, string> };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return undefined;
}

/** Keep the catalog and the provider adapter tied to the same exact model id. */
export function isGoogleOmniModel(model: Pick<ModelInfo, "provider" | "providerModel">): boolean {
  return model.provider === "google" && model.providerModel === GOOGLE_OMNI_MODEL_ID;
}

/** Find the video content part across the Interactions API's step/output shapes. */
function findGoogleOmniVideo(value: unknown, depth = 0): UnknownRecord | null {
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGoogleOmniVideo(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  if (typeof value.type === "string" && value.type.toLowerCase() === "video") return value;
  if (isRecord(value.video)) return value.video;

  for (const key of ["steps", "outputs", "output", "content", "response", "result"]) {
    const found = findGoogleOmniVideo(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function decodeVideoData(value: string): Buffer {
  const match = value.match(/^data:[^;,]+;base64,(.+)$/);
  return Buffer.from(match ? match[1] : value, "base64");
}

/**
 * Convert a completed Gemini Omni interaction into the shared video poll
 * result. The response has changed shape across the preview docs (`steps`,
 * `outputs`, and nested `video` content), so the parser deliberately accepts
 * all documented forms while keeping provider-specific parsing testable.
 */
export function parseGoogleOmniInteraction(
  data: unknown,
  modelName = "Gemini Omni Flash",
  downloadHeaders?: Record<string, string>,
): GoogleOmniVideoPoll {
  if (!isRecord(data)) throw new Error(`${modelName} returned an invalid interaction.`);

  const status = typeof data.status === "string" ? data.status.toLowerCase() : "";
  if (["failed", "cancelled", "canceled", "expired"].includes(status)) {
    const error = isRecord(data.error)
      ? firstString(data.error, ["message"])
      : typeof data.error === "string"
        ? data.error
        : undefined;
    throw new Error(`${modelName} failed: ${error ?? (status || "generation error")}`);
  }
  if (!["completed", "done", "succeeded", "success"].includes(status)) {
    return { status: "running", note: status || undefined };
  }

  const part = findGoogleOmniVideo(data);
  if (!part) throw new Error(`${modelName} returned no video — try rephrasing your prompt.`);

  const payload = isRecord(part.video) ? part.video : part;
  const mimeType = firstString(payload, ["mime_type", "mimeType", "contentType"]);
  const bytes = firstString(payload, ["data", "base64", "b64_json", "bytesBase64Encoded"]);
  if (bytes) {
    const safeMime = mimeType?.startsWith("video/") ? mimeType : "video/mp4";
    return { status: "done", bytes: decodeVideoData(bytes), mimeType: safeMime };
  }

  const url = firstString(payload, ["uri", "url", "videoUri"]);
  if (url) {
    return {
      status: "done",
      url,
      mimeType: mimeType?.startsWith("video/") ? mimeType : "video/mp4",
      ...(downloadHeaders ? { downloadHeaders } : {}),
    };
  }
  throw new Error(`${modelName} returned an empty video result — try rephrasing your prompt.`);
}
