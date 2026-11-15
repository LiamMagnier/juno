import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { longContextPricing, tokenRate, type LongContextPricing } from "@/lib/pricing";

/**
 * What a hosted Work run's tokens cost, in the integer units the runner's
 * budget guard accumulates (micro-USD per million tokens).
 *
 * Gaps this closes (docs/pricing/USAGE_METERING_AUDIT.md,
 * docs/handoff/2026-10-31/cost/metering-findings.md M1):
 *  - A model the catalog does not know (a rolling deploy, a custom id the
 *    dispatch route accepted) got NO pricing, and a guard without pricing
 *    counts tokens and bills $0. It is now billed at the dearest catalog rate
 *    of its provider — never at a guess that could be low.
 *  - Cache writes were priced at the input rate; Anthropic bills them at
 *    1.25x (5-minute). The write rate rides along for the guard's premium.
 *  - Cache READS were priced at the input rate too, and the guard's figure is
 *    what the run is billed: a cached run paid 5x and more. The read rate and
 *    the lab's per-request long-context tier now ride along as well.
 */
export interface WorkRunPricing {
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  longContext?: LongContextPricing;
}

const micro = (usdPerMillion: number) => Math.round(usdPerMillion * 1_000_000);

export function workRunPricing(model: ModelInfo | null, provider: string): WorkRunPricing {
  if (model) {
    const rate = tokenRate(model);
    const longContext = longContextPricing(model);
    return {
      inputMicroUsdPerMillion: micro(rate.input),
      outputMicroUsdPerMillion: micro(rate.output),
      cacheWriteMicroUsdPerMillion: micro(Math.max(rate.input, rate.cacheWrite5m)),
      cacheReadMicroUsdPerMillion: micro(rate.cacheRead),
      ...(longContext ? { longContext } : {}),
    };
  }
  const chat = MODEL_LIST.filter((m) => m.modality === "chat");
  const sameLab = chat.filter((m) => m.provider === provider);
  const pool = sameLab.length > 0 ? sameLab : chat;
  // Each bucket at the dearest rate any model of the pool bills for it, in
  // the standard band and, separately, past the lowest long-context threshold
  // in the pool (surcharge included). Above that threshold the guard bills
  // the dearer of the two, so no request size is billed below any catalogued
  // model of the lab.
  const standard = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const long = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let tier: { threshold: number; inclusive: boolean } | null = null;
  for (const m of pool) {
    const rate = tokenRate(m);
    const lc = longContextPricing(m);
    const write = Math.max(rate.cacheWrite5m, rate.input);
    const k = lc?.inputMultiplier ?? 1;
    standard.input = Math.max(standard.input, rate.input);
    standard.output = Math.max(standard.output, rate.output);
    standard.cacheRead = Math.max(standard.cacheRead, rate.cacheRead);
    standard.cacheWrite = Math.max(standard.cacheWrite, write);
    long.input = Math.max(long.input, rate.input * k);
    long.output = Math.max(long.output, rate.output * (lc?.outputMultiplier ?? 1));
    long.cacheRead = Math.max(long.cacheRead, rate.cacheRead * k);
    long.cacheWrite = Math.max(long.cacheWrite, write * k);
    if (lc && (!tier || lc.threshold < tier.threshold)) tier = { threshold: lc.threshold, inclusive: lc.inclusive };
    else if (lc && tier && lc.threshold === tier.threshold) tier.inclusive ||= lc.inclusive;
  }
  const ratio = (dear: number, base: number) => (base > 0 ? dear / base : 1);
  const inputMultiplier = Math.max(
    ratio(long.input, standard.input),
    ratio(long.cacheRead, standard.cacheRead),
    ratio(long.cacheWrite, standard.cacheWrite)
  );
  const outputMultiplier = ratio(long.output, standard.output);
  return {
    inputMicroUsdPerMillion: micro(standard.input),
    outputMicroUsdPerMillion: micro(standard.output),
    cacheWriteMicroUsdPerMillion: micro(standard.cacheWrite),
    cacheReadMicroUsdPerMillion: micro(standard.cacheRead),
    ...(tier && (inputMultiplier > 1 || outputMultiplier > 1)
      ? { longContext: { ...tier, inputMultiplier, outputMultiplier } }
      : {}),
  };
}
