import { ReceiptText } from "lucide-react";
import { getModel } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { Card, CardEyebrow } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { staggerDelay } from "@/lib/motion";
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
      <div className="mt-10 grid items-start gap-4 lg:grid-cols-2 lg:gap-6">
        {/* The three points as raised tiles, dealt out on the base stagger. */}
        <dl className="grid gap-4">
          {POINTS.map(({ term, body }, i) => (
            <div
              key={term}
              style={staggerDelay(i)}
              className="surface-raised rounded-card p-5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              <dt className="text-heading">{term}</dt>
              <dd className="mt-1.5 text-sm text-muted-foreground">{body}</dd>
            </div>
          ))}
        </dl>

        {/* The receipt — live numbers, recomputed on every build/deploy. The
            elevated Card is the section's centrepiece, and the ledger inside it
            sits in an inset well: one material, three depths, in one box. */}
        <Card
          variant="elevated"
          style={staggerDelay(3)}
          className="p-5 motion-safe:animate-rise-in [animation-fill-mode:backwards] sm:p-6"
        >
          <CardEyebrow>One message, priced</CardEyebrow>
          <p className="mt-1.5 text-caption text-muted-foreground">
            The same exchange — about {SAMPLE.input.toLocaleString("en-US")} tokens in,{" "}
            {SAMPLE.output.toLocaleString("en-US")} out — at today&rsquo;s list prices.
          </p>
          {ROWS.length > 0 ? (
            <ul className="surface-inset mt-5 space-y-3 rounded-field px-4 py-3.5 font-mono text-caption">
              {ROWS.map(({ name, cost }) => (
                <li key={name} className="flex items-baseline gap-2.5">
                  <span className="whitespace-nowrap">{name}</span>
                  <span className="min-w-4 flex-1 border-b border-dotted border-border" aria-hidden />
                  <span className="tabular-nums text-muted-foreground">~{cost}</span>
                </li>
              ))}
            </ul>
          ) : (
            // Dropping one stale id is honest; dropping all six leaves the intro
            // above and the "this is the exact math" line below bracketing an
            // empty <ul>, on a server-rendered page with no runtime signal that
            // anything broke. tone="error" because that is a failure, not a
            // feature nobody has used yet.
            <EmptyState
              className="mt-5"
              tone="error"
              size="panel"
              icon={ReceiptText}
              title="Receipt unavailable"
              description="None of the sample models resolve against the current registry, so there is nothing honest to price here."
            />
          )}
          <p className="mt-5 border-t border-border/60 pt-4 text-caption text-muted-foreground">
            This is the exact math your usage meter runs in the app — shown on every reply, tallied on your plan.
          </p>
        </Card>
      </div>
    </Section>
  );
}
