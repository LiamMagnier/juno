# Alevr public pages — continuation, 2026-10-02

This record belongs to `/Users/liammagnier/Developer/project/juno-rf-public`, branch `rf/public-pages`. It describes the public-pages implementation and its evidence at the documentation checkpoint. Continue in this worktree; do not assume the canonical `juno` checkout contains these changes. No push, merge, deployment, native build, or production acceptance is established by this document.

The latest homepage and public-polish pass is recorded under **Second design pass** below and in `PUBLIC_PAGES_DESIGN_PASS_2.md`. Earlier evidence remains historical.

## Identity authority and documentation boundary

This is an **ordinary extension of the pinned Alevr V3 identity**, not a replacement visual world. The product is Alevr; Continuum names the selected logo concept. The exact committed vector geometry remains authoritative. The sculpture photograph is editorial material, never a replacement mark.

Read these sources before extending the work:

- `docs/rework/brand/BRAND_IDENTITY.md`: Alevr, Continuum, “Go further.”, neutral themes, Newsreader/Inter, material and interaction constraints.
- `docs/rework/brand/CHAT_SYSTEM.md`: quiet operational hierarchy and shared V3 tokens.
- `docs/rework/brand/MOTION_AND_THINKING.md`: truthful activity, inherited timing, reduced motion, stationary master silhouette.
- `src/app/globals.css` and `tailwind.config.ts`: actual runtime tokens and type scale. Some introductory comments still describe earlier Juno/warm-paper values; read the declarations rather than treating those comments as current palette authority.
- `src/components/brand/alevr-lockup.tsx`, `alevr-lockup-geometry.ts`, `continuum-mark.tsx`, `continuum-geometry.ts`, `alevr-wordmark.tsx`, and `alevr-wordmark-geometry.ts`: exact production drawings.

The Impeccable documenter pass read `reference/document.md` and `agents/impeccable_documenter.toml` from `/Users/liammagnier/.agents/skills/impeccable`. Its ordinary-extension rule preserves the incumbent system and reports pre-existing drift without repairing it unasked. This pass writes this continuation record only. `DESIGN.md`, `.impeccable/design.json`, `PRODUCT.md`, and the brand documents are not rewritten.

`PRODUCT.md` exists but still says Juno and describes an earlier Agents workstream. That is pre-existing context drift, not a newly adopted naming decision. It was reported by the finish reviewer and left intact. Do not canonize that drift, old comments, or an unaccepted presentation detail as a new house rule.

## Commit checkpoint

The documenter verified these entries from local `git log`:

| Commit | Meaning |
| --- | --- |
| `e90549ecaafaee325a5cdb8205f7e4f89f931907` | `Complete Alevr public email identity and preserve continuation evidence`; shared mail envelope and exact lockup PNGs, new OG card and asset generator, escaped-mail tests, Markdown preview notice correction, and the initial continuation record. |
| `b1b51fd94d2d13566d6c181a765723c5470f37a3` | `Carry Alevr V3 across public reading and marketing pages`; shares and owner reading, landing/download imagery and compact platform cells, legal/engineering layouts, and related regression fixtures. |
| `c92dc27146598fa191ba1f862ea1c1edc17d033f` | `Rework public authentication and recovery with Alevr V3`; auth layout/forms/skeletons, local auth-error/check-email routes, root recovery/offline surfaces, scoped public styling and the authorized onboarding exception, authored image, licensed fallback fonts, ignore rules. |
| `97c30ab9` | Immediate base: `Merge branch 'rf/brand-assets' into rework/refoundation`. |
| `c9f03acd` | Earlier inherited Continuum geometry revision 2 documentation/assets; not a new public-pages commit. |

The three implementation commits above preserve the requested public-page work. A subsequent documentation-only checkpoint records the final live-browser evidence, dependency isolation, and completed check results. Obtain its hash from `git log`; a record cannot embed its own commit hash. No push, deploy, or merge was performed.

## Implemented scope and source map

### Shared public system

