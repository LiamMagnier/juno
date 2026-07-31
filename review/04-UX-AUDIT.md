# 04 — UX audit

**Method.** Ran the app locally (`npm run dev`) against a fresh PostgreSQL 17 database rather than the production Supabase instance the `.env` points at, so nothing here wrote to real user data. Signed up as a new user, drove the app with Playwright/Chromium at 390 / 768 / 1440 px in light and dark, captured 70+ screenshots (`review/screenshots/`), and audited the live DOM for landmarks, live regions, focus order, touch targets and computed contrast. Contrast ratios below are computed from the design tokens in `src/app/globals.css`, not eyeballed.

**Caveat on performance numbers:** everything was measured against `next dev`, which compiles routes on first request and ships an unminified bundle. Latency figures are directional only and are labelled as such.

---

## 1. The honest overall read

**This does not look like accumulated shadcn defaults.** It looks like a designed product with a point of view — warm paper (`48 33% 97%`) rather than the category's default cool grey, Newsreader serif for the entire UI including body prose, JetBrains Mono for metadata, one coral accent used sparingly, no all-caps anywhere, and a film-grain overlay at 2.2% opacity. Set the landing page (`01-landing-desktop-light.png`) next to ChatGPT, Claude.ai or T3 Chat and it is immediately distinguishable, which is genuinely rare in this category.

The craft holds up under inspection: type scale is size-driven rather than weight-driven and the jumps are large enough to read as hierarchy; the dark theme is a warm charcoal with a coral glow behind the composer rather than an inverted light theme (`32-conversation-dark.png`); the transcript is deliberately flat while the chrome carries glass and depth, and that discipline is maintained.

Three things undercut it:

1. **The empty state teaches nothing.** A brand-new user sees a greeting and a text box. No capability hints, no starter affordances, no indication that Canvas, connectors, voice, projects or a code agent exist. The design doc records that starter pills were deliberately removed (`docs/JUNO.md:249-251`) and the resulting screen *is* calmer — but the product has roughly fifteen features and the first screen advertises none of them.
2. **Error states are louder and more numerous than success states.** The provider-failure path renders the same message twice, once as a toast that overlaps the user's own message and once as an inline card.
3. **The accessibility layer is largely absent** on the one surface that most needs it — a streaming message log with no live region and no headings.

---

## 2. First-run experience

`02-signup-desktop-light.png` → `10-first-run-onboarding-desktop-light.png` → `20-chat-empty-desktop-light.png`

**Time to first message: fast.** Name, email, password, submit, and you land on `/chat` with the composer focused. No email verification wall, no onboarding carousel between you and the product. That is the right call and several competitors get it wrong.

**What a new user must understand before getting value:** more than they are told.

- **A free account cannot send a single message.** `FREE.monthlyMessages = 0` (`src/lib/plans.ts:33`). The composer is fully interactive — placeholder, model picker, effort selector, attach button, voice button — and the paywall lands *after* they type and press Enter. The upgrade page's Free column even lists "Canvas & artifacts" and "File & image uploads" as included features, which cannot be exercised with zero messages.
  **Fix:** state the constraint on the empty state itself, and either disable Send with an inline explanation or let Free users have a small trial allowance. Selling a plan whose listed features are unreachable is the single most damaging first-run problem here.
- **The send button is a waveform icon, sitting immediately beside a microphone icon** (`20-chat-empty-desktop-light.png`, bottom right of the composer). Two audio-looking glyphs adjacent, where one is "dictate" and the other is "start a voice conversation" — and the actual Send affordance only appears once text is entered (the morphing Voice → Send → Stop control). A first-time user looking for "how do I send this" sees no send button.
  **Fix:** keep the morph, but show a disabled send arrow at rest rather than a second audio glyph, or move the voice-conversation button out of the composer's action cluster.
- **The reasoning-effort control is an unlabelled value.** It reads `High` with a chevron and nothing else (`20-chat-empty-desktop-light.png`). `High` what? Its `aria-label` is correct (`"Thinking effort: High; Flash mode off"`) but sighted users get only the value.
  **Fix:** a mono eyebrow `Thinking` above or before the value, matching the label pattern used elsewhere in the design system.

**What the empty state does well:** the time-aware personalised greeting (`Burning the midnight oil, Liam` at 02:00, `Late-night thoughts, Liam`, `Can't sleep?, Liam`) is a small, cheap, genuinely charming touch, and it is the kind of thing that makes a product feel made by a person.

---

## 3. The chat surface

`29-answer-complete.png` is the product working. It is good.

