/**
 * The shared string table (wave 2 spec §6.18), formatted for the web.
 *
 * `shell.generated.ts` is the table as data, generated from
 * contracts/product/juno-shell-v1.json — the same table the Mac reads as
 * `JunoShellStrings` and the iPhone as `Shell.xcstrings`. A string changed in
 * the contract changes on all three, so the web never types one of these
 * sentences again: it asks for the key.
 *
 *   shellString("now.updates", { n: 3 })               → "3 updates"
 *   shellString("home.greetingNamed", { firstName })   → "What’s next, Ada?"
 *   shellString("turn.thoughtFor", { n: 4 }, "fr")     → "Réflexion de 4 s"
 *
 * The table carries English and French. Any other interface language gets the
 * English source, which the web's i18n layer translates like every other
 * literal (src/lib/i18n-phrase.tsx), so a key is never blank.
 */

import { SHELL_INT_ARGS, SHELL_STRINGS, type ShellPlural, type ShellStringKey } from "./shell.generated";

export { SHELL_LOCALES, SHELL_RETIRED_STRINGS, SHELL_STRINGS, type ShellStringKey } from "./shell.generated";

/** The table's two languages. */
export type ShellLocale = "en" | "fr";

/** The table language for an interface locale: French for any `fr-*`, English otherwise. */
export function shellLocale(locale: string | null | undefined): ShellLocale {
  return typeof locale === "string" && /^fr(?:[-_]|$)/i.test(locale.trim()) ? "fr" : "en";
}

type Vars = Record<string, string | number>;

const INT_ARGS = new Set<string>(SHELL_INT_ARGS);

function interpolate(text: string, vars: Vars, locale: ShellLocale): string {
  return text.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) return whole;
    if (INT_ARGS.has(name) && typeof value === "number") return new Intl.NumberFormat(locale).format(value);
    return String(value);
  });
}

/**
 * The string for `key` in `locale`, with `{name}` placeholders filled from
 * `vars`. Plural entries choose their form with the CLDR rules for the
 * language (French counts 0 as singular). A placeholder with no value is left
 * as written, so a missing argument shows up in review rather than as "".
 */
export function shellString(key: ShellStringKey, vars: Vars = {}, locale: string = "en"): string {
  const entry = SHELL_STRINGS[key] as { en: string | ShellPlural; fr: string | ShellPlural; plural?: string };
  const language = shellLocale(locale);
  const value = entry[language];
  if (typeof value === "string") return interpolate(value, vars, language);
  const count = Number(vars[entry.plural ?? ""] ?? 0);
  const form = new Intl.PluralRules(language).select(count) === "one" ? value.one : value.other;
  return interpolate(form, vars, language);
}

/** Apple's Title Case, for the few menu commands the Mac shows in its menu bar. English only. */
export function shellMenuTitle(key: ShellStringKey, locale: string = "en"): string {
  const text = shellString(key, {}, locale);
  if (shellLocale(locale) !== "en") return text;
  const minor = new Set(["a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet", "as", "at", "by", "in", "of", "off", "on", "per", "to", "up", "via", "from", "into", "onto", "over", "with"]);
  const words = text.split(" ");
  return words
    .map((word, i) => (i > 0 && i < words.length - 1 && minor.has(word.toLowerCase()) ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
