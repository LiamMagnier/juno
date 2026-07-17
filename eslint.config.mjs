import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "public/**",
      "prisma/migrations/**",
      "relay/node_modules/**",
      "relay/dist/**",
      "deploy/**",
      // Transient agent worktrees and the vendored Cloud Code runner (its own
      // build/lint story lives in CI) are not part of the app's lint surface.
      ".claude/**",
      "runner/**",
      "next-env.d.ts",
      "src/lib/i18n-catalog.generated.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // no-img-element is off globally; keep the older inline disables at the
    // deliberate <img> sites without flagging them as unused.
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      // `_`-prefixed bindings and omittable catch params are the repo's
      // deliberate "intentionally unused" convention.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      // User avatars/attachments come from arbitrary hosts at runtime, where
      // next/image optimization doesn't apply.
      "@next/next/no-img-element": "off",
    },
  },
];

export default config;
