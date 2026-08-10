import { ArrowUp, ChevronDown } from "lucide-react";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { DEFAULT_MODEL, MODEL_LIST, getModel, type ModelInfo } from "@/lib/models";

/**
 * The composer, on the front door.
 *
 * A visitor's first sight of Juno used to be on the far side of a sign-up form:
 * the landing depicted no composer, no aura, no picker. The composer with its
 * aura is the most recognisable object the product owns, so the first thing a
 * user touches after signing in is now visually the thing that sold them.
 *
 * This is a DEPICTION, not a copy of the component: it reuses the real surface
 * class string from chat/composer.tsx (search `composer-surface`), the real
 * `.composer-aura` from globals.css, the real ProviderLogo and the real primary
 * button lighting classes. If any of those change, change this with them — a
 * front door that misdescribes the product is worse than one that shows nothing.
 *
 * The aura is pinned on via `.is-preview` (globals.css, beside the
 * `:focus-within` rule): nothing here is focusable, so it can never light up on
 * its own. aria-hidden + pointer-events-none — it is imagery, not a control, and
 * the whole thing stays server-rendered, keeping the landing at zero client JS.
 */

/** The picker's actual default, read from the registry rather than hardcoded. */
export const HERO_MODEL: ModelInfo = getModel(DEFAULT_MODEL) ?? MODEL_LIST[0];

export function ComposerPreview({ model }: { model: ModelInfo }) {
  return (
    // No mx-auto: the hero flushes every sibling left (eyebrow, h1, lede, CTA
    // row, flagship strip), so a centred composer floated ~176px inboard of all
    // of them on a wide screen — the largest object in the hero, and the only
    // one off the column. max-w-2xl is the lede's measure, so it shares an edge
    // and a width with it. Centring, if wanted, is the hero's call, not this
    // component's.
    <div aria-hidden className="composer-aura-host is-preview pointer-events-none w-full max-w-2xl">
      <div className="composer-aura" />
      <div className="composer-surface relative flex w-full flex-col rounded-composer border border-border/65 bg-card/95 p-3 backdrop-blur sm:p-3.5">
        <p className="px-1 pb-6 pt-1 text-body text-muted-foreground">Ask anything…</p>
        <div className="flex items-center gap-1.5">
          {/* Model trigger — same geometry and voice as model-selector.tsx: 10px
              radius, size-4 logo, the model name in mono. */}
          <span className="inline-flex h-8 items-center gap-1.5 rounded-control px-2 text-[13px] font-medium text-foreground/80">
            <ProviderLogo provider={model.provider} className="size-4 shrink-0 rounded-sm" />
            <span className="font-mono">{model.name}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
          </span>
          {/* Send — the composer's primary action at its real size and radius,
              wearing the same lighting classes as Button's default variant. */}
          <span className="btn-glossy halo-primary ml-auto grid size-9 place-items-center rounded-composer-action bg-primary text-primary-foreground">
            <ArrowUp className="size-4" aria-hidden />
          </span>
        </div>
      </div>
    </div>
  );
}
