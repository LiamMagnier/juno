import { headers } from "next/headers";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Fixed-window rate limiter backed by Postgres so it works across serverless
 * instances. The read-modify-write is a single atomic INSERT ... ON CONFLICT,
 * so concurrent requests cannot race past the limit or reset each other's window.
 * `key` should be scoped, e.g. `chat:<userId>` or `upload:<ip>`.
 */
export async function rateLimit(opts: {
  key: string;
  limit: number;
  windowSec: number;
}): Promise<RateLimitResult> {
  const { key, limit, windowSec } = opts;
  const resetAt = new Date(Date.now() + windowSec * 1000);

  const rows = await prisma.$queryRaw<Array<{ count: number; expiresAt: Date }>>(Prisma.sql`
    INSERT INTO "RateLimit" ("key", "count", "expiresAt")
    VALUES (${key}, 1, ${resetAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."expiresAt" <= now() THEN 1 ELSE "RateLimit"."count" + 1 END,
      "expiresAt" = CASE WHEN "RateLimit"."expiresAt" <= now() THEN ${resetAt} ELSE "RateLimit"."expiresAt" END
    RETURNING "count", "expiresAt";
  `);

  const row = rows[0];
  const count = Number(row?.count ?? 1);
  const expiresAt = row?.expiresAt ?? resetAt;
  return { success: count <= limit, remaining: Math.max(0, limit - count), resetAt: expiresAt };
}

/**
 * Best-effort client IP from a Headers object. The left-most X-Forwarded-For
 * entry is client-supplied and spoofable, so we do NOT trust it: prefer
 * X-Real-IP (nginx sets it to $remote_addr, the true peer), and otherwise take
 * the RIGHT-most X-Forwarded-For entry (the hop the trusted proxy appended).
 * Returns "unknown" when no proxy header is present (e.g. plain local dev).
 */
export function ipFromHeaders(h: Headers): string {
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return "unknown";
}

/** Best-effort client IP from the current request context. */
export async function getClientIp(): Promise<string> {
  return ipFromHeaders(await headers());
}
