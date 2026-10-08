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
  covers reconnects, not a killed app. Fixed on polish/research-background — see
  "Background runs" below.

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

## Background runs (2026-10-08, branch polish/research-background)

Before: an app's research turn (`deepResearch: true`) ran `runDeepResearch` inside
the chat request — gather to `synthesizing` with a per-turn lease, then the chat
model wrote the report into the answer. The run lived on one request on one
process: a server restart stranded it, the apps' Stop/abort path cancelled it
(`chat_stopped`), nothing told the apps to follow it, and no "ready"
notification was ever sent for it (the engine's `announceFinish` only runs on
the engine's own completion).

After (SPEC §9.6.1, for a client that declares `research_background` — both
apps already do; the web declares nothing and is unchanged):

1. `resolveResearchStage` → `startBackgroundResearch` (`src/lib/deep-research.ts`):
   the research surface's start checks (live runs, starts today, usage windows),
   then `engine.start({ confirmation: "auto", delivery: "background", … })` with
   the full engine, and `driveResearchInBackground` (lease owner
   `research-web:<runId>`; the PM2 research worker adopts it if the process dies).
   A "yes"/"no" reply to a plan waiting in the conversation confirms/cancels it.
2. The turn sends `{ type: "handoff", to: "research", runId, userMessageId }` as
   its terminal frame (logged, so a resumed stream ends on it), writes no assistant
   row, marks a first-submission receipt `research_handoff`, releases its spend hold.
3. The engine plans (auto-confirm recorded as `plan_confirmed { by: "handoff" }`,
   which every shipped app draws as a run row, never as the in-chat answer),
   investigates, writes, audits, and `finalizeResearchRun` writes the completion
   message (`research-report-<runId>` artifact, the format both readers parse),
   then `announceFinish` → `notifyUser`: inbox row, APNs, Web Push (path
   `/research/<id>`, data `conversationId` + `runId`).
4. Only Stop (`POST /api/research/{id}/control {action:"cancel"}`) cancels it.

Apps: the existing hand-off adoption and `followResearch` draw the live run and,
on relaunch, rediscover it from `GET /api/research?conversationId=`. New: a
completion watcher (`NativeResearchCompletionWatch` + `checkResearchCompletions`,
reading `GET /api/research?live=1`, runs seen working persisted per account) that
raises a local notification (identifier = the push's collapse id
`research-<runId>`, so local and remote never stack) — on the Mac while running
(toast in front, banner behind), on the phone in front and from a
`BGAppRefreshTask` (`com.liammagnier.JunoMobile.research-refresh`). A tap
(`JunoNotificationRoute.research`, `/research/<id>`) opens the report: the Mac's
report window plus the chat behind it; on the phone the chat with the reader
sheet over it. The Mac inbox's research rows route the same way.

Remote push in production needs: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`
(or `APNS_P8`, the .p8 body) on the server (`src/lib/apns.ts`; without them every
APNs send is skipped), optionally `APNS_BUNDLE_ID`; and app builds signed with the
`aps-environment` entitlement and a provisioning profile that has Push (not ad-hoc
or a personal team), so the apps receive a device token to register (the
environment and bundle id ride the registration). Web Push works with
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` pinned (otherwise generated and stored) and
`VAPID_SUBJECT` (`src/lib/notify/web-push.ts`). Without any of it the local
notifications above still fire while the app runs or iOS grants a refresh.

Not changed: a regenerate of a research answer keeps the in-chat path (the
answer being replaced must be superseded by an answer); clients that declare
nothing (web chat, older builds) keep `runDeepResearch`.
