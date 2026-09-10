import { ProviderLogo } from "@/components/brand/provider-logo";
import { MODELS, MODELS_BY_PROVIDER, type ModelInfo } from "@/lib/models";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import { staggerDelay } from "@/lib/motion";
import { Section } from "@/components/landing/section";

/**
 * The lineup, straight from the model registry — no hand-maintained marketing
 * list to drift out of date. Everything below is computed at render time from
 * the same data that powers the in-app model picker.
 */

/**
 * Current-generation chat models for a provider: newest first; ties go to the
 * priciest (the frontier line), then the shorter name (the canonical variant).
 */
function currentChat(p: Provider): ModelInfo[] {
  return (MODELS_BY_PROVIDER.get(p) ?? [])
    .filter((m) => m.modality === "chat" && (m.status ?? "current") === "current" && !m.comingSoon)
    .sort(
      (a, b) =>
        (b.released ?? "").localeCompare(a.released ?? "") ||
        b.cost - a.cost ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name)
    );
}

interface Lab {
  provider: Provider;
  label: string;
  flagship: string;
}

// Registry order (Anthropic, OpenAI, Google first) is already editorial — keep it.
const LABS: Lab[] = PROVIDER_LIST.flatMap((p) => {
  const [lead] = currentChat(p);
  return lead ? [{ provider: p, label: PROVIDERS[p].label, flagship: lead.name }] : [];
});

const TOTAL_MODELS = Object.keys(MODELS).length;
// Labs across every modality — Seedance, for one, is video-only and has no chat row.
const TOTAL_LABS = new Set(Object.values(MODELS).map((m) => m.provider)).size;
/** "127" reads like a bug; "120+" reads like a catalog. */
const MODELS_FLOOR = Math.floor(TOTAL_MODELS / 10) * 10;

/**
 * How many labs the hero strip names before the count line takes over.
 *
 * It is a *taste* of the picker, not the picker. Uncapped this was ~13 entries
 * of roughly 147px each: on a 375px phone that is two per row, ~7 rows and
 * ~270px wedged between the CTA and the fold. The full enumeration is what the
 * ModelLineup section below is for, and the count line already states the total.
 */
const STRIP_LABS = 6;

/** Compact strip for the hero: one flagship each, from the first few labs. */
export function FlagshipStrip() {
  return (
    <div>
      {/* DottedDivider's labelled branch is aria-hidden, so "In the picker today"
          never reaches assistive tech and this list was announced as an
          anonymous run of model names in the middle of the hero. */}
      <ul aria-label="Models in the picker today" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2.5">
        {/* Names, not chips: these are inert, and the most clickable-looking
            thing in the hero must not be the one thing that does nothing. */}
        {LABS.slice(0, STRIP_LABS).map(({ provider, label, flagship }) => (
          <li key={provider} className="inline-flex items-center gap-1.5 text-body font-medium text-foreground/80">
            <ProviderLogo provider={provider} label={label} className="size-4 shrink-0" />
            <span className="whitespace-nowrap font-mono">{flagship}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 font-mono text-caption text-muted-foreground">
        {MODELS_FLOOR}+ models · {TOTAL_LABS} labs
      </p>
    </div>
  );
}

/**
 * The lineup as a logo strip and one sentence. It was a grid of raised lab
 * chips with "×N" inventory counts under a "120+ models across 14 labs" H2 —
 * a catalogue page's facts in a marketing section's frame, and the third card
 * grid in a row. The benefit is the choice, not the count.
 */
export function ModelLineup() {
  return (
    <Section
      id="models"
      eyebrow="The lineup"
      heading="Every lab that matters, one picker."
      lede="Pick per message — the conversation carries on. New flagships appear as each provider ships them, without waiting on us."
    >
      <ul className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-4" aria-label="Labs in the picker">
        {LABS.map(({ provider, label, flagship }, i) => (
          <li
            key={provider}
            style={staggerDelay(i, "tight")}
            className="inline-flex items-center gap-2 motion-safe:animate-fade-in [animation-fill-mode:backwards]"
          >
            <ProviderLogo provider={provider} label={label} className="size-6 shrink-0" />
            <span className="flex flex-col leading-tight">
              <span className="text-ui font-medium text-foreground">{label}</span>
              <span className="font-mono text-caption text-muted-foreground">{flagship}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-8 max-w-prose text-body text-muted-foreground">
        {MODELS_FLOOR}+ models across {TOTAL_LABS} labs, and beyond chat: image and video generation (GPT Image, Nano
        Banana, Veo, Grok Imagine, Seedance) and realtime voice — all under the same subscription, all metered the
        same way.
      </p>
    </Section>
  );
}
