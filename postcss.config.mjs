const config = {
  plugins: {
    tailwindcss: {},
    // After Tailwind, so `motion-reduce:` / `motion-safe:` utilities are
    // rewritten too: compiles every reduced-motion block into its in-app twin
    // (Settings › Motion: System / Reduced / Full). See the file's header.
    "./postcss/motion-preference.cjs": {},
    // Last, so it also sees the in-app motion twins above: rewrites Tailwind's
    // space-* and divide-* sibling selectors, which made Chrome restyle the
    // whole transcript on every row insert. See the file.
    "./scripts/postcss/sibling-invalidation.cjs": {},
    autoprefixer: {},
  },
};

export default config;
