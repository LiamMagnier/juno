import type { ClientActionApproval } from "@/lib/action-approval";
import { WEB_CLIENT_FEATURES, type ClientFeature } from "@/lib/chat/client-features";
import type { ClientActivityEvent, ClientSource } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";
import type { ChatSourceOrigin, ToolErrorCode, ToolFigure, ToolPresentArgs, ToolWebDetail } from "@/types/run";

/*
 * THE TURNS THE REWORK IS CHECKED AGAINST: one provider event script per
 * `/dev/run` fixture (SPEC §11.1).
 *
 * A script is what an adapter yields for one turn — text, reasoning, round
 * ends, the dispatcher's status and result events, provider search, sources,
 * usage — each with the time it arrives. Nothing downstream is hand-written:
 * the gallery's frames, `turn-stream.test.ts`, the native conformance test and
 * the adapter-parity test all play these scripts through `TurnStream`, so the
 * gallery can never pass against a wire the server does not produce.
 *
 * Every event uses the FINAL shapes of SPEC §2.9 (`round`, `index`, typed
 * statuses). Fixture 19 is the one turn that does not stream: a pre-rework
 * message only ever comes back from the database, so its script is the
 * persisted row (`legacy`) and has no steps.
 * WS4 owns this file after WS0 and adds scripts; WS5 asks WS4 for new ones.
 */

export interface TurnScriptStep {
  /** Milliseconds after the request started. */
  atMs: number;
  event: LlmEvent;
}

export interface TurnScript {
  /** The `/dev/run` fixture number (SPEC §11.1). */
  fixture: number;
  id: string;
  title: string;
  /** What the client declares. Empty = a profile-1 (native) request. */
  features: readonly ClientFeature[];
  /** How the provider stream ends: normally, by the reader's Stop, or with a transport failure. */
  end: "completed" | "aborted" | "failed";
  /** The route ends this turn with a `handoff` frame for this run instead of `done`. */
  handoffRunId?: string;
  /** A message persisted before the rework: no stream runs, and the gallery renders this row at rest. */
  legacy?: LegacyTurnRecord;
  steps: readonly TurnScriptStep[];
}

/**
 * An assistant row as the pre-rework route persisted it (SPEC §7.7, INV-20):
 * no `seq` on any event, rows in the order they were written, and the text of
 * every round glued together.
 */
export interface LegacyTurnRecord {
  content: string;
  reasoning: string | null;
  activity: ClientActivityEvent[];
}

// ── Builders ──────────────────────────────────────────────────────────────────

const JUNO = "Juno";
const GITHUB = "GitHub";

function at(atMs: number, event: LlmEvent): TurnScriptStep {
  return { atMs, event };
}

const text = (round: number, t: string, phase?: "commentary" | "answer"): LlmEvent =>
  phase ? { type: "text", text: t, round, phase } : { type: "text", text: t, round };

const reasoning = (round: number, t: string, part?: number): LlmEvent =>
  part === undefined ? { type: "reasoning", text: t, round } : { type: "reasoning", text: t, round, part };

const roundEnd = (
  round: number,
  tools: number,
  opts: { serverTools?: number; final?: boolean; stop?: string | null } = {},
): LlmEvent => ({
  type: "round_end",
  round,
  tools,
  serverTools: opts.serverTools ?? 0,
  final: opts.final ?? false,
  stop: opts.stop === undefined ? (tools > 0 ? "tool_use" : "end_turn") : opts.stop,
});

const call = (
  round: number,
  index: number,
  name: string,
  callId: string,
  opts: { server?: string; args?: string } = {},
): LlmEvent => ({
  type: "tool",
  phase: "call",
  server: opts.server ?? JUNO,
  name,
  callId,
  round,
  index,
  ...(opts.args === undefined ? {} : { args: opts.args }),
});

const queued = (callId: string, argsText: string, present?: ToolPresentArgs): LlmEvent => ({
  type: "tool",
  phase: "status",
  callId,
  status: "queued",
  argsText,
  ...(present ? { present } : {}),
});

const running = (callId: string, timeoutMs: number): LlmEvent => ({
  type: "tool",
  phase: "status",
  callId,
  status: "running",
  timeoutMs,
});

const awaiting = (callId: string, approval: ClientActionApproval): LlmEvent => ({
  type: "tool",
  phase: "status",
  callId,
  status: "awaiting_approval",
  approval,
});

const result = (
  round: number,
  index: number,
  name: string,
  callId: string,
  body: string,
  opts: {
    server?: string;
    args?: string;
    status?: "succeeded" | "failed" | "denied" | "expired" | "cancelled";
    code?: ToolErrorCode;
    durationMs?: number;
    figure?: ToolFigure;
    web?: ToolWebDetail;
    feeMicroUsd?: number;
  } = {},
): LlmEvent => {
  const status = opts.status ?? "succeeded";
  return {
    type: "tool",
    phase: "result",
    server: opts.server ?? JUNO,
    name,
    callId,
    round,
    index,
    ...(opts.args === undefined ? {} : { args: opts.args }),
    result: body,
    ok: status === "succeeded",
    status,
    ...(opts.code ? { error: { code: opts.code } } : {}),
    ...(opts.durationMs === undefined ? {} : { durationMs: opts.durationMs }),
    ...(opts.figure ? { figure: opts.figure } : {}),
    ...(opts.web ? { web: opts.web } : {}),
    ...(opts.feeMicroUsd === undefined ? {} : { feeMicroUsd: opts.feeMicroUsd }),
  };
};

