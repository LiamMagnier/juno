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

// ----------------------------------------------------------------------------
// Account security mail: address verification, address change, magic link
// ----------------------------------------------------------------------------

/*
 * These three templates live here rather than in email-templates.ts on
 * purpose: they are the only mail whose delivery is load-bearing for access to
 * the account, so the template and the send stay in one file where the "what
 * happens when this doesn't go out" comment sits next to both. The palette and
 * the one-card shape match email-templates.ts; keep them in step by eye.
 */

const PAPER = "#faf7f0";
const CARD = "#ffffff";
const INK = "#292524";
const MUTED = "#78716c";
const HAIRLINE = "#e7e2d8";
const CORAL = "#c2410c";
const SERIF = `Georgia, 'Times New Roman', serif`;
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'SF Mono', SFMono-Regular, Menlo, Consolas, monospace`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[^\x00-\x7f]/gu, (c) => `&#${c.codePointAt(0)};`);
}

function securityLayout(opts: { eyebrow: string; heading: string; body: string[]; cta: { label: string; href: string } }): string {
  const paragraphs = opts.body
    .map(
      (line) =>
        `<p style="margin:0 0 12px;font-family:${SANS};font-size:14px;line-height:1.6;color:${INK};">${escapeHtml(line)}</p>`
    )
    .join("\n            ");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${PAPER};padding:40px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr>
          <td style="background-color:${CARD};border:1px solid ${HAIRLINE};border-radius:16px;padding:36px 36px 32px;">
            <p style="margin:0 0 16px;font-family:${MONO};font-size:11px;letter-spacing:0.02em;color:${MUTED};">${escapeHtml(opts.eyebrow)}</p>
            <h1 style="margin:0 0 16px;font-family:${SERIF};font-size:24px;font-weight:500;line-height:1.3;color:${INK};">${escapeHtml(opts.heading)}</h1>
            ${paragraphs}
            <p style="margin:24px 0 0;font-family:${SANS};font-size:14px;">
              <a href="${opts.cta.href}" style="color:${CORAL};font-weight:600;text-decoration:none;">${escapeHtml(opts.cta.label)} &rarr;</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

function securityText(body: string[], cta: { label: string; href: string }): string {
  return [...body, "", `${cta.label}: ${cta.href}`, "", "Juno · chat.liams.dev"].join("\n");
}

const IGNORE_LINE = "If you didn't ask for this, you can ignore this email — nothing changes until the link is opened.";

/** "Confirm your email address" — sent at registration and on resend. */
export async function sendEmailVerification(to: string, verifyUrl: string): Promise<SendEmailResult> {
  const body = [
    "Confirm this address to finish setting up your Juno account.",
    "The link works once and expires in 24 hours.",
    IGNORE_LINE,
  ];
  return sendEmail({
    to,
    subject: "Confirm your email address",
    html: securityLayout({ eyebrow: "Juno", heading: "Confirm your email address", body, cta: { label: "Confirm address", href: verifyUrl } }),
    text: securityText(body, { label: "Confirm address", href: verifyUrl }),
  });
}

/**
 * "Confirm your new email address" — sent to the NEW address only.
 *
 * Nothing is sent to the old address and nothing changes on the account until
 * this link is opened, so a mistyped address is a no-op rather than a lockout.
 */
export async function sendEmailChangeVerification(to: string, verifyUrl: string): Promise<SendEmailResult> {
  const body = [
    `Confirm ${to} to make it the address you sign in to Juno with.`,
    "Your current address keeps working until you do. The link expires in 24 hours.",
    IGNORE_LINE,
  ];
  return sendEmail({
    to,
    subject: "Confirm your new email address",
    html: securityLayout({ eyebrow: "Juno", heading: "Confirm your new address", body, cta: { label: "Confirm address", href: verifyUrl } }),
    text: securityText(body, { label: "Confirm address", href: verifyUrl }),
  });
}

/** The passwordless sign-in link (Auth.js email provider). */
export async function sendMagicLink(to: string, signInUrl: string): Promise<SendEmailResult> {
  const body = [
    "Open this link to sign in to Juno. It works once and expires shortly.",
    "If you didn't ask to sign in, you can ignore this email.",
  ];
  return sendEmail({
    to,
    subject: "Your Juno sign-in link",
    html: securityLayout({ eyebrow: "Juno", heading: "Sign in to Juno", body, cta: { label: "Sign in", href: signInUrl } }),
    text: securityText(body, { label: "Sign in", href: signInUrl }),
  });
}

// TODO(email): weeklyDigest — send every Monday from a cron, honoring
// settings.emailWeeklyDigest. taskResult — send from the scheduled-task
// runner when a run completes. Both templates live in email-templates.ts.
