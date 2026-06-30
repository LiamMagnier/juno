import "server-only";
import OpenAI from "openai";
import { getObjectBytes } from "@/lib/storage";
import { providerApiKey, providerBaseUrl, PROVIDERS, type Provider } from "@/lib/providers";
import type { ModelInfo } from "@/lib/models";
import type { LlmEvent, MessageForModel } from "@/types/llm";

const clients = new Map<Provider, OpenAI>();

function client(provider: Provider): OpenAI {
  const apiKey = providerApiKey(provider);
  if (!apiKey) throw new Error(`${PROVIDERS[provider].label} API key is not configured.`);
  let c = clients.get(provider);
  if (!c) {
    c = new OpenAI({ apiKey, baseURL: providerBaseUrl(provider), maxRetries: 2 });
    clients.set(provider, c);
  }
  return c;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

async function toOpenAIMessages(
  system: string,
  history: MessageForModel[],
  vision: boolean
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "system", content: system }];

  for (const msg of history) {
    if (msg.role === "SYSTEM") continue;
    if (msg.role === "ASSISTANT") {
      out.push({ role: "assistant", content: msg.content || "(no content)" });
      continue;
    }

    if (msg.attachments.length === 0) {
      out.push({ role: "user", content: msg.content || "(no content)" });
      continue;
    }

    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    if (msg.content.trim()) parts.push({ type: "text", text: msg.content });

    for (const att of msg.attachments) {
      try {
        if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType) && vision) {
          const { bytes } = await getObjectBytes(att.storageKey);
          parts.push({
            type: "image_url",
            image_url: { url: `data:${att.mimeType};base64,${Buffer.from(bytes).toString("base64")}` },
          });
        } else if (att.extractedText) {
          parts.push({ type: "text", text: `Attached file "${att.fileName}":\n\n${att.extractedText.slice(0, 100_000)}` });
        } else {
          const note = att.kind === "IMAGE" && !vision ? " — this model cannot view images" : "";
          parts.push({ type: "text", text: `[Attached file "${att.fileName}" (${att.mimeType})${note}.]` });
        }
      } catch {
        parts.push({ type: "text", text: `[Attachment "${att.fileName}" could not be loaded.]` });
      }
    }

    out.push({ role: "user", content: parts });
  }

  return out;
}

/** Stream a completion from any OpenAI-compatible provider (OpenAI, Gemini, GLM, Kimi). */
export async function* streamOpenAICompat(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: "low" | "medium" | "high",
  webSearch?: boolean
): AsyncGenerator<LlmEvent> {
  const messages = await toOpenAIMessages(system, history, model.vision);

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & Record<string, unknown> = {
    model: model.providerModel,
    messages,
    stream: true,
    // Request a final usage chunk on the compat path; without this most
    // providers report usage as null on every chunk. (Gate per-provider only
    // if a specific endpoint ever rejects it.)
    stream_options: { include_usage: true },
  };
  if (reasoningEffort) params.reasoning_effort = reasoningEffort;
  if (model.provider === "openai") {
    // GPT-5 reasoning models count hidden reasoning toward max_completion_tokens,
    // so a tight cap can yield empty/truncated output — give it headroom.
    params.max_completion_tokens = Math.max(maxTokens, 16000);
  } else {
    params.max_tokens = maxTokens;
  }
  // xAI Grok "Live Search" — a request-body extension that returns citations.
  if (webSearch && model.provider === "xai") {
    params.search_parameters = { mode: "auto", return_citations: true };
  }

  const seen = new Set<string>();
  const stream = await client(model.provider).chat.completions.create(params, { signal });
  for await (const chunk of stream) {
    const choiceDelta = chunk.choices?.[0]?.delta;
    // Reasoning models stream their chain-of-thought separately from the answer:
    // DeepSeek/GLM use `reasoning_content`, some others use `reasoning`.
    const reasoning = (choiceDelta as unknown as { reasoning_content?: string; reasoning?: string } | undefined);
    const reasoningText = reasoning?.reasoning_content ?? reasoning?.reasoning;
    if (reasoningText) yield { type: "reasoning", text: reasoningText };
    const delta = choiceDelta?.content;
    if (delta) yield { type: "text", text: delta };
    // xAI surfaces citations (array of URLs) on the streamed chunks.
    const citations = (chunk as unknown as { citations?: string[] }).citations;
    if (citations?.length) {
      const fresh = citations.filter((u) => u && !seen.has(u));
      for (const u of fresh) seen.add(u);
      if (fresh.length) {
        yield {
          type: "sources",
          sources: fresh.map((url) => ({ title: url, url, snippet: "" })),
        };
      }
    }
    if (chunk.usage) yield { type: "usage", input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
  }
}
