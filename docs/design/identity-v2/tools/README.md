# Identity v2 tools

These scripts produced the measured values in `../TOKENS.md`, `../MOTION.md`, `../BRAND.md` and
`../../IDENTITY_V2.md` §19, and every render in `../shots/`. They are reference implementations for W0/W1,
not part of the build. Nothing here reads from the session scratchpad: every input is committed beside the
scripts.

| Path | What it is | Run |
|---|---|---|
| `palette.py` | The palette as OKLCH inputs (granite `cool`, the default, or `warm` stone), OKLCH → 8-bit sRGB → HSL triplets, alpha roles, WCAG 2.x contrast over every ground and state fill, APCA-W3 0.0.98G, OKLab distances (chart vs status inks; neutrals vs the recorded competitor tokens) | `python3 palette.py [cool\|warm]`; `… md` prints TOKENS.md's tables; `… css <out>` writes `../proto/tokens.css` (`tokens-warm.css` for warm); `… json palette.json`; `… distinct` |
| `palette.json` | The granite palette as written by `palette.py cool json` (source, hex, HSL per appearance) | — |
| `springs.py` | The token generator's spring model (`springPosition`, `springTwin` in `scripts/generate-design-tokens.ts`) reimplemented: settle time, overshoot (also in px on 10 and 4 px travels), time to 95 %; the run list includes every case MOTION.md quotes | `python3 springs.py` |
| `brand3.py` | Generates every file in `../brand/` from numbers (the Arch masters, wordmark cuts, lockups, favicon, app icon and its Icon Composer layers, `geometry.json`), in the granite palette | `pip install -r requirements.txt`, then `python3 brand3.py <out-dir>` |
| `vendor/brand2.py`, `vendor/outline.py` | d3's Arch geometry and the font outliner `brand3.py` imports (paths fixed to this folder) | — |
| `vendor/frames.js` | d3's frame-strip tool (WAAPI seek every 40 ms); W3 ports it to `scripts/design-audit/motion-frames.mjs` | — |
| `vendor/d3-icons/` | d3's 50 drawings at 16, 20 and 24 px (light; dark is the same geometry), the source W2 re-cuts with flat terminals (ICONS §5 "re-cut from d3") | — |
| `vendor/icons-v3-entry.tsx` | The "before" renderer for ICONS §4: the product's own V3 drawings through its own renderer | build command in the file's header |
| `fonts-src/` | The font inputs with their OFL texts (SHA-256 in `fonts.md`) | — |
| `fonts-out/` | The measured outputs that are not already in `../proto/fonts/`: Inter italic, Cyrillic, Greek and Vietnamese subsets; Geologica TTF instances for native and share images | — |
| `fonts.md` | The subsetting and instancing code and every measured size | — |
| `requirements.txt` | fontTools 4.68.0 and brotli 1.2.1, pinned | — |
| `seed/identity-seed.json` | Neutral seed content for the screenshot harness (MIGRATION §4): `example.*` subdomains, invented people, vendors and agents | — |

The prototype used for the renders is `../proto/proto.html`. Scenes (`?s=`): `margin` (`&w=1440|1280|1180`,
`&live=1` streaming, `&focus=1` the numeral's hit box), `home` (`&ny=1` with a waiting needs-you card),
`home-phone`, `agent` (`&ans=1` answered), `voice` and `voice-phone` (`&speak=0` listening), `settings`,
`projects`, `landing` (`&dl=1` with the Mac download button), `auth`, `phone-thread`, `phone-menu`
(`&kb=1` keyboard ring), `phone-drill`, `greet-measure` (`&c=<JSON list>`). Common flags: `&t=light|dark`,
`&p=cool|warm`. `brand.html?t=light|dark` is the brand check sheet; `measure.html` the reading-measure
counter. Serve the `identity-v2` folder with `python3 -m http.server <port> --bind 127.0.0.1` (fonts load
only over HTTP, not `file://`) and shoot with `node proto/shoot.js <url> <out.png> <w> <h> <dpr>`. The
prototype's faces are stand-ins (a flat tone body with two cuts) and its glyphs are sketches; the product
draws the flat rig and the v4 drawings.
