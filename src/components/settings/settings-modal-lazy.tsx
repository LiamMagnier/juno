"use client";

import nextDynamic from "next/dynamic";

/**
 * The settings modal, fetched when it opens rather than with the shell.
 *
 * It was a static import in `(app)/layout.tsx`, so every app route — /chat,
 * /code, /library, all of them — downloaded and compiled its whole dependency
 * tree before it could hydrate. That tree is not small: the modal renders
 * Markdown previews, which pulls react-markdown, lowlight with 37 highlight.js
 * grammars, and KaTeX. Roughly 180 KB gzipped of maths typesetting and syntax
 * grammars, shipped to /code — exactly the route the product switch has to
 * reach quickly, and one that never opens any of it.
 *
 * THIS FILE EXISTS BECAUSE OF ONE RULE: `next/dynamic` with `ssr: false` is not
 * allowed in a Server Component, and the layout is one. So the boundary lives
 * here, in the smallest client component that can hold it, and the layout
 * imports this instead.
 *
 * `ssr: false` is right regardless: the modal is closed on first paint by
 * definition — it opens on a `juno:settings` event — so there is no server HTML
 * to match and nothing to hydrate until someone asks for it.
 */
const SettingsModalImpl = nextDynamic(
  () => import("@/components/settings/settings-modal").then((m) => m.SettingsModal),
  { ssr: false },
);

export function SettingsModalLazy() {
  return <SettingsModalImpl />;
}
