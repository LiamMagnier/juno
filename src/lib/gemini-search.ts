import "server-only";
import { streamGemini } from "@/lib/gemini";
import type { ModelInfo } from "@/lib/models";
import type { LlmEvent, MessageForModel } from "@/types/llm";

export async function* streamGeminiSearch(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  dynamicContext?: string
): AsyncGenerator<LlmEvent> {
  yield* streamGemini(
    model,
    system,
    history,
    maxTokens,
    signal,
    undefined,
    true,
    undefined,
    dynamicContext
  );
}
