import { EMAIL_COLORS, EMAIL_SANS, emailAppUrl, emailParagraph, escapeEmailHtml, renderEmailLayout } from "@/lib/email-layout";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * Lifecycle email templates. Pure string builders — no I/O — so they can be
 * unit-tested and reused by any sender (budget hook today, digest/task crons
 * later). Every template returns subject + HTML + a plain-text alternate.
 *
 * Email HTML is deliberately old-school: a single centered table, inline
 * styles everywhere, with Newsreader/Inter where supported and safe fallbacks.
 * The shared envelope mirrors the neutral V3 palette in light and dark mode.
 */

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

const PAPER = EMAIL_COLORS.well;
const INK = EMAIL_COLORS.ink;
const MUTED = EMAIL_COLORS.muted;
const HAIRLINE = EMAIL_COLORS.edge;
const SANS = EMAIL_SANS;
const MONO = EMAIL_SANS;
const appUrl = emailAppUrl;
const escapeHtml = escapeEmailHtml;

/** "$4.72" / "$11" — dollars with cents only when they matter. */
function usd(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** "August 3" — the day a budget renews. */
function dayLabel(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

function layout(opts: { eyebrow: string; heading: string; bodyHtml: string; cta: { label: string; href: string } }): string {
  return renderEmailLayout({
    heading: opts.heading,
    bodyHtml: opts.bodyHtml,
    cta: opts.cta,
    footer: { label: "Manage notifications", href: appUrl("/settings") },
  });
}

/** Plain-text alternate shell: body lines + CTA + the same branded footer. */
function textLayout(lines: string[], cta: { label: string; href: string }): string {
  return [...lines, "", `${cta.label}: ${cta.href}`, "", `${PRODUCT_NAME} · Go further. · Manage notifications: ${appUrl("/settings")}`].join("\n");
}

const para = emailParagraph;

/** One-hour, single-use credential recovery email. */
export function passwordReset(resetUrl: string): EmailTemplate {
  const subject = `Reset your ${PRODUCT_NAME} password`;
  const bodyHtml =
    para(`We received a request to reset the password for your ${PRODUCT_NAME} account.`) +
    para("This link expires in one hour and can only be used once. If you did not request it, you can safely ignore this email.");

  return {
    subject,
    html: layout({
      eyebrow: "Account recovery",
      heading: subject,
      bodyHtml,
      cta: { label: "Choose a new password", href: resetUrl },
    }),
    text: textLayout(
      [
        subject,
        "",
        `We received a request to reset the password for your ${PRODUCT_NAME} account.`,
        "This link expires in one hour and can only be used once.",
        "If you did not request it, you can safely ignore this email.",
      ],
      { label: "Choose a new password", href: resetUrl }
    ),
  };
}

/**
 * Budget threshold warning — sent once per billing period when spend crosses
 * ~80% of the plan budget.
 */
export function budgetAlert(
  pct: number,
  spentUsd: number,
  budgetUsd: number,
  resetsAt: Date | null
): EmailTemplate {
  const shownPct = Math.min(99, Math.max(1, Math.floor(pct)));
  const renews = resetsAt ? ` It renews on ${dayLabel(resetsAt)}.` : "";
  const subject = `You've used ${shownPct}% of your ${PRODUCT_NAME} budget`;
  const bodyHtml =
    para(
      `You've spent <strong>${usd(spentUsd)}</strong> of your <strong>${usd(budgetUsd)}</strong> monthly model budget.${escapeHtml(renews)}`
    ) +
    para(
      `Once the budget runs out, model requests pause until it renews. If you're running hot, a bigger plan gives you more room.`
    );
  return {
    subject,
    html: layout({
      eyebrow: "Usage alert",
      heading: subject,
      bodyHtml,
      cta: { label: "Review your usage", href: appUrl("/settings") },
    }),
    text: textLayout(
      [
        subject,
        "",
        `You've spent ${usd(spentUsd)} of your ${usd(budgetUsd)} monthly model budget.${renews}`,
        `Once the budget runs out, model requests pause until it renews.`,
      ],
      { label: "Review your usage", href: appUrl("/settings") }
    ),
  };
}

export interface WeeklyDigestStats {
  /** Messages sent during the week. */
  messages: number;
  /** Model spend during the week, in USD. */
  spendUsd: number;
  /** Most-used models, best first. */
  topModels: string[];
  /** Human week range, e.g. "Jun 29 – Jul 5". */
  weekRange: string;
}

/**
 * Weekly usage recap. Exported for future wiring — nothing sends it yet
 * (a Monday cron will, honoring settings.emailWeeklyDigest).
 */
export function weeklyDigest(stats: WeeklyDigestStats): EmailTemplate {
  const subject = `Your week on ${PRODUCT_NAME} · ${stats.weekRange}`;
  const models = stats.topModels.slice(0, 3);
  const row = (label: string, value: string) =>
    `<tr>
      <td class="alevr-email-rule alevr-email-muted" style="padding:8px 0;border-bottom:1px solid ${HAIRLINE};font-family:${MONO};font-size:10px;letter-spacing:0.02em;color:${MUTED};">${escapeHtml(label)}</td>
      <td class="alevr-email-rule alevr-email-copy" align="right" style="padding:8px 0;border-bottom:1px solid ${HAIRLINE};font-family:${SANS};font-size:14px;color:${INK};">${escapeHtml(value)}</td>
    </tr>`;
  const bodyHtml =
    para(`Here's what your week looked like.`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">
      ${row("Messages", String(stats.messages))}
      ${row("Model spend", usd(stats.spendUsd))}
      ${models.length ? row("Top models", models.join(", ")) : ""}
    </table>`;
  return {
    subject,
    html: layout({
      eyebrow: "Weekly digest",
      heading: subject,
      bodyHtml,
      cta: { label: `Open ${PRODUCT_NAME}`, href: appUrl("/chat") },
    }),
    text: textLayout(
      [
        subject,
        "",
        `Messages: ${stats.messages}`,
        `Model spend: ${usd(stats.spendUsd)}`,
        ...(models.length ? [`Top models: ${models.join(", ")}`] : []),
      ],
      { label: `Open ${PRODUCT_NAME}`, href: appUrl("/chat") }
    ),
  };
}

/**
 * Scheduled-task result notification. Exported for future wiring — the
 * scheduled-tasks runner will send it when a run completes.
 */
export function taskResult(taskName: string, excerpt: string, threadUrl: string): EmailTemplate {
  const subject = `${taskName}: your scheduled task ran`;
  const bodyHtml =
    para(`Your scheduled task <strong>${escapeHtml(taskName)}</strong> just finished a run.`) +
    `<blockquote class="alevr-email-well" style="margin:16px 0 0;padding:12px 16px;background-color:${PAPER};border-radius:8px;font-family:${SANS};font-size:14px;line-height:1.6;color:${INK};">${escapeHtml(excerpt)}</blockquote>`;
  return {
    subject,
    html: layout({
      eyebrow: "Scheduled task",
      heading: subject,
      bodyHtml,
      cta: { label: "Open the thread", href: threadUrl },
    }),
    text: textLayout(
      [subject, "", `Your scheduled task "${taskName}" just finished a run.`, "", excerpt],
      { label: "Open the thread", href: threadUrl }
    ),
  };
}
