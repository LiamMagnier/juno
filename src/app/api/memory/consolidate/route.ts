import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { backgroundDenialMessage } from "@/lib/background-provider-policy";
import { consolidateWithFallback, getMemorySummary, hasMemorySources, utilityModelCandidates } from "@/lib/memory";

export const runtime = "nodejs";
export const maxDuration = 60;

// Hoisted rather than written inline in the ternary below: the i18n extractor
// reads a copy property's literal initializer, and a conditional expression is
// not one — inlining these would silently drop them from the catalog.
const FAILURE_MESSAGE = {
  busy: "The AI provider is busy right now — wait a minute and try again.",
  unusable: "Couldn’t generate a summary right now — try again in a moment.",
};

// Regenerate the consolidated memory summary on demand (the "Regenerate" button).
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (utilityModelCandidates().length === 0) {
    return NextResponse.json({ error: "No model provider is configured." }, { status: 503 });
  }

  if (!(await hasMemorySources(user.id))) return NextResponse.json({ summary: null });

  const outcome = await consolidateWithFallback(user.id);

  // A policy refusal is not a provider outage, and saying so was the bug: the
  // user was told to wait out a rate limit that would never lift, when what
  // they needed was a setting. 409 rather than 502 so the client can tell a
  // rule from a failure without parsing prose.
  if (outcome.status === "denied") {
    return NextResponse.json(
      {
        error: backgroundDenialMessage(outcome.reason),
        code: "background_policy_denied",
        policyMode: outcome.mode,
      },
      { status: 409 }
    );
  }
  if (outcome.status === "empty") return NextResponse.json({ summary: null });
  if (outcome.status === "failed") {
    return NextResponse.json(
      {
        error: outcome.transient ? FAILURE_MESSAGE.busy : FAILURE_MESSAGE.unusable,
        code: "provider_failed",
      },
      { status: 502 }
    );
  }

  const s = await getMemorySummary(user.id);
  return NextResponse.json({
    summary: {
      content: outcome.content,
      updatedAt: s?.updatedAt.toISOString() ?? new Date().toISOString(),
      entryCount: s?.entryCount ?? 0,
    },
  });
}
