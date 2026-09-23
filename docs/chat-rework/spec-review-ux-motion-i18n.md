# SPEC review: UX, motion and i18n (§7, §8, §9 UI, §10, §11)

Reviewer lens: DECISIONS U1–U7, R1–R7, §4b and §4c; `external-motion-audit.md` §3–§4;
`internal-design-system-motion.md`; `gap-dynamic-copy-i18n.md`; `internal-research-ui.md`;
`external-deep-research-audit.md` §6.3 and §11; `internal-thinking-and-right-panel.md`. Every code
reference below was read in this worktree at `169e6bb1`.

Items are numbered once. **Blocking** means a broken implementation or a contradiction with
DECISIONS. **Important** means a user-visible defect, an unspecified state, or an a11y failure.
**Minor** means a polish or consistency issue.

---

## Blocking

### 1. More than one loop owner, and the wrong one when the panel is open (§7.5, §7.9, §8.4, §9.14)

DECISIONS U2 says: "One loop owner on screen. It is the transcript line, or the panel's running
row when the panel is open." The motion audit §3.7 says the same: the dock's running-row ring is
the only loop, the dock header is a static word plus the clock, and the transcript line goes to
its static signature. The spec breaks this in six places:

- **§8.4.** The panel **header** `RunLabel` owns "the shimmer and the glyph loop". On top of that,
  "the panel's running row ring runs on the same `--loop-phase`". That is two loops in the panel,
  and the header is the wrong owner.
- **§7.5 peek.** A peek tool row has "its own breathing ring while running" (`.run-marker`). It
  loops at the same time as the RunLine glyph and the shimmer, which gives two loops in the
  transcript.
- **§9.11.3 and §9.7.** A chat turn can stream while a Research row is live. The steering chip
  hides "while … no chat stream is running", so a chat stream is expected. The chat RunLine and
  the Research row then both loop. MAX and MAX20 allow 2–3 live runs, so several Research rows can
  also loop at once.
- **§9.14.** A "pulse ring on `--loop` on the header glyph" plus the header glyph gives two loops on
  one element. No CSS is given, so implementers will reach for the existing `animate-pulse-ring`
  (`tailwind.config.ts:521,817`). That runs at 1.6 s, is off the loop family and doesn't read
  `--motion-shift`.
- **§8.4.** `data-owner="panel"` → `animation-play-state: paused` has no rule in the §7.9 CSS, which
  "lands verbatim". Even if it did, pausing freezes an arbitrary frame of the lit layer, with some
  dots half-lit, instead of the phase's static signature.
- **§11.1.** The gallery asserts "the number of `[data-run-loop-owner]` elements (exactly 1)", but
  nothing in §7 or §8 defines that attribute.

**Fix.** Add one arbiter to `src/lib/run/store.ts`: `claimLoop(id, priority): release`, read with
`useLoopOwner(id)`. Priorities, highest first:

1. The open panel's live item: the running tool row, or the live reasoning item when nothing runs.
   In the Research panel, the question row whose status is `searching`.
2. The live chat `RunLine`.
3. The artifact card's writing glyph.
4. The newest live Research row.

The winner renders `data-run-loop-owner`. Every other loop-capable element (glyph, sweep, marker)
renders `data-loop="off"`. Add CSS that maps `[data-loop="off"]` to the same static per-phase
signature the reduced-motion block uses, with no sweep and no breath. Change these too:

- The panel header shows a static phase word plus the clock.
- Peek rows use a static running marker (an open ring, no breath) and never loop.
- Delete the §9.14 pulse ring.
- §11.1 then asserts exactly one `[data-run-loop-owner]`.

### 2. Automatic height changes in the transcript beyond the one DECISIONS allows (§7.5, §7.10, §9.11.2, §9.11.3)

DECISIONS §4b says the peek collapse "is the only automatic height change in the transcript". U2
says the peek "grows by translating, never by resizing". The spec adds these:

- **§7.5, peek open.** The peek is "mounted closed; it opens once (`grid-template-rows 0fr → 1fr`)
  when the first step exists". That is an automatic resize.
- **§7.10.** The approval card enters with `rise-in` and is labelled "the one exception". The card →
  receipt collapse is also automatic when the approval **expires** or is decided on another
  device.
- **§7.5.** "The whole block collapses in the same transition" (line and peek) for runs with
  nothing to show at rest.