`src/components/public/public-frame.tsx` supplies `PublicFrame`, the labelled vector `PublicBrand` home link, and `PublicState` for recoverable states. `theme-toggle.tsx` supplies the existing theme interaction. `public.css` is imported from the root layout and applies the public identity through `.alevr-public`, with a narrowly scoped onboarding exception described below.

Observed implementation rules:

- Shared semantic light/dark neutral grounds, graphite primary controls, tonal edges and fields. Public primary colors resolve to foreground/background; existing focus/presence tokens remain meaningful.
- Upright Newsreader display and Inter body/controls. Public non-code metadata previously using mono is set to the interface face. Code and preformatted content retain their own treatment.
- Forms use 44px minimum input and submit heights, 8px field/button corners, explicit focus-visible outlines, and quiet hover/focus changes. Public raised/stage surfaces lose decorative shadows.
- Auth has a finite staged entrance using 220/360/560ms durations and inherited soft/expo curves. Content starts partially visible; there is no hidden form awaiting a timeline. Public opening hierarchy uses the same short entrance vocabulary; reading stays stable. Reduced motion removes entrance travel/scale and public control transitions/press movement.
- The authored monochrome sculpture substantially anchors auth, landing, and download. It is not a device screenshot or evidence that a native application workflow has been demonstrated.

These observations document this implementation; they do not replace the global brand specification or promote page-specific composition into a universal system.

### Authentication, reset, and OAuth entry

- `src/app/(auth)/layout.tsx`: responsive two-column desktop composition and compact phone sculpture crop, real vector lockup, theme control, form reading measure, and complete existing legal destinations.
- `src/app/(auth)/sign-in/page.tsx`, `sign-up/page.tsx`, and `src/components/auth/auth-form.tsx`: provider-aware form presentation and existing authentication actions preserved. `auth-form-skeleton.tsx` matches configured provider availability rather than reserving fictitious buttons. `verify-email-banner.tsx` receives the same presentation.
- Existing `forgot-password/page.tsx` and `reset-password/page.tsx` inherit the new auth layout. Their reset/token rules are not redesigned by replacing backend semantics.
- `src/app/(auth)/auth-error/page.tsx`: verification-expired/used, access-denied, and generic failure copy with a real sign-in recovery destination.
- `src/app/(auth)/check-email/page.tsx`: local email-link request state and return destination.
- `src/lib/auth.ts`: explicit local `error: "/auth-error"` and `verifyRequest: "/check-email"` destinations beside the existing sign-in page.
- `src/app/app-auth/page.tsx` and `handoff.tsx`: native entry/handoff presentation follows Alevr. The redundant “Sign-in failed” eyebrow was removed; the failure heading and alert retain the actual meaning.

OAuth provider-owned consent pages remain external. This work styles the application’s entry/error surfaces and retains provider configuration, callback, account-linking, and consent ownership. A static sign-in preview does not establish a configured OAuth round trip or email delivery.

### Authorized onboarding exception

The original scope explicitly authorized onboarding styling while prohibiting edits to `src/components/app`. The unique `[role="dialog"]:has(#onboarding-name)` selectors in `public.css` implement that exception: neutral surface, 14px radius, bounded scrolling, upright Newsreader heading, exact vector lockup mask, and interface typography. They remove the prior decorative backdrop within that dialog.

The selectors deliberately reach the authenticated onboarding dialog, as the stylesheet's introductory comment now states. No forbidden app component was edited, and existing gating, save, theme/accent choices, focus trapping, and dismissal logic remain owned by the original component. Their runtime behavior is still awaiting acceptance.

### 404, root failure, offline, and secondary entry states

- `src/app/not-found.tsx`: shared public recovery composition for an unknown route.
- `src/app/global-error.tsx`: standalone document with exact vector lockup, inline neutral theme styles, self-hosted font fallbacks, reference digest when present, actual `reset()` action, and router-independent home navigation. It remains useful when the normal root layout/providers fail.
- `src/app/offline/page.tsx` and `reconnect-action.tsx`: explicit offline destination; online/offline events update a readable status, and retry leads to `/chat` through the existing auth boundary.
- `public/offline.html`: router-independent generated fallback; `scripts/generate-public-fallback.ts` derives it from the real root boundary.
- `src/app/suspended/page.tsx` and `computer-view/page.tsx`: matching entry/recovery presentation.

