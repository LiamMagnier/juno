import { env } from "@/lib/env";

/**
 * Lifecycle email templates. Pure string builders — no I/O — so they can be
 * unit-tested and reused by any sender (budget hook today, digest/task crons
 * later). Every template returns subject + HTML + a plain-text alternate.
 *
 * Email HTML is deliberately old-school: a single centered table, inline
 * styles everywhere, system font stacks (webfonts don't load in most clients).
 * The palette mirrors the app — warm paper #faf7f0, ink text, one coral link.
 */

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

const PAPER = "#faf7f0";
const CARD = "#ffffff";
const INK = "#292524";
const MUTED = "#78716c";
const HAIRLINE = "#e7e2d8";
const CORAL = "#c2410c";

const SERIF = `Georgia, 'Times New Roman', serif`;
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'SF Mono', SFMono-Regular, Menlo, Consolas, monospace`;

/** Absolute app URL for links (prod: https://chat.liams.dev). */
function appUrl(path = ""): string {
  return `${env.appUrl.replace(/\/$/, "")}${path}`;
}

/**
 * HTML-escape, then numeric-entity-encode anything non-ASCII so the markup
 * survives clients that mis-detect the charset (the HTML part is a fragment,
 * so there is no <meta charset> to save us).
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[^\x00-\x7f]/gu, (c) => `&#${c.codePointAt(0)};`);
}

/** "$4.72" / "$11" — dollars with cents only when they matter. */
function usd(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** "August 3" — the day a budget renews. */
function dayLabel(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * Shared shell: paper background, one white card with a hairline border,
 * serif display heading, sans body, single coral CTA link, mono footer.
 */
function layout(opts: {
  eyebrow: string;
  heading: string;
  /** Pre-escaped HTML paragraphs/blocks for the card body. */
  bodyHtml: string;
  cta: { label: string; href: string };
}): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${PAPER};padding:40px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr>
          <td style="background-color:${CARD};border:1px solid ${HAIRLINE};border-radius:16px;padding:36px 36px 32px;">
            <p style="margin:0 0 16px;font-family:${MONO};font-size:11px;letter-spacing:0.02em;color:${MUTED};">${escapeHtml(opts.eyebrow)}</p>
            <h1 style="margin:0 0 16px;font-family:${SERIF};font-size:24px;font-weight:500;line-height:1.3;color:${INK};">${escapeHtml(opts.heading)}</h1>
            ${opts.bodyHtml}
            <p style="margin:24px 0 0;font-family:${SANS};font-size:14px;">
              <a href="${opts.cta.href}" style="color:${CORAL};font-weight:600;text-decoration:none;">${escapeHtml(opts.cta.label)} &rarr;</a>
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 8px 0;">
            <p style="margin:0;font-family:${MONO};font-size:10px;letter-spacing:0.02em;color:${MUTED};">
              Juno &middot; chat.liams.dev &middot; <a href="${appUrl("/settings")}" style="color:${MUTED};text-decoration:underline;">manage notifications</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

/** Plain-text alternate shell: body lines + CTA + the same mono footer. */
function textLayout(lines: string[], cta: { label: string; href: string }): string {
  return [...lines, "", `${cta.label}: ${cta.href}`, "", `Juno · chat.liams.dev · manage notifications: ${appUrl("/settings")}`].join("\n");
}

/** One inline-styled body paragraph. */
function para(html: string): string {
  return `<p style="margin:0 0 12px;font-family:${SANS};font-size:14px;line-height:1.6;color:${INK};">${html}</p>`;
}

/** One-hour, single-use credential recovery email. */
export function passwordReset(resetUrl: string): EmailTemplate {
  const subject = "Reset your Juno password";
  const bodyHtml =
    para("We received a request to reset the password for your Juno account.") +
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
        "We received a request to reset the password for your Juno account.",
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
  const subject = `You've used ${shownPct}% of your Juno budget`;
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
  const subject = `Your week on Juno · ${stats.weekRange}`;
  const models = stats.topModels.slice(0, 3);
  const row = (label: string, value: string) =>
    `<tr>
      <td style="padding:8px 0;border-bottom:1px solid ${HAIRLINE};font-family:${MONO};font-size:10px;letter-spacing:0.02em;color:${MUTED};">${escapeHtml(label)}</td>
      <td align="right" style="padding:8px 0;border-bottom:1px solid ${HAIRLINE};font-family:${SANS};font-size:14px;color:${INK};">${escapeHtml(value)}</td>
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
      cta: { label: "Open Juno", href: appUrl("/chat") },
    }),
    text: textLayout(
      [
        subject,
        "",
        `Messages: ${stats.messages}`,
        `Model spend: ${usd(stats.spendUsd)}`,
        ...(models.length ? [`Top models: ${models.join(", ")}`] : []),
      ],
      { label: "Open Juno", href: appUrl("/chat") }
    ),
  };
}

/**
 * Scheduled-task result notification. Exported for future wiring — the
 * scheduled-tasks runner will send it when a run completes.
 */
export function taskResult(taskName: string, excerpt: string, threadUrl: string): EmailTemplate {
  const subject = `${taskName} — your scheduled task ran`;
  const bodyHtml =
    para(`Your scheduled task <strong>${escapeHtml(taskName)}</strong> just finished a run.`) +
    `<blockquote style="margin:16px 0 0;padding:12px 16px;border-left:2px solid ${CORAL};background-color:${PAPER};border-radius:0 8px 8px 0;font-family:${SANS};font-size:14px;line-height:1.6;color:${INK};">${escapeHtml(excerpt)}</blockquote>`;
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
