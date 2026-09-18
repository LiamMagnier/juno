import { NextResponse } from "next/server";

import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  githubWebhookSecretFromEnv,
  verifyGithubWebhookSignature,
} from "@/lib/github-app";
import { readAutoFixDelivery } from "@/lib/code-autofix";
import { answerAutoFixDelivery, findAutoFixWatches } from "@/lib/code-autofix-dispatch";

export const runtime = "nodejs";

/**
 * The GitHub App's webhook.
 *
 *   POST → 200 { ok: true, … }   accepted, whatever came of it
 *          202 { ok: false }     no webhook secret configured on this server
 *          401 { ok: false }     the signature does not verify
 *
 * ── THE SIGNATURE IS THE WHOLE PERIMETER ───────────────────────────────────
 *
 * This URL is public and unauthenticated by construction: GitHub cannot hold a
 * session. What arrives downstream of it dispatches a cloud run that clones a
 * repository, edits it and pushes with a credential the server holds. So the
 * ONLY thing that separates a real delivery from anyone on the internet naming
 * a pull request is the HMAC, and it is checked before the body is parsed —
 * `verifyGithubWebhookSignature` signs the raw bytes GitHub sent, because a
 * reparsed body is a different byte string and a check that fails on honest
 * traffic is a check someone eventually deletes.
 *
 * With no secret configured the route accepts nothing. 202 rather than 401 for
 * that case: the delivery is not forged, the server simply is not listening,
 * and GitHub's delivery log should say so rather than showing a failure a
 * maintainer would go looking for in the wrong place.
 *
 * ── ALWAYS 200 AFTERWARDS ──────────────────────────────────────────────────
 *
 * Once the signature holds, every outcome is a 200. GitHub disables a webhook
 * that keeps failing, and almost everything that can go wrong here — an event
 * about a pull request nobody watches, a duplicate, a runner that is down — is
 * an ordinary answer rather than a fault in the delivery. A redelivery would
 * change none of them. The body says what happened for the delivery log.
 *
 * ── AND NOTHING IN THE PAYLOAD IS AN INSTRUCTION ───────────────────────────
 *
 * A check-run name, a check-run output, a review and a review comment are
 * written by whoever can comment on that pull request. This route reads five
 * facts out of a delivery — which repository, which pull request, which branch,
 * which piece of evidence, and its text — and hands the text on fenced and
 * labelled. It never branches on what the text says. See src/lib/code-autofix.ts.
 */
export async function POST(req: Request) {
  const secret = githubWebhookSecretFromEnv();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "webhook_not_configured" },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }

  // The raw bytes, read once. `req.text()` before any parse is what makes the
  // signature checkable at all.
  const raw = await req.text().catch(() => null);
  const signature = req.headers.get(GITHUB_SIGNATURE_HEADER);
  if (raw === null || !verifyGithubWebhookSignature({ secret, payload: raw, signature })) {
    return NextResponse.json(
      { ok: false, error: "bad_signature" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const eventName = req.headers.get(GITHUB_EVENT_HEADER) ?? "";
  const deliveryId = req.headers.get(GITHUB_DELIVERY_HEADER) ?? "";
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Signed, and still not JSON. Accepted so GitHub stops retrying it, and
    // logged, because it means the App is sending something this server does
    // not understand.
    console.warn(`[github-webhook] ${eventName} delivery ${deliveryId} was not JSON`);
    return ok({ outcome: "malformed" });
  }

  const reading = readAutoFixDelivery(eventName, payload);
  if (!reading.act) return ok({ outcome: "ignored", reason: reading.reason });

  const watches = await findAutoFixWatches(reading.event);
  // The ordinary case by a wide margin: auto-fix is off by default, so most
  // deliveries are about a pull request nobody asked Juno to watch. Nothing is
  // recorded for them — a table of events nobody opted into is a log of other
  // people's repositories.
  if (watches.length === 0) return ok({ outcome: "not_watched" });

  /*
   * The body says what happened in Juno's own vocabulary and NAMES NOTHING.
   * GitHub shows a delivery's response to anyone who can administer the
   * repository's webhooks, and which of Juno's rows answered it is none of
   * their business — the outcome is what makes the delivery log useful.
   */
  const outcomes: string[] = [];
  for (const watch of watches) {
    try {
      const result = await answerAutoFixDelivery({ watch, event: reading.event });
      if (!result) {
        outcomes.push("duplicate");
        continue;
      }
      outcomes.push(result.outcome === "skipped" ? `skipped:${result.reason}` : result.outcome);
    } catch (err) {
      // One watch failing must not take the others down, and must not fail the
      // delivery: a 500 here has GitHub retry a body that will fail again.
      console.error(`[github-webhook] auto-fix failed for watch ${watch.id}`, err);
      outcomes.push("error");
    }
  }

  return ok({ outcome: "handled", results: outcomes });
}

function ok(body: Record<string, unknown>) {
  return NextResponse.json({ ok: true, ...body }, { headers: { "Cache-Control": "no-store" } });
}
