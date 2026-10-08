import assert from "node:assert/strict";
import test from "node:test";

import { tokenCoverage } from "@/lib/research/claim-analysis";
import { auditAssistPrompt, parseAuditAssist, shouldAssist } from "@/lib/research/audit-assist";
import { parsePlan, type ResearchObjective } from "@/lib/research/domain";
import { createResearchEngine } from "@/lib/research/engine";
import { auditGaps } from "@/lib/research/gap-audit";
import { detectSignal, extractLeads, guessLanguage } from "@/lib/research/leads";
import { comparisonOptions, figuresConflict, statesMetric } from "@/lib/research/metric-match";
import type { AuditAssistInput } from "@/lib/research/stages/types";
import { SCENARIO_GOAL, scenarioDeps } from "./fixtures/research-protocol-scenario";
import { memoryStore } from "./fixtures/research-store";

/*
 * The gap audit's semantic matching (units, synonyms, tolerance, one figure
 * per compared option) and multilingual leads, plus the optional cheap-model
 * assist that runs once per round.
 */

const NOW = new Date("2026-10-08T00:00:00.000Z");

function objective(id: string, question: string, metrics: string[], verify: string[] = []): ResearchObjective {
  return {
    id,
    question,
    rationale: "",
    importance: 1,
    status: "planned",
    evidenceRequirements: [],
    vector: { metrics, sources: ["official pricing page"], verify },
  } as unknown as ResearchObjective;
}

// ── Units and synonyms ──────────────────────────────────────────────────────

test("a finding states a metric across synonyms and units the word match missed", () => {
  const cases: Array<[string, string]> = [
    ["business plan price per seat per month", "GitHub Copilot Business costs $19 per user per month."],
    ["price per member monthly", "Notion Plus is $10/seat/mo billed annually."],
    ["annual price in USD", "The Team plan is $240 a year."],
    ["requests per minute limit", "The Free tier is capped at 60 RPM."],
    ["context window tokens", "Max mode exposes a 200,000 token context length."],
    ["annual discount percentage", "Paying yearly saves 20%."],
    ["storage limit", "Each workspace gets 100 GB of disk space."],
  ];
  for (const [metric, finding] of cases) {
    assert.ok(statesMetric(metric, finding), `${metric} <- ${finding}`);
  }
  // Before: the lexical check (token coverage ≥ 0.4) failed most of these.
  const lexicalMisses = cases.filter(([metric, finding]) => tokenCoverage(metric, finding) < 0.4).length;
  assert.ok(lexicalMisses >= 5, `lexical check missed ${lexicalMisses}/7`);
  // Still needs a figure, and still needs the concept.
  assert.equal(statesMetric("price per seat", "Pricing is per seat."), false);
  assert.equal(statesMetric("context window tokens", "Copilot Business costs $19 per user per month."), false);
});

test("figures are compared with their units: yearly at the monthly rate, rounding tolerated, different currencies not compared", () => {
  assert.equal(figuresConflict("Copilot Business is $19 per user per month", "Copilot Business is $228 per user per year"), false);
  assert.equal(figuresConflict("Pro costs $19.99 per month", "Pro costs $20 per month"), false);
  assert.equal(figuresConflict("Pro costs $20 per month", "Pro costs $40 per month"), true);
  assert.equal(figuresConflict("Pro costs €20 per month", "Pro costs $22 per month"), false);
  assert.equal(figuresConflict("Adoption is 41%", "Adoption is 55%"), true);
});

test("the options a goal compares", () => {
  assert.deepEqual(comparisonOptions(SCENARIO_GOAL), ["GitHub Copilot", "Cursor"]);
  assert.deepEqual(comparisonOptions("Compare Stripe, Adyen and Mollie fees for card payments"), ["Stripe", "Adyen", "Mollie"]);
  assert.deepEqual(comparisonOptions("postgres vs mysql for analytics"), ["postgres", "mysql"]);
  assert.deepEqual(comparisonOptions("What is the GitHub Copilot rate limit?"), []);
});

test("gap audit: synonyms no longer read as missing, and each compared option needs its own figure", () => {
  const objectives = [objective("o1", "What does each cost per seat on business plans?", ["business plan price per seat per month"])];
  const copilotOnly = auditGaps({
    objectives,
    findings: [{ objectiveId: "o1", sourceId: "s1", url: "https://docs.github.com/copilot/plans", claim: "GitHub Copilot Business costs $19 per user per month.", quote: "$19 per user per month" }],
    sources: [{ id: "s1", url: "https://docs.github.com/copilot/plans", publishedAt: new Date("2026-08-01") }],
    now: NOW,
    subject: "GitHub Copilot Cursor",
    issued: [],
    goal: SCENARIO_GOAL,
  });
  // "per user" satisfies "per seat"; Cursor's own price is what is missing.
  assert.deepEqual(copilotOnly.entries[0]!.missingFigures, ["business plan price per seat per month — Cursor"]);
  assert.ok(copilotOnly.queries.some((query) => /^Cursor business plan price per seat per month/.test(query)), copilotOnly.queries.join(" | "));

  const both = auditGaps({
    objectives,
    findings: [
      { objectiveId: "o1", sourceId: "s1", url: "https://docs.github.com/copilot/plans", claim: "GitHub Copilot Business costs $19 per user per month.", quote: "" },
      { objectiveId: "o1", sourceId: "s2", url: "https://cursor.com/pricing", claim: "Teams is $40/user/mo.", quote: "" },
    ],
    sources: [],
    now: NOW,
    subject: "GitHub Copilot Cursor",
    issued: [],
    goal: SCENARIO_GOAL,
  });
  assert.deepEqual(both.entries[0]!.missingFigures, []);
});