const serverTool = (
  phase: "call" | "result",
  round: number,
  callId: string,
  opts: { query?: string; results?: number; ok?: boolean } = {},
): LlmEvent => ({ type: "server_tool", phase, tool: "provider_web_search", callId, round, ...opts });

const sources = (list: ClientSource[], origin: ChatSourceOrigin): LlmEvent => ({ type: "sources", sources: list, origin });

const usage = (round: number, input: number, output: number, extra: { reasoning?: number; webSearchRequests?: number } = {}): LlmEvent => ({
  type: "usage",
  input,
  output,
  round,
  ...extra,
});

const finish = (reason: Extract<LlmEvent, { type: "finish" }>["reason"] = "stop"): LlmEvent => ({ type: "finish", reason });

function source(n: number, host: string, title: string): ClientSource {
  return { title, url: `https://${host}/article-${n}`, snippet: `${title}. An excerpt from ${host}.` };
}

function approval(input: {
  id: string;
  callId: string;
  status: ClientActionApproval["status"];
  decision?: string | null;
}): ClientActionApproval {
  return {
    id: input.id,
    surface: "chat",
    sessionId: "gen_fixture",
    conversationId: "conv_fixture",
    connectorId: "github",
    connectorLabel: GITHUB,
    toolName: "create_issue",
    action: "Create issue",
    riskClass: "external_write",
    preview: "Create issue \"Pinned fetch fails on Node 24\" in juno/web",
    detail: { repository: "juno/web", title: "Pinned fetch fails on Node 24" },
    receiptDigest: `digest_${input.callId}`,
    status: input.status,
    decision: input.decision ?? null,
    canAllowScope: true,
    derivedFromUntrusted: false,
    expiresAt: "2026-09-23T19:22:00.000Z",
    decidedAt: input.status === "pending" ? null : "2026-09-23T19:08:30.000Z",
    completedAt: null,
    createdAt: "2026-09-23T19:07:00.000Z",
  };
}

/** A search, then parallel reads of its first results — the shape most web turns take. */
function searchAndRead(opts: { startMs: number; round: number; query: string; hosts: string[] }): TurnScriptStep[] {
  const { startMs, round, query, hosts } = opts;
  const found = hosts.map((host, i) => source(i + 1, host, `${query} — ${host}`));
  const searchId = `jc_${round}_0`;
  const searchArgs = JSON.stringify({ query });
  const steps: TurnScriptStep[] = [
    at(startMs, call(round, 0, "web_search", searchId, { args: searchArgs })),
    at(startMs + 5, roundEnd(round, 1)),
    at(startMs + 10, queued(searchId, searchArgs, { query })),
    at(startMs + 15, running(searchId, 15_000)),
    at(startMs + 900, sources(found, "juno_search")),
    at(
      startMs + 905,
      result(round, 0, "web_search", searchId, found.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n"), {
        args: searchArgs,
        durationMs: 890,
        figure: { kind: "results", n: found.length },
        web: { query, engine: "tavily", results: found.map((s, i) => ({ n: i + 1, title: s.title, url: s.url })) },
        feeMicroUsd: 8_000,
      }),
    ),
    at(startMs + 910, usage(round, 4_200, 60)),
  ];
  const next = round + 1;
  const reads = found.slice(0, 3);
  reads.forEach((s, i) => {
    const id = `jc_${next}_${i}`;
    const args = JSON.stringify({ url: s.url });
    steps.push(at(startMs + 1_600 + i * 5, call(next, i, "web_fetch", id, { args })));
  });
  steps.push(at(startMs + 1_620, roundEnd(next, reads.length)));
  reads.forEach((s, i) => {
    const id = `jc_${next}_${i}`;
    const args = JSON.stringify({ url: s.url });
    steps.push(at(startMs + 1_625 + i, queued(id, args, { url: s.url, domain: new URL(s.url).hostname })));
  });
  reads.forEach((_, i) => steps.push(at(startMs + 1_630 + i, running(`jc_${next}_${i}`, 20_000))));
  reads.forEach((s, i) => {
    const id = `jc_${next}_${i}`;
    const done = startMs + 2_400 + i * 350;
    steps.push(at(done, sources([{ ...s, snippet: `${s.snippet} Read in full.` }], "juno_fetch")));
    steps.push(
      at(
        done + 5,
        result(next, i, "web_fetch", id, `${s.title}\n\nThe page text.`, {
          args: JSON.stringify({ url: s.url }),
          durationMs: 780 + i * 350,
          figure: { kind: "chars", n: 9_400 + i * 1_300 },
          web: { requestedUrl: s.url, finalUrl: s.url, contentType: "html", chars: 9_400 + i * 1_300, totalChars: 9_400 + i * 1_300 },
        }),
      ),
    );
  });
  steps.push(at(startMs + 3_500, usage(next, 21_000, 120)));
  return steps;
}

// ── The scripts ───────────────────────────────────────────────────────────────