- **§9.11.2.** The scope card appears automatically (skeleton → card). It can be mid-transcript if
  the person kept chatting during planning ("any other message … is a normal turn", §9.6.1).
  "Update plan" sets the state back to `planning`, which renders the skeleton, so the card
  collapses and then re-expands.
- **§9.11.3.** "On completion the row unmounts via collapse." The row sits under the original user
  message, usually far above the tail once the person has kept chatting, so everything below it
  shifts under the reader.

**Fix.**

- **(a)** Record the peek's one-time open as an owner-approved amendment: it happens only at the
  transcript tail, because a live chat run is always the last message, and it is scroll-anchored.
  The alternative is to reserve the 64 px from the line's first paint whenever `fact:tools.offered`
  is non-empty. Pick one, write it into §7.5, and add it to §14.
- **(b)** Cite the approval card as implied by DECISIONS U1 ("the card anchored to its call"), not
  as a spec exception. Scroll-anchor the insertion and any receipt collapse the reader didn't
  cause.
- **(c)** The whole-block collapse is the same event as the peek collapse. Say so.
- **(d)** The scope card appears full-size only when it is at the tail. Otherwise it appears as a
  one-line "Plan ready · Review ›" row the height of the skeleton, and it expands on click, which
  is user-initiated.
- **(e)** During `revise`, keep the card mounted with `aria-busy`, dimmed inputs and a footer line
  "Updating the plan". Never fall back to the skeleton.
- **(f)** At completion, don't unmount the Research row. Swap it in place, at the same 36 px, to a
  static "Report ready · Open report ›" line. The completion message still appears at the tail.
- **(g)** Every automatic change that remains goes through `scroll-anchor.ts`.
- **(h)** List every automatic height change in §7.5 in one table.

### 3. Text-first tool rounds (Anthropic, Gemini, compat) break the settle, the peek and "collapse before text" (§7.3, §7.5, §2.8)

**The problem.** §2.8 classifies commentary only at `round_end`, and text streams into the answer
area first. §7.3 rule 5 sets `answerStarted` as soon as "the current round has non-commentary
text and no tool started after it". A Claude turn therefore goes like this:

1. Claude writes "Let me look that up."
2. The line settles at the first token (gather, summary, shimmer off), and the peek collapses or
   never opens, because §7.5 opens it only "before any answer text".
3. The `tool_use` arrives and rule 3 re-enters `tool`, so the line un-settles.

**The consequences.**

- For the most common tool pattern, DECISIONS U1's "live steps as they happen" never appear.
- The line flickers through its done state.
- No re-entry choreography exists: nothing reverses the gather, restores the label swap or resumes
  the clock.
- "Collapses … before any answer text renders" (DECISIONS §4b) can't hold as written. The collapse
  lasts 220 ms and text renders at t = 0, so the first answer text slides up 64 px.

**Fix.** Add a provisional-text rule to §7.3 and §7.5 (in `live-message.ts` and the pacer). This
applies to rounds from providers that don't declare `phase` (every adapter except OpenAI
Responses with `phase`). Buffer the round's first text, without rendering it, for up to
`RUN_PACING.textHoldMs = 600`, or until a tool `call` arrives.

- **If a call arrives:** the text is commentary. Render it in `RunCommentary` below the open peek.
  The line stays working and the peek opens if it was closed, before any answer text exists.
- **If the hold expires:** the round is an answer. Set `answering`, collapse the peek (0 ms under
  reduced motion) and flush the buffer on the collapse's `transitionend`, so text renders after
  the collapse.
- **If a tool starts after the flush:** re-enter a working phase on the line only. The peek doesn't
  reopen. The glyph un-gathers with the reverse transition, the label swaps through the pacer, and
  the clock resumes and counts only tool time (`workedMs` already unions post-answer tool
  intervals).

Add a `/dev/run` fixture, "Anthropic text-first round with peek". Redefine `answerStarted` as
"a round's text was flushed as answer".

### 4. `PhraseSpec` can't express the spec's own copy, and many strings are composed (§7.6, §7.3, §7.10, §7.12, §8.3.1, §9.6.3, §9.9, §9.11, §10.1)

**The type gap.** DECISIONS §4b requires a fixed phrase plus separate argument nodes, and whole
phrases for plurals. §10.1 says arguments are "followed (or preceded, fixed per phrase)". But
`PhraseSpec = { phrase: string; args?: ArgNode[] }` has no position field and no plural count
node, so "5 results", "About 12 min" and "12 min read" can't be represented.

