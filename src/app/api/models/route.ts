import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { loadAvailableModels, nativeModelCatalog } from "@/lib/model-catalog-api";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const models = await loadAvailableModels();
  // Additive metadata lets older web clients keep consuming the existing model
  // shape while native clients use the explicit v1 representation.
  return NextResponse.json({ models, manifestVersion: nativeModelCatalog(models).manifestVersion });
}