**Offline integration is incomplete.** `public/sw.js` is an existing push-only service worker with no fetch handler or cache. It was preserved. A static offline file and `/offline` route do not make failed navigation automatically fall back offline, or make private work available without a connection. Hosting/navigation fallback integration remains follow-up work. Keep private/authenticated content out of caches and do not silently turn the push worker into a general cache.

### Public shares and owner read view

- `src/app/share/[token]/page.tsx`, `src/components/share/share-gone.tsx`, and `shared-chat-transcript.tsx`: neutral Alevr wrapper, exact lockup, Newsreader heading and restrained provenance/transcript treatment.
- `src/components/share/shared-artifact-viewer.tsx`: Markdown remains previewable in the public static profile, and no longer shows the contradictory script-preview-disabled notice. Script execution restrictions are unchanged.
- `src/app/(app)/a/[id]/artifact-read-view.tsx`, `loading.tsx`, `error.tsx`, and `not-found.tsx`: owner-read header/loading/recovery presentation. The parent route’s `requireUser` authentication and owner checks remain intact; `/a` is not made public.

Frozen snapshots, publication versions, revocation/gone handling, source/restore lifecycle, access checks, and sandbox security remain the existing contracts. Public share rendering stays dynamic so revocation is not hidden by a cached page. Unknown/revoked/taken-down shares and known-but-gone content must be tested with their actual respective route behavior; presentation alone does not prove enforcement.

### Landing, download, and legal layout

- `src/components/landing/{landing-page,landing-header,site-chrome,section,platforms,metering,closing}.tsx`: public Alevr hierarchy and real monochrome imagery instead of the prior plates/large neutral placeholders. Existing landing reveal behavior remains; runtime choreography has not been accepted.
- `src/components/download/download-view.tsx`: authored large photographic stage, quiet controls/platform availability, and existing actionable download/feed semantics preserved. The former oversized iOS stage is now a compact platform cell alongside the other devices; the final layout was captured in `download-platforms-final.png`.
- `src/app/(legal)/layout.tsx`: layout/type/table styling only. French document language, article semantics, bodies, obligations, and destinations are unchanged. `git diff` against the base shows only the legal layout in that directory.
- `src/app/(engineering)/layout.tsx`: shared public wrapper alignment.

The application’s app/chat/library/customize/agents/code/UI/icon implementation directories were excluded from this workstream. Shared components may be imported; they were not edited here. The expressly authorized owner-read files and onboarding CSS exception do not grant permission to expand into app-shell implementation.

### Transactional and work email, OG output

- `src/lib/email-layout.ts`: central presentation-table envelope with inline light fallbacks, neutral dark media rules, Newsreader/Inter where webfonts are supported, appropriate system/Georgia fallbacks, light/dark PNG lockups, and no motion. Headings, context, CTA labels/URLs, and footer values are escaped. `bodyHtml` is trusted template markup; callers must continue escaping every interpolated user value.
- `src/lib/email.ts`, `email-templates.ts`, and `src/lib/work/notify/email.ts`: reuse that envelope while retaining real requested actions, expiration copy, CTA destinations, and plain-text alternatives.
- `public/brand/email-lockup-{light,dark}.png`: rasterizations of committed vector lockups for email clients; not a newly drawn approximation.
- `public/og.png`: exact vector Continuum + Alevr and “Go further.” on the neutral ground, 1200×630. The generator uses the bundled licensed Newsreader face for the signature line.
- `scripts/generate-public-assets.ts`: deterministic source pipeline for the email lockups and OG card.
- `tests/email-layout.test.ts`: escaping dynamic headings/link labels/URL attributes, reset expiration and plain-text link preservation, escaped task content, and real work CTA plus both logo appearances.
- `tests/download-feed.test.ts` and `tests/public-ui-smoke.test.ts`: feed behavior and HTTP/source contract assertions updated for the final presentation. Passing source markers are not browser acceptance.

