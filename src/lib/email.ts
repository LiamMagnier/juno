import "server-only";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { budgetAlert } from "@/lib/email-templates";

/**
 * Thin Resend REST client (no SDK) + the lifecycle senders that wrap it.
 *
 * Email is strictly best-effort and flag-gated: without RESEND_API_KEY every
 * send is a silent no-op, and with it a failure is logged and swallowed —
 * nothing in a request path ever throws because a mail didn't go out.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Email delivery is configured (RESEND_API_KEY present). */
export function isEmailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function fromAddress(): string {
  return process.env.EMAIL_FROM ?? "Juno <hello@chat.liams.dev>";
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternate (always provide one — some clients prefer it). */
  text?: string;
}

export type SendEmailResult =
  | { skipped: true }
  | { ok: true; id: string | null }
  | { ok: false };

/**
 * Send one email through Resend. No-ops with `{ skipped: true }` when the API
 * key is missing; never throws into the caller (errors are logged + swallowed).
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true };
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [input.to],
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[email] resend rejected send", { status: res.status, subject: input.subject, detail: detail.slice(0, 300) });
      return { ok: false };
    }
    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    console.error("[email] send failed", {
      subject: input.subject,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

// ----------------------------------------------------------------------------
// Budget alert (80% of the plan budget, once per billing period)
// ----------------------------------------------------------------------------

/** 30 days — dedupe fallback when a billing period end isn't known. */
const FALLBACK_DEDUPE_SEC = 30 * 24 * 60 * 60;

// Per-process memo of alerts already deduped, so requests from a user who is
// past the threshold don't re-hit the RateLimit table on every checkBudget.
// The RateLimit row remains the cross-instance source of truth.
const alertedThisProcess = new Set<string>();

export interface BudgetAlertInput {
  userId: string;
  spentMicroUsd: number;
  budgetMicroUsd: number;
  /** Epoch ms the budget renews (billing period end); null = unknown. */
  resetsAtMs: number | null;
}

/**
 * Fire-and-forget "you've used ~80% of your budget" email. Callers `void` this
 * — it never throws. Layered so the common cases cost nothing:
 *
 *   1. no RESEND_API_KEY → return (no I/O at all);
 *   2. per-process memo hit → return (no I/O);
 *   3. RateLimit upsert keyed on user + period end → exactly one send per
 *      billing period across instances (new period ⇒ new key);
 *   4. opt-out check (settings.emailBudgetAlerts) + user email lookup;
 *   5. send.
 */
export async function sendBudgetAlert(input: BudgetAlertInput): Promise<void> {
  try {
    if (!isEmailEnabled() || input.budgetMicroUsd <= 0) return;

    const dedupeKey = `email:budget80:${input.userId}:${input.resetsAtMs ?? "rolling"}`;
    if (alertedThisProcess.has(dedupeKey)) return;

    const windowSec = input.resetsAtMs
      ? Math.max(60, Math.ceil((input.resetsAtMs - Date.now()) / 1000))
      : FALLBACK_DEDUPE_SEC;
    const gate = await rateLimit({ key: dedupeKey, limit: 1, windowSec });
    alertedThisProcess.add(dedupeKey);
    if (!gate.success) return; // someone (or a past request) already sent it

    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true, settings: { select: { emailBudgetAlerts: true } } },
    });
    if (!user?.email || user.settings?.emailBudgetAlerts === false) return;

    const pct = (input.spentMicroUsd / input.budgetMicroUsd) * 100;
    const tpl = budgetAlert(
      pct,
      input.spentMicroUsd / 1_000_000,
      input.budgetMicroUsd / 1_000_000,
      input.resetsAtMs ? new Date(input.resetsAtMs) : null
    );
    await sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  } catch (err) {
    console.error("[email] budget alert failed", {
      userId: input.userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// TODO(email): weeklyDigest — send every Monday from a cron, honoring
// settings.emailWeeklyDigest. taskResult — send from the scheduled-task
// runner when a run completes. Both templates live in email-templates.ts.
