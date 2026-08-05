/**
 * Enforcement of the tool-selection hierarchy.
 *
 * The rule the domain states is refusal, not preference, and the distinction
 * is the whole module. A preference is a hint the model may decline: asked to
 * archive a thread, a model that finds the Gmail connector fiddly will take a
 * screenshot and click, and the run is then slower, less reliable, needs
 * screen-recording permission it did not need, and has put the user's inbox
 * into an image. A refusal removes that choice — the visual click is denied
 * while a healthy connector has declared it can do the same thing, and the
 * denial names the connector so the model's next attempt is the right one.
 *
 * `healthy` is what keeps the rule from becoming a trap. A connector whose
 * token expired is still tier 1 for its intent; refusing every lower tier
 * because of it would leave the run unable to do the work at all, which is a
 * worse outcome than the browser. Health is asked per call and never cached,
 * because a token that expires mid-run must change the answer mid-run.
 */

import {
  permitsTier,
  toolTier,
  WORK_TOOL_TIERS,
  type WorkAuditIntent,
  type WorkToolCandidate,
  type WorkToolDefinition,
} from './types.js';

export interface TierRequest {
  /** The tool-independent thing being attempted, e.g. "email.archive". */
  intent: string;
  /** The tool the run wants to use. */
  chosen: string;
  /** Every tool that declared it can serve this intent, including `chosen`. */
  candidates: readonly WorkToolCandidate[];
}

export interface TierRefusalTarget {
  tool: string;
  tier: number;
  label: string;
}

export type TierDecision =
  | { allowed: true; tier: number; reason: string }
  | {
      allowed: false;
      tier: number;
      reason: string;
      /** The tool that should have been used, when there is one. */
      better?: TierRefusalTarget;
      /** Ready to hand to the audit writer as `tier_downgrade_refused`. */
      audit: WorkAuditIntent;
    };

export function describeTier(id: string): string {
  return WORK_TOOL_TIERS.find((t) => t.id === id)?.label ?? id;
}

/** The healthy candidate on the highest rung, or undefined when none is. */
export function bestCandidate(
  candidates: readonly WorkToolCandidate[],
): WorkToolCandidate | undefined {
  let best: WorkToolCandidate | undefined;
  for (const candidate of candidates) {
    if (!candidate.healthy) continue;
    if (!best || toolTier(candidate.tier) < toolTier(best.tier)) best = candidate;
  }
  return best;
}

/**
 * Every tool that has declared it can serve an intent, as candidates.
 *
 * Health is resolved here, at the moment of the decision, rather than stored
 * on the definition.
 */
export function candidatesForIntent(
  tools: readonly WorkToolDefinition[],
  intent: string,
): WorkToolCandidate[] {
  return tools
    .filter((tool) => tool.intents.includes(intent))
    .map((tool) => ({
      tool: tool.spec.name,
      tier: tool.tier,
      healthy: tool.isHealthy ? tool.isHealthy() : true,
    }));
}

/**
 * The tier number as an audit row should carry it.
 *
 * `toolTier` returns MAX_SAFE_INTEGER for an unknown id so that comparisons
 * sort it last, which is right for the comparison and wrong for a stored
 * value: 9007199254740991 in an audit detail reads as corruption. Zero means
 * "not on the hierarchy" and no rung is ever numbered zero.
 */
function auditTier(id: string): number {
  const tier = toolTier(id);
  return tier === Number.MAX_SAFE_INTEGER ? 0 : tier;
}

function refusalAudit(
  intent: string,
  chosen: { tool: string; tier: string },
  better?: TierRefusalTarget,
): WorkAuditIntent {
  const detail: Record<string, string | number | boolean> = {
    intent,
    chosen: chosen.tool,
    chosenTier: auditTier(chosen.tier),
  };
  if (better) {
    detail.better = better.tool;
    detail.betterTier = better.tier;
  }
  // Identifiers and verdicts only: the tool input is deliberately absent,
  // because an audit row is read by support and a search query or recipient
  // list has no business being in one.
  return { kind: 'tier_downgrade_refused', severity: 'refusal', detail };
}

