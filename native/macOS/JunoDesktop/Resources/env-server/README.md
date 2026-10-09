# Bundled env server

`alevr-env.mjs` here is Alevr Code's local environment server
(`runner/env-server`), bundled into one file and copied into the app at
`Contents/Resources/env-server/`. The Mac app's `EnvServerSidecar` runs it with
the user's `node`. Build it with:

    npm run env-server:bundle:mac

The bundle is not checked in. Without it, a debug build falls back to the
repo's `runner/env-server` (`dist/alevr-env.mjs`, `dist/bin.js`, or
`src/bin.ts` through tsx), or to `ALEVR_ENV_SERVER_ENTRY`.
