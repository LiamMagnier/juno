# Performance: navigation and long conversations (BRIEF §4–§5)

2026-10-04 · branch `rework/perf` · measured on a production build (`next build && next start -p 3201`), Chrome stable headless, 1440×900 @1x, Apple-silicon laptop, Postgres on loopback.

Everything below was measured with the scripts in this branch. Numbers are from the same script before and after the change. The JSON files hold every request, long task and layout shift. Nothing was measured against the hosted deployment.

## How it was measured

- Seed: `scripts/seed-e2e-user.ts`, then `scripts/perf/seed-perf-data.ts`. This creates a throwaway database `juno_perf_test` with one project, 40 sidebar chats, two Orbit agents with 30-message threads, and a 1,000-message conversation. Messages are encrypted as in production, with code blocks, lists and tables.
- Run: `node scripts/perf/measure-navigation.mjs --runs 3 [--profile remote] --state <storage.json> --out <file>`.
  - The script clicks the real sidebar and page links through Chat → Projects → Project → Library → Customize → Orbit → agent → another agent → Chat. It hovers for 120 ms before each click, as a person does, so intent prefetch gets its chance.
  - **ready** is measured in the page: the first animation frame after the click in which the destination's content is in the viewport at more than 10% opacity. An entrance animation that holds content at opacity 0 counts as not shown.
  - **settled** is the moment the network has been quiet for 300 ms. Favicons, streams and requests stuck for more than 8 s are excluded.
  - The script also records:
    - requests in the window, duplicates, and sequential depth
    - JS bytes transferred
    - long tasks and CLS
    - whether the sidebar `<aside>` and `<main>` DOM nodes survived (shell remount)
    - CDP heap
- Pass 1 is cold (HTTP cache cleared). Passes 2–3 are warm, and the tables report their median.
- Two profiles:
  - `local`: loopback, no throttling.
  - `remote`: 60 ms RTT, 20 Mbit/s down, CPU ×2. This approximates a laptop talking to the hosted server.
- Long conversation:
  - hard load of `/chat/<1,000 messages>`
  - 120 wheel ticks of 600 px up through history
  - Home and End
  - 300 streamed deltas at 25 ms intervals
- For streaming, `fetch` is stubbed in the page, so the product's own SSE parser, `use-chat` and the renderers run without a model.
- Render counts were taken on the development server through a counter that only exists in development (`countTranscriptRender`).
- Bundle attribution: `ALEVR_BUNDLE_SOURCEMAPS=1 next build`, then `node scripts/perf/bundle-attribution.mjs "/(app)/layout" "/(app)/chat/[id]/page"`.

Raw results:

- `perf/navigation-before-local.json`
- `perf/navigation-before-remote.json`
- `perf/navigation-after-local.json`
- `perf/navigation-after-remote.json`
- `perf/build-routes-{before,after}.txt`

## Baseline findings (before)

1. **Cross-section clicks waited on React's Suspense reveal throttle.**
   - `PageTransition` keyed the whole page subtree on the route group. Every Chat → Projects or Orbit → agent click therefore threw away and rebuilt the subtree under the shell.
   - Rebuilt Suspense boundaries are new boundaries, and React shows a new boundary's fallback even inside a transition.
   - After a fallback has been visible, React holds the real content back for 300 ms (`FALLBACK_THROTTLE_MS`, confirmed in the bundled react-dom).
   - Measured on Orbit → agent: the server answered in ~20 ms, the RSC payload had arrived by 64 ms, and the thread was first visible at ~400 ms. The main thread was idle in between (CDP trace).
2. **Viewport prefetch stopped at the loading boundary.**
   - Orbit's cards and the project tiles used `<Link>` viewport prefetch. For a `force-dynamic` route this fetches only up to `loading.tsx`.
   - The click therefore committed the skeleton, which set off the throttle above.
   - Sidebar rows already prefetched in full on hover (`lib/intent-prefetch.ts`). These links did not.
