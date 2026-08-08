import { loadAvailableModels } from "../src/lib/model-catalog-api";
import { probeAndPersistModelCapability } from "../src/lib/model-capability";

/**
 * Refresh exact model capability evidence for a deployment.
 *
 * Run from a protected scheduler (or `npm run models:probe` by an operator),
 * not from a request path. Each target makes one bounded one-token provider
 * call; failures are persisted so routing fails closed until the next pass.
 */
async function main() {
  const models = (await loadAvailableModels()).filter((model) => model.modality === "chat" && !model.comingSoon);
  let failed = 0;
  for (const model of models) {
    const snapshot = await probeAndPersistModelCapability(model);
    console.log(`${snapshot.status === "passed" ? "PASS" : "FAIL"} ${snapshot.modelId}${snapshot.detail ? ` — ${snapshot.detail}` : ""}`);
    if (snapshot.status === "failed") failed += 1;
  }
  console.log(`Model capability probes: ${models.length - failed}/${models.length} passed.`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error("Model capability probe run failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
