"use client";

import { useUiLocale } from "@/lib/i18n-format";
import { shellString, type ShellStringKey } from "@/lib/strings";

/**
 * The shared string table (spec §6.18) in the reader's interface language:
 * `useShellString()("status.running")` → "Running" / "En cours". The table
 * carries English and French; other languages get English, which the web's
 * i18n layer translates like any other literal.
 */
export function useShellString(): (key: ShellStringKey, vars?: Record<string, string | number>) => string {
  const locale = useUiLocale();
  return (key, vars) => shellString(key, vars, locale);
}
