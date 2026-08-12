import type { Config } from "tailwindcss";

/*
 * Juno Desktop — Tailwind v3.4
 * ----------------------------
 * This file holds NAMES. `src/renderer/styles/tokens.css` holds VALUES, and it
 * is generated from the web's own `src/app/globals.css` + `tailwind.config.ts`
 * by `scripts/generate-tokens.ts`. Nothing below is a number somebody chose for
 * the desktop; every entry points at a custom property the generator emitted.
 *
 * That split is the whole design. A component written against `bg-card`,
 * `rounded-menu`, `shadow-glass`, `duration-base` or `animate-pop-in` compiles
 * to the same declaration here as it does on the web, so a component can be
 * lifted across without a translation pass — and when the web moves a value,
 * `npm run tokens:check` fails here instead of the two products quietly
 * disagreeing about what "card" means.
 *
 * The semantic structure is the web's, key for key. Where an entry is
 * deliberately absent, it says so rather than being silently dropped:
 *
 *   keyframes   — supplied by tokens.css, projected from the web config. Naming
 *                 them again here would be the one place a body could drift.
 *   container   — a page-width helper for a document. The desktop is a window.
 *   coarse:     — a pointer-media variant for touch. macOS has a mouse.
 *   p{t,b,l,r}-safe — iOS notch insets. There is no notch on a desktop window.
 *   tailwindcss-animate — the web keeps it for its data-[state] helpers; the
 *                 pop-in/pop-out pair below already covers what Radix needs, and
 *                 it is not a dependency of this package.
 */

