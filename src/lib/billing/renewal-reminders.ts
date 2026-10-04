import "server-only";
import type { Plan } from "@prisma/client";
import { prismaUnguarded } from "@/lib/prisma";
import { isEmailEnabled, sendEmail } from "@/lib/email";
import { emailAppUrl, emailParagraph, escapeEmailHtml, renderEmailLayout } from "@/lib/email-layout";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { PLANS } from "@/lib/plans";
import { ANNUAL_MONTHS_BILLED, formatEur, withVat } from "@/lib/price-display";
import { getStripe, intervalFromPriceId } from "@/lib/stripe";
import {
  RENEWAL_REMINDER_EARLIEST_MS,
  RENEWAL_REMINDER_LATEST_MS,
  renewalReminderDue,
} from "@/lib/credits";
import { claimRenewalReminder, releaseRenewalReminder } from "@/lib/billing/credit-ledger";

/**
 * The annual-renewal notice: Code de la consommation L215-1 (loi Chatel).
 *
 * A consumer on a contract that renews tacitly must be told, no earlier than
 * three months and no later than one month before the end of the period, that
 * it will renew and that they can stop it. Without the notice they may end the
 * contract at any time after the renewal and get the unused part back. Only
 * the ANNUAL plans are in scope (a monthly one is cancellable any day), and
 * the notice states the renewal date, the tax-included price and how to cancel.
 *
 * Two triggers, one ledger: Stripe's `invoice.upcoming` webhook (its lead time
 * is set in the dashboard, see docs/pricing/BILLING_SETUP.md) and a daily
 * sweep over the Subscription table, so a reminder still goes out if the
 * dashboard lead time is shorter than a month or a webhook is lost. The
 * RenewalReminder row is claimed before the send, so either trigger, any
 * number of times, sends one mail per subscription period.
 */

const SETTINGS_BILLING_PATH = "/settings?section=billing";

export interface RenewalNotice {
  userId: string;
  email: string;
  plan: Plan;
  stripeSubscriptionId: string;
  renewsAt: Date;
  /** Amount the renewal will charge, tax included, in cents; null → computed from the plan. */
  totalCents: number | null;
}

function noticeCopy(n: RenewalNotice): { subject: string; html: string; text: string } {
  const planName = PLANS[n.plan]?.name ?? n.plan;
  const ttc =
    n.totalCents != null ? n.totalCents / 100 : withVat((PLANS[n.plan]?.price ?? 0) * ANNUAL_MONTHS_BILLED);
  const dateFr = n.renewsAt.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });
  const dateEn = n.renewsAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });
  const priceFr = formatEur(ttc, "fr");
  const priceEn = formatEur(ttc, "en");
  const manage = emailAppUrl(SETTINGS_BILLING_PATH);

  const fr = [
    `Votre abonnement annuel ${PRODUCT_NAME} ${planName} sera reconduit automatiquement le ${dateFr}, pour ${priceFr} TTC pour un an.`,
    `Vous pouvez ne pas le reconduire : annulez à tout moment avant cette date depuis Réglages → Forfait et usage (${manage}), sans frais. Votre forfait reste actif jusqu'au ${dateFr}.`,
    "Cette information vous est adressée en application de l'article L215-1 du Code de la consommation.",
  ];
  const en = [
    `Your annual ${PRODUCT_NAME} ${planName} subscription renews automatically on ${dateEn}, for ${priceEn} including VAT for one year.`,
    `If you don't want it to renew, cancel any time before that date in Settings → Plan & usage (${manage}), at no cost. Your plan stays active until ${dateEn}.`,
  ];
  const subject = `Votre abonnement annuel est reconduit le ${dateFr} · Your annual plan renews on ${dateEn}`;
  const html = renderEmailLayout({
    heading: "Renouvellement de votre abonnement",
    bodyHtml: [...fr, ...en].map((line) => emailParagraph(escapeEmailHtml(line))).join("\n"),
    cta: { label: "Gérer l'abonnement · Manage plan", href: manage },
  });
  const text = [...fr, "", ...en, "", `${PRODUCT_NAME}`].join("\n");
  return { subject, html, text };
}

/**
 * Send the notice for one period, once. Returns true when this call sent it.
 * Never throws; a failed send gives its claim back so the next sweep retries.
 */
