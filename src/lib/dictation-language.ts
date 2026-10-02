/**
 * Which language dictation listens for.
 *
 * The browser recognizer hears ONE language per session. It used to be handed
 * `navigator.language`, which on a French speaker's English-configured browser
 * is "en-US": every French sentence came back as the nearest English words, and
 * the live preview looked broken. The language is now a choice the reader can
 * see and change from the dictation bar, remembered per device.
 *
 * Resolution order: the stored choice, then the browser's first preferred
 * language, then the interface locale, then English.
 */

export interface DictationLanguage {
  /** BCP-47 tag the Web Speech API accepts. */
  tag: string;
  /** Name in its own language, for the picker. */
  label: string;
  /** Two-letter mark for the compact chip. */
  short: string;
}

export const DICTATION_LANGUAGES: readonly DictationLanguage[] = [
  { tag: "fr-FR", label: "Français", short: "FR" },
  { tag: "en-US", label: "English", short: "EN" },
  { tag: "es-ES", label: "Español", short: "ES" },
  { tag: "de-DE", label: "Deutsch", short: "DE" },
  { tag: "it-IT", label: "Italiano", short: "IT" },
  { tag: "pt-BR", label: "Português", short: "PT" },
  { tag: "nl-NL", label: "Nederlands", short: "NL" },
  { tag: "pl-PL", label: "Polski", short: "PL" },
  { tag: "ja-JP", label: "日本語", short: "JA" },
  { tag: "ko-KR", label: "한국어", short: "KO" },
  { tag: "zh-CN", label: "中文", short: "ZH" },
];

const STORAGE_KEY = "alevr.dictation.language";

/** Match any tag ("fr", "fr-CA", "FR-fr") to the closest offered language. */
export function matchDictationLanguage(tag: string | null | undefined): DictationLanguage | null {
  if (!tag) return null;
  const lower = tag.trim().toLowerCase();
  if (!lower) return null;
  const exact = DICTATION_LANGUAGES.find((l) => l.tag.toLowerCase() === lower);
  if (exact) return exact;
  const base = lower.split(/[-_]/)[0];
  return DICTATION_LANGUAGES.find((l) => l.tag.toLowerCase().split("-")[0] === base) ?? null;
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeDictationLanguage(tag: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, tag);
  } catch {
    // Private window or blocked storage: the choice lasts for this session only.
  }
}

export function resolveDictationLanguage(uiLocale?: string): DictationLanguage {
  if (typeof window !== "undefined") {
    const stored = matchDictationLanguage(readStored());
    if (stored) return stored;
    const preferred = typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
    for (const tag of preferred) {
      const hit = matchDictationLanguage(tag);
      if (hit) return hit;
    }
  }
  return matchDictationLanguage(uiLocale) ?? DICTATION_LANGUAGES[1];
}