**The composed strings.** Many strings in the spec put an argument between two phrase fragments,
or stitch two phrases together:

- §7.6.2: "ran code" + n + "times"; "used" + label + n + "more".
- §7.3: "Reading {n} sources"; "Searching {n} queries".
- §7.6 `read_document`: "Reading" + file + "pages" + range; "Searching" + file + "for" + quote.
- §9.11.2: "About {n} min · reads up to ~{p} pages".
- §9.11.3: "{n} sources · {m} min read".
- §9.9: "You have {n} research runs going. Wait for one to finish."; "You've started today's {n}
  research runs."
- §8.3.1: "Try {toolTitle} again".
- §9.6.3: "Stopped early: {reason}".
- §7.10: "Couldn't finish" + duration, with no separator, which renders "Couldn't finish 12s".
- §7.12 accessible names: "{lead} {duration long}, {facts}{, n warnings}. Show steps".

AutoTranslate matches whole values only (`auto-translate.tsx:190-196,207`), so a composed
`aria-label` never matches and stays English.

**Fix.**

- **The type.** Define `PhraseSpec = { parts: ReadonlyArray<{ phrase: string } | ArgNode> }` with at
  most one bare phrase, placed first or last. Add
  `ArgNode { kind: "count"; n: number; one: string; other: string }`, rendered as a number node
  plus `pluralPhrase`, which is the §4b "5 sources" pattern.
- **A test.** `run-presentation.test.ts` asserts the one-phrase rule for every spec the registry
  and the copy modules can produce.
- **The rewrites:**

| String | Rewrite |
|---|---|
| "ran code" + n + "times" | count(n, "code run", "code runs"); "ran code" when n = 1 |
| "used" + label + n + "more" | "used" + label for one connector; count(n, "connector used", "connectors used") for more |
| "Reading {n} sources" | "Reading" + count(n, "source", "sources") |
| "Searching {n} queries" | "Searching" + count(n, "query", "queries") |
| `read_document` range | ["Reading", file] · ["Pages", formatRange] |
| `read_document` search | ["Searching", file] · [quote] |
| Estimate | ["About", minutes as `Intl.NumberFormat` unit] · ["Reads up to", count(p, "page", "pages")], with `~` as a number-node option |
| Report card | count(n, "source", "sources") · [minutes, "read"] |
| `live_runs` refusal | "Too many research runs are going. Wait for one to finish." (no number) |
| `daily_starts` refusal | "You've reached today's research limit." |
| "Try {toolTitle} again" | ["Try again:", label] |
| "Stopped early: {reason}" | ["Stopped early"] · [reason] |
| "Couldn't finish" + duration | ["Couldn't finish"] · [duration] |

- **Rule 5 (§10.1).** Extend it: every attribute built from phrases (`aria-label`, `title`,
  `placeholder` with arguments) is built by `phraseText` from complete phrases joined with ". ",
  and set on an element marked `data-no-auto-translate`.

### 5. Steering is on by default, which contradicts R6 (§9.7)

§9.7 describes a "mode chip 'Guiding the research' (toggle, **on by default** while a run works;
off sends a normal message)". DECISIONS R6 says "Steering is an explicit composer mode". The
research audit's principle 7 is "explicit, not a side effect of `isBusy`", and its §11.7 proposes a
two-way "Ask Juno | Guide the research" switch.

On by default recreates research-UI bug 1's class of error: a follow-up question typed during a
run silently becomes guidance. The chip also hides while a chat stream runs and comes back on
afterwards, so the default re-arms after every reply.

**Fix.**

- Default the mode to **Ask**. Show a visible two-segment switch "Ask Juno | Guide the research"
  above the composer while a run is in `investigating`, `reviewing`, `synthesizing`,
  `validating_citations` or `paused`. It is never shown at a gate.
- Remember the choice per run in `sessionStorage`, and reset it when the run leaves a working
  state.
- In Guide mode the placeholder is "Add guidance for the research…", and Send shows the mode's
  name.
- Use the DECISIONS wording "Guide the research" for the control, not "Guiding the research".

### 6. The tab-title notice and the print file name can't work (§9.8, §9.13)

`DocumentTitle` (`src/components/app/document-title.tsx:37-62`) holds `document.title` with a
`MutationObserver` on `<head>` that re-applies its computed title on every change. The watcher's
`document.title = "Report ready · {title}"` (§9.8) is therefore reverted in the same task.
Setting the title "to the report title during print" (§9.13) is reverted the same way, so R7's
"the tab title changes" and the PDF file name both fail.