Actual mail-client rendering, image blocking, webfont fallback, forwarded mail, and dark-mode overrides remain unverified. Do not infer Outlook/Gmail/Apple Mail acceptance from generated HTML or the presence of inline fallback styles.

## Asset reproduction

`public/brand/auth-continuation.webp` is 54,512 bytes, generated on 2026-10-02 from the prompt saved in `public/brand/auth-continuation.prompt.txt`, then converted to WebP at quality 90 without cropping or visual alteration. The prompt requests pale folded-paper sculpture in a charcoal photographic studio, no text or logo. Regeneration is generative and will not be pixel-identical; preserve the committed reviewed WebP for exact reproducibility.

`public/fonts/README.md` records the bundled Newsreader Regular TTF and Inter Latin WOFF2 provenance. Both SIL Open Font License texts are committed beside the files. The wordmark is outlined vector geometry and does not depend on an email client downloading a webfont.

From this worktree, with the repository-required Node 24 runtime and installed dependencies:

```sh
npx tsx scripts/generate-public-assets.ts
npx tsx scripts/generate-public-fallback.ts
```

Review generated `public/og.png`, both email PNG lockups, and `public/offline.html`; generators write files. Keep those outputs synchronized with approved vector masters and fallback styles. The offline generator transforms the real boundary’s wording/action; verify its replacement strings still match after future copy edits.

## Verification evidence and limits

The implementation owner reported these completed Node 24 checks before planned small commits:

| Check | Reported result | What it establishes |
| --- | --- | --- |
| `npm run typecheck` | Exit 0 | TypeScript acceptance at the tested checkpoint. |
| `npm run lint` | Exit 0; seven pre-existing canvas/porcelain gallery warnings | Lint acceptance, with inherited warnings rather than a warning-free claim. |
| `npm test` | Exit 0; 4,547 tests, 4,475 pass, 72 skip | Domain/source regression suite at that checkpoint; skipped tests are not acceptance. |
| Chained helpers in `npm test` | Auth/locale, message crypto, moderation, skill-package, custom-MCP helpers passed | Their exercised integration contracts, not configured external OAuth or mail delivery. |
| Targeted local log `.public-targeted.log` | 33 tests, 33 pass, 0 fail | The documented focused run’s regression coverage. |

These are completed validation runs by the implementation owner, not an independent rerun by the documenter. The same three checks were repeated before the authentication commit and the public-reading/marketing commit, each with process exit 0. The final rerun after isolating the branch's generated Prisma client is recorded below. Do not treat a log containing only command headers or partial passing tests as proof of process exit 0.

**Final rerun, 2026-10-02:** `npm run typecheck`, `npm run lint`, and the entire `npm test` chain each completed with exit 0 after dependency isolation. The test runner reported 4,547 tests, 4,475 passing, 72 skipped, zero failures; all chained helpers passed. Lint reported the same seven inherited gallery warnings and zero errors. No source change was needed for the generated-client mismatch. The documentation checkpoint was committed after these results.

Local logs and artifacts are ignored: `.public-*.log`, `.next-public-dev.log`, `.public-signin.html`, `.validation/`, `.impeccable/`, and `public/_review*` previews. They may not travel with a branch checkout or PR. Preserve needed review evidence separately when handing work to another machine.

### Browser and review evidence

The owner's live `npx next dev -p 3175` session rendered the initial auth page and exercised required-field validation. Severe resource contention then delayed compilation and browser navigation. The final normal webpack run compiled sign-in in 224 seconds and returned HTTP 200; its live page was inspected and captured in light/dark, and theme switching plus the password-visibility pressed state were exercised. A temporary Turbopack experiment reached startup but failed on an inherited `::highlight(juno-find)` CSS parser incompatibility; its temporary configuration was restored and is not committed. These live checks do not establish successful sign-in, sign-up, reset, OAuth, native handoff, or onboarding completion.

The final visual review used **real component server rendering and real streamed form HTML with compiled CSS**. Animations were disabled for captures. Phone evidence used a same-origin viewport iframe at 390×844 after browser-controller timeouts. This is useful settled-layout evidence, not a complete browser interaction, standalone phone navigation, runtime animation, or authenticated acceptance matrix.

