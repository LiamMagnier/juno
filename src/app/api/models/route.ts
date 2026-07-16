import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { loadAvailableModels, nativeModelCatalog } from "@/lib/model-catalog-api";
import { sortModelsForDisplay } from "@/lib/model-metrics";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Order [lab asc, intelligence desc, released desc, name asc] so the Mac app —
  // which trusts /api/models order verbatim — matches the web UI.
  const models = sortModelsForDisplay(await loadAvailableModels());
  // Additive metadata lets older web clients keep consuming the existing model
  // shape while native clients use the explicit v1 representation.
  return NextResponse.json({ models, manifestVersion: nativeModelCatalog(models).manifestVersion });
}
