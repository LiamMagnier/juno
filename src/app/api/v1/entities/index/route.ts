import { ApiV1Error, apiV1Error, apiV1Json } from "@/lib/api-v1";
import { requireNativeRequest } from "@/lib/native-request";
import {
  EntityIndexInputError,
  encodeEntityIndexCursor,
  parseEntityIndexCursor,
  parseEntityIndexLimit,
} from "@/lib/sync-entity-index";
import { isSyncEntityType, listEntityIndex } from "@/lib/sync-entities";

export const runtime = "nodejs";

// Minimal snapshot inventory for fresh installs and compaction recovery.
// Entity data stays on GET /entities so hydration remains batched and typed by
// the existing owner-scoped loaders.
export async function GET(request: Request) {
  try {
    const current = await requireNativeRequest(request);
    const url = new URL(request.url);
    const after = parseEntityIndexCursor(url.searchParams.get("after"));
    if (after && !isSyncEntityType(after.type)) {
      throw new ApiV1Error("invalid_request", 400, "The entity index cursor is malformed.");
    }
    const page = await listEntityIndex(
      current.user.id,
      after,
      parseEntityIndexLimit(url.searchParams.get("limit")),
    );
    const last = page.items.at(-1);
    return apiV1Json({
      items: page.items,
      nextAfter: page.hasMore && last ? encodeEntityIndexCursor({ type: last.type, id: last.id }) : null,
      hasMore: page.hasMore,
    });
  } catch (error) {
    if (error instanceof EntityIndexInputError) {
      const message = error.field === "limit"
        ? "The entity index limit must be between 1 and 500."
        : "The entity index cursor is malformed.";
      return apiV1Error(new ApiV1Error("invalid_request", 400, message));
    }
    return apiV1Error(error);
  }
}
