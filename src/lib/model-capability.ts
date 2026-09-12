import "server-only";

import type { ModelCapabilityProbe, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isDiscoveredModel, type ModelInfo } from "@/lib/models";
import { providerApiKey } from "@/lib/providers";
import {
  decideModelCapability,
  MODEL_CAPABILITY_TRANSPORT_FAILURE_TTL_MS,
  MODEL_CAPABILITY_TTL_MS,
  type ModelCapabilityEvidence,
} from "@/lib/model-capability-policy";
import {
  isTransportFailureStatus,
  probeRequestFor,
  probeResponseLooksValid,
} from "@/lib/model-capability-probe";

/**
 * Bumped to 2 when the probe moved onto each model's OWN transport (native
 * GenerateContent for Gemini, /responses for the Responses line). Rows written
 * by version 1 answered a different question — "does this id work on the
 * OpenAI-compat shim?" — so the version is what tells an operator why an old
 * failed row disagrees with a fresh pass.
 */
export const MODEL_CAPABILITY_PROBE_VERSION = 2;

export interface ModelCapabilitySnapshot {
  modelId: string;
  provider: string;
  status: "passed" | "failed";
  checkedAt: string;
  expiresAt: string;
  detail: string | null;
  evidence: Record<string, unknown>;
}

function evidenceOf(row: Pick<ModelCapabilityProbe, "status" | "checkedAt" | "expiresAt" | "probeVersion">): ModelCapabilityEvidence {
  return {
    status: row.status === "passed" ? "passed" : "failed",
    checkedAt: row.checkedAt,
    expiresAt: row.expiresAt,
    probeVersion: row.probeVersion,
  };
}

export async function loadModelCapabilityMap(modelIds: readonly string[]): Promise<Map<string, ModelCapabilityProbe>> {
  if (modelIds.length === 0) return new Map();
  const rows = await prisma.modelCapabilityProbe.findMany({ where: { modelId: { in: [...new Set(modelIds)] } } });
  return new Map(rows.map((row) => [row.modelId, row]));
}

export function modelCapabilityVerdict(
  model: Pick<ModelInfo, "id">,
  probes: ReadonlyMap<string, Pick<ModelCapabilityProbe, "status" | "checkedAt" | "expiresAt" | "probeVersion">>,
  now = new Date(),
): { allowed: boolean; reason: string } {
  const row = probes.get(model.id);
  return decideModelCapability(model, isDiscoveredModel(model.id), row ? evidenceOf(row) : null, now);
}

export function modelCanRoute(
  model: Pick<ModelInfo, "id">,
  probes: ReadonlyMap<string, Pick<ModelCapabilityProbe, "status" | "checkedAt" | "expiresAt" | "probeVersion">>,
  now = new Date()
): boolean {
  return modelCapabilityVerdict(model, probes, now).allowed;
}

export function nativeModelCapabilityVerdicts(
  models: readonly Pick<ModelInfo, "id">[],
  probes: ReadonlyMap<string, Pick<ModelCapabilityProbe, "status" | "checkedAt" | "expiresAt" | "probeVersion">>,
  now = new Date(),
): Map<string, { allowed: boolean; reason: string }> {
  return new Map(models.map((model) => [model.id, modelCapabilityVerdict(model, probes, now)]));
}

/**
 * Probe one model with the smallest ordinary text completion.
 *
 * This proves that the exact provider model id is callable, that the response
 * shape the adapter expects is still valid, and that the catalog's capability
 * declaration has a current piece of evidence attached to it. The probe is an
 * explicit operator/background action, not part of a user's chat request.
 */