const WEB = WEB_CLIENT_FEATURES;

const trivial: TurnScript = {
  fixture: 1,
  id: "trivial-answer",
  title: "Trivial answer, no tools",
  features: WEB,
  end: "completed",
  steps: [
    at(220, text(0, "Paris is the capital of France.")),
    at(260, roundEnd(0, 0)),
    at(265, usage(0, 900, 9)),
    at(270, finish()),
  ],
};

const shortThinking: TurnScript = {
  fixture: 2,
  id: "short-thinking",
  title: "Short thinking, then the answer",
  features: WEB,
  end: "completed",
  steps: [
    at(300, reasoning(0, "The user wants a quick comparison of two sorting algorithms. ")),
    at(1_400, reasoning(0, "Merge sort is stable; quicksort is usually faster in place.")),
    at(3_000, text(0, "Merge sort is stable and O(n log n) in the worst case; ")),
    at(3_100, text(0, "quicksort is usually faster in practice but O(n²) in the worst case.")),
    at(3_150, roundEnd(0, 0)),
    at(3_160, usage(0, 1_200, 180, { reasoning: 90 })),
    at(3_170, finish()),
  ],
};

const longThinking: TurnScript = {
  fixture: 3,
  id: "long-thinking-headlines",
  title: "Long thinking with provider headlines",
  features: WEB,
  end: "completed",
  steps: [
    at(400, reasoning(0, "**Reading the question**\n\nThe user asks how a heat pump's efficiency changes in winter. ", 0)),
    at(6_000, reasoning(0, "**Comparing climates**\n\nCOP falls as the outdoor temperature drops; cold-climate units hold up better. ", 1)),
    at(14_000, reasoning(0, "**Checking the numbers**\n\nA typical COP of 3–4 at 7 °C falls to about 2 at −15 °C. ", 2)),
    at(24_000, reasoning(0, "**Drafting**\n\nLead with the rule of thumb, then the caveats.", 3)),
    at(25_000, text(0, "A heat pump's efficiency (its COP) falls as it gets colder outside: ")),
    at(25_200, text(0, "around 3–4 at 7 °C, and about 2 at −15 °C for a cold-climate unit.")),
    at(25_250, roundEnd(0, 0)),
    at(25_260, usage(0, 1_500, 2_400, { reasoning: 2_100 })),
    at(25_270, finish()),
  ],
};

const searchThenReads: TurnScript = {
  fixture: 4,
  id: "search-parallel-reads",
  title: "A search, three parallel reads, a cited answer",
  features: WEB,
  end: "completed",
  steps: [
    ...searchAndRead({
      startMs: 600,
      round: 0,
      query: "heat pump subsidies 2026",
      hosts: ["gov.example.org", "energy.example.com", "news.example.net", "blog.example.io", "wiki.example.org"],
    }),
    at(4_200, text(2, "Three programmes fund heat pumps in 2026 [1][2]. ")),
    at(4_400, text(2, "The largest covers up to 70% of the cost for low-income homes [3].")),
    at(4_450, roundEnd(2, 0)),
    at(4_460, usage(2, 38_000, 260)),
    at(4_470, finish()),
  ],
};

const runCodeFiles: TurnScript = {
  fixture: 5,
  id: "run-code-files",
  title: "run_code creating two files",
  features: WEB,
  end: "completed",
  steps: [
    at(500, call(0, 0, "run_code", "jc_0_0", { args: JSON.stringify({ code: "import pandas as pd\n…", reason: "Chart the monthly totals" }) })),
    at(510, roundEnd(0, 1)),
    at(515, queued("jc_0_0", JSON.stringify({ code: "import pandas as pd\n…", reason: "Chart the monthly totals" }), {
      reason: "Chart the monthly totals",
      language: "python",
      lines: 14,
    })),
    at(520, running("jc_0_0", 130_000)),
    at(6_800, result(0, 0, "run_code", "jc_0_0", "Saved totals.csv and chart.png.", {
      args: JSON.stringify({ code: "import pandas as pd\n…", reason: "Chart the monthly totals" }),
      durationMs: 6_270,
      figure: { kind: "files", n: 2 },
      feeMicroUsd: 46 * 7,
    })),
    at(6_810, usage(0, 3_100, 240)),
    at(7_400, text(1, "Here are the monthly totals and a chart of them.")),
    at(7_450, roundEnd(1, 0)),
    at(7_460, usage(1, 3_600, 300)),
    at(7_470, finish()),
  ],
};

const connectorOk: TurnScript = {
  fixture: 6,
  id: "connector-succeeded",
  title: "A connector call that succeeds",
  features: WEB,
  end: "completed",
  steps: [
    at(700, call(0, 0, "github__create_issue", "toolu_01", { server: GITHUB, args: JSON.stringify({ title: "Flaky test" }) })),
    at(710, roundEnd(0, 1)),
    at(715, queued("toolu_01", JSON.stringify({ title: "Flaky test" }), { title: "Flaky test" })),
    at(720, running("toolu_01", 60_000)),
    at(2_100, result(0, 0, "github__create_issue", "toolu_01", "Created issue #412.", {
      server: GITHUB,
      durationMs: 1_380,
    })),
    at(2_110, usage(0, 2_800, 90)),
    at(2_600, text(1, "I opened issue #412 for the flaky test.")),
    at(2_650, roundEnd(1, 0)),
    at(2_660, usage(1, 3_000, 120)),
    at(2_670, finish()),
  ],
};

