import "server-only";
import { truncate } from "@/lib/utils";
// Same helper the chat route uses — this was a third verbatim copy.
import { sourceHost } from "@/lib/chat-responses";
import {
  RESEARCH_STATE_MESSAGE,
  isResearchState,
  parsePlan,
  type ResearchBlockedState,
  type ResearchEffort,
  type ResearchEventDTO,
} from "@/lib/research/domain";
import { createPrismaResearchStore, gatheringOnlyEngine } from "@/lib/research/run";
import { buildResearchCorpus, corpusFindings, researchSearchConfigured } from "@/lib/research/tools";
import type { ClientActivityEvent, ClientSource } from "@/types/chat";
import { prisma } from "@/lib/db";

/** Durable research adapter. Web chat reviews the plan inline before paid
 * investigation; native clients retain their existing streaming hand-off. */

type SendActivity = (event: Omit<ClientActivityEvent, "id" | "createdAt">) => ClientActivityEvent;

/**
 * One numbered source, with the text the model was actually shown.
 *
 * The client-facing `sources` array is deliberately snippet-sized — it is
 * persisted on every message — but the citation validator has to re-read the
 * SAME text the model saw. Checking a claim against a fresh fetch would be
 * checking it against a page that may have changed since, which is the failure
 * the run's stored snapshot exists to prevent. So the corpus rides back
 * separately, for the audit, and is not persisted on the message.
 */
export interface ResearchCorpusPage {
  sourceId?: string;
  url: string;
  title: string;
  body: string;
  publishedAt: Date | null;
  /** True when `body` is the search snippet rather than the fetched page. */
  truncated: boolean;
}

export interface DeepResearchResult {
  /** False means no report corpus is ready; never silently answer without research. */
  ok: boolean;
  state?: string;
  /** System-prompt section: report instructions + the numbered source corpus. */
  context: string;
  /** Numbered sources, in citation order — emit as the stream's sources chunk. */
  sources: ClientSource[];
  /**
   * What the gathering cost in USD, as the run's own ledger has it.
   *
   * Wider than the number this used to return, which was the planning model's
   * spend alone. It now also carries the search backend's per-call charge —
   * real money the user was never shown, because Tavily bills us per request
   * and nothing about that reached `ApiSpend`. The model portion is still
   * written to `ApiSpend` by the tools; the search portion is on the run row
   * only, which is why this is read from the run rather than accumulated here.
   */
  costUsd: number;
  /**
   * The durable run this turn gathered into, so the client can open the panel
   * and see the stages, the sources and the controls for it. Null only when no
   * run was created at all.
   */
  runId: string | null;
  /** The bodies behind `sources`, for the citation audit. Never persisted. */
  corpus: ResearchCorpusPage[];
}

const EMPTY: DeepResearchResult = { ok: false, context: "", sources: [], costUsd: 0, runId: null, corpus: [] };

/** Total numbered sources handed to the model. */
const MAX_SOURCES = 250;

/**
 * The per-run ceiling for research started from chat.
 *
 * A chat turn cannot ask the user what they are willing to spend — they pressed
 * a toggle and sent a message — so it gets a fixed ceiling rather than none. A
 * run that reaches it stops at `partially_completed` with its sources intact,
 * and the turn still answers from what it gathered.
 *
 * This was $0.60, sized for "a plan, five searches and a handful of page
 * fetches". That is a search, not an investigation: with the planner now
 * drafting up to fourteen queries against a merged multi-engine index and four
 * follow-up rounds behind them, $0.60 was itself one of the ceilings a user hit
 * as "it stopped early". The default is the ceiling for a genuinely deep run;
 * deployments that want a tighter or looser one set `RESEARCH_CHAT_BUDGET_USD`.
 */
const CHAT_RUN_BUDGET_MICRO_USD = (() => {
  const raw = Number(process.env.RESEARCH_CHAT_BUDGET_USD?.trim());
  const usd = Number.isFinite(raw) && raw > 0 ? Math.min(40, raw) : 8;
  return BigInt(Math.round(usd * 1_000_000));
})();

