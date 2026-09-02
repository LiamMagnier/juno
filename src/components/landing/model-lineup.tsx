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
  flagships: string[];
  count: number;
}

// Registry order (Anthropic, OpenAI, Google first) is already editorial — keep it.
const LABS: Lab[] = PROVIDER_LIST.map((p) => ({
  provider: p,
  label: PROVIDERS[p].label,
  flagships: currentChat(p)
    .slice(0, 2)
    .map((m) => m.name),
  count: (MODELS_BY_PROVIDER.get(p) ?? []).length,
})).filter((l) => l.flagships.length > 0);

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
      <ul aria-label="Models in the picker today" className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        {/* Names, not chips: these are inert, and the most clickable-looking
            thing in the hero must not be the one thing that does nothing. */}
        {LABS.slice(0, STRIP_LABS).map(({ provider, label, flagships }) => (
          <li key={provider} className="inline-flex items-center gap-1.5 text-body font-medium text-foreground/80">
            <ProviderLogo provider={provider} label={label} className="size-4 shrink-0" />
            <span className="whitespace-nowrap font-mono">{flagships[0]}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 font-mono text-caption text-muted-foreground">
        {MODELS_FLOOR}+ models · {TOTAL_LABS} labs · synced nightly
      </p>
    </div>
  );
}

export function ModelLineup() {
  return (
    <Section
      id="models"
      eyebrow="The lineup"
      heading={`${MODELS_FLOOR}+ models across ${TOTAL_LABS} labs.`}
      lede="Curated and synced nightly from each provider's own catalog, so new flagships appear without waiting on us. Pick per message — the conversation carries on."
    >
      {/* An inset track holding raised lab chips: the picker's own idiom (a
          well, keys standing proud of it). Concentric: the well is
          rounded-card (16) with p-1.5 (6), so the chips sit at rounded-control (10). */}
      <div className="surface-inset mt-10 rounded-card p-1.5">
        <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {LABS.map(({ provider, label, flagships, count }, i) => (
            <li
              key={provider}
              style={staggerDelay(i, "tight")}
              className="surface-raised flex items-center gap-3 rounded-control px-3 py-2.5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              <ProviderLogo provider={provider} label={label} className="size-6 shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{label}</span>
                <span className="block truncate text-caption text-muted-foreground">{flagships.join(" · ")}</span>
              </div>
              <span className="font-mono text-caption tabular-nums text-muted-foreground">×{count}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-6 max-w-prose text-body text-muted-foreground">
        Beyond chat: image and video generation (GPT Image, Nano Banana, Veo, Grok Imagine, Seedance) and realtime
        voice — all under the same subscription, all metered the same way.
      </p>
    </Section>
  );
}
