import { headers } from "next/headers";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { PLAN_LIST } from "@/lib/plans";
import { env } from "@/lib/env";
import { AlevrHome } from "@/components/home/home-page";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { MODELS_FLOOR, TOTAL_LABS } from "@/components/landing/lab-marquee";

// Signed-in users go straight to the app; strangers get the front door.
// The title leads with the name (brand searches) and says what it is (category
// searches); the description is the sentence a result card should show.
const HOME_DESCRIPTION = `${PRODUCT_NAME} is the AI workspace for chat, agents and code. Use Claude, GPT, Gemini and ${MODELS_FLOOR}+ models, research with cited sources, and build. Hosted in France.`;

export const metadata: Metadata = {
  title: { absolute: `${PRODUCT_NAME}: AI chat, agents and code in one workspace` },
  description: HOME_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: PRODUCT_NAME,
    url: "/",
    title: `${PRODUCT_NAME}. Go further.`,
    description: HOME_DESCRIPTION,
  },
  twitter: { card: "summary_large_image", title: `${PRODUCT_NAME}. Go further.`, description: HOME_DESCRIPTION },
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
  const org = `${base}/#organization`;
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": org,
        name: PRODUCT_NAME,
        url: base,
        logo: `${base}/brand/icon-512.png`,
        slogan: "Go further.",
      },
      {
        "@type": "WebSite",
        "@id": `${base}/#website`,
        name: PRODUCT_NAME,
        alternateName: [`${PRODUCT_NAME} AI`, `${PRODUCT_NAME} Chat`],
        url: base,
        publisher: { "@id": org },
        inLanguage: "en",
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${base}/#app`,
        name: PRODUCT_NAME,
        url: base,
        image: `${base}/opengraph-image`,
        publisher: { "@id": org },
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "AI assistant",
        operatingSystem: "Web, macOS, iOS",
        description: `The AI workspace for chat, agents and code, with ${MODELS_FLOOR}+ models from ${TOTAL_LABS} labs and transparent usage pricing.`,
        featureList: [
          `AI chat with ${MODELS_FLOOR}+ models including Claude, GPT and Gemini`,
          "Deep Field research with cited sources",
          "Alevr Orbit: persistent AI agents with permissions you set",
          "Alevr Code: coding agent with reviewable changes",
          "Folio documents with version history",
          "Memory, projects, voice and connected apps",
        ],
        offers: PLAN_LIST.map((plan) => ({
          "@type": "Offer",
          name: plan.name,
          description: plan.tagline,
          price: plan.price.toFixed(2),
          priceCurrency: "EUR",
          url: `${base}/#pricing`,
          availability: "https://schema.org/InStock",
        })),
      },
    ],
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
      <AlevrHome />
    </>
  );
}
