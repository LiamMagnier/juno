# Parallel upgrade: product experience (web, macOS, iOS)

Owner of this file: the product, design and frontend workstream. The backend,
runtime, contracts, persistence, authorization and infrastructure belong to
the ChatGPT/Codex workstream, whose notes go in `ENGINEERING.md` beside this
file. **`ENGINEERING.md` did not exist on any branch on 27 Nov 2026**, so every
backend item below is a proposal, not an agreed contract.

Branch: `claude/awesome-bardeen-uv5uih`, from `ce0c4b4` (main's head on 27 Nov 2026).

## 0. Where this pass stands, plainly

The brief asks for a full refoundation across three platforms. The repository
is not a blank slate: it carries an owner-approved direction ("Graphite",
`docs/design/direction-2026-11/DIRECTION.md`, approved 31 Oct), a token
pipeline that generates the Swift palette and motion, nine native design
gates, a measured web audit (15 Nov) and a working attention model on the web
(Activity: needs you / running / ready / blocked). Rebuilding over that would
throw away decisions the owner already made. This pass therefore:

1. measured the current product (screenshots, axe-core WCAG 2.2 AA, layout
   probes, native static gates) instead of trusting earlier audits;
2. researched the current competitor interfaces (section 3);
3. fixed the defects the measurements found, at the system level where the
   system allowed it (a token role, a transition token, one read per render);
4. wrote down what the backend must provide for the larger experiences
   (section 6), so neither workstream invents a contract alone.

What it did **not** do: the large new surfaces in the brief (Work progress
panel redesign, subagent inspector, Orbit rooms, the cloud computer viewer on
the phone, the Code multi-agent board). Section 8 lists them in priority
order with what each needs. No mocked or fixture activity was added anywhere.

**Name.** The brief says Juno; the shipping product name is **Alevr**
(`src/lib/brand/names.ts`, decisions D-035..D-038). Juno remains the
repository, storage-key and bundle name. This pass keeps Alevr in the
interface. Changing it is one string, but it is the owner's decision.

## 1. Design decisions

| # | Decision | Why |
|---|---|---|
| D1 | Keep the Graphite direction and its tokens; add no new token library. | Owner-approved; generated into Swift; a second system would fork the platforms. |
| D2 | Fix contrast with the existing role `muted-on-fill`, not by darkening `muted-foreground` everywhere. | The role exists for text on fills (4.9:1 in both themes, `tests/wave2-p1-contrast.test.ts`). Darkening muted text globally to 40.5% L would also have passed, but it changes every quiet line in the product to fix three call sites. |
| D3 | Reduce Motion removes travel inside the transition token (`junoPage(reducesTravel:)`, `junoOverlay(reducesTravel:)`), not at call sites. | The tokens attach their own animation, which overrides a caller's reduced curve, so call-site fixes silently did nothing. The token is the only place the fix holds. |
| D4 | Loops stop under Reduce Motion; a spinner holds still rather than disappearing. | Matches the web's three tiers (opacity stays, travel collapses, loops stop). The row's label still says "working". |
| D5 | Haptics fire on the person's tap, not on server confirmation. | Haptics confirm the person's own action; the card's visual state is what reports the server's answer. |
| D6 | Phone controls: keep a small visual where the design calls for it, give it a 44pt target; full-width stacked rows become 44pt themselves. | A hidden hit pad on stacked rows would overlap the neighbouring row. |
| D7 | Text containers on iOS take `minHeight`, not `height`. | Identical at the default size; grows instead of clipping at accessibility sizes. |
| D8 | Code's repository strip hangs from the composer card; the tools row sits below it. | The strip's own CSS (border-top 0, bottom corners) is built to attach to the card. Owner may prefer the tools directly under the card; then the strip needs its own top edge. |
| D9 | The chat minimap's 28×14 ticks stay. | WCAG 2.5.8's "equivalent" exception: scrolling and conversation find reach every turn. Recorded, not hidden. |
| D10 | Button outlines at ~1.3:1 are not a WCAG failure. | WCAG 1.4.11 does not require a boundary on a control identified by its text label. Inputs use `--input` (≥3:1). |

## 2. User journeys this pass checked

| Journey | Platform | Evidence | Result |
|---|---|---|---|
| Open the app → Chat home → type | Web 1440/390, light/dark | screenshots, axe | Clean after D2 |
| Open a 1,000-message thread, read, scroll | Web | screenshots, axe | Only the minimap ticks (D9) |
| Open a Code session → composer, strip, tools, switch product | Web | screenshots, unit tests, axe | Strip regression fixed (D8); contrast fixed (D2) |
| Agents empty state → first agent | Web | screenshot | No defect found |
| Activity, Projects, Library, Memory, Settings | Web | screenshots, axe | No violations |
| Approve / deny an action | iPhone | code review | Haptics added (D5) |
| Hear that a reply finished | iPhone (VoiceOver) | code review | Announcement added |
| Stop a reply from a keyboard | iPad | code review | ⌘. added |
| Change page / open palette with Reduce Motion | Mac | code review | Travel removed (D3) |
| Stream a reply in a long thread | iPhone | code review | O(n² log n) per chunk → one read per render |

## 3. Competitor research (27 Nov 2026), in short

Full report with sources: kept out of the repository (scratch), summarised
here. OpenAI, Google and x.ai pages could not be fetched from this environment;
their claims come from search excerpts of first-party pages and need checking.

- **One attention model.** Every strong product converges on Working / Needs
  you / Ready for review / Done / Failed, with "needs you" pinned and the same
  count everywhere (sidebar, title, badge, Live Activity). Alevr's web Activity
  already has this vocabulary; the apps and the sidebar do not all use it.
- **Approvals are action-bound cards** (exact payload; allow once / always,
  scoped / deny; a typed reply declines with feedback). Claude Duet finishes
  the rest of a task and brings the approval back later instead of stalling.
- **Plan, then run**, with an editable plan and a progress chip that opens a
  work panel (steps done / current / planned, files, sources, budget).
- **Transcript density is a setting** (all / hide successful / summary / zen);
  approvals and errors always show.
- **Subagents live in a side panel**; their approvals surface in the parent
  with the child's name; stopping the parent stops the children.
- **Persistent agents**: a named identity whose avatar *is* its status
  (moves only while working), one list of what it owes you, restraint about
  interrupting, only the person marks a task done.
- **Cloud computer**: watch live, explicit Take over / I'm done, no capture
  while the person is in control, credentials through a secure form.
- **Phone as remote control**: pair once, push only for needs-you and done,
  skip pushes while the person is active elsewhere, approve from the
  notification.

## 4. Platform decisions

- **Web**: Next.js; the shared composer shell (Chat and Code), one command
  surface, one floating material. Ratchets in `eslint-rules/` and the
  contrast matrix are the gate.
- **macOS**: native Liquid Glass sidebar and controls (owner override,
  5 Nov 2026); transitions from `JunoMotion`; every Reduce Motion path goes
  through `JunoAccessibilityPreferences.reducesTravel`.
- **iOS**: the web's information architecture, 44pt targets, the house haptic
  vocabulary (`JunoMobileFeedback.swift`), Dynamic Type. No local execution is
  implied: Code on the phone is remote supervision of a Mac or cloud run.

## 5. Changes in this pass

| Commit | Platform | What |
|---|---|---|
| `6fd61e8` | Mac, Code UI | Page and overlay travel removed under Reduce Motion (6 sites, via the token); Code and sidebar spinners stop under Reduce Motion and cap at 60 fps. |
| `38cdf55` | iPhone, both | Approve/deny haptics on chat and Work approval cards; "Response complete, N words." for VoiceOver; iPad ⌘. stops; 7 targets to 44pt; 5 fixed heights to minimums; approval risk glyph 19→13pt; a labelled remove button; native targets ratchet 150→145. |
| `7faaeec` | Web | Code's repository strip hangs from the composer again (regression since `e34a718`, 22 Nov). |
| `42f64e7` | Web | Muted text on the product switch track and selected/hovered Code rows uses `muted-on-fill` (4.24–4.36:1 → ≥4.9:1). |
| `000a5a6` | iPhone | Transcript reads the conversation once per render, not ~6× per row. |
| `f7c0d46` | iPhone, Mac, Code UI | Fourteen remaining scale/slide/rise transitions collapse to a fade under Reduce Motion (`JunoMotion.scaleFrom`, `JunoMotion.shift`, identity for edge moves); the pairing sheet's spring is reduced. |

## 6. Required backend capabilities (proposals for ENGINEERING.md)

None of these is implemented or assumed by this pass. Each names what the
interface needs; the owning workstream decides the shape.

| # | Capability | Needed by | Today |
|---|---|---|---|
| B1 | **One attention state for every unit of work** (chat run, Work task, Code session, research, agent routine): `working \| needs_you \| ready \| done \| failed \| paused`, plus `need` (approval, question, sign-in, budget) and `since`. | Sidebar badges, Activity, Mac Dock badge, iOS tab badge and Live Activity, push. | Web Activity derives it (`src/components/activity/`). The apps and push do not share one field. |
| B2 | **Attention events on the existing stream**, keyed by work id, with a monotonic version. | Live counts without polling (Activity polls every 30s when something waits). | Polling. |
| B3 | **"Continue the rest" while an approval waits**: the run proceeds with work that does not depend on the pending action, and the approval stays open. | Long Work tasks that today stall on one question. | Not present; needs runtime support. |
| B4 | **Subagent tree on the run stream**: parent id, role/name, state, current step, needs-you, cost so far; Steer / Pause / Resume / Top-up / Stop per child, authorised against the parent's permissions. | Subagent side panel on web, Mac and iPhone. | Web Agents tree for Mac-hosted runs; `/api/code/v2/link/[deviceId]/agents` is Planned in the parity ledger; iOS Steer/Pause/Top-up Planned. |
| B5 | **Cloud computer frames** for the apps: `/api/work/runs/[id]/frames/[callId]` (listed Planned in `docs/native/PARITY_MATRIX.md`), plus a takeover state (`agent \| person`) the stream reports, and "no capture while the person controls". | Filmstrip and Take over on Mac and iPhone. | Web has a filmstrip; apps show a still poster. |
| B6 | **Push routing that knows where the person is**: suppress a push when the same account has an active foreground client on the item; carry approve/deny as notification actions bound to the approval receipt. | iPhone remote-control journey. | Not specified. |
| B7 | **Context provenance per answer**: which earlier conversations, files and memories were used, with ids the person may open or exclude (within the existing authorization model). | Cross-conversation context references. | Memory sources exist for chat; not a general provenance list. |

## 7. Integration status

| Area | Web | Mac | iPhone |
|---|---|---|---|
| Attention model (B1) | Activity page | partial | Work tab only |
| Approval card | action-bound, armed verb | equal-weight buttons | prominent Allow once, now with haptics |
| Tasks in chat | yes | ChatWorkRunCard | not yet (parity 0/2) |
| Subagent controls | Agents tree | yes (host) | rows + Stop; Steer/Pause planned |
| Cloud computer | filmstrip, terminal, teach | poster + web handoff | poster + web handoff |
| Reduce Motion | three tiers | fixed this pass (transitions, spinners) | fixed this pass (14 transitions); no ungated scale/move found by the audit remains |
| Dynamic Type | n/a | n/a | text ok; icons fixed-size (see 8) |

## 8. Next, in priority order

1. **iOS icons follow Dynamic Type** (`JunoIconView` draws at a fixed size;
   `JunoBrand.swift:987`). Needs a scaled metric in the view and the cache key.
   Must be compiled and checked in the simulator.
2. **One approval card across platforms**: the web's armed verb, "Not now",
   "Tell Alevr instead"; today three designs (web `approval-card.tsx`, Mac
   `ApprovalCard.swift`, iOS `NativeChatApprovalView.swift`).
3. **iPhone run card in chat** (parity "Tasks in chat" 0/2): move
   `ChatWorkRunCard` into JunoWorkKit and place it by conversation.
4. **Attention badges everywhere** once B1 exists.
5. **Subagent side panel** (B4) and **cloud computer takeover on the apps**
   (B5).
6. **Web performance baseline in a production build**: long-thread scroll,
   INP while streaming, route latency. Not measured in this pass (section 9).

## 9. Test results (27 Nov 2026, this container)

| Check | Result |
|---|---|
| axe-core 4 (WCAG 2.0/2.1/2.2 A+AA), 10 routes × 3 modes, before | 29 pages measured: color-contrast 11 nodes, target-size 60 (minimap ticks, D9). 2 nodes on one page were a dev-server restart artefact. |
| axe, after, Chat home and Code session, light + dark | 0 violations |
| `tests/code-v2-web-workspace.test.ts` | 43/43 pass (one assertion updated for D8) |
| `tests/wave2-p1-contrast.test.ts` | 13/13 pass |
| ESLint on changed web files | clean |
| `tsc --noEmit` (before sub-package installs) | no errors in `src/` or changed files; 64 errors: 63 from sub-packages whose own dependencies were not installed, and one real error, TS7022 in `tests/code-v2-agents-tree.test.ts` (from `f34fe50`), which this pass first misread as environmental. It also failed main's deploy on 24 Nov. Fixed; `tsc --noEmit` now exits 0. |
| CI on this branch (manual dispatch) | `native.yml`: success (the Swift changes build and their tests pass on macOS). `deploy.yml` gates: all passed except the typecheck above, fixed after. |
| `next build` (production, includes the full type check), after `npm ci` in `relay`, `runner/env-server`, `runner/agent-core` and its build, as `deploy.yml` does | passed |
| `npm run native:design:check` | all 9 gates hold; targets 150 → 145 (ratchet locked) |
| `npm run native:sync:check` | 16/16 gates hold |
| Production e2e (`run-prod-e2e.sh`, Chromium): Code workspace v2, keyboard focus, composer submission | 20/21 first run; the one failure was a stale assertion (below). After fixing it: Code workspace v2 6/6. |
| Swift build, Swift tests, simulator, VoiceOver, Dynamic Type | **Not run: no Swift toolchain, Xcode or Apple simulator in this Linux container.** Every native change is static and must pass `native.yml` and a device check before release. |

E2E: the failure was `code-workspace-v2.spec.ts` expecting "Workspace" and
"Tools" group labels in the Code sidebar, which `5b7e3d3` (22 Nov) removed on
purpose. Because it stopped there, the rest of that test (the Agents panel and
the composer row at narrow widths on a session page) had not been running. The
assertion now checks the labels are gone, and the whole test passes. The run
used Chromium 158 (revision 1243, pre-installed) in place of the pinned 1234,
linked under `~/.cache/ms-playwright`; Firefox, WebKit and the 390/1440 wave-2
projects were not run.

## 10. Screenshots

`screenshots/before/` (32 images, dev build, signed-in seeded QA account): 12 routes × 1440 light, 1440 dark, 390 light. Four 1440-dark
captures failed when the dev server restarted (chat home, thread, Code home,
Work); `report.json` lists them. The bottom-left "N" in the before images is
the Next.js dev indicator, not the account avatar; the after images hide it.

`screenshots/after/`: Chat home, Code home and a Code session in the same
three modes.

## 11. Blockers and limits

- No Swift/Xcode/simulator here (section 9).
- `ENGINEERING.md` absent: backend items are proposals (section 6).
- First-party OpenAI, Google and x.ai pages blocked by the network policy;
  those research claims are from search excerpts.
- The repository's e2e runner needs Node 24; this container has Node 22. The
  run used a Node 24 binary from the npm registry via `ALEVR_QA_NODE_BIN`.
- Web performance was not measured in a production build; dev-mode timings
  in `screenshots/*/report.json` are compile-dominated and are not a baseline.
