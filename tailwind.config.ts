import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import animate from "tailwindcss-animate";

/*
 * Juno design tokens (Slice 0 — Foundation)
 * -----------------------------------------
 * Type scale ............ text-{display,title,heading,body,body-lg,label,caption} (+ legacy `hero`)
 *                         serif = human moments · sans = UI body · mono = labels/metadata
 * Motion ................ ease-{spring,out-soft,out-expo} · duration-{fast,base,slow}
 *                         (mirrored as --ease-* / --dur-* in globals.css)
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
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "8px",
        sm: "4px",
        // Floating layers (composer, command palette, canvas sheet) — softer, bigger.
        panel: "28px",
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
      spacing: {
        // Dot/ASCII signature unit.
        dot: "var(--dot-size)",
        "dot-gap": "var(--dot-gap)",
      },
      transitionTimingFunction: {
        spring: "cubic-bezier(0.32, 0.72, 0, 1)",
        "out-soft": "cubic-bezier(0.33, 1, 0.68, 1)",
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      transitionDuration: {
        fast: "120ms",
        base: "220ms",
        slow: "360ms",
      },
      fontFamily: {
        // Overall UI typeface is the editorial serif (Newsreader). `font-sans`
        // and the body both resolve to it; mono stays for labels/code.
        sans: ["var(--font-serif)", "Newsreader", "Georgia", "serif"],
        serif: ["var(--font-serif)", "Newsreader", "Source Serif 4", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        // Legacy hero (empty-state) — kept.
        hero: ["clamp(2.4rem, 5vw, 4rem)", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        // Type scale. Contrast comes from family (serif/sans/mono) + 3x size jumps, not timid weights.
        display: ["clamp(2rem, 4vw, 3rem)", { lineHeight: "1.08", letterSpacing: "-0.02em", fontWeight: "500" }],
        title: ["1.375rem", { lineHeight: "1.25", letterSpacing: "-0.012em", fontWeight: "600" }],
        heading: ["1.125rem", { lineHeight: "1.3", letterSpacing: "-0.006em", fontWeight: "600" }],
        "body-lg": ["1.0625rem", { lineHeight: "1.6" }],
        body: ["0.9375rem", { lineHeight: "1.6" }],
        // Eyebrow/metadata — sizing only; pair with `font-mono` + `uppercase`.
        label: ["0.75rem", { lineHeight: "1.4", letterSpacing: "0.14em", fontWeight: "500" }],
        caption: ["0.6875rem", { lineHeight: "1.45", letterSpacing: "0.02em" }],
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
        drift: {
          "0%, 100%": { transform: "translate(0,0) rotate(0deg)" },
          "50%": { transform: "translate(-12px,8px) rotate(-1.5deg)" },
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
        // The dot trailing a streaming reply. `animate-pulse` (2s, opacity only)
        // read as an idle placeholder next to text arriving several times a
        // second; this beats at roughly a typing cadence and scales as well as
        // fades, so it reads as a live caret.
        "stream-dot": {
          "0%, 100%": { opacity: "0.35", transform: "scale(0.8)" },
          "50%": { opacity: "1", transform: "scale(1)" },
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
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
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
        drift: "drift 18s ease-in-out infinite",
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
        "title-out": "title-out 180ms cubic-bezier(0.33,1,0.68,1)",
        // Floating layers: data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out
        // (pair with .origin-popper on Radix popper content so scale anchors to the trigger).
        // Enter on ease-out-soft — out-expo front-loaded so hard here that the
        // pop read as an instant snap; exit reverses faster, as leaving should.
        "pop-in": "pop-in 180ms cubic-bezier(0.33, 1, 0.68, 1) both",
        "pop-out": "pop-out 120ms cubic-bezier(0.33, 1, 0.68, 1) both",
        // Route changes (page-transition.tsx). Reuses the opacity-only `fade-in`
        // keyframe on purpose — a transform here would create a containing block
        // and break the `fixed` model-selector / canvas panel.
        "page-in": "fade-in 280ms cubic-bezier(0.16, 1, 0.3, 1) both",
        // Dialog/sheet backdrops.
        "overlay-in": "fade-in 220ms cubic-bezier(0.33, 1, 0.68, 1) both",
        "overlay-out": "fade-out 150ms cubic-bezier(0.33, 1, 0.68, 1) both",
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
        "stream-dot": "stream-dot 1.15s cubic-bezier(0.45, 0, 0.55, 1) infinite",
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