**What's right:**
- **The message footer is the best thing in the product**: `Mistral Medium 3.5 · 7.3K tokens · $0.037`. Per-message model attribution *and* real cost, on every turn. Almost nothing in the hosted consumer market does this — see [05-MARKET-STUDY.md](05-MARKET-STUDY.md). It directly delivers the landing page's promise ("the real cost of every answer on the receipt") and it is a defensible differentiator, not a nice-to-have.
- **Code blocks**: language label, line numbers, a Copy button, theme-aware highlighting, hairline chrome. Clean and legible.
- **Message actions**: copy, regenerate, branch, fork privately, 👍/👎, read aloud — all present, all keyboard-focusable (`tabIndex: 0`, verified in the live DOM), all 32×32.
- **The flat-transcript rule is upheld.** User turns are right-aligned `bg-secondary` bubbles; assistant turns are full-width prose with no card. The reading column is comfortable.
- **Auto-scroll behaviour** is the "follow only if already at the bottom" rule with a 24 px re-attach slop. The reasoning behind it is documented at `docs/JUNO.md:258-279` and it is correct — this is a problem most chat UIs get wrong twice before getting right, and Juno has already been through both failure modes.

**What's wrong:**

### 3.1 The error toast overlaps the user's own message — **High**
`29-answer-complete.png` (first capture, provider failure): the red toast renders top-centre and covers the right-aligned user bubble, making the message that caused the error unreadable. Toasts are positioned in the viewport centre-top while the transcript's newest content is also at the top of the scroll area.
**Fix:** move toasts to bottom-right (or bottom-centre above the composer), where they cannot collide with the newest message.

### 3.2 The same error is shown twice — **Medium**
Once as a toast, once as an inline card with a `Try again` button. The inline card is the better affordance — it is anchored to the failed turn and it is actionable. Drop the toast for errors that already render inline.

### 3.3 Provider billing state is shown to the end user — **Medium**
*"OpenAI · GPT reports no remaining balance or quota. Top up that account, or pick another model."* A paying customer cannot top up Juno's OpenAI account. Full reasoning in [01-CODE-REVIEW.md](01-CODE-REVIEW.md) §2.2.

### 3.4 "Thought process … 1m 5s" on a model with no visible reasoning — **Low**
`29-answer-complete.png`. Mistral Medium emitted no reasoning parts, yet the panel header reports a 1m 5s duration next to the label "Thought process". The docs are explicit that the panel is designed so "the form cannot lie" (`docs/JUNO.md:386-388`) — this is the one place where the label outruns the content. Consider "Run · 1m 5s" when there are no reasoning parts.

### 3.5 After a failed generation the URL stays on `/chat` — **Low**
Reproduced twice. The conversation *is* created (it appears in the sidebar) but `window.location` remains `/chat`, so a refresh lands on a new empty chat and the failed thread is only reachable from the sidebar. Deep links themselves work correctly — I verified `/chat/<id>` renders the full transcript on a cold load in a fresh context.

### 3.6 Time to first token — **directional, needs a production measurement**
`5.8 s` TTFT and `68 s` total for a short two-part answer, measured on `next dev` against Mistral Medium with thinking enabled. The dev server's first-request compilation dominates the first number, so this is **not** a production figure. It is worth measuring properly, because 5.8 s to first token would be a serious problem and the architecture (no serverless timeout, 15 s heartbeat, streaming from the first chunk) suggests it should be well under 1 s.

### 3.7 Long-conversation navigation — **not testable, and that is itself the finding**
There is no jump-to-top, no message minimap, no conversation outline, and search is **title-only** because message bodies are encrypted at rest (`docs/JUNO.md:1013`). In a 200-turn conversation there is no way to find anything. Competitors have converged on in-conversation search (see [05](05-MARKET-STUDY.md)); the encryption decision forecloses the obvious implementation.
**Fix worth considering:** a client-side index built from the decrypted transcript already in memory, scoped to the open conversation. That gets 80% of the value without weakening at-rest encryption.

---

## 4. Visual craft, state by state

