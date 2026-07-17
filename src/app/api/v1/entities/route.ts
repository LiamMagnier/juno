import { ApiV1Error, apiV1Error, apiV1Json } from "@/lib/api-v1";
import { requireNativeRequest } from "@/lib/native-request";
import { isSyncEntityType, loadEntities, MAX_ENTITY_IDS } from "@/lib/sync-entities";

export const runtime = "nodejs";

// Batch entity hydration for sync catch-up: after /changes reports what moved,
// clients fetch the authoritative state here. Type strings match the change
// feed exactly; ownership is enforced inside every loader.
export async function GET(request: Request) {
  try {
    const current = await requireNativeRequest(request);
    const url = new URL(request.url);
    const type = url.searchParams.get("type") ?? "";
    if (!isSyncEntityType(type)) {
      throw new ApiV1Error("invalid_request", 400, "Unknown entity type.");
    }
    const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) {
      throw new ApiV1Error("invalid_request", 400, "At least one entity id is required.");
    }
    if (ids.length > MAX_ENTITY_IDS) {
      throw new ApiV1Error("invalid_request", 400, `At most ${MAX_ENTITY_IDS} entity ids per request.`);
    }
    if (ids.some((id) => id.length > 200)) {
      throw new ApiV1Error("invalid_request", 400, "An entity id is malformed.");
    }
    return apiV1Json({ entities: await loadEntities(current.user.id, type, ids) });
  } catch (error) {
    return apiV1Error(error);
  }
}
