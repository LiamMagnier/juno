# Internal audit: Deep Research — UI, UX and motion (web)

Branch `web/tools-thinking-research`, worktree `juno-tools`, read at `d0997af2` (2026-09-23).
Read-only audit. Every claim below cites the file and line it was read from; where a
behaviour was inferred from code rather than observed in a browser it is marked
**(inferred)**. No dev server was started, and there is no dev gallery that renders
any research component, so nothing here was verified visually (see §9).

---

## 0. Summary

Research on web is a per-message tool in the composer. It goes through three client
surfaces that were designed at different times and do not agree with each other:

1. the **composer** (arming, depth chip, scoping questions), which a later chat turn
   treats as an ordinary chat;
2. a **card in the transcript** (`ResearchRunPanel`) that is by turns a plan form, a
   live console and a report cover;
3. a **modal dialog** (`ReportDialog` → `ReportReader`) that holds the finished report.

The right-hand dock, which the rest of chat uses for "how this answer was made", plays
no part in research after the plan: it shows only the planning turn, labelled
"Thinking".

The ten problems that matter most for the redesign:

| # | Problem | Where |
|---|---------|-------|
| 1 | **Steering is dead once the plan is approved.** The composer's "Add to the research" mode needs `isBusy` (a chat stream in progress) or `standalone`, and research passes neither. After Start, the run works in the background with no chat stream, so the composer is an ordinary chat box. `docs/research-workspace.md:34` says the opposite. | `composer.tsx:1232-1236`, `chat-view.tsx:1806-1822` |
| 2 | **Stop on an unrelated reply cancels the paid research run.** While a run is working, `onStop` is bound to "cancel research + stop stream". If the person sends any follow-up and presses Stop on that answer, the research is cancelled too. | `chat-view.tsx:1787-1792` |
| 3 | **Nothing from the finished report appears in the thread on web.** The Start button path writes the report in the background with the research lead model. No assistant message is written, so the thread still reads "Here's the research plan…" above a report cover. Reading a single finding takes a click into a modal. | `plan/route.ts:53-55`, `run.ts:589-601`, `tools.ts:655-670`, `route.ts:2837-2839` |
| 4 | **Two different completions for one feature.** Pressing Start gives a background run, the lead model, a recap card and a dialog. Typing "yes" with research re-armed gives an in-chat stream, the user's model, a chat answer, a canvas artifact, the sources pill and the audit panel. | `deep-research.ts:273-277` vs `plan/route.ts:53-55` |
| 5 | **Depth ("Quick/Standard/Deep/Max") is derived silently and shown as jargon.** The tier changes the team 12×, pages 24× and the wall clock 12× (`domain.ts:1026-1073`) according to the model and thinking effort. Juno then shows it as a bare word on a chip, and the report is still written by a different model than the one picked. | `auto-effort.ts:35-46`, `composer.tsx:2512-2527`, `effort-copy.ts:28-33` |
| 6 | **The live card hides the interesting part.** Sources arriving, what each researcher is reading and findings with quotes all sit two or three disclosures down. The visible layer is a stage rail that barely moves, plus a slot-machine line of six numbers. | `research-console.tsx:147-207` |
| 7 | **The composer offers research where the server will refuse it or drop it silently.** It ignores `features.deepResearch`, the plan tier and project workspace permissions. In a project that disallows research, the flag is dropped with no notice at all. | `composer.tsx:764`, `app-data.ts:192`, `route.ts:2093-2095` |
| 8 | **The report reader is a modal with half-built export.** "Share" copies the current chat URL. Download is `.md` only, named `juno-deep-research-DATE.md`. The model-written "## Sources" section is not stripped, so sources appear twice. The recap never shows the report's title on web because the parser only reads artifact titles. | `report-reader.tsx:218,236`, `report-dialog.tsx:56-59` |
| 9 | **Numbers disagree with each other.** The console and its Steps header give two different "sources read" totals. The recap duration includes time parked at the plan gate. "Round N of 4" is hard-coded while tiers run 1–3 rounds. The shield is green while the headline lists partial or unverified claims. | see §8 |
| 10 | **Motion is careful but has no identity and sits in the wrong places.** Stage changes cut with no motion, the live→done swap is a hard cut with a layout jump, and a dozen pulse rings loop at once with worker lines re-animating on every poll. The one moment that deserves motion, completion, has none. | `run-spine.tsx:33-43`, `research-run-panel.tsx:71-109`, `run-timeline.tsx:686-705` |

The engineering underneath is good and worth keeping: the durable run, the event log with
cursors, `workingElapsedMs`, the null-is-not-zero evidence rules, the provider roster and
the plan contract. The problem is the product surface on top of them.

---

## 1. Files read

| Area | File | Lines | Role |
|---|---|---|---|
| Research UI | `src/components/research/research-console.tsx` | 211 | Live card: header, spine, fact line, 4-tab disclosure |
| | `src/components/research/run-controls.tsx` | 698 | `PlanOutline`, `ClarifyGate`, `PlanReview`, `FocusList` |
| | `src/components/research/run-timeline.tsx` | 863 | Event log → steps (search groups, worker lanes, notes) |
| | `src/components/research/run-spine.tsx` | 45 | 4-stage rail |
| | `src/components/research/research-recap.tsx` | 226 | Finished-run cover |
| | `src/components/research/source-rail.tsx` | 162 | Publisher chips (recap) |
| | `src/components/research/source-deck.tsx` | 172 | Read / lead lists |
| | `src/components/research/evidence-panel.tsx` | 296 | Objective bars, provenance mix, conflicts |
| | `src/components/research/report-dialog.tsx` | 111 | Modal wrapper, artifact extraction, title |
| | `src/components/research/report-reader.tsx` | 424 | Document: toolbar, ToC, prose, sources rail |
| | `src/components/research/effort-copy.ts` | 49 | Tier labels (Quick/Standard/Deep/Max) + summaries |
| | `src/components/research/run-format.ts` / `run-clock.ts` | 52 / 61 | $ formatting, durations, working clock |
| | `src/components/research/use-research-run.ts` | 364 | Per-run poller (2.5 s / 8 s), POST helper |
| | `src/components/research/use-conversation-run.ts` | 85 | Run discovery (4 s, forever), steering verbs |
| Chat wiring | `src/components/chat/research-run-panel.tsx` | 132 | Router: live → Console, terminal → Recap + Dialog |
| | `src/components/chat/chat-view.tsx` | 2589 | Hook ownership, composer steering/stop, inline runs |
| | `src/components/chat/message-list.tsx` | ~420 | Places inline runs after the originating turn |
| | `src/components/chat/message-item.tsx`, `activity-timeline.tsx`, `thought-process-*.tsx` | — | What the planning turn shows |
| Composer | `src/components/chat/composer.tsx` | 3737 | Arm, derive depth, marks, + menu, slash/@, steer mode |
| | `src/components/ui/composer-shell.tsx` | — | `ComposerArmedMark` (the "Deep research · Standard" chip) |
| | `src/components/chat/composer-plus-menu.tsx` | — | Toggle row rendering |
| | `src/components/chat/composer-clarification-popover.tsx` | 524 | Scoping questions (shared with ordinary chat) |
| | `src/hooks/use-chat.ts` | — | Research preflight (8 s budget), park flag through clarification |
| Server (read for UI truth) | `src/app/api/chat/route.ts`, `src/lib/deep-research.ts`, `src/lib/research/{domain,run,engine,tools,corpus,auto-effort}.ts`, `src/app/api/research/**` | — | States, notices, who writes the report, polling payload |
| Surfaces | `src/app/(app)/research/page.tsx`, `research/[id]/page.tsx`, `projects/[id]/page.tsx`, `src/components/landing/features.tsx`, `src/components/chat/starter-chips.tsx` | — | Entry points |
| Native | `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeResearchEffort.swift`, `native/iOS/JunoMobile/App/JunoMobileResearchProgress.swift`, `native/macOS/JunoDesktop/App/DesktopComposer.swift`, `DesktopChatWorkspace.swift`, `DesktopSearchScreen.swift`, `Localizable.xcstrings` | — | Level names and mirrors |
| Docs | `docs/research-workspace.md`, `docs/JUNO.md:728-747` | — | Stated intent (partly contradicted, §8) |

---

## 2. Architecture as it affects the UI

```
                    ┌──────────────────────────── chat-view.tsx ────────────────────────────┐
 composer.tsx       │ useConversationResearch(convId)  ← GET /api/research?conversationId=  │
  research flag ────┤   every 4 s, forever (use-conversation-run.ts:57)                      │
  + derived tier    │   └─ useResearchRun(newestRunId) ← GET /api/research/:id?after=cursor  │
  → chat.send(...)  │        2.5 s while working / 8 s idle; stops when terminal + caught up │
                    │ steering = { accepting, steer(), stop() }  → Composer.steering/onStop  │
                    │ inlineRuns = [newest → ResearchRunPanel, older → Historical…Panel]     │
                    └────────────────────────────────────────────────────────────────────────┘
                                         │ placed by createdAt after the turn that asked
                                         ▼ (message-list.tsx:119-127)
             ResearchRunPanel (router)
               live  ─► ResearchConsole ─┬─ awaiting_clarification → ClarifyGate   (REST-started runs only)
                                         ├─ awaiting_plan_confirmation → PlanReview (web chat always)
                                         └─ otherwise → RunSpine + facts + [tabs: Activity|Sources|Plan|Evidence]
               terminal ─► ResearchRecap ── "Read the full report" ─► ReportDialog ─► ReportReader
```