| State | Verdict |
|---|---|
| **Loading / skeleton** | Not observed on any route — pages render server-side and appear complete. Good. |
| **Streaming** | The `.stream-tail` gradient mask on the line being written is a genuinely elegant solution; no trailing caret, no jitter. |
| **Empty** | Consistent across Projects / Memory / Library / Artifacts / Tasks / Connections, all with a one-line explanation. Calm, but see §2 — none of them teach the feature. |
| **Error** | See §3.1–3.3. |
| **Offline** | Not handled. No offline banner, no queued send, no service worker. A dropped connection mid-stream shows a generic failure. |
| **Rate-limited** | 429 with a plain-text message. Not styled distinctly from other errors, and no retry-after countdown. |
| **Quota exceeded** | 402 with `QUOTA_EXCEEDED` and an upgrade prompt. Correct. |
| **Unauthenticated** | Redirects to `/sign-in`. Clean. |
| **Mid-upload / failed upload** | Not reached in this pass — **UNVERIFIED**. Needs a manual check with a large file and a forced S3 failure. |
| **Dark mode** | Excellent (`32-conversation-dark.png`). A genuine warm-charcoal theme with its own coral glow, not an inversion. Contrast on body text is 15.55:1. |

### 4.1 Contrast failures — **Medium, WCAG 1.4.3 (AA)**
Computed from the tokens:

| Text | Ratio (light / dark) | AA needs | Verdict |
|---|---|---|---|
| `--foreground` on `--background` | 15.62 / 15.55 | 4.5 | ✅ excellent |
| `--muted-foreground` on background | 5.35 / 7.05 | 4.5 | ✅ |
| **`muted-foreground/60` at 11 px** — the message model/token/cost footer and the `"Juno can be wrong…"` disclaimer | **2.44 / 3.33** | 4.5 | ❌ **fails both themes** |
| `--primary` (coral) on background | 3.87 | 4.5 small / 3.0 large | ⚠️ passes for headlines, fails for small coral text |

The failing element is, ironically, the cost receipt — the product's best differentiator is rendered at the one opacity that makes it unreadable for anyone with reduced vision.
**Fix:** drop the `/60` modifier. `--muted-foreground` at full opacity already passes comfortably in both themes.

### 4.2 Text-input focus indicator fails non-text contrast — **Medium, WCAG 1.4.11 (AA)**
`docs/JUNO.md:309-316` records a deliberate decision: text fields opt out of the global focus ring and instead darken the border to `border-foreground/30`, because browsers grant `:focus-visible` to inputs on *pointer* focus and the previous coral ring "bloomed" on every click.

The diagnosis was right; the fix went too far. `foreground/30` over the card computes to **1.90:1**, below the 3:1 required for a focus indicator. The coral ring it replaced was 4.08:1.
**Fix:** keep the pointer-focus complaint solved by scoping the ring to `:focus-visible:not(:hover)` or using `@media (any-pointer: coarse)` gating — but restore an indicator that reaches 3:1. `border-foreground/60` would be ~2.9; `foreground/70` clears it.

### 4.3 Model chip truncates mid-word on mobile — **Low**
`20-chat-empty-mobile-light.png` at 390 px: `Claude Sonne` — clipped with no ellipsis. Add `text-overflow: ellipsis` or shorten the label at narrow widths.

### 4.4 The parameters popover clips the greeting — **Low**
`23-model-picker.png`: the Parameters panel overlays and cuts the centred `Late-night thoughts, Liam` heading. Cosmetic, but it is the first thing you see when opening the panel from an empty chat.

### 4.5 The Max ×5 / ×20 toggle is low-affordance — **Low**
`41-upgrade-desktop-light.png`: the ×20 option is rendered light enough to read as disabled. On the highest-revenue control in the product.

---

## 5. Accessibility — WCAG 2.2 AA

Audited against the live DOM of a real conversation.

### 5.1 The streaming transcript is not a live region — **High, WCAG 4.1.3 Status Messages**
```
[role=log]     → 0
[role=status]  → 0
```
`aria-live="polite"` exists on conversation *titles* and on the "Thought process" summary, but **not on the assistant message being streamed**. A screen-reader user gets no announcement that a reply has started, is arriving, or has finished. For a product whose entire interaction model is "text arrives asynchronously", this is the single most consequential accessibility gap.
**Fix:** wrap the transcript in `role="log" aria-live="polite" aria-relevant="additions"`, and announce completion separately via a visually-hidden `role="status"` ("Response complete, 340 words") rather than streaming every token to the screen reader.

### 5.2 No headings anywhere on the chat surface — **Medium, WCAG 1.3.1 / 2.4.6**
`document.querySelectorAll("h1,h2,h3,h4")` → `[]`. No `<h1>`, no heading structure at all. Screen-reader users navigate by heading; there is nothing to navigate. There is also no `<header>` landmark (`main`: 1, `nav`: 1, `aside`: 1, `header`: **0**).
**Fix:** a visually-hidden `<h1>` carrying the conversation title, and `<h2>`-level markers per turn (`"You said"` / `"Juno replied"`), visually hidden.