/** How often the live activity feed drains the run's event log while it works. */
const EVENT_POLL_MS = 700;

/**
 * The state the engine parks a run in while its plan waits for a person.
 *
 * Typed against the domain union so the compiler, not production, notices a
 * misnamed state. `ResearchRun.state` is TEXT end to end, so a Prisma filter
 * on a state the engine never writes throws nothing and matches nothing — and
 * every run it was meant to find keeps a live-run slot forever.
 */
const PLAN_GATE = "awaiting_plan_confirmation" satisfies ResearchBlockedState;

/*
 * How a reply to a waiting plan is read. Anchored AND word-bounded: without
 * the boundary, "no" swallows "north sea oil output" and cancels a run the
 * user still wants, while "ok" swallows "okinawa" and confirms a plan they
 * never looked at. Anything matching neither is treated as a new question.
 */
const CONFIRM_REPLY = /^(yes|yep|yeah|sure|ok(ay)?|approved?|proceed|go ahead|do it|looks good)\b/;
const REJECT_REPLY = /^(no|nope|nah|cancel|stop|abort|reject)\b/;

/**
 * One research event, as a line in the existing chat activity timeline.
 *
 * Returning null is the important half. The event log is the durable record and
 * carries everything — every spend, every state move, every source found — and
 * replaying all of it into the timeline is what made the earlier version read as
 * tool spam. The timeline gets the four kinds a person watching actually reads:
 * what stage it is in, what it searched for, what it read, and what went wrong.
 */
function toActivity(event: ResearchEventDTO): Omit<ClientActivityEvent, "id" | "createdAt"> | null {
  const payload = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case "state_changed": {
      const state = String(payload.state ?? "");
      if (!isResearchState(state)) return null;
      return { kind: "reasoning", title: RESEARCH_STATE_MESSAGE[state] };
    }
    case "plan_drafted": {
      const count = Number(payload.objectives ?? 0);
      return {
        kind: "reasoning",
        title: count > 0 ? `Planned the research: ${count} question${count === 1 ? "" : "s"} to answer` : "Planned the research",
        detail: truncate(String(payload.approach ?? ""), 140),
      };
    }
    case "plan_confirmed":
      return { kind: "reasoning", title: payload.by === "user" ? "Plan approved — starting the research" : "Starting the research" };
    case "query_issued":
      return {
        kind: "search",
        title: "Searching the web",
        detail: truncate(String(payload.query ?? ""), 96),
      };
    case "source_read": {
      const url = String(payload.url ?? "");
      const title = String(payload.title ?? "");
      return {
        kind: "visit",
        title: "Reading source",
        detail: truncate(title && title !== url ? title : sourceHost(url), 96),
        url,
      };
    }
    case "source_ranked":
      return { kind: "reasoning", title: "Prioritizing the strongest sources" };
    case "worker_spawned": {
      const round = Number(payload.round ?? 1);
      return {
        kind: "reasoning",
        title: round > 1 ? `Sending a researcher after a gap (round ${round})` : "Sending a researcher",
        detail: truncate(String(payload.objective ?? ""), 96),
      };
    }
    case "worker_finished": {
      const calls = Number(payload.toolCalls ?? 0);
      return {
        kind: "context",
        title: "A researcher reported back",
        detail: truncate(String(payload.summary ?? "") || `${calls} tool call${calls === 1 ? "" : "s"}`, 96),
      };
    }
    case "round_reviewed": {
      const claims = Number(payload.claims ?? 0);
      return {
        kind: "reasoning",
        title: payload.decision === "continue" ? "Lead review: another round is needed" : "Lead review: the evidence is ready",
        detail: truncate(`${claims} sourced finding${claims === 1 ? "" : "s"} · ${String(payload.reason ?? "")}`, 96),
      };
    }
    case "coverage_matrix_updated":
      return { kind: "reasoning", title: "Checking each research question" };
    case "follow_up_scheduled":
      return {
        kind: "search",
        title: "Following an evidence gap",
        detail: truncate(String((payload.queries as unknown[] | undefined)?.[0] ?? ""), 96),
      };
    case "citation_audit_started":
      return { kind: "reasoning", title: "Checking every citation against its source" };
    case "citation_audit_completed":
      return { kind: "context", title: "Citation check complete" };
    case "citation_audit":
      return { kind: "context", title: "Citation check complete" };
    case "report_repaired":
      return { kind: "reasoning", title: "Labelling claims that need caution" };
    case "budget_exhausted":
      return {
        kind: "warning",
        title: "Stopped at the research budget",
        detail: "Answering from the sources gathered so far.",
      };
    case "error":
      return {
        kind: "warning",
        title: "A source could not be read",
        detail: truncate(String(payload.message ?? ""), 96),
      };
    default:
      return null;
  }
}

