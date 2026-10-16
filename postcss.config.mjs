const config = {
  plugins: {
    tailwindcss: {},
    // After Tailwind: rewrites its space-* and divide-* sibling selectors, which
    // made Chrome restyle the whole transcript on every row insert. See the file.
    "./scripts/postcss/sibling-invalidation.cjs": {},
    autoprefixer: {},
  },
};

export default config;
