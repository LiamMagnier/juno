# ArtifactRuntime

Files the Mac serves to running artifacts over `juno-runtime://<file>`
(`ArtifactRuntimeSchemeHandler`, JunoChatKit) and registers with the transcript's
Mermaid figure (`JunoMermaidEngine.register(script:)`, `JunoDesktopApp.init`).

| File | What | Version | sha256 |
|---|---|---|---|
| `mermaid.min.js` | Mermaid, the official IIFE build (`dist/mermaid.min.js`), which sets `globalThis.mermaid` | 11.12.3 | `71dc54e481779b526de5e615c2eb00c99fa5acb75da9c5524d02e333d2fda89a` |

The web imports Mermaid 11 as an ES module from jsdelivr (`sandbox-frame.tsx`,
`MERMAID_CDN`); the Mac bundles the same major version so diagrams draw offline
and the transcript's figure never fetches anything.

**Provenance.** This copy was taken from a local, unmodified vendored copy of the
upstream `dist/mermaid.min.js` (the build a JetBrains IDE plugin ships), not
downloaded during the build. When it is next updated, replace it with the file
from the npm tarball (`npm pack mermaid@11`) and record the new hash here.