export async function sendRenewalNotice(
  n: RenewalNotice,
  now = new Date(),
  /** Looked up only once the claim is won, so a sweep re-run costs no Stripe call. */
  resolveTotalCents?: () => Promise<number | null>
): Promise<boolean> {
  try {
    if (!isEmailEnabled()) return false;
    if (!renewalReminderDue(n.renewsAt.getTime(), now.getTime())) return false;
    const claimed = await claimRenewalReminder({
      userId: n.userId,
      stripeSubscriptionId: n.stripeSubscriptionId,
      periodEnd: n.renewsAt,
    });
    if (!claimed) return false;
    const totalCents = n.totalCents ?? (resolveTotalCents ? await resolveTotalCents() : null);
    const copy = noticeCopy({ ...n, totalCents });
    const sent = await sendEmail({ to: n.email, subject: copy.subject, html: copy.html, text: copy.text });
    if (!("ok" in sent) || !sent.ok) {
      await releaseRenewalReminder(n.stripeSubscriptionId, n.renewsAt);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[renewal] notice failed", {
      userId: n.userId,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The renewal total from Stripe (tax, discounts and the buyer's country included). */
async function upcomingTotalCents(stripeSubscriptionId: string): Promise<number | null> {
  try {
    const preview = await getStripe().invoices.createPreview({ subscription: stripeSubscriptionId });
    return typeof preview.total === "number" ? preview.total : null;
  } catch {
    return null;
  }
}

/** One subscription, from a webhook: send if it is annual and due. */
export async function renewalNoticeForSubscription(input: {
  stripeSubscriptionId: string;
  totalCents?: number | null;
  now?: Date;
}): Promise<boolean> {
  const sub = await prismaUnguarded.subscription.findUnique({
    where: { stripeSubscriptionId: input.stripeSubscriptionId },
    select: {
      userId: true,
      plan: true,
      status: true,
      stripePriceId: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      user: { select: { email: true } },
    },
  });
  if (!sub?.currentPeriodEnd || !sub.user?.email) return false;
  if (sub.cancelAtPeriodEnd || (sub.status !== "ACTIVE" && sub.status !== "TRIALING")) return false;
  if (intervalFromPriceId(sub.stripePriceId) !== "year") return false;
  return sendRenewalNotice(
    {
      userId: sub.userId,
      email: sub.user.email,
      plan: sub.plan,
      stripeSubscriptionId: input.stripeSubscriptionId,
      renewsAt: sub.currentPeriodEnd,
      totalCents: input.totalCents ?? null,
    },
    input.now,
    () => upcomingTotalCents(input.stripeSubscriptionId)
  );
}

/**
 * The daily sweep: every annual Stripe subscription whose renewal falls inside
 * the notice window and has not been told yet. Bounded per run; the ledger
 * makes a re-run harmless.
 */
export async function sweepRenewalReminders(now = new Date(), limit = 200): Promise<number> {
  if (!isEmailEnabled()) return 0;
  const subs = await prismaUnguarded.subscription.findMany({
    where: {
      stripeSubscriptionId: { not: null },
      status: { in: ["ACTIVE", "TRIALING"] },
      cancelAtPeriodEnd: false,
      currentPeriodEnd: {
        gte: new Date(now.getTime() + RENEWAL_REMINDER_LATEST_MS),
        lte: new Date(now.getTime() + RENEWAL_REMINDER_EARLIEST_MS),
      },
    },
    select: {
      userId: true,
      plan: true,
      stripePriceId: true,
      stripeSubscriptionId: true,
      currentPeriodEnd: true,
      user: { select: { email: true } },
    },
    take: limit,
  });
  let sent = 0;
  for (const sub of subs) {
    if (!sub.stripeSubscriptionId || !sub.currentPeriodEnd || !sub.user?.email) continue;
    if (intervalFromPriceId(sub.stripePriceId) !== "year") continue;
    const ok = await sendRenewalNotice(
      {
        userId: sub.userId,
        email: sub.user.email,
        plan: sub.plan,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        renewsAt: sub.currentPeriodEnd,
        totalCents: null,
      },
      now,
      () => upcomingTotalCents(sub.stripeSubscriptionId!)
    );
    if (ok) sent++;
  }
  return sent;
}
