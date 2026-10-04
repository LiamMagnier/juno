import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/lib/env";
import { PRODUCT_NAME } from "@/lib/brand/names";
import {
  findPair,
  findings,
  MODEL_PAIRS,
  modelFacts,
  pairDescription,
  pairTitle,
  planForBoth,
  relatedPairs,
  usd,
  verdict,
  WORKLOADS,
  type ModelFacts,
  type ModelPair,
} from "@/lib/compare/model-pairs";
import { VsCta, VsList, VsMethod } from "@/components/compare-public/vs-parts";

export const dynamicParams = false;

export function generateStaticParams() {
  return MODEL_PAIRS.map((p) => ({ slug: p.slug }));
}

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const pair = findPair((await params).slug);
  if (!pair) return {};
  const title = `${pairTitle(pair)}: price, context and speed`;
  const description = pairDescription(pair);
  const url = `/vs/${pair.slug}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "article", siteName: PRODUCT_NAME, url, title, description },
    twitter: { card: "summary_large_image", title, description },
  };
}

const yesNo = (v: boolean) => (v ? "Yes" : "No");

function rows(a: ModelFacts, b: ModelFacts): { label: string; a: React.ReactNode; b: React.ReactNode }[] {
  return [
    { label: "Lab", a: a.lab, b: b.lab },
    { label: "Released", a: a.releasedLabel ?? "Not recorded", b: b.releasedLabel ?? "Not recorded" },
    { label: "Context window", a: `${a.contextTokens.toLocaleString("en-US")} tokens`, b: `${b.contextTokens.toLocaleString("en-US")} tokens` },
    { label: "Input, per M tokens", a: usd(a.inputUsd), b: usd(b.inputUsd) },
    { label: "Cached input, per M tokens", a: usd(a.cachedInputUsd), b: usd(b.cachedInputUsd) },
    { label: "Output, per M tokens", a: usd(a.outputUsd), b: usd(b.outputUsd) },
    {
      label: "Intelligence grade",
      a: <>{`${a.intelligence} / 10`}<small>{a.measured ? "Measured" : "Catalog estimate"}</small></>,
      b: <>{`${b.intelligence} / 10`}<small>{b.measured ? "Measured" : "Catalog estimate"}</small></>,
    },
    {
      label: "Speed grade",
      a: <>{`${a.speed} / 10`}<small>{a.measured ? "Measured" : "Catalog estimate"}</small></>,
      b: <>{`${b.speed} / 10`}<small>{b.measured ? "Measured" : "Catalog estimate"}</small></>,
    },
    { label: "Adjustable thinking", a: yesNo(a.reasoning), b: yesNo(b.reasoning) },
    { label: "Reads images", a: yesNo(a.vision), b: yesNo(b.vision) },
    { label: `Searches the web in ${PRODUCT_NAME}`, a: yesNo(a.webSearch), b: yesNo(b.webSearch) },
    { label: "Drives agents and Code", a: yesNo(a.agenticTools), b: yesNo(b.agenticTools) },
    {
      label: `Included in ${PRODUCT_NAME} from`,
      a: <>{a.planName}<small>{`${a.planPrice} a month incl. VAT`}</small></>,
      b: <>{b.planName}<small>{`${b.planPrice} a month incl. VAT`}</small></>,
    },
  ];
}

function structuredData(pair: ModelPair, title: string, description: string): string {
  const base = env.appUrl.replace(/\/+$/, "");
  const url = `${base}/vs/${pair.slug}`;
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": url,
        url,
        name: title,
        description,
        inLanguage: "en",
        isPartOf: { "@id": `${base}/#website` },
        publisher: { "@id": `${base}/#organization` },
        about: [pair.a, pair.b].map((id) => {
          const m = modelFacts(id);
          return { "@type": "SoftwareApplication", name: m.name, applicationCategory: "AI model", creator: { "@type": "Organization", name: m.lab } };
        }),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: PRODUCT_NAME, item: `${base}/` },
          { "@type": "ListItem", position: 2, name: "Compare models", item: `${base}/vs` },
          { "@type": "ListItem", position: 3, name: title, item: url },
        ],
      },
    ],
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

const USE_LEDE = {
  general: "",
  coding: " for coding",
  writing: " for writing",
} as const;