Key local evidence:

- `.impeccable/review/auth-desktop-v2.png` and `auth-desktop-dark.png`: desktop auth in light/dark.
- `.impeccable/review/auth-mobile-light-final.png` and `auth-mobile-dark.png`: phone auth; final light capture shows the full sculpture caption and legal footer.
- `.impeccable/review/auth-live-light.png` and `auth-live-dark.png`: final live sign-in at the actual 842px browser width, after interactive theme/password-control checks. These supplement the settled desktop/phone captures; they do not establish a completed authentication journey.
- `.impeccable/review/landing-light-final.png` and `landing-light-hero-final.png`: substantial photographic landing focal region, real heading/actions, nonblank full-page capture.
- `.impeccable/review/download-light-top-final.png`, `download-light-hero-final.png`, and `download-platforms-final.png`: photographic download stage and the final compact three-platform row.
- `.impeccable/review/privacy-final.png`: the real legal layout and unchanged French document body.
- `.impeccable/review/shared-chat-final.png`: the real public transcript wrapper and reading hierarchy.
- `.impeccable/review/email-reset-light.png`: the real recovery envelope, typography, lockup, and action; browser rendering does not establish actual mail-client support.
- Other offline/root-error/email HTML and captures under `.impeccable/review/` are supplementary previews, not completed workflow or email-client acceptance.
- `.impeccable/review/finish-review.md`: independent reviewer’s findings and post-fix verdict. Its opening `disposition: fix` is the historical initial review; the final post-fix `disposition: ship` supersedes it for the three scored findings only.

The reviewer cleared: (1) missing landing/download imagery, (2) the onboarding boundary objection after the parent supplied explicit original authorization, and (3) the redundant native-auth failure eyebrow after source correction. It identified no regression in those scored regions. No formal five-block direction contract, approved comp, or QUALITY BAR card was supplied; do not invent one retrospectively. The detector’s Inter warnings were overridden by the user’s pinned Inter requirement.

**The ship verdict is restricted to those three findings.** It does not accept the whole site, configured OAuth, onboarding behavior/accessibility, native handoff, actual motion/performance, actual email clients, or an authenticated production route matrix.

## Local preview and isolated database

The local Next dev origin used during work was `http://localhost:3175`. Ignored `_review` HTML/CSS files served visual snapshots from that origin, including sign-in light/dark, phone viewports, landing/download light/dark, and email variants. They are ephemeral QA files and must not be published as product routes.

The temporary public `_review` HTML/CSS files were removed at closeout. Captures remain in the ignored review directory. The normal `npx next dev -p 3175` preview uses the unchanged committed Next configuration and isolated validation database; it may require cold route compilation when resumed.

The validation database is an isolated PostgreSQL cluster under `.validation/postgres`, port **54385**, database **`alevr_public_validation`**. It contains synthetic auth/share/read fixtures only. No production database was used for this validation. Do not copy synthetic credentials into this document, commit them, or seed an account into production. Synthetic rows establish fixture setup; they do not establish an authenticated browser session. Check the database process and exported validation environment before resuming; process liveness is not promised by the existence of the data directory.

The worktree helper initially linked all of `node_modules` to the refoundation checkout. Another concurrent Prisma generation then changed the shared client, making this branch's unchanged `WorkSkillVersion` test fixture fail typechecking on three fields absent from its schema. Only this worktree's dependency link was replaced: ordinary dependencies remain linked, while `@prisma/client` and `.prisma/client` are local. A temporary copy of the unchanged branch schema, with its generator output directed explicitly to this worktree's `node_modules/.prisma/client`, regenerated the matching client. No other checkout or schema was modified, and no unrelated fixture was patched to accommodate another branch. A normal independent dependency install and `prisma generate` from this branch produce the same schema contract.

Reproducible checks, after selecting Node 24 and pointing any database-dependent helpers only at the isolated validation target:

```sh
npm run typecheck
npm run lint
npm test
npx tsx --test tests/email-layout.test.ts tests/download-feed.test.ts tests/public-ui-smoke.test.ts
npx next dev -p 3175
```

For HTTP-level smoke against a running local target:

```sh
JUNO_PUBLIC_UI_BASE_URL=http://localhost:3175 node scripts/public-ui-smoke.mjs
```

The smoke script checks real HTML markers, security headers, and signed-out `/chat` redirect behavior. It is explicitly an HTTP gate. A source test of its request matrix is not a completed run against the application. No final application smoke result is claimed here; required-header expectations also need the intended server/hosting configuration. Reset-token, share/publication, and owner-read cases require prepared synthetic fixtures beyond this simple route list.

## Follow-up acceptance checklist

1. Verify the current branch/HEAD and clean diff before integration. Keep unrelated concurrent changes out of this workstream's commits.
2. Check landing/download both themes and desktop/phone widths, real navigation, availability/blocked-download states, and actionable platform links. The compact platform row has a final settled-layout capture; complete its interactive responsive acceptance.
3. Test real sign-in/sign-up journeys with validation credentials: empty/invalid fields, error/loading/disabled states, provider buttons when configured and absent, password autofill, legal links, theme persistence, keyboard order, focus-visible, narrow width, zoom, and screen-reader labels/status.
4. Exercise reset request and reset completion with actual local mail/test tokens: invalid/expired/already-used token, successful completion, repeat submissions, back navigation, and truthful recovery copy. Exercise email-link request, expired link, and `/auth-error` error variants through their real routing.
5. Complete each configured external OAuth provider round trip, cancel/deny/error callback, account linking, and native `/app-auth` handoff/callback. The provider owns its consent UI. Validate the existing security and redirect rules while reviewing the local presentation.
6. Open the real onboarding dialog after an authenticated first session. Verify `:has(#onboarding-name)` styling in light/dark and narrow viewports, label/readability, bounded scroll, focus trap, gating, theme/accent changes, save/dismissal, and persisted result. Preserve the prohibition on editing app components unless separately authorized.
7. Visit real unknown routes and exercise root failure/reset recovery, digest display, suspended/computer entry states, and standalone fallback fonts/theme without root providers. Test `/offline` reconnect status and retry. Separately design and validate hosting/navigation fallback integration without caching private content.
8. Use synthetic public chat/artifact snapshots, live publications, version-pinned and follow-latest publications, unknown/revoked/gone/trash/takedown cases. Verify metadata privacy, immediate revocation, source/version controls where applicable, script sandboxing, content overflow, and responsive readability. Test `/a/[id]` signed out, wrong owner, correct owner, missing/trash, loading/error, versions/source/download, and navigation; preserve authentication and ownership.
9. Review legal layout in both themes/phone widths, French language, long paragraphs, lists, tables/scroll, footer/header destinations. Confirm document body text remains unchanged.
10. Run actual animation in a responsive browser with reduced motion both off and on. Inspect entrance settling, no flashing/hidden content, focus/typing stability, scroll reveals, press feedback, page visibility, layout shifts, and performance. Static screenshots with animations disabled do not answer this requirement.
11. Send synthetic transactional/work mail to representative actual clients. Verify light/dark, webfont failure, images blocked, narrow width, Outlook table fallback, CTA destination/expiration/action wording, escaped content, and plain-text alternatives. Review OG unfurl/crop and exact logo geometry at actual usage size.
12. Re-run the HTTP gate on the intended running environment and complete authenticated real-route acceptance before any production-ready claim. Native/macOS and signed-release checks belong to their authorized workstreams; no native acceptance follows from the download page or a successful web suite.

The implemented presentation, limited captures, and passing reported regression checks are preserved for continuation. The unverified requirements above remain acceptance work rather than silently completed scope.


## Second design pass, 2026-10-02

The owner explicitly authorized beginning the homepage now, using the documented product overview brief. The newer instruction supersedes the older homepage scheduling restriction. This pass invokes design-taste-frontend, preserves the pinned identity and excluded app component ownership, and introduces no application dependency.