const connectorUnavailable: TurnScript = {
  fixture: 7,
  id: "connector-unavailable",
  title: "A connector unavailable at turn start",
  // The unavailable connector is a turn-start fact and notice from the route (turnStartFacts);
  // the provider stream itself is an ordinary answer.
  features: WEB,
  end: "completed",
  steps: [
    at(600, text(0, "I can't reach GitHub this turn, so I can't list your open issues. ")),
    at(700, text(0, "Reconnecting it in Settings should fix that.")),
    at(750, roundEnd(0, 0)),
    at(760, usage(0, 1_100, 40)),
    at(770, finish()),
  ],
};

const approvalAllowed: TurnScript = {
  fixture: 8,
  id: "approval-allowed",
  title: "An approval, pending then allowed",
  features: WEB,
  end: "completed",
  steps: [
    at(600, call(0, 0, "github__create_issue", "toolu_02", { server: GITHUB, args: JSON.stringify({ title: "Pinned fetch fails on Node 24" }) })),
    at(610, roundEnd(0, 1)),
    at(615, queued("toolu_02", JSON.stringify({ title: "Pinned fetch fails on Node 24" }), { title: "Pinned fetch fails on Node 24" })),
    at(900, awaiting("toolu_02", approval({ id: "apr_1", callId: "toolu_02", status: "pending" }))),
    at(14_000, running("toolu_02", 60_000)),
    at(15_200, result(0, 0, "github__create_issue", "toolu_02", "Created issue #413.", { server: GITHUB, durationMs: 1_150 })),
    at(15_210, usage(0, 2_900, 80)),
    at(15_800, text(1, "Done: issue #413 is open.")),
    at(15_850, roundEnd(1, 0)),
    at(15_860, usage(1, 3_100, 100)),
    at(15_870, finish()),
  ],
};

const approvalRefused: TurnScript = {
  fixture: 9,
  id: "approval-denied-expired",
  title: "Approvals denied and expired",
  features: WEB,
  end: "completed",
  steps: [
    at(600, call(0, 0, "github__create_issue", "toolu_03", { server: GITHUB, args: JSON.stringify({ title: "One" }) })),
    at(605, call(0, 1, "github__create_issue", "toolu_04", { server: GITHUB, args: JSON.stringify({ title: "Two" }) })),
    at(610, roundEnd(0, 2)),
    at(615, queued("toolu_03", JSON.stringify({ title: "One" }), { title: "One" })),
    at(616, queued("toolu_04", JSON.stringify({ title: "Two" }), { title: "Two" })),
    at(900, awaiting("toolu_03", approval({ id: "apr_2", callId: "toolu_03", status: "pending" }))),
    at(9_000, result(0, 0, "github__create_issue", "toolu_03", "The person declined this action.", {
      server: GITHUB,
      status: "denied",
      code: "denied",
    })),
    at(9_100, awaiting("toolu_04", approval({ id: "apr_3", callId: "toolu_04", status: "pending" }))),
    at(909_100, result(0, 1, "github__create_issue", "toolu_04", "The approval expired before anyone answered.", {
      server: GITHUB,
      status: "expired",
      code: "expired",
    })),
    at(909_110, usage(0, 3_000, 90)),
    at(909_600, text(1, "I didn't create either issue: one was declined and the other approval expired.")),
    at(909_650, roundEnd(1, 0)),
    at(909_660, usage(1, 3_300, 120)),
    at(909_670, finish()),
  ],
};

const failures: TurnScript = {
  fixture: 10,
  id: "timeout-invalid-provenance",
  title: "A timeout, invalid arguments and a provenance refusal",
  features: WEB,
  end: "completed",
  steps: [
    at(500, call(0, 0, "web_fetch", "jc_0_0", { args: JSON.stringify({ url: "https://made-up.example.com/report" }) })),
    at(505, call(0, 1, "calculate", "jc_0_1", { args: "{\"expression\": " })),
    at(510, call(0, 2, "search_chats", "jc_0_2", { args: JSON.stringify({ query: "trip notes" }) })),
    at(515, roundEnd(0, 3)),
    at(520, queued("jc_0_0", JSON.stringify({ url: "https://made-up.example.com/report" }), { url: "https://made-up.example.com/report", domain: "made-up.example.com" })),
    at(521, queued("jc_0_1", "{\"expression\": ")),
    at(522, queued("jc_0_2", JSON.stringify({ query: "trip notes" }), { query: "trip notes" })),
    at(530, result(0, 0, "web_fetch", "jc_0_0", "Juno only opens links that appeared in this conversation.", {
      status: "failed",
      code: "url_not_in_prior_context",
    })),
    at(535, result(0, 1, "calculate", "jc_0_1", "The arguments were not valid JSON. Nothing was run.", {
      status: "failed",
      code: "invalid_args",
    })),
    at(540, running("jc_0_2", 10_000)),
    at(10_540, result(0, 2, "search_chats", "jc_0_2", "Timed out after 10 s.", {
      status: "failed",
      code: "timeout",
      durationMs: 10_000,
    })),
    at(10_550, usage(0, 2_600, 110)),
    at(11_000, text(1, "I couldn't open that link or search your chats just now.")),
    at(11_050, roundEnd(1, 0)),
    at(11_060, usage(1, 2_900, 140)),
    at(11_070, finish()),
  ],
};