export async function probeModelCapability(model: ModelInfo, now = new Date()): Promise<ModelCapabilitySnapshot> {
  const apiKey = providerApiKey(model.provider);
  const request = apiKey ? probeRequestFor(model, apiKey) : null;
  const checkedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + MODEL_CAPABILITY_TTL_MS).toISOString();
  /**
   * How long this verdict speaks for the model.
   *
   * A failure the provider never answered (timeout, 429, 5xx, rejected
   * credential) is evidence about the wire, so it is deliberately short-lived
   * and retried; a request the provider understood and refused is evidence
   * about the model id and keeps the full TTL. Without this split every
   * failure looked identical to "this model cannot do this", and the policy
   * had no way to tell them apart.
   */
  const failureExpiry = (status: number | null): string =>
    isTransportFailureStatus(status)
      ? new Date(now.getTime() + MODEL_CAPABILITY_TRANSPORT_FAILURE_TTL_MS).toISOString()
      : expiresAt;
  const failureKind = (status: number | null): "transport" | "model" =>
    isTransportFailureStatus(status) ? "transport" : "model";
  const base = {
    modelId: model.id,
    provider: model.provider,
    checkedAt,
    expiresAt,
    evidence: {
      probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
      providerModel: model.providerModel,
      catalogCapabilities: {
        tools: model.agenticTools,
        vision: model.vision,
        webSearch: model.webSearch,
        streaming: model.modality === "chat",
      },
    },
  };

  if (!request) {
    // Not a claim about the model: nothing was asked. Keep it short-lived so
    // adding the key later does not leave a day-old "failed" row behind.
    return {
      ...base,
      status: "failed",
      expiresAt: failureExpiry(null),
      detail: "Provider is not configured.",
      evidence: { ...base.evidence, failureKind: "transport" },
    };
  }

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* The detail below names the status without persisting the provider body. */
    }
    if (!response.ok || !probeResponseLooksValid(request.shape, parsed)) {
      const providerCode =
        parsed && typeof parsed === "object" && "error" in parsed && parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>).type ?? (parsed.error as Record<string, unknown>).code
          : null;
      return {
        ...base,
        status: "failed",
        expiresAt: failureExpiry(response.status),
        // Provider bodies are deliberately not persisted: some gateways echo
        // request fragments, account metadata, or opaque diagnostic tokens.
        detail: `${response.status} ${providerCode ? String(providerCode).slice(0, 80) : "invalid_response"}`.trim(),
        evidence: {
          ...base.evidence,
          httpStatus: response.status,
          adapter: request.adapter,
          failureKind: failureKind(response.status),
          responseShape: probeResponseLooksValid(request.shape, parsed) ? "chat" : "invalid",
        },
      };
    }
    return {
      ...base,
      status: "passed",
      detail: null,
      evidence: { ...base.evidence, httpStatus: response.status, adapter: request.adapter },
    };
  } catch (error) {
    // A thrown request never reached a verdict about the model.
    return {
      ...base,
      status: "failed",
      expiresAt: failureExpiry(null),
      detail: error instanceof Error ? error.message.slice(0, 240) : "Probe failed.",
      evidence: { ...base.evidence, adapter: request.adapter, failureKind: "transport" },
    };
  }
}

export async function persistModelCapabilityProbe(snapshot: ModelCapabilitySnapshot): Promise<void> {
  await prisma.modelCapabilityProbe.upsert({
    where: { modelId: snapshot.modelId },
    create: {
      modelId: snapshot.modelId,
      provider: snapshot.provider,
      status: snapshot.status,
      detail: snapshot.detail,
      evidence: snapshot.evidence as Prisma.InputJsonObject,
      probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
      checkedAt: new Date(snapshot.checkedAt),
      expiresAt: new Date(snapshot.expiresAt),
    },
    update: {
      provider: snapshot.provider,
      status: snapshot.status,
      detail: snapshot.detail,
      evidence: snapshot.evidence as Prisma.InputJsonObject,
      probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
      checkedAt: new Date(snapshot.checkedAt),
      expiresAt: new Date(snapshot.expiresAt),
    },
  });
}

export async function probeAndPersistModelCapability(model: ModelInfo): Promise<ModelCapabilitySnapshot> {
  const snapshot = await probeModelCapability(model);
  await persistModelCapabilityProbe(snapshot);
  return snapshot;
}
