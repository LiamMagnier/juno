import type { ModelInfo } from "@/lib/models";

/** A persisted verdict from the model capability probe runner. */
export type ModelCapabilityStatus = "passed" | "failed";

export interface ModelCapabilityEvidence {
  status: ModelCapabilityStatus;
  checkedAt: Date | null;
  expiresAt: Date | null;
  probeVersion: number;
}
export interface ModelCapabilityDecision {
  allowed: boolean;
  reason: "passed" | "curated-unprobed" | "discovered-unprobed" | "failed" | "expired";
}

/** Evidence is short-lived because a provider can retire a model overnight. */
export const MODEL_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Decide whether a model may be routed.
 *
 * Hand-curated models are already human-reviewed and remain fail-open until a
 * probe has evidence to the contrary, which preserves availability across a
 * fresh deploy with an empty probe table. Auto-discovered models are different:
 * they are opt-in and cannot route until an operator has run a passing probe.
 * A failed or expired probe never silently makes a model look healthy again.
 */
export function decideModelCapability(
  model: Pick<ModelInfo, "id">,
  discovered: boolean,
  evidence: ModelCapabilityEvidence | null,
  now = new Date()
): ModelCapabilityDecision {
  if (evidence?.status === "failed") return { allowed: false, reason: "failed" };

  if (evidence?.status === "passed") {
    if (evidence.expiresAt && evidence.expiresAt.getTime() > now.getTime()) {
      return { allowed: true, reason: "passed" };
    }
    return { allowed: false, reason: "expired" };
  }

  return discovered
    ? { allowed: false, reason: "discovered-unprobed" }
    : { allowed: true, reason: "curated-unprobed" };
}
