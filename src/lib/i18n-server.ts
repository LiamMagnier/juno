import "server-only";
import { headers } from "next/headers";
import { localeFromAcceptLanguage, resolveUiLocale } from "@/lib/i18n";

/** The browser's own preference, ignoring any stored override. */
export async function getAcceptLanguageLocale(): Promise<string> {
  return localeFromAcceptLanguage((await headers()).get("accept-language"));
}

/**
 * The locale the interface renders in. An explicit stored choice wins; "auto"
 * (or none) falls back to Accept-Language. Resolved server-side so `<html lang>`
 * and `dir` are correct on first paint.
 */
export async function getRequestLocale(override?: string | null): Promise<string> {
  return resolveUiLocale(override, await getAcceptLanguageLocale());
}
