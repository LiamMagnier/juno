import type { ResearchEffort } from "@/lib/research/domain";
import type { ReasoningEffort } from "@/types/chat";

/**
 * How hard a research run works, decided from the model and the thinking
 * effort the person already chose.
 *
 * There is no separate depth control. A person who picks a frontier model and
 * turns thinking to max has said what they want — the most thorough answer
 * the product can give — and asking them to say it again in a second menu is
 * the kind of duplicate decision that gets left on its default. The composer
 * shows the depth it derived on the research chip so it is never a surprise,
 * and the chat route derives the same answer from the same inputs so the run
 * cannot disagree with the chip.
 *
 * The score is the model's cost tier (a proxy for capability the catalog
 * already carries) plus the effort rung, plus one for GPT Pro execution.
 */
const EFFORT_RANK: Record<ReasoningEffort, number> = {
  minimal: 0,
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 3,
};

export interface ResearchEffortInputs {
  /** The catalog cost tier, 1..3. Auto mode has none and counts as 2. */
  cost?: 1 | 2 | 3 | null;
  reasoningEffort?: ReasoningEffort | null;
  proMode?: boolean;
}

export function researchEffortFor({ cost, reasoningEffort, proMode = false }: ResearchEffortInputs): ResearchEffort {
  const tier = cost ?? 2;
  // A model with no effort control still thinks; give it the middle rung
  // rather than the floor so a strong non-reasoning model is not sent out
  // as a quick pass.
  const rung = reasoningEffort ? EFFORT_RANK[reasoningEffort] : 1;
  const score = tier + rung + (proMode ? 1 : 0);
  if (score >= 6) return "max";
  if (score >= 4) return "deep";
  if (score >= 2) return "standard";
  return "quick";
}
