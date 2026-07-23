import { getModel } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { Section } from "@/components/landing/section";

/**
 * The differentiator, shown rather than claimed: a receipt priced with the
 * SAME pricing table the in-app usage meter runs (src/lib/pricing.ts), for
 * one identical exchange across a spread of models. If list prices change,
 * this section changes with them.
 */

// ~A solid question and a thorough answer.
const SAMPLE = { input: 1200, output: 600 };

const RECEIPT_IDS = [
  "anthropic:claude-fable-5",
  "openai:gpt-5.6-sol",
  "google:gemini-3.1-pro-preview",
  "anthropic:claude-sonnet-5",
  "zhipu:glm-5.2",
  "deepseek:deepseek-v4-flash",
];

function fmtUsd(v: number): string {
  if (v >= 0.1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

const ROWS = RECEIPT_IDS.flatMap((id) => {
  const m = getModel(id);
  if (!m) return []; // registry moved on — drop the row rather than lie
  return [{ name: m.name, cost: fmtUsd(estimateCostUsd(m, SAMPLE)) }];
});

const POINTS: { term: string; body: string }[] = [
  {
    term: "Priced per reply",
    body: "Every answer shows its estimated cost, computed from the provider's public list prices.",
  },
  {
    term: "A budget, not a cap",
    body: "Your plan is a monthly amount of real usage. Light models stretch it; frontier models spend it. Your call, visibly.",
  },
  {
    term: "Nothing marked up",
    body: "The meter runs the same math you see here — no opaque “message” units, no quiet throttling.",
  },
];

export function Metering() {
  return (
    <Section
      id="metering"
      eyebrow="Honest metering"
      heading="You see what every answer costs."
      lede="Most subscriptions sell a vague number of messages. Juno meters your plan in the only unit that's real — what the model providers actually charge."
    >
      <div className="mt-10 grid items-start gap-10 lg:grid-cols-2">
        <dl>
          {POINTS.map(({ term, body }) => (
            <div key={term} className="border-t border-border/60 py-4">
              <dt className="font-serif text-heading font-medium">{term}</dt>
              <dd className="mt-1 max-w-prose text-sm text-muted-foreground">{body}</dd>
            </div>
          ))}
        </dl>

        {/* The receipt — live numbers, recomputed on every build/deploy. */}
        <div className="rounded-[24px] border border-border/60 bg-card p-6 shadow-soft">
          <p className="font-mono text-[10px] text-muted-foreground">One message, priced</p>
          <p className="mt-1.5 text-caption text-muted-foreground">
            The same exchange — about {SAMPLE.input.toLocaleString("en-US")} tokens in,{" "}
            {SAMPLE.output.toLocaleString("en-US")} out — at today&rsquo;s list prices.
          </p>
          <ul className="mt-5 space-y-3 font-mono text-[13px]">
            {ROWS.map(({ name, cost }) => (
              <li key={name} className="flex items-baseline gap-2.5">
                <span className="whitespace-nowrap">{name}</span>
                <span className="min-w-4 flex-1 border-b border-dotted border-border" aria-hidden />
                <span className="tabular-nums text-muted-foreground">~{cost}</span>
              </li>
            ))}
          </ul>
          <p className="mt-5 border-t border-dotted border-border pt-4 text-caption text-muted-foreground">
            This is the exact math your usage meter runs in the app — shown on every reply, tallied on your plan.
          </p>
        </div>
      </div>
    </Section>
  );
}
