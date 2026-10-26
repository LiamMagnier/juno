import { Bell, type IconComponent } from "@/components/ui/icons";
import { AppIcons, CodeIcons, SettingsIcons } from "@/lib/app-icons";
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
 * mirrored into the Mac app); these are the web's own. Two, so the rail is
 * twelve rows, the size of ChatGPT's and Claude's give or take the Macs and
 * Code this product also covers. Every other web-only pane was folded into
 * the section a reader would look for it in, and its old id still opens
 * that section (RETIRED_WEB_SECTIONS):
 *
 *   Appearance, Keyboard     -> General (the contract already aliases
 *                               `appearance` there; General was otherwise one
 *                               dropdown)
 *   Capabilities             -> retired: Wrap long code lines is a Reading
 *                               setting (General), conversations messaging
 *                               each other is Memory's
 *   Remote                   -> Devices, as "This browser": two sections
 *                               listed your Macs, with two ways to revoke
 *   Connections, Agents,
 *   Permissions              -> Code, one section like Claude's: four rows
 *                               that each held one part of how Code runs
 */
export const WEB_SETTINGS_SECTIONS = [
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "code", label: "Code", icon: AppIcons.code },
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
  { label: "Personal", ids: ["general", "notifications", "personalization", "memory", "models", "voice", "account", "data", "billing"] },
  { label: "Integrations", ids: ["connectors", "devices"] },
  { label: "Coding", ids: ["code"] },
];

/**
 * Words a search in the rail should find each section by: its rows' labels,
 * and the everyday words people type for them ("cancel subscription", "dark
 * mode", "log out"), which are rarely the words a row is titled with.
 */
export const SETTINGS_KEYWORDS: Record<SettingsSectionId, string> = {
  code: "code session defaults work log generation image video music agents subagents team orchestration roles budget permissions access ask auto edits commands connections subscriptions api key keys byok own key anthropic openai gemini xai grok deepseek claude chatgpt",
  general:
    "language interface locale appearance theme light dark system mode dark mode light mode accent color colour text size font chat font serif mono width transcript motion animation reduce reading wrap long code lines keyboard shortcuts keys hotkeys send enter return capabilities",
  notifications: "notify notification alert sound sounds chime email budget digest background reply push browser",
  personalization: "name nickname call you instructions custom instructions personality style tone response language about you",
  memory: "memory remember saved memories forget sensitive health money learn background conversations message each other cross capabilities",
  models: "model default model auto favourite favorite fast mode pinned thinking effort web search labs train training",
  connectors: "apps connectors integrations mcp permissions github google lockdown approval actions",
  voice: "voice read aloud speech dictation tts sound sounds chime chimes call calls",
  devices: "devices mac macs computer host permissions remote pair paired unpair QR iPhone browser revoke access",
  account: "profile picture photo avatar name username handle email password security two-step 2fa mfa two-factor authentication sign out log out logout delete account sessions",
  data: "export import data privacy shared links delete conversations delete chats delete all archive chatgpt claude",
  billing: "plan upgrade downgrade billing usage spend limit invoice invoices receipt receipts refund refunds vat tax subscription cancel subscription budget ceiling cap payment method card pro invite invites friend friends referral referrals refer reward rewards invitation invitations",
};

export const ALL_SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [...SETTINGS_SECTIONS, ...WEB_SETTINGS_SECTIONS];

/**
 * Does a section answer a search? Every word the reader typed has to start a
 * word in the section's name or its keywords, in any order: "dark mode" finds
 * Appearance, "cancel subscription" finds Plan & usage, and "voice" no longer
 * finds Plan & usage through "invoice". A plain substring test on the whole
 * query found neither of the first two and the third by accident.
 *
 * The word start is "not after a letter or digit" rather than `\b`, which in
 * JavaScript only knows ASCII letters.
 */
export function settingsSectionMatches(section: SettingsSectionMeta, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${section.label} ${SETTINGS_KEYWORDS[section.id]}`.toLowerCase();
  return words.every((word) =>
    new RegExp(`(?:^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(haystack)
  );
}

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

/**
 * Web-only sections that were folded into another, so a bookmark, an old
 * `juno:settings` detail or a link elsewhere in the product (Code's "Use your
 * own API key" opens `connections`) still lands on the section that now holds
 * it. Kept out of ALIASES, which is the shell contract's list
 * (tests/shell-contract.test.ts) and which the Mac app mirrors: these are the
 * web's own retirements, and the Mac keeps its own sections. `appearance` is
 * not here: the contract already aliases it to General.
 */
const RETIRED_WEB_SECTIONS: Record<string, SettingsSectionId> = {
  keyboard: "general",
  "code-keyboard": "general",
  capabilities: "general",
  remote: "devices",
  connections: "code",
  "code-agent": "code",
  "code-permissions": "code",
};

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === "string" && ALL_SETTINGS_SECTIONS.some((s) => s.id === value);
}

export function resolveSettingsSection(value: unknown): SettingsSectionId {
  if (isSettingsSectionId(value)) return value;
  if (typeof value === "string" && value in ALIASES) return ALIASES[value];
  if (typeof value === "string" && value in RETIRED_WEB_SECTIONS) return RETIRED_WEB_SECTIONS[value];
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