3. **Choreography held rendered content invisible.**
   - Project tiles were in the DOM 47 ms after the click and stayed at opacity 0 until 247 ms. The entrance had a 120 ms base delay plus 50 ms per tile, over 720 ms.
4. **Duplicate and stale reads.**
   - `/api/announcements` was read on every pathname change.
   - `/api/connectors` was read on every conversation open.
   - `/api/projects` was read by five components independently.
   - On every switch from thread A to B, the research run and tasks were also read for **A**. `ChatView` preferred app-wide `activeConversationId`, which a mount effect updates one render late. The same stale read happened on `/chat/B → /chat`.
   - `follow-ups` was posted twice per switch.
5. **Streaming re-rendered settled history.**
   - With ChatGPT's windowing in place, every mounted settled row still rendered once per token on the real `/chat/[id]` route: 205 renders per row for 205 tokens.
   - Cause: `use-chat`'s handlers (`regenerate`, `editAndResend`, …) close over the hook's options object and message array, so they are new functions on every token, and `TranscriptMessage`'s memo saw new props.
   - The 3,000-line composer also re-rendered per token because six of its props were fresh closures. In development it took 404 ms per 200 tokens, more than the transcript itself.
6. **Short conversations were not windowed.**
   - Windowing started at 80 messages. A 30-message agent thread mounted 30 Markdown renderers before first paint.
   - This showed up as a 50 ms task locally and a 107 ms task with CPU ×2 on Orbit → agent.

No shell remounts were found. The sidebar and `<main>` survived every transition before and after. Layout shift was 0 on every transition.

## Changes

| Change | Where |
|---|---|
| Entrance replayed with the Web Animations API on a persistent wrapper. The subtree is no longer keyed or remounted. It leaves no transform behind and does nothing under reduced motion. | `src/components/app/page-transition.tsx` |
| Full intent prefetch on hover and focus with `prefetch={false}` for Orbit cards, project tiles and project chat rows. This also stops each visible tile and card firing its own partial prefetch on load. | `agents-home.tsx`, `project-folders.tsx`, `project-chat-list.tsx` |
| Tile entrance starts on the first frame: 30 ms stagger over 420 ms, no 120 ms hold. | `projects/projects.css` |
| Shared stale-while-revalidate JSON cache. It does one in-flight read per URL, `peek` for an immediate paint, and generation-guarded invalidation tied to the app's existing mutation events (`projects:sync`, `starred:sync`, `juno:agents-changed`, `juno:agent-updated`, `juno:connections-changed`). Used for `/api/projects` (sidebar, Projects, project page, chat scope) and `/api/connectors` (composer with 30 s freshness; the + menu and retry still read fresh; project defaults). Seeds are applied in a layout effect, not the state initialiser, which keeps hydration identical. | `src/lib/client-cache.ts`, callers |
| The Orbit roster paints the last good read, deduplicates the concurrent sidebar and page polls, and a write voids any read that started before it. | `src/components/agents/use-agents.ts` |
| Announcements are re-read at most every 5 minutes on navigation. A read cut short by the next click does not count. | `announcement-popup.tsx` |
| `currentConversationId` uses the route's id first. App-wide state is used only for the chat this view created. | `chat-view.tsx` |
| Stable handler identities: `useLatestHandler` for transcript turn actions and the composer's handlers. The composer is wrapped in `React.memo` and its footnote is memoised. | `src/hooks/use-latest-handler.ts`, `message-list.tsx`, `chat-view.tsx`, `composer.tsx` |
| Windowing starts at 24 messages. The full-transcript switch follows the same constant. | `use-transcript-window.ts`, `message-list.tsx` |
| Inline run placement is computed in one pass. It is the desktop's `ChatWorkPlacement.anchor` rule, ported and tested. Before, it re-parsed every message date per run per token. | `src/lib/chat/transcript-window.ts` |
| Opt-in client source maps for bundle attribution. | `next.config.mjs`, `scripts/perf/bundle-attribution.mjs` |

Removed: nothing user-visible. The keyed `Entrance` component is gone.

## Results: navigation (ms, click → destination content visible)

