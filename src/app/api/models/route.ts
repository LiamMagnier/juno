import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { accountPinnedModelIds, loadSelectableModels, nativeModelCatalog } from "@/lib/model-catalog-api";
import { sortModelsForDisplay } from "@/lib/model-metrics";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Order [lab asc, intelligence desc, released desc, name asc] so the Mac app —
  // which trusts /api/models order verbatim — matches the web UI.
  // The saved default is kept even when superseded, or the settings dropdown
  // renders a blank box for anyone who never changed it.
  const models = sortModelsForDisplay(await loadSelectableModels(await accountPinnedModelIds(user.id)));
  // Additive metadata lets older web clients keep consuming the existing model
  // shape while native clients use the explicit v1 representation.
  return NextResponse.json({ models, manifestVersion: nativeModelCatalog(models).manifestVersion });
}