### Changes and commits

- `f8b7c9aa`, **Rebuild Alevr's public overview around real product examples**: horizon hero, responsive light/dark artwork, actual transcript/AgentFace/FileDiff examples with accessible Chat/Orbit/Code tabs, editorial capabilities, aleph story, static registry logos, honest pricing/platform availability, compact navigation and consistent account/download actions. The actual components are imported, never edited. Homepage metadata/canonical/registry offers remain intact. A regression fixture now checks download destinations in the marketing files that actually own them.
- **Polish Alevr public recovery and reading surfaces**: follow-up commit for auth, shared-state recovery, independent root failure, embedded offline fallback, download, legal layout, shared reading landmark/44px artifact controls, regression fixture and this documentation. Obtain this commit's hash from git log after the documentation checkpoint.

Auth now uses the dark horizon; recovery surfaces use the silver open-fold study with the primary action first on phones. Auth behavior/provider readiness remains intact. The shared page has a semantic main landmark without losing the artifact's flex viewport. Legal bodies are untouched. Earlier onboarding, owner reading, mail templates and OG implementation remains in place.

Three WebP assets and their generation prompts live under `public/brand/home-*.webp` and `home-editorial.prompts.txt`. These are editorial imagery, not replacement logo geometry or evidence of native workflow execution. Decorative horizon backgrounds follow the existing root theme, selecting optimized 750px mobile/1920px desktop candidates without an image controller or new preference cookie.

### Current verification

Node 24 production build (without its redundant lint stage), typecheck, lint and the entire npm test chain completed with exit 0 before the homepage commit. Tests report 4,547 total, 4,475 pass, 72 skipped, zero failures. Lint retains seven inherited design-gallery warnings and zero errors. The three required checks were repeated before the follow-up commit, all with exit 0 and the same test totals and inherited warnings; see ignored final logs for process evidence.

Live production routes were inspected at 1280x800, 390x844 and 320px in the in-app browser, with real light/dark theme switching. Product tabs, shared artifact Preview/Code, password visibility and compact navigation were exercised. A 320px header overflow was fixed. Shared chat/artifact fixtures use isolated local synthetic content. The public artifact now retains a 670px reading main area at an 800px viewport and source controls remain functional. Live dev preview is restored on port 3175 at closeout.

Final CSS-layer production Lighthouse (default simulated mobile): performance **78**, accessibility **100**, best practices **96**, SEO **100**; FCP **1.7s**, LCP **5.8s**, TBT **70ms**, CLS **0**. A separate DevTools-throttled run: performance **91**, accessibility **100**, best practices **96**, SEO **100**; FCP **2.3s**, LCP **3.0s**, TBT **30ms**, CLS **0**. These are two different diagnostic protocols, not field data or a passed 2.5s LCP gate. Best-practices reports a CSP inspector issue; its cause was not established here. Background appearance was checked visually; a foreground-content metric alone does not establish landscape readiness. No claim about field INP is made.

Relevant local evidence: `home-pass2-{light,dark}.png`, their full-page variants, phone homepage/sign-in captures, `sign-in-pass2-desktop-{light,dark}.png`, `404-pass2-*.png`, `pass2-*-desktop.png`, both production Lighthouse JSON files and the visual gallery under `.impeccable/review/`. The self-contained 32-capture gallery is `.impeccable/review/public-pages-review.html`, served locally at `http://127.0.0.1:3176/public-pages-review.html` during review. It includes an enlargement dialog and live-page links. The gallery is local review material, not a shipped route.

### Remaining acceptance

The complete design-taste checklist is recorded in `PUBLIC_PAGES_DESIGN_PASS_2.md`. Full acceptance remains open for slow-mobile LCP, a browser run with JavaScript disabled and OS reduced motion enabled, authenticated onboarding/owner-read/native handoff, configured OAuth/reset/mail delivery and actual email clients. Source reduced-motion/print/no-script rules are verified; unavailable live journeys are not treated as completed. Public visuals and regression checks are delivered without editing shared-root/app ownership to chase the remaining performance work. No push, deploy or merge was performed.
