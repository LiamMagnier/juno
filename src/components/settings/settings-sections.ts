import type { LucideIcon } from "lucide-react";
import {
  CreditCard,
  Database,
  Mic,
  NotebookPen,
  Plug,
  Settings2,
  Sparkles,
  User,
  Wand2,
} from "lucide-react";

/**
 * The settings sections — one registry for the modal rail, the `/settings`
 * page rail, the `?section=` query and the `juno:settings` window event.
 *
 * Order is reading order: how Juno looks, how it talks, what it remembers,
 * which models it uses, what it may reach, how it sounds — then the account
 * and the money. Irreversible operations live at the bottom of Account and
 * Data & privacy, not in a "danger zone" section of their own: a section
 * whose only content is destruction reads as a dare.
 */
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", icon: Settings2, description: "Theme, accent, language and text size." },
  { id: "personalization", label: "Personalization", icon: Sparkles, description: "How Juno writes and what it keeps in mind." },
  { id: "memory", label: "Memory", icon: NotebookPen, description: "What Juno may remember between conversations." },
  { id: "models", label: "Models", icon: Wand2, description: "Which model answers by default, and how hard it thinks." },
  { id: "connectors", label: "Connectors", icon: Plug, description: "The apps Juno can read from and act on." },
  { id: "voice", label: "Voice", icon: Mic, description: "How Juno sounds, and how you talk to it." },
  { id: "data", label: "Data & privacy", icon: Database, description: "Export, import, shared links and deletion." },
  { id: "account", label: "Account", icon: User, description: "Who you are to Juno, and how you sign in." },
  { id: "billing", label: "Plan & billing", icon: CreditCard, description: "Your plan, what you have used, and the ceiling." },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon; description: string }[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "general";

/**
 * Aliases the rest of the product dispatches on `juno:settings` (and older
 * links use in `?section=`). Kept permissive: an unknown detail opens General
 * rather than nothing.
 */
const ALIASES: Record<string, SettingsSectionId> = {
  profile: "account",
  permissions: "connectors",
  "connected-apps": "connectors",
  usage: "billing",
  plan: "billing",
  appearance: "general",
  theme: "general",
  chat: "personalization",
  style: "personalization",
  instructions: "personalization",
  danger: "account",
  privacy: "data",
};

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === "string" && SETTINGS_SECTIONS.some((s) => s.id === value);
}

export function resolveSettingsSection(value: unknown): SettingsSectionId {
  if (isSettingsSectionId(value)) return value;
  if (typeof value === "string" && value in ALIASES) return ALIASES[value];
  return DEFAULT_SETTINGS_SECTION;
}

export function settingsSection(id: SettingsSectionId) {
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0];
}

/** Open the settings modal anywhere in the app. */
export function openSettings(section?: SettingsSectionId | string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("juno:settings", { detail: section ?? DEFAULT_SETTINGS_SECTION }));
}
