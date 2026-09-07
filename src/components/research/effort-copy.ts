import { RESEARCH_EFFORTS, RESEARCH_TIERS, type ResearchEffort } from "@/lib/research/domain";

/**
 * How each research depth is described to a person.
 *
 * The numbers come from the tier table rather than being retyped here, so a
 * retuned tier cannot leave the menu promising a team it no longer sends.
 * The minutes are the tier's wall-clock ceiling halved — a typical run stops
 * on saturation well before the ceiling — and rounded so they read as an
 * estimate rather than a promise.
 */
export interface ResearchEffortCopy {
  value: ResearchEffort;
  label: string;
  /** One line under the label: who goes out and how much they read. */
  summary: string;
  /** A sentence about what the tier is for. */
  note: string;
  /** "~3 min" — the trailing figure on a menu row. */
  eta: string;
}

function eta(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000 / 2));
  return `~${minutes} min`;
}

const LABELS: Record<ResearchEffort, { label: string; note: string }> = {
  quick: { label: "Quick", note: "A focused pass for a narrow question" },
  standard: { label: "Standard", note: "A small team, several angles" },
  deep: { label: "Deep", note: "A full team with follow-up rounds" },
  max: { label: "Max", note: "Everything the tier allows, for hard questions" },
};

export const RESEARCH_EFFORT_COPY: readonly ResearchEffortCopy[] = RESEARCH_EFFORTS.map((value) => {
  const tier = RESEARCH_TIERS[value];
  const team = tier.workers === 1 ? "1 researcher" : `${tier.workers} researchers`;
  return {
    value,
    label: LABELS[value].label,
    summary: `${team} · up to ${tier.pages} pages`,
    note: LABELS[value].note,
    eta: eta(tier.wallClockMs),
  };
});

export function researchEffortLabel(effort: ResearchEffort): string {
  return LABELS[effort].label;
}
