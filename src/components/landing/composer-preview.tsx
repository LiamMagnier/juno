import { ArrowUp, ChevronDown, Plus } from "lucide-react";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { DEFAULT_MODEL, MODEL_LIST, getModel, type ModelInfo } from "@/lib/models";

/**
 * The composer, on the front door.
 *
 * The composer is the most recognisable object the product owns, so the first
 * thing a user touches after signing in is visually the thing that sold them.
 *
 * This is a DEPICTION, not a copy of the component: the same Soft UI recipe
 * the real composer is cut from (docs/design/FLAT_UI.md — a raised shell at
 * the panel rung, an inset well for the field, a raised chip for the model
 * trigger, the primary material on send) plus the real ProviderLogo. If the
 * composer's recipe changes, change this with it — a front door that
 * misdescribes the product is worse than one that shows nothing.
 *
 * aria-hidden + pointer-events-none: it is imagery, not a control, and the whole
 * thing stays server-rendered, keeping the landing at zero client JS.
 */

/** The picker's actual default, read from the registry rather than hardcoded. */
export const HERO_MODEL: ModelInfo = getModel(DEFAULT_MODEL) ?? MODEL_LIST[0];

export function ComposerPreview({ model }: { model: ModelInfo }) {
  return (
    // No mx-auto: the hero flushes every sibling left, so the composer shares
    // the lede's edge. `isolate` so the glow layer's -z-10 resolves here.
    <div aria-hidden className="pointer-events-none relative isolate w-full max-w-[40rem]">
      {/* The bloom: a soft coral radial behind the shell, blurred, so the
          composer reads as the warmest object on the page — the landing keeps
          the ambient brand glow the working chat surface deliberately drops
          (the in-product composer is a single quiet surface with no aura). */}
      <div
        aria-hidden
        className="absolute -inset-x-10 -inset-y-8 -z-10 bg-[radial-gradient(60%_70%_at_50%_45%,hsl(var(--primary)/0.18),transparent_70%)] blur-2xl"
      />
      {/* The shell: the same `.composer-surface` the real composer wears — one
          quiet card with a hairline and a low throw, the text directly on it,
          one controls row under it. No inner well: a field in a box is the
          one thing the flat composer never draws. */}
      <div className="composer-surface relative flex w-full flex-col rounded-panel">
        <p className="px-5 pb-6 pt-4 text-body text-muted-foreground">Ask anything…</p>
        <div className="flex items-center gap-1.5 px-3 pb-3 pt-1">
          {/* The `+` and the model chip: the flat chips the real composer uses. */}
          <span className="inline-flex size-9 items-center justify-center rounded-control text-muted-foreground">
            <Plus className="size-4" aria-hidden />
          </span>
          <span className="inline-flex h-9 items-center gap-1.5 rounded-control px-2.5 text-ui font-medium text-foreground/80">
            <ProviderLogo provider={model.provider} className="size-4 shrink-0" />
            <span>{model.name}</span>
            <ChevronDown className="size-3 text-muted-foreground opacity-60" aria-hidden />
          </span>
          {/* Send — the composer's primary action at its real size and material. */}
          <span className="ml-auto grid size-9 place-items-center rounded-full bg-primary text-primary-foreground">
            <ArrowUp className="size-4" aria-hidden strokeWidth={2.25} />
          </span>
        </div>
      </div>
    </div>
  );
}