Warm passes are the median of passes 2–3. Cold is pass 1 after a cache-cleared hard load.

| Transition | local before (warm / cold) | local after (warm / cold) | remote before (warm / cold) | remote after (warm / cold) |
|---|---|---|---|---|
| Chat → Projects | 247 / 264 | **97 / 114** | 328 / 613 | **130 / 428** |
| Projects → Project | 97 / 380 | **89 / 95** | 244 / 495 | **178 / 192** |
| Project → Library | 62 / 64 | 64 / 63 | 79 / 92 | 78 / 79 |
| Library → Customize | 64 / 65 | 65 / 66 | 62 / 73 | 65 / 60 |
| Customize → Orbit | 131 / 131 | **114 / 129** | 261 / 545 | **179 / 460** |
| Orbit → agent | 404 / 401 | **81 / 97** | 369 / 452 | **138 / 163** |
| agent → another agent | 120 / 403 | **71 / 365** | 404 / 511 | **164 / 164** |
| agent → Chat | 43 / 48 | 39 / 38 | 80 / 73 | 65 / 60 |

Requests per transition (cold pass, API only):

- Orbit → agent: 5 → 3
- agent → another agent: 8 → 3, and the duplicate `follow-ups` POST is gone
- agent → Chat: 4 → 0
- Chat → Projects: 2 → 1
- Projects → Project: 7 → 4

Honest caveats:

- **Cold agent → another agent (local) still hits 365 ms.** When the hover prefetch of a sidebar row has not landed, the route's `loading.tsx` commits and React's 300 ms throttle applies. Remote cold did not hit it in this run. The fix is either a FULL prefetch that is guaranteed to win the race, or dropping that segment's `loading.tsx`. That second option is a UX decision (no skeleton on slow servers) and is listed under next steps.
- **Cold first visits to Projects and Orbit on the remote profile (~430–460 ms) are dominated by downloading the route's chunks** plus the page's own first `/api/*` read. This pass did not reduce bundles (see below).
- Library and Customize were already fast and are unchanged.

## Results: hard loads and bundles

| | before | after |
|---|---|---|
| `/chat` hard load, ready (local / remote) | 199 / 389 ms | 215 / 379 ms |
| JS transferred on `/chat` hard load | 1,041 KB | 1,038 KB |
| First-load JS `/chat` · `/chat/[id]` · `/projects` · `/agents` (build output) | 734 · 770 · 280 · 309 kB | 736 · 771 · 281 · 309 kB |

Bundles did not shrink. Attribution with source maps names where the weight is. All figures are minified, before gzip:

- **Every page's shell:**
  - **zod, 74 KB**: only through `app-sidebar → lib/agents/domain.ts`, whose request schemas are top-level `z.object` calls.
  - **`lib/models.ts`, 52 KB**: through `app-provider`.
  - `motion-dom`, 100 KB.
  - The Code session hook and generated protocol, ~36 KB: through `app-sidebar → code/use-code-runs`.
  - `thinking-orbs`, 25 KB: through `work-vocabulary → phase-orb`.
  - The dot engine: through `notifications → empty-state`.
- **Chat:** `use-realtime-voice` + `voice-glow` (~60 KB) load with every conversation.

Moving the agent request schemas into a server-only module would take zod out of every page. That touches 21 importers owned by the Orbit lane, so it was left as a coordinated next step rather than done under them.

## Results: 1,000-message conversation

| | before | after |
|---|---|---|
| Hard load ready (local / remote) | 394 / 927 ms | 372 / 882 ms |
| Rows mounted / DOM elements after load | 7 / 1,790 | 7 / 1,791 |
| Scroll 120×600 px up: p95 frame, long tasks (local) | 16.7 ms, 0 | 16.7 ms, 0 |
| Scroll, remote profile: max frame, frames > 25 ms | 100 ms, 4.7% | 33 ms, 2.2% |
| Stream 300 deltas: main-thread script time (local / remote) | 0.9 / 1.7 s | 0.7 / 1.1 s (best run 0.5 / 0.9) |
| Stream: long tasks, frames > 50 ms | 0, 0 | 0, 0 |
| Settled-row renders per streamed token on `/chat/[id]` (development counter) | 1 per mounted row (205 per row for 205 tokens) | 0 (≤1 per row, only on the busy start and end) |
| Composer render time per 200 tokens (development profiler) | 404 ms | 54 ms |

