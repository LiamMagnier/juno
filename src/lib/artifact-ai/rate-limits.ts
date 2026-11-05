import "server-only";
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";

/*
 * Abuse caps on what an artifact's code can do through `window.alevr`, on top
 * of the money gates in complete.ts (which bound what a call COSTS) and the
 * storage caps in storage.ts (which bound what it KEEPS). These bound how
 * often, so a page in a loop meets a 429 in a minute rather than a bill.
 *
 * Per viewer, because the viewer is who pays: a person's own apps share one
 * minute budget and one daily budget for completions. A shared or published
 * page additionally gets its own daily budget per (visitor, artifact), so one
 * stranger's page cannot use up a visitor's whole day. Storage calls are
 * cheap but each is a database round trip; reads and writes have separate
 * budgets sized for an app saving as the person types.
 *
 * The owner account is exempt, as on the other artifact routes; its spend is
 * still gated by its budget like anyone's.
 */
export const ARTIFACT_RUNTIME_BUDGETS = {
  complete: { limit: 30, windowSec: 60 },
  completeDaily: { limit: 600, windowSec: 86_400 },
  completeLinkDaily: { limit: 200, windowSec: 86_400 },
  storageRead: { limit: 1200, windowSec: 60 },
  storageWrite: { limit: 300, windowSec: 60 },
} as const;

type Bucket = keyof typeof ARTIFACT_RUNTIME_BUDGETS;

async function over(bucket: Bucket, key: string): Promise<number | null> {
  const budget = ARTIFACT_RUNTIME_BUDGETS[bucket];
  const result = await rateLimit({ key: `artifact-runtime-${bucket}:${key}`, limit: budget.limit, windowSec: budget.windowSec });
  if (result.success) return null;
  return Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
}

function limited(retryAfter: number, error: string): NextResponse {
  return NextResponse.json(
    { error, code: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

/** The 429 for a completion over any of its budgets, or null to go on. */
export async function artifactCompletionLimited(
  user: { id: string; email?: string | null },
  access: { artifactId: string; via: "owner" | "link" }
): Promise<NextResponse | null> {
  if (isOwnerEmail(user.email)) return null;
  const minute = await over("complete", user.id);
  if (minute) return limited(minute, "This app is asking for AI too often. Try again in a moment.");
  const day = await over("completeDaily", user.id);
  if (day) return limited(day, "You've reached today's limit for AI in apps. It resets within a day.");
  if (access.via === "link") {
    const link = await over("completeLinkDaily", `${user.id}:${access.artifactId}`);
    if (link) return limited(link, "This app has reached today's AI limit for your account.");
  }
  return null;
}

/** The 429 for a storage call over its budget, or null to go on. */
export async function artifactStorageLimited(
  user: { id: string; email?: string | null },
  kind: "read" | "write"
): Promise<NextResponse | null> {
  if (isOwnerEmail(user.email)) return null;
  const retryAfter = await over(kind === "read" ? "storageRead" : "storageWrite", user.id);
  return retryAfter ? limited(retryAfter, "This app is saving too often. Try again in a moment.") : null;
}
