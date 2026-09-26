import { ProviderLogo } from "@/components/brand/provider-logo";
import { MODELS, MODELS_BY_PROVIDER, type ModelInfo } from "@/lib/models";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";

/**
 * Every lab in the picker, one flagship each, drifting under the hero. The
 * page's only marquee: the lineup is breadth, not a list anyone reads item by
 * item, and a static row either truncated it or wrapped it into a paragraph.
 *
 * Computed from the registry at render, like the picker itself. The track is
 * printed twice so the loop is seamless; the copy is aria-hidden, and the
 * first copy carries the list semantics. Pauses on hover and focus; still under
 * reduced motion (globals.css `.marquee-track`).
 */

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

function Track({ hidden = false }: { hidden?: boolean }) {
  return (
    <ul
      aria-label={hidden ? undefined : "Labs in the picker"}
      aria-hidden={hidden || undefined}
      className="flex shrink-0 items-center gap-12 pr-12"
    >
      {LABS.map(({ provider, label, model }) => (
        <li key={provider} className="flex shrink-0 items-center gap-2.5">
          <ProviderLogo provider={provider} label={label} className="size-5 shrink-0 text-foreground/80" />
          <span className="whitespace-nowrap text-body font-medium text-foreground/80">{model}</span>
        </li>
      ))}
    </ul>
  );
}

export function LabMarquee() {
  return (
    <div className="marquee overflow-hidden py-2">
      <div className="marquee-track flex w-max">
        <Track />
        <Track hidden />
      </div>
    </div>
  );
}
