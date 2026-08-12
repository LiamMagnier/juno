/**
 * Model and reasoning-effort presentation.
 *
 * NOT a catalog. The catalog comes from main over `chat:models`, because a
 * hardcoded list in the renderer is wrong the day the backend adds a model and
 * cannot know which entries the signed-in user's plan actually includes. What
 * lives here is only the vocabulary needed to *label* what main sends.
 *
 * The effort ladder is the web's `REASONING_TIERS`, and `null` is a seventh
 * rung rather than an absence — "Instant" is a choice the user makes, not the
 * lack of one, and models differ in whether they allow it.
 */

import type { ModelDescriptor, ReasoningEffort } from '../contract.js';

export const REASONING_TIERS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * Short labels. Chosen to read as depth rather than as a setting value —
 * "Extended" says something to a user in a way that "xhigh" does not.
 */
const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  minimal: 'Minimal',
  low: 'Brief',
  medium: 'Balanced',
  high: 'Thorough',
  xhigh: 'Extended',
  max: 'Exhaustive',
};

export function effortLabel(effort: ReasoningEffort | null): string {
  return effort === null ? 'Instant' : EFFORT_LABELS[effort];
}

/**
 * One line explaining what the choice costs and buys.
 *
 * Shown in the picker, because "high vs xhigh" is meaningless without it and
 * the alternative is a user who picks the top rung every time and then wonders
 * why replies are slow.
 */
export function effortDescription(effort: ReasoningEffort | null): string {
  switch (effort) {
    case null:
      return 'Answers immediately, with no thinking step.';
    case 'minimal':
      return 'A moment of thought. Best for lookups and short edits.';
    case 'low':
      return 'Brief reasoning. Good for everyday questions.';
    case 'medium':
      return 'The usual balance of speed and care.';
    case 'high':
      return 'Works the problem through. Slower, and noticeably better on hard questions.';
    case 'xhigh':
      return 'Extended reasoning for multi-step problems. Expect a wait.';
    case 'max':
      return 'Everything the model has. For the hardest questions only.';
  }
}

/**
 * The effort options a model actually supports, with `null` first when allowed.
 *
 * Reading `reasoningTiers` from the descriptor rather than showing all six is
 * what stops the picker offering "Exhaustive" on a model that will silently
 * clamp it to "Thorough" — a setting that appears to do something and does not.
 */
export function effortOptionsFor(
  model: ModelDescriptor | undefined,
): readonly (ReasoningEffort | null)[] {
  if (!model || model.reasoningTiers.length === 0) return [];
  return model.canDisableReasoning ? [null, ...model.reasoningTiers] : model.reasoningTiers;
}

/** Clamp a remembered effort onto what the newly-selected model supports. */
export function clampEffort(
  effort: ReasoningEffort | null,
  model: ModelDescriptor | undefined,
): ReasoningEffort | null {
  const options = effortOptionsFor(model);
  if (options.length === 0) return null;
  if (options.includes(effort)) return effort;
  /* Fall to the highest supported tier at or below the request, rather than to
     a default — someone who asked for "max" on a model that stops at "high"
     wants "high", not "balanced". */
  const wanted = effort === null ? -1 : REASONING_TIERS.indexOf(effort);
  let best: ReasoningEffort | null = options[0] ?? null;
  for (const option of options) {
    if (option === null) continue;
    const rank = REASONING_TIERS.indexOf(option);
    if (rank <= wanted) best = option;
  }
  return best;
}

/**
 * The bit of `provider:slug` worth showing when there is no display name.
 *
 * Falls back to the whole id rather than to "Unknown": an id the user can read
 * and search for is far more useful than a placeholder, and this path is only
 * reached when main sent something unexpected.
 */
export function modelLabel(models: readonly ModelDescriptor[], id: string | null): string {
  if (id === null) return 'Assistant';
  const found = models.find((model) => model.id === id);
  if (found) return found.name;
  const slug = id.includes(':') ? (id.split(':')[1] ?? id) : id;
  return slug;
}
