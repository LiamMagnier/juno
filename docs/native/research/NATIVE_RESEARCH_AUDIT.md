# Native Deep Research — audit (2026-10-08)

Scope: Deep Research in the macOS app (`native/macOS/JunoDesktop`), the iOS app
(`native/iOS/JunoMobile`) and the shared kit (`JunoChatKit` `NativeResearchRun*`,
`DeepResearch*`; `JunoDesignSystem` `JunoResearchPresence`). Reference: the web's
Deep Field redesign (`src/components/research/*`, `docs/rework/program/RESEARCH.md`)
and the server (`src/lib/deep-research.ts`, `src/lib/research/*`, `/api/research/*`).

## How research actually runs for a native client today

Read from the server, not the docs:

1. The composer sets `deepResearch: true`. The chat route (`research-stage.ts`)
   calls `runDeepResearch` with `client: "app"`, which starts a durable
   `ResearchRun` with **`confirmation: "auto"`** — no plan gate, no clarify gate
   (`planning.ts` skips clarify when confirmation is auto).
2. While the run plans, searches and reads, its events are narrated into the chat
   stream as `activity` rows (`toActivity`): `Planned the research: N questions`
   (detail = approach), `Searching the web` (detail = query), `Reading source`
   (detail = **page title**, url), `Sending a researcher` (detail = **the question
   being worked**), `A researcher reported back` (detail = summary), lead reviews,
   citation checks, warnings.
3. At `synthesizing` the chat writes the answer: 100–200 words of prose, then the
   whole report inside **one `<juno:artifact identifier="research-report" type="MARKDOWN">`**.
   `sources` (the numbered, `cited` corpus) arrive up front; `[n]` = `sources[n-1]`.
   The citation audit runs afterwards (`/api/research/citations?messageId=`).
4. The `handoff` frame (`research_background`) is declared by native but **no
   server code path sends it**; background runs reach native only when started on
   the web (plan gate → background worker) and listed by `GET /api/research?conversationId=`.

So the production surfaces are: the live in-chat research turn, and the
`research-report` artifact inside the finished answer. The background-run row,
plan/clarify cards, panel and recap matter for web-started runs.

## What is broken or missing

### iOS (worst)
- **No live research in the transcript.** The answer row shows the generic
  "Thinking…" shimmer for the whole multi-minute run; the only progress is a card
  pinned above the composer (`JunoMobileResearchProgress`) that vanishes the moment
  the generation ends and lists raw queries and URLs behind a disclosure.
- **No report reader.** The finished report is the generic artifact card ("MARKDOWN"
  subtitle) opening the generic artifact canvas: no outline, no editorial type, no
  citation previews, no sources list, no Markdown/PDF export.
- **Background runs are invisible.** iOS never calls `followResearch`, has no row,
  plan card, clarify card, recap or report for a run started on the web or handed
  off. A `handoff` frame removes the placeholder and leaves nothing on screen.
- No way to reopen a past report other than scrolling to its artifact card.

### macOS
- **In-chat report (the production path) opens the generic artifact canvas.** The
  editorial `ResearchReportWindow` only opens for web background runs' recaps.
- `NativeResearchRun.inChat` throws away what the stream carries: page **titles**
  (uses the host), the **questions** being worked (`Sending a researcher` detail),
  the planned question count and approach, researcher count, lead-review and
  citation-check phases. The live row reads as "Searching… 7 Read" and nothing more.
- The live row disappears the moment the first answer token arrives, so the
  multi-minute report-writing phase reads as a plain streaming reply.
- Research panel's Report tab is headed **"Shape the research"** (wrong copy).
- Live views have no source favicons/titles appearing, no fade/rise of new
  evidence, counts jump rather than roll; no field.
- Report reader: headings are SF semibold (not the editorial serif), the H1 title
  repeats under the cover, no PDF export, no share, sources list is plain rows.
- Recap card: bordered box with a `.bordered` button, dismissible ✕ on a receipt
  that is the only door back into the report.

### Shared / state
- Steering sends `constraint` (immediate plan rewrite that can send a run back a
  stage) where the web sends queued `guidance` that applies at the next round.
- A failed run poll is silent: connection loss is indistinguishable from a stalled
  run; the web shows "Connection lost. Showing the last saved research" + retry.
- `researchPanel` for a run not yet followed refreshes once; a failure leaves an
  empty panel forever.
- Clarifications are read from `plan.clarifications` only (the DTO's top-level
  `clarifications[].options` is ignored) — works today, fragile.
- Relaunch mid-run: the in-chat run is tied to the chat request; the server
  cancels it when the request aborts (`chat_stopped`). The app's stream-resume path
  covers reconnects, not a killed app. Server-side; not changed here.

## What "excellent" means here (targets)
- Live: a calm working view in the transcript — phase sentence in plain text,
  elapsed time, the question in Newsreader, the field of real sources moving
  found → read → cited, the questions being worked, figures that roll, the newest
  pages read (favicon + title) fading in, Stop/Guide where the server allows.
- Report: an editorial reader on both platforms — serif title and headings,
  comfortable measure, outline navigation (Mac sidebar, iOS Contents menu),
  citations that preview their source, numbered sources, copy/share/export
  Markdown and PDF, Dynamic Type on iOS.
- Recap: the finished answer carries a report card that invites opening it; the
  same reader reopens from history (any past research answer).

## What changed (2026-10-08, branch polish/native-research)

Shared (`JunoChatKit`):
- `NativeResearchLiveView` — the working view on both platforms (wide on the Mac
  transcript, compact in the Mac panel and on the phone). `NativeResearchField` +
  `NativeResearchFieldModel` port the web's Deep Field map (stable hashed angles,
  discovery order, labels that never leave the box; sources move inward as the
  report cites them — in-chat, from the `[n]` marks in the text being written).
- `NativeResearchReport` — one model for an in-chat `research-report` artifact
  (citations = the answer's `sources`) and a run's report (citations = sources
  read). Sections without their heading lines, a generic title replaced by the
  report's own `#` or the reader's question, Markdown export with a numbered
  Sources appendix, PDF blocks.
- `NativeResearchReportArticle` (cover, Newsreader headings, reading-style body,
  numbered sources, citation cards with the audited passage), `NativeResearchReportCard`
  (the door in the chat; a "Writing “section” · N words" state while streaming),
  `NativeResearchReportPDF` (A4, block-paginated, headings kept with their first block).
- `NativeResearchRun.inChat` keeps page titles, researcher questions, approach,
  review/checking/writing phases. Steering sends queued `guidance`. Poll failures
  set `researchUnreachableRunIDs` (shown as "Connection lost…" + Retry).
  Auto-confirmed (in-chat) runs are never drawn a second time as a run row.

Mac: in-chat research shows the working view through the whole turn including
writing; the report artifact is a report card that opens the report window
(`message:<id>`); window has Contents (incl. Sources), Copy, Share, Export
(Markdown, PDF), Print; recap = report card + audit/inspect/hide line; panel's
Progress tab is the compact working view with guidance; wrong "Shape the research"
heading gone.

iPhone: working view in the answer's place (composer card now only the armed
state); report card; full-height reader sheet with Contents menu and Share (text,
Markdown file, PDF); background runs followed (`followResearch`) and drawn as
gate / working view / report card.

Not verified: a live provider-backed run against production; favicons over the
network (snapshots draw letters); popover anchoring of citations on touch (the
citation card is a sheet with detents on iPhone); relaunch mid in-chat run (server
cancels the run when the chat request aborts — server-side, unchanged).
