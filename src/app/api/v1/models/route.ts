import { apiV1Json } from "@/lib/api-v1";
import { loadAvailableModels, nativeModelCatalog } from "@/lib/model-catalog-api";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiV1Json({ error: { code: "unauthenticated", message: "Authentication is required.", retryable: false, retryAfterMs: null } }, { status: 401 });
  const catalog = nativeModelCatalog(await loadAvailableModels());
  return apiV1Json({ ...catalog, generatedAt: new Date().toISOString() }, {
    headers: { ETag: `"${catalog.contractDigest}"`, "Cache-Control": "private, max-age=300" },
  });
}
