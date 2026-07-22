import { apiV1Json } from "@/lib/api-v1";
import { loadAvailableModels, nativeModelCatalog } from "@/lib/model-catalog-api";
import { sortModelsForDisplay } from "@/lib/model-metrics";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiV1Json({ error: { code: "unauthenticated", message: "Authentication is required.", retryable: false, retryAfterMs: null } }, { status: 401 });
  // Plan-aware: a model this account cannot call comes back as `requires_plan`
  // so a client can explain it, instead of offering a selection /api/chat would
  // silently swap out. Order is the web selector's order (lab, intelligence, …)
  // and clients render it verbatim, so every surface lists models identically.
  const [models, plan] = await Promise.all([
    loadAvailableModels().then(sortModelsForDisplay),
    getUserPlan(user.id),
  ]);
  const catalog = nativeModelCatalog(models, plan);
  return apiV1Json({ ...catalog, generatedAt: new Date().toISOString() }, {
    // The digest now varies with the account's plan; the cache was already
    // private, which is what keeps that per-account ETag correct.
    headers: { ETag: `"${catalog.contractDigest}"`, "Cache-Control": "private, max-age=300" },
  });
}
