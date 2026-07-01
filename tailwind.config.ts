import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

/*
 * Juno design tokens (Slice 0 — Foundation)
 * -----------------------------------------
 * Type scale ............ text-{display,title,heading,body,body-lg,label,caption} (+ legacy `hero`)
 *                         serif = human moments · sans = UI body · mono = labels/metadata
 * Motion ................ ease-{spring,out-soft,out-expo} · duration-{fast,base,slow}
 *                         (mirrored as --ease-* / --dur-* in globals.css)
 * Elevation ............. shadow-{soft,float,glass} — theme-aware via --shadow-* CSS vars
 *                         (names avoid the `card`/`accent`/… color keys to dodge collisions)
 * Radius ................ rounded-{sm,md,lg(=--radius=1rem),panel} (panel = floating layers)
 * Dot atoms ............. h-dot / w-dot / gap-dot-gap — the dot/ASCII signature unit
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
        },
        warning: {
          DEFAULT: "hsl(var(--warning) / <alpha-value>)",
        },
        source: {
          DEFAULT: "hsl(var(--source) / <alpha-value>)",
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
        "rise-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "title-in": {
          "0%": { opacity: "0", transform: "translateY(4px) scale(0.985)", backgroundColor: "hsl(var(--primary) / 0.12)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)", backgroundColor: "transparent" },
        },
        "title-out": {
          "0%": { opacity: "1", transform: "translateY(0) scale(1)" },
          "100%": { opacity: "0", transform: "translateY(-4px) scale(0.985)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.2s ease-out",
        "fade-in-up": "fade-in-up 0.25s ease-out",
        "pulse-ring": "pulse-ring 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        shimmer: "shimmer 1.5s infinite",
        blink: "blink 1.1s steps(1) infinite",
        drift: "drift 18s ease-in-out infinite",
        "rise-in": "rise-in 0.32s cubic-bezier(0.32,0.72,0,1)",
        "dot-wave": "dot-wave 1.2s ease-in-out infinite",
        "title-in": "title-in 240ms cubic-bezier(0.33,1,0.68,1)",
        "title-out": "title-out 180ms cubic-bezier(0.33,1,0.68,1)",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    // `coarse:` → touch devices, for 44px hit areas (WCAG AA).
    plugin(({ addVariant }) => {
      addVariant("coarse", "@media (pointer: coarse)");
    }),
  ],
};

export default config;
