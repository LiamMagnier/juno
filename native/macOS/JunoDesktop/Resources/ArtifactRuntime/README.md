# ArtifactRuntime

Files the Mac serves to running artifacts over `juno-runtime://<file>`
(`ArtifactRuntimeSchemeHandler`, JunoChatKit) and registers with the transcript's
Mermaid figure (`JunoMermaidEngine.register(script:)`, `JunoDesktopApp.init`).
The artifact sandbox has no network (register #21): these are the only scripts
a page can load from outside itself.

| File | What | Version | sha256 | Licence |
|---|---|---|---|---|
| `mermaid.min.js` | Mermaid, the official IIFE build (`dist/mermaid.min.js`), which sets `globalThis.mermaid` | 11.12.3 | `71dc54e481779b526de5e615c2eb00c99fa5acb75da9c5524d02e333d2fda89a` | MIT (`LICENSE`) |
| `react.development.js` | React, the UMD development build, which sets `globalThis.React` | 18.3.1 | `28348fef6cb0ed8b2ceeb22deaf824428fd13875d84c73d38f77dd216fc24e7f` | MIT (`LICENSE-react`) |
| `react-dom.development.js` | ReactDOM, the UMD development build, which sets `globalThis.ReactDOM` | 18.3.1 | `f9044a5e9c39db8bb1a204dff924e526ec0a621e695bb69de1035811be8709e4` | MIT (`LICENSE-react`) |
| `babel.min.js` | `@babel/standalone`, which sets `globalThis.Babel` | 7.29.9 | `5f8ffa174aa2465f074c85b92421662168cd356eedebaedc3d16fd9d61fadb7c` | MIT (`LICENSE-babel`) |
| `tailwind.play.js` | Tailwind CSS's Play CDN build (`cdn.tailwindcss.com/3.4.17`), without plugins | 3.4.17 | `176e894661aa9cdc9a5cba6c720044cbbf7b8bd80d1c9a142a7c24b1b6c50d15` | MIT (`LICENSE-tailwind`) |

**Why these builds.** They are what the web's sandbox loads from CDNs
(`sandbox-frame.tsx`: `REACT_CDN`, `REACT_DOM_CDN`, `BABEL_CDN`,
`TAILWIND_CDN`; Mermaid 11 as an ES module from jsdelivr), so an artifact
compiles, mounts and styles the same way on the Mac as on the website, with
nothing fetched. `NativeArtifactRuntimeDocument` names them by their
`juno-runtime://` URLs, and a full HTML document that loads one of these builds
from a CDN itself is pointed at the bundled copy
(`NativeArtifactRuntimeDocument.pointingAtBundledRuntimes`).

**Provenance.** React, ReactDOM, Babel and Tailwind were downloaded on
2026-09-25 with the owner's approval — React, ReactDOM and `@babel/standalone`
by `npm pack` with the registry's integrity checked, Tailwind Play from
`https://cdn.tailwindcss.com/3.4.17` — and recorded in `SOURCES.md`, copied here
as written then. Each file was checked against its recorded sha256 before it
was copied in; nothing here is fetched during a build. Mermaid was taken from a
local, unmodified vendored copy of the upstream `dist/mermaid.min.js` (the
build a JetBrains IDE plugin ships); when it is next updated, replace it with
the file from the npm tarball (`npm pack mermaid@11`) and record the new hash
here.

**Not here.** Pyodide, the web's Python runtime, is not bundled, so a Python
artifact shows its source on the Mac.
