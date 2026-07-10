import { ProviderLogo } from "@/components/brand/provider-logo";
import { MODELS, MODELS_BY_PROVIDER, type ModelInfo } from "@/lib/models";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
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

/** Compact model-picker-style strip for the hero: one flagship per lab. */
export function FlagshipStrip() {
  return (
    <div>
      <ul className="flex flex-wrap items-center gap-2">
        {LABS.map(({ provider, label, flagships }) => (
          <li
            key={provider}
            className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/70 py-1.5 pl-2 pr-3.5 text-[13px]"
          >
            <ProviderLogo provider={provider} label={label} className="h-5 w-5" />
            <span className="whitespace-nowrap">{flagships[0]}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
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
      <ul className="mt-10 grid gap-x-10 sm:grid-cols-2">
        {LABS.map(({ provider, label, flagships, count }) => (
          <li key={provider} className="flex items-center gap-3 border-t border-border/60 py-3.5">
            <ProviderLogo provider={provider} label={label} className="h-6 w-6" />
            <div className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{label}</span>
              <span className="block truncate text-caption text-muted-foreground">{flagships.join(" · ")}</span>
            </div>
            <span className="font-mono text-caption tabular-nums text-muted-foreground">×{count}</span>
          </li>
        ))}
      </ul>
      <p className="mt-6 max-w-2xl text-sm text-muted-foreground">
        Beyond chat: image and video generation (GPT Image, Nano Banana, Veo, Grok Imagine, Seedance) and realtime
        voice — all under the same subscription, all metered the same way.
      </p>
    </Section>
  );
}
