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
  reason:
    | "passed"
    | "curated-unprobed"
    | "discovered-unprobed"
    | "failed"
    | "failed-expired"
    | "expired";
}

/** Evidence is short-lived because a provider can retire a model overnight. */
export const MODEL_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a TRANSPORT-class failure is allowed to speak for a model.
 *
 * A timeout, a 429, a 5xx or a network error is evidence about the minute it
 * happened, not about the model. Recording it with the full TTL let one bad
 * moment hide a whole lab for a day; recording it with no expiry at all — which
 * is what the policy used to do — hid it until a human re-ran a script.
 */
export const MODEL_CAPABILITY_TRANSPORT_FAILURE_TTL_MS = 15 * 60 * 1000;

/**
 * Decide whether a model may be routed.
 *
 * Hand-curated models are already human-reviewed and remain fail-open until a
 * probe has evidence to the contrary, which preserves availability across a
 * fresh deploy with an empty probe table. Auto-discovered models are different:
 * they are opt-in and cannot route until an operator has run a passing probe.
 * A failed or expired probe never silently makes a model look healthy again.
 *
 * A FAILURE EXPIRES LIKE A PASS. It used to be permanent, and that is how one
 * probe on the wrong transport removed every Gemini model from /api/chat's
 * eligibility set until somebody noticed and re-ran a script: nothing in the
 * product could ever revisit the verdict. Once the evidence is stale the model
 * returns to its unprobed default — fail-open for curated, fail-closed for
 * discovered — and the next background probe gets to decide again. How long a
 * failure counts as current is set when it is RECORDED (see
 * MODEL_CAPABILITY_TRANSPORT_FAILURE_TTL_MS), so "the network was unhappy" and
 * "this model id does not answer" are not the same verdict for the same day.
 */
export function decideModelCapability(
  model: Pick<ModelInfo, "id">,
  discovered: boolean,
  evidence: ModelCapabilityEvidence | null,
  now = new Date()
): ModelCapabilityDecision {
  if (evidence?.status === "failed") {
    const current = evidence.expiresAt != null && evidence.expiresAt.getTime() > now.getTime();
    if (current) return { allowed: false, reason: "failed" };
    return discovered
      ? { allowed: false, reason: "discovered-unprobed" }
      : { allowed: true, reason: "failed-expired" };
  }

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
