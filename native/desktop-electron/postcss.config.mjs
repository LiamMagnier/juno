/*
 * The renderer's PostCSS chain. Identical in shape to the web's
 * `postcss.config.mjs` — Tailwind v3 (NOT v4: there is no `@tailwindcss/postcss`
 * here, and the `tailwind.config.ts` beside this file is a v3 config), then
 * autoprefixer.
 *
 * NO `postcss-import`, deliberately. `base.css` pulls in the generated
 * `tokens.css` with a plain `@import`, which Vite's own CSS pipeline resolves
 * and inlines before this chain runs. Adding postcss-import ahead of tailwindcss
 * is also the exact change that silently drops the whole `@layer components`
 * block on the web — Tailwind's `@tailwind components` directive claims that
 * layer first, so an imported file's `@layer components { … }` has nothing to
 * merge into. See the note at the top of src/app/globals.css; it cost 62 KB of
 * emitted CSS and 235 named classes to find out.
 *
 * autoprefixer stays even though the renderer is exactly one browser, and it is
 * doing more than it looks like. It prefixes in BOTH directions: measured
 * against the default browserslist it adds `-webkit-mask-image` (which the
 * scroll-fade edges and the streaming tail depend on) and REMOVES
 * `-webkit-backdrop-filter`, which the glass chrome no longer needs. So a
 * hand-written prefix in base.css is not belt-and-braces, it is a value
 * autoprefixer will silently disagree with — the prefixes are its job, and
 * base.css writes none.
 *
 * FOLLOW-UP: pin `browserslist` to the Chromium that ships in this Electron
 * (see docs/DESIGN.md). Right now autoprefixer is targeting the generic default
 * query, which is strictly more conservative than one known engine — correct,
 * but it emits prefixes for browsers this app will never run in.
 */

const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

export default config;
