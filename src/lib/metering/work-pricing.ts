import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { tokenRate } from "@/lib/pricing";

/**
 * What a hosted Work run's tokens cost, in the integer units the runner's
 * budget guard accumulates (micro-USD per million tokens).
 *
 * Two gaps this closes (docs/pricing/USAGE_METERING_AUDIT.md):
 *  - A model the catalog does not know (a rolling deploy, a custom id the
 *    dispatch route accepted) got NO pricing, and a guard without pricing
 *    counts tokens and bills $0. It is now billed at the dearest catalog rate
 *    of its provider — never at a guess that could be low.
 *  - Cache writes were priced at the input rate; Anthropic bills them at
 *    1.25x (5-minute). The write rate rides along for the guard's premium.
 */
export interface WorkRunPricing {
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion: number;
}

const micro = (usdPerMillion: number) => Math.round(usdPerMillion * 1_000_000);

export function workRunPricing(model: ModelInfo | null, provider: string): WorkRunPricing {
  if (model) {
    const rate = tokenRate(model);
    return {
      inputMicroUsdPerMillion: micro(rate.input),
      outputMicroUsdPerMillion: micro(rate.output),
      cacheWriteMicroUsdPerMillion: micro(Math.max(rate.input, rate.cacheWrite5m)),
    };
  }
  const chat = MODEL_LIST.filter((m) => m.modality === "chat");
  const sameLab = chat.filter((m) => m.provider === provider);
  const pool = sameLab.length > 0 ? sameLab : chat;
  let input = 0;
  let output = 0;
  let cacheWrite = 0;
  for (const m of pool) {
    const rate = tokenRate(m);
    input = Math.max(input, rate.input);
    output = Math.max(output, rate.output);
    cacheWrite = Math.max(cacheWrite, rate.cacheWrite5m, rate.input);
  }
  return {
    inputMicroUsdPerMillion: micro(input),
    outputMicroUsdPerMillion: micro(output),
    cacheWriteMicroUsdPerMillion: micro(cacheWrite),
  };
}
