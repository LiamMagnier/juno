import { apiV1Error, apiV1Json, CONTRACT_VERSION } from "@/lib/api-v1";
import { requireNativeRequest } from "@/lib/native-request";
import { prisma } from "@/lib/prisma";
import { getCompactionFloor } from "@/lib/sync-feed";
import { loadAvailableModels, nativeModelCatalog } from "@/lib/model-catalog-api";
import { sortModelsForDisplay } from "@/lib/model-metrics";
import { getUserPlan } from "@/lib/usage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const current = await requireNativeRequest(request);
    const period = new Date().toISOString().slice(0, 7);
    const [settings, subscription, usage, latest, compactionFloor, models, plan] = await Promise.all([
      prisma.settings.findUnique({ where: { userId: current.user.id } }),
      prisma.subscription.findUnique({ where: { userId: current.user.id } }),
      prisma.usage.findUnique({ where: { userId_period: { userId: current.user.id, period } } }),
      prisma.accountChange.findFirst({ where: { accountId: current.user.id }, orderBy: { cursor: "desc" }, select: { cursor: true } }),
      getCompactionFloor(),
      loadAvailableModels().then(sortModelsForDisplay),
      getUserPlan(current.user.id),
    ]);
    // Must be built with the same plan and order as GET /models, or a client
    // comparing manifest versions would refetch the catalog forever.
    const modelCatalog = nativeModelCatalog(models, plan);
    return apiV1Json({
      profile: { id: current.user.id, name: current.user.name, email: current.user.email, image: current.user.image },
      subscription: subscription ? {
        plan: subscription.plan.toLowerCase(), status: subscription.status.toLowerCase(),
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      } : { plan: "free", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false },
      usage: usage ? {
        period: usage.period, messageCount: usage.messageCount,
        promptTokens: usage.promptTokens.toString(), completionTokens: usage.completionTokens.toString(),
      } : { period, messageCount: 0, promptTokens: "0", completionTokens: "0" },
      settings,
      featureFlags: {},
      currentChangeCursor: (latest?.cursor ?? 0n).toString(),
      compactionFloorCursor: compactionFloor.toString(),
      modelManifestVersion: modelCatalog.manifestVersion,
      contractVersion: CONTRACT_VERSION,
      minimumClientVersions: { macOS: "3.0.0" },
      announcements: [],
    });
  } catch (error) {
    return apiV1Error(error);
  }
}