Windowing was already in place in the baseline: 7 rows mounted out of 1,000. The work here verified it and removed the per-token re-rendering of settled rows.

Hard-load cost of a long conversation is dominated by its route payload. The RSC response carries all 1,000 decrypted messages, 878 KB uncompressed. That is the next real cost (see next steps).

Frame-time numbers on this machine sit at the 60 Hz cap in headless Chrome. Long tasks, script seconds and render counts are the discriminating measures. Frame times are reported as measured, not as a smoothness claim for slower hardware.

## Virtualization: what was verified

Verified on the development server unless noted.

- **Dynamic heights.**
  - Rows are measured with `ResizeObserver`. Estimates are used only for rows that have never mounted.
  - A card above the reader growing by 520 px leaves the line being read within 2 px. A new benchmark fixture is a research-sized inline card after turn 900 (`e2e/transcript-window.spec.ts`).
  - Covered by unit tests for media and research height changes, reordering, and invalid measurements (`tests/transcript-window.test.ts`).
- **Stable anchoring while streaming.**
  - A reader parked on message 42 stays within 2 px through 120 streamed updates.
  - Follow mode stays pinned to the bottom.
- **Streaming isolated from settled history.**
  - In the benchmark, the streaming row rendered 244 times while settled rows rendered at most 4 (StrictMode doubles counts).
  - On the real route, only the streaming row renders per token (`e2e/transcript-route.spec.ts` asserts it).
- **Find in chat.**
  - "perf-anchor-42", about 950 turns above the bottom and unmounted, mounts and is centred within 4 px on the real route.
  - Global-search deep links use the same `focusTranscriptMessage` path.
- **Research, task, artifact and tool cards.** Inline runs live inside the measured row of the turn they follow, so their height counts and they keep the reader's anchor.
- **Keyboard.**
  - Home and End jump the whole history.
  - A focused control keeps its row mounted when wheel scrolling moves the window away.
- **Screen readers.**
  - A "Read full conversation" switch, reachable by keyboard, mounts every row and can be reversed.
  - The transcript stays a named `role="log"` with `aria-live="off"`, plus one polite completion announcement.
  - Known limit: in compact mode, Tab moves from the last mounted row to the composer and skips unmounted rows. The full-transcript switch exists for that.
- **Desktop concepts reused.**
  - The run-placement rule (`ChatWorkPlacement.anchor`).
  - The index-gated entrance: old rows scrolled back into view do not replay their entrance (`DesktopMessageRise`).
  - Centre-on-jump for find.

## Tests