const config: Config = {
  darkMode: ["class"],
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
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
          foreground: "hsl(var(--warning-foreground) / <alpha-value>)",
        },
        source: {
          DEFAULT: "hsl(var(--source) / <alpha-value>)",
        },
        ultra: {
          DEFAULT: "hsl(var(--ultra) / <alpha-value>)",
        },
        // Syntax colour for the code and diff surfaces. Deliberately NOT
        // --success / --warning: those carry meaning (a run passed, a run is
        // degraded) and a string literal is neither, so tying code colour to a
        // state colour means a theme change to one repaints the other. The
        // desktop has more code on screen than the web does, which makes the
        // separation matter more here, not less.
        code: {
          string: "hsl(var(--code-string) / <alpha-value>)",
          number: "hsl(var(--code-number) / <alpha-value>)",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-foreground) / <alpha-value>)",
          border: "hsl(var(--sidebar-border) / <alpha-value>)",
          accent: "hsl(var(--sidebar-accent) / <alpha-value>)",
        },
        // Already carries its own alpha, so no <alpha-value> slot.
        scrim: "hsl(var(--scrim))",
      },

      /*
       * Text colour is NOT the same ramp as fill colour — `colors` drives bg-*,
       * text-* and border-* alike, and the fill tones only reach ~3:1 as small
       * light-mode text. This block is additive: bg-* and border-* resolve
       * exactly as above, only text-* moves onto the AA ink ramps.
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

      // The compact product ladder: controls 9 · fields 10 · menus 12 · cards 14
      // · surfaces 16 · floating panels 18 · composer 26. Pills stay an explicit
      // rounded-full.
      borderRadius: {
        lg: "var(--radius-lg)",
        md: "var(--radius-md)",
        sm: "var(--radius-sm)",
        panel: "var(--radius-panel)",
        micro: "var(--radius-micro)",
        xs: "var(--radius-xs)",
        control: "var(--radius-control)",
        field: "var(--radius-field)",
        menu: "var(--radius-menu)",
        card: "var(--radius-card)",
        popover: "var(--radius-popover)",
        surface: "var(--radius-surface)",
        composer: "var(--radius-composer)",
        "composer-control": "var(--radius-composer-control)",
        "composer-action": "var(--radius-composer-action)",
        logo: "var(--radius-logo)",
        // Literal, not a token. A CSS-wide keyword cannot travel through a
        // custom property — `border-radius: var(--x)` where --x holds `inherit`
        // is invalid at computed-value time, not an inherited radius. The
        // generator excludes it from tokens.css for exactly this reason.
        inherit: "inherit",
      },

      // Theme-aware and monotonic: soft < lift < glass < float. An element that
      // has not left the flow must never out-elevate one that has.
      boxShadow: {
        soft: "var(--shadow-soft)",
        lift: "var(--shadow-lift)",
        glass: "var(--shadow-glass)",
        float: "var(--shadow-float)",
        pop: "var(--shadow-pop)",
        "glow-primary": "var(--glow-primary)",
        well: "var(--well-inset)",
      },

      // The out-of-flow stacking order. popper is above modal by five, on
      // purpose: a menu opened inside a dialog has to clear the surface that
      // opened it.
      zIndex: {
        popper: "var(--z-popper)",
        modal: "var(--z-modal)",
        toolbar: "var(--z-toolbar)",
        toast: "var(--z-toast)",
      },

      spacing: {
        dot: "var(--dot-size)",
        "dot-gap": "var(--dot-gap)",
      },

      /*
       * Two faces, two jobs. `sans` is the interface voice — controls, menus,
       * tables, metadata, anything at or below ~15px. `serif` is display and
       * continuous reading. `mono` is labels, model ids, code, terminal and the
       * dot/ASCII signature layer. The --font-* variables are bound in base.css,
       * which is also where the local @font-face declarations live: Electron
       * under our CSP cannot reach Google Fonts, so the desktop ships the files.
       *
       * "Source Serif 4" MUST stay quoted. Unquoted, its last component is the
       * number 4, which is not a valid CSS custom-ident — that invalidates the
       * whole declaration and every `font-serif` element silently falls back to
       * inheriting body.
       */
      fontFamily: {
        sans: ["var(--font-sans)", "Archivo", "system-ui", "-apple-system", "sans-serif"],
        serif: ["var(--font-serif)", "Newsreader", "'Source Serif 4'", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },

      // Contrast comes from family and 3× size jumps, not from timid weights.
      // Each step carries its own leading/tracking/weight so it cannot be
      // half-adopted.
      fontSize: {
        hero: ["var(--text-hero)", { lineHeight: "var(--text-hero-leading)", letterSpacing: "var(--text-hero-tracking)" }],
        display: [
          "var(--text-display)",
          {
            lineHeight: "var(--text-display-leading)",
            letterSpacing: "var(--text-display-tracking)",
            fontWeight: "var(--text-display-weight)",
          },
        ],
        title: [
          "var(--text-title)",
          {
            lineHeight: "var(--text-title-leading)",
            letterSpacing: "var(--text-title-tracking)",
            fontWeight: "var(--text-title-weight)",
          },
        ],
        heading: [
          "var(--text-heading)",
          {
            lineHeight: "var(--text-heading-leading)",
            letterSpacing: "var(--text-heading-tracking)",
            fontWeight: "var(--text-heading-weight)",
          },
        ],
        "body-lg": ["var(--text-body-lg)", { lineHeight: "var(--text-body-lg-leading)" }],
        body: ["var(--text-body)", { lineHeight: "var(--text-body-leading)" }],
        // Eyebrow/metadata — sizing only; pair with `font-mono` + `uppercase`.
        label: [
          "var(--text-label)",
          {
            lineHeight: "var(--text-label-leading)",
            letterSpacing: "var(--text-label-tracking)",
            fontWeight: "var(--text-label-weight)",
          },
        ],
        caption: [
          "var(--text-caption)",
          { lineHeight: "var(--text-caption-leading)", letterSpacing: "var(--text-caption-tracking)" },
        ],
      },

      // The number follows how far something travels and how much of the screen
      // changes underneath it — not how important it is. press 70 · fast 120 ·
      // exit 160 · base 220 · slow 360 · emphasis 560.
      transitionDuration: {
        press: "var(--dur-press)",
        fast: "var(--dur-fast)",
        exit: "var(--dur-exit)",
        base: "var(--dur-base)",
        slow: "var(--dur-slow)",
        emphasis: "var(--dur-emphasis)",
      },

      transitionTimingFunction: {
        "out-soft": "var(--ease-out-soft)",
        "out-strong": "var(--ease-out-strong)",
        "out-expo": "var(--ease-out-expo)",
        in: "var(--ease-in)",
        "in-out": "var(--ease-in-out)",
        breathe: "var(--ease-breathe)",
        "out-back": "var(--ease-out-back)",
        // Deprecated alias of out-strong, kept because the web still carries it
        // on ~47 call sites that may be ported here. Do not add a new one.
        spring: "var(--ease-spring)",
      },

      /*
       * Every shorthand is a token, so a curve flattened under reduced motion
       * reaches the animations built on it: `--anim-rise-in` names
       * `var(--ease-out-strong)`, and substitution happens on the element, at
       * use time, against whatever that element resolves the curve to.
       *
       * The matching @keyframes are in tokens.css, not in a `keyframes` key
       * here — see the header.
       */
      animation: {
        "accordion-down": "var(--anim-accordion-down)",
        "accordion-up": "var(--anim-accordion-up)",
        "fade-in": "var(--anim-fade-in)",
        "fade-in-up": "var(--anim-fade-in-up)",
        "pulse-ring": "var(--anim-pulse-ring)",
        "pulse-ring-once": "var(--anim-pulse-ring-once)",
        shimmer: "var(--anim-shimmer)",
        blink: "var(--anim-blink)",
        "rise-in": "var(--anim-rise-in)",
        "stage-in": "var(--anim-stage-in)",
        nudge: "var(--anim-nudge)",
        "stroke-draw": "var(--anim-stroke-draw)",
        "dot-wave": "var(--anim-dot-wave)",
        "thinking-matrix": "var(--anim-thinking-matrix)",
        "status-glow": "var(--anim-status-glow)",
        "icon-breathe": "var(--anim-icon-breathe)",
        "title-in": "var(--anim-title-in)",
        "title-out": "var(--anim-title-out)",
        "pop-in": "var(--anim-pop-in)",
        "pop-out": "var(--anim-pop-out)",
        "modal-in": "var(--anim-modal-in)",
        "modal-out": "var(--anim-modal-out)",
        "page-in": "var(--anim-page-in)",
        "overlay-in": "var(--anim-overlay-in)",
        "overlay-out": "var(--anim-overlay-out)",
        "ultra-pan": "var(--anim-ultra-pan)",
        "ultra-spark": "var(--anim-ultra-spark)",
        "ultra-pop": "var(--anim-ultra-pop)",
        "gen-drift-a": "var(--anim-gen-drift-a)",
        "gen-drift-b": "var(--anim-gen-drift-b)",
        "gen-grid-pulse": "var(--anim-gen-grid-pulse)",
        "gen-sweep": "var(--anim-gen-sweep)",
      },
    },
  },
  plugins: [],
};

export default config;
