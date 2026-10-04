import Link from "next/link";
import { PublicAction } from "@/components/public/public-motion";
import { MODELS_FLOOR } from "@/components/landing/lab-marquee";
import { PRODUCT_NAME } from "@/lib/brand/names";
import {
  benchmarkSyncLabel,
  cheapestPaidPlan,
  modelFacts,
  usd,
  type ModelPair,
} from "@/lib/compare/model-pairs";

/** The close every comparison ends on: the plan that covers both, honestly priced. */
export function VsCta({ heading, plan }: { heading: string; plan?: { name: string; price: string } }) {
  const from = cheapestPaidPlan();
  return (
    <section className="vs-cta" aria-labelledby="vs-cta-title">
      <h2 id="vs-cta-title" className="alv-h2">{heading}</h2>
      <p className="alv-lede">
        {plan && plan.name !== from.name
          ? `${PRODUCT_NAME} puts Claude, GPT, Gemini and ${MODELS_FLOOR}+ models in one subscription, hosted in France. Both of these are included from ${plan.name}, ${plan.price} a month incl. VAT. Plans start at ${from.price}.`
          : `${PRODUCT_NAME} puts Claude, GPT, Gemini and ${MODELS_FLOOR}+ models in one subscription, hosted in France. Plans start at ${from.price} a month incl. VAT.`}
      </p>
      <div className="alv-actions">
        <PublicAction href="/sign-up">Create account</PublicAction>
        <PublicAction href="/#pricing" secondary>See plans</PublicAction>
      </div>
    </section>
  );
}

/** One row per comparison: the pair, and its list prices as a hint. */
export function VsList({ pairs, title }: { pairs: readonly ModelPair[]; title: (p: ModelPair) => string }) {
  return (
    <ul className="vs-list">
      {pairs.map((p) => {
        const a = modelFacts(p.a);
        const b = modelFacts(p.b);
        return (
          <li key={p.slug}>
            <Link href={`/vs/${p.slug}`}>
              <span>{title(p)}</span>
              <span className="alv-caption">{`${usd(a.inputUsd)} / ${usd(a.outputUsd)} vs ${usd(b.inputUsd)} / ${usd(b.outputUsd)} per M tokens`}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Where every figure comes from. The same paragraphs on every page. */
export function VsMethod() {
  const sync = benchmarkSyncLabel();
  return (
    <div className="vs-notes alv-body">
      <p>
        {`Prices are each lab's API list price in US dollars per million tokens, as recorded in the model catalog ${PRODUCT_NAME} bills from. Cached input is the rate a prompt-cache hit is billed at. ${PRODUCT_NAME} subscribers do not pay per token: each plan includes a monthly usage budget.`}
      </p>
      <p>
        {`Intelligence and speed are ${PRODUCT_NAME}'s 1 to 10 grades. Where Artificial Analysis has measured a model, the grade is computed from its Intelligence Index and median output speed. A model it has not measured yet carries an estimate from the lab's positioning, and the page says so.`}
        {sync ? ` The benchmark sync last ran on ${sync}.` : ""}
      </p>
      <p>
        {`The figures change when labs change their prices. These pages are rebuilt from the same catalog each time ${PRODUCT_NAME} ships, so they match what the app shows.`}
      </p>
    </div>
  );
}
