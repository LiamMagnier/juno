import { AUTO_MODEL_ID, isAutoModelId } from "@/lib/auto-model";

/**
 * The model a chat view starts on, before the reader has chosen anything.
 *
 * Pure, and client-safe: chat-view.tsx calls it once at mount (from the
 * bundled catalog) and again when the live catalog arrives with each lab's
 * `unavailableReason` (src/app/api/models/route.ts, `withAvailability`).
 *
 * Three rules, in order:
 *
 *  1. An existing conversation (or a deep link that named a model) keeps its
 *     recorded model, available or not. That model is the conversation's
 *     routing contract; if its lab is down the turn fails honestly and the
 *     error card offers an alternative the reader can choose.
 *  2. A new chat starts on the account's default — unless the live catalog
 *     marks it unavailable, in which case it starts on Auto and says so in one
 *     line. Nothing has been chosen for this chat yet, the picker shows Auto
 *     before anything is sent, and the reader can change it, so this is a
 *     visible starting point rather than a substitution. On 2026-10-26 every
 *     new paid chat started on the out-of-credit default and failed.
 *  3. A default the catalog does not list at all (an unconfigured lab, a model
 *     removed since) starts on Auto quietly, as it always has.
 */

export interface InitialModelChoice {
  modelId: string;
  /** One line to show above the composer, or null. */
  notice: string | null;
}

export interface InitialModelCatalogEntry {
  id: string;
  name: string;
  unavailableReason?: string | null;
}

export function initialChatModel(input: {
  /** The conversation's recorded model, or a model a deep link named — already resolved. */
  conversationModelId: string | null | undefined;
  /** The account's default, already resolved. */
  defaultModelId: string | null | undefined;
  models: readonly InitialModelCatalogEntry[];
}): InitialModelChoice {
  if (input.conversationModelId) return { modelId: input.conversationModelId, notice: null };
  const defaultId = input.defaultModelId;
  if (!defaultId) return { modelId: AUTO_MODEL_ID, notice: null };
  if (isAutoModelId(defaultId)) return { modelId: defaultId, notice: null };
  const entry = input.models.find((model) => model.id === defaultId);
  if (!entry) return { modelId: AUTO_MODEL_ID, notice: null };
  if (entry.unavailableReason) {
    return { modelId: AUTO_MODEL_ID, notice: unavailableDefaultNotice(entry.name) };
  }
  return { modelId: defaultId, notice: null };
}

/** The one line a new chat shows when its default is unavailable. */
export function unavailableDefaultNotice(modelName: string): string {
  return `${modelName} is unavailable right now, so this chat starts on Auto. You can still pick a model.`;
}
