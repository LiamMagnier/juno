import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { PLAN_LIST } from "@/lib/plans";
import { env } from "@/lib/env";
import { LandingPage } from "@/components/landing/landing-page";

// Signed-in users go straight to the app; strangers get the front door.
export const metadata: Metadata = {
  title: { absolute: "Juno — every frontier AI model, one honest subscription" },
  description:
    "Chat with Claude, GPT, Gemini and models from a dozen more labs in one calm workspace. Plans are metered by real API cost — you see what every answer costs. Hosted in France, GDPR by default.",
  alternates: { canonical: "/" },
};

/**
 * Structured data for the front door: a SoftwareApplication with one Offer
 * per plan, read from the same PLAN_LIST the pricing cards render, so the
 * prices a search engine shows are the prices the page shows. The `<` escape
 * is the standard guard for JSON inside a script element — a plan name could
 * in principle contain one, and it would end the script early.
 */
function structuredData(): string {
  const base = env.appUrl.replace(/\/+$/, "");
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Juno",
    url: base,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web, macOS, iOS",
    description:
      "Every frontier AI model — Claude, GPT, Gemini and a dozen more labs — in one calm workspace, metered by what answers actually cost.",
    offers: PLAN_LIST.map((plan) => ({
      "@type": "Offer",
      name: plan.name,
      description: plan.tagline,
      price: plan.price.toFixed(2),
      priceCurrency: "EUR",
      url: `${base}/#pricing`,
      availability: "https://schema.org/InStock",
    })),
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect("/chat");
  // The CSP nonce the middleware minted for this request — the landing's one
  // inline script (the hero-entrance gate) has to carry it or the policy
  // drops it silently.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <>
      <script nonce={nonce} type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData() }} />
      <LandingPage nonce={nonce} />
    </>
  );
}
