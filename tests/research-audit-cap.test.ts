import test from "node:test";
import assert from "node:assert/strict";
import {
  extractClaims,
  repairReportFromClaims,
  resolveClaimStatus,
  type LinkVerdict,
} from "@/lib/research/claim-analysis";
import { createResearchEngine } from "@/lib/research/engine";
import { memoryStore } from "./fixtures/research-store";
import { USABLE_REPORT, reworkDeps } from "./fixtures/research-deps";
import { readSource } from "./fixtures/server-only-graph";

/*
 * B4 / B22: claims past the judge's cap were marked "unsupported", the report
 * was rewritten to say the evidence failed, and a paid revision followed —
 * about claims nobody had checked. Now: no verdict because of the cap is
 * `unverified`; nothing unverified is rewritten; and with nothing rewritten
 * there is no revision. The cap itself is the run's own `judgeCalls`.
 */

test("no verdict because the judge's cap was reached is unverified, never unsupported", () => {
  assert.deepEqual(resolveClaimStatus([], { judgeCapReached: true }), { status: "unverified", supportStrength: null });
  // A claim with no candidate passages at all is still unsupported: nothing supports it.
  assert.deepEqual(resolveClaimStatus([]), { status: "unsupported", supportStrength: 0 });
  const verdict: LinkVerdict = { status: "supported", stance: "supports", strength: 0.9, label: "supported", reasons: [], degraded: false };
  assert.equal(resolveClaimStatus([verdict], { judgeCapReached: true }).status, "supported", "the flag only speaks when nothing was judged");
});

test("an unverified claim is never rewritten, so the audit reports no repair", () => {
  const report =
    "# Report\n\nThe scheme cost taxpayers £2.7 billion in 2023 [1].\n\nThe programme was cancelled by the ministry in March 2024 [2].";
  const claims = extractClaims(report);
  assert.ok(claims.length >= 2);
  const repaired = repairReportFromClaims(
    report,
    claims.map((claim) => ({ ...claim, status: "unverified" as const, supportStrength: null }))
  );
  assert.equal(repaired.repaired, false);
  assert.equal(repaired.report, report);

  // An unsupported one still is — the audit's whole point.
  const mixed = repairReportFromClaims(report, [
    { ...claims[0], status: "unverified", supportStrength: null },
    { ...claims[1], status: "unsupported", supportStrength: 0.1 },
  ]);
  assert.equal(mixed.repaired, true);
  assert.equal(mixed.repairedClaims, 1);
  assert.doesNotMatch(mixed.report, /Unverified:/);
});

test("an audit whose only gaps are unchecked claims completes with no paid revision", async () => {
  const { store } = memoryStore();
  let writes = 0;
  const base = reworkDeps(store);
  const engine = createResearchEngine({
    ...base,
    async synthesize(input) {
      writes += 1;
      return base.synthesize!(input);
    },
    async validateReport({ report }) {
      return {
        report,
        repaired: false,
        summary: { claims: 30, supported: 12, partiallySupported: 0, unsupported: 0, contradicted: 0, unverified: 18, duplicateSources: 0 },
      };
    },
  });
  const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.state, "completed");
  assert.equal(writes, 1, "no revision for claims nobody checked");
  assert.equal(done?.report, USABLE_REPORT);
});

test("the audit's cap is the run's judgeCalls and its claim cap the scope's targetClaims (B22)", () => {
  const claims = readSource("src/lib/research/claims.ts");
  assert.match(claims, /const judgeCap = Math\.max\(1, Math\.floor\(opts\.maxJudgeCalls \?\? MAX_JUDGE_CALLS\)\);/);
  assert.match(claims, /if \(!settledByText && judgeCalls >= judgeCap\) \{\n\s+judgeCapReached = verdicts\.length === 0;/);
  assert.match(claims, /resolveClaimStatus\(verdicts, \{ judgeCapReached \}\)/);
  assert.match(claims, /claimsForAudit\(extractClaims\(opts\.report\), Math\.max\(1, Math\.floor\(opts\.maxClaims \?\? MAX_CLAIMS\)\)\)/);
  const run = readSource("src/lib/research/run.ts");
  assert.match(run, /maxJudgeCalls: plan\.envelope\?\.judgeCalls/);
  assert.match(run, /maxClaims: plan\.scope \? targetClaimsFor\(plan\.scope\.questions\) : undefined/);
});
