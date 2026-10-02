# Public design pass 2

## Brief and authority

The owner explicitly requested continuing the public redesign and beginning the homepage now. This supersedes the older scheduling restriction in `HANDOFF.md` without changing its design brief. Work remains restricted to `juno-rf-public`, branch `rf/public-pages`; no push, merge, or deploy, and no changes to the excluded app components.

Reading this as a premium consumer product overview and public-page redesign, preserving the Alevr identity. DESIGN_VARIANCE 7, MOTION_INTENSITY 6, VISUAL_DENSITY 3. The foundation remains the repository's Tailwind 3, owned Radix/shadcn components, existing Framer Motion 12, semantic V3 tokens, upright Newsreader, Inter, and exact Continuum assets. No additional UI system is introduced.

## Audit before implementation

- Identity: neutral ground `#fcfcfd` / charcoal `#18191b`, graphite primary actions, 8px controls and 12/14px panels. Newsreader display, Inter UI, exact vector lockup. These remain authoritative despite generic skill defaults.
- IA: preserve `/`, authentication/recovery routes, download, shares, owner reading, legal slugs, and homepage anchors `#metering`, `#apps`, `#features`, `#pricing`. Keep the primary navigation labels stable.
- SEO: retain the homepage canonical URL, registry-driven SoftwareApplication offers, and the Alevr OG asset. Refresh the description to represent the complete product, without inventing availability.
- Homepage debt: a large reused auth photograph leads into model counts, metering, and dense feature/price lists. Orbit, Library, customization, and the aleph origin are not meaningfully demonstrated. Repeated signup intent uses different labels. Public pricing inherits a recommendation pill from the billing component.
- Current motion: small finite entrances and one model marquee, then scroll reveals. Preserve readable server HTML and reduced-motion behavior; make sequence serve the product narrative rather than adding idle spectacle.
- Recovery debt: common centered text-only states lack a purposeful visual anchor and clear semantic status hierarchy. Auth is stronger, but needs shared form/error rhythm, responsive spacing, and no contrast failures.
- Legal/share/download: existing routes, actions and data/security contracts are sound. Evolve presentation and public reading rhythm without altering document bodies or application behavior.
- Existing generated photography is legitimate editorial material, never evidence of an application workflow. Old native product shots still contain the prior identity and must not return as current product evidence.

## Composition

Homepage: a measured horizon hero; an interactive Chat/Orbit/Code product study using real rendering components and explicit example content; grouped capabilities for Library, Customize, voice, research and tools; live registry model breadth; the aleph/continuation story; cost and plan data from their existing sources; actual platform availability; one consistent account CTA.

Motion communicates hierarchy on entry, transitions between selected product examples, and reveals supporting sections as they become relevant. No perpetual logo/orbit loops, simulated work, approval actions, or unverified success animation. All content remains usable without motion or JavaScript.

## Verification record

The initial desktop homepage was inspected live and captured at 1280px in `.impeccable/review/home-before-pass2.png`. Final screenshots, responsive checks, reduced-motion checks, Lighthouse evidence and required command results will be appended after implementation. These files are local QA evidence and are not a production acceptance claim.

## Implemented

- Replaced the reused-auth hero with an authored silver horizon, upright Newsreader promise, short product description, and a consistent account/download action pair. Light and dark artwork share composition. Prompts are saved beside the three WebP assets.
- Added an accessible Radix Chat/Orbit/Code study. Its examples use the existing public transcript/Markdown renderer, actual `AgentFace`, and `FileDiff`; examples are explicitly labeled, agent tracking is disabled, and no approval, execution, or completion is simulated. The excluded component directories are imported where appropriate but untouched.
- Explained Library, Projects, canvas output, instructions, apps, skills, voice, Deep Field, and tools in an asymmetric, unboxed capabilities section. Added the aleph origin and exact Continuum mark. Provider logos, counts, cost calculations, prices, and availability retain their current registries.
- Removed the perpetual model marquee and public recommendation pill. Pricing uses native feature disclosures and consistent signup destinations. Compact navigation includes sign-in/account creation; a 320px overflow found during review was fixed.
- The horizon is a decorative CSS layer selected by the existing theme, with 750px mobile and 1920px desktop optimized candidates. It adds no image controller, preference cookie, duplicate mounted img, or custom theme initialization. Foreground heading/actions remain real HTML. LCP measures the foreground content; visual/network review also checks the landscape rather than treating an LCP score as proof of image readiness.
- Reframed 404/offline/revoked-share states around a silver continuation study with the recovery action first on phones. Root failure preserves independent HTML/CSS, font fallbacks, digest, and reset. Offline HTML embeds its artwork, avoiding an extra image request when disconnected.
- Refined auth imagery and kept provider readiness, field validation, autofill, callbacks, reset token handling, password visibility, and legal destinations. Shared-artifact controls use 44px targets. Legal reading rhythm changed only in the layout; document text is untouched. Existing onboarding, owner-read, email, and OG work from the first pass remains in place.