const anthropicCommentary: TurnScript = {
  fixture: 11,
  id: "commentary-between-rounds",
  title: "Commentary between rounds (Anthropic-style)",
  features: WEB,
  end: "completed",
  steps: [
    at(500, text(0, "Let me check the current exchange rate first.")),
    // Anthropic's call arrives at content_block_start with no arguments; they ride on the result.
    at(900, call(0, 0, "web_search", "toolu_10")),
    at(1_100, roundEnd(0, 1)),
    at(1_105, queued("toolu_10", JSON.stringify({ query: "EUR to JPY today" }), { query: "EUR to JPY today" })),
    at(1_110, running("toolu_10", 15_000)),
    at(1_900, sources([source(1, "rates.example.com", "EUR/JPY today")], "juno_search")),
    at(1_905, result(0, 0, "web_search", "toolu_10", "[1] EUR/JPY today — https://rates.example.com/article-1", {
      args: JSON.stringify({ query: "EUR to JPY today" }),
      durationMs: 790,
      figure: { kind: "results", n: 1 },
    })),
    at(1_910, usage(0, 3_000, 40)),
    at(2_500, text(1, "One euro buys about 162 yen today [1].")),
    at(2_550, roundEnd(1, 0)),
    at(2_560, usage(1, 3_400, 70)),
    at(2_570, finish()),
  ],
};

const openaiPhase: TurnScript = {
  fixture: 12,
  id: "openai-phase-commentary",
  title: "OpenAI phase: commentary, then the final answer",
  features: WEB,
  end: "completed",
  steps: [
    at(400, reasoning(0, "Look up the release date, then answer.", 0)),
    at(900, text(0, "I'll look up the release date.", "commentary")),
    at(1_000, call(0, 0, "web_search", "call_abc", { args: JSON.stringify({ query: "Node 26 release date" }) })),
    at(1_010, roundEnd(0, 1)),
    at(1_015, queued("call_abc", JSON.stringify({ query: "Node 26 release date" }), { query: "Node 26 release date" })),
    at(1_020, running("call_abc", 15_000)),
    at(1_800, sources([source(1, "nodejs.example.org", "Node 26 release")], "juno_search")),
    at(1_805, result(0, 0, "web_search", "call_abc", "[1] Node 26 release — https://nodejs.example.org/article-1", {
      durationMs: 780,
      figure: { kind: "results", n: 1 },
    })),
    at(1_810, usage(0, 2_500, 60, { reasoning: 20 })),
    at(2_400, text(1, "Node 26 was released in April 2026 [1].", "answer")),
    at(2_450, roundEnd(1, 0)),
    at(2_460, usage(1, 2_900, 90, { reasoning: 20 })),
    at(2_470, finish()),
  ],
};

const LONG_OPENING =
  "Here is the short version: the policy changed this year, and most households now qualify for the higher rate. " +
  "The details depend on your region, your income band and whether the installer is certified, so it is worth " +
  "checking each one before you apply. Let me confirm the current regional thresholds so the numbers are exact.";

const toolAfterAnswer: TurnScript = {
  fixture: 13,
  id: "tool-after-answer-text",
  title: "A tool after the answer text started",
  features: WEB,
  end: "completed",
  steps: [
    at(500, text(0, LONG_OPENING)),
    at(1_600, call(0, 0, "web_search", "toolu_20")),
    at(1_800, roundEnd(0, 1)),
    at(1_805, queued("toolu_20", JSON.stringify({ query: "regional heat pump thresholds 2026" }), { query: "regional heat pump thresholds 2026" })),
    at(1_810, running("toolu_20", 15_000)),
    at(2_700, result(0, 0, "web_search", "toolu_20", "[1] Regional thresholds — https://gov.example.org/article-1", {
      args: JSON.stringify({ query: "regional heat pump thresholds 2026" }),
      durationMs: 890,
      figure: { kind: "results", n: 1 },
    })),
    at(2_710, usage(0, 3_000, 120)),
    at(3_200, text(1, "The thresholds are €40,000 in most regions and €45,000 in the north [1].")),
    at(3_250, roundEnd(1, 0)),
    at(3_260, usage(1, 3_500, 150)),
    at(3_270, finish()),
  ],
};

const budgetReached: TurnScript = {
  fixture: 14,
  id: "round-budget-final-round",
  title: "The round budget reached; the final round answers",
  // A low-effort turn: a budget of 4 requests, the fourth tools-off.
  features: WEB,
  end: "completed",
  steps: [
    ...[0, 1, 2].flatMap((round) => {
      const id = `jc_${round}_0`;
      const args = JSON.stringify({ query: `laptop battery benchmark ${round + 1}` });
      const t = 500 + round * 1_500;
      return [
        at(t, call(round, 0, "web_search", id, { args })),
        at(t + 5, roundEnd(round, 1)),
        at(t + 10, queued(id, args, { query: `laptop battery benchmark ${round + 1}` })),
        at(t + 15, running(id, 15_000)),
        at(t + 800, result(round, 0, "web_search", id, "[1] Benchmarks — https://bench.example.com/article-1", {
          args,
          durationMs: 785,
          figure: { kind: "results", n: 1 },
        })),
        at(t + 810, usage(round, 3_000 + round * 1_000, 50)),
      ];
    }),
    at(5_200, text(3, "From what I found, the best battery life is about 18 hours; I couldn't check the newest models.")),
    at(5_250, roundEnd(3, 0, { final: true })),
    at(5_260, usage(3, 7_000, 140)),
    at(5_270, finish()),
  ],
};

