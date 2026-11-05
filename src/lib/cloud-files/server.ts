import "server-only";
import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { isStorageAvailable } from "@/lib/env";
import { isOwnerEmail } from "@/lib/owner";
import { getConnector, isConnectorConfigured } from "@/lib/connectors";
import { firstPartyAccessToken } from "@/lib/first-party-connectors/tokens";
import { resolveActionPolicy } from "@/lib/action-approval-store";
import { persistAttachment } from "@/lib/attachment-store";
import { LibraryQuotaExceededError } from "@/lib/library";
import { serializeAttachment } from "@/lib/serializers";
import type { CloudFilesDeps } from "./api";

/** The real dependencies of the picker routes; see ./api.ts for what they decide. */
export function cloudFilesDeps(): CloudFilesDeps {
  return {
    currentUser: getCurrentUser,
    connectorConfigured: (provider) => {
      const def = getConnector(provider);
      return Boolean(def && isConnectorConfigured(def));
    },
    hasConnection: async (userId, provider) =>
      Boolean(await prisma.connection.findFirst({ where: { userId, provider }, select: { id: true } })),
    accessToken: firstPartyAccessToken,
    appPolicy: async (userId, provider) => {
      const policy = await resolveActionPolicy({ userId, connectorId: provider });
      return { lockdown: policy.lockdown, blocked: policy.connectorBlocked };
    },
    rateLimit: async (key, limit, windowSec) => (await rateLimit({ key, limit, windowSec })).success,
    isOwner: isOwnerEmail,
    fetcher: fetch,
    uploadLimit: async (userId) => {
      const plan = await getUserPlan(userId);
      return { plan, maxUploadMb: PLANS[plan].maxUploadMb };
    },
    storageAvailable: isStorageAvailable,
    conversationOwned: async (userId, conversationId) =>
      Boolean(await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } })),
    persist: async (input) => serializeAttachment(await persistAttachment({ ...input, plan: input.plan as Plan })),
    isQuotaError: (error) => error instanceof LibraryQuotaExceededError,
  };
}
