import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { peekPublicShare, sharedArtifactIsTrashed } from "@/lib/share";
import { findPublicPublication } from "@/lib/artifact-publication";
import { publicShareProfile } from "@/lib/sandbox-policy";
import { streamChat } from "@/lib/llm";
import { accountBackgroundProvider, loadBackgroundProviderPolicy, utilityModelCandidates } from "@/lib/memory";
import { resolveBackgroundCandidates } from "@/lib/background-provider-policy";
import { noteLiveProviderFault, providerHealthy } from "@/lib/provider-health";
import { admitMeteredCall } from "@/lib/metering/admit";
import { modelRatesMicroUsdPerToken, recordSpend, reserveSpend, settleSpend } from "@/lib/spend";
import { decryptField, encryptField, FIELD_DECRYPT_PLACEHOLDER } from "@/lib/field-crypto";
import type { ArtifactType } from "@/lib/message-content";
import type { RuntimeAccessDeps, RuntimeArtifactRow } from "@/lib/artifact-ai/access";
import type { ArtifactCompletionDeps } from "@/lib/artifact-ai/complete";
import { createArtifactStorage } from "@/lib/artifact-ai/storage";
import { prismaArtifactStorageStore } from "@/lib/artifact-ai/storage-store";

/**
 * The production wiring behind the two artifact-runtime routes: the database
 * lookups, the spend ledger, the provider walk and the cipher. The rules live
 * in access.ts, complete.ts and storage.ts, which take these as arguments so
 * the tests can run them without any of it.
 */

export const runtimeAccessDeps: RuntimeAccessDeps = {
  async findOwnedArtifact(viewerId, artifactId) {
    const row = await prisma.artifact.findFirst({
      where: ownedArtifactWhere(viewerId, { id: artifactId }),
      select: { id: true, type: true, language: true },
    });
    return row ? { id: row.id, type: row.type as ArtifactType, language: row.language } : null;
  },

  /*
   * The same resolution as the share page (src/app/share/[token]/page.tsx): a
   * live share first, then a live publication. `peekPublicShare` and
   * `findPublicPublication` are the page's own request-cached reads, and
   * neither counts a view: an app calling its bridge is not someone opening
   * the link again.
   */
  async findLinkedArtifact(token): Promise<RuntimeArtifactRow | null> {
    const share = await peekPublicShare(token);
    if (share) {
      if (share.kind !== "ARTIFACT" || !share.artifactId || (await sharedArtifactIsTrashed(share))) return null;
      // Scoped to the share's owner, the artifact's own owner by construction.
      const artifact = await prisma.artifact.findFirst({
        where: { id: share.artifactId, userId: share.userId, deletedAt: null },
        select: { id: true, type: true, language: true },
      });
      return artifact ? { id: artifact.id, type: artifact.type as ArtifactType, language: artifact.language } : null;
    }
    const publication = await findPublicPublication(token);
    if (!publication || publication.state !== "live") return null;
    return {
      id: publication.publication.artifactId,
      type: publication.snapshot.type,
      language: publication.snapshot.language,
    };
  },

  publicScriptsEnabled: () => publicShareProfile() === "public",
};

/** One request's completion dependencies, with the viewer named for provider-health bookkeeping. */
export function artifactCompletionDeps(viewerId: string): ArtifactCompletionDeps {
  return {
    async resolveModels(userId) {
      const [policy, conversationProvider] = await Promise.all([
        loadBackgroundProviderPolicy(userId),
        accountBackgroundProvider(userId),
      ]);
      return resolveBackgroundCandidates({
        policy,
        conversationProvider,
        candidates: utilityModelCandidates(),
        isProviderHealthy: (provider) => providerHealthy(provider as Parameters<typeof providerHealthy>[0]),
      }).candidates;
    },
    admit: (input) => admitMeteredCall(input),
    reserve: ({ userId, plan, ref, estimateMicroUsd }) => reserveSpend({ userId, kind: "utility", ref, estimateMicroUsd, plan }),
    settle: (userId, ref, actual) => settleSpend(userId, ref, actual),
    stream: ({ model, system, prompt, maxTokens, signal }) =>
      streamChat({
        model,
        system,
        history: [{ role: "USER", content: prompt, attachments: [] }],
        maxTokens,
        signal,
        // Sent once: a cache write would be a premium nobody reads.
        promptCache: "none",
        role: "artifact",
      }),
    record: (input) => recordSpend(input),
    rates: (model) => modelRatesMicroUsdPerToken(model.id),
    newRef: () => `artifact-ai:${randomUUID()}`,
    onProviderFault: (model, error) =>
      noteLiveProviderFault(model.provider, error, "background", { requester: viewerId, modelId: model.id }),
  };
}

export const artifactStorage = createArtifactStorage({
  store: prismaArtifactStorageStore,
  seal: (plain) => encryptField(plain),
  open: (stored) => {
    const plain = decryptField(stored);
    return plain === FIELD_DECRYPT_PLACEHOLDER ? null : plain;
  },
});
