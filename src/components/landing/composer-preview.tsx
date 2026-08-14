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
    // `relative isolate` is load-bearing, not decoration. `.composer-aura` is
    // `position:absolute; z-index:-1` with a 138%-of-parent width — with no
    // positioned ancestor here it resolved its box against the hero <section>
    // and centred itself in the full 1152px column, and with no stacking context
    // its negative z put it behind the page ground. The front door's signature
    // object shipped mispositioned with its light off. chat-view.tsx and the
    // voice gallery both carry `relative isolate` on their hosts for this reason.
    <div aria-hidden className="composer-aura-host is-preview relative isolate pointer-events-none w-full max-w-2xl">
      <div className="composer-aura" />
      {/* `border bg-card`, matching chat/composer.tsx verbatim — this was
          `border-border/65 bg-card/95 backdrop-blur`. On the true-black theme the
          border alpha is the only separation cue the composer has left (its
          shadows are dead there), so /65 dropped the effective edge from 21% to
          ~13.6% and the depiction read flatter than the thing it depicts. The
          blur had nothing behind it to blur on a static hero. */}
      <div className="composer-surface relative flex w-full flex-col rounded-composer border bg-card p-3 sm:p-3.5">
        <p className="px-1 pb-6 pt-1 text-body text-muted-foreground">Ask anything…</p>
        <div className="flex items-center gap-1.5">
          {/* Model trigger — same geometry and voice as model-selector.tsx:
              `rounded-composer-control` (12px), size-4 logo, the model name in
              mono, and the same 12px→13px step at the sm breakpoint. This was
              `rounded-control` (9px) under a comment claiming 10px, so the
              depiction got its most prominent nested control's corner wrong and
              documented a third value while doing it.
              `.composer-chip` is the missing half of that copy: the real trigger
              wears it at REST (model-selector.tsx, search `composer-chip`) for a
              --secondary/.7 fill and a hairline, and without it the front door
              drew the composer's most-used control as bare text on the panel —
              the one nested object a visitor is meant to recognise once they are
              inside. No competing `bg-*`/`border-*` utility here: those are
              emitted after the components layer and would silently win. */}
          <span className="composer-chip inline-flex h-8 items-center gap-1.5 rounded-composer-control px-2 text-label font-medium text-foreground/80 sm:text-ui">
            <ProviderLogo provider={model.provider} className="size-4 shrink-0" />
            <span className="font-mono">{model.name}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
          </span>
          {/* Send — the composer's primary action at its real size, radius and
              lighting. `.composer-primary-action` is the class the real button
              wears (chat/composer.tsx, search `composer-primary-action`): a
              --sheen specular inset plus a coral cast shadow, per theme.
              This carried `btn-glossy halo-primary` under a comment claiming
              they were "the same lighting classes as Button's default variant" —
              Button's default has since moved to `border-primary/90` plus an
              inset sheen and wears neither, so the sentence described nothing
              and the depiction was lit differently from the thing it depicts. */}
          <span className="composer-primary-action ml-auto grid size-9 place-items-center rounded-composer-action bg-primary text-primary-foreground">
            <ArrowUp className="size-4" aria-hidden />
          </span>
        </div>
      </div>
    </div>
  );
}
