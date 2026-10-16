const config = {
  plugins: {
    tailwindcss: {},
    // After Tailwind, so `motion-reduce:` / `motion-safe:` utilities are
    // rewritten too: compiles every reduced-motion block into its in-app twin
    // (Settings › Motion: System / Reduced / Full). See the file's header.
    "./postcss/motion-preference.cjs": {},
    autoprefixer: {},
  },
};

export default config;
