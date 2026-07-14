import "server-only";

import { rateLimit } from "@/lib/rate-limit";

export type ComposioRateLimitAction = "catalog" | "connect" | "callback" | "disconnect";

const LIMITS: Record<
  ComposioRateLimitAction,
  { userLimit: number; globalLimit: number; windowSec: number }
> = {
  // Search is debounced in the UI, but keep enough headroom for fast browsing.
  catalog: { userLimit: 120, globalLimit: 5_000, windowSec: 60 },
  // Mutating connection state is intentionally much tighter.
  connect: { userLimit: 10, globalLimit: 500, windowSec: 10 * 60 },
  callback: { userLimit: 30, globalLimit: 1_500, windowSec: 10 * 60 },
  disconnect: { userLimit: 15, globalLimit: 750, windowSec: 10 * 60 },
};

export async function checkComposioRateLimit(action: ComposioRateLimitAction, userId: string) {
  const config = LIMITS[action];
  const [user, global] = await Promise.all([
    rateLimit({
      key: `composio:${action}:user:${userId}`,
      limit: config.userLimit,
      windowSec: config.windowSec,
    }),
    rateLimit({
      key: `composio:${action}:global`,
      limit: config.globalLimit,
      windowSec: config.windowSec,
    }),
  ]);
  const resetAt = user.resetAt > global.resetAt ? user.resetAt : global.resetAt;
  return {
    success: user.success && global.success,
    retryAfterSec: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)),
  };
}
