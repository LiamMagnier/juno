# Premium pass: one brief for web, Mac and iPhone

Started 2026-09-26. Owner's ask: take Juno Chat and Juno Code from "calm but boring" to a
product that feels built by a best-in-class company (reference points: Claude, Codex,
Linear, Things, Arc). Every page, window and state gets attention to detail; the public
pages (landing, sign-in, download) get real imagery; iOS gets a full rework.

## Design read

Redesign in *preserve-brand, overhaul-composition* mode, for design-conscious
professionals who already use Claude/ChatGPT. Calm, warm, confident, editorial; never
loud. Dials: VARIANCE 6, MOTION 5, DENSITY 4 (product surfaces: DENSITY 5).

What we keep (it is the brand, and the web/Mac parity work depends on it):
- Tokens in `src/app/globals.css`: warm-neutral ground (`--background 48 24% 97.2%`,
  dark `30 5% 11.5%`), one accent, clay coral `--primary 15 54% 46%`.
- Type: Inter for every control and reading surface, Newsreader for display moments only
  (greetings, page heroes), JetBrains Mono for ids, costs, telemetry. On Apple platforms:
  SF Pro for UI, Newsreader for display via the bundled font, SF Mono for mono.
- The Juno mark and the dot-grid motif.

What changes: composition, depth, imagery, motion, and consistency between products.

## The five rules that fix "boring"

1. **One shell grammar across Chat and Code, on every platform.** Same sidebar rows
   (monochrome 16pt icon + label, 32pt row, 8pt radius hover/selected fill), same section
   headers, same account footer, same toolbar placement. No system-blue icons in Code
   while Chat is monochrome. The only accent-coloured thing in a sidebar is the selected
   row's icon or an unread indicator.
2. **Every empty state is designed, not blank.** A greeting in the display face, the
   composer as the hero object (elevated: hairline + soft tinted shadow, 20-24pt radius),
   and 3-4 starting points that are real actions, not generic pills. Code gets the same
   treatment as Chat ("What should we build?" set in the display face, project/runtime
   pickers integrated into the composer's top edge instead of floating above it).
3. **Depth has three rungs and nothing else.** Ground (page), raised (cards, composer:
   hairline + `0 1px 2px` + `0 8px 24px -12px` tinted shadow), floating (popovers,
   sheets, menus: stronger throw, glass on Apple platforms). Shadows are tinted with the
   ground hue, never pure black.
4. **Motion explains state.** Spring `response 0.35, damping 0.86` (web
   `cubic-bezier(0.16, 1, 0.3, 1)` 240-320ms) for appearance; 120ms press scale 0.97;
   streaming text fades in by chunk; sidebars/popovers scale from their anchor (0.96 → 1
   + fade). Everything collapses under Reduce Motion. No infinite decorative loops except
   real live state (thinking, recording, running).
5. **Imagery on public surfaces only.** Landing, sign-in, download and onboarding carry
   painted landscape art plus real product shots; product surfaces stay clean.

## Libraries.dev placements (skill: `.agents/skills/libraries-dev`)

Web only (they are React packages). Apple platforms get native equivalents built with
SwiftUI (angular-gradient stroke for the beam, `TimelineView` dots for the orb), labelled
as such in comments.

| Spot | Library | State wiring |
| --- | --- | --- |
| Chat composer while a reply streams (> 3 s) | Border beam `line` | `active` = streaming flag |
| Empty-state composer | Border beam `pulse-outside`, low strength | only until first keystroke |
| "Thinking / searching / writing" line in the transcript | Thinking orbs | the real tool/thinking phase |
| Voice mode + dictation | Voice glow | the real mic stream |
| Agents list / agent headers | Bot avatars | the agent's real status |
| Generated-image placeholder | Image (img-fx) | generation job status |
| Plan badge / Upgrade CTA only | Liquid metal (one preset per page) | none |

Never two effects on one element or on neighbours. Each respects `prefers-reduced-motion`.

## Copy rules

Plain, concrete English. No em dashes in visible copy (use a period, comma or colon).
No "seamless", "elevate", "unleash". Button labels 1-3 words. One label per intent.

## Surfaces and owners

- Web front door (landing `/`, `(auth)`, `/download`, `/legal` chrome): lead session.
- Web app (chat shell, composer, transcript, Code on web, settings, secondary pages) and
  libraries.dev integration: web-app lane. Must keep `npm run native:design:*` and the
  shell/chat contract checks green (the Mac mirrors the web shell by contract).
- macOS (Chat + Code, `native/macOS`, `native/Packages/JunoCode/Sources/JunoCodeUI`):
  mac lane. Verify with offscreen snapshot tests only (no screen control).
- iOS (`native/iOS/JunoMobile`): iOS lane. Full rework of shell, onboarding/sign-in,
  drawer, empty state, composer, transcript, model picker, settings, Code remote.
  Verify with simulator screenshots via the simulator tool (headless) or ImageRenderer.

## Imagery

Painted landscape plates (generated, stored under `public/brand/plates/`), warm dawn for
light theme and dusk for dark. Product shots rendered from the Mac snapshot tests with
sample data (no real user data), stored under `public/brand/product/`.