export default async function PairPage({ params }: Params) {
  const pair = findPair((await params).slug);
  if (!pair) notFound();
  const a = modelFacts(pair.a);
  const b = modelFacts(pair.b);
  const title = pairTitle(pair);
  const list = findings(pair);
  const short = verdict(pair);
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const sideName = (side: "a" | "b") => (side === "a" ? a.name : b.name);

  return (
    <div className="vs-page">
      <script nonce={nonce} suppressHydrationWarning type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData(pair, title, pairDescription(pair)) }} />
      <div className="alv-col">
        <nav aria-label="Breadcrumb" className="vs-crumbs alv-caption">
          <Link href="/vs">Compare models</Link>
          <span aria-hidden>/</span>
          <span aria-current="page">{title}</span>
        </nav>

        <header className="vs-hero">
          <h1 className="alv-display vs-title">
            {a.name} <span className="vs-sep">vs</span> {b.name}
            {pair.use !== "general" && <span className="vs-sep">{USE_LEDE[pair.use]}</span>}
          </h1>
          <p className="alv-lede">
            {`${a.lab}'s ${a.name} and ${b.lab}'s ${b.name}${USE_LEDE[pair.use]}, compared on the figures ${PRODUCT_NAME} runs on: list prices, context window, speed and intelligence grades, and the plan that includes each.`}
          </p>
        </header>

        <div className="vs-faces">
          {[a, b].map((m) => (
            <section key={m.id} className="vs-face" aria-label={m.name}>
              <p className="alv-caption">{m.lab}</p>
              <h2 className="alv-h3">{m.name}</h2>
              {m.description && <p className="alv-body">{m.description}</p>}
              <dl className="vs-figures">
                <div className="vs-figure"><dt>Input / output per M</dt><dd>{`${usd(m.inputUsd)} / ${usd(m.outputUsd)}`}</dd></div>
                <div className="vs-figure"><dt>Context</dt><dd>{m.contextLabel}</dd></div>
                <div className="vs-figure"><dt>{`In ${PRODUCT_NAME} from`}</dt><dd>{m.planName}</dd></div>
              </dl>
            </section>
          ))}
        </div>

        <section className="vs-section" aria-labelledby="vs-table-title">
          <header>
            <h2 id="vs-table-title" className="alv-h2">Side by side.</h2>
          </header>
          <div className="vs-table-wrap">
            <table className="vs-table">
              <caption className="sr-only">{`${title}, figure by figure`}</caption>
              <thead>
                <tr><td /><th scope="col">{a.name}</th><th scope="col">{b.name}</th></tr>
              </thead>
              <tbody>
                {rows(a, b).map((r) => (
                  <tr key={r.label}><th scope="row">{r.label}</th><td>{r.a}</td><td>{r.b}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="vs-section" aria-labelledby="vs-pick-title">
          <header>
            <h2 id="vs-pick-title" className="alv-h2">Which to pick.</h2>
            <p className="alv-lede">
              {`Each answer below is a comparison of the figures above, nothing more. Costs use ${WORKLOADS[pair.use].label}.`}
            </p>
          </header>
          <dl className="vs-findings">
            {list.map((f) => (
              <div key={f.topic} className="vs-finding">
                <dt>
                  {f.topic}
                  <span>{f.favours ? sideName(f.favours) : "No clear difference"}</span>
                </dt>
                <dd className="alv-body">{f.text}</dd>
              </div>
            ))}
          </dl>

          <div className="vs-short">
            {(["a", "b"] as const).map((side) => (
              <div key={side}>
                <h3 className="alv-h3">{`Pick ${sideName(side)}`}</h3>
                {short[side].length > 0 ? (
                  <ul className="alv-body">{short[side].map((t) => <li key={t}>{`for ${t}`}</li>)}</ul>
                ) : (
                  <p className="alv-body" style={{ marginTop: 12 }}>
                    {`On these figures it does not come out ahead on any measure here. Its lab's own positioning is in the note above; in ${PRODUCT_NAME} you can try both on the same prompt and judge the answers yourself.`}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        <VsCta heading={`Use both in ${PRODUCT_NAME}.`} plan={planForBoth(pair)} />

        <section aria-labelledby="vs-more-title">
          <header style={{ marginBottom: 24 }}>
            <h2 id="vs-more-title" className="alv-h3">More comparisons</h2>
          </header>
          <VsList pairs={relatedPairs(pair)} title={pairTitle} />
        </section>

        <section className="vs-section" aria-labelledby="vs-method-title">
          <header style={{ marginBottom: 20 }}>
            <h2 id="vs-method-title" className="alv-h3">Where these figures come from</h2>
          </header>
          <VsMethod />
          {[a, b].some((m) => m.openRouter?.inputUsd !== undefined && m.openRouter.outputUsd !== undefined) && (
            <div className="vs-notes alv-body" style={{ marginTop: 14 }}>
              {[a, b].filter((m) => m.openRouter?.inputUsd !== undefined && m.openRouter.outputUsd !== undefined).map((m) => (
                <p key={m.id}>
                  {`OpenRouter, a reseller, lists ${m.name} (${m.openRouter!.slug}) at ${usd(m.openRouter!.inputUsd ?? 0)} input and ${usd(m.openRouter!.outputUsd ?? 0)} output per million tokens. Resale rates can differ from the lab's own.`}
                </p>
              ))}
            </div>
          )}
        </section>
        <div className="vs-foot-space" />
      </div>
    </div>
  );
}