const stoppedMidTool: TurnScript = {
  fixture: 15,
  id: "stopped-mid-tool",
  title: "Stopped during a tool call",
  features: WEB,
  end: "aborted",
  steps: [
    at(400, reasoning(0, "I'll compute this with code.")),
    at(1_000, call(0, 0, "run_code", "jc_0_0", { args: JSON.stringify({ code: "simulate()" }) })),
    at(1_005, roundEnd(0, 1)),
    at(1_010, queued("jc_0_0", JSON.stringify({ code: "simulate()" }), { language: "python", lines: 1 })),
    at(1_015, running("jc_0_0", 130_000)),
    at(8_000, result(0, 0, "run_code", "jc_0_0", "Cancelled.", { status: "cancelled", code: "cancelled" })),
  ],
};

const networkFailure: TurnScript = {
  fixture: 16,
  id: "network-failure",
  title: "The provider connection drops",
  features: WEB,
  end: "failed",
  steps: [
    at(400, reasoning(0, "Planning the answer.")),
    at(2_000, reasoning(0, " Checking the edge cases.")),
  ],
};

const stall: TurnScript = {
  fixture: 17,
  id: "stall-no-tool",
  title: "Thirty seconds with no frame and no tool running",
  features: WEB,
  end: "completed",
  steps: [
    at(400, reasoning(0, "Working through the proof.")),
    // No frame for 34 s: the line shows "No response for" and goes calm.
    at(34_400, reasoning(0, " The induction step holds.")),
    at(35_000, text(0, "The statement holds for every n ≥ 1, by induction.")),
    at(35_050, roundEnd(0, 0)),
    at(35_060, usage(0, 1_300, 900, { reasoning: 800 })),
    at(35_070, finish()),
  ],
};

const longRun: TurnScript = {
  fixture: 18,
  id: "long-run-90s",
  title: "A 90-second run with a provider search",
  features: WEB,
  end: "completed",
  steps: [
    at(500, reasoning(0, "I need recent figures.")),
    at(3_000, text(0, "Let me search for the latest numbers.")),
    at(3_500, serverTool("call", 0, "srvtoolu_01", { query: "EV sales 2026 Europe" })),
    at(9_000, serverTool("result", 0, "srvtoolu_01", { results: 5, ok: true })),
    at(9_010, sources(
      [source(1, "autos.example.com", "EV sales 2026"), source(2, "stats.example.org", "European registrations")],
      "provider_search",
    )),
    // The search happened inside the response: the step ends with no client tool call.
    at(9_020, roundEnd(0, 0, { serverTools: 1, stop: null })),
    at(20_000, reasoning(1, "Now summarise by country.")),
    at(60_000, reasoning(1, " Norway and Denmark lead on share.")),
    at(88_000, text(1, "EV sales in Europe rose about 18% in 2026, led by Norway and Denmark.")),
    at(89_000, roundEnd(1, 0)),
    at(89_010, usage(1, 12_000, 1_800, { reasoning: 1_200, webSearchRequests: 1 })),
    at(89_020, finish()),
  ],
};

/** One row as a pre-rework emitter wrote it: the id and time `createSseSender` stamped, nothing else. */
function legacyRow(n: number, row: Omit<ClientActivityEvent, "id" | "createdAt">): ClientActivityEvent {
  return { ...row, id: `activity-1758359640000-${n}`, createdAt: `2026-09-20T09:14:${String(10 + n).padStart(2, "0")}.000Z` };
}

