import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import animate from "tailwindcss-animate";
import containerQueries from "@tailwindcss/container-queries";

/*
 * Juno design tokens (Slice 0 — Foundation)
 * -----------------------------------------
 * Type scale ............ text-{home-title,display,page-title,title,heading,body-lg,reading,body,nav,ui,label,kbd}
 *                         (+ marketing `hero`; `caption` deprecated and `micro` retired, both 12px) ·
 *                         serif = human moments · sans = UI body · mono = labels/metadata/keycaps
 * Motion ................ ease-{out-soft,out-strong,out-expo,in,in-out,breathe,out-back,spring,drawer} ·
 *                         duration-{press,fast,exit,base,slow,emphasis}
 *                         (mirrored as --ease-* / --dur-* in globals.css, where the
 *                          reasoning behind each value lives — read it before adding a fifth)
 * Overlays .............. animate-{pop-in,pop-out} (floating layers, spring) · animate-{sheet-in,sheet-out}
 *                         (drawers) · animate-{overlay-in,overlay-out} (backdrops) ·
 *                         animate-{tooltip-in,tooltip-out} (the quick, small-offset tooltip pair) — pair
 *                         with Radix data-[state=open/closed]. animate-check-morph (copy → check).
 * Icons ................. src/components/ui/icons.tsx (one set); hover articulation is
 *                         juno-icons/icons.css, on destinations marked data-jicon-articulate only.
 * Touch ................. p{t,b,l,r}-safe (env safe-area insets) · .pressable (press feedback, globals.css)
 * Elevation ............. Flat kit (docs/design/FLAT_UI.md): shadow-{raised,raised-lg,inset,
 *                         pressed,float} — theme-aware via --shadow-* CSS vars; inset and
 *                         pressed resolve to nothing since the 2026-09 retune. Components use
 *                         the composed .surface-{raised,raised-lg,inset,float} / .control-{neu,primary}
 *                         classes in globals.css, not the bare shadows. shadow-{soft,lift,glass}
 *                         are the legacy in-flow rungs, cut from the same two inks.
 * Radius ................ control 8 · field 10 · card 12 (= lg = surface = popover) · menu 14 ·
 *                         panel 16 · composer 22. Nested: nest-<rung> nest-p-<n> → rounded-inner.
 * Dot atoms ............. h-dot / w-dot / gap-dot-gap — the dot/ASCII signature unit
 * Working ............... the galaxy (components/brand/galaxy-mark.tsx, docs/design/GALAXY_SPEC.md)
 *                         is the one working mark; spinners only inside the button just pressed.
 * Keep raw hex out of components; drive everything from these tokens + the HSL vars.
 */

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: { "2xl": "1280px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },
        knob: "hsl(var(--knob) / <alpha-value>)",
        // The brand's one live colour (--presence in globals.css): marks, rings
        // and soft fills for work happening now. `text-presence` reads the ink
        // half (textColor below), as `text-primary` does.
        presence: {
          DEFAULT: "hsl(var(--presence) / <alpha-value>)",
          ink: "hsl(var(--presence-ink) / <alpha-value>)",
          // The finished-away wash (C22); carries its own alpha.
          wash: "hsl(var(--presence-wash))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
          ink: "hsl(var(--destructive-ink) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        // The on tone — selected, pressed, held — one rung past the `accent`
        // hover fill in both themes, so a control that is ON never reads
        // weaker than one the pointer is merely over. `secondary` is a tonal
        // fill (bubbles, tracks, badges), not a state. See globals.css.
        selected: "hsl(var(--selected) / <alpha-value>)",
        // Wave 2 roles (globals.css §3.1). `muted-on-fill` is quiet text on a
        // hover or selected fill, where `muted-foreground` fails AA; the
        // bubble-hover fill is for controls drawn on the user bubble.
        "muted-on-fill": "hsl(var(--muted-foreground-on-fill) / <alpha-value>)",
        "ink-tertiary": "hsl(var(--ink-tertiary) / <alpha-value>)",
        "user-bubble": {
          DEFAULT: "hsl(var(--user-bubble) / <alpha-value>)",
          hover: "hsl(var(--user-bubble-hover) / <alpha-value>)",
        },
        // The status roles (§3.4). StatusMark and every status consumer read
        // these, never presence / signal / destructive directly, so the
        // needs-you mapping (sign-off S1) changes in globals.css alone.
        status: {
          running: "hsl(var(--status-running) / <alpha-value>)",
          "needs-you": "hsl(var(--status-needs-you) / <alpha-value>)",
          "needs-you-ink": "hsl(var(--status-needs-you-ink) / <alpha-value>)",
          ready: "hsl(var(--status-ready) / <alpha-value>)",
          blocked: "hsl(var(--status-blocked) / <alpha-value>)",
        },
        signal: {
          DEFAULT: "hsl(var(--signal) / <alpha-value>)",
          ink: "hsl(var(--signal-ink) / <alpha-value>)",
          // Carries its own alpha (0.14 / 0.18): never add a second one.
          wash: "hsl(var(--signal-wash))",
        },
        attention: "hsl(var(--attention) / <alpha-value>)",
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        success: {
          DEFAULT: "hsl(var(--success) / <alpha-value>)",
          foreground: "hsl(var(--success-foreground) / <alpha-value>)",
          // AA text ramp on --background (fills only reach ~3:1 in light mode).
          ink: "hsl(var(--success-ink) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "hsl(var(--warning) / <alpha-value>)",
          // Text on a light surface — see the note in globals.css.
          foreground: "hsl(var(--warning-foreground) / <alpha-value>)",
        },
        source: {
          DEFAULT: "hsl(var(--source) / <alpha-value>)",
        },

        ultra: {
          DEFAULT: "hsl(var(--ultra) / <alpha-value>)",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-foreground) / <alpha-value>)",
          border: "hsl(var(--sidebar-border) / <alpha-value>)",
          // The panel's general tonal fill — the account band, the download
          // menu, the product switch's track.
          accent: "hsl(var(--sidebar-accent) / <alpha-value>)",
          // The two ROW STATES, which used to be this same accent at 60% and
          // at 100%. They are separate colours now because a state told apart
          // by opacity alone is not told apart at all; see the token block in
          // globals.css for the rungs.
          hover: "hsl(var(--sidebar-hover) / <alpha-value>)",
          selected: {
            DEFAULT: "hsl(var(--sidebar-selected) / <alpha-value>)",
            border: "hsl(var(--sidebar-selected-border) / <alpha-value>)",
          },
        },
        // The one dim value every modal backdrop shares. Four different scrim
        // treatments existed before this.
        scrim: "hsl(var(--scrim))",
        // Design-canvas selection chrome (canvas-selection / canvas-handle /
        // canvas-measure). The values live per-theme in globals.css, where the
        // note explains why selection keeps the editing-canvas blue convention
        // while the guide red and measure amber sit on the palette's own
        // destructive/warning hues. Chrome, not content: nothing outside the
        // design canvas should reach for these.
        canvas: {
          selection: "hsl(var(--canvas-selection) / <alpha-value>)",
          guide: "hsl(var(--canvas-guide) / <alpha-value>)",
          measure: "hsl(var(--canvas-measure) / <alpha-value>)",
        },
      },
      borderRadius: {
        // The Soft UI radius ladder (docs/design/SOFT_UI.md §2.3), single source.
        //
        //   control 8 · field 10 · card 12 · menu 14 · panel 16 · composer 22 · full
        //
        // Concentric rule: inner radius = outer radius − padding, with the SAME
        // padding on every side the two boxes share. A 12px card with p-1 (4px)
        // holds 8px controls; a 14px menu with p-1.5 (6px) holds 8px rows; a
        // 16px panel with p-1 holds 12px cards; the 22px composer's controls,
        // 10px in, are 12 (`composer-action`). Write it with `nest-<rung>` +
        // `nest-p-<step>` on the parent and `rounded-inner` on the child (the
        // plugin at the bottom of this file) and the arithmetic is done for
        // you; `design-system/concentric-radius` (eslint) checks the rest.
        //
        // `lg` IS `card` (= --radius, 12px) and `panel` is 16px. The old
        // `lg/surface` duality — two names for one 16px value, and a `lg` that
        // was quietly a different number from `card` — is gone: `surface` and
        // `popover` remain as ALIASES of `card` so no call site breaks, but they
        // are the same rung and the fixer reaches for `card`.
        //
        // The scale is enforced: `design-system/no-arbitrary-radius` (eslint)
        // rejects `rounded-[Npx]` and autofixes values that land on a rung. If
        // the ladder moves, update RADIUS_TOKENS in eslint-rules/design-system.mjs
        // in the same change, then `npm run design:tokens`.
        lg: "var(--radius)",
        md: "8px",
        sm: "4px",
        micro: "2px", // heatmap cells, crop handles — anything under ~12px square
        xs: "6px", // chips, dots, tiny badges
        // Alevr V3 ladder (docs/rework/brand/BRAND_IDENTITY.md): row 8, card 12,
        // popover 14, composer 22. Concentric: card 12 − p-1 = row 8; menu 14 −
        // p-1.5 = row 8; panel 16 − p-2 = row 8.
        control: "8px", // sm buttons, menu items, list rows, tooltips, kbd
        // The general small-container rung: inputs, textareas, wells, segmented
        // thumbs, icon tiles, inline notes, the dashed box a short empty state
        // sits in.
        field: "10px",
        menu: "14px", // dropdown / select / tabs shells
        card: "12px", // cards, toasts, tiles
        popover: "12px", // alias of card — popovers, transcripts
        surface: "12px", // alias of card — in-flow panels and section wells
        panel: "16px", // dialogs, sheets (inner edge)
        // The composer is a raised soft card and takes the panel rung. It is
        // distinct through placement and material, not an oversized novelty
        // radius.
        composer: "26px",
        // Marketing stages only: the painted plates and product shots on the
        // front door (landing, download, auth art). Never inside the product.
        stage: "28px",
        // The two composer-seated control radii. Every control on the composer's
        // controls row — the `+`, the mic, the primary action — sits 10px in
        // from the 22px shell, so it takes `composer-action` (22 − 10 = 12).
        // `composer-control` is the tighter seat for a control inset further.
        // Both are nested inside the composer shell and neither is on the main
        // ladder, which is exactly why they need names: they are derived, not
        // chosen. They move WITH the shell — nesting reads as concentric only
        // while the inner radius stays a consistent fraction of the outer one,
        // so a shell that got 2px rounder hands its children a share of it.
        "composer-control": "14px",
        "composer-action": "16px",
        // The one user bubble (spec D6, sign-off S3): card radius, with an 8px
        // tuck on the logical end-end corner — `rounded-bubble
        // rounded-ee-bubble-tuck`, which mirrors in RTL. Mirrored as
        // --radius-bubble / --radius-bubble-tuck in globals.css for CSS recipes.
        bubble: "12px",
        "bubble-tuck": "8px",
        // Provider/product marks. A PERCENTAGE, not px, so one value is one shape
        // at every size — 24% is the iOS app-icon superellipse ratio these marks
        // are imitating. Owned by <ProviderLogo>; call sites must not override it.
        // Three different values (24/28/32%) were in use on the same component.
        logo: "24%",
        // For overlays that must trace whatever they are laid over (drag scrims,
        // focus rings on an unknown parent). A keyword, not a magic number.
        inherit: "inherit",
        // THE CONCENTRIC CHILD. `rounded-inner` is its parent's radius minus its
        // parent's padding, read off the two custom properties the parent sets
        // with `nest-<rung>` and `nest-p-<step>` (the plugin below):
        //
        //   <div class="nest-menu nest-p-1.5">        14px shell, 6px inset
        //     <div class="rounded-inner">…</div>      → 8px, by construction
        //
        // Move the shell a rung or change its padding and the child follows —
        // the arithmetic lives in one place instead of in a comment beside every
        // nested box. The fallbacks are the menu recipe's own numbers (14 − 6 =
        // 8), so a row rendered outside any `nest-*` parent is still a control.
        // A calc, not px, so the native token mirror skips it (it reads px only).
        inner: "max(0px, calc(var(--r-outer, 14px) - var(--pad, 6px)))",
      },
      boxShadow: {
        // The Soft UI depth kit (globals.css `--shadow-*`, per theme). Prefer the
        // composed `.surface-*` / `.control-*` classes — they carry the hairline
        // and fill too; reach for the bare shadow only when composing a one-off
        // that already has both.
        raised: "var(--shadow-raised)",
        "raised-lg": "var(--shadow-raised-lg)",
        inset: "var(--shadow-inset)",
        pressed: "var(--shadow-pressed)",
        // The out-of-flow rung: popovers, dialogs, toasts, tooltips, sheets.
        float: "var(--shadow-float)",
        // Legacy in-flow rungs, cut from the same two inks. soft < lift < glass
        // < float stays monotonic: an in-flow element never out-elevates a
        // floating one.
        soft: "var(--shadow-soft)",
        lift: "var(--shadow-lift)",
        glass: "var(--shadow-glass)",
        // Crisp shadow for small chips, the accent halo, and `well` as an alias
        // of `inset` for the one call site that predates the kit (it reads the
        // inset token directly now that the `--well-inset` alias is gone).
        pop: "var(--shadow-pop)",
        well: "var(--shadow-inset)",
      },
      // The out-of-flow stacking order. globals.css has declared these since the
      // depth kit landed — "so a new one has somewhere to look up its answer
      // instead of picking a number" — but they were never mapped into Tailwind,
      // so the answer was unreachable from a className and every call site went
      // on picking a number anyway: 15 hardcoded `z-50`s, plus `z-[60]`, `z-[70]`
      // and a `z-[100]` that outranks everything in the product including the
      // modal scrim. A scale you cannot type is not a scale.
      zIndex: {
        aura: "var(--z-aura)", // the voice light: over the interface, under input
        popper: "var(--z-popper)", // menus, popovers, selects, tooltips
        modal: "var(--z-modal)", // the dialog scrim and its panel
        toolbar: "var(--z-toolbar)", // floating toolbars that must clear a popper
        toast: "var(--z-toast)", // the top of the product; nothing goes above it
      },
      spacing: {
        // Dot/ASCII signature unit.
        dot: "var(--dot-size)",
        "dot-gap": "var(--dot-gap)",
        // 18px. Tailwind's default scale jumps 16 → 20 with nothing between, and
        // 18px is a size this product genuinely uses for the slightly-larger
        // interface glyph — on the icon ladder it is the sidebar-destination
        // rung (docs/design/ICONS_AND_MOTION.md §1.2). With no rung to land on,
        // call sites had split into two workarounds: seven wrote
        // `h-[18px] w-[18px]`, and three wrote `size-4.5` — which Tailwind did
        // not define, so it emitted NO css at all and those icons silently
        // rendered at the glyph's intrinsic 24px box. Naming the rung is what
        // makes both spellings converge on one real value.
        "4.5": "1.125rem",
      },
      transitionTimingFunction: {
        // Every key reads the CSS token, with the token's value as the
        // fallback, so a utility and a hand-written `var(--ease-*)` are one
        // curve and the reduced-motion overrides in globals.css (which flatten
        // out-strong, out-expo, spring and drawer onto out-soft) reach the
        // `ease-*` utilities too. They used to be literal copies the media
        // query could not touch. The fallback keeps a document that never loads
        // globals.css on the same curve.
        //
        // Tailwind's stock `ease-out` (0,0,.2,1) and the bare `transition`
        // default (.4,0,.2,1) are not on the ladder; hundreds of call sites
        // write them. Pointing both at out-soft puts every one of those on
        // the house curve without touching a call site (BRAND_IDENTITY.md,
        // "Motion and interaction").
        DEFAULT: "var(--ease-out-soft, cubic-bezier(0.33, 1, 0.68, 1))",
        out: "var(--ease-out-soft, cubic-bezier(0.33, 1, 0.68, 1))",
        "out-soft": "var(--ease-out-soft, cubic-bezier(0.33, 1, 0.68, 1))",
        "out-strong": "var(--ease-out-strong, cubic-bezier(0.32, 0.72, 0, 1))",
        "out-expo": "var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1))",
        // The product had NO accelerate curve, so every exit ran an entrance
        // curve — which is why dismissals felt like the UI was reluctant to let
        // go. `in-out` is for A-to-B moves where both endpoints are visible
        // (chevron rotate, accordion, sidebar width); running those on an
        // ease-out makes them look like they arrive from off-screen.
        in: "var(--ease-in, cubic-bezier(0.4, 0, 1, 1))",
        "in-out": "var(--ease-in-out, cubic-bezier(0.65, 0, 0.35, 1))",
        // The only symmetric curve here, and the only one meant for a LOOP:
        // loops have a seam that an ease-out visibly pulses at. See the
        // reasoning beside --ease-breathe in globals.css.
        breathe: "var(--ease-breathe, cubic-bezier(0.45, 0, 0.55, 1))",
        // The one overshooting curve — for elements with apparent mass that
        // should settle rather than stop. See --ease-out-back in globals.css.
        "out-back": "var(--ease-out-back, cubic-bezier(0.34, 1.32, 0.64, 1))",
        // Soft UI (SOFT_UI.md §2.4). `spring` is the entrance curve for
        // anything that pops into place: a long, overshoot-free settle (opacity
        // past 1 just clips). `drawer` is the sheet curve: front-loaded,
        // overshoot-free, named for the job.
        spring: "var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1))",
        drawer: "var(--ease-drawer, cubic-bezier(0.32, 0.72, 0, 1))",
      },
      // The duration ladder, read from the same custom properties (values as
      // fallbacks) so `duration-slow` shortens to the base rung under reduced
      // motion exactly as `var(--dur-slow)` does.
      // tests/tailwind-motion-tokens.test.ts holds every key to its token.
      transitionDuration: {
        press: "var(--dur-press, 70ms)",
        fast: "var(--dur-fast, 120ms)",
        exit: "var(--dur-exit, 160ms)",
        base: "var(--dur-base, 220ms)",
        slow: "var(--dur-slow, 360ms)",
        // One rung above slow, reserved for a change the user did not cause —
        // see the reasoning beside --dur-emphasis in globals.css.
        emphasis: "var(--dur-emphasis, 560ms)",
      },
      fontFamily: {
        // A single product voice: Inter is every control, heading and reading
        // surface (docs/design/FLAT_UI.md §5 — it replaced Archivo in the flat
        // retune). `serif` is Newsreader (loaded in layout.tsx as --font-serif)
        // and is reserved for the human moments — the empty-chat greeting — so
        // it never competes with the interface face. Mono is code, ids and
        // compact telemetry.
        sans: [
          "var(--font-sans)",
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        serif: [
          "var(--font-serif)",
          "Newsreader",
          "var(--font-serif-cyr)",
          "Georgia",
          "Times New Roman",
          "serif",
        ],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      fontSize: {
        // The rem intercept in every clamp below is NOT stylistic. A pure
        // relative-unit preferred value ignores the user's base font size, so
        // browser text zoom has no effect at all on the largest type in the
        // product (WCAG 1.4.4). Keep the intercept in rem whenever you retune
        // one of these.
        //
        // `hero` is the ONE rung still measured in `vw`, and that is correct
        // rather than an oversight: it appears only on the landing page, which
        // is a full-bleed marketing surface with no sidebar and no column, so
        // the window IS its container. Anchored 360px → 1280px.
        //   hero  38.4px → 64px : m = 2.7826vw, b = 28.38px = 1.7739rem
        hero: [
          "clamp(2.4rem, 1.7739rem + 2.7826vw, 4rem)",
          { lineHeight: "1.1", letterSpacing: "-0.02em" },
        ],
        /*
         * Type scale. Contrast comes from family (serif/sans/mono) + 3x size
         * jumps, not timid weights.
         *
         * THE TWO FLUID APP RUNGS ARE MEASURED IN `cqi`, NOT `vw` — 1% of the
         * content column's inline size, against the `page` container declared
         * on `.app-main-canvas`. They were `vw`, and `vw` is the window, which
         * is not what a page has: the sidebar takes 256px of the window until
         * the breakpoint where it starts floating and then stops taking it, so
         * window and column move independently and for one stretch in opposite
         * directions. Measured before this change, a 900px window gave a
         * WIDER column than a 1120px window and a SMALLER title — the same
         * page, larger, in less type.
         *
         * Anchored to the two measures rather than to device widths: the
         * minimum is the size at a 640px column, the maximum at 1024px, which
         * are exactly where the gutter steps in globals.css. One set of
         * thresholds for the whole page frame.
         *   display     32px → 48px : m = 4.1667cqi, b = 5.33px = 0.3333rem
         *   page-title  32px → 44px : m = 3.125cqi,  b = 12px   = 0.75rem
         */
        display: [
          "clamp(2rem, 0.3333rem + 4.1667cqi, 3rem)",
          { lineHeight: "1.08", letterSpacing: "-0.02em", fontWeight: "500" },
        ],
        /*
         * The <h1> of an app page — the rung between `display` (marketing) and
         * `title` (a section head). It was missing, so the size that appears on
         * more screens than any other display size in the product was being
         * hand-written at each call site, and had already drifted three ways:
         *
         *   app-page-header.tsx   clamp(1.65rem, 1.4rem  + 0.8vw, 2.1rem)  -0.02em
         *   compare-view.tsx      clamp(1.65rem, 1.4rem  + 0.8vw, 2.1rem)  -0.025em
         *   projects/[id]         clamp(1.7rem,  1.45rem + 0.8vw, 2.15rem) -0.025em
         *
         * Two of those differ only in tracking and one only in a 0.05rem step —
         * differences nobody chose, which is what an unnamed size always
         * produces. The rem intercept is kept for the reason the two clamps above
         * document: a pure-vw preferred value ignores the user's base font size,
         * so text zoom cannot move it (WCAG 1.4.4).
         */
        /*
         * Revamp (owner, 2026-10-03: "use the design system of the website"):
         * 32px → 44px across the same 640 → 1024 column, at the homepage's
         * display tracking, so an app page opens in the homepage's voice.
         *   m = 3.125cqi, b = 12px = 0.75rem
         */
        //
        // Wave 2 (spec §3.5): Newsreader 500 — every app h1, Settings
        // included, sets this rung in `font-serif`. Below a 640px viewport it
        // is a fixed 1.75rem (globals.css, `.text-page-title` in utilities),
        // which a clamp keyed to the column cannot say.
        "page-title": [
          "clamp(2rem, 0.75rem + 3.125cqi, 2.75rem)",
          { lineHeight: "1.08", letterSpacing: "-0.03em", fontWeight: "500" },
        ],
        /*
         * The home greeting (spec §3.5, C3): Newsreader 400, one step under
         * `display` at the narrow end and over it at the wide one, keyed to the
         * column like the rungs above.
         *   home-title  34px → 50px : m = 2.2cqi, b = 24px = 1.5rem
         */
        "home-title": [
          "clamp(2.125rem, 1.5rem + 2.2cqi, 3.125rem)",
          { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "400" },
        ],
        title: [
          "1.375rem",
          { lineHeight: "1.25", letterSpacing: "-0.012em", fontWeight: "600" },
        ],
        heading: [
          "1.125rem",
          { lineHeight: "1.3", letterSpacing: "-0.006em", fontWeight: "600" },
        ],
        "body-lg": ["1.0625rem", { lineHeight: "1.6" }],
        /*
         * The conversation's reading size: both speakers in a chat, the
         * assistant's prose (`.prose-juno` in globals.css states the same two
         * numbers) and the user's bubble (`USER_BUBBLE_CLASS`). 16px because
         * that is what Claude and ChatGPT set replies at, and at 15px a long
         * answer read a size smaller than the products it sits next to. 1.7
         * rather than body's 1.6: this rung is for paragraphs read in flow,
         * where the extra leading is what keeps a 75ch line easy to track back.
         */
        reading: ["1rem", { lineHeight: "1.7" }],
        body: ["0.9375rem", { lineHeight: "1.6" }],
        /*
         * The navigation rung: sidebar rows, conversation and project titles,
         * the account name. 14px on a 20px line, which is what Claude and
         * ChatGPT set their sidebars in. `body` (15px) is the size the product
         * reads prose at, and chrome at reading size competes with the
         * transcript beside it; `ui` (13px) is dense furniture read at a
         * glance, one step too small for a column people scan all day. A fixed
         * 20px line rather than a ratio, because every one of these sits
         * centred in a fixed-height row.
         */
        nav: ["0.875rem", { lineHeight: "1.25rem" }],
        /*
         * The dense-UI rung — list rows, chips, option text, table cells:
         * interface furniture read at a glance, not prose read in flow. It was
         * the widest hole in the scale: 116 call sites were hand-writing it as
         * text-[13px] (80) or text-[12.5px] (36), the half pixel being a
         * difference nobody chose and one no 1x display can honour anyway.
         *
         * Plain rem, not a clamp — and that is the same WCAG 1.4.4 reasoning
         * the fluid rungs above document, seen from the other side. The rem
         * intercept exists up there so user text size can still move a
         * vw-driven value; a size with no vw term is already fully in the
         * user's hands, and any viewport term on a 13px rung would SHRINK
         * dense rows precisely on the small screens where they are hardest to
         * read. 1.5, not body's 1.6: rows and chips are usually one line tall,
         * and their rhythm comes from the row grid, not from leading.
         */
        ui: ["0.8125rem", { lineHeight: "1.5" }],
        // All metadata and section headings (spec §3.5): JetBrains Mono 500,
        // sentence case, tabular figures. globals.css gives `.text-label` the
        // mono face and tabular-nums at zero specificity (`:where`), so an
        // explicit `font-sans` beside it still wins.
        /*
         * 0.01em, down from 0.10em. A tenth of an em is a CAPS tracking: caps
         * are all the same height with no ascenders or descenders to separate
         * them, so they need the air. This rung is set in sentence case now
         * (see the eyebrow note in docs/design/PREMIUM_AUDIT.md), and at 0.10em
         * sentence-case mono reads as l e t t e r s p a c e d — the one
         * typographic effect that looks like a mistake rather than a choice.
         */
        label: [
          "0.75rem",
          { lineHeight: "1.4", letterSpacing: "0.01em", fontWeight: "500" },
        ],
        /*
         * THE TYPE FLOOR (spec D16, owner sign-off S4): 12px on the web. The
         * two rungs under it are lifted here, in one place, which raises every
         * one of their ~1,344 uses at once; each package then moves its own
         * uses to the semantic rung (`label` for metadata, `ui` for controls).
         * `caption` is a deprecated name for 12px sans; `micro` is RETIRED and
         * aliased to it until its last use moves. The transcript-chrome lint
         * (eslint-rules) flags both inside the turn body, the composer,
         * tooltips, notifications and the sidebar.
         */
        caption: ["0.75rem", { lineHeight: "1.4" }],
        micro: ["0.75rem", { lineHeight: "1.4" }],
        /*
         * The one rung under the floor, and only for keycaps and count badges of
         * up to three characters (Kbd and Badge; the lint keeps it there). 11px
         * mono — globals.css gives `.text-kbd` the mono face and tabular
         * figures, which a fontSize entry cannot.
         */
        kbd: ["0.6875rem", { lineHeight: "1.45" }],
      },
      /*
       * Text colour is NOT the same ramp as fill colour.
       *
       * `colors` drives bg-*, text-* and border-* alike, so `text-warning` resolved
       * to the FILL token --warning, which measures 2.36:1 on its own chip. The
       * AA text ramps (--warning-foreground, --success-ink, --destructive-ink,
       * --primary-ink) already existed and were only reached by hand at a minority
       * of call sites.
       *
       * This block is ADDITIVE — every bg-* and border-* utility resolves exactly
       * as before. Only text-* moves onto the ink ramps, which fixes ~219 call
       * sites with zero component edits. Where a fill tone is genuinely wanted as
       * text, the *-foreground keys are preserved.
       */
      textColor: {
        presence: {
          DEFAULT: "hsl(var(--presence-ink) / <alpha-value>)",
          ink: "hsl(var(--presence-ink) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "hsl(var(--primary-ink) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
          // Alias, as `destructive.ink` is: `text-primary-ink` was written at ten
          // call sites and silently generated nothing before this key existed.
          ink: "hsl(var(--primary-ink) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive-ink) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
          ink: "hsl(var(--destructive-ink) / <alpha-value>)",
        },
        success: {
          DEFAULT: "hsl(var(--success-ink) / <alpha-value>)",
          foreground: "hsl(var(--success-foreground) / <alpha-value>)",
          ink: "hsl(var(--success-ink) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "hsl(var(--warning-foreground) / <alpha-value>)",
          foreground: "hsl(var(--warning-foreground) / <alpha-value>)",
        },
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        // Every travelling/scaling keyframe below reads --motion-shift and
        // --motion-scale-from. That is the ENTIRE mechanism behind Tier B of the
        // reduced-motion policy in globals.css: the two vars are set to 0 and 1
        // under `prefers-reduced-motion`, which collapses travel and overshoot to
        // identity while the fade keeps its timing. Both vars were declared and
        // read by nothing, so Tier B silently did not exist and every entrance
        // kept its full transform — "worse than the clamp it replaced", as the
        // note beside them says. The fallback in each `var()` is that keyframe's
        // own original value, so nothing changes when the preference is unset.
        "fade-in-up": {
          from: {
            opacity: "0",
            transform: "translateY(calc(6px * var(--motion-shift, 1)))",
          },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.9)", opacity: "0.7" },
          "70%": { transform: "scale(1.3)", opacity: "0" },
          "100%": { transform: "scale(1.3)", opacity: "0" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.2" },
        },
        "dot-wave": {
          "0%, 60%, 100%": { transform: "translateY(0)", opacity: "0.4" },
          "30%": { transform: "translateY(-4px)", opacity: "1" },
        },
        "icon-breathe": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.85" },
          "50%": { transform: "scale(1.1)", opacity: "1" },
        },
        // 6px (SOFT_UI.md §2.4), down from 8: the workhorse entrance should be
        // felt as settling, not as arriving from somewhere. `src/lib/motion.ts`
        // mirrors the offset (SHIFT.rise) — change both.
        // Agents (docs/design/agents-rework/DIRECTION.md): a face changing its
        // look in the studio, and a new agent arriving. Spring overshoot, once.
        "studio-swap": {
          "0%": { opacity: "0.55", transform: "scale(calc(1 - 0.1 * var(--motion-shift, 1)))" },
          "60%": { opacity: "1", transform: "scale(calc(1 + 0.04 * var(--motion-shift, 1)))" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "agent-arrive": {
          "0%": { opacity: "0", transform: "scale(calc(1 - 0.4 * var(--motion-shift, 1))) translateY(calc(12px * var(--motion-shift, 1)))" },
          "55%": { opacity: "1", transform: "scale(calc(1 + 0.06 * var(--motion-shift, 1))) translateY(0)" },
          "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        // `turn-in` (420ms out of a 4px blur) is RETIRED (spec C1): no entrance
        // blurs, and the assistant turn's root does not animate at all. The
        // user bubble rises with `animate-rise-user`; parts settle with
        // `animate-settle-part`. Both keyframes live in globals.css, beside
        // the tier table, so plain CSS rules can name them too.
        "rise-in": {
          from: {
            opacity: "0",
            transform: "translateY(calc(6px * var(--motion-shift, 1)))",
          },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Sheets slide in from their own edge. `--sheet-from` is set per side
        // by sheet.tsx (-100% left, 100% right); multiplied by --motion-shift
        // so the reduced-motion tier keeps the fade and drops the travel —
        // which tailwindcss-animate's slide-in-from-* could never do, since its
        // translate is a hardcoded -100% no preference can reach.
        "sheet-in": {
          from: {
            opacity: "0",
            transform: "translateX(calc(var(--sheet-from, -100%) * var(--motion-shift, 1)))",
          },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "sheet-out": {
          from: { opacity: "1", transform: "translateX(0)" },
          to: {
            opacity: "0",
            transform: "translateX(calc(var(--sheet-from, -100%) * var(--motion-shift, 1)))",
          },
        },
        // Copy → check (`.check-morph`). Springs in from small-and-tilted; both
        // vars read so the reduced tier is a fade.
        "check-morph": {
          from: {
            opacity: "0",
            transform:
              "scale(var(--motion-scale-from, 0.5)) rotate(calc(-14deg * var(--motion-shift, 1)))",
          },
          to: { opacity: "1", transform: "scale(1) rotate(0deg)" },
        },
        // Live UI steps and quiz (live-ui-learning.tsx). One parametrized
        // keyframe covers both navigation directions: the caller sets --stage-dx
        // to 12px (forward) or -12px (back) on the keyed stage element.
        "stage-in": {
          from: {
            opacity: "0",
            transform:
              "translateX(calc(var(--stage-dx, 12px) * var(--motion-shift, 1)))",
          },
          to: { opacity: "1", transform: "none" },
        },
        // Wrong-answer feedback — a one-shot 3px sideways nudge, then still.
        nudge: {
          "0%, 100%": { transform: "translateX(0)" },
          "35%": {
            transform: "translateX(calc(-3px * var(--motion-shift, 1)))",
          },
          "70%": {
            transform: "translateX(calc(2px * var(--motion-shift, 1)))",
          },
        },
        // Draws an SVG path once (next-token autoregression return arc). The
        // caller sets stroke-dasharray and --draw-len to the path length.
        "stroke-draw": {
          from: { strokeDashoffset: "var(--draw-len, 120)" },
          to: { strokeDashoffset: "0" },
        },
        "title-in": {
          "0%": {
            opacity: "0",
            transform:
              "translateY(calc(4px * var(--motion-shift, 1))) scale(var(--motion-scale-from, 0.985))",
            backgroundColor: "hsl(var(--primary) / 0.12)",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0) scale(1)",
            backgroundColor: "transparent",
          },
        },
        "title-out": {
          "0%": { opacity: "1", transform: "translateY(0) scale(1)" },
          "100%": {
            opacity: "0",
            transform:
              "translateY(calc(-4px * var(--motion-shift, 1))) scale(var(--motion-scale-from, 0.985))",
          },
        },
        // Overlay enter/exit pair — sized for Radix data-[state=open/closed].
        // --pop-shift makes the 4px drift origin-aware: .origin-popper layers
        // flip it per data-side (globals.css) so a menu always emerges from its
        // trigger — a bottom-anchored menu rises 4px, a top-anchored one settles
        // 4px down. Non-popper users of animate-pop-in keep the 4px-rise default.
        // 2026-10: the layer also comes into focus (a 3px blur that clears),
        // scaled by --motion-shift so reduced motion keeps a plain fade.
        "pop-in": {
          from: {
            opacity: "0",
            transform:
              "translateY(calc(var(--pop-shift, 4px) * var(--motion-shift, 1))) scale(var(--motion-scale-from, 0.96))",
            filter: "blur(calc(3px * var(--motion-shift, 1)))",
          },
          to: { opacity: "1", transform: "translateY(0) scale(1)", filter: "blur(0)" },
        },
        "pop-out": {
          from: { opacity: "1", transform: "translateY(0) scale(1)" },
          to: {
            opacity: "0",
            transform:
              "translateY(calc(var(--pop-shift, 4px) * var(--motion-shift, 1))) scale(var(--motion-scale-from, 0.96))",
          },
        },
        "fade-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        /*
         * The tooltip pair. A tooltip is the smallest floating layer and the one
         * that opens most often, so it moves least: HALF the popper drift (2px,
         * still toward the trigger via --pop-shift from `.origin-popper`) and a
         * 0.97 start rather than the menu's 0.96, on the fast rung with no
         * overshoot. A micro-label that springs reads as a toy; one that fades
         * in place with a hair of travel reads as the interface answering.
         *
         * Both terms multiply --motion-shift, so the reduced tier (globals.css)
         * collapses travel and scale to identity and keeps the fade.
         */
        "tooltip-in": {
          from: {
            opacity: "0",
            transform:
              "translateY(calc(var(--pop-shift, 4px) * 0.5 * var(--motion-shift, 1))) scale(calc(1 - 0.03 * var(--motion-shift, 1)))",
          },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "tooltip-out": {
          from: { opacity: "1", transform: "translateY(0) scale(1)" },
          to: {
            opacity: "0",
            transform:
              "translateY(calc(var(--pop-shift, 4px) * 0.5 * var(--motion-shift, 1))) scale(calc(1 - 0.03 * var(--motion-shift, 1)))",
          },
        },
        /*
         * A jumped-to citation, marked once and let go — the landing signal for
         * the thought panel's jump-to-source (thought-process-panel.tsx). The
         * reader clicks a source row in the dock, the transcript scrolls, and
         * without this there is nothing to say WHICH bracket it stopped on.
         *
         * Colour only: nothing travels and nothing scales, so this is safe under
         * the reduced tier and is deliberately NOT guarded by `motion-safe` —
         * removing it would remove the only confirmation that the jump landed.
         *
         * Not `title-in`, which is the nearest existing keyframe and would be
         * exactly wrong: it starts at `opacity: 0`, so it would blink the cited
         * text out at the moment the reader was sent to look at it.
         */
        "cite-flash": {
          "0%": { backgroundColor: "hsl(var(--primary) / 0.18)" },
          "100%": { backgroundColor: "transparent" },
        },
        // Generation placeholder — two long-period gradient orbs drifting out of
        // phase (16s/22s) so the field never reads as a visible loop.
        "gen-drift-a": {
          "0%, 100%": { transform: "translate(-6%, -4%) scale(1)" },
          "50%": { transform: "translate(8%, 6%) scale(1.12)" },
        },
        "gen-drift-b": {
          "0%, 100%": { transform: "translate(6%, 5%) scale(1.08)" },
          "50%": { transform: "translate(-8%, -6%) scale(1)" },
        },
        "gen-grid-pulse": {
          "0%, 100%": { opacity: "0.35" },
          "50%": { opacity: "0.75" },
        },
        // ---- Reasoning slider, top tier ("Max") ----
        // The gradient is sized 200% and panned, so the hue drifts without the
        // element itself moving. Paired with `bg-[length:200%_100%]`.
        "ultra-pan": {
          "0%": { backgroundPosition: "0% 50%" },
          "100%": { backgroundPosition: "-200% 50%" },
        },
        // Star field over the filled track: each particle DRIFTS a little and
        // breathes, rather than blinking in place.
        //
        // It used to snap 0 -> 0.95 -> 0.2 opacity on a ~2.6s loop. Hard white
        // pulsing that fast, over a gradient that was itself sweeping every 6s,
        // read as strobing rather than as a field of stars. Now the peak is soft
        // (~0.5) and the motion is carried by translation, which the eye reads as
        // life without demanding attention. Direction/peak are per-particle CSS
        // vars so no two sparks travel the same way.
        "ultra-spark": {
          "0%, 100%": {
            opacity: "0",
            transform: "translate3d(0, 0, 0) scale(0.6)",
          },
          "50%": {
            opacity: "var(--spark-peak, 0.5)",
            transform:
              "translate3d(var(--spark-dx, 4px), var(--spark-dy, -2px), 0) scale(1)",
          },
        },
        // One-shot flourish when the thumb lands on the top tier.
        "ultra-pop": {
          "0%": { transform: "translateY(-50%) scale(1)" },
          "45%": { transform: "translateY(-50%) scale(calc(1 + 0.18 * var(--motion-shift, 1)))" },
          "100%": { transform: "translateY(-50%) scale(1)" },
        },
      },
      animation: {
        // A-to-B moves with both endpoints visible run in-out, not ease-out; and
        // the collapse is faster than the expand, like every other exit here.
        // These two previously used the raw `ease-out` keyword — off-token entirely.
        // `fade-in` is the keyframe `page-in` and `overlay-in` both build on, so
        // it is the most-run animation in the product — and it was the last pair
        // still on the raw `ease-out` keyword and off-ladder 200/250ms, the exact
        // fault the accordion pair above was fixed for.
        "fade-in": "fade-in var(--dur-base) var(--ease-out-soft)",
        "fade-in-up": "fade-in-up var(--dur-base) var(--ease-out-soft)",
        "pulse-ring": "pulse-ring var(--loop-breathe) var(--ease-breathe) infinite",
        // One-shot variant (quiz correct-answer flourish) — the arbitrary
        // [animation-iteration-count:1] override does NOT work on animate-*
        // utilities (the shorthand re-declares iteration-count later in the
        // stylesheet at equal specificity), so a named one-shot is required.
        "pulse-ring-once": "pulse-ring var(--loop-breathe) var(--ease-breathe) 1 both",
        // linear: the band exits one edge and teleports to the other, so there is
        // no turn to ease — an eased sweep decelerates into the seam and jumps.
        blink: "blink var(--loop-beat) steps(1) infinite",
        // 6px of travel is a --dur-base move on the default decelerate; the
        // old slow/out-strong pairing was sized for the 8px it no longer has.
        "rise-in": "rise-in var(--dur-base) var(--ease-out-soft)",
        // The user bubble lands (C1): a 6px × shift rise over the fast rung,
        // painted within 100ms of Enter. Keyframe in globals.css.
        "rise-user": "rise-user var(--dur-fast) var(--ease-out-soft) both",
        // An answer part arriving mid-stream: 4px × shift over the base rung,
        // no blur. Keyframe in globals.css.
        "settle-part": "settle-part var(--dur-base) var(--ease-out-soft) both",
        "studio-swap": "studio-swap var(--dur-emphasis) var(--ease-spring) both",
        "agent-arrive": "agent-arrive var(--dur-emphasis) var(--ease-spring) both",
        // Drawers (sheet.tsx). Enter on the drawer curve at --dur-base — a
        // 280px panel wants ~240ms — and leave faster on the accelerate, as
        // every exit here does.
        "sheet-in": "sheet-in var(--dur-base) var(--ease-drawer) both",
        "sheet-out": "sheet-out var(--dur-exit) var(--ease-in) both",
        "check-morph": "check-morph var(--dur-base) var(--ease-spring) both",
        // Live UI steps/quiz: direction-aware step navigation (strong), one-shot
        // wrong-answer nudge (soft), one-shot SVG path draw (expo).
        "stage-in": "stage-in var(--dur-base) var(--ease-out-strong) both",
        nudge: "nudge var(--dur-base) var(--ease-out-soft)",
        "stroke-draw": "stroke-draw var(--dur-slow) var(--ease-out-expo) both",
        // A loop turns around at both ends, so it takes the symmetric curve —
        // `ease-in-out` the keyword is NOT --ease-in-out the token, and neither
        // is the loop curve. See --ease-breathe.
        "icon-breathe": "icon-breathe var(--loop-galaxy) var(--ease-breathe) infinite",
        "title-out": "title-out var(--dur-exit) var(--ease-in)",
        // Floating layers: data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out
        // (pair with .origin-popper on Radix popper content so scale anchors to the trigger).
        // Enter on the SPRING at --dur-base (SOFT_UI.md §2.4): scale .96 → 1
        // with a ~2% overrun, so a menu settles into place rather than stopping
        // on it. The exit reverses faster on the accelerate, as leaving should.
        "pop-in": "pop-in var(--dur-base) var(--ease-spring) both",
        "pop-out": "pop-out var(--dur-fast) var(--ease-in) both",
        // Dialogs: the same spring pop, one exit rung slower because a dialog
        // is a bigger box. Replaces the tailwindcss-animate chain on DialogContent.
        "modal-in": "pop-in var(--dur-base) var(--ease-spring) both",
        "modal-out": "pop-out var(--dur-exit) var(--ease-in) both",
        // Tooltips: in on the fast rung and the plain decelerate (no spring —
        // see the keyframe note), out on the same rung on the accelerate, which
        // is what makes the exit read as the quicker of the two.
        "tooltip-in": "tooltip-in var(--dur-fast) var(--ease-out-soft) both",
        "tooltip-out": "tooltip-out var(--dur-fast) var(--ease-in) both",
        // Route changes (page-transition.tsx). Reuses the opacity-only `fade-in`
        // keyframe on purpose — a transform here would create a containing block
        // and break the `fixed` model-selector / canvas panel.
        // 280ms on out-expo front-loaded so hard that an opacity-only fade appeared
        // instantly and then hung; base on out-soft reads as one move.
        // Dialog/sheet backdrops. The scrim LEADS on open (the dim establishes
        // context before the panel arrives) and TRAILS on close (it must outlast
        // the panel it dims). Previously the scrim cleared in 150ms while
        // SheetContent took 220ms to leave, so the drawer finished sliding over an
        // already-undimmed page.
        "cite-flash": "cite-flash var(--dur-slow) var(--ease-out-soft) both",
        "overlay-in": "fade-in var(--dur-fast) var(--ease-out-soft) both",
        "overlay-out": "fade-out var(--dur-base) var(--ease-in) both",
        // Reasoning slider's top tier (reasoning-slider.tsx).
        // 24s, not 6s: the gradient should read as a slow luminous drift, not a
        // sweep. `linear` is deliberate — an eased loop visibly pulses at the
        // seam, which is the thing that looked like flashing.
        // Per-particle durations (7-13s) are set inline; this is only the fallback.
      },
    },
  },
  plugins: [
    animate,
    /*
     * `@sm:` / `@md:` / `@lg:` / `@[40rem]:` — size classes measured on the
     * nearest `@container` ancestor instead of the window. PREMIUM_AUDIT.md
     * rule 11 has said "size by the container, never the viewport" since the
     * September audit, and `<main>` has been `container-type: inline-size`
     * (globals.css `.app-main-canvas`) just as long — but no variant existed
     * to write it with, so every one of ~42 files kept keying on `sm:`/`md:`/
     * `lg:`, and the migration the rule describes was unimplementable as
     * written. This is the missing half.
     */
    containerQueries,
    /*
     * The concentric pair (see `rounded-inner` above). `nest-card` is
     * `rounded-card` that also publishes its radius as `--r-outer`; `nest-p-1`
     * is `p-1` that also publishes its inset as `--pad`. Both read the real
     * ladders, so there is no second table to keep in step.
     */
    plugin(({ matchUtilities, theme }) => {
      const radii = Object.fromEntries(
        Object.entries((theme("borderRadius") ?? {}) as Record<string, string>).filter(
          ([name]) => !["inner", "inherit", "full", "none", "logo", "DEFAULT"].includes(name),
        ),
      );
      matchUtilities(
        { nest: (value: string) => ({ "--r-outer": value, borderRadius: value }) },
        { values: radii },
      );
      matchUtilities(
        { "nest-p": (value: string) => ({ "--pad": value, padding: value }) },
        { values: theme("spacing") as Record<string, string> },
      );
    }),
    // `coarse:` → touch devices, for 44px hit areas (WCAG AA).
    plugin(({ addVariant, addUtilities }) => {
      addVariant("coarse", "@media (pointer: coarse)");
      // iOS notch/home-indicator breathing room (composer, sheets, full-bleed layouts).
      addUtilities({
        ".pt-safe": { paddingTop: "env(safe-area-inset-top, 0px)" },
        ".pb-safe": { paddingBottom: "env(safe-area-inset-bottom, 0px)" },
        ".pl-safe": { paddingLeft: "env(safe-area-inset-left, 0px)" },
        ".pr-safe": { paddingRight: "env(safe-area-inset-right, 0px)" },
        // A 44px hit area on touch for a control drawn smaller (G54): the box
        // keeps its drawn size and its neighbours their places; an invisible
        // pad centred on it takes the finger. Needs `position: relative`,
        // which Button and Pressable carry.
        ".hit-44": {
          "@media (pointer: coarse)": {
            "&::before": {
              content: '""',
              position: "absolute",
              left: "50%",
              top: "50%",
              width: "max(100%, 2.75rem)",
              height: "max(100%, 2.75rem)",
              translate: "-50% -50%",
            },
          },
        },
      });
    }),
  ],
};

export default config;
