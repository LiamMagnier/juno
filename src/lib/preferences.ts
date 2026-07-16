import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { AUTO_LOCALE } from "@/lib/i18n";

export interface InitialPreferences {
  accent: string;
  theme: "light" | "dark" | "system";
  /** "auto" = follow Accept-Language; otherwise a BCP-47 tag the user chose. */
  uiLocale: string;
}

/** Read theme + accent + interface locale for the initial server render (defaults if signed out). */
export async function getInitialPreferences(): Promise<InitialPreferences> {
  const user = await getCurrentUser();
  if (!user) return { accent: "coral", theme: "system", uiLocale: AUTO_LOCALE };

  const settings = await prisma.settings.findUnique({ where: { userId: user.id } });
  return {
    accent: settings?.accent ?? "coral",
    theme: (settings?.theme?.toLowerCase() as InitialPreferences["theme"]) ?? "system",
    uiLocale: settings?.uiLocale ?? AUTO_LOCALE,
  };
}
