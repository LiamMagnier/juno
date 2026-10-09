/**
 * Generation models for Code: when a Code run needs to make an image, a video
 * or music, it uses the model chosen here. The Code model picker lists only
 * models that write code (picker-catalogue.ts), so media models are picked in
 * Settings instead.
 *
 * The rule is shared with the Mac (it computes the same defaults):
 * - Options per kind: catalogue models of that modality that are callable
 *   today (not coming soon, not retired) and current (legacy hidden), in the
 *   web catalogue's display order (sortModelsForDisplay).
 * - Default per kind: the NEWEST option by `released` (YYYY-MM, descending),
 *   ties broken by display order. For audio this is DEFAULT_AUDIO_MODEL.
 * - A stored id that is unknown, retired or no longer an option falls back to
 *   the default.
 *
 * The catalogue's "audio" modality is music (Lyria); it has no separate speech
 * models, so there is no speech row.
 */
import * as React from "react";
import { hasRetired, MODELS, type ModelInfo } from "@/lib/models";
import { sortModelsForDisplay } from "@/lib/model-metrics";
import { PROVIDERS } from "@/lib/providers";

/**
 * Every catalogue model, media included. `MODEL_LIST` is the chat-only client
 * list (media models load per configured lab), so the options read `MODELS`.
 */
const CATALOGUE: readonly ModelInfo[] = Object.values(MODELS);

export type GenerationKind = "image" | "video" | "audio";

export const GENERATION_KINDS: readonly GenerationKind[] = ["image", "video", "audio"];

/** The row titles in Settings: the catalogue's audio is music. */
export const GENERATION_KIND_LABELS: Record<GenerationKind, string> = { image: "Image", video: "Video", audio: "Music" };

export const GENERATION_MODELS_COPY = {
  title: "Generation models",
  description: "When Code needs to make an image, a video or music, it uses these models. The model picker lists only models that write code.",
} as const;

/** localStorage key holding `{ image?, video?, audio? }` as JSON. */
export const GENERATION_MODELS_STORAGE_KEY = "alevr.code.generationModels";

export type GenerationModelChoice = Partial<Record<GenerationKind, string>>;
export type ResolvedGenerationModels = Record<GenerationKind, string | undefined>;

/** The models a kind offers, in the web catalogue's display order. */
export function generationModelOptions(kind: GenerationKind, models: readonly ModelInfo[] = CATALOGUE): ModelInfo[] {
  return sortModelsForDisplay(
    models.filter((m) => m.modality === kind && !m.comingSoon && !hasRetired(m) && (m.status ?? "current") === "current"),
  );
}

/** The newest option by release month; ties keep display order. */
export function defaultGenerationModel(kind: GenerationKind, models: readonly ModelInfo[] = CATALOGUE): string | undefined {
  const options = generationModelOptions(kind, models);
  let best: ModelInfo | undefined;
  for (const m of options) if (!best || (m.released ?? "") > (best.released ?? "")) best = m;
  return best?.id;
}

/** "GPT Image 2.5 Sunburst · OpenAI": how an option reads in the select. */
export function generationOptionLabel(model: Pick<ModelInfo, "name" | "provider">): string {
  const lab = PROVIDERS[model.provider]?.label.split(" · ")[0] ?? model.provider;
  return `${model.name} · ${lab}`;
}

/** The model a kind uses: the stored id when it is still an option, else the default. */
export function resolveGenerationModel(kind: GenerationKind, stored: string | undefined, models: readonly ModelInfo[] = CATALOGUE): string | undefined {
  if (stored && generationModelOptions(kind, models).some((m) => m.id === stored)) return stored;
  return defaultGenerationModel(kind, models);
}

export function resolveGenerationModels(choice: GenerationModelChoice, models: readonly ModelInfo[] = CATALOGUE): ResolvedGenerationModels {
  return {
    image: resolveGenerationModel("image", choice.image, models),
    video: resolveGenerationModel("video", choice.video, models),
    audio: resolveGenerationModel("audio", choice.audio, models),
  };
}

/** Parse a stored value; anything malformed reads as no choice. */
export function parseGenerationChoice(raw: string | null | undefined): GenerationModelChoice {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return {};
    const out: GenerationModelChoice = {};
    for (const k of GENERATION_KINDS) {
      const id = (v as Record<string, unknown>)[k];
      if (typeof id === "string" && id) out[k] = id;
    }
    return out;
  } catch {
    return {};
  }
}

// TODO(server-side): the account settings row has no field for generation
// models yet, so the choice lives in this browser only. Move it to a Settings
// column (e.g. `codeGenerationModels` JSON) behind the /api/settings PATCH, and
// have the Mac read the same field instead of its own default.
/** Fallback when storage is blocked: the choice lasts for this page. */
let memory: GenerationModelChoice = {};

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The stored choice (raw: may name ids that no longer resolve). */
export function readGenerationChoice(): GenerationModelChoice {
  try {
    const s = storage();
    return s ? parseGenerationChoice(s.getItem(GENERATION_MODELS_STORAGE_KEY)) : { ...memory };
  } catch {
    return { ...memory };
  }
}

/** What the Code client should use for each kind right now. */
export function getGenerationModels(): ResolvedGenerationModels {
  return resolveGenerationModels(readGenerationChoice());
}

export function writeGenerationChoice(choice: GenerationModelChoice): void {
  memory = { ...choice };
  try {
    storage()?.setItem(GENERATION_MODELS_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

const listeners = new Set<() => void>();

/** The resolved models plus a setter; every mounted reader updates together. */
export function useGenerationModels(): [ResolvedGenerationModels, (kind: GenerationKind, id: string) => void] {
  const [choice, setChoice] = React.useState<GenerationModelChoice>({});
  React.useEffect(() => {
    const sync = () => setChoice(readGenerationChoice());
    sync();
    listeners.add(sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key === GENERATION_MODELS_STORAGE_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const set = React.useCallback((kind: GenerationKind, id: string) => {
    const next = { ...readGenerationChoice(), [kind]: id };
    writeGenerationChoice(next);
    setChoice(next);
    for (const l of listeners) l();
  }, []);
  return [React.useMemo(() => resolveGenerationModels(choice), [choice]), set];
}
