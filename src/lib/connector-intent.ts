/**
 * Map free-text prompts to connector ids the user likely wants for this turn.
 * Client-safe: no server-only imports. Only enables apps the account already
 * has connected — never starts an OAuth flow from a mention alone.
 */

export const MAX_CHAT_CONNECTORS = 5;

/** Native connector brand cues (id → patterns). Keep these high-precision. */
const NATIVE_HINTS: Record<string, RegExp[]> = {
  github: [/\bgithub\b/i, /\bgithub\.com\b/i, /\bgh\.com\b/i],
  figma: [/\bfigma\b/i, /\bfigjam\b/i],
  notion: [/\bnotion\b/i],
  "apple-calendar": [/\bapple\s*calendar\b/i, /\bicloud\s*calendar\b/i],
  "apple-mail": [/\bapple\s*mail\b/i, /\bicloud\s*mail\b/i],
  "apple-music": [/\bapple\s*music\b/i],
};

export type ConnectorRef = { id: string; label: string };

/**
 * Which of `available` (already connected) connectors the prompt clearly
 * refers to. Order is stable: already-enabled first (caller merges), then
 * native hints, then label/id matches. Caps at `MAX_CHAT_CONNECTORS`.
 */
export function detectConnectorsFromPrompt(
  text: string,
  available: ConnectorRef[],
  alreadyEnabled: string[] = []
): string[] {
  const trimmed = text.trim();
  if (!trimmed || available.length === 0) return [];

  const byId = new Map(available.map((c) => [c.id, c]));
  const picked: string[] = [];
  const add = (id: string) => {
    if (!byId.has(id) || picked.includes(id)) return;
    if (picked.length >= MAX_CHAT_CONNECTORS) return;
    picked.push(id);
  };

  // Keep anything already on so we only fill free slots with new matches.
  for (const id of alreadyEnabled) add(id);

  for (const [id, patterns] of Object.entries(NATIVE_HINTS)) {
    if (patterns.some((re) => re.test(trimmed))) add(id);
  }

  // Composio (and any future) apps: match label or bare id as whole words.
  // "composio:gmail" also matches "gmail".
  for (const c of available) {
    if (picked.includes(c.id)) continue;
    const bare = c.id.includes(":") ? c.id.slice(c.id.indexOf(":") + 1) : c.id;
    const needles = [c.label, bare, c.id].filter(Boolean);
    for (const needle of needles) {
      if (needle.length < 3) continue; // avoid ultra-short false positives
      try {
        const re = new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i");
        if (re.test(trimmed)) {
          add(c.id);
          break;
        }
      } catch {
        /* ignore bad patterns */
      }
    }
  }

  // Return only the ones that were not already enabled (for UI feedback),
  // but the full merge is what callers should enable + send.
  return picked;
}

/** Newly matched ids not already in `alreadyEnabled`. */
export function newlyDetectedConnectors(
  text: string,
  available: ConnectorRef[],
  alreadyEnabled: string[] = []
): string[] {
  const enabled = new Set(alreadyEnabled);
  return detectConnectorsFromPrompt(text, available, alreadyEnabled).filter((id) => !enabled.has(id));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