**Fix.** Give `DocumentTitle` an override channel: a tiny store `src/lib/title-override.ts` with
`setTitleOverride(key, text | null)`. `desired = override ?? computed`.

- The completion watcher sets it and clears it on focus or when the conversation opens.
- The export uses `beforeprint`/`afterprint`.
- The text comes from `formatPhrase`, with the title FSI/PDI-isolated.
- Add `completion-watcher` to WS8's tests with a fake `DocumentTitle`.

---

## Important

### 7. Stalled and long-run escalation are unspecified (§7.3, §7.10, §7.12, §11.1)

`stalled` exists only as a boolean, and fixture 17 says "stalled overlay line". The spec gives no
visual, no copy, no announcement and no calm forcing, and doesn't say whether `ping` frames count
as events. It also drops the 2-minute and 10-minute escalation copy the motion audit keeps
(§3.5.6; gap-i18n P-8 and P-9, today in `activity-timeline.tsx:88-93`). As written, a 60 s
`run_code` that sends no events (the watchdog is paused, INV-33) would show a stall warning.

**Fix.** In §7.3:

- `stalled` excludes phases where a call is `running` within its `timeoutMs`, and excludes
  `waiting`.
- `lastEventAt` ignores `ping`.
- Stalled forces calm.

In §7.10, stalled renders a secondary caption inside the line, with no new row: "No response for" +
duration, in `text-warning` (P-7). Escalation captions appear at 2 min ("Still thinking. This can
take a few minutes.") and 10 min ("Still working. You can leave; the answer will be here.").
In §7.12, stalled announces "Still working" once. Add a fixture for a stall while a tool runs,
which must show no warning.

### 8. Phase-locking doesn't work as specified (§7.9)

`--loop-phase` is set only on the `.run-glyph` span (markup at §7.9). The sweep sits in the
sibling `RunLabel`, and the markers sit in the peek and the panel, so none of them inherit it and
all default to `0ms`. The glyph and the shimmer then don't "start together and read as one
gesture" (motion audit §3.3.2).

A single ancestor value doesn't fix this either. A negative delay aligns an animation with the
page clock only when it is computed at that animation's own start. The calm period is 4.8 s, but
`loopPhase(2400)` is used. The reduced-motion `run-breathe-opacity` on the glyph has no delay at
all.

**Fix.** Add `usePhaseLock(ref, periodMs)` in `src/lib/run/loop-phase.ts`. It writes
`--loop-phase` on each looping element when its animation starts or changes (mount, `data-phase`,
`data-calm`, owner change) using that element's current period (1200, 2400 or 4800). The
alternative is to align with the Web Animations API:
`el.getAnimations({subtree:true}).forEach(a => a.startTime = 0)`. Add
`animation-delay: var(--loop-phase)` to every reduced-motion breath.

### 9. Reduced-motion gaps (§7.5, §7.9 unlayered block)

- **The peek list.** It moves by `translate` 28 px, and the value isn't multiplied by
  `--motion-shift`. Add `.run-peek__list { transition: none }` to the reduced block, and multiply
  the JS offset by the resolved shift.
- **The glyph's own reduced breath.** It isn't paused off screen, because `[data-offscreen]` pauses
  only `::after`. Add `.run-glyph[data-offscreen] { animation-play-state: paused }`.
- **`.run-marker::before`.** It has no off-screen pause anywhere, which fails U5.
- **The gather.** Under reduced motion it still scales outer dots to 0.4 and the centre to 1.5. The
  motion audit §3.11 says to cross-fade to the resting dot. Under reduce, fade only, and draw the
  resting dot at 6 px without scaling.
- **`.run-collapse { transition: none }`.** This drops the content fade the audit keeps ("Instant +
  content fade").

### 10. Collapsed content stays focusable (§7.8, §7.9 `.run-collapse`)

The CSS keeps closed content mounted and clipped, with only `overflow: hidden`, so keyboard focus
can land inside the collapsed inline timeline or a collapsed peek. That fails WCAG 2.4.7 and
2.4.11, and it reintroduces what the motion audit §4.7 prevents with `inert` and `visibility`.

**Fix.** Toggle `inert` together with `data-open`. Add `visibility: hidden` after the close, as in
§4.7. The alternative is to use the existing `<Collapse>` (`src/components/ui/collapse.tsx`, which
unmounts when closed) for the user-opened inline timeline, and keep `.run-collapse` for the peek
only. Set `aria-controls` only while the target is mounted.

### 11. RTL is live today, and the spec's CSS breaks under `dir="rtl"` (§1.2 item 8, §7.9, §8.2, §10.1 rule 10)

RTL is not only a follow-up. `AutoTranslate` sets `document.documentElement.dir =
directionOf(activeLocale)` (`auto-translate.tsx:104`), and the root layout sets `dir`
(`layout.tsx:119`). `UI_LOCALES` is "not a whitelist" (`i18n.ts:95-105`), so a browser set to
Arabic or Hebrew with the locale on "auto" gets `rtl` now. Several things break:

- **The glyph gather.** In RTL, `.run-glyph` is an `inline-grid`, so its columns mirror and `c = 0`
  sits on the right. `translate: calc((1 - var(--c)) * 7px …)` then moves the outer dots
  **outward**.
- **The shell.** `.right-shell` enters from `+24px` and the sheet exit uses a physical x, so in RTL
  the panel slides in from the transcript side.
- **Carets.** `CaretRight` rotating 90° points up once it is mirrored.
- **Copy.** "Open ›" hard-codes a glyph in the copy.

**Fix.**

- Add `direction: ltr` to `.run-glyph`, because it is an icon.
- Multiply the shell and sheet x by `var(--dir, 1)`, with `:dir(rtl) { --dir: -1 }`.
- Use `rtl:-scale-x-100` plus `rtl:-rotate-90` for the expanded caret.
- Make "Open" a phrase followed by a `CaretRight` icon.
- Correct §1.2 item 8: DECISIONS §4c says nothing about RTL. The follow-up is adding RTL locales
  to the menu. New surfaces must render correctly under `dir="rtl"` now.
- Add an RTL toggle to both galleries.

### 12. Sheet geometry, occlusion and header alignment (§8.2)

- **`top-14` is wrong on phones.** The chat header band is `hidden … md:flex` and is `h-11`
  without a title (`chat-view.tsx:2015-2022`). Below `md`, where most sheets open, there is no
  band, so the sheet leaves a 56 px gap. Measure the band into `--juno-header-h` with a
  `ResizeObserver`, as §8.2 already does for `--juno-composer-h`. Use it for the sheet's `top` and
  the column header's height, so "aligned with the chat header's height" (U3) holds for new chats
  too.
- **The covered transcript stays focusable.** The sheet covers the whole transcript, with no
  backdrop, but the transcript remains focusable, so Tab moves focus under the sheet (WCAG
  2.4.11). An `IntersectionObserver` doesn't see occlusion, so the covered line keeps animating
  (U5). While `coversChat()`, a prop §8.3 declares but never wires, set `inert` on the transcript
  scroller only (not on the composer) and set the store's owner so the covered loops go static.
- **The sheet's surface.** Replace stock `shadow-lg` with the floating-layer material
  (`shadow-float` or `.surface-float`) and `rounded-t-panel`, as FLAT_UI requires for sheets. Say
  what the body fill is (the dock today is `bg-card`, and §8.2 gives the header `bg-background`).

### 13. A pending approval is unreachable while the sheet is open (§7.10, §8.3.1)

The `ApprovalCard` exists only in the transcript. The panel shows only the receipt after a
decision. Below the split, the sheet covers the card, so the turn waits and expires unless the
person finds "Back to chat".

**Fix.** The panel's `awaiting_approval` row renders a compact approval control. It uses the same
`/api/approvals/[id]` decision path and reads state from the `approval` frame, as the motion audit
§3.6 does with "an inline approval control replaces the caption in place". The alternative is to
bring the transcript card into view: in sheet mode, `waiting` closes the sheet and moves focus to
the card. The assertive announcement names where to act.

### 14. Notice and connector-failure copy is undefined (§2.4 `RUN_NOTICE_CODES` × §7)

§7 defines phrases only for tool `error.code` (§7.6.1) and research refusals (§9.9). These have
no client phrase:

- 14 notice codes: `model_changed`, `skill_not_applied`, `connector_unavailable`, `usage_limit`,
  `stall`, `finish_length`, `finish_sensitive`, `tool_budget`, `web_off_lockdown`,
  `provenance_refused`, `hostile_content`, `search_degraded`, `private_tools_limited`,
  `tools_capped`;
- the 5 `ConnectorFailure` reasons shown in the Details tab.

Implementers will render `legacyTitle` (English), which contradicts §10.6 I-3.

**Fix.** Add `RUN_COPY.notices: Record<RunNoticeCode, PhraseSpec builder>` and
`RUN_COPY.connectorFailure`, with each param's rendering (connector → label node, host → domain
node, and so on). Assert full coverage in `run-presentation.test.ts`.

### 15. Tabs, headings and panel lifecycle semantics (§8.2, §8.3, §9.11.4)

- **Tabs.** `RightColumnShell.tabs` has no ARIA contract. The research console's "tabs are not
  tabs" bug (research-UI §6.8) will recur. Mandate the Radix `Tabs` in
  `src/components/ui/tabs.tsx`, which has roving focus and a per-mount `layoutId` thumb.
- **The heading.** The `h2` "header title" is the live phase label, so the heading's text changes
  every phase. Make the `h2` the stable panel name ("Activity" / "Research"). The phase label
  becomes a separate `aria-hidden` element, and its shimmer copy is `aria-hidden` (motion audit
  §4.3).
- **Row entrances.** Rows present when the panel opens or a tab switches must carry
  `data-instant`. Otherwise `@starting-style` deals the whole list again every time (research-UI
  §6.5, "stagger on repeat is noise").
- **Focus and exit.** Focus moves to the `aside` on open in column mode too (today's behaviour).
  Mark the content `inert` during the exit.
- **`onExited`.** It needs a timer fallback (`--dur-exit` + 50 ms) and must filter
  `propertyName === "opacity"`. With `display` and `allow-discrete` unsupported (Safari < 17.4),
  or when nothing actually transitions, `transitionend` never fires.

### 16. Research accessibility: announcements and focus (§7.12, §9.7, §9.11)

`RunAnnouncer` announces only from "the phase store of the streaming message". Research phases
arrive by polling, so these are all silent:

- planning finished ("Ready to start");
- started, paused, writing;
- report ready (the completion message is inserted; a polite region doesn't announce its own
  initial content);
- couldn't finish.

Focus after **Start** isn't specified. The card collapses, so focus falls to `<body>`, which is
research-UI bug 12. The Research row has no accessible name.

**Fix.**

- `RunAnnouncer` subscribes to the live runs of the open conversation: polite, ≥ 3 s apart,
  terminal states immediate.
- After Start (or a typed "yes"), focus moves to the new Research row, a `Pressable` named with a
  stable label: "Research: {phase}. Open research panel".
- The scope card's arrival is announced once ("The research plan is ready").

### 17. Mobile layout for Research and the run line (§7.5, §9.11.2–9.11.4)

- **The scope card.** Start is at the bottom of a card that can be tall (6 questions, clarifications
  and sources). On a phone it sits under the composer dock (research-UI §6.7). Make the footer
  (estimate, notify, Cancel, Update plan, Start) sticky inside the card on narrow containers,
  following the deep-research audit's "Start is primary and sticky".
- **The panel header.** At 375 px the Research header holds back, glyph, sentence, clock, Pause,
  Finish now and overflow. Below `@[28rem]`, move Pause and Finish now into the overflow.
- **The rows.** At 375 px the RunLine and the Research row drop the favicon stack and facts (both
  are in the accessible name). They keep the glyph, label, clock or chevron, and "Open".
- **The peek.** The motion audit §3.6 scopes the peek to desktop. Decide, and state in §7.5,
  whether it shows on `coarse` or under `@[28rem]`.

### 18. Other gaps in the Research UX (§9.7, §9.11)

- **Keep researching.** "Starts a new run whose goal is the old goal + 'Go further on: {user text}'",
  but no input surface is specified. Put an inline text field in the report view and the report
  card. It posts `POST /api/research { goal, conversationId, pinnedSources }`, and `pinnedSources`
  already exists in `startResearchSchema` (`protocol.ts:59`). The new run then goes through the
  scope card.
- **Completion while the panel is on Progress.** The panel cross-fades to Report, unless the person
  switched tabs during the run (deep-research audit §6.3, "dock cross-fades from progress to the
  report").
- **Finish now.** Pressing it gives no feedback until the next round boundary, which can be minutes
  away. Show a "Finishing with what it has" state and disable the button. The steering row needs
  applied copy ("Applied in round {n}", as a count node).
- **Paused.** "Static glyph" isn't a defined `data-phase`. Add `data-phase="paused"`: the resting
  grid, no lit dots and no accent.
- **The Research row's source count.** Say which count the row shows: `counts.read` while live and
  `counts.cited` at rest (bug 11, "one count vocabulary").
- **The Research row's clock.** It extrapolates from `workingMs + (now − fetchedAt)` while working,
  and freezes at gates and when paused. Otherwise it jumps on every poll.
- **The completion message's `RunLine`.** It opens the panel instead of toggling the timeline, so
  one component has two behaviours and a wrong `aria-expanded`. Make it a separate `Pressable`
  with no `aria-expanded`.

### 19. The fixed px geometry ignores Juno's reader text size (§7.5, §7.9)

`FONT_SIZE_BOOT_SCRIPT` (`src/components/settings/font-size.ts:62`) scales the root from 14 to
20 px, and the design system requires rem-based sizing. The peek's 64, 56 and 28 px boxes, the
28 px JS translate and the 36 px line are px. At 20 px, or with browser text zoom (WCAG 1.4.4),
peek rows clip.

**Fix.** Use `4rem`, `3.5rem` and `1.75rem`, and translate by the measured slot height. Add a
20 px root toggle to `/dev/run`.

### 20. §9.9 misses user-visible "deep research" strings, and nothing guards R1 (§9.9, §13)

These are missing from the table:

- `src/lib/chat/request.ts:189`: "…cannot be combined with regenerate, clarification, or deep
  research.", an API error shown to web users;
- `src/app/dev/controls/gallery.tsx:860`: `<MenuRow>Deep research</MenuRow>` (only `:203` is
  listed);
- `src/lib/models.ts:512`: the model-picker description "Parallel multi-agent deep research
  (beta)."

§9.2 sets `plan.effort` to `nearestEffort(...)`, while §9.4 says it is "null on new runs". If it
is non-null, a web DTO carries "deep" or "max" to any kept component that reads it.

**Fix.**

- Add the three rows.
- Null `plan.effort` in the DTO for requests that declare `research_background`.
- Add `tests/research-copy-guard.test.ts`. It scans `src/components/**`, `src/app/(app)/**`,
  `src/app/dev/**` and every `*_COPY` literal for `/deep[ -]research/i`, and scans
  research-context strings for the depth labels `Quick`, `Standard`, `Deep` and `Max`. The
  thinking rung and plan names are allow-listed.

### 21. The galleries can't verify what the spec promises (§11)

- **Toggles missing.** `dir="rtl"`; accent (all six presets, because `waiting` uses `--primary`
  and the design system §17 requires "all six accents where accent is used"); a 20 px root; and
  `de` seeds for `PANEL_COPY` and `RESEARCH_COPY`. Only `RUN_COPY` is seeded, so `/dev/research`
  in `de` would call the live translation route.
- **Assertions.** "Layout shift of the answer's first line at the collapse" measures nothing,
  because the collapse precedes the text. Replace it with a `PerformanceObserver('layout-shift')`
  total after the first answer token of 0, as in motion audit §3.15. Define
  `[data-run-loop-owner]` (item 1).
- **`/dev/run` fixtures to add:** an Anthropic text-first round (item 3); a stall while a 60 s tool
  runs, with no warning, and a stall with no tool; a chat stream while a Research row is live (one
  owner); the sheet at 375 px with a pending approval (item 13); the re-entry choreography with
  the peek not reopening.
- **`/dev/research` states to add:** `revising` (the card stays, item 2e); `completed-while-panel-open`;
  `notify-prompt`; two live runs; a mobile scope card with the composer dock;
  `finish-requested` feedback; `cancelled` without a report.

---

## Minor

### 22. The summary lead and the DECISIONS example disagree (§7.6.2)

§7.6.2 claims the DECISIONS example "Thought for 12s · 5 sources · ran code ›" "is exactly this
grammar". Under its own lead rule, a run that ran code reads "Worked for". Either write "DECISIONS
wins: …" and always use "Thought for", or keep "Worked for" (the motion audit's rule) and state
that the DECISIONS example is illustrative.

### 23. The assertive region deviates from U6 (§7.12)

§7.12 adds an assertive `role="alert"` region, while DECISIONS U6 specifies "one polite
announcer". Either record the deviation (waiting is time-critical) or use the polite region with
priority.

### 24. The line's accessible name ends in an action verb (§7.12)

The name ends in "Show steps" while `aria-expanded` carries the state, so it reads "Show steps,
expanded". Use a stable noun, "Steps: {summary}".

### 25. Two failure inks (§7.8, §7.12, §8.3.1)

Failed rows use `text-destructive`, while the glyph and the line use warning. The design system
§2.2 says "'Failed' is warning, not destructive, in the dock". Use one ink: warning.

### 26. The favicon ring colour is wrong in the transcript (§7.9 `.run-fav`)

The separation ring is `hsl(var(--card))`, but the transcript ground is `--background`, so dark
mode shows a halo. Use `--fav-ring` set by the container. Add the "+N" overflow count and "never
reshuffle" (motion audit §3.8).

### 27. Forced colours lose two states (§7.9)

The failed centre dot is overridden to `GrayText`, so the failed state has no mark. The
`.run-marker` rings are `box-shadow`, which forced colours removes. Keep the failed centre as
`CanvasText` or a `Mark` colour, and draw the rings with `outline` under `forced-colors`.

### 28. `StreamProgress` stays coral (§7.11 item 6, §7.13)

It keeps a coral 1.4 s sweep (`globals.css:3567-3588`), which conflicts with "one muted ink" and
the single loop family. Move it to `--foreground` ink on `--loop`, or record it as out of scope.

### 29. The artifact card's glyph (§7.13)

`RunGlyph size="sm"` isn't in the component's API. `phase="writing"` in chat contradicts §4b's
"Writing is shown only in Research". Use the `tool` pattern, or record the card as a non-run
surface. It also joins the loop arbiter (item 1).

### 30. Research phase derivation (§9.11.1)

`derivePhase(view, {research: true})` needs a chat `RunView`, but §9.4 derives `dto.phase` on
the server. Map `dto.phase` to the glyph and phrase with a table in `src/lib/research/phase.ts`,
use only the pacer for research, and drop the `research` flag from `derivePhase`.

### 31. The Details tab has no data for context tokens (§8.3.3)

"Context: used / window … tokens" has no typed source. `RunFact` context has only counts, and the
`usage` row is an English `detail`. Add a typed usage fact (`inputTokens`, `contextWindow`), or
show the context fact's counts.

### 32. Tool icons have no registry (§7.6)

Map `ToolIconKind` to `icons.tsx` glyphs through a `ToolIcons` registry in
`src/lib/app-icons.ts` ("registries come first", design system §7.1).

### 33. Homographs share catalog keys (§7.6, §9.11.4, §10.1)

The catalog is keyed by exact English text, so homographs share one translation. "Searching" (the
question status chip) and "Searching" (the verb prefix) get the same translation. The lowercase
single-word facts ("read", "used", "ran code") give the model translator no context. Give each
meaning a distinct source string.

### 34. Segmentation needs `Intl.Segmenter` (§7.5, §9.12)

The peek's "newest complete sentence" and the citation fragment's "first 8 words" need
`Intl.Segmenter`. CJK has no spaces or periods of the Latin kind.

### 35. `lang` markup is incomplete (§10.1 rule 7, §9.11)

`lang={run.language}` goes only on the report. Add it to the scope card's approach and questions,
the Progress activity, "Found so far" and the completion summary. Verbatim argument nodes carry
`lang=""` (gap-i18n §4.2).

### 36. `formatDate` is missing (§10.2)

Add `formatDate` to §10.2 for "Researched {date}" and the citation-card dates.

### 37. The notify prompt repeats (§9.8)

The notify line shows on every card while permission is `default`. Persist "asked" in
`localStorage`, so it is shown on the first qualifying Start only (R7).

### 38. Stopped and failed runs leave the peek open (§7.10)

Nothing says what happens to an open peek at `stopped` or `failed` before any answer. Collapse it
there too, scroll-anchored (a stop is user-caused; a failure is at the tail).

### 39. The label swap wording suggests animating `font-size` (§7.5)

"Colour/size cross-fade" should say it is the two stacked `.run-label__item` elements. It is
never a `font-size` transition.

### 40. Minor wording and wiring points

- §9.9: the `budget` refusal's `resetsOn` param is unused. Consider adding "Resets on {date}" as a
  separate phrase.
- §8.3: `juno.activity.tab` mixes key conventions with `juno:thought-width`.
- §7.5: under D-5 (ii), the peek's reasoning excerpt is untranslated content under a localised
  line. That is acceptable, but record it.
- §9.11.2: "Notify me" and a typed "yes" can both apply. State that a typed confirmation skips the
  prompt.
