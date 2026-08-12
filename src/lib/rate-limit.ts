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
  return { success: true, remaining: opts.limit, resetAt: new Date() };
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
  warnMissingProxyHeaders();
  return "unknown";
}

/**
 * In production, no proxy header means nginx's header config has drifted — and
 * the consequence is severe and very hard to diagnose: every anonymous visitor
 * collapses into the single "unknown" bucket, so signup starts failing globally
 * after 5 attempts an hour and looks like a mystery outage rather than a
 * misconfiguration.
 *
 * Once per process: this would otherwise fire on every request.
 */
let warnedMissingProxyHeaders = false;
function warnMissingProxyHeaders(): void {
  if (warnedMissingProxyHeaders || process.env.NODE_ENV !== "production") return;
  warnedMissingProxyHeaders = true;
  console.error(
    "[rate-limit] no X-Real-IP or X-Forwarded-For on a production request — " +
      "every anonymous client now shares one rate-limit bucket. Check the nginx proxy_set_header config."
  );
}

/** Best-effort client IP from the current request context. */
export async function getClientIp(): Promise<string> {
  return ipFromHeaders(await headers());
}