| Command | Result |
|---|---|
| `npx tsx --test tests/transcript-window.test.ts tests/client-cache.test.ts` | 10/10 pass |
| `PERF_STORAGE_STATE=<state> PERF_LONG_CONVERSATION_ID=<seeded> npx playwright test --config scripts/perf/playwright.perf.config.ts e2e/transcript-window.spec.ts e2e/transcript-route.spec.ts` (development server, port 3201) | 6/6 pass |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` | clean |
| `npx eslint <changed files>` | clean |
| `next build` (production) | succeeds |
| Hydration check on `/chat`, `/library`, `/projects`, `/agents`, `/customize`, `/chat/<long>` | no React errors |

The hydration check caught a #418 caused by seeding from the cache in a state initialiser. That was fixed by seeding in a layout effect.

## Paged history (Workstream I, 2026-10-14)

Measured on a production build (`ALEVR_BUNDLE_SOURCEMAPS=1 next build && next start -p 3201`), Chrome stable headless, 1440×900, Postgres 17 on loopback in a throwaway database. Before and after are the same fixture and the same script.

**Fixture.** `scripts/perf/seed-perf-data.ts` now also seeds `perf-long-2000`: 2,000 messages. Every fourth reply carries a run of three tool calls with arguments and results (encrypted activity), every tenth carries web sources, and every twentieth question carries an image and a PDF (100 attachments). Find and jump anchors are `perf-anchor-6` (near the top) and `perf-anchor-1500`.

**Script.** `node scripts/perf/measure-chat-history.mjs --runs 5 --profile local|remote --state <storage.json> --out <file>`.
- Five cold hard loads of `/chat/<id>`, with the cache cleared and starting from `about:blank`.
- The route's RSC payload and HTML document timed to last byte from Node with the session cookie.
- A wheel scroll to the very top.
- Find `perf-anchor-6` from a fresh load.
- A `?m=` deep link to message 6.

**Attribution.** `node scripts/perf/loaded-attribution.mjs --bucket early|late` attributes the scripts the browser actually fetched before (early) or after (late) DOMContentLoaded, through source maps. The build manifest that `bundle-attribution.mjs` reads lists chunks the page never fetches, and it misses that a Server Component's `next/dynamic` does not split a Client Component.

Raw results: `perf/history-{before,after}-{local,remote}.json`, `perf/loaded-history-{before,after}-{early,late}.txt`, `perf/build-routes-history-{before,after}.txt`, `perf/bundle-history-{before,after}.txt`.

### Baseline (before)

- **The whole conversation was in the route payload.** `/chat/[id]` decrypted and serialised all 2,000 messages into the RSC.
  - Payload: 3.5 MB.
  - HTML document: 4.26 MB decoded, 194 KB gzipped.
  - Server time to last byte: 108 ms (RSC) and 158 ms (HTML), against 3–20 ms to first byte.
- **The dropped-stream recovery poll** read the same whole thread every few seconds for up to an hour.
- **Code and voice modules shipped with every conversation:**
  - **Code session surface (~150 KB minified):** `code-session-view`, `run-review`, `code-run-cards`, the session composer and banner, and the agent-protocol code. They were fetched before DOMContentLoaded on every chat, although `page.tsx` imported them through `next/dynamic`. Called from a Server Component, that does not split a Client Component.
  - **`voice-glow` (38.5 KB minified):** the whole library, imported only for its six-line `getAudioContext`. The dev voice labs use the library's `VoiceBeam`, so webpack kept the entire module in the shared chunk.
- **zod (75 KB) is in the client graph legitimately.** `chat/context-tokens`, the semantic deliverables and `work/skills` parse with it at runtime. The agent request schemas in `lib/agents/domain.ts` are about 6 KB of it. Moving them would not remove zod, so they were left.

### Changes

| Change | Where |
|---|---|
| Cursor paging over `(createdAt, id)`, a total order, so tied timestamps neither skip nor repeat. The first page is the newest 60 messages and older pages are 120. A page is widened back to the question that opens its turn, so a turn is never split. `through` reaches back to a message; `all` returns the rest. | `src/lib/chat/history-page.ts` |
| `/chat/[id]` opens on the newest page. A `?m=` deep link widens that page to reach its message, so the jump renders with the route. The legacy Code surface still reads the whole thread. | `chat/[id]/page.tsx`, `lib/queries.ts` (`getConversationThreadPage`, `getConversationHistory`) |
| `GET /api/conversations/[id]/messages?before=&limit=&through=&all=1`: owner-scoped (another account's conversation is a 404, with or without a valid cursor) and parameters validated. | `api/conversations/[id]/messages/route.ts` |
| `GET /api/conversations/[id]` is unchanged without parameters. The Mac and iPhone apps read it whole (`NativeThreadClient.swift`), and its whole-thread order now tie-breaks on id. `?limit=N` returns the newest page plus `history`. The web recovery poll uses `?limit=40`. | `api/conversations/[id]/route.ts`, `use-chat.ts` |
| `use-chat` holds `history` and `loadOlderMessages`, one request at a time. A refreshed newest page (`router.refresh`, sync) keeps the history the reader already scrolled back through, but only when the two overlap. | `use-chat.ts`, `lib/chat/history-merge.ts` |
| The next page is requested about two screens before the top. Rows landing above the reader hold the reader's line by key. In the commit where a page lands, the window is drawn at the anchored position. Rows that have never been measured are measured before paint, so their first layout cannot move the line. | `use-transcript-window.ts`, `message-list.tsx` |
| History that lands above does not replay its entrance. Runs placed before every loaded question wait for their turn instead of drawing at the foot. | `message-list.tsx` |
| Find, the full-transcript switch, the outputs panel and fork bring in the rest of the conversation when used. Find still searches on the client and adds no server search surface. Jumping (rail, find, links) to an unloaded message reads back to it first. | `conversation-find.tsx`, `session-outputs.tsx`, `chat-view.tsx`, `use-transcript-window.ts` |
| The Code session view is split behind a Client Component `next/dynamic`. | `components/code/code-session-view-lazy.tsx` |
| `getAudioContext` is local, so the product no longer imports `voice-glow`. The dev labs still do. | `src/lib/audio-context.ts` |

No component, style or layout changed.

### Results: first load of the 2,000-message conversation (median of 5 cold loads)

| | local before | local after | remote before | remote after |
|---|---|---|---|---|
| Ready (first transcript row) | 399 ms | **192 ms** | 874 ms | **372 ms** |
| Document fully received (`responseEnd`) | 250 ms | **47 ms** | 296 ms | **82 ms** |
| DOMContentLoaded | 302 ms | **62 ms** | 405 ms | **277 ms** |
| HTML document, transferred (gzip) | 194 KB | **45 KB** | 194 KB | **45 KB** |
| HTML document, decoded | 4,262 KB | **330 KB** | 4,262 KB | **330 KB** |
| RSC payload, soft navigation (decoded) | 3,547 KB | **148 KB** | — | — |
| Server, to last byte: RSC / HTML | 108 / 158 ms | **15 / 36 ms** | — | — |
| Server, to first byte (Navigation Timing) | 19 ms | 24 ms | 19 ms | 18 ms |
| JS transferred, cold | 1,224 KB | **1,169 KB** | 1,216 KB | **1,169 KB** |
| Everything transferred | 1,734 KB | **1,538 KB** | 1,738 KB | **1,549 KB** |
| Long tasks during load (count / total / max) | 0 / 0 / 0 | 0 / 0 / 0 | 3 / 247 / 93 ms | 3 / 221 / 94 ms |
| DOM elements after load | 2,174 | 1,851 | 2,137 | 1,845 |
| Settled (network quiet 300 ms) | 754 ms | 851 ms | 2,124 ms | 1,990 ms |

- **First-load scripts** (attributed, fetched before DOMContentLoaded): 84 scripts and 3,026 KB minified before, 80 scripts and 2,845 KB after. The Code session surface and `voice-glow` are gone. `next build` reports `/chat/[id]` first-load JS at 864 → 817 kB.
- **`?m=` deep link to message 6:** visible at 778 → 427 ms locally and 1,830 → 1,772 ms remote. That link needs nearly the whole conversation, so its document is the same size as before.

### What got slower, as measured

- **Find on a phrase near the top, from a fresh load:** 94 → 257 ms locally and 167 → 1,564 ms remote. Find now fetches the rest of the conversation first: one request of about 2.8 MB, because route-handler JSON is not compressed by `next start`. The first load no longer pays that cost for everyone, but the one person who searches does. Compressing API responses (or a proxy that does) would cut most of it.
- **Scrolling from the newest message to the very first:** 17 history requests, 2.9 MB uncompressed. Long tasks: 2 (108 ms total) locally, and 14 (1.36 s total, max 129 ms) on the remote profile with CPU ×2, against 0–1 before. Each landing page costs one task to parse, merge and lay out. That is spread across the scroll rather than paid up front, but a page is not free on slow hardware. Smaller older pages, or merging off the render path, are the next step.
- **Settled time locally:** 754 → 851 ms. The page now requests the next older page only when the reader is near the top, so this is not history traffic. It is within run-to-run variance of this metric, and the remote profile improved.

### Anchoring, verified

`e2e/transcript-history.spec.ts` runs on the production build and on the development server: 5/5 on each.
- The first load does not contain old turns.
- Three successive pages land above a reader parked near the top, and the reader's row stays within 2 px. Measured drift is 0.6 px. Before the measure-before-paint fix it was 213 px: the first page's new rows rendered at their real heights while the layout still had estimates.
- The top is reachable, and all 2,000 distinct rows render.
- Find reaches an unloaded phrase and centres it.
- `?m=` opens on message 1,500.

The existing `e2e/transcript-window.spec.ts` and `e2e/transcript-route.spec.ts` still pass (6/6). They cover streaming re-rendering only its row, find on the 1,000-message chat, card growth above the reader, and the full-transcript switch.

### Tests

| Command | Result |
|---|---|
| `npx tsx --test tests/chat-history.test.ts tests/transcript-window.test.ts` | 19/19 |
| `HISTORY_TEST_DATABASE_URL=<throwaway> NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/chat-history-paging.integration.test.ts` | 9/9 against Postgres 17 |
| `npx tsx --test tests/*.test.ts` | 6,886 pass, 0 fail, 140 skipped |
| `npm run typecheck` | clean |

The integration test runs the real routes. It covers:
- the native contract (no `history` key, every message, in order);
- a cursor walk that returns each message exactly once, with tied timestamps;
- attachments without `extractedText`;
- bodies stored as ciphertext;
- `through`, `all` and `?m=`;
- owner scoping and malformed parameters.

### Known limits

- **The outputs chip's count of generated images** covers loaded history until the panel is opened. Opening it loads the rest. Artifacts were always complete.
- **The file viewer's switcher** lists files from loaded history.
- **The rail and the scrollbar** describe the loaded part of a long conversation. Each grows as history arrives.
- **The legacy Code surface** (`?surface=legacy`) and `/code/[id]` still read whole threads.

## Security considerations

- The client cache holds only the signed-in user's own GET responses, in memory, for one page load. It is never persisted, never keyed across accounts, and signing out is a full navigation.
- Invalidation rides the app's existing mutation broadcasts. A read that started before a write cannot repopulate the cache (generation guard, tested).
- `useLatestHandler` changes only handler identity; the same closures run.
- No server route, permission check or payload changed.
- The perf seed writes only to a throwaway database named by `DATABASE_URL`.
- `productionBrowserSourceMaps` is off unless `ALEVR_BUNDLE_SOURCEMAPS=1` is set.

## Remaining blockers

- No hosted-deployment measurement. Real database round trips are 20–40 ms and are not reproduced by loopback; the remote profile emulates the network, not the database.
- A screen-reader pass with a real assistive-technology user has not been done.

## Next milestone

1. Make the `/chat/[id]` cold path never show a fallback: guarantee a FULL prefetch before click, or remove that segment's `loading.tsx` and give pending feedback on the clicked row (`useLinkStatus`).
2. Take zod out of the shell by moving the agent request schemas to a server-only module. Lazy-load voice (`use-realtime-voice`/`voice-glow`) and the Code session hook from the sidebar.
3. ~~Page the conversation payload~~ (done, "Paged history" above). Follow-ups: compress route-handler JSON so find and long scroll-backs pay less, and cut the per-page long task on slow hardware.
4. Re-run `scripts/perf/measure-navigation.mjs` against the hosted deployment with a test account, and record the result in `src/lib/capabilities.ts`.

## References

- Next.js `<Link>` prefetch: https://nextjs.org/docs/app/api-reference/components/link#prefetch
- Next.js `staleTimes` (client router cache): https://nextjs.org/docs/app/api-reference/config/next-config-js/staleTimes
- React `<Suspense>`: https://react.dev/reference/react/Suspense. The 300 ms reveal throttle is `FALLBACK_THROTTLE_MS` in `react-dom-client` as bundled by Next 15.5.
