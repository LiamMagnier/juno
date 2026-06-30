import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export interface InitialPreferences {
  accent: string;
  theme: "light" | "dark" | "system";
}

/** Read theme + accent for the initial server render (defaults if signed out). */
export async function getInitialPreferences(): Promise<InitialPreferences> {
  const user = await getCurrentUser();
  if (!user) return { accent: "coral", theme: "system" };

  const settings = await prisma.settings.findUnique({ where: { userId: user.id } });
  return {
    accent: settings?.accent ?? "coral",
    theme: (settings?.theme?.toLowerCase() as InitialPreferences["theme"]) ?? "system",
  };
}
