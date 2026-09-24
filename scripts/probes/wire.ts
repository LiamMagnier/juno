/**
 * The one request helper the provider probes share (SPEC §5.7).
 *
 * Every probe is a real, paid request, run by the owner with keys, never in
 * CI. The key comes from the same env var the chat adapters read, and the
 * host from the same base-URL override, so a proxied deployment probes its
 * proxy. A key is never printed — only the provider, the HTTP status and the
 * start of what the provider said back.
 */

import { googleNativeBaseUrl, providerApiKey, providerBaseUrl, PROVIDERS, type Provider } from "../../src/lib/providers";

export interface ProbeResult {
  label: string;
  status: number | null;
  /** The whole body, or the network error. The runner prints only its start. */
  body: string;
}

export class MissingKeyError extends Error {}

function keyFor(provider: Provider): string {
  const key = providerApiKey(provider);
  if (!key) throw new MissingKeyError(`${PROVIDERS[provider].label}: set ${PROVIDERS[provider].apiKeyEnv}`);
  return key;
}

async function send(label: string, url: string, init: RequestInit): Promise<ProbeResult> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
    const text = await response.text();
    return { label, status: response.status, body: text };
  } catch (error) {
    return { label, status: null, body: error instanceof Error ? error.message : String(error) };
  }
}

/** POST a JSON body to an OpenAI-shaped host (Chat Completions or Responses). */
export function postOpenAIShaped(
  label: string,
  provider: Provider,
  path: "/chat/completions" | "/responses",
  body: Record<string, unknown>,
): Promise<ProbeResult> {
  const base = (providerBaseUrl(provider) ?? "").replace(/\/+$/, "");
  return send(label, `${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keyFor(provider)}` },
    body: JSON.stringify(body),
  });
}

/** GET from an OpenAI-shaped host (the model list). */
export function getOpenAIShaped(label: string, provider: Provider, path: string): Promise<ProbeResult> {
  const base = (providerBaseUrl(provider) ?? "").replace(/\/+$/, "");
  return send(label, `${base}${path}`, { headers: { authorization: `Bearer ${keyFor(provider)}` } });
}

/** POST to Anthropic's Messages API. */
export function postAnthropic(
  label: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<ProbeResult> {
  return send(label, "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": keyFor("anthropic"),
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** POST to Gemini's native generateContent, the surface the chat adapter uses. */
export function postGemini(label: string, model: string, body: Record<string, unknown>): Promise<ProbeResult> {
  return send(label, `${googleNativeBaseUrl()}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": keyFor("google") },
    body: JSON.stringify(body),
  });
}

/** One function tool in the Chat Completions shape. */
export function chatTool(name: string, properties: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "function", function: { name, description: `probe tool ${name}`, parameters: { type: "object", properties } } };
}

/** A two-step history in the Chat Completions shape: a tool call and its result. */
export function chatToolHistory(assistantExtra: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return [
    { role: "user", content: "What time is it? Use the tool." },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "now", arguments: "{}" } }],
      ...assistantExtra,
    },
    { role: "tool", tool_call_id: "call_1", content: "12:00" },
  ];
}
