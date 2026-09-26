import { ReceiptText } from "@/components/ui/icons";
import { DURATION } from "@/lib/design/tokens.generated";
import { getModel } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { eurPerUsd } from "@/lib/spend";
import { CardEyebrow } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatEur } from "@/components/landing/eur";
import { Plate } from "@/components/landing/plate";
import { Reveal, RevealItem, RevealList } from "@/components/landing/reveal";
import { Section } from "@/components/landing/section";

/**
 * The differentiator, shown rather than claimed: a receipt priced with the
 * SAME pricing table the in-app usage meter runs (src/lib/pricing.ts), for
 * one identical exchange across a spread of models, converted to euros at
 * the same rate the spend ledger uses. If list prices change, this section
 * changes with them.
 *
 * The receipt is the section's one object, so it is the one set on a plate:
 * printed on paper, held up to the light. The four points beside it sit on the
 * page ground, read after the receipt has made the argument.
 */

const SAMPLE = { input: 1200, output: 600 };

const RECEIPT_IDS = [
  "anthropic:claude-fable-5-1",
  "openai:gpt-6-sol",
  "google:gemini-3.1-pro-preview",
  "anthropic:claude-sonnet-5",
  "zhipu:glm-5.3",
  "deepseek:deepseek-flash",
];

/**
 * The pacing windows. The figures mirror SESSION_MS and WEEK_MS in
 * src/lib/spend.ts; the monthly budget is the one hard limit and the windows
 * pace it, so the page says what the windows are instead of promising none.
 */
const WINDOWS = { session: "5-hour", weekly: "7-day" };

const POINTS: { term: string; body: string }[] = [
  {
    term: "Priced per reply",
    body: "Every answer shows its estimated cost, computed from the provider's public list prices.",
  },
  {
    term: "A budget, not a message count",
    body: "Your plan is a monthly amount of real usage. Light models stretch it, frontier models spend it. You choose.",
  },
  {
    term: "Paced, not throttled",
    body: `Rolling ${WINDOWS.session} and ${WINDOWS.weekly} windows keep one heavy afternoon from draining the month. Both meters are on your billing page.`,
  },
  {
    term: "Nothing marked up",
    body: "The meter runs the same math you see here. No opaque credits, no hidden multipliers.",
  },
];

export function Metering() {
  const rate = eurPerUsd();
  const rows = RECEIPT_IDS.flatMap((id) => {
    const m = getModel(id);
    if (!m) return []; // registry moved on: drop the row rather than lie
    return [{ name: m.name, cost: formatEur(estimateCostUsd(m, SAMPLE) * rate) }];
  });

  return (
    <Section
      id="metering"
      eyebrow="Honest metering"
      heading="See what every answer costs."
      lede="Most subscriptions sell a vague number of messages. Juno meters your plan in the only unit that is real: what the model providers charge."
    >
      <div className="mt-10 grid items-stretch gap-10 lg:grid-cols-12 lg:gap-14">
        <Reveal className="lg:col-span-7">
          <div className="stage flex h-full items-center justify-center rounded-stage px-4 py-10 sm:px-10 sm:py-14">
            <Plate name="coast" dim sizes="(min-width: 1024px) 700px, 100vw" imageClassName="object-[50%_60%]" />
            <div className="stage-window relative w-full max-w-[26rem] rounded-panel bg-card/90 p-5 backdrop-blur-xl sm:p-6">
              <CardEyebrow>One message, priced</CardEyebrow>
              <p className="mt-1.5 text-caption text-muted-foreground">
                The same exchange, about {SAMPLE.input.toLocaleString("en-US")} tokens in and{" "}
                {SAMPLE.output.toLocaleString("en-US")} out, at today&rsquo;s list prices.
              </p>
              {rows.length > 0 ? (
                <RevealList
                  as="ul"
                  className="surface-inset mt-5 space-y-3 rounded-field px-4 py-3.5 font-mono text-caption"
                >
                  {rows.map(({ name, cost }, i) => (
                    <RevealItem
                      key={name}
                      as="li"
                      index={i}
                      rung="tight"
                      offset={DURATION.fast}
                      className="flex items-baseline gap-2.5"
                    >
                      <span className="whitespace-nowrap">{name}</span>
                      <span className="min-w-4 flex-1 border-b border-dotted border-border" aria-hidden />
                      <span className="tabular-nums text-muted-foreground">~{cost}</span>
                    </RevealItem>
                  ))}
                </RevealList>
              ) : (
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
                The exact math your usage meter runs in the app, shown on every reply and tallied on your plan.
              </p>
            </div>
          </div>
        </Reveal>

        <RevealList as="dl" className="grid content-center gap-x-8 gap-y-8 sm:grid-cols-2 lg:col-span-5 lg:grid-cols-1">
          {POINTS.map(({ term, body }, i) => (
            <RevealItem key={term} index={i}>
              <dt className="text-heading text-foreground">{term}</dt>
              <dd className="mt-1.5 max-w-prose text-body text-muted-foreground">{body}</dd>
            </RevealItem>
          ))}
        </RevealList>
      </div>
    </Section>
  );
}
