import type { IconComponent } from "@/components/ui/icons";
import { CodeIcons, SettingsIcons } from "@/lib/app-icons";

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
  { id: "memory", label: "Memory", icon: SettingsIcons.memory },
  { id: "models", label: "Models", icon: SettingsIcons.models },
  { id: "connectors", label: "Connectors", icon: SettingsIcons.connectors },
  { id: "devices", label: "Devices", icon: CodeIcons.device },
  { id: "voice", label: "Voice", icon: SettingsIcons.voice },
  { id: "data", label: "Data & privacy", icon: SettingsIcons.data },
  { id: "account", label: "Account", icon: SettingsIcons.account },
  { id: "billing", label: "Plan & usage", icon: SettingsIcons.billing },
] as const satisfies readonly { id: string; label: string; icon: IconComponent }[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

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

/** The `/settings` URL for a section: General is the bare page. */
export function settingsHref(id: SettingsSectionId): string {
  return id === DEFAULT_SETTINGS_SECTION ? "/settings" : `/settings?section=${id}`;
}

/** Open settings at a section from anywhere in the app. */
export function openSettings(section?: SettingsSectionId | string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("juno:settings", { detail: section ?? DEFAULT_SETTINGS_SECTION }));
}
