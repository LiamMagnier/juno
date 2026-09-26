import { ArrowUp, Plus } from "@/components/ui/icons";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { DEFAULT_MODEL, MODEL_LIST, getModel, type ModelInfo } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { eurPerUsd } from "@/lib/spend";
import { formatEur } from "@/components/landing/eur";
import { Plate } from "@/components/landing/plate";
import { ProductShot, hasProductShot } from "@/components/landing/product-shot";

/**
 * The hero's picture: the product set on a painted plate, the way a gallery
 * hangs a print. The plate is the valley (dawn in light, dusk in dark).
 *
 * What stands on it is the Mac app's own window, rendered offscreen from the
 * snapshot tests with sample data, when that shot exists. Until it does, and
 * as the fallback if it is ever removed, it is a live preview built from the
 * product's real parts: the registry's model, the pricing table's cost for the
 * exchange, the transcript's bubble and chips. Either way nothing on the stage
 * is a hand-drawn imitation of an interface.
 *
 * The window settles into place as the stage scrolls into view (`scroll-settle`,
 * CSS view timeline, off under reduced motion).
 */

const SHOT = "mac-chat-conversation";

/** The flagship on the preview, so the cost chip has digits worth reading. */
const MODEL: ModelInfo = getModel("anthropic:claude-fable-5-1") ?? getModel(DEFAULT_MODEL) ?? MODEL_LIST[0];

const TURN = {
  user: "Which model should review a 40-page contract, and which one for a quick clause check?",
  assistant:
    "For the full read, use the model with the longest context and the strongest reasoning. For a single clause, the fast tier gives the same answer at a tenth of the price.",
  usage: { input: 60, output: 90 },
};

export function HeroStage() {
  const shot = hasProductShot(SHOT);
  return (
    <div className="stage rounded-stage">
      <Plate
        name="valley"
        priority
        sizes="(min-width: 1280px) 1200px, 100vw"
        imageClassName="object-[30%_50%] sm:object-center"
      />
      {shot ? (
        // The real window, bleeding off the stage's lower edge: a whole app
        // does not fit in a hero, and pretending it does shrinks it to a stamp.
        <div className="relative px-4 pt-10 sm:px-[7%] sm:pt-[6%]">
          <div className="scroll-settle stage-window mx-auto max-w-[62rem] overflow-hidden rounded-t-panel">
            <ProductShot
              name={SHOT}
              alt="Juno for Mac: a conversation with Claude Fable, the reply's cost shown under it"
              width={2400}
              height={1500}
              priority
              sizes="(min-width: 1280px) 1000px, 92vw"
            />
          </div>
        </div>
      ) : (
        <div className="relative flex min-h-[26rem] items-center justify-center px-4 py-12 sm:min-h-[34rem] sm:px-10 sm:py-16">
          <LivePreview />
        </div>
      )}
    </div>
  );
}

function LivePreview() {
  const cost = formatEur(estimateCostUsd(MODEL, TURN.usage) * eurPerUsd());
  return (
    <div
      aria-hidden
      inert
      className="scroll-settle stage-window pointer-events-none w-full max-w-[40rem] rounded-panel bg-card/85 p-1 text-left backdrop-blur-xl backdrop-saturate-150"
    >
      <div className="rounded-card bg-background/70 px-5 pb-5 pt-5 sm:px-7 sm:pt-7">
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-card bg-secondary px-4 py-2.5 text-body text-foreground">{TURN.user}</p>
        </div>
        <p className="mt-5 text-body-lg text-foreground">{TURN.assistant}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-caption text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <ProviderLogo provider={MODEL.provider} className="size-3.5 shrink-0" />
            {MODEL.name}
          </span>
          <span className="tabular-nums">{TURN.usage.input + TURN.usage.output} tokens</span>
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 tabular-nums text-primary-ink">
            ~{cost}
          </span>
        </div>
      </div>
      {/* The composer, at rest: the same material the app's composer wears. */}
      <div className="mt-1 flex items-center gap-3 rounded-card bg-background/70 px-4 py-3">
        <Plus className="size-4 text-muted-foreground" />
        <span className="flex-1 text-body text-muted-foreground">Ask a follow-up</span>
        <span className="hidden items-center gap-1.5 font-mono text-caption text-muted-foreground sm:inline-flex">
          <ProviderLogo provider={MODEL.provider} className="size-3.5" />
          {MODEL.name}
        </span>
        <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <ArrowUp className="size-4" />
        </span>
      </div>
    </div>
  );
}
