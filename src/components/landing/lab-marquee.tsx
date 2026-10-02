import { ProviderLogo } from "@/components/brand/provider-logo";
import { MODELS, MODELS_BY_PROVIDER, type ModelInfo } from "@/lib/models";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";

/** Provider logos are read from the current model registry. */

function flagship(p: Provider): ModelInfo | undefined {
  return (MODELS_BY_PROVIDER.get(p) ?? [])
    .filter((m) => m.modality === "chat" && (m.status ?? "current") === "current" && !m.comingSoon)
    .sort(
      (a, b) =>
        (b.released ?? "").localeCompare(a.released ?? "") ||
        b.cost - a.cost ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name)
    )[0];
}

export const LABS = PROVIDER_LIST.flatMap((p) => {
  const lead = flagship(p);
  return lead ? [{ provider: p, label: PROVIDERS[p].label, model: lead.name }] : [];
});

export const TOTAL_LABS = new Set(Object.values(MODELS).map((m) => m.provider)).size;
/** "127" reads like a bug; "120+" reads like a catalogue. */
export const MODELS_FLOOR = Math.floor(Object.keys(MODELS).length / 10) * 10;

export function LabMarquee() {
  return (
    <ul aria-label="Labs in the picker">
      {LABS.map(({ provider, label }) => (
        <li key={provider}>
          <ProviderLogo provider={provider} label={label} className="size-7 text-foreground/80" />
        </li>
      ))}
    </ul>
  );
}
