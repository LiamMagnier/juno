/**
 * The email a Work run sends when it has something to say.
 *
 * The words are not decided here. `describeNotification` in
 * ../notifications.ts writes them, per state, in plain sentences; this file
 * only puts them in an envelope a mail client will render. Keeping the two
 * apart is what lets the sentences be tested without a renderer and the
 * renderer be changed without reopening the copy.
 *
 * **Why this is not in src/lib/email-templates.ts.** It should be, and the
 * layout below is a deliberate near-copy of the shell that lives there — same
 * paper, same card, same serif heading, same mono footer — because a Juno email
 * that looks like a different product is worse than a duplicated table. The
 * shell's helpers (`layout`, `para`, `escapeHtml`) are module-private, so there
 * is currently no way to reuse them from outside that file. The right fix is to
 * export them and delete this shell; until then the duplication is here, named,
 * rather than hidden behind a template whose heading would read "your scheduled
 * task ran" over a run that is actually waiting for an approval.
 *
 * No `server-only`: this is a pure function of a message, and the point of that
 * is a test that renders one without a mail provider or a database.
 */

import { env } from "@/lib/env";
import type { EmailTemplate } from "@/lib/email-templates";
import type { WorkNotifyMessage, WorkNotifyUrgency } from "@/lib/work/notifications";

// The app palette, matching src/lib/email-templates.ts exactly. Webfonts do not
// load in most mail clients, so the display face is a system serif rather than
// the one the app loads.
const PAPER = "#faf7f0";
const CARD = "#ffffff";
const INK = "#292524";
const MUTED = "#78716c";
const HAIRLINE = "#e7e2d8";
const CORAL = "#c2410c";

const SERIF = `Georgia, 'Times New Roman', serif`;
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'SF Mono', SFMono-Regular, Menlo, Consolas, monospace`;

function appUrl(path = ""): string {
  return `${env.appUrl.replace(/\/$/, "")}${path}`;
}

/**
 * HTML-escape, then numeric-entity-encode anything non-ASCII.
 *
 * The HTML part is a fragment with no `<meta charset>`, so a client that
 * mis-detects the encoding would otherwise render a task titled "Café notes" as
 * mojibake — and a mangled task name in a subject line is exactly the thing
 * that makes a real notification look like spam.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[^\x00-\x7f]/gu, (character) => `&#${character.codePointAt(0)};`);
}

/**
 * The line above the heading, which is the only part of the email that says how
 * loudly this arrived.
 *
 * Two words rather than a coloured banner: a blocked run and a finished one
 * need different treatment on a lock screen, and the subject line plus this
 * eyebrow are the only two things a preview pane reliably shows.
 */
function eyebrowFor(urgency: WorkNotifyUrgency): string {
  return urgency === "blocking" ? "Waiting for you" : "Juno Work";
}

export interface WorkNotificationEmailInput {
  message: WorkNotifyMessage;
  urgency: WorkNotifyUrgency;
  /** Absolute URL of the task this is about. */
  taskUrl: string;
}

/**
 * One notification, as subject + HTML + plain text.
 *
 * The call to action is `message.action` when the state has one, because that
 * string already says what the reader can do — "Answer to continue", "Review
 * and decide" — and a generic "Open Juno" throws that away. States with nothing
 * to do (a cancelled run) fall back to opening the task, which is still where
 * the reader would go to see what happened.
 */
export function workNotificationEmail(input: WorkNotificationEmailInput): EmailTemplate {
  const { message, urgency, taskUrl } = input;
  const cta = { label: message.action ?? "Open the task", href: taskUrl };

  const bodyHtml = `<p style="margin:0 0 12px;font-family:${SANS};font-size:14px;line-height:1.6;color:${INK};">${escapeHtml(
    message.summary
  )}</p>`;

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${PAPER};padding:40px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr>
          <td style="background-color:${CARD};border:1px solid ${HAIRLINE};border-radius:16px;padding:36px 36px 32px;">
            <p style="margin:0 0 16px;font-family:${MONO};font-size:11px;letter-spacing:0.02em;color:${MUTED};">${escapeHtml(eyebrowFor(urgency))}</p>
            <h1 style="margin:0 0 16px;font-family:${SERIF};font-size:24px;font-weight:500;line-height:1.3;color:${INK};">${escapeHtml(message.subject)}</h1>
            ${bodyHtml}
            <p style="margin:24px 0 0;font-family:${SANS};font-size:14px;">
              <a href="${cta.href}" style="color:${CORAL};font-weight:600;text-decoration:none;">${escapeHtml(cta.label)} &rarr;</a>
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 8px 0;">
            <p style="margin:0;font-family:${MONO};font-size:10px;letter-spacing:0.02em;color:${MUTED};">
              Juno &middot; chat.liams.dev &middot; <a href="${appUrl("/work/schedules")}" style="color:${MUTED};text-decoration:underline;">change when this task tells you</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

  const text = [
    message.subject,
    "",
    message.summary,
    "",
    `${cta.label}: ${cta.href}`,
    "",
    `Juno · chat.liams.dev · change when this task tells you: ${appUrl("/work/schedules")}`,
  ].join("\n");

  return { subject: message.subject, html, text };
}
