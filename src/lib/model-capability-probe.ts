import { geminiEndpoint } from "@/lib/gemini-core";
import { providerRequestModel } from "@/lib/model-request";
import type { ModelInfo } from "@/lib/models";
import { providerAdapterFor, type ProviderAdapter } from "@/lib/provider-routing";
import { providerBaseUrl } from "@/lib/providers";

/**
 * What a capability probe sends, and what a valid answer looks like.
 *
 * PROBE THE TRANSPORT THAT WILL SERVE THE REQUEST. This used to build
 * `${providerBaseUrl(provider)}/chat/completions` with `Authorization: Bearer`
 * for every non-Anthropic provider, which for Google is the OpenAI-compat shim
 * — a surface the chat path never touches (`provider-routing.ts` sends google
 * to the native adapter) — and for OpenAI's `api:"responses"` models is an
 * endpoint they 404 on by design. Both therefore failed the probe, and a failed
 * probe is a hard eligibility gate in /api/chat: every Gemini model and every
 * Responses-only model was silently removed from routing while the transport
 * that actually works was never asked.
 *
 * Pure on purpose — no credentials, no fetch — so the request shape per adapter
 * family is pinned by a test rather than by a live account.
 */
export type ProbeShape = "anthropic" | "openai" | "responses" | "gemini";

export interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  shape: ProbeShape;
  adapter: ProviderAdapter;
}

const PROBE_PROMPT = "Reply with OK.";

export function probeRequestFor(model: ModelInfo, apiKey: string): ProbeRequest | null {
  const adapter = providerAdapterFor(model);
  const requestModel = providerRequestModel(model);

  switch (adapter) {
    case "anthropic-native":
      return {
        adapter,
        shape: "anthropic",
        url: "https://api.anthropic.com/v1/messages",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: { model: requestModel, max_tokens: 1, messages: [{ role: "user", content: PROBE_PROMPT }] },
      };
    case "gemini-native":
      return {
        adapter,
        shape: "gemini",
        // The same host, path and header gemini.ts uses — including the
        // GOOGLE_BASE_URL override, so a proxied deployment probes its proxy.
        url: geminiEndpoint(model, "generateContent"),
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: {
          contents: [{ role: "user", parts: [{ text: PROBE_PROMPT }] }],
          // No thinkingConfig: the probe asks whether the ID is callable, not
          // whether a particular thinking ladder is accepted.
          generationConfig: { maxOutputTokens: 16 },
        },
      };
    case "openai-responses": {
      const base = providerBaseUrl("openai");
      if (!base) return null;
      return {
        adapter,
        shape: "responses",
        url: `${base.replace(/\/+$/, "")}/responses`,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: { model: requestModel, input: PROBE_PROMPT, max_output_tokens: 16, store: false },
      };
    }
    case "openai-compatible": {
      const base = providerBaseUrl(model.provider);
      if (!base) return null;
      return {
        adapter,
        shape: "openai",
        url: `${base.replace(/\/+$/, "")}/chat/completions`,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: { model: requestModel, max_tokens: 1, messages: [{ role: "user", content: PROBE_PROMPT }] },
      };
    }
  }
}

/** Does this body look like a real completion from that transport? */
export function probeResponseLooksValid(shape: ProbeShape, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  switch (shape) {
    case "anthropic":
      return Array.isArray(body.content);
    case "gemini":
      // A blocked-but-served prompt still returns `candidates`; the id being
      // callable is what is being proven here, not the answer's content.
      return Array.isArray(body.candidates);
    case "responses":
      return Array.isArray(body.output) || body.object === "response";
    case "openai":
      return Array.isArray(body.choices);
  }
}

/**
 * Is this failure about the WIRE rather than about the model?
 *
 * A timeout, a rate limit, a gateway error or a rejected account credential
 * says nothing about whether the model id is served — it says the probe never
 * got an answer. Only a request the provider understood and refused (400 / 404
 * / 422 …) is evidence about the model itself, and only that deserves to hide
 * the model for a full day.
 */
export function isTransportFailureStatus(status: number | null | undefined): boolean {
  if (status == null) return true; // network error, abort, DNS — no answer at all
  if (status >= 500) return true;
  return status === 401 || status === 403 || status === 408 || status === 425 || status === 429;
}
