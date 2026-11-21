import { ACCENT_IDS } from "@/lib/accents";
import type { ChatFont, ComposerShape, TranscriptWidth } from "@/lib/ui-prefs";

export interface DesignPreset {
  version: 1;
  name: string;
  theme: "system" | "light" | "dark";
  accent: string;
  chatFont: ChatFont;
  transcriptWidth: TranscriptWidth;
  composerShape: ComposerShape;
}

export const BUILT_IN_DESIGNS: readonly DesignPreset[] = [
  { version: 1, name: "Alevr", theme: "system", accent: "coral", chatFont: "default", transcriptWidth: "medium", composerShape: "standard" },
  { version: 1, name: "Paper", theme: "light", accent: "juniper", chatFont: "serif", transcriptWidth: "narrow", composerShape: "compact" },
  { version: 1, name: "Midnight", theme: "dark", accent: "violet", chatFont: "system", transcriptWidth: "medium", composerShape: "soft" },
];

const PRESET_KEYS = new Set<keyof DesignPreset>([
  "version", "name", "theme", "accent", "chatFont", "transcriptWidth", "composerShape",
]);

export function validateDesignPreset(input: unknown): DesignPreset | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { version, name, theme, accent, chatFont, transcriptWidth, composerShape } = input as Partial<DesignPreset>;
  if (Object.keys(input).some((key) => !PRESET_KEYS.has(key as keyof DesignPreset))) return null;
  if (version !== 1 || typeof name !== "string" || /[\u0000-\u001f\u007f]/.test(name)) return null;
  const title = name.trim();
  if (!title || title.length > 40) return null;
  if (theme !== "system" && theme !== "light" && theme !== "dark") return null;
  if (typeof accent !== "string" || (!ACCENT_IDS.some((id) => id === accent) && !/^#[0-9a-f]{6}$/i.test(accent))) return null;
  if (chatFont !== "default" && chatFont !== "system" && chatFont !== "serif" && chatFont !== "mono") return null;
  if (transcriptWidth !== "narrow" && transcriptWidth !== "medium" && transcriptWidth !== "wide") return null;
  if (composerShape !== "compact" && composerShape !== "standard" && composerShape !== "soft") return null;
  return { version, name: title, theme, accent, chatFont, transcriptWidth, composerShape };
}

export function parseDesignPreset(code: string): DesignPreset | null {
  if (code.length > 2048) return null;
  try {
    return validateDesignPreset(JSON.parse(code) as unknown);
  } catch {
    return null;
  }
}