### 5.3 What passes — worth recording
- **Every button has an accessible name.** Zero buttons without one, across the whole chat surface. That is unusual and it is the hard part.
- **Every `<img>` has `alt`.** Zero missing.
- **Focus indicators are present** on all non-text-input controls: 2 px solid outline.
- **Focus order is logical** and there are no keyboard traps — a 26-step Tab walk moved composer → sidebar → conversation list → user menu → share, with no dead ends.
- **Message action buttons are keyboard-reachable** (`tabIndex: 0`, visible, not `pointer-events: none`) — I expected hover-only actions here and was wrong.
- **RTL is implemented**, not faked: `dir="rtl"` is set and the entire layout mirrors (see §7).
- **`prefers-reduced-motion` is respected** and the design system gates on `prefers-reduced-transparency` and `prefers-contrast` too (`docs/JUNO.md:323-325`).

### 5.4 Touch targets — **Low, WCAG 2.5.8**
Only three controls fall under 44×44 on mobile: the Juno mark button at **21×21**, and two at 40×40 (`Leave private chat`, the thinking-effort chip). AA's minimum is 24×24, so all three technically pass AA; only the 21×21 mark misses it.

---

## 6. Mobile web

`20-chat-empty-mobile-light.png`, `33-conversation-mobile.png`, `34-mobile-composer-focus.png`

- Layout adapts correctly: sidebar becomes a sheet, header collapses to hamburger + search + new-chat.
- **Vertical centring is off in the empty state.** The greeting and composer sit at roughly 55% of viewport height with a large void above and a smaller one below, on a 390×844 viewport. At desktop the same layout reads as deliberate; on a tall phone it reads as a bug.
- **Safe areas**: `pt-safe`/`pb-safe` utilities exist in the design system. Not verifiable in Chromium headless — **UNVERIFIED**, needs a real iPhone with a home indicator.
- **Composer with keyboard open**: not reproducible in headless Chromium — **UNVERIFIED**. This is the highest-value manual mobile check remaining, because the composer is bottom-fixed and iOS Safari's `visualViewport` behaviour is where these break.
- Touch targets: see §5.4.

---

## 7. Copy and i18n

Spot-checked `fr-FR`, `ar-SA` and `ja-JP` via `Accept-Language`.

**What works — and it is impressive.** The catalog translation is real: nav labels, the user menu (`المالك الخطة` for "Owner plan"), and the disclaimer all render translated. `dir` flips to `rtl` for Arabic and the **entire layout mirrors correctly** — sidebar to the right, icons flipped, composer controls reversed (`39-locale-ar.png`). Most products that claim RTL support do not do this.

**Three bidi bugs, all in the same class — LTR strings placed in an RTL container without isolation:**

### 7.1 The greeting is untranslated *and* bidi-mangled — **Medium**
`39-locale-ar.png` renders `Liam ,?Can't sleep` — the comma and question mark have migrated to the wrong end of the string. The greeting is generated dynamically (personalised, time-aware) so it is not in the static catalog, and as raw LTR text inside `dir="rtl"` the neutral punctuation reorders.
**Fix:** wrap dynamic LTR content in `<span dir="ltr">` (or `<bdi>`), and add the greeting variants to the translation catalog.

### 7.2 The composer placeholder is untranslated and flipped — **Medium**
`...Message Juno` with the ellipsis on the left. Same root cause; same fix. This is the most-seen string in the product.

### 7.3 Conversation titles truncate from the wrong end — **Medium**
Sidebar shows `…efinition and Implementation` and `…xplanation and Binary Search` — the ellipsis is at the *start* and the beginning of the title is cut. `text-overflow: ellipsis` on an LTR string inside an RTL container truncates the logical start.
**Fix:** `<bdi>` around user-generated titles, or `dir="auto"` on the title element.

**Copy quality generally:** the voice is consistent and good — `"Juno can be wrong — worth a second look on anything that matters"`, `"Create an account and look around"`, `"For teams of one who never stop"`. It reads as written by one person with a point of view, which is an asset. Error messages are actionable except where they leak vendor state (§3.3).

**One tonal inconsistency:** the legal pages are French-only (`/legal/cgu`, `/legal/confidentialite`, `/legal/mentions-legales`) while the entire product is English. See [03](03-PRODUCTION-READINESS.md) §5.2 — this is a legal issue before it is a UX one.

---

## 8. Performance as felt

Not measured under production conditions; treat all of this as directional and re-measure against a `next build`.