const legacy: TurnScript = {
  fixture: 19,
  id: "legacy-message",
  title: "A message persisted before the rework",
  // Each row is what an emitter at d0997af2 wrote, in the order a turn writes them. Between them
  // they cover every legacy row the adapter maps (§7.7); one real turn seldom has them all.
  features: [],
  end: "completed",
  legacy: {
    // The two rounds' text, glued: the old route streamed it with no separator and saved it so.
    content: "Let me check.You have three open issues. I opened a fourth for the Node 24 fetch failure.",
    reasoning: null,
    activity: [
      // route.ts:2762-2767, at turn start on every web-on turn.
      legacyRow(0, { kind: "search", title: "Preparing web search", detail: "Claude web search" }),
      // deep-research.ts:146-151, the in-chat research drive: the only emitter of this title.
      legacyRow(1, { kind: "search", title: "Searching the web", detail: "node 24 fetch ENOTFOUND pinned lookup" }),
      // route.ts:3006-3011, at the first text delta.
      legacyRow(2, { kind: "write", title: "Writing the answer", detail: "Streaming response text" }),
      // route.ts:390-400 opened these two rows and :403-420 closed them with the tool detail.
      legacyRow(3, {
        kind: "tool",
        title: `Using ${GITHUB}`,
        detail: "github__list_issues",
        tool: { server: GITHUB, name: "github__list_issues", argsNote: "empty", status: "ok", durationMs: 1_100, result: "3 open issues." },
      }),
      legacyRow(4, {
        kind: "tool",
        title: `Using ${GITHUB}`,
        detail: "github__create_issue",
        tool: {
          server: GITHUB,
          name: "github__create_issue",
          args: "{\n  \"repository\": \"juno/web\",\n  \"title\": \"Pinned fetch fails on Node 24\"\n}",
          status: "ok",
          durationMs: 640,
          result: "Created issue #412.",
        },
      }),
      // route.ts:2896-2908, when the second call asked for approval.
      legacyRow(5, {
        kind: "tool",
        title: `${GITHUB} needs approval`,
        detail: "Create issue \"Pinned fetch fails on Node 24\" in juno/web",
      }),
      // route.ts:3028-3037, one row per source the provider search returned.
      legacyRow(6, {
        kind: "visit",
        title: "Visited source",
        detail: "Node.js 24 release notes",
        url: "https://nodejs.example.org/en/blog/release/v24.0.0",
      }),
      // route.ts:3159, :3163-3172.
      legacyRow(7, { kind: "usage", title: "Token usage recorded", detail: "4,200 input · 90 output · 1 search · $0.03" }),
      legacyRow(8, { kind: "done", title: "Finished response", detail: "1 source" }),
    ],
  },
  steps: [],
};

const twoRuns: TurnScript = {
  fixture: 20,
  id: "two-runs-panel-open",
  title: "The live run of a list with two runs, the panel open on it",
  features: WEB,
  end: "completed",
  steps: [
    ...searchAndRead({ startMs: 500, round: 0, query: "rust async runtimes", hosts: ["docs.example.rs", "blog.example.dev", "forum.example.org"] }),
    at(4_200, text(2, "Tokio is the most widely used runtime [1]; smol is the lightweight alternative [2].")),
    at(4_250, roundEnd(2, 0)),
    at(4_260, usage(2, 30_000, 120)),
    at(4_270, finish()),
  ],
};

const researchHandoff: TurnScript = {
  fixture: 21,
  id: "research-handoff",
  title: "A Research request handed to a background run",
  // The route creates the run and ends the request with the `handoff` frame; no provider stream runs.
  features: WEB,
  end: "completed",
  handoffRunId: "run_fixture_21",
  steps: [],
};

const burst: TurnScript = {
  fixture: 22,
  id: "burst-100fps",
  title: "A 100 frames/s burst of deltas",
  features: WEB,
  end: "completed",
  steps: [
    ...Array.from({ length: 300 }, (_, i) => at(300 + i * 10, text(0, `token${i} `))),
    at(3_310, roundEnd(0, 0)),
    at(3_320, usage(0, 800, 600)),
    at(3_330, finish()),
  ],
};

const textFirst: TurnScript = {
  fixture: 23,
  id: "anthropic-text-first",
  title: "\"Let me look that up.\", then a tool call in the same round",
  features: WEB,
  end: "completed",
  steps: [
    at(400, text(0, "Let me look that up.")),
    at(700, call(0, 0, "web_search", "toolu_30")),
    at(900, roundEnd(0, 1)),
    at(905, queued("toolu_30", JSON.stringify({ query: "Mars rover news" }), { query: "Mars rover news" })),
    at(910, running("toolu_30", 15_000)),
    at(1_700, result(0, 0, "web_search", "toolu_30", "[1] Rover news — https://space.example.org/article-1", {
      args: JSON.stringify({ query: "Mars rover news" }),
      durationMs: 790,
      figure: { kind: "results", n: 1 },
    })),
    at(1_710, usage(0, 2_200, 30)),
    at(2_300, text(1, "The rover reached the delta's rim last week [1].")),
    at(2_350, roundEnd(1, 0)),
    at(2_360, usage(1, 2_600, 60)),
    at(2_370, finish()),
  ],
};

const quietRunCode: TurnScript = {
  fixture: 24,
  id: "run-code-60s-quiet",
  title: "A 60-second run_code with no events",
  features: WEB,
  end: "completed",
  steps: [
    at(500, call(0, 0, "run_code", "jc_0_0", { args: JSON.stringify({ code: "train()" }) })),
    at(505, roundEnd(0, 1)),
    at(510, queued("jc_0_0", JSON.stringify({ code: "train()" }), { language: "python", lines: 1 })),
    at(515, running("jc_0_0", 130_000)),
    // Silent for 60 s, well inside its own timeout: not a stall.
    at(60_600, result(0, 0, "run_code", "jc_0_0", "Accuracy 0.94.", {
      durationMs: 60_085,
      figure: { kind: "exit", value: "0" },
      feeMicroUsd: 46 * 61,
    })),
    at(60_610, usage(0, 2_000, 60)),
    at(61_000, text(1, "The model reached 94% accuracy.")),
    at(61_050, roundEnd(1, 0)),
    at(61_060, usage(1, 2_300, 80)),
    at(61_070, finish()),
  ],
};

