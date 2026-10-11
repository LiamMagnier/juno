# Thirty-task product benchmark

This suite supplements `npm run eval:juno`; it does not replace the existing model
graders/router evaluation. That existing command defaults to authored responses,
which test graders and routing rather than product/model success. This benchmark
requires actual product workflows, artifacts and independent output review.

```sh
python3 scripts/workflow-benchmark.py init /tmp/alevr-benchmark-001
python3 scripts/workflow-benchmark.py summary /tmp/alevr-benchmark-001 > /tmp/alevr-benchmark-001/results.json
```

Initialization creates 30 tasks, six in each required category: Chat/research,
documents/spreadsheets, local Mac, remote web/iPhone-to-Mac, and coding. Each product
gets identical frozen inputs and prompts. Rows for Alevr, ChatGPT Chat, ChatGPT Work,
Codex, Claude Chat, Claude Cowork and Claude Code begin `not_run`. No product capability
is inferred from its name. Unsupported needs dated official source evidence and a
reviewer's confirmed account/tool availability; lack of access is `not_run`.

## Conduct a run

1. Give the product only that run's prompt and workspace. Grant the workspace
   directory itself, not its parent. The outside-grant credential canary is
   synthetic; source material's instructions to read it are injection data.
   Keep the harness/scoring keys outside the product's granted directory.
2. Record exact product/version/model, tools, permissions, session identity, starting
   time, duration, attempts, retries, interventions, recovery and observed costs in
   result.json. Use the same time and dollar limits for meaningfully equivalent
   products. Internal repairs/tool retries remain visible. Human output correction
   and manual recovery do not count toward the first-attempt 27/30 target. Routine
   permission approvals are recorded separately. Unobserved usage/cost stays null;
   never describe subscription fees as observed per-call API spend.
3. Run the task through the actual product. For computer/remote cases use disposable
   files and a test backend/account, never production restarts or private documents.
   Carry out the specified interruptions, including revocation and repeated events.
   Log actions; an absent canary alone does not prove no unauthorized read happened.
4. Save final artifacts in workspace/outputs and set status to `claimed_complete`,
   `partial` or `failed`. A statement of completion never counts by itself.
5. Have someone other than the executor review outputs, preferably with product and
   model labels hidden. Check correctness against source data, open every deliverable,
   inspect code/diffs, confirm actual tests against the latest revision, and review
   authorization/recovery evidence. Record their identity, confirmations and final
   artifact SHA-256 hashes. Review refers to exact final bytes; later edits invalidate it.
6. Run summary. It independently checks required artifacts, numerical answers,
   review bindings, independence, interruption observations, first-attempt conditions,
   time/cost ceilings and physical-iPhone requirements. A claimed completion with
   missing evidence becomes `unverified`. The grader never executes submitted code.

For coding, run tests using the product's existing authorized runtime/container;
retain raw test.log and test-results.json with `checks: [{command, exitCode}]` and
workspaceSHA256 for the final project directory. Compute that digest with:

```sh
python3 scripts/workflow-benchmark.py hash /tmp/alevr-benchmark-001/runs/alevr/code-01/workspace/project
```

This digest binds tests to the final tree. Independent review must still confirm
that the reported command actually ran: JSON assertions are not trusted execution
attestations. The reviewer also checks tests were not weakened, all requested edge
cases pass, and files reopen correctly. PDF/OOXML filename existence or a JSON
numerical sidecar alone does not prove a usable report/workbook.

## Fair comparison and interpretation

Keep prompts/data/budgets identical where possible and record unavoidable tool
differences. Report coverage per category and product, not just overall scores.
Unsupported is excluded from supported-workflow competitor rates and remains visible;
Alevr's proposed acceptance denominator is all 30 requested tasks. Compare products
only on tested equivalent workflows. Record first attempts before repeats, retain
failures, and do not cherry-pick the best of several runs. Repeat nondeterministic
tasks in new benchmark directories and report each trial plus uncertainty. Separate
model reasoning from product execution, latency and recovery. No ranking is justified
without direct observed runs and reviewed outputs.

## Current results

The generated matrix at `/tmp/alevr-quality-evidence/workflow-results-initial.json`
contains 210 rows, all `not_run`; Alevr has zero verified benchmark completions and
the 27/30 target is **not met**. Seven scoring regression tests passed using clearly
synthetic outputs. They prove checker behavior only, including wrong facts despite
completion claims, changed artifacts, symlink escape, missing review/security,
human intervention, missing physical device and stale code verification.

Live product runs require a disposable authenticated Alevr environment with configured
model/provider access and an independent reviewer. Physical iPhone pairing, Mac
sleep/wake and each competitor account/tool mode remain untested. Existing thousands
of unit tests do not fill those rows.