**Two server paths feed the same card** (`deep-research.ts:261-289`, `plan/route.ts:53-55`):

| Path | Trigger | Who drives | Who writes the report | What the thread gets |
|---|---|---|---|---|
| A. **Button (default on web)** | Plan card → *Start researching* → `POST /plan {confirm}` | `driveResearchInBackground` with the **full** engine | `writeResearchReport` on `researchPlannerModel()` = the configured **lead** model (`tools.ts:127-133, 660-670`) | Nothing. The plan-notice message stays; the card becomes a recap. |
| B. **Typed reply** | Re-arm research, type "yes/ok/go ahead…" (`deep-research.ts:116-117, 273-277`) | The chat request, gathering-only engine, `until: "synthesizing"` | The **user's selected model**, streamed, under `RESEARCH_OUTPUT_CONTRACT` (100–200-word answer + artifact) | A full assistant turn: chat answer, canvas artifact, sources pill and citation audit panel. The card also runs live beside it. |

The notice copy never says how to start, so path B is reachable only by accident
(`route.ts:2837-2839`: *"Here's the research plan. You can edit the steps or add sources
before I start."*).

**States → what the card draws** (`domain.ts:29-114`, `research-console.tsx:128-208`):

| State | Stage (`domain.ts:329-347`) | Header | Body |
|---|---|---|---|
| `accepted` | plan | goal (serif) + "Getting ready" | spine (Plan current) + facts |
| `clarifying` | plan | goal + "Working out what the question leaves open" | spine + facts |
| `awaiting_clarification` | plan | "Before Juno starts" + status | `ClarifyGate` (not reachable from web chat: the gathering engine has no clarifier, `run.ts:653-666`) |
| `planning` | plan | goal + "Working out what to look up" | spine + facts ("0 sources read") |
| `awaiting_plan_confirmation` | plan | "Your research plan" + "Waiting for you to confirm the plan" | `PlanReview` |
| `investigating` | investigate | goal + "Researchers are searching and reading" | spine + facts + disclosure |
| `reviewing` | review | "Reviewing what the researchers found" | same |
| `synthesizing` | write | "Writing the report" | same |
| `validating_citations` | write | "Checking every citation against its source" | same |
| `paused` | **investigate** (whatever stage it paused in) | "Paused" | same; pause icon swaps to play |
| `awaiting_user_input` | investigate | "Waiting for your answer" | same, with **no input anywhere**. The state is never entered (no writer in `src/`), so it is vestigial. |
| `completed` / `partially_completed` / `failed` / `cancelled` | done | — | `ResearchRecap` |

---

## 3. The user journey, screen by screen

### J0. Entry points

| Entry | What happens | File |
|---|---|---|
| **+ menu → "Deep research"** (checkmark row in the "armed for this message" group) | Toggles the per-send flag. While on, the row shows the derived depth word as `detail`. | `composer.tsx:2828-2842, 2954` |
| **`/research`** in the slash palette | Same toggle. Hint: "Deep-research the next message". | `composer.tsx:1675-1687` |
| **`@research`** mention | Same toggle. Its `else` branch toasts "Deep research is available on paid plans." and can never run, because the row only exists when `researchAvailable`. | `composer.tsx:1755-1770` |
| URL **`/research`** | Redirects to `/chat?research=1` and arms the composer. | `app/(app)/research/page.tsx:2`, `chat-view.tsx:1776` |
| URL **`/research/:id`** | Redirects to `/chat/:conv?researchRun=:id`, or `/chat?researchRun=:id` for runs with no conversation. | `research/[id]/page.tsx:9` |
| **Project page composer** with research armed | Navigates to `/chat?project=…&q=…&research=1&reasoning=…` and auto-sends. Attachments and skill are dropped. The composer shows research even when the project's workspace disallows it, and the server then drops the flag silently. | `projects/[id]/page.tsx:461-473, 853-858`; `route.ts:2093-2095` |
| **Empty-state "Research" starter chip** | Seeds an example prompt without arming research, although it wears the research telescope glyph. | `starter-chips.tsx:54-61` |
| Landing page card "Deep Research" | Marketing copy: "Approve the search plan, follow source coverage live, steer the run…". Steering is not reachable on web (bug #1). | `landing/features.tsx:53-57` |

There is **no research library or history destination** on web. `/research` is a redirect.
`GET /api/research` lists 20 runs (`api/research/route.ts:36`), but its only consumer is the
per-conversation discovery poll.

### J1. Arming — the chip and the derived depth

```
S1 · Composer, research armed (desktop, composer ≥ 30rem)
┌──────────────────────────────────────────────────────────────────────────┐
│ ┌──────────────────────────────┐                                         │
│ │ 🔭 Deep research · Standard ✕│ What does the latest evidence say ab…  │  ← mark at the head of
│ └──────────────────────────────┘                                         │    the field; NO placeholder
│                                                                          │    while a mark is present
│  (+)   [ Claude Sonnet 4.x ▾ ]                              (🎙)  ( ↑ )  │    (composer.tsx:3522-3535)
└──────────────────────────────────────────────────────────────────────────┘
  hover the label ▸ tooltip:
  ┌─────────────────────────────────────────────────────────┐
  │ 4 researchers · up to 80 pages. Depth follows your model │
  │ and thinking effort. Pick a stronger model or raise      │
  │ thinking for a deeper run.                               │
  └─────────────────────────────────────────────────────────┘

S1b · Same on a phone / narrow composer (< 30rem): the "· Standard" detail is dropped
┌──────────────────────────────────────┐
│ [🔭 Deep research ✕] What does th…   │
│ (+) [Model ▾]            (🎙) ( ↑ )  │
└──────────────────────────────────────┘

S2 · + menu (third group)
┌───────────────────────────────────────┐
│ 📎 Add files or photos           ⌘U   │
│ 🖼 Take a screenshot                  │
│ 📚 Add from library                   │
│ ───────────────────────────────────── │
│ 📁 Add to project                  ›  │
│ 🔌 Connectors                   2  ›  │
│ ───────────────────────────────────── │
│ ✦ Use a skill                      ›  │
│ 🔭 Deep research        Standard  ✓   │  ← depth word only while ON (composer.tsx:2836-2840)
│ 🌐 Web search                     ✓   │
│ 🧠 Memory                         ✓   │
└───────────────────────────────────────┘
```

- **Depth is not chosen.** `researchEffortFor` adds the model's cost tier (1–3) to a
  thinking rung (0–3) and one more for Pro, then maps the score (≥6 max, ≥4 deep, ≥2
  standard) (`auto-effort.ts:35-46`). Nothing on the chip says that turning thinking
  from "high" to "max" also changes research from 30 minutes / 320 pages to 60 minutes /
  480 pages under the same $8 ceiling (`deep-research.ts:87-91`).
- The tooltip lists team and pages but not time, and the plan card later states time
  ("about 15 min").
- `RESEARCH_EFFORT_COPY.note` ("A focused pass for a narrow question", …) is defined and
  never rendered (`effort-copy.ts:28-33, 42`).
- Research does **not** switch off web search. The chip and "Web search ✓" can both show
  while the server replaces native search with research (`route.ts:2099`).
- The Tooltip wraps a button that opens the + menu. Pressing the mark opens the whole
  menu, not a research-specific control.

### J2. Send → "checking" → scoping questions

1. `use-chat.ts:1399-1433`: a research send runs the **preflight triage** in research mode
   with an **8 s** client timeout. The primary button shows the `checking` face (a
   spinner) and the field is disabled (`composer.tsx:3521`). There is no copy saying why.
2. `RESEARCH_TRIAGE_SYSTEM` defaults to **asking** (`preflight-triage.ts:139-152`), so most
   research sends stop here.

```
S3 · Scoping popover (the same component as ordinary chat clarifications)
          ┌─────────────────────────────────────────────────────────┐
          │ QUESTION 1 OF 3 · Scope of the report               ✕   │  mono micro eyebrow
          │ A couple of details will shape the report.              │
          │ ▬▬▬▬▬▬ ▭▭▭▭▭▭ ▭▭▭▭▭▭                                    │  segmented progress
          │                                                         │
          │ Which period should it cover?                           │
          │  ① Last 12 months                                       │
          │  ② Since 2020                                           │
          │  ③ All available evidence                               │
          │  [ Or type your own answer… ]                           │
          │                                                         │
          │ Use your judgment               [← Back]  [ Next → ]    │
          └──────────────────────────▽──────────────────────────────┘
          ┌─────────────────────────────────────────────────────────┐
          │ (composer, placeholder: "Or type your own answer…")     │
          └─────────────────────────────────────────────────────────┘
```

- **Nothing in the popover says it is a research step.** Same shell, same eyebrow and
  same "Use your judgment" as an ordinary clarification (`composer-clarification-popover.tsx:224-259`).
- Free-plan users and unconfigured deployments answer all the scoping questions and are
  **then** told research is unavailable (`route.ts:2845-2853`), because the composer
  never consults `features.deepResearch` or the plan (§8 #4).
- A second, different clarify UI exists for the same idea: `ClarifyGate`
  (`run-controls.tsx:263-373`). It has free-text fields plus suggestion chips, an
  "Optional" tag, and "Start researching / Skip and research as written". It only appears
  for REST-started runs, so web users never see it.

### J3. The planning turn (the one moment research uses the chat stream)

The chat route calls `runDeepResearch`. The run goes `accepted → clarifying (skip) →
planning → awaiting_plan_confirmation` and the drive returns. The route then streams the
application-authored notice as the assistant message (`route.ts:2837-2842, 2941-2942`).

```
S4 · Transcript during planning (~10–60 s)
  ┌───────────────────────────────────────────────┐
  │                   What does the latest …  (you)│
  └───────────────────────────────────────────────┘
  ⣿ Thinking · 23s                                   ← activity strip: says "Thinking" the whole time.
                                                       liveCopy() ignores reasoning-kind titles such as
                                                       "Working out what to look up" /
                                                       "Planned the research: 4 questions"
                                                       (activity-timeline.tsx:53-94)
  ┌─ research card (appears ≤4 s after the run exists; discovery poll) ─────────┐
  │ What does the latest evidence say about intermittent fasting?        ❚❚  ■  │
  │ Working out what to look up                                                 │
  │ ●───────────○───────────○───────────○                                       │
  │ Plan        Investigate  Review      Write                                  │
  │ 0:18 · $0.03 of $8.00 · 0 sources read                                      │
  │ ─────────────────────────────────────────────────────────────────────────── │
  │ View research activity                                                   ⌄  │
  └─────────────────────────────────────────────────────────────────────────────┘
```

So two live indicators run at once, one saying "Thinking" and the other "Working out what
to look up", with two clocks that disagree: the strip's run clock versus the card's
working clock.

### J4. The plan gate

```
S5 · Plan gate (after the turn ends). Thread order: user → notice message → card
  Here's the research plan. You can edit the steps or add sources before I start.   ← assistant msg
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │ Your research plan                                                          │ text-ui medium
  │ Waiting for you to confirm the plan                                         │ caption, role=status
  │                                                                             │
  │ Here's how Juno will research this. Adjust anything before it starts.       │ lede
  │ What does the latest evidence say about intermittent fasting?               │ goal (clamp 2)
  │                                                                             │
  │ APPROACH                                                                    │ mono eyebrows
  │ Prioritise meta-analyses and RCTs from 2020 on; weigh …                     │
  │                                                                             │
  │ QUESTIONS TO ANSWER                                                         │
  │ (1) What do RCTs show for weight loss vs caloric restriction?               │
  │     Why it matters …                                                        │
  │     [2 independent sources] [primary source] [fresh · last 5 years]         │ mono chips
  │ (2) …                                                                       │
  │                                                                             │
  │ HOW THE WORK WILL RUN                                                       │
  │ 1  [ Search meta-analyses of time-restricted eating …           ]           │ editable textareas
  │ 2  [ …                                                           ]           │ (no add/remove/reorder)
  │                                                                             │
  │ A COMPLETE ANSWER INCLUDES                                                  │
  │ ✓ Effect sizes with confidence intervals                                    │
  │ WHERE EVIDENCE MAY BE THIN                                                  │
  │ • Long-term (>2 yr) outcomes                                                │
  │                                                                             │
  │ [ Start researching ]   Cancel research                                     │
  │ 8 researchers · up to 320 pages · about 15 min · Stops at $8.00             │ caption
  │ ─────────────────────────────────────────────────────────────────────────── │
  │ Show the searches 14                                                     ⌄  │
  │ ─────────────────────────────────────────────────────────────────────────── │
  │ Set focus and sources                                                    ⌄  │
  └─────────────────────────────────────────────────────────────────────────────┘
```

- Four statements of one fact precede the plan: the assistant notice, "Your research
  plan", the status line, and the lede.
- The card commonly runs **800–1,200 px** tall inside the transcript. Start sits
  mid-card with two disclosures below it, and is not sticky.
- Only the **steps** and the hidden **queries** can be edited. Objectives, approach,
  criteria and risks are read-only by design (`run-controls.tsx:221-234`). Steps cannot
  be added, removed or reordered; blanking one removes it on confirm.
- The evidence chips are machine vocabulary in mono ("fresh · last 5 years", "1 source").
- The **section eyebrows are `font-mono text-label`** (`run-controls.tsx:87`). The same
  directory removed exactly this voice elsewhere "because nothing in this product is set
  in full caps / mono as heading" (`run-timeline.tsx:775-778`, `report-reader.tsx:325-327`).
- Typing into the composer does not interact with the plan. An ordinary message cancels
  the parked plan only if research is re-armed (`deep-research.ts:281-285`). Without
  research armed, the plan stays parked and the message is answered normally.

### J5. The live console

```
S6 · Live, collapsed (the default after Start)
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │ What does the latest evidence say about intermittent fasting?        ❚❚  ■  │ serif title + icons
  │ Researchers are searching and reading                                       │ status (role=status)
  │                                                                             │
  │ ✓───────────●───────────○───────────○                                       │ RunSpine
  │ Plan        Investigate  Review      Write                                  │
  │ 14 queries  18 found ·   —                                                  │ yields (@sm container)
  │             7 read                                                          │
  │ 4m 12s · $0.42 of $8.00 · 12 sources read · 5 of 8 researchers working ·    │ fact line, wraps
  │ 14 findings · nature.com                                                    │ (3 RollingNumbers)
  │ ─────────────────────────────────────────────────────────────────────────── │
  │ View research activity                                                   ⌄  │
  └─────────────────────────────────────────────────────────────────────────────┘

S7 · Live, expanded → Activity tab (the default tab)
  │ View research activity → "Hide research details"                         ⌃  │
  │ Activity   Sources   Plan   Evidence                                        │ aria-pressed buttons
  │ ─────────                                                                   │
  │ Steps  3 searches · 45 sources read · 8 researchers                      ⌃  │ ← 2nd disclosure;
  │ ⚠ No indexed search provider is configured. This run could only …          │   note "45" ≠ "12" above
  │ + 4 earlier steps not shown                                                 │
  │ 🔍 Searched "intermittent fasting meta-analysis 2024"          24 results   │ WebSearchBlock
  │    brave 12 · tavily 18 · searxng key missing or rejected 401               │ EngineStrip
  │ (◌1) What do RCTs show for weight loss…                        3 findings   │ WorkerLane, pulse ring
  │      Reading · nejm.org                                                     │ re-animates each poll
  │ (◌2) …                                                                      │
  │ (✓3) Long-term outcomes                                        1 finding    │
  │      Found two cohort studies beyond 2 years…                               │
  │ • Lead review: another round                                          42s   │ NoteRow
  │   9 findings · gaps on long-term adherence                                  │
  │ • Following an evidence gap                                                 │
  │   Round 2 of 4 · adherence intermittent fasting 24 months                   │ ← "of 4" hard-coded
```

Tabs:

- **Sources** shows `SourceDeck`: "Read sources N" then "Found leads N — Discovered, not
  yet read", six rows each, favicon + host + title + type/date footer.
- **Plan** shows `PlanOutline`, the same component as the gate, read-only. Its staggered
  rise-in replays on every tab switch.
- **Evidence** shows `EvidencePanel`. Per objective: a round badge, the question, a 1 px
  bar coloured **amber while unanswered** (`evidence-panel.tsx:200`) and "3 sources · 2
  independent". Below that, "Where the evidence comes from" as a stacked bar with a
  legend, then up to four conflicts, the rest silently dropped.

**Controls on the live card:** pause ⇄ play (icon swap) and stop (square). **Stop is one
click with no confirmation and cannot be undone** on a run that may have spent dollars
and minutes (`research-console.tsx:141`). "Stop and write the report with what you have"
is not offered: cancel means no report (`research-recap.tsx:184`).

**Steering:** see §8 #1. After Start the composer is an ordinary chat box. The only
remaining controls are the two icons.

### J6. Completion → recap

The router swaps `ResearchConsole` for `ResearchRecap` in one render
(`research-run-panel.tsx:71-109`). Nothing marks the moment: no transition, no toast, no
tab-title change, and no browser notification. The only completion signal anywhere is
APNs to iOS (`engine.ts:1438-1448`).

```
S8 · Recap (report cover)
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │ ✓ Research complete                              12 min · $3.87   ✕         │
  │                                                                             │
  │ What does the latest evidence say about intermittent fasting?               │ ← always the GOAL on
  │                                                                             │   web (see §8 #6)
  │ 34 sources read · 61 found · 4/5 objectives answered                        │
  │ ─────────────────────────────────────────────────────────────────────────── │
  │ [◉ nejm.org ● ↗] [◉ bmj.com (3) ● ↗] [◉ nature.com ↗] … +23 more            │ SourceRail
  │ [ 61 sources · 34 read ]                                                    │
  │                                                                             │
  │ 🛡 22/26 claims supported · 2 partly supported · 2 not checked               │ shield is GREEN here
  │                                                                             │
  │ [ Read the full report → ]                                                  │ secondary button
  │ ─────────────────────────────────────────────────────────────────────────── │
  │ Inspect methodology & sources ⌄                                             │
  └─────────────────────────────────────────────────────────────────────────────┘
```

- The cover holds **no content from the report**: no summary, no key findings, no
  answer. On path A nothing in the thread answers the question the person asked.
- The **duration counts the wait at the plan gate** (`createdAt → finishedAt`,
  `run-format.ts:27-37`). A plan approved the next morning reads "14h 3m" on a run that
  worked for 12 minutes. `run-clock.ts` exists to prevent exactly this on the live card.
- ✕ "Hide this research receipt" hides a paid report. The hide is only in React state and
  comes back on reload, with no undo (`research-run-panel.tsx:56,64,90`).
- "61 sources · 34 read" opens the methodology drawer, which shows Evidence first, not the
  sources (`research-recap.tsx:162`).
- A partially completed run with a report shows the report cover in amber. A cancelled
  run shows the word "Cancelled" (hard-coded, `research-recap.tsx:110`) and "This run
  stopped before it wrote a report." There is no Resume, Retry, "Write with what you
  have" or "Research again".
- The **methodology drawer** on a run with no sources says "Sources appear here as the
  research finds them" (`source-deck.tsx:28-29`), the live tense on a finished run.
  `SourceRail`'s empty state says "Harvesting sources from the web…" (`source-rail.tsx:21`)
  although its own comment says it only mounts for finished runs.

### J7. Reading the report (modal)

```
S9 · ReportDialog at ≥ xl (max-w min(96rem, 100vw-2rem))
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│ Deep research report · 4,812 words · ~22 min read · 34 sources read   [⧉ Copy][⤓ Export .md][🖶 Print][⇪]   ✕ │
│ ─────────────────────────────────────────────────────────────────────────────────────────────── │
│ Contents          │  Intermittent Fasting: What the Evidence Shows (h3, from "# Title")  │ Sources read · 34  ⇥ │
│ ▌Intermittent F…  │  Executive Summary                                                   │ 1 ◉ Title…           │
│  Executive Summ…  │  Time-restricted eating produces weight loss comparable to …[1][4]   │   nejm.org           │
│  Key Findings …   │  …                                                                   │ 2 ◉ …                │
│   Weight loss     │  Sources                                    ← model-written list     │ …                    │
│  Limitations …    │  [1] Title — https://…                         (duplicate of rail)   │                      │
│  Sources          │  [2] …                                                               │                      │
└───────────────────────────────────────────────────────────────────────────────────────────────┘

S10 · Same dialog on a phone (375 pt): 1rem inset card, p-5 pr-14 → ~267 pt text measure
┌─────────────────────────────────┐
│ Deep research report ·        ✕ │
│ 4,812 words · ~22 min read ·    │
│ 34 sources read                 │
│ [⧉ Copy] [⤓ Export .md]         │
│ [🖶 Print] [⇪]                  │
│ ─────────────────────────────── │
│ On this page                  ⌄ │
│ ─────────────────────────────── │
│ Intermittent Fasting:     │     │ ← 56 pt right gutter reserved for
│ What the Evidence         │     │   the close button on every line
│ Shows                     │     │
│ …                         │     │
│ Sources  [1] … [2] …      │     │
│ ─────────────────────────       │
│ Sources read · 34               │ ← the same list again
└─────────────────────────────────┘
```

- **Modal, not a document.** The person cannot read the report beside the conversation,
  select a passage and ask about it, or keep it open while typing a follow-up. There is
  no URL for the report: "Share" (`⇪`, tooltip "Copy page link (sign-in required)")
  copies `window.location.href`, which is the chat (`report-reader.tsx:233-242`).
- **Export** is Markdown only, named `juno-deep-research-YYYY-MM-DD.md`
  (`report-reader.tsx:218`). There is no PDF other than the browser print dialog, and no
  DOCX or Google Docs export. Copy copies raw Markdown with `[n]` markers.
- **Sources appear twice or three times.** The writer is told to end with "## Sources"
  (`corpus.ts:214`). `message-item.tsx:407` has `stripTrailingSourcesSection` for exactly
  this case, but the reader never uses it. Result: model list + sticky rail (≥xl) or
  model list + "Sources read · N" section (<xl).
- The **citation audit is not in the reader**. Claim-level verdicts exist
  (`citation-audit-panel.tsx`, used under chat messages on path B), but on path A the
  audit appears only as one sentence on the cover.
- **Findings with verbatim quotes** (`ResearchFinding`, the team's evidence ledger,
  `docs/research-workspace.md:138-145`) are not shown anywhere. The only trace is the
  count "14 findings".
- The ToC includes the report's own title as its first entry, and "Sources" as its last.
- Word count counts Markdown syntax and the source list (`report-reader.tsx:195-199`).
- The toolbar title says "Deep research report" as a hard-coded string (a naming issue, §4).

### J8. Follow-ups

- Follow-up chips are hidden while the run is live (`chat-view.tsx:473`). Once it
  finishes they are fetched for the last assistant message, which on path A is the
  **plan notice**. So the suggestions are **(inferred)** about the plan, not the report
  (`follow-up-suggestions.tsx:39-44`).
- The finished report is injected as untrusted context into later turns
  (`route.ts:2777-2791`). Nothing in the UI says so: no "Ask about this report" or
  "Using report as context" chip, and no quote-to-ask from the reader.
- The report seeds sources into the next turn (`route.ts:2789`), so the next answer's
  `[n]` chips point into the report's corpus. The person has no way to tell.

### J9. Revisits and history

- Discovery returns up to 20 runs per conversation. The newest drives the steering hook,
  and each older run mounts `HistoricalResearchRunPanel` with **its own poller**, each
  fetching up to 200 events and every source on open (`chat-view.tsx:2263`,
  `research-run-panel.tsx:129-132`).
- Deep link `?researchRun=` selects a run but does not scroll to it or open its report.

### J10. Native (for later mirroring)

- iOS `JunoMobileResearchProgress` shows "Deep research is on · Max" plus a summary
  line, a **five**-stage rail (Plan · Search · Read · Check · Write), and the live search
  block (`JunoMobileResearchProgress.swift:74-106`). Web has four stages
  (Plan · Investigate · Review · Write) and `RESEARCH_STAGE_LABEL` has a third set
  ("Planning / Gathering sources / Analyzing evidence / Synthesizing report"), which is
  unused.
- `NativeResearchEffort.summary` numbers are **stale** against the server tiers:

  | Tier | Native (`NativeResearchEffort.swift:39-44`) | Server (`domain.ts:1026-1073` → `effort-copy.ts`) |
  |---|---|---|
  | quick | 1 researcher · up to 40 pages · ~2 min | 1 researcher · up to 20 pages · ~3 min |
  | standard | 3 · 120 · ~5 min | 4 · 80 · ~6 min |
  | deep | 5 · 220 · ~10 min | 8 · 320 · ~15 min |
  | max | 8 · 320 · ~15 min | 12 · 480 · ~30 min |

- macOS has a plain "Deep research" toggle with no depth shown (`DesktopComposer.swift:731-733`),
  a `GroupBox("Research activity")` in chat (`DesktopChatWorkspace.swift:1954-1965`) and a
  research status bar in Search (`DesktopSearchScreen.swift:263-330`).

---

## 4. Every place a level name, or "Deep", appears

The user asked for the level names to go. They appear in three layers: user-visible
copy, internal vocabulary, and model-facing prompts.

### 4.1 Level names "Quick / Standard / Deep / Max" as **research depth**

| Where | What | Visible? |
|---|---|---|
| `src/components/research/effort-copy.ts:28-33` | `LABELS` source of truth: Quick/Standard/Deep/Max plus unused `note` sentences | source |
| `src/components/research/effort-copy.ts:34-49` | `RESEARCH_EFFORT_COPY` (label, summary "N researchers · up to P pages", eta) and `researchEffortLabel()` | source |
| `src/components/chat/composer.tsx:2512-2527` | Armed mark: `label: "Deep research"`, `detail: researchEffortLabel(...)` → "Deep research · Standard"; tooltip with summary; `openLabel` "Deep research on, Standard depth. Depth follows…" (screen reader) | **yes** (detail hidden < 30rem) |
| `src/components/chat/composer.tsx:2828-2842` | + menu row `detail: research ? researchEffortLabel(...)` | **yes** |
| `src/components/research/run-controls.tsx:469-473` | Plan gate "authorised" line uses `tier.summary` + eta (numbers, no level word) | yes (numbers) |
| `src/components/ui/composer-shell.tsx:308-318` | Prop docs mention "Max" and `RESEARCH_EFFORT_COPY` | comment |
| `src/app/dev/controls/gallery.tsx:203` | Fixture: `detail: research ? "Standard" : undefined` | dev only |
| `src/lib/research/domain.ts:965-1110` | `RESEARCH_EFFORTS = ["quick","standard","deep","max"]`, `RESEARCH_TIERS`, `DEFAULT_RESEARCH_EFFORT`, `budgetForEffort` | internal |
| `src/lib/research/auto-effort.ts:35-46` | Derivation to the four names | internal |
| `src/lib/chat/request.ts:114-116`, `src/types/chat.ts:421-422`, `src/hooks/use-chat.ts:103-104,1225-1226,1308,1457-1458,1605`, `src/lib/preflight-clarification.ts:48` | `researchEffort?: "quick" \| "standard" \| "deep" \| "max"` on the wire | API |
| `src/app/api/research/protocol.ts` (`startResearchSchema.effort`) | REST start accepts an effort | API |
| `src/lib/deep-research.ts:227-228, 267` | "The depth the composer asked for. Deep when it did not say." `effort ?? "deep"` | internal |
| `docs/JUNO.md:735-738`, `docs/research-workspace.md:155-162` | Documents tiers by name | docs |
| `tests/research-auto-effort.test.ts`, `tests/research-agents.test.ts` | Tier names in tests | tests |
| **i18n catalog** `src/lib/i18n-catalog.generated.ts` | **Not in the repo.** It is generated at predev/prebuild and gitignored (`.gitignore`, `scripts/generate-i18n-catalog.mjs:9`). The extractor harvests `label:` literals, so "Quick", "Standard", "Deep" and "Max" do enter the catalog. `note:` is not a copy property, so the notes do not. Composed summaries (template literals) are not extractable at all. | generated |
| **Native** `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeResearchEffort.swift:26-45` | `String(localized: "Quick"/"Standard"/"Deep"/"Max")` plus stale summaries and notes | **yes (iOS)** |
| `native/iOS/JunoMobile/App/JunoMobileResearchProgress.swift:74-106` | "Deep research is on · {depth.label}" plus `depth.summary` | **yes (iOS)** |
| `native/iOS/JunoMobile/App/JunoMobileComposer.swift:151-158, 296` | Derives and passes depth | internal |
| `native/Packages/JunoNativeKit/Tests/JunoChatKitTests/NativeResearchEffortTests.swift` | Tests | tests |

Not research depth, and **not to be touched** by this rename: plan names "Max ×5 / Max ×10"
(`plans.ts:96,123`, `upgrade/page.tsx:213`, `legal/cgu`, `landing/pricing.tsx`), the
thinking-effort rung "Max" (`settings/sections/models.tsx:24`, `model-metrics.ts:878`,
`reasoning-slider.tsx`, `NativeThinkingScale.swift:76`), model names "Qwen3.8 Max", and
learning blocks "Quick check" / "Deep dive". Settings and billing have **no** research-depth
copy. Research is never mentioned in plan or pricing copy. Availability is gated server-side
on `PLANS[plan].webSearch` (`plans.ts:56,80,…`).

### 4.2 "Deep" in the **feature name** ("Deep research")

If the redesign renames the feature to "Research" (Claude's name), these are the strings:

| Where | String | Audience |
|---|---|---|
| `composer.tsx:2457-2462` | armed summary "deep research" (+ trigger aria-label) | SR |
| `composer.tsx:2516, 2524-2525` | "Deep research", "Deep research on, … depth…", "Turn off deep research" | UI/SR |
| `composer.tsx:2833` | + menu row "Deep research" | UI |
| `composer.tsx:1681, 1761` | "Deep-research the next message" | UI |
| `composer.tsx:1768` | "Deep research is available on paid plans." (dead branch) | UI |
| `research-console.tsx:125` | `aria-label="Deep research"` | SR |
| `research-recap.tsx:39` | `kicker: "Deep research report"` (aria-label) | SR |
| `report-reader.tsx:257` | toolbar "Deep research report" | UI |
| `report-reader.tsx:218` | filename `juno-deep-research-…md` | file |
| `projects/[id]/page.tsx:112` | workspace tool "Deep research" | UI |
| `landing/features.tsx:54` | "Deep Research" | marketing |
| `app/api/chat/route.ts:2847-2852` | notices "Deep research is not configured…", "…available on paid Juno plans…", activity "Deep research was skipped" / "…isn't available on this plan right now." | UI (streamed) |
| `app/api/research/route.ts:54` | "Deep research is available on a paid Juno plan." | API error |
| `lib/research/engine.ts:1443` | APNs title fallback "Deep Research" | push |
| `lib/research/corpus.ts:204` | "# Autonomous Deep Research Mode" | **model-facing** |
| `lib/preflight-triage.ts:139` | "You are the scoping step for Juno's Deep Research…" | **model-facing** |
| `app/dev/glyphs/gallery.tsx:212`, `app/dev/controls/gallery.tsx:203,860` | fixtures | dev |
| iOS `Localizable.xcstrings`: `composer.deep-research` "Deep research", `research.enabled` "Deep research is on", `research.title` "Deep research" | | iOS |
| macOS `DesktopComposer.swift:732`, `ProjectWorkspaceStore.swift:57` "Deep research" | | macOS |

---

## 5. What the right-hand panel shows during research

The right side of chat is `@container/split` (`chat-view.tsx:1978-1989`) with two docked
columns: the **canvas** (artifacts) and the **thought panel** (`ThoughtProcessPanel`,
portalled from the message's `ActivityTimeline`). Neither is research-aware after the plan.

| Moment | Right dock | Evidence |
|---|---|---|
| Composer armed, scoping questions | nothing | — |
| Planning turn streaming | If opened from the strip: header "Thinking" and steps "Working out what to look up", "Planned the research: N questions" (approach as detail), "Waiting for you to confirm the plan", "Research plan ready". No **Research** phase, because that phase needs `Searching the web` events (`thought-process-model.tsx:371-449`) and planning issues none. | `thought-process-panel.tsx:648-654` |
| After the turn settles | The strip **unmounts** once settled, since there is no reasoning, searches or tool calls (`activity-timeline.tsx:240`), so the planning steps vanish from the transcript. If the dock was open it keeps the settled panel until closed. | |
| Plan gate / investigating / reviewing / writing (path A) | **Nothing.** The background run never touches the message or the dock. All live information is in the inline card. | `plan/route.ts:53-55` |
| Report ready (path A) | Nothing. The report opens in a **modal**, not the canvas. | `research-run-panel.tsx:110-123` |
| Path B (typed "yes") | The thought panel shows a proper **Research** phase ("Researching", searches, "Reading source" rows, "Research corpus ready"), and the report opens as a **canvas artifact** on the right. | `deep-research.ts:129-219`, `route.ts:220-241` |
| `ContextInspector` (`components/app/context-inspector.tsx`) | Has a `mode === "research"` branch with Activity / Artifacts / Plan tabs, and **no consumers**. Dead code. | grep: no imports |

**In short:** during research on web the right dock is empty or stale. The product's best
real estate for a multi-minute job, a live side panel, is unused, while a 4-tab console is
folded into a transcript card. This is the reverse of ChatGPT (activity sidebar on the
right) and Claude (research process and report open to the side).

---

## 6. Critique

### 6.1 Information architecture and hierarchy

- **Three disclosure levels to see a worker.** Card → "View research activity" →
  Activity tab (default) → "Steps" (open by default when live, `run-timeline.tsx:744`).
  Watching live work is the reason people wait on this feature, and it is hidden by
  default. The comment at `research-console.tsx:31-33` says the disclosure opens on
  Activity "because a live run's question is 'is it doing anything'". The answer is then
  folded behind a toggle.
- **The visible layer is the least informative.** The spine sits on "Investigate" for
  most of the run, and the yields under it are hidden on narrow containers. The fact line
  is six caption-sized facts that wrap to two or three lines. The one fact that says what
  is happening now (`nature.com`) comes last and is the one that truncates
  (`research-console.tsx:148-177`).
- **Money is foregrounded** from the first second ("$0.00 of $8.00" during planning),
  yet the plan gate is the only place a person consents to spend, and there it is a
  caption under the button.
- **No answer in the thread (path A).** The recap is a cover with no content. Every
  comparable product puts at least a summary where the question was asked. Juno's own
  `RESEARCH_OUTPUT_CONTRACT` (`route.ts:203-241`) argues for this, and it is only used on
  path B.
- **The plan card is a document inside a document.** Six sections, two disclosures and a
  mid-card primary action, stacked in the transcript between the notice above and
  whatever comes next.
- **Findings are the product's best asset and they are invisible.** Every worker finding
  is "a claim plus a verbatim quote that must appear on the page"
  (`docs/research-workspace.md:138-141`). The UI reduces them to a count.
- **Evidence tab semantics.** An unanswered objective has an amber bar
  (`evidence-panel.tsx:200`). This contradicts the file's own rule 3, "weaker is not
  worse" (lines 35-39), and reads as an error while the run is simply early.
  `partially_covered` and `blocked` render the same as `open`.
- **The recap numbers point three ways.** "34 sources read · 61 found · 4/5 objectives
  answered", then the rail button "61 sources · 34 read", then the audit "22/26 claims
  supported". That is three denominators in three phrasings.

### 6.2 What is confusing

1. "Here's the research plan…" as an assistant **message**, followed by a card that says
   it again. After completion the message is still there, above a report cover.
2. The depth word changes when the model or thinking changes, with nothing saying why,
   and it does not name the model that will write the report (the lead model on path A).
3. "Thinking · 23s" while Juno is planning research.
4. Two scoping UIs (popover vs `ClarifyGate`) and two completion paths (button vs typed
   "yes").
5. Stop on the composer means different things depending on whether a research worker is
   running in the background (bug #2).
6. The recap's ✕ hides the report until reload.
7. "Share" copies a private chat link.

### 6.3 Missing, compared with a great research product

(Behavioural references: ChatGPT Deep Research and Claude Research as publicly documented,
see `docs/research-workspace.md:11-17`. The detailed external audit belongs in the sibling
external report.)

| Capability | ChatGPT DR / Claude Research (public behaviour) | Juno web today |
|---|---|---|
| One tool name, no tiers exposed | "Deep research" / "Research", with no depth word in the UI | "Deep research · Standard/Deep/Max" chip |
| Clarify, then plan | Clarifying questions in chat, then the run (ChatGPT also shows an editable plan) | Popover plus a long plan card with limited editing |
| Live progress people want to watch | Activity sidebar / process panel with narrated steps and sources streaming in | Folded console; right dock idle |
| Mid-run steering | Update or interrupt the run with new instructions | API exists; UI dead after Start (#1) |
| "Finish now" | Stop and write from what was gathered | Stop = cancel, no report |
| Completion signal | Notification; thread updates | None on web |
| Answer in the thread | Report / summary delivered into the conversation | Cover card only (path A) |
| Report as a document | Full-screen or side document, ToC, citations with source previews, export (PDF/DOCX/MD), share | Modal; MD only; share = chat URL |
| Citations you can verify | Hover shows the source and passage | `[n]` chips with title/host only (`clientSources` snippet `""`, `report-reader.tsx:69-72`); audit verdicts not in the reader |
| History | Reports findable later | No research list; only per-conversation cards |
| Mobile | Report readable on a phone | Modal with a 56 pt dead gutter (S10) |

### 6.4 Visual quality

- The card vocabulary is consistent (`research-surface` = `rounded-card border bg-card
  p-4 sm:p-5`, `globals.css:3685`) but generic: a bordered box like every other card.
  Research has **no visual identity** and no sense of scale. A 45-minute, 12-researcher
  job looks the same as a tool result.
- The **type voices are mixed**: serif title, sans status, mono eyebrows in the plan,
  mono micro badges on worker lanes (`run-timeline.tsx:693`), mono chips on evidence
  requirements, mono "Optional" on clarify. That contradicts the directory's own register
  rules.
- **The spine** is 16 px dots with a 1 px line (`run-spine.tsx:36-41`). "Current" and
  "done" are both solid accent fills, told apart only by a check glyph. The current step
  has no motion or ring, so a working stage and a finished one look alike.
- **Iconography:** pause and stop are bare 16 px glyphs in 36 px hit targets with no
  label. Stop is a filled-square glyph that people who don't know media controls may not
  recognise as "cancel".
- **Source rail chips** mix two signals, a green "read" dot (colour-only, `title` for
  meaning, `source-rail.tsx:93`) and an ↗ glyph, plus a separate count button.
- The **evidence bars** are 4 px tall (`h-1`) with a 4% minimum fill; at card width they
  read as hairlines.

### 6.5 Motion

| Moment | Today | Assessment |
|---|---|---|
| Card appears | `research-enter` → `research-arrive` 4 px rise on `--dur-exit` (`globals.css:3706-3711`) | Fine but anonymous; it arrives up to 4 s late (discovery poll) and pops into a transcript the reader may be scrolled in |
| Stage advances | **No transition at all** on dot fill or line colour (`run-spine.tsx:36-38`) | Misses the one progress beat a watcher waits for |
| Live → done | Console unmounts, recap mounts in the same frame (`research-run-panel.tsx:71-109`); recap has no entrance | Hard cut and layout jump (expanded console is taller than the recap); expanded state is lost |
| Gate sections | `PlanSection` staggered `rise-in` (from below); `ClarifyGate` / field rows use `research-detail-in` (**from above**, `translateY(-4px)`, `globals.css:1026-1035`) | Two opposite directions for "content arrives" in the same card |
| Tab switch | keyed body replays `research-arrive`; the Plan tab also replays its staggered sections every time | Acceptable, but the stagger on repeat is noise |
| Worker lanes | `motion-safe:animate-pulse-ring` infinite ring per working lane (`run-timeline.tsx:688`); the action line is **re-keyed on every tool call** and replays `research-detail-in` (`run-timeline.tsx:703-705`) | With 8–12 workers and a 2.5 s poll: up to 12 rings looping and a burst of line entrances every poll, which is the "slot machine" the console comment warns about (`research-console.tsx:155-163`) |
| Fact counters | 3 `RollingNumber`s (`research-console.tsx:164-174`) plus a ticking clock plus a detail that changes each poll | Busy; the roll is nice in isolation |
| Search groups | `WebSearchBlock` keyed with `isLast`, so a new step **remounts** the previous group shut with no fold (`run-timeline.tsx:833`) | Content jumps on every query |
| Disclosures | `Collapse` (grid-rows 0fr→1fr + fade, symmetric curve) and `inert` during fold | Good; keep |
| Evidence bars | `transform: scaleX` with `duration-slow` (`evidence-panel.tsx:196-203`) | Good technique |
| Completion | None: no settle, no success moment, no document "coming together" | The biggest missed moment |
| Report open | Dialog `animate-modal-in` (pop), sources rail `fade-in` | Generic modal; no continuity from the cover to the document (no shared-element or morph) |

There is no signature "researching" motion. Research uses the same 3×3 thinking matrix
("Thinking") as any reply during planning, then no ambient motion at all while the real
work runs.

### 6.6 Reduced motion

Mostly well guarded: `motion-safe:` on entrances and pulse rings, `motion-reduce:transition-none`
on transitions, `RollingNumber` renders plain digits (`micro.tsx:216-224`), `Collapse` snaps
(`collapse.tsx:52-53`), `jumpTo` uses `auto` scroll (`report-reader.tsx:141-142`), and the
unlayered kill-list covers shimmer (`globals.css:3746-3755`). Gaps:

- Under reduced motion the live card becomes **completely static**. Nothing replaces the
  pulse ring or the roll as a "still working" signal (e.g. a non-moving "Updated 3 s ago"
  or a state word). The working clock is the only cue, and it hides when the run parks.
- The stagger delays (`staggerDelay`) still apply opacity sequencing through
  `animation-fill-mode: backwards` on `motion-safe:` only, which is fine. But
  `animate-fade-in-up` on `FocusList` items (`run-controls.tsx:654`) is also only
  `motion-safe`, so that one is fine too.

### 6.7 Mobile

- The **plan card** on a phone is a long scroll inside the transcript, with the composer
  dock covering its bottom and Start mid-card.
- **RunSpine** labels at ~75 px per column ("Investigate" is ~70 px at 14 px). The
  `@sm:` yields resolve against the **split container** (the whole chat area), not the
  card (`run-spine.tsx:42`; the only `@container` ancestor is `chat-view.tsx:1989`), so
  they show on most phones in four cramped columns **(inferred)**.
- **Report dialog** (S10): a centred card with `pr-14` reserves the close button's gutter
  on every line (`report-dialog.tsx:105`), giving roughly a 267 pt measure on a 375 pt
  phone. Two nested scroll containers (the `DialogContent` base has `overflow-y-auto`,
  `dialog.tsx:81`, and the inner div too). Four toolbar buttons wrap to two rows. It
  should be a full-screen sheet on phones.
- Touch targets: `coarse:size-11` on icons (good). Recap dismiss is `size-7 coarse:size-11` (good).
  The `SourceRail` chip links are ~24 px tall (`py-1`) with no coarse bump.

### 6.8 Accessibility

- **Focus loss on every gate transition.** Pressing *Start researching* disables the
  button (busy), then the gate unmounts and the console renders the spine. Focus falls to
  `<body>` (`research-console.tsx:146`). The same happens with the clarify gate's submit
  and the live→recap swap when focus is on pause or stop.
- **Tabs are not tabs**: a `nav` of buttons with `aria-pressed`, a region labelled with
  the raw id ("activity"), and no arrow-key roving (`research-console.tsx:192-200`).
- **The spine** exposes `aria-current="step"` but not "completed" for done steps (check
  glyphs are `aria-hidden`).
- **The read state is colour and title only** on `SourceRail` (`source-rail.tsx:93`);
  `SourceDeck` dims unread favicons to 60% (`source-deck.tsx:49`).
- **Stop** has no confirmation and no "run cancelled — undo" affordance.
- **Status announcements:** `role="status"` on the state sentence is right. The fact line
  is not live (right). Worker lanes are not announced (right). On completion the
  console's status node unmounts, so completion is never announced **(inferred)**.
- The report dialog's accessible name is sr-only `Research report — {goal}`, which is
  good, and print styles are handled.
- `ClarifyGate`: Enter in any field submits the whole gate (`run-controls.tsx:313-318`).
  That is intended, but it surprises people answering question 1 of 3. A question with
  `skippable: false` gets no "Needed" label (`CLARIFY_COPY.needed` is unused,
  `run-controls.tsx:240, 299-303`).

### 6.9 Dark mode

Everything uses semantic tokens (`bg-card`, `border-border`, `text-success-ink`,
`text-warning-foreground`, the ink ramps in `tailwind.config.ts:461-489`), so both themes are
coherent. Two risks:

- The **provenance bar** uses `bg-primary` at 100/70/45/25% and `bg-border` for
  unclassified (`evidence-panel.tsx:78-84`). On the dark ground, 25% primary and the
  border token are close, so the last two segments merge.
- **Amber everywhere means "early"**, not "problem": the evidence bars, conflict boxes
  (`bg-warning/[0.06]`) and engine warnings. In dark mode `--warning-foreground` is a
  bright 72% L (`globals.css:556`), so the Evidence tab turns loud while a run is simply
  in progress.

### 6.10 Copy and i18n

- Hard-coded, non-extractable strings: "Cancelled" (`research-recap.tsx:110`), toasts in
  `report-reader.tsx:205-241`, the `${n} independent sources` / "1 source" chips
  (`run-controls.tsx:101`), and every composed summary in `effort-copy.ts` (template
  literals, which the extractor cannot see).
- Tier `note`s are neither rendered nor extracted.
- The voice drifts between "Juno" ("Before Juno starts"), "I" ("before I start" in the
  notice), and impersonal ("Researchers are searching").

### 6.11 Performance (felt in the UI)

- **Discovery polls every 4 s forever** for every open conversation, research or not
  (`use-conversation-run.ts:57`), querying up to 20 runs with a `_count` of sources each time.
- **Every run poll loads every source's full page snapshot from Postgres** to compute a
  boolean `read` (`run.ts:398-413` selects `snapshot`; `readResearchRun` calls it on every
  GET, `run.ts:801-808`). A max-tier run holds up to 480 pages, re-read every 2.5 s per
  watching tab. The response also re-sends every source row and the full report each
  poll.
- `useResearchRun` polls `awaiting_clarification` at the working rate (2.5 s), since only
  `paused` and `awaiting_plan_confirmation` count as idle (`use-research-run.ts:297-301`).
- `EvidencePanel`'s `useMemo` depends on `readable`, a new array every render, so the memo
  never hits (`evidence-panel.tsx:137-152`).
- N historical runs mean N pollers, each fetching events from 0 plus all sources on open.

---

## 7. ASCII: current key screens at a glance (flow)

```
 ┌───────────── Composer ─────────────┐     ┌──────── Scoping popover ────────┐
 │ [🔭 Deep research · Deep ✕] prompt │ ──► │ Q1/3 · options · Use judgment    │
 └────────────────────────────────────┘     └──────────────┬───────────────────┘
                                                           ▼  (≤ 8 s "checking" spinner before)
 ┌──────────── Transcript ─────────────────────────────────────────────────────────┐
 │ you: question                                                                   │
 │ ⣿ Thinking · 23s                         ← planning, mislabelled                │
 │ "Here's the research plan. You can edit the steps or add sources before I start."│
 │ ┌ Plan card (800–1200 px) ───────────────────────────────────────────────────┐  │
 │ │ Your research plan / status / lede / goal / APPROACH / QUESTIONS / HOW … / │  │
 │ │ CRITERIA / RISKS / [Start researching] Cancel / authorised line / ⌄ ⌄      │  │
 │ └────────────────────────────────────────────────────────────────────────────┘  │
 │                 │ Start (focus lost)                                            │
 │                 ▼                                                                │
 │ ┌ Live console ───────────────────────────────────────── ❚❚ ■ ┐  right dock:     │
 │ │ goal · state · spine · 6-fact line · [View research activity]│  (nothing)      │
 │ └──────────────────────────────────────────────────────────────┘                 │
 │                 │ terminal (hard cut, no notification)                           │
 │                 ▼                                                                │
 │ ┌ Recap ──────────────────────────────────────────────────── ✕ ┐                 │
 │ │ ✓ Research complete · goal · counts · chips · 🛡 · [Read →]   │ ──► Modal reader│
 │ └──────────────────────────────────────────────────────────────┘                 │
 │ follow-up chips (derived from the plan notice)                                   │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Bugs

Severity reflects user impact. "Verified" means traced end to end in code. "Plausible"
means the code path supports it but it was not observed.

| # | Sev | Bug | Location | Evidence | Status |
|---|---|---|---|---|---|
| 1 | high | **Composer steering never engages after plan approval.** `steerMode` needs `isBusy \|\| steering.standalone`. Research steering passes no `standalone`, and after Start there is no chat stream, so "Add a constraint, or paste a source…" never appears and the typed text becomes a new chat turn. The docs say it works. | `composer.tsx:1232-1236`; `chat-view.tsx:1806-1822`; `docs/research-workspace.md:34`, `landing/features.tsx:56` | `accepting` is true in working states (`use-conversation-run.ts:69`) but the mode also needs `isBusy` | verified |
| 2 | high | **Stopping an unrelated reply cancels the research run.** While a run is `accepting`, `onStop` = `researchSteering.stop(); chat.stop()`. A follow-up sent during the run makes `isBusy` true and the primary face "stop"; pressing it POSTs `/control {cancel}`. | `chat-view.tsx:1787-1792`; `use-conversation-run.ts:80` | the ternary has no check that the streaming turn is the research turn | verified |
| 3 | high | **Research offered where it will be refused or silently dropped.** The composer ignores `features.deepResearch` (`app-data.ts:192`, documented as "gates the composer toggle" at `types/app.ts:140`), the plan's `webSearch`, and the project's `allowedTools`. When the workspace forbids it, `researchRequested` is false and **no notice** is sent, so the answer is plain chat. | `composer.tsx:764`; `route.ts:2093-2095, 2845-2853`; `projects/[id]/page.tsx:461-473` | `researchAvailable = !privateMode && modality === "chat"` | verified |
| 4 | high | **No answer in the thread on the default path.** The background drive writes `run.report` via `writeResearchReport`; no message is persisted; the plan notice remains the turn's text. `tools.ts:655` still claims "Only the standalone research surface uses this". | `plan/route.ts:53-55`; `run.ts:589-601`; `tools.ts:655-670` | no message write in `engine.ts`/`run.ts` (grep) | verified |
| 5 | high | **Two divergent completion paths** (button vs typed confirm with research re-armed): different model, delivery, citation UI and dock behaviour. | `deep-research.ts:273-277`; `route.ts:2818-2836`; `plan/route.ts:53-55` | see §2 | verified |
| 6 | medium | **Recap never shows the report title on path A.** `reportTitle` only reads a `<juno:artifact>` title, and the background writer returns plain Markdown whose title is `# Title`, so the cover always falls back to the goal. | `report-dialog.tsx:36-59`; `research-recap.tsx:74,144`; `corpus.ts:209` | `parseArtifacts` on a plain report returns nothing | verified |
| 7 | medium | **Sources rendered twice in the reader**: the model-written `## Sources` section is not stripped, although `stripTrailingSourcesSection` exists for exactly this. | `report-reader.tsx:371`; `corpus.ts:214`; `message-item.tsx:394-419` | | verified |
| 8 | medium | **"Share" copies the private chat URL**, not a report link; no share mechanism exists. | `report-reader.tsx:233-242, 303-310` | | verified |
| 9 | medium | **Recap duration includes plan-gate and paused time** (`createdAt → finishedAt`), contradicting `run-clock.ts`. | `run-format.ts:27-37`; `research-recap.tsx:72, 120-125` | | verified |
| 10 | medium | **Paused shows the wrong stage.** `paused` (and `awaiting_user_input`) map to `investigate`, so pausing during Write moves the spine back to Investigate. | `domain.ts:341-342`; `run-spine.tsx:33-34` | | verified |
| 11 | medium | **Two "sources read" totals on one card**: the fact line counts `run.sources.filter(read)`, while the Steps header counts group rows marked done **plus** every worker `open_page` (duplicates included). | `research-console.tsx:164`; `run-timeline.tsx:751-753, 471` | | verified |
| 12 | medium | **Focus is lost when a gate resolves** (Start, clarify submit, pause/stop at the live→recap swap): the focused control unmounts. | `research-console.tsx:146-208`; `research-run-panel.tsx:71-109` | no focus management anywhere in the directory | plausible (a11y) |
| 13 | medium | **Stop is one click, irreversible, no confirm and no "finish with what you have".** | `research-console.tsx:141`; `use-conversation-run.ts:80` | | verified (UX) |
| 14 | medium | **Every poll loads every source snapshot** just to set `read`. | `run.ts:398-413`, `run.ts:801-808`; `use-research-run.ts:198` | `select: { snapshot: true }` | verified (perf) |
| 15 | medium | **Discovery polls forever** (4 s) on every open conversation. | `use-conversation-run.ts:43-58` | `finally { setTimeout(discover, 4000) }` | verified (perf) |
| 16 | medium | **Native tier summaries are stale** against the server table (all four tiers wrong). | `NativeResearchEffort.swift:39-44` vs `domain.ts:1026-1073` | table in §J10 | verified |
| 17 | medium | **Planning is labelled "Thinking"**: `liveCopy` ignores reasoning-kind research titles, so the strip says "Thinking" for the whole planning pass. | `activity-timeline.tsx:53-94`; `deep-research.ts:129-144` | | verified |
| 18 | low | **"Round N of 4" hard-coded**; tiers allow 1–3 rounds (the constant is legacy `MAX_FOLLOW_UP_ROUNDS = 4`). | `run-timeline.tsx:69, 395`; `domain.ts:532-533, 1030-1066` | | verified |
| 19 | low | **Green shield with a problems headline**: `auditClean` ignores `partiallySupported` and `unverified`, while `auditHeadline` lists them. | `research-recap.tsx:76, 169`; `citation-audit.tsx:626-636` | | verified |
| 20 | low | **Conflicts silently capped at 4** (the timeline's own rule says truncation must be labelled). | `evidence-panel.tsx:272`; cf. `run-timeline.tsx:132-141` | | verified |
| 21 | low | **Live-tense empty states on finished runs**: "Sources appear here as the research finds them" in the recap drawer; "Harvesting sources from the web…" in the recap rail. | `source-deck.tsx:28-29`, `research-run-panel.tsx:105`; `source-rail.tsx:21, 56-66` | | verified |
| 22 | low | **`formatSpan` can print "1m 60s"** (floor minutes, round seconds) and shows "75m 3s" past an hour; used for timeline step durations. | `lib/run-receipt.ts:52-54`; `run-timeline.tsx:534-539` | 119.6 s → "1m 60s" | verified |
| 23 | low | **Timeline step durations assume one sequential worker** (their own comment). With parallel lanes, a note's duration is the gap to the next *spawn*. | `run-timeline.tsx:516-527` | | verified |
| 24 | low | **Worker action line re-keys on every tool call**, replaying its entrance each poll for every lane. | `run-timeline.tsx:703-705` | | verified (motion) |
| 25 | low | **Search groups snap shut** when a newer step arrives (remount by key, no fold). | `run-timeline.tsx:827-840` | | verified (motion) |
| 26 | low | **Stale error text in the steer toast**: `research.notice` is read from the render closure, so the server message set by `post()` is never shown. | `chat-view.tsx:1815-1817`; `use-research-run.ts:334` | | verified (latent, since #1 blocks the path) |
| 27 | low | **Dead `@research` fallback toast** "available on paid plans" (unreachable). | `composer.tsx:1765-1768` | row only rendered when `researchAvailable` | verified |
| 28 | low | **`PlanReview` query inputs and focus lists stay editable while `busy`.** | `run-controls.tsx:553-562, 671-694` | no `disabled={busy}` | verified |
| 29 | low | **`PlanReview` seeds constraints and sources from props once**; a revised plan (`plan_revised`) under the same `run.id` key keeps the stale drafts. | `run-controls.tsx:408-415`; `research-console.tsx:146` (`key={run.id}`) | | plausible |
| 30 | low | **Recap dismiss is session-only**, with no undo and no persistence. | `research-run-panel.tsx:56, 64, 90` | | verified |
| 31 | low | **Follow-up chips are generated from the plan notice** after completion. | `chat-view.tsx:472-476`; `follow-up-suggestions.tsx:39-44` | the report is not a message | plausible |
| 32 | low | **The unread chip dims to `opacity-75`** in the non-link branch, contradicting the contrast comment ten lines above. | `source-rail.tsx:114-128` | | verified |
| 33 | low | **`EvidencePanel` memo never hits** (new array dependency). | `evidence-panel.tsx:137-152` | | verified |
| 34 | low | **Idle poll misses `awaiting_clarification`** (polled at 2.5 s). | `use-research-run.ts:297-301` | | verified |
| 35 | low | **Report dialog on phones**: `pr-14` gutter on every line and nested scroll containers. | `report-dialog.tsx:94, 105`; `dialog.tsx:81` | | verified (layout) |
| 36 | low | **The report's `[n]` hover shows no passage** (`snippet: ""`). | `report-reader.tsx:69-72` | | verified |
| 37 | low | **Recap `ShieldCheck` not `aria-hidden`**, and the read dot has no text. | `research-recap.tsx:169`; `source-rail.tsx:93` | | verified |
| 38 | cleanup | Dead code: `ContextInspector` (no consumers, research mode); `.animate-research-stage` and `.research-field` (0 uses); `RESEARCH_STAGE_LABEL` (0 uses); `CLARIFY_COPY.needed`; `RESEARCH_EFFORT_COPY.note`; the console `onDismiss` prop (never passed); the `awaiting_user_input` state (never entered). | `context-inspector.tsx`; `globals.css:1037-1039, 3688`; `domain.ts:354-360, 85`; `run-controls.tsx:240`; `effort-copy.ts:42`; `research-console.tsx:143` | grep | verified |

---

## 9. Gaps in verification tooling (fix before the redesign)

- **No dev gallery renders any research component.** `src/app/dev/*` has composer and
  controls galleries (the + menu row with "Standard", the telescope glyph), but no
  fixture for `ResearchConsole` (each state), `PlanReview`, `ClarifyGate`,
  `ResearchRecap`, `ReportReader` or `RunTimeline` with lanes. Per the project's
  verification rules (`juno-web-verification`: verify in `/dev/*` galleries) this surface
  currently **cannot be visually verified** without a live paid run. A `/dev/research`
  gallery driven by static `ResearchRunView` + `ResearchEventDTO[]` fixtures (every state
  in §2, plus tier sizes 1 / 4 / 8 / 12 workers, plus a 480-source run) should be the
  first commit of the rework.
- There are no UI tests for research. `tests/research-*.test.ts` cover the engine, clock,
  plan format and citations. The only UI-adjacent test is `markdown-headings.test.ts` for
  the reader's ToC selector.

---

## 10. What to keep, and what the redesign has to decide

**Keep (the engine and its truths):** the durable run and event log with a cursor and
`maxSeq` catch-up (`use-research-run.ts`); `workingElapsedMs` (working time excluding
parked time); null-is-not-zero evidence rules and "nothing colour-only"; the provider
roster warning ("thin because of this deployment, not the topic",
`run-timeline.tsx:589-633`); the structured plan (approach, objectives with evidence
contracts, steps, criteria, risks); the numbered-corpus contract (read sources in store
order = citation order, `research-run-panel.tsx:115-120`); `Collapse` + `inert`; the
print pipeline for a portalled document (`globals.css:3712-3721`); `stripTrailingSourcesSection`.

**Decisions the redesign must make (with this audit's recommendation):**

1. **One completion path.** Either the background report posts an assistant message into
   the thread (summary with citations plus a document), or Start re-enters the chat stream.
   Recommendation: background run, then a persisted assistant turn with a 100–200-word
   answer and a report document. This reuses `RESEARCH_OUTPUT_CONTRACT`'s shape and is
   written by one clearly named model.
2. **Remove tier names from every surface.** Keep a tier internally if the budget needs
   it, but show scale in human terms at the plan ("~15 min · reads up to ~300 pages · stops
   at $8"), or drop the derivation and let the lead model size the run (Claude's model).
   Rename the feature "Research" and remove "Deep" from the UI strings in §4.2. The
   model-facing prompts can keep any wording.
3. **Live progress on the right.** Move the console's machinery into the right dock as a
   research panel (plan → researchers → sources streaming → findings with quotes →
   writing), and leave a compact, glanceable progress row in the transcript. This also
   gives the dock a job while the thread stays free for chat.
4. **Steering that works.** When a run is working, give the composer an explicit mode
   switch ("Message Juno" vs "Add to research"), not an implicit takeover tied to
   `isBusy`, and never bind Stop to the run unless the visible control says so (fixes #1, #2).
5. **A short plan.** Show the approach and 3–6 questions editable in place (add, remove,
   reword), with Start sticky at the bottom of the card. Put searches and evidence
   contracts behind "Details". Optionally auto-start after a visible countdown.
6. **Report as a document**, opened in the canvas or dock (side-by-side) with a
   full-screen mode on phones. Add claim-level audit marks in the prose, citation hovers
   with the quoted passage (findings already store quotes), export to PDF / DOCX / MD
   with a sources appendix, a real share link, and "Ask about this" on a selection.
7. **Completion moment.** A settle animation on the card, a toast if the person is
   elsewhere in the app, a tab-title and favicon badge, and a browser notification (opt-in).
8. **Stop semantics.** Offer "Finish now (write with what's gathered)" alongside "Cancel
   run", with a confirm step and an undo window for cancel.
9. **Motion system for research.** One ambient "researching" signature (not the chat
   thinking matrix), a stage advance beat, sources arriving as a calm stream (batched per
   poll, not per row), no per-poll re-keyed entrances, one pulse at most per surface, a
   live→done morph, and a reduced-motion equivalent that carries state in words.
10. **Performance.** Drop `snapshot` from the poll's source select (compute `read` in SQL,
    e.g. `snapshot IS NOT NULL`, or with a column). Stop discovery polling when a
    conversation has no live run and resume on send. Send sources incrementally with
    the event cursor.