export async function runDeepResearch(opts: {
  userId: string;
  /** The user's message, plaintext (clarification-expanded when applicable). */
  prompt: string;
  conversationId?: string | null;
  client: "web" | "app";
  /** The depth the composer asked for. Deep when it did not say. */
  effort?: ResearchEffort;
  signal?: AbortSignal;
  /** The chat route's activity emitter — events land in the existing timeline. */
  sendActivity: SendActivity;
}): Promise<DeepResearchResult> {
  const prompt = opts.prompt.trim();
  if (!prompt || !researchSearchConfigured()) return EMPTY;

  const store = createPrismaResearchStore();
  const engine = gatheringOnlyEngine();

  let runId: string | null = null;
  try {
    // Only the newest plan can be acted on in this conversation. Release older
    // abandoned plans before creating another so they do not hold live slots.
    const parked = opts.conversationId
      ? await prisma.researchRun.findMany({
          where: {
            userId: opts.userId,
            conversationId: opts.conversationId,
            state: PLAN_GATE,
          },
          orderBy: { createdAt: "desc" },
        })
      : [];
    const [pendingRun, ...stranded] = parked;
    for (const orphan of stranded) {
      // Housekeeping: a slot that cannot be freed must not fail the turn.
      await engine
        .decidePlan({ runId: orphan.id, userId: opts.userId, decision: "cancel" })
        .catch(() => undefined);
    }

    const startChatRun = async (): Promise<string> => {
      const run = await engine.start({
        userId: opts.userId,
        goal: prompt,
        conversationId: opts.conversationId ?? null,
        budgetMicroUsd: CHAT_RUN_BUDGET_MICRO_USD,
        effort: opts.effort ?? "deep",
        confirmation: opts.client === "web" ? "required" : "auto",
      });
      return run.id;
    };

    if (pendingRun) {
      const reply = prompt.toLowerCase();
      if (CONFIRM_REPLY.test(reply)) {
        await engine.decidePlan({ runId: pendingRun.id, userId: opts.userId, decision: "confirm" });
        runId = pendingRun.id;
      } else if (REJECT_REPLY.test(reply)) {
        await engine.decidePlan({ runId: pendingRun.id, userId: opts.userId, decision: "cancel" });
        return EMPTY;
      } else {
        // Not a decision on the waiting plan but a new question: end the
        // parked run and research what was actually asked.
        await engine.decidePlan({ runId: pendingRun.id, userId: opts.userId, decision: "cancel" });
        runId = await startChatRun();
      }
    } else {
      runId = await startChatRun();
    }
  } catch (e) {
    console.error("[deep-research] could not start a run", e);
    return EMPTY;
  }

  /*
   * Drain the event log into the timeline while the job runs.
   *
   * The job is durable and the timeline is not, so these are two different
   * things and the poll is the seam between them: the rows are the record, and
   * this loop narrates them to a user who is watching right now. Without it the
   * whole gathering phase — often a minute or more — would be one silent pause
   * followed by an answer, which reads as a hung request.
   */
  let cursor = 0;
  let draining = true;
  const drain = async () => {
    const events = await store.readEvents({
      runId: runId!,
      userId: opts.userId,
      after: cursor,
      limit: 100,
    });
    for (const event of events) {
      cursor = event.seq;
      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      const activity = toActivity({
        id: event.id,
        seq: event.seq,
        kind: event.kind as ResearchEventDTO["kind"],
        payload,
        createdAt: event.createdAt.toISOString(),
      });
      if (activity) opts.sendActivity(activity);
    }
  };
  const pump = (async () => {
    while (draining) {
      await new Promise((resolve) => setTimeout(resolve, EVENT_POLL_MS));
      // A failed drain must never take the run down with it: this is narration.
      await drain().catch(() => undefined);
    }
  })();

  try {
    // `until: "synthesizing"` is the hand-off. The run stays live and the route
    // writes the report; the panel shows it as still working until the turn
    // completes, which is exactly what is happening.
    //
    // The `workerId` is not optional in practice, though the signature allows it.
    // Driving without one skips `claimRun` entirely (engine.ts: the claim and its
    // heartbeat are both guarded on `store.claimRun && workerId`), so this path
    // took no lease at all — and an unleased run is one scripts/research-worker.ts
    // is free to adopt. Both drivers then advance the same state machine, issue
    // the same queries and bill them twice. Identifying by runId rather than pid
    // is deliberate: this driver lives and dies with one turn, so a per-turn
    // identity is what makes the lease releasable and the ownership legible in
    // the `worker_lease_acquired` event.
    await engine.drive({
      runId,
      userId: opts.userId,
      signal: opts.signal,
      until: "synthesizing",
      workerId: `research-chat:${runId}:${Date.now()}`,
    });
  } catch (e) {
    console.error("[deep-research] drive failed", { runId, error: e });
  } finally {
    draining = false;
    await pump;
    await drain().catch(() => undefined);
  }

  const finished = await store.loadRun(runId, opts.userId);
  const sources = (await store.listSources(runId, opts.userId))
    .filter((source) => source.snapshot)
    .slice(0, MAX_SOURCES);
  const costUsd = finished ? Number(finished.costMicroUsd) / 1_000_000 : 0;

  if (sources.length === 0) return { ...EMPTY, runId, costUsd, state: finished?.state };

  const plan = parsePlan(finished?.plan);
  const findings = store.listFindings ? await store.listFindings(runId, opts.userId).catch(() => []) : [];
  const ledger = corpusFindings(plan, sources, findings);
  opts.sendActivity({
    kind: "context",
    title: "Research corpus ready",
    detail: `${sources.length} source${sources.length === 1 ? "" : "s"} · ${plan.queries.length} ${
      plan.queries.length === 1 ? "search" : "searches"
    }${ledger.length ? ` · ${ledger.length} sourced finding${ledger.length === 1 ? "" : "s"}` : ""} · saved to this run`,
  });

  return {
    ok: true,
    context: buildResearchCorpus(prompt, plan, sources, ledger),
    // `cited` marks these as the numbered corpus the model was actually given,
    // which is what licenses the UI to resolve inline [n] markers positionally.
    // Deep research is the ONLY path that numbers sources for the model.
    sources: sources.map((source) => ({
      title: source.title,
      url: source.url,
      // The stored snapshot is the full fetched body; the client list wants a
      // line, not a page.
      snippet: (source.snapshot ?? "").replace(/\s+/g, " ").slice(0, 300),
      cited: true,
    })),
    costUsd,
    runId,
    // Read from the run's stored snapshots rather than re-fetched: the audit
    // must judge a claim against the bytes the model was given, not against
    // whatever the page says now.
    corpus: sources.map((source) => ({
      sourceId: source.id,
      url: source.url,
      title: source.title,
      body: source.snapshot ?? "",
      publishedAt: source.publishedAt ?? null,
      truncated: !source.snapshot,
    })),
  };
}
