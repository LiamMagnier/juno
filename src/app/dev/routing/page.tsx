import { notFound } from "next/navigation";
import { routeAuto } from "@/lib/router/decide";
import { parsePaidTierAttestation } from "@/lib/router/data-policy";
import { receiptFromDecision } from "@/lib/router/receipt";
import { RoutingGallery, type RoutingCase } from "./gallery";

/**
 * Dev-only gallery for Auto Router 2.0 (docs/rework/program/AUTO_ROUTER.md):
 * the REAL MessageItem carrying Auto's receipt, the "Selected for" popover
 * body, a hand-routed turn for contrast, and — for the developer, never the
 * product — the decision table behind each pick (expected total and its parts).
 *
 * Decisions are computed here, on the server, by the real router with every
 * provider treated as configured and Google/Mistral attested as paid tier, so
 * the page shows what Auto would do on a fully keyed deployment.
 *
 * `?only=<section>` renders one section. 404s outside development.
 */
const PROMPTS: { id: string; prompt: string; webSearch?: boolean }[] = [
  { id: "everyday", prompt: "hey, what's a good name for a grey cat?" },
  { id: "writing", prompt: "Write a warm thank-you email to my landlord for fixing the boiler so quickly." },
  {
    id: "coding",
    prompt:
      "Refactor this repository's auth module across multiple files to use a distributed session store, handle race conditions, and prove it correct step by step.",
  },
  { id: "research", prompt: "What changed in the EU AI Act implementation this week? Cite sources.", webSearch: true },
  { id: "reasoning", prompt: "Explain the trade-offs between Raft and Paxos step by step, including edge cases." },
];

export default async function RoutingDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { only } = await searchParams;
  const paidTier = parsePaidTierAttestation("google,mistral");
  const cases: RoutingCase[] = PROMPTS.map(({ id, prompt, webSearch }) => {
    const d = routeAuto({ message: prompt, plan: "PRO", wantsWebSearch: webSearch, isConfigured: () => true, paidTier });
    return {
      id,
      prompt,
      modelId: d.model.id,
      receipt: receiptFromDecision(d),
      taskClass: d.profile.taskClass,
      complexity: d.complexity.level,
      excluded: d.excluded,
      ranked: d.ranked.slice(0, 5).map((c) => ({
        modelId: c.modelId,
        name: c.name,
        effort: c.effort,
        pSuccess: c.pSuccess,
        call: c.callMicroUsd,
        tools: c.toolRoundsMicroUsd,
        retries: c.retriesMicroUsd,
        failure: c.failureMicroUsd,
        latency: c.latencyMicroUsd,
        total: c.expectedTotalMicroUsd,
      })),
    };
  });
  return <RoutingGallery cases={cases} only={typeof only === "string" ? only : undefined} />;
}
