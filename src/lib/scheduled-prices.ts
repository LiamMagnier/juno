/**
 * Provider prices with a published end date, read by both rate tables
 * (`pricing.ts` baseRate for billing, `model-metrics.ts` for the picker and the
 * routers) so the two can never disagree about which side of the date it is.
 *
 * Gemini 3.6 / 3.7 / 3.8 Flash, standard tier, per 1M tokens
 * (ai.google.dev/gemini-api/docs/pricing, read 2026-10-04):
 *   input  "$0.75 through December 31, 2026. $1.50 starting January 1, 2027."
 *   output "$3.75 through December 31, 2026. $7.50 starting January 1, 2027."
 * Cached input follows at 10% of input ($0.075 → $0.15), which `tokenRate`
 * already derives, and the Batch/Flex rows stay at 50% of standard, which
 * `batchPriceMultiplier` already applies.
 *
 * Google writes the dates without a time zone; the switch is taken at
 * 00:00 UTC on 2027-01-01.
 *
 * Gemini 4 Argon, standard tier, per 1M tokens (same page, read 2026-10-14):
 *   input   "$2.00 through November 30, 2026." then "$4.00 starting December 1, 2026."
 *   output  "$10.00 through November 30, 2026." then "$20.00 starting December 1, 2026."
 *   caching "$0.10 through November 30, 2026." then "$0.20 starting December 1, 2026."
 * Cached input is 5% of input on both sides of the date, which `computedRate`
 * applies for Argon. No long-context tier. Switch taken at 00:00 UTC 2026-12-01.
 *
 * No other text model Juno routes to has a scheduled change on that page. The
 * Flash TTS models do too, but `metering/unit-prices.ts` already bills those
 * at the 2027 rate.
 */

export interface TokenPrice {
  input: number;
  output: number;
}

export const GEMINI_FLASH_PROMO_ENDS_AT = Date.UTC(2027, 0, 1);

export const GEMINI_FLASH_PROMO_RATE: TokenPrice = { input: 0.75, output: 3.75 };
export const GEMINI_FLASH_2027_RATE: TokenPrice = { input: 1.5, output: 7.5 };

/** Gemini 3.6, 3.7 and 3.8 Flash — not their Lite or TTS siblings. */
export function isGeminiPromoFlash(providerModel: string): boolean {
  return /(?:^|[^\d.])3\.[678]-flash(?!-lite|-tts|-live|-image)/.test(providerModel.toLowerCase());
}

/** The standard rate in force at `at` (the moment the tokens were used). */
export function geminiFlashRate(at: Date | number = Date.now()): TokenPrice {
  const t = typeof at === "number" ? at : at.getTime();
  return t < GEMINI_FLASH_PROMO_ENDS_AT ? GEMINI_FLASH_PROMO_RATE : GEMINI_FLASH_2027_RATE;
}

export const GEMINI_ARGON_INTRO_ENDS_AT = Date.UTC(2026, 11, 1);

export const GEMINI_ARGON_INTRO_RATE: TokenPrice = { input: 2, output: 10 };
export const GEMINI_ARGON_STANDARD_RATE: TokenPrice = { input: 4, output: 20 };

/** Gemini 4 Argon (`gemini-4-argon`), the 4.x frontier tier. */
export function isGeminiArgon(providerModel: string): boolean {
  return providerModel.toLowerCase().includes("4-argon");
}

/** Argon's standard rate in force at `at` (the moment the tokens were used). */
export function geminiArgonRate(at: Date | number = Date.now()): TokenPrice {
  const t = typeof at === "number" ? at : at.getTime();
  return t < GEMINI_ARGON_INTRO_ENDS_AT ? GEMINI_ARGON_INTRO_RATE : GEMINI_ARGON_STANDARD_RATE;
}