const chatWhileResearch: TurnScript = {
  fixture: 25,
  id: "chat-while-research-live",
  title: "A chat stream while a Research row is live",
  features: WEB,
  end: "completed",
  steps: [
    at(400, reasoning(0, "A definition question; no tools needed.")),
    at(1_800, text(0, "A heat pump moves heat rather than making it, which is why it can deliver more than it uses.")),
    at(1_850, roundEnd(0, 0)),
    at(1_860, usage(0, 1_100, 90, { reasoning: 30 })),
    at(1_870, finish()),
  ],
};

const sheetApproval: TurnScript = {
  fixture: 26,
  id: "sheet-pending-approval",
  title: "A pending approval while the panel is a sheet",
  features: WEB,
  end: "completed",
  steps: [
    at(600, call(0, 0, "github__create_issue", "toolu_40", { server: GITHUB, args: JSON.stringify({ title: "Sheet test" }) })),
    at(610, roundEnd(0, 1)),
    at(615, queued("toolu_40", JSON.stringify({ title: "Sheet test" }), { title: "Sheet test" })),
    at(900, awaiting("toolu_40", approval({ id: "apr_4", callId: "toolu_40", status: "pending" }))),
    at(30_000, running("toolu_40", 60_000)),
    at(31_000, result(0, 0, "github__create_issue", "toolu_40", "Created issue #414.", { server: GITHUB, durationMs: 980 })),
    at(31_010, usage(0, 2_900, 70)),
    at(31_500, text(1, "Issue #414 is open.")),
    at(31_550, roundEnd(1, 0)),
    at(31_560, usage(1, 3_100, 90)),
    at(31_570, finish()),
  ],
};

const reEntry: TurnScript = {
  fixture: 27,
  id: "tool-after-answer-twice",
  title: "Answer text, a tool, more answer, another tool, the answer",
  features: WEB,
  end: "completed",
  steps: [
    at(500, text(0, LONG_OPENING)),
    at(1_600, call(0, 0, "current_time", "toolu_50")),
    at(1_700, roundEnd(0, 1)),
    at(1_705, queued("toolu_50", "{}", {})),
    at(1_710, running("toolu_50", 1_000)),
    at(1_720, result(0, 0, "current_time", "toolu_50", "Now: 2026-09-23T19:07:00+02:00", {
      args: "{}",
      durationMs: 3,
      figure: { kind: "value", value: "2026-09-23T19:07:00+02:00" },
    })),
    at(1_730, usage(0, 2_000, 110)),
    at(2_200, text(1, "Applications for this year close in 38 days. Let me confirm the regional deadline too.")),
    at(2_900, call(1, 0, "web_search", "toolu_51")),
    at(3_000, roundEnd(1, 1)),
    at(3_005, queued("toolu_51", JSON.stringify({ query: "regional application deadline" }), { query: "regional application deadline" })),
    at(3_010, running("toolu_51", 15_000)),
    at(3_800, result(1, 0, "web_search", "toolu_51", "[1] Deadlines — https://gov.example.org/article-2", {
      args: JSON.stringify({ query: "regional application deadline" }),
      durationMs: 790,
      figure: { kind: "results", n: 1 },
    })),
    at(3_810, usage(1, 3_000, 150)),
    at(4_300, text(2, "The northern region closes a week earlier, on 23 October [1].")),
    at(4_350, roundEnd(2, 0)),
    at(4_360, usage(2, 3_600, 190)),
    at(4_370, finish()),
  ],
};

const escalation: TurnScript = {
  fixture: 28,
  id: "escalation-2-and-10-min",
  title: "Two and then ten minutes of work",
  features: WEB,
  end: "completed",
  steps: [
    ...Array.from({ length: 22 }, (_, i) => at(400 + i * 29_000, reasoning(0, `Step ${i + 1} of the derivation. `))),
    at(640_000, text(0, "The closed form is (n² + n) / 2.")),
    at(640_050, roundEnd(0, 0)),
    at(640_060, usage(0, 1_400, 24_000, { reasoning: 23_900 })),
    at(640_070, finish()),
  ],
};

/** One script per `/dev/run` fixture, in fixture order (1–28). */
export const TURN_SCRIPTS: readonly TurnScript[] = [
  trivial,
  shortThinking,
  longThinking,
  searchThenReads,
  runCodeFiles,
  connectorOk,
  connectorUnavailable,
  approvalAllowed,
  approvalRefused,
  failures,
  anthropicCommentary,
  openaiPhase,
  toolAfterAnswer,
  budgetReached,
  stoppedMidTool,
  networkFailure,
  stall,
  longRun,
  legacy,
  twoRuns,
  researchHandoff,
  burst,
  textFirst,
  quietRunCode,
  chatWhileResearch,
  sheetApproval,
  reEntry,
  escalation,
];

/** The script's events alone, in order: what a provider stream yields. */
export function scriptEvents(script: TurnScript): LlmEvent[] {
  return script.steps.map((step) => step.event);
}

export function turnScript(fixture: number): TurnScript {
  const script = TURN_SCRIPTS.find((candidate) => candidate.fixture === fixture);
  if (!script) throw new Error(`no turn script for /dev/run fixture ${fixture}`);
  return script;
}
