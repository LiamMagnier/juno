/**
 * The email a Work run sends when it has something to say.
 *
 * The words are not decided here. `describeNotification` in
 * ../notifications.ts writes them, per state, in plain sentences; this file
 * only puts them in an envelope a mail client will render. Keeping the two
 * apart is what lets the sentences be tested without a renderer and the
 * renderer be changed without reopening the copy.
 *
 * The shared V3 envelope lives in email-layout.ts. All transactional and Work
 * senders use the same Continuum lockup, typography and light/dark surfaces.
 *
 * No `server-only`: this is a pure function of a message, and the point of that
 * is a test that renders one without a mail provider or a database.
 */

import type { EmailTemplate } from "@/lib/email-templates";
import type { WorkNotifyMessage, WorkNotifyUrgency } from "@/lib/work/notifications";
import { emailAppUrl, emailParagraph, escapeEmailHtml, renderEmailLayout } from "@/lib/email-layout";
import { PRODUCT_NAME } from "@/lib/brand/names";

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

  const html = renderEmailLayout({
    heading: message.subject,
    bodyHtml: emailParagraph(escapeEmailHtml(message.summary)),
    context: urgency === "blocking" ? "Waiting for you" : undefined,
    cta,
    footer: { label: "Change when this task tells you", href: emailAppUrl("/automations") },
  });

  const text = [
    message.subject,
    "",
    message.summary,
    "",
    `${cta.label}: ${cta.href}`,
    "",
    `${PRODUCT_NAME} · Go further. · change when this task tells you: ${emailAppUrl("/automations")}`,
  ].join("\n");

  return { subject: message.subject, html, text };
}