## Design-taste preflight

| Criteria | Evidence / disposition |
| --- | --- |
| Design Read, dials, audit, identity, IA, SEO, one system | Recorded above; no new app dependencies, no route/anchor rename, canonical/registry offers preserved. |
| Typography, palette, italic clearance | Exact brand Newsreader/Inter and V3 graphite/neutral grounds; serif is explicitly required by the brief. No display italics or clipped descenders. |
| Hero fit, padding, text stack, CTA wrapping | Desktop 1280x800 and mobile 390x844 reviewed. One promise, one description, two actions; 16-word description. CTA labels stay on one line. |
| Eyebrows, split headers, zigzag/repeated layouts | No numbered/uppercase marketing eyebrows. Stacked section headings; distinct hero, study, editorial capabilities, logos, image/story, metering, comparison, platform, closing layouts. |
| CTA consistency, logo wall, imagery | Repeated signup intent is `Create account`; `Download for Mac` consistently names the download destination. Registry logos only, without model-name captions. Three real generated photographic assets, no invented app window. |
| Bento rhythm/diversity | Not applicable: capabilities are an unboxed editorial grid, not a set of decorative bento cards. Product examples and pricing are functional grouped surfaces. |
| Copy, lists, labels, dots, micro-metadata | Copy re-read; no decorative labels/dots/pills, fake progress, scroll cues, location strips, version stamp, or em dash in new UI copy. Actual release facts and artifact versions remain meaningful product data. Legal/user-authored content remains intact. |
| Motion motivation, implementation, cleanup | Entrances establish hierarchy; finite tab entry communicates a selection; existing intersection-driven reveals expose supporting sections. Transform/opacity only; removed clip-path animation and model marquee. No custom scroll listener or perpetual animation. No new timer or listener needs cleanup; existing menu/reveal cleanup is retained. |
| GSAP pin/scrub, kinetic title, physics | Not applicable: the brief calls for restrained product motion, not a pinned or hijacked scroll narrative. |
| Reduced motion, print, progressive HTML | New entrances are under `prefers-reduced-motion: no-preference`; reduced motion removes hover travel. Existing Framer Motion config respects the user setting. Product content is force-mounted with print/no-script disclosure rules. The no-script page uses the default light ground and matching landscape. Source verified; OS-level reduced-motion and a disabled-JS browser run remain acceptance checks. |
| Themes, mobile collapse, viewport stability | Both themes reviewed; study controls exercised on mobile. Desktop/390px and 320px recovery/header checks passed after the header fix. Explicit single-column collapse, bounded measures, intrinsic image geometry, no `h-screen`. |
| Form contrast, empty/loading/errors | V3 field/focus tokens retained. Password visibility exercised and restored. Missing-mail, auth-error, confirmation, offline, 404, and revoked-link states reviewed. Providers/mail are absent locally, so live delivery/consent success is not claimed. |
| Icons, client isolation, unnecessary cards | Existing owned icon family retained; no new hand-drawn icons. Interactive/motion leaves are client components. Editorial feature/platform sections use space and rules rather than repeated cards. |
| Performance / full acceptance | Responsive image candidates and high fetch priority implemented. Lighthouse reports no CLS and a clean accessibility audit. Slow-mobile LCP remains above the skill's 2.5s goal. No blanket performance or full production-acceptance claim. See the continuation record for exact measurements and remaining work. |

The invoked [design-taste-frontend skill](/Users/liammagnier/.agents/skills/design-taste-frontend/SKILL.md) states: “If a single checkbox cannot be honestly ticked, the page is not done. Fix it before delivering.” Its full-acceptance label is therefore not asserted. The visual implementation and passing functional gates are preserved; the shared-root performance work is separately identified without changing the excluded app workstream.
