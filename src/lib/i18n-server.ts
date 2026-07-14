import "server-only";
import { headers } from "next/headers";
import { localeFromAcceptLanguage } from "@/lib/i18n";

export async function getRequestLocale(): Promise<string> {
  return localeFromAcceptLanguage((await headers()).get("accept-language"));
}
