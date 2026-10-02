import { headers } from "next/headers";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { PLAN_LIST } from "@/lib/plans";
import { env } from "@/lib/env";
import { LandingPage } from "@/components/landing/landing-page";
import { PRODUCT_NAME } from "@/lib/brand/names";

// Signed-in users go straight to the app; strangers get the front door.
export const metadata: Metadata = {
  title: { absolute: `${PRODUCT_NAME} · Go further.` },
  description:
    "Conversation, persistent agents, and code in one workspace. Bring your context, research with frontier models, and carry your work forward. See what every answer costs.",
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
    name: PRODUCT_NAME,
    url: base,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web, macOS, iOS",
    description:
      "Conversation, persistent agents, and code in one workspace, with frontier models and transparent usage pricing.",
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
  // Structured data retains the request CSP nonce.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <>
      <script nonce={nonce} suppressHydrationWarning type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData() }} />
      <LandingPage />
    </>
  );
}
