import { prisma } from "@/lib/prisma";

/**
 * Whether this account has the Mac app: the evidence "Open in Mac app" needs
 * before it asks the browser for `com.liammagnier.juno://open`
 * (src/lib/desktop-app-link.ts). A scheme nobody registered makes Safari say
 * the address is invalid, so the website only tries it when a Mac has been
 * seen recently.
 *
 * Three signals, each scoped to the signed-in account (the ownership guard in
 * src/lib/db.ts insists on the `userId`):
 *  - the Mac's sign-in (NativeDeviceSession, platform "macOS", not revoked),
 *    whose lastSeenAt moves with every token refresh;
 *  - the Code host it registers (CodeDevice, platform "macos");
 *  - its push token (DevicePushToken, platform "macos", active).
 * A Mac seen through any of them in the last MAC_APP_RECENT_DAYS counts.
 */

export const MAC_APP_RECENT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MacAppPresence = { installed: boolean; lastSeenAt: string | null };

/** The latest of the dates seen, as the route reports it. Pure. */
export function macAppPresence(seen: Array<Date | null | undefined>): MacAppPresence {
  const latest = seen.reduce<Date | null>((best, date) => (date && (!best || date > best) ? date : best), null);
  return { installed: latest !== null, lastSeenAt: latest ? latest.toISOString() : null };
}

export async function loadMacAppPresence(userId: string, now: Date = new Date()): Promise<MacAppPresence> {
  const since = new Date(now.getTime() - MAC_APP_RECENT_DAYS * DAY_MS);
  const [session, host, push] = await Promise.all([
    prisma.nativeDeviceSession.findFirst({
      where: { userId, revokedAt: null, platform: { equals: "macos", mode: "insensitive" }, lastSeenAt: { gte: since } },
      orderBy: { lastSeenAt: "desc" },
      select: { lastSeenAt: true },
    }),
    prisma.codeDevice.findFirst({
      where: { userId, platform: { equals: "macos", mode: "insensitive" }, lastSeenAt: { gte: since } },
      orderBy: { lastSeenAt: "desc" },
      select: { lastSeenAt: true },
    }),
    prisma.devicePushToken.findFirst({
      where: { userId, platform: "macos", active: true, updatedAt: { gte: since } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
  ]);
  return macAppPresence([session?.lastSeenAt, host?.lastSeenAt, push?.updatedAt]);
}