/**
 * Decide one call against the hierarchy.
 *
 * Refuses in four cases, each with a different reason string, because "denied"
 * on its own tells the model nothing it can act on:
 *
 *   - the tool never declared it serves this intent, which means the caller
 *     wired an intent to a tool that cannot do it;
 *   - the tool is on no rung of the hierarchy at all;
 *   - the tool itself is unhealthy;
 *   - a healthy tool sits on a higher rung.
 */
export function evaluateTier(request: TierRequest): TierDecision {
  const chosen = request.candidates.find((c) => c.tool === request.chosen);
  if (!chosen) {
    return {
      allowed: false,
      tier: Number.MAX_SAFE_INTEGER,
      reason: `${request.chosen} has not declared that it can serve ${request.intent}, so it must not be used for it.`,
      audit: refusalAudit(request.intent, { tool: request.chosen, tier: '' }),
    };
  }

  const chosenTier = toolTier(chosen.tier);
  if (chosenTier === Number.MAX_SAFE_INTEGER) {
    return {
      allowed: false,
      tier: chosenTier,
      reason: `${chosen.tool} is not on any tier of the tool hierarchy; a tool with no tier cannot be ordered against the others and is refused rather than assumed safe.`,
      audit: refusalAudit(request.intent, chosen),
    };
  }

  const best = bestCandidate(request.candidates);

  if (!chosen.healthy) {
    const better =
      best && best.tool !== chosen.tool
        ? { tool: best.tool, tier: toolTier(best.tier), label: describeTier(best.tier) }
        : undefined;
    return {
      allowed: false,
      tier: chosenTier,
      reason: chosen.unhealthyReason
        ? `${chosen.tool} cannot be used right now: ${chosen.unhealthyReason}`
        : `${chosen.tool} is not currently healthy.`,
      ...(better ? { better } : {}),
      audit: refusalAudit(request.intent, chosen, better),
    };
  }

  const healthyTools = request.candidates.filter((c) => c.healthy).map((c) => c.tier);
  if (permitsTier(chosen.tier, healthyTools)) {
    const skipped = request.candidates.filter(
      (c) => !c.healthy && toolTier(c.tier) < chosenTier,
    );
    return {
      allowed: true,
      tier: chosenTier,
      reason:
        skipped.length === 0
          ? `${chosen.tool} is the highest-tier tool available for ${request.intent} (${describeTier(chosen.tier)}).`
          : `${chosen.tool} is the highest-tier tool currently working for ${request.intent}; ${skipped
              .map((c) => c.tool)
              .join(', ')} would rank higher but ${skipped.length === 1 ? 'is' : 'are'} unavailable.`,
    };
  }

  // `best` is defined here: permitsTier only fails when some healthy candidate
  // ranks strictly higher than the chosen one.
  const better = best as WorkToolCandidate;
  const target: TierRefusalTarget = {
    tool: better.tool,
    tier: toolTier(better.tier),
    label: describeTier(better.tier),
  };
  return {
    allowed: false,
    tier: chosenTier,
    reason: `${chosen.tool} (${describeTier(chosen.tier)}) is refused for ${request.intent} because ${better.tool} (${target.label}) can do the same thing and is available. Use ${better.tool}.`,
    better: target,
    audit: refusalAudit(request.intent, chosen, target),
  };
}

/**
 * The hierarchy, phrased for the system prompt.
 *
 * Stated to the model as well as enforced against it: a model that knows the
 * rule picks the right tool first, and only the ones that did not get a
 * refusal to read.
 */
export function tierPromptSection(): string {
  const rungs = WORK_TOOL_TIERS.map((t) => `${t.tier}. ${t.label}`).join('\n');
  return [
    '',
    '# Tool selection',
    '',
    'For any given intent, use the most precise tool available, in this order:',
    '',
    rungs,
    '',
    'This is enforced, not advised. A call to a lower-ranked tool is refused outright while a higher-ranked one has declared it can serve the same intent and is working, and the refusal names the tool to use instead. A lower rung becomes available only when everything above it is unavailable, and the refusal will say so.',
  ].join('\n');
}
