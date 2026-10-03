import {
  allowedValues,
  applyParamChange,
  capabilitiesFor,
  defaultParams,
  normalizeParams,
  optionValues,
  paramsForModelSwitch,
  type MediaCapabilities,
  type MediaOption,
  type MediaParamKey,
  type MediaParams,
} from "@/lib/media-params";

/*
 * What the composer's generation row draws for a model, worked out without
 * React so it can be tested: which control each option becomes, what its chip
 * says, which values the current combination rules out and what picking one
 * of those would move, and how choices are kept per model.
 */

/** The order controls appear in, left to right: framing, fidelity, time, sound, then the file. */
export const PARAM_ORDER: MediaParamKey[] = [
  "aspect",
  "resolution",
  "quality",
  "durationSec",
  "fps",
  "audio",
  "instrumental",
  "count",
  "background",
  "outputFormat",
];

export type ControlKind = "aspect" | "segmented" | "menu" | "slider" | "toggle";

export interface ParamChoice {
  value: string | number;
  label: string;
  detail?: string;
  /** The current combination rules this value out; picking it moves another option. */
  conflict: boolean;
  /** What picking a conflicting value changes, in words ("Resolution becomes 720p"). */
  consequence?: string;
}

export interface ParamControl {
  key: MediaParamKey;
  kind: ControlKind;
  label: string;
  value: string | number | boolean | undefined;
  /** What the closed chip says. */
  chip: string;
  choices: ParamChoice[];
  /** Range controls only. */
  range?: { min: number; max: number; step: number; unit: string; auto?: string };
}

const SEGMENTED_KEYS = new Set<MediaParamKey>(["resolution", "quality", "durationSec", "fps"]);

function controlKind(key: MediaParamKey, option: MediaOption): ControlKind {
  if (option.kind === "toggle") return "toggle";
  if (key === "aspect") return "aspect";
  if (option.kind === "range") return option.unit === "s" ? "slider" : "menu";
  if (SEGMENTED_KEYS.has(key) && option.choices.length <= 3) return "segmented";
  return "menu";
}

function choiceLabel(option: MediaOption, value: unknown): string {
  if (option.kind === "select") return option.choices.find((c) => c.value === value)?.label ?? String(value);
  if (option.kind === "range") {
    if (value === "auto") return option.auto?.label ?? "Auto";
    return option.unit === "s" ? `${value}s` : String(value);
  }
  return value ? "On" : "Off";
}

/** The closed chip's text for one option. */
export function chipText(key: MediaParamKey, option: MediaOption, value: unknown): string {
  if (option.kind === "toggle") return option.label;
  if (key === "aspect") return value === "auto" ? "Auto" : String(value);
  if (key === "durationSec" && value === "auto") return "Auto length";
  if (key === "count" && typeof value === "number") {
    const noun = option.label.toLowerCase().replace(/s$/, "");
    return `${value} ${value === 1 ? noun : `${noun}s`}`;
  }
  if (key === "background") return value === "auto" ? "Auto background" : choiceLabel(option, value);
  if (key === "quality" && value === "auto") return "Auto quality";
  return choiceLabel(option, value);
}

/** "Resolution becomes 720p" for every other option a pick would move. */
export function changeConsequence(modelId: string, params: MediaParams, key: MediaParamKey, value: unknown): string | undefined {
  const caps = capabilitiesFor(modelId);
  if (!caps) return undefined;
  const next = applyParamChange(modelId, params, key, value);
  const current = normalizeParams(modelId, params);
  const moved: string[] = [];
  for (const k of PARAM_ORDER) {
    if (k === key) continue;
    const option = caps.options[k];
    if (!option || next[k] === current[k]) continue;
    moved.push(`${option.label} becomes ${choiceLabel(option, next[k])}`);
  }
  return moved.length ? moved.join(", ") : undefined;
}

/** Every control the row draws for a model, in order; empty for a model with nothing to choose. */
export function paramControls(modelId: string, input: MediaParams): ParamControl[] {
  const caps = capabilitiesFor(modelId);
  if (!caps) return [];
  const params = normalizeParams(modelId, input);
  const out: ParamControl[] = [];
  for (const key of PARAM_ORDER) {
    const option = caps.options[key];
    if (!option) continue;
    const allowed = allowedValues(modelId, key, params);
    const value = params[key] as ParamControl["value"];
    const choices: ParamChoice[] =
      option.kind === "toggle"
        ? []
        : optionValues(option).map((v) => {
            const val = v as string | number;
            const conflict = !allowed.includes(v);
            const meta = option.kind === "select" ? option.choices.find((c) => c.value === val) : undefined;
            return {
              value: val,
              label: option.kind === "range" && key === "count" ? String(val) : choiceLabel(option, val),
              ...(meta?.detail ? { detail: meta.detail } : {}),
              conflict,
              ...(conflict ? { consequence: changeConsequence(modelId, params, key, val) } : {}),
            };
          });
    out.push({
      key,
      kind: controlKind(key, option),
      label: option.label,
      value,
      chip: chipText(key, option, value),
      choices,
      ...(option.kind === "range"
        ? { range: { min: option.min, max: option.max, step: option.step, unit: option.unit, ...(option.auto ? { auto: option.auto.label } : {}) } }
        : {}),
    });
  }
  return out;
}