test("gap audit: a yearly and a monthly statement of one price are not a conflict; two monthly prices are", () => {
  const objectives = [objective("o1", "What does Copilot cost?", ["price per seat"])];
  const run = (claimB: string) =>
    auditGaps({
      objectives,
      findings: [
        { objectiveId: "o1", sourceId: "a", url: "https://docs.github.com/a", claim: "Copilot Business costs $19 per user per month.", quote: "" },
        { objectiveId: "o1", sourceId: "b", url: "https://news.example/b", claim: claimB, quote: "" },
      ],
      sources: [],
      now: NOW,
      subject: "Copilot",
      issued: [],
    }).entries[0]!.conflicts;
  assert.equal(run("Copilot Business costs $228 per user per year.").length, 0);
  assert.equal(run("Copilot Business costs $39 per user per month.").length, 1);
});

test("gap audit: a model-confirmed metric is no longer a gap", () => {
  const audit = auditGaps({
    objectives: [objective("o1", "What does it cost?", ["seat licence price"])],
    findings: [{ objectiveId: "o1", sourceId: null, url: "https://x.example", claim: "Each licence is nineteen dollars a month, 19 USD.", quote: "" }],
    sources: [],
    now: NOW,
    subject: "X",
    issued: [],
    confirmed: [{ objectiveId: "o1", metric: "seat licence price" }],
  });
  assert.deepEqual(audit.entries[0]!.missingFigures, []);
});

// ── Multilingual leads ──────────────────────────────────────────────────────

test("lead signals are read in FR, DE, ES, IT, PT, JA and ZH, and the micro-query is written in the source's language", () => {
  const cases: Array<{ claim: string; signal: string; language: string; terms: RegExp }> = [
    { claim: "Le forfait Pro de Cursor sera supprimé le 1er mars 2026 pour les clients.", signal: "deprecation", language: "fr", terms: /date de fin migration/ },
    { claim: "Cursor kündigt eine Preiserhöhung für den Pro-Tarif ab Juli 2026 an, die für alle Nutzer gilt.", signal: "pricing change", language: "de", terms: /Preisänderung gültig ab/ },
    { claim: "Cursor aplica un límite de solicitudes por minuto a las cuentas gratuitas y no lo publica.", signal: "rate limit", language: "es", terms: /límites de tasa cuotas/ },
    { claim: "Il servizio Cursor ha subito un disservizio di tre ore in Europa e non è stato comunicato.", signal: "incident", language: "it", terms: /incidente rapporto post-mortem/ },
    { claim: "A Cursor foi processada em ação coletiva por uso de dados e não respondeu.", signal: "legal or regulatory", language: "pt", terms: /processo regulador decisão/ },
    { claim: "Cursorは旧プランを2026年に廃止すると発表した。", signal: "deprecation", language: "ja", terms: /廃止 日付 移行/ },
    { claim: "Cursor 宣布涨价，专业版将于2026年生效。", signal: "pricing change", language: "zh", terms: /价格调整 生效日期/ },
  ];
  for (const item of cases) {
    const hit = detectSignal(item.claim);
    assert.equal(hit?.signal.signal, item.signal, item.claim);
    assert.equal(hit?.language, item.language, item.claim);
    const [lead] = extractLeads({
      findings: [{ objectiveId: "o1", url: "https://cursor.com/x", claim: item.claim, quote: "", round: 1 }],
      round: 1,
      issued: [],
      goal: SCENARIO_GOAL,
      entities: ["GitHub Copilot", "Cursor"],
    });
    assert.ok(lead, item.claim);
    assert.match(lead!.query, /^Cursor /, lead!.query);
    assert.match(lead!.query, item.terms, lead!.query);
  }
  assert.equal(guessLanguage("The plan will cost more from June."), "en");
});

test("multilingual leads are deduplicated: CJK queries compare on character bigrams", () => {
  const leads = extractLeads({
    findings: [{ objectiveId: "o1", url: "https://cursor.com/x", claim: "Cursor 宣布涨价，专业版将于2026年生效。", quote: "", round: 1 }],
    round: 1,
    issued: ["Cursor 价格调整 生效日期 2026"],
    goal: SCENARIO_GOAL,
    entities: ["Cursor"],
  });
  assert.deepEqual(leads, []);
});

