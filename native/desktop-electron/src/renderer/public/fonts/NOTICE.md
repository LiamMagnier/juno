# Bundled fonts

Three families, four files, all **SIL Open Font License 1.1**, which permits
bundling in an application provided the licence travels with them.

| File | Family | Axes | Upstream |
|---|---|---|---|
| `Archivo-Variable.woff2` | Archivo | `wght` 100–900 | <https://fonts.google.com/specimen/Archivo> |
| `Newsreader-Variable.woff2` | Newsreader | `wght` 200–800, `opsz` 6–72 | <https://fonts.google.com/specimen/Newsreader> |
| `Newsreader-Italic-Variable.woff2` | Newsreader Italic | `wght` 200–800, `opsz` 6–72 | as above |
| `JetBrainsMono-Variable.woff2` | JetBrains Mono | `wght` 100–800 | <https://fonts.google.com/specimen/JetBrains+Mono> |

## Why these are bundled rather than fetched

The web app loads them through `next/font/google`. The desktop app cannot: its
Content-Security-Policy is `default-src 'none'` with `font-src 'self' data:`, so
a remote font is blocked by design. Bundling is not a convenience here, it is
the only way the typography exists at all — and it also means the app renders
correctly offline and on first launch.

## The `opsz` axis is load-bearing

`base.css` sets `font-optical-sizing: auto`, which is a **silent no-op** on a
Newsreader build that lacks the `opsz` axis. Both Newsreader files here were
verified to carry it (`wght` 200–800, `opsz` 6–72) with `fontTools`. If these
files are ever re-fetched, re-verify — a static instance downloads without
error and simply looks subtly wrong forever.

## Subset

Latin only, taken from the Google Fonts CSS API's `/* latin */` block. If Juno
Desktop needs Vietnamese, Greek or Cyrillic, additional subsets must be fetched
and added as separate `@font-face` rules with matching `unicode-range`
descriptors — do not assume the latin file covers them.

## Licence text

The full SIL Open Font License 1.1 is at
<https://openfontlicense.org/open-font-license-official-text/>. Each family's
own copyright line is embedded in its `name` table and travels with the binary;
the OFL requires that notice be preserved, which it is.
