import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { env } from "@/lib/env";
import { PRODUCT_NAME } from "@/lib/brand/names";
import {
  featuredModelIds,
  MODEL_PAIRS,
  modelFacts,
  pairTitle,
  usd,
  type ModelPair,
} from "@/lib/compare/model-pairs";
import { VsCta, VsList, VsMethod } from "@/components/compare-public/vs-parts";

const TITLE = "Compare AI models: Claude, GPT, Gemini, GLM and Muse Spark";
const DESCRIPTION = `Claude Opus and Sonnet, GPT-6, Gemini, GLM-5.3 and Muse Spark side by side: list prices per million tokens, context windows, speed and intelligence grades, and which to pick for coding or writing. Every figure comes from the catalog ${PRODUCT_NAME} bills from.`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/vs" },
  openGraph: { type: "website", siteName: PRODUCT_NAME, url: "/vs", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const GROUPS: { id: ModelPair["group"]; title: string }[] = [
  { id: "flagship", title: "Flagships" },
  { id: "everyday", title: "Everyday models" },
  { id: "task", title: "By task" },
];

function structuredData(): string {
  const base = env.appUrl.replace(/\/+$/, "");
  const data = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${base}/vs`,
    url: `${base}/vs`,
    name: TITLE,
    description: DESCRIPTION,
    inLanguage: "en",
    isPartOf: { "@id": `${base}/#website` },
    mainEntity: {
      "@type": "ItemList",
      itemListElement: MODEL_PAIRS.map((p, i) => ({ "@type": "ListItem", position: i + 1, name: pairTitle(p), url: `${base}/vs/${p.slug}` })),
    },
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function VsIndexPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const models = featuredModelIds().map(modelFacts);
  return (
    <div className="vs-page">
      <script nonce={nonce} suppressHydrationWarning type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData() }} />
      <div className="alv-col">
        <nav aria-label="Breadcrumb" className="vs-crumbs alv-caption">
          <Link href="/">{PRODUCT_NAME}</Link>
          <span aria-hidden>/</span>
          <span aria-current="page">Compare models</span>
        </nav>

        <header className="vs-hero">
          <h1 className="alv-display vs-title">Compare the models, on the numbers.</h1>
          <p className="alv-lede">
            {`Prices, context windows and grades for the models people weigh against each other most, read from the same catalog ${PRODUCT_NAME} bills from. No benchmark is quoted that has not been measured.`}
          </p>
        </header>

        <div className="vs-groups">
          {GROUPS.map((g) => (
            <section key={g.id} className="vs-group" aria-labelledby={`vs-g-${g.id}`}>
              <h2 id={`vs-g-${g.id}`} className="alv-h3">{g.title}</h2>
              <VsList pairs={MODEL_PAIRS.filter((p) => p.group === g.id)} title={pairTitle} />
            </section>
          ))}
        </div>

        <section className="vs-section" aria-labelledby="vs-all-title">
          <header>
            <h2 id="vs-all-title" className="alv-h2">Every model on these pages.</h2>
            <p className="alv-lede">List prices in US dollars per million tokens, and the plan that includes each model.</p>
          </header>
          <div className="vs-table-wrap">
            <table className="vs-table">
              <caption className="sr-only">Models compared on these pages</caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Input</th>
                  <th scope="col">Output</th>
                  <th scope="col">Context</th>
                  <th scope="col">Intelligence</th>
                  <th scope="col">Speed</th>
                  <th scope="col">{`In ${PRODUCT_NAME} from`}</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id}>
                    <th scope="row" style={{ color: "var(--alv-ink)" }}>{m.name}<small style={{ display: "block", fontSize: 13, color: "var(--alv-sub)" }}>{m.lab}</small></th>
                    <td>{usd(m.inputUsd)}</td>
                    <td>{usd(m.outputUsd)}</td>
                    <td>{m.contextLabel}</td>
                    <td>{`${m.intelligence} / 10`}<small>{m.measured ? "Measured" : "Estimate"}</small></td>
                    <td>{`${m.speed} / 10`}<small>{m.measured ? "Measured" : "Estimate"}</small></td>
                    <td>{m.planName}<small>{`${m.planPrice} a month`}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <VsCta heading={`Every one of them, in one ${PRODUCT_NAME} subscription.`} />

        <section aria-labelledby="vs-method-title">
          <header style={{ marginBottom: 20 }}>
            <h2 id="vs-method-title" className="alv-h3">Where these figures come from</h2>
          </header>
          <VsMethod />
        </section>
        <div className="vs-foot-space" />
      </div>
    </div>
  );
}
