import { ReceiptText } from "lucide-react";
import { getModel } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { eurPerUsd } from "@/lib/spend";
import { Card, CardEyebrow } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatEur } from "@/components/landing/eur";
import { Section } from "@/components/landing/section";

/**
 * The differentiator, shown rather than claimed: a receipt priced with the
 * SAME pricing table the in-app usage meter runs (src/lib/pricing.ts), for
 * one identical exchange across a spread of models, converted to euros at
 * the same rate the spend ledger uses. If list prices change, this section
 * changes with them.
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

/**
 * The pacing windows, stated where the "no quiet throttling" line used to be.
 *
 * The figures mirror SESSION_MS and WEEK_MS in src/lib/spend.ts. The windows
 * are display-only pacing — the monthly budget is the one hard limit — but a
 * page that promised no throttling while the billing pane drew two rolling
 * meters was contradicting the product. Saying what the windows are is the
 * honest version of the same promise.
 */
const WINDOWS = { session: "5-hour", weekly: "7-day" };

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
    term: "Paced, not throttled",
    body: `The month is spread across rolling ${WINDOWS.session} and ${WINDOWS.weekly} windows so one heavy afternoon can't drain it. Both meters are on your billing page, with the exact moment each one frees up.`,
  },
  {
    term: "Nothing marked up",
    body: "The meter runs the same math you see here — no opaque “message” units.",
  },
];

export function Metering() {
  const rate = eurPerUsd();
  const rows = RECEIPT_IDS.flatMap((id) => {
    const m = getModel(id);
    if (!m) return []; // registry moved on — drop the row rather than lie
    return [{ name: m.name, cost: formatEur(estimateCostUsd(m, SAMPLE) * rate) }];
  });

  return (
    <Section
      id="metering"
      eyebrow="Honest metering"
      heading="You see what every answer costs."
      lede="Most subscriptions sell a vague number of messages. Juno meters your plan in the only unit that's real — what the model providers actually charge."
    >
      <div className="mt-10 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-14">
        {/* The four points as a plain definition list on hairlines. The
            receipt beside it is the section's one elevated object, and a grid
            of raised tiles next to it was two sections' worth of cards in one. */}
        <dl className="divide-y divide-border/60">
          {POINTS.map(({ term, body }) => (
            <div key={term} className="py-4 first:pt-0 last:pb-0">
              <dt className="text-heading">{term}</dt>
              <dd className="mt-1 max-w-prose text-body text-muted-foreground">{body}</dd>
            </div>
          ))}
        </dl>

        {/* The receipt — live numbers, recomputed on every build/deploy. */}
        <Card variant="elevated" className="p-5 sm:p-6">
          <CardEyebrow>One message, priced</CardEyebrow>
          <p className="mt-1.5 text-caption text-muted-foreground">
            The same exchange — about {SAMPLE.input.toLocaleString("en-US")} tokens in,{" "}
            {SAMPLE.output.toLocaleString("en-US")} out — at today&rsquo;s list prices.
          </p>
          {rows.length > 0 ? (
            <ul className="surface-inset mt-5 space-y-3 rounded-field px-4 py-3.5 font-mono text-caption">
              {rows.map(({ name, cost }) => (
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
