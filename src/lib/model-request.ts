import type { ModelInfo } from "@/lib/models";

/**
 * The one model identifier that provider adapters are allowed to serialize.
 * Keeping this tiny pure boundary makes the catalog/request equality testable
 * without importing a server adapter or touching provider credentials.
 */
export function providerRequestModel(model: Pick<ModelInfo, "id" | "provider" | "providerModel">): string {
  const expectedId = `${model.provider}:${model.providerModel}`;
  if (model.id !== expectedId) {
    throw new Error(`Model ${model.id} does not match provider request model ${expectedId}.`);
  }
  return model.providerModel;
}
