# ADR-0003 — Design tokens are generated from the web source, and the web
# stack version is matched deliberately

**Status:** Accepted · 2026-08-12

## Context

The brief (§30) makes the website the design authority, forbids approximating
its tokens from memory, and asks for tokens to be shared programmatically "so
web and desktop do not drift".

The repository already solves this for Swift. `scripts/generate-design-tokens.ts`
is a real CSS parser — it walks brace depth tracking the at-rule chain and
treats only `@layer` as transparent, because `globals.css` re-declares
`--ease-out-strong`, `--ease-out-expo` and `--dur-slow` inside
`@media (prefers-reduced-motion: reduce)`, and a flat regex scan silently drops
all three. It emits `JunoGeneratedTokens.swift` and `src/lib/design/tokens.generated.ts`,
stamps a `sha256(css + radius)` digest into both banners, and
`npm run design:tokens:check` byte-compares and exits 1 on drift.

Sources of truth: `src/app/globals.css` for colour and motion,
`tailwind.config.ts` for the radius ladder.

## Decision

1. **Same sources of truth, separate emitter.** The desktop has its own
   `scripts/generate-tokens.ts` reading the *same* two files
   (`src/app/globals.css`, `tailwind.config.ts`) and reproducing the same
   `--check` / digest / exit-1 contract.

   > **Amended 2026-08-12, after implementation.** This ADR originally said
   > "extend the existing generator" and add an entry to its `outputs` array.
   > That turned out not to be possible as written: the root script **executes
   > on import and exports nothing**, so there is no function to call and no
   > `outputs` array reachable from outside. Extending it would have meant
   > editing a file the web app and the Swift token pipeline both depend on, to
   > serve a third consumer. The parser logic (`parseBlocks`/`declsFor`) is
   > carried over near-verbatim instead.
   >
   > The duplication is real and is the accepted cost. What matters for
   > anti-drift is that the **source of truth** is shared, not the code that
   > reads it — and both generators fail CI when their output goes stale.
   > Factoring the parser into a module both can import is the right follow-up;
   > it is recorded in STATUS.md rather than done opportunistically here.

2. Re-emit the **raw HSL triples verbatim**. Do not round-trip through
   `hslToRgb` — that would introduce drift against the web for no benefit, and
   emitting the triples keeps `hsl(var(--card) / <alpha-value>)`, the `.dark`
   swap and the `[data-accent]` cascade working untranslated.
3. **Pin Tailwind 3.4.19 and framer-motion 12.43.0** in the desktop workspace,
   matching the web app, even though 4.3.3 and 13.1.0 exist.

### One parser difference, deliberately

The Swift emitter *drops* conditional blocks; the CSS emitter **keeps** them,
tagged with their at-rule chain. Swift has no `@media`, so flattening was
correct there. CSS does, and `globals.css` re-declares `--ease-out-strong`,
`--ease-out-expo` and `--dur-slow` inside
`@media (prefers-reduced-motion: reduce)` — flattening those would ship the
reduced-motion values to everyone.

The digest fingerprints the **projection**, not the source bytes, so editing a
comment in `globals.css` does not fail desktop CI.

## Rationale for (3)

Tailwind 4 replaces the JS config with a CSS-first model. The web app's
`tailwind.config.ts` **is** the semantic mapping — `bg-surface`, `text-muted-foreground`
and so on. Matching v3.4 means a component written against a semantic class means
the same thing in both codebases, and the config can be reused rather than
translated. Adopting v4 would fork the design system on day one to gain nothing
the brief asks for.

The same argument applies to framer-motion: the web app's motion vocabulary —
six durations (70/120/160/220/360/560ms) and seven easings — is expressed
against v12.

This is the "documented reason" §5 asks for, in the opposite direction from
usual: the reason is to *not* upgrade.

## Identity captured

- Light: warm paper (`--background: 54 18% 97%`). Dark: **true black**
  (`0 0% 0%`), deliberately re-based from warm charcoal for OLED.
- Every neutral sits at hue 48. Dark drops saturation to 4–5%, because 7% over
  pure black reads as brown sludge.
- Coral `--primary: 15 54% 46%`, identical in both themes, plus five alternates
  swapped via `[data-accent]`, each overriding only four tokens.
- **On dark, elevation cannot come from shadow.** It comes from a lightness
  ladder (`0%` < card `6.5%` < muted `9.5%` < popover `13%`) plus a 1px *inset*
  sheen. Any desktop surface must obey this or it will look wrong next to the web.
- Reduced motion is **tiered, not a kill switch**: `--motion-shift: 0` and
  `--motion-scale-from: 1` collapse transforms while state-carrying animation
  survives. The desktop must reproduce the tiering, not disable animation.
- `.overlay-glass` **is opaque** (`backdrop-filter: none`). The product moved off
  real blur deliberately; documentation claiming otherwise is stale.

## Consequences

**Good**

- One generator, one digest, one drift gate covering Swift, web and desktop.
- `npm run tokens:check` in desktop CI fails on divergence.

**Bad**

- The desktop is coupled to the web repo's file layout. Acceptable: they are the
  same repository, and the coupling is the point.
- Two gaps must be closed in the generator: its existing TS emitter carries
  **no colour at all** (motion and radius only), and the `--shadow-*` /
  `--well-inset` box-shadow strings are invisible to `asColor()` and need a
  literal pass-through list.
- The desktop pins two dependencies behind their latest majors, deliberately.
  Revisit when the web app upgrades — not before.

**Follow-up**

- Fonts (Archivo, Newsreader, JetBrains Mono) are loaded on the web via
  `next/font/google`. The desktop CSP forbids remote fonts, so the font files
  must be **bundled locally** in `resources/fonts/`. Tracked in STATUS.md; the
  metric-matched fallback stacks must be reproduced too.