/** Plain facts the person cannot change, worth a quiet word in the row. */
export function fixedFacts(caps: MediaCapabilities | null): string[] {
  if (!caps?.fixed) return [];
  const facts: string[] = [];
  if (caps.fixed.audio && !caps.options.audio) facts.push("With sound");
  if (caps.fixed.durationSec && !caps.options.durationSec) facts.push(`${caps.fixed.durationSec}s clip`);
  return facts;
}

/**
 * The box a ratio draws inside a `size` square, for the shape glyph and the
 * menu's preview. "16:9" → wide, "9:16" → tall; "auto" and junk → null.
 */
export function aspectBox(value: unknown, size: number): { width: number; height: number } | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0 && h > 0)) return null;
  const scale = size / Math.max(w, h);
  return { width: Math.max(2, Math.round(w * scale * 10) / 10), height: Math.max(2, Math.round(h * scale * 10) / 10) };
}

// ---------------------------------------------------------------------------
// Per-model memory
// ---------------------------------------------------------------------------

export const MEDIA_PARAMS_STORE_KEY = "alevr.mediaParams.v1";

export type ParamsByModel = Record<string, MediaParams>;

/** Parse a stored map, keeping only models with a capability entry. Never throws. */
export function parseStoredParams(raw: string | null): ParamsByModel {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: ParamsByModel = {};
    for (const [id, value] of Object.entries(data as Record<string, unknown>)) {
      if (capabilitiesFor(id) && value && typeof value === "object") out[id] = normalizeParams(id, value);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The choices to show when the composer lands on `toModel`: what was last
 * picked for that model if anything, otherwise the previous model's choices
 * carried across (nearest resolution, nearest length, same aspect where it
 * exists), otherwise its defaults.
 */
export function paramsForModel(saved: ParamsByModel, toModel: string, carried: MediaParams | null): MediaParams {
  if (!capabilitiesFor(toModel)) return {};
  if (saved[toModel]) return normalizeParams(toModel, saved[toModel]);
  return carried ? paramsForModelSwitch(carried, toModel) : defaultParams(toModel);
}

/** The JSON-safe form /api/generate takes. */
export function paramsForRequest(params: MediaParams): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The frame chooser: order, and the pixels a ratio comes out at
// ---------------------------------------------------------------------------

/** Width over height for "16:9"; null for "auto" and anything that is not a ratio. */
export function aspectRatioValue(value: unknown): number | null {
  const box = aspectBox(value, 1000);
  return box ? box.width / box.height : null;
}

/**
 * The aspect choices in the order the chooser draws them: Auto first (it is
 * not a shape), then tall to square to wide, so the grid reads as one sweep.
 */
export function orderAspectChoices(choices: ParamChoice[]): ParamChoice[] {
  return [...choices].sort((a, b) => {
    const ra = aspectRatioValue(a.value);
    const rb = aspectRatioValue(b.value);
    if (ra == null) return rb == null ? 0 : -1;
    if (rb == null) return 1;
    return ra - rb;
  });
}

export interface FramePixels {
  width: number;
  height: number;
  /** True when the size is the one the model is sent (a provider size table), false when worked out from the tier. */
  exact: boolean;
}

const roundTo = (value: number, step: number) => Math.max(step, Math.round(value / step) * step);

/**
 * The output size a ratio would come out at with the rest of the current
 * choices: the provider's own size table where there is one (OpenAI's `size`),
 * otherwise worked out from the resolution tier (a "1K" image keeps about a
 * megapixel whatever its shape; "720p" fixes the short edge). Picking the ratio
 * may move another option first (applyParamChange), and the size follows it.
 * Null when the model fixes no size at all (Auto, or no resolution option).
 */
export function framePixels(modelId: string, params: MediaParams, aspect: unknown): FramePixels | null {
  const caps = capabilitiesFor(modelId);
  const ratio = aspectRatioValue(aspect);
  if (!caps || ratio == null) return null;
  const next = caps.options.aspect ? applyParamChange(modelId, params, "aspect", aspect) : normalizeParams(modelId, params);
  if (caps.composed) {
    const key = caps.composed.from.map((k) => String(k === "aspect" ? aspect : next[k])).join("|");
    const m = caps.composed.table[key]?.match(/^(\d+)x(\d+)$/);
    if (m) return { width: Number(m[1]), height: Number(m[2]), exact: true };
  }
  const tier = next.resolution;
  if (typeof tier !== "string") return null;
  const p = tier.match(/^(\d+)p$/);
  const short = p ? Number(p[1]) : caps.kind === "video" && tier === "4K" ? 2160 : null;
  if (short != null) {
    const width = ratio >= 1 ? roundTo(short * ratio, 2) : short;
    const height = ratio >= 1 ? short : roundTo(short / ratio, 2);
    const standard = aspect === "16:9" || aspect === "9:16" || aspect === "1:1";
    return { width, height, exact: standard };
  }
  const k = tier.match(/^(\d+(?:\.\d+)?)K$/);
  if (!k) return null;
  const area = (Number(k[1]) * 1024) ** 2;
  const width = roundTo(Math.sqrt(area * ratio), 8);
  const height = roundTo(Math.sqrt(area / ratio), 8);
  return { width, height, exact: ratio === 1 };
}

/** "1536 × 864", or "≈ 1368 × 768" when the size is worked out rather than sent. */
export function formatFramePixels(px: FramePixels | null): string | null {
  if (!px) return null;
  return `${px.exact ? "" : "≈ "}${px.width} × ${px.height}`;
}
