import "server-only";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { isEmailEnabled, sendEmail } from "@/lib/email";
import { emailParagraph, escapeEmailHtml, renderEmailLayout } from "@/lib/email-layout";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { consentPlainText } from "@/lib/billing/consent";
import { formatEur } from "@/lib/price-display";

/**
 * Confirmation of the contract on a durable medium (Code de la consommation
 * L221-13): after every purchase the buyer gets, by email, what they bought,
 * what they paid, the consent they gave at checkout (word for word, from
 * consent.ts), and the Terms of Sale THEMSELVES — attached as a dated HTML
 * snapshot of /legal/cgv, because a link to a page that can change is not a
 * durable medium.
 *
 * Best-effort like every other email: it never throws into the webhook, and a
 * Stripe retry of the same session sends nothing twice (RateLimit gate keyed on
 * the session id).
 */

export interface OrderConfirmationInput {
  userId: string;
  /** Checkout session id: the dedupe key. */
  sessionId: string;
  kind: "subscription" | "topup";
  /** "Pro, monthly" / "Top-up €5". */
  itemLabel: string;
  /** Amount actually charged, in cents, tax included; null when Stripe gave none. */
  amountTotalCents: number | null;
  /** Of which VAT, in cents. */
  amountTaxCents: number | null;
}

const SNAPSHOT_TIMEOUT_MS = 8_000;

async function termsSnapshot(): Promise<{ filename: string; content: string } | null> {
  const url = `${env.appUrl.replace(/\/$/, "")}/legal/cgv`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    const day = new Date().toISOString().slice(0, 10);
    return { filename: `CGV-${PRODUCT_NAME}-${day}.html`, content: Buffer.from(html, "utf8").toString("base64") };
  } catch {
    return null;
  }
}

export async function sendOrderConfirmation(input: OrderConfirmationInput): Promise<void> {
  try {
    if (!isEmailEnabled()) return;
    const gate = await rateLimit({ key: `email:order:${input.sessionId}`, limit: 1, windowSec: 60 * 60 * 24 * 30 });
    if (!gate.success) return;

    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true } });
    if (!user?.email) return;

    const total = input.amountTotalCents != null ? formatEur(input.amountTotalCents / 100) : null;
    const tax = input.amountTaxCents != null ? formatEur(input.amountTaxCents / 100) : null;
    const consent = consentPlainText(input.kind);
    const attachment = await termsSnapshot();
    if (!attachment) console.warn("[email] order confirmation sent without the CGV snapshot", { sessionId: input.sessionId });

    const lines = [
      `Item / Article : ${input.itemLabel}`,
      total ? `Total paid incl. VAT / Total TTC : ${total}${tax ? ` (VAT / TVA ${tax})` : ""}` : null,
      `Order reference / Référence : ${input.sessionId}`,
    ].filter((l): l is string => Boolean(l));

    const bodyHtml = [
      emailParagraph(
        "Thank you, your order is confirmed. Merci, votre commande est confirmée.",
      ),
      emailParagraph(lines.map(escapeEmailHtml).join("<br>")),
      emailParagraph(
        `<strong>What you agreed to at checkout / Ce que vous avez accepté :</strong><br>${escapeEmailHtml(consent)}`,
      ),
      emailParagraph(
        attachment
          ? "Our Terms of Sale as they stood today are attached to this email. Nos CGV en vigueur ce jour sont jointes à ce message."
          : `Our Terms of Sale: ${escapeEmailHtml(`${env.appUrl}/legal/cgv`)}`,
      ),
      emailParagraph(
        "You can cancel at any time in Settings › Plan &amp; usage. Vous pouvez résilier à tout moment dans Réglages › Abonnement.",
      ),
    ].join("");

    const text = [
      "Thank you, your order is confirmed. Merci, votre commande est confirmée.",
      "",
      ...lines,
      "",
      "What you agreed to at checkout / Ce que vous avez accepté :",
      consent,
      "",
      attachment ? "Terms of Sale attached. CGV jointes." : `Terms of Sale: ${env.appUrl}/legal/cgv`,
    ].join("\n");

    await sendEmail({
      to: user.email,
      subject: `${PRODUCT_NAME}: order confirmation / confirmation de commande`,
      html: renderEmailLayout({
        heading: "Order confirmed",
        bodyHtml,
        cta: { label: "Plan & usage", href: `${env.appUrl}/settings?section=billing` },
      }),
      text,
      attachments: attachment ? [attachment] : undefined,
    });
  } catch (err) {
    console.error("[email] order confirmation failed", {
      sessionId: input.sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
