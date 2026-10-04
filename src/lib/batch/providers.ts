import "server-only";

import OpenAI, { toFile } from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic } from "@/lib/anthropic";
import { buildAnthropicThinkingBits } from "@/lib/anthropic-thinking";
import { reasoningCaps } from "@/lib/model-metrics";
import { providerRequestModel } from "@/lib/model-request";
import { isProviderConfigured, providerApiKey, providerBaseUrl } from "@/lib/providers";
import type { ModelInfo } from "@/lib/models";
import {
  anthropicBatchRequest,
  anthropicBatchStatus,
  openAIBatchLine,
  openAIBatchStatus,
  parseAnthropicBatchResult,
  parseOpenAIBatchOutput,
  type BatchItem,
  type BatchItemResult,
  type BatchStatus,
} from "@/lib/batch/parse";
import { isBatchProvider, type BatchProvider } from "@/lib/batch/plan";

/**
 * The network half of the Batch APIs: submit, poll, read results. The shapes
 * are in parse.ts; nothing here decides anything.
 *
 * Tests replace this whole object (`BatchTransport`) — no test reaches a
 * provider, and nothing here is ever retried by the SDK (maxRetries 0, the
 * same rule every billable client in Juno follows).
 */
export interface BatchTransport {
  submit(model: ModelInfo, items: readonly BatchItem[]): Promise<string>;
  status(provider: BatchProvider, batchId: string): Promise<BatchStatus>;
  results(provider: BatchProvider, batchId: string): Promise<BatchItemResult[]>;
}

/** Whether `model`'s provider has a Batch API Juno speaks and a key to call it with. */
export function batchCapable(model: Pick<ModelInfo, "provider">): boolean {
  return isBatchProvider(model.provider) && isProviderConfigured(model.provider);
}

let openai: OpenAI | null = null;
function openAIClient(): OpenAI {
  if (!openai) {
    const apiKey = providerApiKey("openai");
    if (!apiKey) throw new Error("OpenAI API key is not configured.");
    openai = new OpenAI({ apiKey, baseURL: providerBaseUrl("openai"), maxRetries: 0 });
  }
  return openai;
}

/** The output budget the synchronous walk would give: reasoning models get room to think. */
function openAIBody(model: ModelInfo, maxTokens: number): { maxCompletionTokens: number; reasoningEffort: string | null } {
  if (!model.reasoning) return { maxCompletionTokens: maxTokens, reasoningEffort: null };
  // Background prompts are small and structured: no thinking where the model can skip it.
  if (reasoningCaps(model).canDisable) return { maxCompletionTokens: maxTokens, reasoningEffort: "none" };
  return { maxCompletionTokens: maxTokens + 8_192, reasoningEffort: "low" };
}

export const liveBatchTransport: BatchTransport = {
  async submit(model, items) {
    if (model.provider === "anthropic") {
      const requests = items.map((item) => {
        const thinking = buildAnthropicThinkingBits(model.providerModel, item.maxTokens, undefined);
        return anthropicBatchRequest(item, {
          model: providerRequestModel(model),
          maxTokens: thinking.maxTokens,
          thinking: thinking.thinking,
          outputConfig: thinking.outputConfig,
        });
      });
      const batch = await getAnthropic().messages.batches.create({
        requests: requests as unknown as Anthropic.Messages.Batches.BatchCreateParams["requests"],
      });
      return batch.id;
    }
    if (model.provider === "openai") {
      const lines = items.map((item) => {
        const body = openAIBody(model, item.maxTokens);
        return openAIBatchLine(item, { model: providerRequestModel(model), ...body });
      });
      const client = openAIClient();
      const file = await client.files.create({
        file: await toFile(Buffer.from(`${lines.join("\n")}\n`, "utf8"), "juno-batch.jsonl"),
        purpose: "batch",
      });
      const batch = await client.batches.create({
        input_file_id: file.id,
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      });
      return batch.id;
    }
    throw new Error(`No batch API for provider ${model.provider}`);
  },

  async status(provider, batchId) {
    if (provider === "anthropic") {
      const batch = await getAnthropic().messages.batches.retrieve(batchId);
      return anthropicBatchStatus(batch.processing_status);
    }
    const batch = await openAIClient().batches.retrieve(batchId);
    return openAIBatchStatus(batch.status, !!batch.output_file_id);
  },

  async results(provider, batchId) {
    if (provider === "anthropic") {
      const out: BatchItemResult[] = [];
      for await (const row of await getAnthropic().messages.batches.results(batchId)) {
        const parsed = parseAnthropicBatchResult(row);
        if (parsed) out.push(parsed);
      }
      return out;
    }
    const client = openAIClient();
    const batch = await client.batches.retrieve(batchId);
    const out: BatchItemResult[] = [];
    for (const fileId of [batch.output_file_id, batch.error_file_id]) {
      if (!fileId) continue;
      const response = await client.files.content(fileId);
      out.push(...parseOpenAIBatchOutput(await response.text()));
    }
    return out;
  },
};
