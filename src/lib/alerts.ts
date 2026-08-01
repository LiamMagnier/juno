import "server-only";
import { sendEmail } from "@/lib/email";
import { logAsync } from "@/lib/logger";

/**
 * Operator alerts — the "something is wrong with the deployment" channel, as
 * opposed to `src/lib/email.ts`'s user-facing lifecycle mail.
 *
 * Two things happen for every alert:
 *  - a structured `[alert]` line on stderr, always. This is the durable record;
 *    it is greppable in the PM2 logs and is what an external log shipper picks
 *    up. Alerting must work even with no mail configured.
 *  - a best-effort email to OWNER_EMAILS when RESEND_API_KEY is set.
 *
 * Every call is fire-and-forget and cannot throw into its caller: an alert is
 * never allowed to be the reason a request fails. Alerts are deduplicated by
 * `kind:key` so a provider that is down for a day sends one mail, not one per
 * probe.
 *
 * Dedupe state is per-process and in memory, which matches the rest of the
 * deployment today (one PM2 instance — see docs/JUNO.md §20.1). If Juno ever
 * runs more than one instance, the effect is at worst one mail per instance per
 * window, which is an acceptable failure mode for an alert channel.
 */

export type AlertSeverity = "warn" | "critical";

export interface AlertInput {
  /** Stable slug identifying the alert class, e.g. "provider_unhealthy". */
  kind: string;
  /**
   * Sub-key so independent subjects alert independently — the provider id, the
   * price id, and so on. Omit when the kind is already unique.
   */
  key?: string;
  /** One-line operator-facing summary. Goes in the log line and the subject. */
  title: string;
  severity?: AlertSeverity;
  /** Structured context. Never put a secret or a user's email in here. */
  detail?: Record<string, unknown>;
  /**
   * Whether this alert is worth an email. Defaults to true.
   *
   * Set false for conditions that are real, worth recording, and *already
   * known to the person who would receive the mail* — a provider account with
   * no credit left is the case this exists for. It is not an incident to be
   * paged about; it is a funding state only the owner can change, it persists
   * for as long as the account is dry, and the log line still records it.
   */
  mail?: boolean;
}

/**
 * Alert kinds the operator has muted, as `kind` or `kind:key`, comma-separated.
 *
 * An escape hatch that does not need a deploy: mail can be silenced from the
 * environment when a known condition starts producing noise, without editing
 * the call site or losing the log line.
 */
function mutedKinds(): Set<string> {
  return new Set(
    (process.env.ALERT_MUTED_KINDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/** One mail per kind:key per hour. The log line is never suppressed. */
const MAIL_DEDUPE_MS = 60 * 60 * 1000;

const lastMailedAt = new Map<string, number>();

function ownerRecipients(): string[] {
  return (process.env.OWNER_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function shouldMail(dedupeKey: string, now: number): boolean {
  const previous = lastMailedAt.get(dedupeKey);
  if (previous !== undefined && now - previous < MAIL_DEDUPE_MS) return false;
  lastMailedAt.set(dedupeKey, now);
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function deliverMail(input: AlertInput, dedupeKey: string): Promise<void> {
  const recipients = ownerRecipients();
  if (recipients.length === 0) return;

  const severity = input.severity ?? "critical";
  const lines = Object.entries(input.detail ?? {}).map(
    ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
  );
  const text = [input.title, "", ...lines, "", `alert: ${dedupeKey}`].join("\n");
  const html = [
    `<p><strong>${escapeHtml(input.title)}</strong></p>`,
    lines.length ? `<pre>${escapeHtml(lines.join("\n"))}</pre>` : "",
    `<p style="color:#888">alert: ${escapeHtml(dedupeKey)}</p>`,
  ]
    .filter(Boolean)
    .join("");

  await Promise.all(
    recipients.map((to) =>
      sendEmail({
        to,
        subject: `[Juno ${severity}] ${input.title}`,
        html,
        text,
      })
    )
  );
}

/**
 * Record an operator alert. Returns immediately; delivery happens in the
 * background and swallows its own errors.
 */
export function alertOperator(input: AlertInput): void {
  const dedupeKey = input.key ? `${input.kind}:${input.key}` : input.kind;
  const severity = input.severity ?? "critical";

  logAsync("error", "alert", {
    kind: input.kind,
    ...(input.key ? { key: input.key } : {}),
    severity,
    title: input.title,
    ...(input.detail ?? {}),
  });

  // The log line above is unconditional; only delivery is suppressed. An alert
  // that is not worth waking someone for is still worth being able to grep.
  if (input.mail === false) return;
  const muted = mutedKinds();
  if (muted.has(input.kind) || muted.has(dedupeKey)) return;

  if (!shouldMail(dedupeKey, Date.now())) return;

  void deliverMail(input, dedupeKey).catch((err) => {
    console.error("[alert] delivery failed", {
      kind: input.kind,
      message: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Test seam — clears the mail dedupe window. */
export function resetAlertDedupeForTests(): void {
  lastMailedAt.clear();
}
