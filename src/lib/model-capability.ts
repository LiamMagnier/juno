import "server-only";

import type { ModelCapabilityProbe, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isDiscoveredModel, type ModelInfo } from "@/lib/models";
import { providerApiKey, providerBaseUrl, PROVIDERS } from "@/lib/providers";
import {
  decideModelCapability,
  MODEL_CAPABILITY_TTL_MS,
  type ModelCapabilityEvidence,
} from "@/lib/model-capability-policy";
import { providerRequestModel } from "@/lib/model-request";

export const MODEL_CAPABILITY_PROBE_VERSION = 1;

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

function providerEndpoint(model: ModelInfo): { url: string; headers: Record<string, string> } | null {
  const key = providerApiKey(model.provider);
  if (!key) return null;
  const provider = PROVIDERS[model.provider];
  if (provider.kind === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    };
  }
  const base = providerBaseUrl(model.provider);
  if (!base) return null;
  return {
    url: `${base.replace(/\/+$/, "")}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  };
}

function responseLooksLikeChat(provider: string, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (provider === "anthropic") return Array.isArray(body.content);
  return Array.isArray(body.choices);
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
  const endpoint = providerEndpoint(model);
  const checkedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + MODEL_CAPABILITY_TTL_MS).toISOString();
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

  if (!endpoint) {
    return { ...base, status: "failed", detail: "Provider is not configured.", evidence: base.evidence };
  }

  try {
    const body = PROVIDERS[model.provider].kind === "anthropic"
      ? { model: providerRequestModel(model), max_tokens: 1, messages: [{ role: "user", content: "Reply with OK." }] }
      : { model: providerRequestModel(model), max_tokens: 1, messages: [{ role: "user", content: "Reply with OK." }] };
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* The detail below names the status without persisting the provider body. */
    }
    if (!response.ok || !responseLooksLikeChat(model.provider, parsed)) {
      const providerCode =
        parsed && typeof parsed === "object" && "error" in parsed && parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>).type ?? (parsed.error as Record<string, unknown>).code
          : null;
      return {
        ...base,
        status: "failed",
        // Provider bodies are deliberately not persisted: some gateways echo
        // request fragments, account metadata, or opaque diagnostic tokens.
        detail: `${response.status} ${providerCode ? String(providerCode).slice(0, 80) : "invalid_response"}`.trim(),
        evidence: {
          ...base.evidence,
          httpStatus: response.status,
          responseShape: responseLooksLikeChat(model.provider, parsed) ? "chat" : "invalid",
        },
      };
    }
    return {
      ...base,
      status: "passed",
      detail: null,
      evidence: { ...base.evidence, httpStatus: response.status },
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      detail: error instanceof Error ? error.message.slice(0, 240) : "Probe failed.",
      evidence: base.evidence,
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