| Signal | Observation |
|---|---|
| Bundle | Measured from a real `next build`: **102 kB shared First Load JS** — that part is lean. Individual routes are not: `/memory` **419 kB**, `/share/[token]` **399 kB**, `/projects/[id]` 239 kB, `/tasks` 186 kB. The `/chat` figure was truncated out of my captured output (**UNVERIFIED**, but it is the heaviest surface in the app, so assume ≥ 419 kB). A 400 kB first load on a share page — a public, unauthenticated, read-only snapshot — is the clearest single win available: it pulls in the whole `SandboxFrame` + markdown + KaTeX + highlight.js stack to render static text. Worth a `@next/bundle-analyzer` pass. |
| Client components | 127 of 440 files (29%). Reasonable for this app. |
| Hydration | One mismatch warning at 768 px ([01](01-CODE-REVIEW.md) §5.5). None at 390 or 1440. |
| CSS | `src/app/globals.css` is 2,637 lines / 110 KB of hand-written CSS in a Tailwind project, all of it in the critical path. Splitting it ([01](01-CODE-REVIEW.md) §5.6) would let most of it be deferred. |
| TTFT | ~5.8 s on `next dev` — dominated by route compilation, not representative. |
| Console errors | Zero on every authenticated surface across both themes. Clean. |
| Network errors | Zero 4xx/5xx on any real route across the full sweep. |

---

## 9. Ranked

| # | Finding | Severity | Surface |
|---|---|---|---|
| 1 | Free plan cannot send a message; composer gives no warning; upgrade page lists unreachable features | **High** | empty chat, `/upgrade` |
| 2 | Streaming transcript is not a live region | **High** | chat |
| 3 | Error toast overlaps the user's own message | **High** | chat |
| 4 | No send affordance at rest; two adjacent audio glyphs | **Medium** | composer |
| 5 | Provider billing state leaked to the user | **Medium** | chat error |
| 6 | `muted-foreground/60` at 11 px fails AA in both themes | **Medium** | cost footer, disclaimer |
| 7 | Text-input focus indicator is 1.90:1 | **Medium** | all inputs |
| 8 | No headings / no `<h1>` on the chat surface | **Medium** | chat |
| 9 | Arabic: greeting untranslated and bidi-mangled | **Medium** | i18n |
| 10 | Arabic: placeholder untranslated and flipped | **Medium** | composer |
| 11 | Arabic: conversation titles truncate from the wrong end | **Medium** | sidebar |
| 12 | Empty state teaches none of the product's features | **Medium** | empty chat |
| 13 | Duplicate error presentation (toast + inline card) | **Medium** | chat |
| 14 | No in-conversation search or long-thread navigation | **Medium** | chat |
| 15 | Unlabelled reasoning-effort control | **Low** | composer |
| 16 | Model chip truncates mid-word at 390 px | **Low** | composer |
| 17 | Empty state vertically mis-centred on mobile | **Low** | mobile chat |
| 18 | Parameters popover clips the greeting | **Low** | chat |
| 19 | Max ×5/×20 toggle reads as disabled | **Low** | `/upgrade` |
| 20 | "Thought process · 1m 5s" on a non-reasoning model | **Low** | chat |
| 21 | URL stays `/chat` after a failed generation | **Low** | chat |
| 22 | Juno mark button is 21×21 on mobile | **Low** | mobile header |
| 23 | No offline handling of any kind | **Low** | global |

**Still unverified, needs a real device:** composer behaviour with the iOS keyboard open, safe-area insets, upload progress and failed-upload states, and production Core Web Vitals.

---

## Screenshot index

All under `review/screenshots/`. Naming: `<order>-<surface>-<viewport>-<scheme>.png`.

`01-landing` · `02-signup` · `02b-signup-filled` · `03-signin` · `10-first-run-onboarding` · `20-chat-empty` · `21-composer-focused` · `22-composer-plus-menu` · `23-model-picker` (parameters panel) · `24-slash-menu` · `25-command-palette` · `26-composer-filled` · `27-streaming-early` · `28-streaming-mid` · `29-answer-complete` · `30-message-actions` · `31-two-turn-conversation` · `32-conversation-dark` · `33-conversation-mobile` · `34-mobile-composer-focus` · `35-focus-after-tabs` · `36-reduced-motion` · `37-conversation-tablet` · `38-locale-fr` · `39-locale-ar` · `44-locale-ja` · `45-deeplink-conversation` · `30-projects` · `31-memory` · `32-connections` · `33-code` · `34-library` · `35-artifacts` · `36-tasks` · `37-roadmap` · `38-compare` · `40-settings` · `41-upgrade` · `42-profile` · `50-admin-users` · `51-admin-moderation` · `52-admin-announcements` · `70-notfound`
