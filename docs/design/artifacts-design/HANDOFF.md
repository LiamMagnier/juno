# Artifacts & Design audit — handoff (complete 2026-09-24)

**Status (2026-09-24): ALL THREE STEPS ARE DONE.** `05-IMPROVEMENTS.md` was generated with a script (`gen05.py` logic: `04` Appendix B placement over `wip/merge/backlog.clean.json` and `00` §7.1), covering all 101 R-ids and all 33 X-ids. `00-README.md` is written. Nothing below is required to finish. Remaining work is the plan's own phases, starting with R0.
Paused because the user's usage limit was about to run out; they asked every chat to pause without losing anything.
This work touched **docs only**. No product code was changed and nothing was committed to main.
- Everything lives untracked in the main checkout under `docs/design/artifacts-design/`.
- It is also snapshotted to the local branch ref `wip/artifacts-design-audit`: not pushed, not for main, made with commit-tree on a temporary index so there was no checkout.

## The ask (from the user)
1. Run a full audit of Artifacts & Design on the Juno website and macOS.
2. When step 1 is completely done, audit how Claude handles Artifacts & Design and how Figma handles Figma Design: features, UI/UX, motion, and anything that could improve Juno.
3. Merge Artifacts and Design the way Anthropic merged Claude chat, Cowork and Artifacts on 16 Sept 2026 (claude.com/blog/cowork-is-now-claude; TechCrunch 2026-09-16).

## What exists in this folder
| File | What | State |
|---|---|---|
| `00-AUDIT-OVERVIEW.md` | Cross-cutting audit: defects X-01…X-33, fragmentation map, scorecard, merge preconditions | Final (run `wf_4e23b542-7b4`) |
| `01-AUDIT-WEB.md`, `02-AUDIT-MAC.md` | Web and Mac audits | Final |
| `03-COMPETITIVE-AUDIT.md` | Claude and Figma: features, UI/UX, motion, feature matrix, patterns, what not to copy | Final (run `wf_eea9cc9d-38c`). Source-policy scrubbed: nothing rests on the leaked Claude Design prompt, and there are no long verbatim quotes |
| `04-MERGE-PLAN.md` | The merge plan (≈2,150 lines): object model, data model and migrations, IA, routes, unified view with wireframes, AI loop, sharing and governance, motion, Work deliverables, telemetry, dated release train, risks, owner decisions D1…, review log | Final: drafted, red-teamed by two critics, revised (run `wf_7184c904-c30`) |
| `research/*.md` | Nine fact-checked, scrubbed research notes plus `claude-primary-evidence.md` | Final |
| `wip/raw/*.json` | Raw findings and verifier verdicts from step 1 | Record |
| `wip/merge/proposal-*.md`, `wip/merge/backlog.clean.json` | The three competing proposals and the consolidated, scrubbed backlog of 101 items (R-001…) | Inputs to 04/05 |
| `wip/raw-merge/*.json` | Judge scores, red-team issues, scrub reports | Record |

How the merge plan was judged: product and design picked claude-faithful (48 vs object-first 47 vs risk-first 39). Engineering risk picked risk-first (51/39/36). Strategy picked risk-first (43/35/33). The final plan uses risk-first's dated release train as its spine, with the claude-faithful product order and the object-first view and Mac design grafted in (see `04` §0).

## Next steps (the deliverable is complete; these are follow-ups)
1. **Release coordination (owner's call).** R0 is `7243613f` plus this session's `artifacts/r0-size-and-type` (`9161bcbc` X-08, `db3766ab` M11 type immutability, stacked on it). Merge that branch and you get all three commits. Sticky titles need `titleSource` (M0, R1), so they're deferred. The `derivedFrom*` columns (M0a) are deferred too; the link is recoverable from the retired handle `{identifier}~{id tail}`. Three other fix branches are waiting for one releaser: X-02 `499b6afd`, X-03/X-04 `7243613f` and X-01 `b7946ff5`. X-01 also needs a migration deploy. No session has been named releaser; this one isn't.
2. **Mac:** after X-02 lands, rebuild the Mac design editor bundle (`scripts/build-design-editor.mjs`). X-19 is already stale, and X-02 changes the editor's rail breakpoints to container widths (640/896 px). Tell the juno-glass session.
3. Snapshot this folder to `wip/artifacts-design-audit` after any change, and ping the juno-glass session.
4. **Check the X-01 fix against `04`'s preview requirements.** X-01 is fixed on branch `claude/sharp-aryabhata-79fb4b` (commit `b7946ff5`; handoff `docs/security/PREVIEW-ORIGIN-HANDOFF.md`). That fix adds a sandbox shell with its own CSP, egress allowlists, ban propagation, admin takedown and a Report link. It is not merged. Nobody has told that session about these requirements yet. `04` §9.5 and §13.6 add requirements for the preview origin:
   - every preview response carries a CSP `sandbox` header;
   - it refuses a non-iframe `Sec-Fetch-Dest`;
   - it sends `nosniff`;
   - a CI test opens a preview URL top-level;
   - subdomains are keyed HMACs;
   - legacy scripted shares are screened (backfill B11) before public previews turn on;
   - share governance ships in the same release.
5. Owner decisions are listed in `04` §14 (D1…, each with a recommended answer), plus the open questions in `00` §13.

## Related work in other sessions (status at pause)
- **X-03 and X-04** (edit or regenerate deletes artifacts): fixed on branch `claude/agitated-elion-a15fe9`, commit `7243613f`. Not merged or deployed. Session "Stop edit/regenerate from deleting artifacts".
- **X-01** (CSP-dead previews): session "Fix dead script previews under enforcing CSP".
- **X-02** (Canvas design editor remount): fix ready at `499b6afd` on `claude/suspicious-borg-f3e3b4`. It fast-forwards from main `7f92324f`; tests, the full suite and lint pass. Its handoff is `X-02-HANDOFF.md` on that branch. It still needs a signed-in check and a releaser.
- **X-01:** see step 4 above. Branch `claude/sharp-aryabhata-79fb4b` (`b7946ff5`), not deployed. The migration `20260923180000_share_governance` still has to be deployed.
- **Mac Liquid Glass Phase 2 stage 3:** branch `mac/liquid-glass-chat` (worktree juno-glass), commit `2b1049c5`, "Run artifacts, designs and diagrams inline in the Mac transcript". It carries X-11, the regenerate confirm and the Mac preview sandbox. Leave that worktree alone.

## Earlier history of this run
- Workflow 1 was paused once at 10 of 11 areas and resumed from its journal. It finished with 15 areas (four follow-ups added by a completeness critic) and 34 agents. Only 1 of about 630 claims was refuted; the two critical ones (X-01 and X-03) were also re-checked by the lead.
- Workflow 2 used 9 lenses, each researched, then fact-checked, then gap-analysed. It produced 101 recommendations and 76 anti-patterns.

## Findings that affect Mac artifact & design rendering (for Liquid Glass Phase 2)
Also sent to the glass session. X-11 is being addressed on its branch.
- **X-11 (HIGH):** the chat dock and the iPhone inline viewer cannot open any chat-made design, because the tag body is the compact form. Render from the stored row.
- **The glass branch's regenerate on settled answers** widens X-04 exposure until `7243613f` lands.
- **`InlineArtifactCard.swift` is a static tile.** Don't copy the web's live preview, which is itself dead in production.