// ── The assist ──────────────────────────────────────────────────────────────

const ASSIST_INPUT: AuditAssistInput = {
  userId: "u",
  goal: SCENARIO_GOAL,
  objectives: [{ id: "o1", question: "What does each cost?", missing: ["seat licence price"] }],
  findings: [
    { index: 1, objectiveId: "o1", claim: "Each licence is 19 USD a month.", quote: "19 USD", url: "https://a.example" },
    { index: 2, objectiveId: "o1", claim: "Cursor is popular.", quote: "popular", url: "https://b.example" },
  ],
  issued: [],
};

test("the assist's answer is held to the rules: known metrics, findings with figures, sane leads", () => {
  const parsed = parseAuditAssist(
    JSON.stringify({
      confirmed: [
        { objective: "o1", metric: "seat licence price", finding: 1 },
        { objective: "o1", metric: "seat licence price", finding: 2 }, // no figure
        { objective: "o1", metric: "something invented", finding: 1 }, // not a reported gap
        { objective: "o9", metric: "seat licence price", finding: 1 }, // unknown vector
      ],
      leads: [
        { objective: "o1", query: "Cursor Ultra plan limits", signal: "new tier", finding: 2 },
        { objective: "o1", query: "x", signal: "noise", finding: 2 },
        { objective: "o1", query: "Cursor something", signal: "y", finding: 99 },
      ],
    }),
    ASSIST_INPUT
  );
  assert.deepEqual(parsed.confirmed, [{ objectiveId: "o1", metric: "seat licence price", finding: 1 }]);
  assert.deepEqual(parsed.leads.map((lead) => lead.query), ["Cursor Ultra plan limits"]);
  assert.deepEqual(parseAuditAssist("not json at all", ASSIST_INPUT), { confirmed: [], leads: [] });
  // Findings are wrapped as untrusted data in the prompt.
  const prompt = auditAssistPrompt(ASSIST_INPUT, (label, body) => `<<${label}>>${body}<</${label}>>`);
  assert.match(prompt, /<<research findings>>\[1\] \(o1\) Each licence is 19 USD a month\./);
  assert.match(prompt, /missing figures: "seat licence price"/);
});

test("the assist is only asked when there is something ambiguous to read", () => {
  assert.equal(shouldAssist(ASSIST_INPUT), true);
  assert.equal(shouldAssist({ ...ASSIST_INPUT, objectives: [{ id: "o1", question: "q", missing: [] }] }), false);
  assert.equal(
    shouldAssist({ objectives: [{ id: "o1", question: "q", missing: [] }], findings: [{ index: 1, objectiveId: "o1", claim: "Le service sera arrêté pour les clients en mars.", quote: "", url: "" }] }),
    true,
    "a French finding is worth a multilingual read"
  );
  assert.equal(shouldAssist({ ...ASSIST_INPUT, findings: [] }), false);
});

test("end to end: the assist runs at most once per round, its confirmations persist and its leads reach the next round", async () => {
  const { store, events } = memoryStore();
  const { deps } = scenarioDeps(store);
  const calls: AuditAssistInput[] = [];
  const engine = createResearchEngine({
    ...deps,
    async auditAssist(input) {
      calls.push(input);
      const gap = input.objectives.find((item) => item.missing.includes("annual discount"));
      const withFigure = input.findings.find((finding) => finding.objectiveId === gap?.id && /\d/.test(finding.claim));
      return {
        confirmed: gap && withFigure ? [{ objectiveId: gap.id, metric: "annual discount", finding: withFigure.index }] : [],
        leads: input.findings[0] ? [{ objectiveId: input.findings[0].objectiveId ?? "", query: "Cursor Business SSO enforcement changelog", signal: "terms", finding: input.findings[0].index }] : [],
        costMicroUsd: 300,
      };
    },
  });
  const run = await engine.start({ userId: "u", goal: SCENARIO_GOAL, confirmation: "auto", effort: "standard" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.state, "completed", String(done?.error));
  const plan = parsePlan(done?.plan);
  const rounds = plan.rounds?.length ?? 0;
  assert.ok(calls.length >= 1 && calls.length <= rounds, `${calls.length} assist calls over ${rounds} rounds`);
  if (plan.gapAudit?.confirmed?.length) {
    assert.ok(plan.gapAudit.entries.every((entry) => !entry.missingFigures.includes("annual discount") || entry.objectiveId !== plan.gapAudit!.confirmed![0]!.objectiveId));
  }
  const reviewed = events.filter((event) => event.kind === "round_reviewed").map((event) => event.payload as { assisted?: unknown; leads?: Array<{ query: string }> });
  assert.ok(reviewed.some((payload) => payload.assisted), "the round records that it was assisted");
  assert.ok(reviewed.some((payload) => payload.leads?.some((lead) => lead.query === "Cursor Business SSO enforcement changelog")), "the model's lead joined the round's leads");
  assert.ok(events.some((event) => event.kind === "spend_recorded" && (event.payload as { step?: string }).step === "review"), "the assist was billed");
});
