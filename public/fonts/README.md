# Public-page font fallbacks

- `newsreader-regular.ttf` is the repository's bundled Newsreader 24pt Regular,
  copied from `native/iOS/JunoMobile/Resources/Fonts/Newsreader24pt-Regular.ttf`.
- `inter-latin.woff2` is the same Latin Inter font Next/font fetched for the root
  layout, copied from its development output (Google Fonts, Inter).

These self-hosted files keep the root-error page and capable email clients in
Alevr's type system when the application layout is unavailable. Email clients
without webfont support use Georgia and the system sans-serif stack. The
wordmark itself is the committed vector drawing, so it never depends on fonts.
Both typefaces are licensed under the SIL Open Font License. Their license
texts are in `OFL-Newsreader.txt` and `OFL-Inter.txt` beside these files.
