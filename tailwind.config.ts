import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import animate from "tailwindcss-animate";

/*
 * Juno design tokens (Slice 0 — Foundation)
 * -----------------------------------------
 * Type scale ............ text-{display,title,heading,body,body-lg,label,caption} (+ legacy `hero`)
 *                         serif = human moments · sans = UI body · mono = labels/metadata
 * Motion ................ ease-{spring,out-soft,out-expo,breathe} · duration-{fast,base,slow,emphasis}
 *                         (mirrored as --ease-* / --dur-* in globals.css, where the
 *                          reasoning behind each value lives — read it before adding a fifth)
 * Overlays .............. animate-{pop-in,pop-out} (floating layers) · animate-{overlay-in,overlay-out}
 *                         (backdrops) — pair with Radix data-[state=open/closed]
 * Touch ................. p{t,b,l,r}-safe (env safe-area insets) · .pressable (press feedback, globals.css)
 * Elevation ............. shadow-{soft,float,glass} — theme-aware via --shadow-* CSS vars
 *                         (names avoid the `card`/`accent`/… color keys to dodge collisions)
 * Radius ................ NON-MONOTONIC — overriding `lg` reorders Tailwind's scale. Real sizes:
 *                           sm 4 · md 8 · xl 12* · 2xl 16* · lg 24 (=--radius) · 3xl 24* · panel 28
 *                         (* = stock Tailwind, not overridden below.) So `rounded-lg` is BIGGER than
 *                         `rounded-xl`/`rounded-2xl`, not a mid step. Want ~8px? rounded-md. ~12px?
 *                         rounded-xl. ~16px? rounded-2xl. A pill? rounded-full. Reach for rounded-lg
 *                         only when you actually mean 24px. panel = floating layers.
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
      },
      borderRadius: {
        // Legacy scale — values UNCHANGED so no existing surface moves. `lg` stays
        // 24px; renumbering it would shift 77 live surfaces.
        lg: "var(--radius)",
        md: "8px",
        sm: "4px",
        // Floating layers (composer, command palette, canvas sheet) — softer, bigger.
        panel: "28px",
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
        micro: "2px",     // heatmap cells, crop handles — anything under ~12px square
        xs: "6px",        // chips, dots, tiny badges
        control: "10px",  // sm buttons, menu items, list rows
        field: "12px",    // inputs, wells, segmented thumbs
        menu: "14px",     // dropdown / select / tabs shells
        card: "16px",     // cards, toasts, tiles
        popover: "18px",  // popovers, transcripts
        surface: "20px",  // in-flow panels and section wells
        composer: "22px", // the composer shell
        // The two composer-seated control radii. The primary action sits at
        // `composer-action` (13px) at its 36px rest size and morphs to
        // `composer-control` (11px) as it widens to 44px while busy — the corner
        // curvature has to fall as the box grows or the button visibly inflates.
        // Both are nested inside the 22px shell and neither is on the main ladder,
        // which is exactly why they need names: they are derived, not chosen.
        "composer-control": "11px",
        "composer-action": "13px",
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
        // Deprecated alias of out-strong, kept so the 39 existing `ease-spring`
        // sites keep compiling. Delete after migration.
        spring: "cubic-bezier(0.32, 0.72, 0, 1)",
        // The only symmetric curve here, and the only one meant for a LOOP:
        // loops have a seam that an ease-out visibly pulses at. Already inlined
        // verbatim in the pulse-ring / status-glow / gen-sweep keyframes below;
        // see the reasoning beside --ease-breathe in globals.css.
        breathe: "cubic-bezier(0.45, 0, 0.55, 1)",
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
        // Two-face system. `sans` is the interface voice (controls, menus, tables,
        // metadata — anything at or below ~15px). `serif` is reserved for display
        // and for continuous reading: headings, greetings, assistant prose. Mono is
        // labels, model ids, code and the dot/ASCII signature layer.
        //
        // Archivo's x-height ratio (~0.52) is within 5% of Newsreader's, so no
        // `size-adjust` is needed and every existing px size still holds.
        sans: ["var(--font-sans)", "Archivo", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        // "Source Serif 4" MUST stay quoted. Unquoted, its last component is the
        // number 4, which is not a valid CSS custom-ident — that makes the whole
        // font-family declaration invalid and the browser drops it, so every
        // `font-serif` element silently falls back to inheriting body. It went
        // unnoticed for as long as body was itself serif.
        serif: ["var(--font-serif)", "Newsreader", "'Source Serif 4'", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
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
        hero: ["clamp(2.4rem, 1.7739rem + 2.7826vw, 4rem)", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        // Type scale. Contrast comes from family (serif/sans/mono) + 3x size jumps, not timid weights.
        display: ["clamp(2rem, 1.6087rem + 1.7391vw, 3rem)", { lineHeight: "1.08", letterSpacing: "-0.02em", fontWeight: "500" }],
        title: ["1.375rem", { lineHeight: "1.25", letterSpacing: "-0.012em", fontWeight: "600" }],
        heading: ["1.125rem", { lineHeight: "1.3", letterSpacing: "-0.006em", fontWeight: "600" }],
        "body-lg": ["1.0625rem", { lineHeight: "1.6" }],
        body: ["0.9375rem", { lineHeight: "1.6" }],
        // Eyebrow/metadata — sizing only; pair with `font-mono` + `uppercase`.
        // 0.10em is the editorial maximum for caps: above ~0.12em uppercase
        // micro-labels stop grouping into words and read as decoration. It is also
        // the most likely SC 1.4.12 failure in the tree, since tracking stacks with
        // a user-forced 0.12em on fixed-height chips. AsciiWordmark keeps its own
        // 0.12em — that is a logotype, not a label.
        label: ["0.75rem", { lineHeight: "1.4", letterSpacing: "0.10em", fontWeight: "500" }],
        caption: ["0.6875rem", { lineHeight: "1.45", letterSpacing: "0.02em" }],
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
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
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
          "0%, 100%": { opacity: "0", boxShadow: "0 0 0 hsl(var(--foreground) / 0)" },
          "8%": { opacity: "0.28", boxShadow: "0 0 2px hsl(var(--foreground) / 0.05)" },
          "15%": { opacity: "0.95", boxShadow: "0 0 5px hsl(var(--foreground) / 0.12)" },
          "30%": { opacity: "0", boxShadow: "0 0 0 hsl(var(--foreground) / 0)" },
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
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Learning blocks (step-lab-block.tsx + quiz-block.tsx). One parametrized
        // keyframe covers both navigation directions: the caller sets --stage-dx
        // to 12px (forward) or -12px (back) on the keyed stage element.
        "stage-in": {
          from: { opacity: "0", transform: "translateX(var(--stage-dx, 12px))" },
          to: { opacity: "1", transform: "none" },
        },
        // Wrong-answer feedback — a one-shot 3px sideways nudge, then still.
        nudge: {
          "0%, 100%": { transform: "translateX(0)" },
          "35%": { transform: "translateX(-3px)" },
          "70%": { transform: "translateX(2px)" },
        },
        // Draws an SVG path once (next-token autoregression return arc). The
        // caller sets stroke-dasharray and --draw-len to the path length.
        "stroke-draw": {
          from: { strokeDashoffset: "var(--draw-len, 120)" },
          to: { strokeDashoffset: "0" },
        },
        "title-in": {
          "0%": { opacity: "0", transform: "translateY(4px) scale(0.985)", backgroundColor: "hsl(var(--primary) / 0.12)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)", backgroundColor: "transparent" },
        },
        "title-out": {
          "0%": { opacity: "1", transform: "translateY(0) scale(1)" },
          "100%": { opacity: "0", transform: "translateY(-4px) scale(0.985)" },
        },
        // Overlay enter/exit pair — sized for Radix data-[state=open/closed].
        // --pop-shift makes the 4px drift origin-aware: .origin-popper layers
        // flip it per data-side (globals.css) so a menu always emerges from its
        // trigger — a bottom-anchored menu rises 4px, a top-anchored one settles
        // 4px down. Non-popper users of animate-pop-in keep the 4px-rise default.
        "pop-in": {
          from: { opacity: "0", transform: "translateY(var(--pop-shift, 4px)) scale(0.96)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "pop-out": {
          from: { opacity: "1", transform: "translateY(0) scale(1)" },
          to: { opacity: "0", transform: "translateY(var(--pop-shift, 4px)) scale(0.96)" },
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
          "0%, 100%": { opacity: "0", transform: "translate3d(0, 0, 0) scale(0.6)" },
          "50%": {
            opacity: "var(--spark-peak, 0.5)",
            transform: "translate3d(var(--spark-dx, 4px), var(--spark-dy, -2px), 0) scale(1)",
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
        "fade-in": "fade-in 0.2s ease-out",
        "fade-in-up": "fade-in-up 0.25s ease-out",
        "pulse-ring": "pulse-ring 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        // One-shot variant (quiz correct-answer flourish) — the arbitrary
        // [animation-iteration-count:1] override does NOT work on animate-*
        // utilities (the shorthand re-declares iteration-count later in the
        // stylesheet at equal specificity), so a named one-shot is required.
        "pulse-ring-once": "pulse-ring 1.6s cubic-bezier(0.4, 0, 0.6, 1) 1 both",
        shimmer: "shimmer 1.5s infinite",
        blink: "blink 1.1s steps(1) infinite",
        "rise-in": "rise-in 0.32s cubic-bezier(0.32,0.72,0,1)",
        // Learning blocks: direction-aware step navigation (spring), one-shot
        // wrong-answer nudge (soft), one-shot SVG path draw (expo).
        "stage-in": "stage-in 220ms cubic-bezier(0.32, 0.72, 0, 1) both",
        nudge: "nudge 240ms cubic-bezier(0.33, 1, 0.68, 1)",
        "stroke-draw": "stroke-draw 360ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "dot-wave": "dot-wave 1.2s ease-in-out infinite",
        // Thinking signature (ThinkingDots) + live reasoning header (ActivityTimeline).
        "thinking-matrix": "thinking-matrix 1.8s ease-in-out infinite",
        "status-glow": "status-glow 2.8s cubic-bezier(0.45, 0, 0.55, 1) infinite",
        "icon-breathe": "icon-breathe 2.6s cubic-bezier(0.33, 1, 0.68, 1) infinite",
        "title-in": "title-in 240ms cubic-bezier(0.33,1,0.68,1)",
        "title-out": "title-out var(--dur-exit) var(--ease-in)",
        // Floating layers: data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out
        // (pair with .origin-popper on Radix popper content so scale anchors to the trigger).
        // Enter on ease-out-soft — out-expo front-loaded so hard here that the
        // pop read as an instant snap; exit reverses faster, as leaving should.
        "pop-in": "pop-in 180ms var(--ease-out-soft) both",
        "pop-out": "pop-out 120ms var(--ease-in) both",
        // Dialogs travel further than a popper, so they get the next rung up.
        // Replaces the tailwindcss-animate utility chain on DialogContent.
        "modal-in": "pop-in 220ms var(--ease-out-soft) both",
        "modal-out": "pop-out 160ms var(--ease-in) both",
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
        "overlay-in": "fade-in 120ms var(--ease-out-soft) both",
        "overlay-out": "fade-out 220ms var(--ease-in) both",
        // Reasoning slider's top tier (reasoning-slider.tsx).
        // 24s, not 6s: the gradient should read as a slow luminous drift, not a
        // sweep. `linear` is deliberate — an eased loop visibly pulses at the
        // seam, which is the thing that looked like flashing.
        "ultra-pan": "ultra-pan 24s linear infinite",
        // Per-particle durations (7-13s) are set inline; this is only the fallback.
        "ultra-spark": "ultra-spark 9s ease-in-out infinite",
        "ultra-pop": "ultra-pop 420ms cubic-bezier(0.32, 0.72, 0, 1)",
        // Media-generation placeholder (generation-placeholder.tsx).
        "gen-drift-a": "gen-drift-a 16s ease-in-out infinite",
        "gen-drift-b": "gen-drift-b 22s ease-in-out infinite",
        "gen-grid-pulse": "gen-grid-pulse 5.2s ease-in-out infinite",
        "gen-sweep": "gen-sweep 1.8s cubic-bezier(0.45, 0, 0.55, 1) infinite",
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
