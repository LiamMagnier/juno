import { Bell, Keyboard, KeyRound, Sparkles, Sun, type IconComponent } from "@/components/ui/icons";
import { CodeIcons, SettingsIcons } from "@/lib/app-icons";
import { FEATURE_NAMES } from "@/lib/brand/names";

/**
 * The settings sections: one registry for the modal rail, the `/settings`
 * page rail, the `?section=` query and the `juno:settings` window event.
 *
 * Order is reading order: how Juno looks, how it talks, what it remembers,
 * which models it uses, what it may reach (apps, then your own Macs), how it
 * sounds, then your data, the account and the money. Irreversible operations
 * live at the bottom of Data & privacy and Account, not in a "danger zone"
 * section of their own: a section whose only content is destruction reads as
 * a dare.
 *
 * The marks come from the shared registries in `app-icons.ts` rather than
 * being imported here one by one, so the rail cannot drift from the rest of
 * the shell. Devices wears the Mac mark the Work surfaces already use for a
 * machine Juno can reach.
 */
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", icon: SettingsIcons.general },
  { id: "personalization", label: "Personalization", icon: SettingsIcons.personalization },
  { id: "memory", label: FEATURE_NAMES.memory.label, icon: SettingsIcons.memory },
  { id: "models", label: "Models", icon: SettingsIcons.models },
  { id: "connectors", label: FEATURE_NAMES.apps.label, icon: SettingsIcons.connectors },
  { id: "devices", label: "Devices", icon: CodeIcons.device },
  { id: "voice", label: "Voice", icon: SettingsIcons.voice },
  { id: "data", label: "Data & privacy", icon: SettingsIcons.data },
  { id: "account", label: "Account", icon: SettingsIcons.account },
  { id: "billing", label: "Plan & usage", icon: SettingsIcons.billing },
] as const satisfies readonly { id: string; label: string; icon: IconComponent }[];

/**
 * Sections the web draws that the shared shell contract does not carry yet.
 *
 * SETTINGS_SECTIONS is the contract (contracts/product/juno-shell-v1.json,
 * mirrored into the Mac app); these are web-only panes for per-device
 * preferences. They sit in the same rail, in their groups, and resolve before
 * the contract's aliases (so `/settings?section=appearance` opens Appearance
 * here, while the Mac keeps routing it to General).
 */
export const WEB_SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Sun },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "capabilities", label: "Capabilities", icon: Sparkles },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
  // Alevr Code v2: your own API keys (BYOK). Web-only until the Mac's
  // Connections settings (code-v2 mac lane) land in the shell contract.
  { id: "connections", label: "Connections", icon: KeyRound },
] as const satisfies readonly { id: string; label: string; icon: IconComponent }[];

type SharedSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
type WebSectionId = (typeof WEB_SETTINGS_SECTIONS)[number]["id"];
export type SettingsSectionId = SharedSectionId | WebSectionId;
export type SettingsSectionMeta = { id: SettingsSectionId; label: string; icon: IconComponent };

/**
 * The rail, grouped the way ChatGPT and Claude group theirs: you and this
 * screen, what the assistant can do and reach, then the account.
 */
export const SETTINGS_GROUPS: { label: string; ids: SettingsSectionId[] }[] = [
  { label: "Personal", ids: ["general", "appearance", "notifications", "personalization", "keyboard"] },
  { label: "Assistant", ids: ["capabilities", "memory", "models", "connectors", "connections", "voice", "devices"] },
  { label: "Account", ids: ["account", "data", "billing"] },
];

/** Words a search in the rail should find each section by (its rows' labels). */
export const SETTINGS_KEYWORDS: Record<SettingsSectionId, string> = {
  general: "language interface locale send enter shortcut",
  appearance: "theme light dark system mode accent color colour text size font chat font serif mono width transcript motion animation reduce",
  notifications: "notify notification alert sound chime email budget digest background reply",
  personalization: "name instructions custom personality style tone response language about you",
  keyboard: "shortcuts keys hotkeys keyboard send enter",
  capabilities: "tools follow-up suggestions code wrap memory apps models voice",
  memory: "memory remember saved memories sensitive learn background",
  models: "model default favourite favorite fast mode pinned",
  connectors: "apps connectors integrations mcp permissions github google",
  connections: "api key keys byok own key anthropic openai gemini xai grok deepseek subscription code",
  voice: "voice read aloud speech dictation tts",
  devices: "devices mac computer host permissions code",
  account: "profile picture name username handle email password security two-step sign out delete account sessions",
  data: "export import data privacy shared links delete conversations chatgpt claude",
  billing: "plan upgrade billing usage spend limit invoice subscription",
};

export const ALL_SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [...SETTINGS_SECTIONS, ...WEB_SETTINGS_SECTIONS];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "general";

/**
 * Aliases the rest of the product dispatches on `juno:settings` (and older
 * links use in `?section=`). Kept permissive: an unknown detail opens General
 * rather than nothing.
 *
 * `permissions` points at Devices now. The sidebar's "Permissions" entry is
 * gone, and what it opened (the Macs Juno can reach, and what it always asks
 * before doing on them) is what Devices shows; connector permissions are
 * still reachable as `connector-permissions`.
 */
const ALIASES: Record<string, SettingsSectionId> = {
  profile: "account",
  security: "account",
  permissions: "devices",
  macs: "devices",
  hosts: "devices",
  "connected-apps": "connectors",
  "connector-permissions": "connectors",
  usage: "billing",
  plan: "billing",
  "plan-usage": "billing",
  appearance: "general",
  theme: "general",
  language: "general",
  chat: "personalization",
  style: "personalization",
  instructions: "personalization",
  danger: "account",
  privacy: "data",
};

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === "string" && ALL_SETTINGS_SECTIONS.some((s) => s.id === value);
}

export function resolveSettingsSection(value: unknown): SettingsSectionId {
  if (isSettingsSectionId(value)) return value;
  if (typeof value === "string" && value in ALIASES) return ALIASES[value];
  return DEFAULT_SETTINGS_SECTION;
}

export function settingsSection(id: SettingsSectionId): SettingsSectionMeta {
  return ALL_SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0];
}

/** The `/settings` URL for a section: General is the bare page. */
export function settingsHref(id: SettingsSectionId): string {
  return id === DEFAULT_SETTINGS_SECTION ? "/settings" : `/settings?section=${id}`;
}

/** Open settings at a section from anywhere in the app. */
export function openSettings(section?: SettingsSectionId | string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("juno:settings", { detail: section ?? DEFAULT_SETTINGS_SECTION }));
}
