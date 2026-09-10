import { ProviderLogo } from "@/components/brand/provider-logo";
import { DEFAULT_MODEL, MODEL_LIST, getModel, type ModelInfo } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { eurPerUsd } from "@/lib/spend";
import { formatEur } from "@/components/landing/eur";

/**
 * The product, in the first viewport.
 *
 * What stood here was a picture of the composer: a box with "Ask anything…"
 * in it, a model chip and a send button, on a coral bloom. It showed the one
 * thing every chat product has and none of the thing Juno sells — the reply,
 * the model that wrote it, and what it cost. This is one exchange from the
 * transcript instead: a user turn, a two-line answer, the model chip, and
 * the per-reply cost chip priced with the same table the app's meter runs.
 *
 * The bloom is gone for the reason globals.css gives beside the composer
 * surface: a halo under the send button is the one thing that made the
 * composer look like an AI demo. The landing was contradicting its own
 * brief.
 *
 * Server-rendered, aria-hidden and inert: imagery, not a control — and zero
 * client JS, which is what keeps the landing free of a bundle of its own.
 */

/**
 * The flagship on the receipt, so the cost chip shows a figure with digits in
 * it; a flash-tier default would price this exchange at a hundredth of a cent
 * and read as a rounding error. Falls through to the picker's real default.
 */
const HERO_MODEL: ModelInfo = getModel("anthropic:claude-fable-5") ?? getModel(DEFAULT_MODEL) ?? MODEL_LIST[0];

/** A short question and a two-line answer — roughly what the sample below weighs. */
const TURN = {
  user: "Which of these three models should I use to review a 40-page contract?",
  assistant:
    "For a full read, the one with the longest context and the strongest reasoning — the flagship. For a quick clause check, the fast tier is a tenth of the price.",
  usage: { input: 60, output: 90 },
};

export function HeroTranscript() {
  const cost = formatEur(estimateCostUsd(HERO_MODEL, TURN.usage) * eurPerUsd());
  return (
    <div aria-hidden className="pointer-events-none w-full max-w-[38rem] text-left">
      {/* The user bubble: `--secondary` at rounded-card, no border, no shadow —
          the Claude/ChatGPT bubble, and the FLAT_UI brief's own recipe. */}
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-card bg-secondary px-4 py-2.5 text-body text-foreground">{TURN.user}</p>
      </div>
      {/* The reply sits directly on the page, as it does in the product:
          the transcript stays flat, and the chips under it are the meter. */}
      <div className="mt-5 pr-6 sm:pr-12">
        <p className="text-body-lg text-foreground">{TURN.assistant}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-caption text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <ProviderLogo provider={HERO_MODEL.provider} className="size-3.5 shrink-0" />
            {HERO_MODEL.name}
          </span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            {TURN.usage.input + TURN.usage.output} tokens
          </span>
          <span aria-hidden>·</span>
          {/* The cost chip — the differentiator, in the ink the app draws it in. */}
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 tabular-nums text-primary-ink">
            ~{cost}
          </span>
        </div>
      </div>
    </div>
  );
}
