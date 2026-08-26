import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import animate from "tailwindcss-animate";

/*
 * Juno design tokens (Slice 0 — Foundation)
 * -----------------------------------------
 * Type scale ............ text-{display,page-title,title,heading,body-lg,body,ui,label,caption,micro}
 *                         (+ legacy `hero`) · serif = human moments · sans = UI body · mono = labels/metadata
 * Motion ................ ease-{out-soft,out-strong,out-expo,in,in-out,breathe,out-back} ·
 *                         duration-{press,fast,exit,base,slow,emphasis}
 *                         (mirrored as --ease-* / --dur-* in globals.css, where the
 *                          reasoning behind each value lives — read it before adding a fifth)
 * Overlays .............. animate-{pop-in,pop-out} (floating layers) · animate-{overlay-in,overlay-out}
 *                         (backdrops) — pair with Radix data-[state=open/closed]
 * Touch ................. p{t,b,l,r}-safe (env safe-area insets) · .pressable (press feedback, globals.css)
 * Elevation ............. shadow-{soft,lift,glass,float} — theme-aware via --shadow-* CSS vars,
 *                         and monotonic in that order: an in-flow element must never
 *                         out-elevate a floating one
 *                         (names avoid the `card`/`accent`/… color keys to dodge collisions)
 * Radius ................ compact product scale: controls 9 · fields 10 · menus 12 · cards 14 ·
 *                         surfaces 16 · floating panels 18. Pills remain explicit rounded-full.
 * Dot atoms ............. h-dot / w-dot / gap-dot-gap — the dot/ASCII signature unit
 * Thinking .............. animate-thinking-matrix (3×3 mark) · animate-status-glow ·
 *                         animate-icon-breathe + .scroll-fade-y (globals.css)
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
          accent: "hsl(var(--sidebar-accent) / <alpha-value>)",
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
        // The generic large step follows the product surface radius.
        lg: "var(--radius)",
        md: "8px",
        sm: "4px",
        // Floating layers stay distinct without becoming oversized capsules.
        panel: "18px",
        // Semantic steps, named after what they wrap. These replace the arbitrary
        // rounded-[Npx] values 1:1, so the compiled CSS is identical — the point is
        // that there is now somewhere to look up the right answer. Eleven different
        // overlay radii existed before this.
        //
        // The ladder is a 2px step from `micro` to `surface`, then 22/24/28. It is
        // continuous ON PURPOSE: every gap in it was previously being filled by a
        // hand-written `rounded-[Npx]`, and a scale you cannot land on is a scale
        // people step off. 26 distinct arbitrary radii existed across 256 call
        // sites before this; `eslint-local/no-arbitrary-radius` now keeps it shut.
        micro: "2px", // heatmap cells, crop handles — anything under ~12px square
        xs: "6px", // chips, dots, tiny badges
        control: "9px", // sm buttons, menu items, list rows
        // 10px. Named for inputs because that is where it started, but it is the
        // general small-container rung: wells, segmented thumbs, icon tiles,
        // inline notes, the dashed box a short empty state sits in. 99 sites were
        // reaching Tailwind's undefined `rounded-xl` for exactly this, so the
        // scope is being written down to match the use rather than the use bent
        // to match a narrower name.
        field: "10px",
        menu: "12px", // dropdown / select / tabs shells
        card: "14px", // cards, toasts, tiles
        popover: "14px", // popovers, transcripts
        surface: "16px", // in-flow panels and section wells
        // The composer is distinct through placement and material, not an
        // oversized novelty radius. This stays one step above ordinary surfaces
        // while sharing their geometry closely enough to feel like one product.
        composer: "18px",
        // The two composer-seated control radii. The primary action sits at
        // `composer-action` at its 36px rest size and morphs to
        // `composer-control` as it widens to 44px while busy — the corner
        // curvature has to fall as the box grows or the button visibly inflates.
        // Both are nested inside the composer shell and neither is on the main
        // ladder, which is exactly why they need names: they are derived, not
        // chosen. They move WITH the shell — nesting reads as concentric only
        // while the inner radius stays a consistent fraction of the outer one,
        // so a shell that got 10px rounder hands its children a share of it.
        "composer-control": "10px",
        "composer-action": "12px",
        // Provider/product marks. A PERCENTAGE, not px, so one value is one shape
        // at every size — 24% is the iOS app-icon superellipse ratio these marks
        // are imitating. Owned by <ProviderLogo>; call sites must not override it.
        // Three different values (24/28/32%) were in use on the same component.
        logo: "24%",
        // For overlays that must trace whatever they are laid over (drag scrims,
        // focus rings on an unknown parent). A keyword, not a magic number.
        inherit: "inherit",
      },
      boxShadow: {
        // Theme-aware elevation (values live in globals.css so light/dark differ).
        soft: "var(--shadow-soft)",
        // The rung between soft and glass. It has existed in both theme blocks
        // since the ladder was made monotonic, but was never mapped here — so
        // `shadow-lift` compiled to nothing and hover states on in-flow cards
        // went on reaching for `shadow-float`, which put a hovered tile above
        // every dropdown in the product. A scale you cannot type is not a scale.
        lift: "var(--shadow-lift)",
        float: "var(--shadow-float)",
        glass: "var(--shadow-glass)",
        // Depth kit: crisp shadow for buttons/chips, colored halo for the primary,
        // inset well for recessed fields.
        pop: "var(--shadow-pop)",
        "glow-primary": "var(--glow-primary)",
        well: "var(--well-inset)",
      },
      // The out-of-flow stacking order. globals.css has declared these since the
      // depth kit landed — "so a new one has somewhere to look up its answer
      // instead of picking a number" — but they were never mapped into Tailwind,
      // so the answer was unreachable from a className and every call site went
      // on picking a number anyway: 15 hardcoded `z-50`s, plus `z-[60]`, `z-[70]`
      // and a `z-[100]` that outranks everything in the product including the
      // modal scrim. A scale you cannot type is not a scale.
      zIndex: {
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
        // interface glyph (the palette's search mark, the composer's send
        // arrow, an onboarding tile's icon). With no rung to land on, call sites
        // had split into two workarounds: seven wrote `h-[18px] w-[18px]`, and
        // three wrote `size-4.5` — which Tailwind does not define, so it emitted
        // NO css at all and those icons silently rendered at Lucide's intrinsic
        // 24px. Naming the rung is what makes both spellings converge on one
        // real value, and it gives the optical stroke ladder in globals.css a
        // class to key 18px on.
        "4.5": "1.125rem",
      },
      transitionTimingFunction: {
        "out-soft": "cubic-bezier(0.33, 1, 0.68, 1)",
        "out-strong": "cubic-bezier(0.32, 0.72, 0, 1)",
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
        // The product had NO accelerate curve, so every exit ran an entrance
        // curve — which is why dismissals felt like the UI was reluctant to let
        // go. `in-out` is for A-to-B moves where both endpoints are visible
        // (chevron rotate, accordion, sidebar width); running those on an
        // ease-out makes them look like they arrive from off-screen.
        in: "cubic-bezier(0.4, 0, 1, 1)",
        "in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
        // The only symmetric curve here, and the only one meant for a LOOP:
        // loops have a seam that an ease-out visibly pulses at. Already inlined
        // verbatim in the pulse-ring / status-glow / gen-sweep keyframes below;
        // see the reasoning beside --ease-breathe in globals.css.
        breathe: "cubic-bezier(0.45, 0, 0.55, 1)",
        // The one overshooting curve — for elements with apparent mass that
        // should settle rather than stop. See --ease-out-back in globals.css.
        "out-back": "cubic-bezier(0.34, 1.32, 0.64, 1)",
      },
      transitionDuration: {
        press: "70ms",
        fast: "120ms",
        exit: "160ms",
        base: "220ms",
        slow: "360ms",
        // One rung above slow, reserved for a change the user did not cause —
        // see the reasoning beside --dur-emphasis in globals.css.
        emphasis: "560ms",
      },
      fontFamily: {
        // A single product voice. `serif` remains as a compatibility alias for
        // existing semantic call sites, but resolves to the same interface face
        // so web and native no longer switch personalities between controls and
        // headings. Mono is reserved for code, ids and compact telemetry.
        sans: [
          "var(--font-sans)",
          "Archivo",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        serif: [
          "var(--font-sans)",
          "Archivo",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      fontSize: {
        // Legacy hero (empty-state) — kept.
        //
        // The rem intercept in these two clamps is NOT stylistic. A pure-vw
        // preferred value ignores the user's base font size, so browser text zoom
        // has no effect at all on the largest type in the product (WCAG 1.4.4).
        // Anchored 360px → 1280px; min and max are unchanged, so rendered sizes
        // match the old values to within a rounding error at every viewport.
        //   hero    38.4px → 64px : m = 2.7826vw, b = 28.38px = 1.7739rem
        //   display 32px   → 48px : m = 1.7391vw, b = 25.74px = 1.6087rem
        hero: [
          "clamp(2.4rem, 1.7739rem + 2.7826vw, 4rem)",
          { lineHeight: "1.1", letterSpacing: "-0.02em" },
        ],
        // Type scale. Contrast comes from family (serif/sans/mono) + 3x size jumps, not timid weights.
        display: [
          "clamp(2rem, 1.6087rem + 1.7391vw, 3rem)",
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
        "page-title": [
          "clamp(1.65rem, 1.4rem + 0.8vw, 2.1rem)",
          { lineHeight: "1.15", letterSpacing: "-0.02em", fontWeight: "600" },
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
        body: ["0.9375rem", { lineHeight: "1.6" }],
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
        // Eyebrow/metadata — sizing only; pair with `font-mono` + `uppercase`.
        // 0.10em is the editorial maximum for caps: above ~0.12em uppercase
        // micro-labels stop grouping into words and read as decoration. It is also
        // the most likely SC 1.4.12 failure in the tree, since tracking stacks with
        // a user-forced 0.12em on fixed-height chips. AsciiWordmark keeps its own
        // 0.12em — that is a logotype, not a label.
        label: [
          "0.75rem",
          { lineHeight: "1.4", letterSpacing: "0.10em", fontWeight: "500" },
        ],
        caption: ["0.6875rem", { lineHeight: "1.45", letterSpacing: "0.02em" }],
        /*
         * The mono metadata floor — token counts, model ids, timestamps, the
         * smallest eyebrow chips. Pair with `font-mono` (and often
         * `uppercase`), like `label` two rungs up. 10.5px, deliberately ABOVE
         * the 10px (139 sites) and 9px (20 sites) it replaces: below ~10.5px
         * the mono face's hairline strokes start losing whole pixels to
         * antialiasing on 1x displays, and most of these sites are
         * muted-foreground on top of that — the floor is where the smallest
         * voice in the product stays legible rather than decorative. (The half
         * pixel rounds per-DPR at 1x and renders true at 2x.) Tracking stays
         * at caption's 0.02em, far under label's 0.10em: mono's fixed advance
         * already separates glyphs, and at this size added air reads as gaps
         * between letters, not as an eyebrow.
         */
        micro: ["0.65625rem", { lineHeight: "1.45", letterSpacing: "0.02em" }],
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
        primary: {
          DEFAULT: "hsl(var(--primary-ink) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
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
        // A dark point travels through a still 3×3 matrix. Adjacent staggered
        // peaks overlap just enough to leave a soft trail.
        "thinking-matrix": {
          "0%, 100%": {
            opacity: "0",
            boxShadow: "0 0 0 hsl(var(--foreground) / 0)",
          },
          "8%": {
            opacity: "0.28",
            boxShadow: "0 0 2px hsl(var(--foreground) / 0.05)",
          },
          "15%": {
            opacity: "0.95",
            boxShadow: "0 0 5px hsl(var(--foreground) / 0.12)",
          },
          "30%": {
            opacity: "0",
            boxShadow: "0 0 0 hsl(var(--foreground) / 0)",
          },
        },
        // The reduced-motion substitute for the matrix above, and it did not
        // exist. `thinking-dots.tsx` has always applied
        // `motion-reduce:animate-thinking-pulse` to the centre dot and its
        // docstring describes exactly this — "the centre point falls back to an
        // opacity-only pulse … no translate, no scale" — but no such keyframe was
        // ever written, so Tailwind emitted no class and a reduced-motion reader
        // got a completely static dot grid while the model was still thinking.
        // That is the one thing the signature exists to prevent, and it failed
        // silently for precisely the users who cannot fall back to the animation.
        //
        // Opacity only, on the loop curve: an eased loop pulses at the seam
        // where it turns around, which is the whole reason --ease-breathe exists.
        "thinking-pulse": {
          "0%, 100%": { opacity: "0.3" },
          "50%": { opacity: "1" },
        },
        // The sentence remains neutral and only breathes slightly toward the
        // foreground, matching the monochrome reference instead of using coral.
        "status-glow": {
          "0%, 100%": {
            color: "hsl(var(--muted-foreground) / 0.8)",
            textShadow: "0 0 0 hsl(var(--foreground) / 0)",
          },
          "50%": {
            color: "hsl(var(--foreground) / 0.78)",
            textShadow: "0 0 8px hsl(var(--foreground) / 0.1)",
          },
        },
        "icon-breathe": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.85" },
          "50%": { transform: "scale(1.1)", opacity: "1" },
        },
        "rise-in": {
          from: {
            opacity: "0",
            transform: "translateY(calc(8px * var(--motion-shift, 1)))",
          },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Learning blocks (step-lab-block.tsx + quiz-block.tsx). One parametrized
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
        "pop-in": {
          from: {
            opacity: "0",
            transform:
              "translateY(calc(var(--pop-shift, 4px) * var(--motion-shift, 1))) scale(var(--motion-scale-from, 0.96))",
          },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
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
        // Indeterminate hairline: a 1/3-width bar; translateX(300%) of its own
        // width crosses the full track, so the sweep exits cleanly on the right.
        "gen-sweep": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(300%)" },
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
          "45%": { transform: "translateY(-50%) scale(1.18)" },
          "100%": { transform: "translateY(-50%) scale(1)" },
        },
      },
      animation: {
        // A-to-B moves with both endpoints visible run in-out, not ease-out; and
        // the collapse is faster than the expand, like every other exit here.
        // These two previously used the raw `ease-out` keyword — off-token entirely.
        "accordion-down": "accordion-down var(--dur-base) var(--ease-in-out)",
        "accordion-up": "accordion-up var(--dur-exit) var(--ease-in-out)",
        // `fade-in` is the keyframe `page-in` and `overlay-in` both build on, so
        // it is the most-run animation in the product — and it was the last pair
        // still on the raw `ease-out` keyword and off-ladder 200/250ms, the exact
        // fault the accordion pair above was fixed for.
        "fade-in": "fade-in var(--dur-base) var(--ease-out-soft)",
        "fade-in-up": "fade-in-up var(--dur-base) var(--ease-out-soft)",
        "pulse-ring": "pulse-ring 1.6s var(--ease-breathe) infinite",
        // One-shot variant (quiz correct-answer flourish) — the arbitrary
        // [animation-iteration-count:1] override does NOT work on animate-*
        // utilities (the shorthand re-declares iteration-count later in the
        // stylesheet at equal specificity), so a named one-shot is required.
        "pulse-ring-once": "pulse-ring 1.6s var(--ease-breathe) 1 both",
        // linear: the band exits one edge and teleports to the other, so there is
        // no turn to ease — an eased sweep decelerates into the seam and jumps.
        shimmer: "shimmer 1.5s linear infinite",
        blink: "blink 1.1s steps(1) infinite",
        "rise-in": "rise-in var(--dur-slow) var(--ease-out-strong)",
        // Learning blocks: direction-aware step navigation (strong), one-shot
        // wrong-answer nudge (soft), one-shot SVG path draw (expo).
        "stage-in": "stage-in var(--dur-base) var(--ease-out-strong) both",
        nudge: "nudge var(--dur-base) var(--ease-out-soft)",
        "stroke-draw": "stroke-draw var(--dur-slow) var(--ease-out-expo) both",
        // A loop turns around at both ends, so it takes the symmetric curve —
        // `ease-in-out` the keyword is NOT --ease-in-out the token, and neither
        // is the loop curve. See --ease-breathe.
        "dot-wave": "dot-wave 1.2s var(--ease-breathe) infinite",
        // Thinking signature (ThinkingDots) + live reasoning header (ActivityTimeline).
        "thinking-matrix": "thinking-matrix 1.8s var(--ease-breathe) infinite",
        // Same period as the matrix it stands in for, so the two read as one
        // signature running at two fidelities rather than as two indicators.
        "thinking-pulse": "thinking-pulse 1.8s var(--ease-breathe) infinite",
        "status-glow": "status-glow 2.8s var(--ease-breathe) infinite",
        "icon-breathe": "icon-breathe 2.6s var(--ease-breathe) infinite",
        "title-in": "title-in var(--dur-base) var(--ease-out-soft)",
        "title-out": "title-out var(--dur-exit) var(--ease-in)",
        // Floating layers: data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out
        // (pair with .origin-popper on Radix popper content so scale anchors to the trigger).
        // Enter on ease-out-soft — out-expo front-loaded so hard here that the
        // pop read as an instant snap; exit reverses faster, as leaving should.
        // 180ms is the one deliberate half-rung in this block: a popper travels
        // 4px, so --dur-base overshoots it and --dur-fast clips the scale. Its
        // exit is the fast rung, as every exit here is.
        "pop-in": "pop-in 180ms var(--ease-out-soft) both",
        "pop-out": "pop-out var(--dur-fast) var(--ease-in) both",
        // Dialogs travel further than a popper, so they get the next rung up.
        // Replaces the tailwindcss-animate utility chain on DialogContent.
        "modal-in": "pop-in var(--dur-base) var(--ease-out-soft) both",
        "modal-out": "pop-out var(--dur-exit) var(--ease-in) both",
        // Route changes (page-transition.tsx). Reuses the opacity-only `fade-in`
        // keyframe on purpose — a transform here would create a containing block
        // and break the `fixed` model-selector / canvas panel.
        // 280ms on out-expo front-loaded so hard that an opacity-only fade appeared
        // instantly and then hung; base on out-soft reads as one move.
        "page-in": "fade-in var(--dur-base) var(--ease-out-soft) both",
        // Dialog/sheet backdrops. The scrim LEADS on open (the dim establishes
        // context before the panel arrives) and TRAILS on close (it must outlast
        // the panel it dims). Previously the scrim cleared in 150ms while
        // SheetContent took 220ms to leave, so the drawer finished sliding over an
        // already-undimmed page.
        "overlay-in": "fade-in var(--dur-fast) var(--ease-out-soft) both",
        "overlay-out": "fade-out var(--dur-base) var(--ease-in) both",
        // Reasoning slider's top tier (reasoning-slider.tsx).
        // 24s, not 6s: the gradient should read as a slow luminous drift, not a
        // sweep. `linear` is deliberate — an eased loop visibly pulses at the
        // seam, which is the thing that looked like flashing.
        "ultra-pan": "ultra-pan 24s linear infinite",
        // Per-particle durations (7-13s) are set inline; this is only the fallback.
        "ultra-spark": "ultra-spark 9s var(--ease-breathe) infinite",
        "ultra-pop": "ultra-pop 420ms var(--ease-out-strong)",
        // Media-generation placeholder (generation-placeholder.tsx).
        "gen-drift-a": "gen-drift-a 16s var(--ease-breathe) infinite",
        "gen-drift-b": "gen-drift-b 22s var(--ease-breathe) infinite",
        "gen-grid-pulse": "gen-grid-pulse 5.2s var(--ease-breathe) infinite",
        "gen-sweep": "gen-sweep 1.8s var(--ease-breathe) infinite",
      },
    },
  },
  plugins: [
    animate,
    // `coarse:` → touch devices, for 44px hit areas (WCAG AA).
    plugin(({ addVariant, addUtilities }) => {
      addVariant("coarse", "@media (pointer: coarse)");
      // iOS notch/home-indicator breathing room (composer, sheets, full-bleed layouts).
      addUtilities({
        ".pt-safe": { paddingTop: "env(safe-area-inset-top, 0px)" },
        ".pb-safe": { paddingBottom: "env(safe-area-inset-bottom, 0px)" },
        ".pl-safe": { paddingLeft: "env(safe-area-inset-left, 0px)" },
        ".pr-safe": { paddingRight: "env(safe-area-inset-right, 0px)" },
      });
    }),
  ],
};

export default config;
