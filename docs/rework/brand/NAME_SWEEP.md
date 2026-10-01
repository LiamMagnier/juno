# Alevr name sweep: web app

2026-10-02, lane `rf/web-alevr-names`. The NAMES_AND_ICONS map (with D-038 revised) applied to every user-facing web surface, and the record of every place that still says Juno or crew on purpose.

## How names work now

`src/lib/brand/names.ts` is the one registry: `PRODUCT_NAME` (Alevr), `BRAND` (Alevr Chat, Alevr Orbit with the descriptor "Your agents", Alevr Code; navigation Chat, Orbit, Code), `AGENT_NOUN`, `FEATURE_NAMES` (New chat, Search, Projects, Library, Customize, Apps, Skills, Routines, Memory, Instructions, Deep Field for deep research with "Deep research", Needs you, Create agent, Made by Alevr) and `AGENT_STATE_NAMES` (Ready, Thinking, Working, Needs your answer, Blocked, Finished). Renaming the product or a feature is one edit there.

Translation still works by matching rendered text against the build-time catalog. `scripts/generate-i18n-catalog.mjs` now evaluates the registry and resolves `${PRODUCT_NAME}` and `${FEATURE_NAMES.x.label}` inside template literals, so a sentence built from a name is catalogued whole. The translator is told to keep Alevr, Alevr Chat, Alevr Orbit, Alevr Code and Orbit untranslated.

## What changed

- **Product name.** 836 user-facing strings in 314 files (string literals, template literals, JSX text and attributes) moved from "Juno" to `PRODUCT_NAME` by a syntax-tree codemod that keeps each sentence one template literal. This covers metadata (title template, application name, Apple web-app title, OpenGraph, Twitter, JSON-LD), the manifest, onboarding, settings, notifications and web push, emails and their From display name, download and install pages, error pages, the command palette, keyboard help, tooltips, aria labels, empty states, approvals, memory, skills, Code, Work, Library and the public landing and engineering pages.
- **The assistant's self-name.** The chat system prompt, pre-answer triage, Deep research scoping, agent prompts ("one of Liam's agents in Alevr"), the voice relay ("You are Alevr") and the Code runner ("You are Alevr Code") introduce the assistant as Alevr.
- **Orbit.** The sidebar section is Orbit with Create agent; the agents page is titled Orbit and its lede opens with "Your agents". Crew member and teammate became agent (or the agent's name) in errors, mentions, context receipts, prompts, the handoff tool's descriptions and refusals, and the approval card. Suggested agent names no longer include Juno (Vega instead).
- **States.** Ready, Thinking, Working, Needs your answer, Blocked, Finished come from the registry (`AGENT_STATE_LABEL`, the face studio, the agent panel). The idle state was already Ready; "Free" no longer appears anywhere.
- **Apps, Routines, Deep Field, Made by Alevr.** The + menu's Connectors row and the Settings section are Apps; the scheduled-work pages, palette and API messages say routine; deep research is Deep Field with its descriptor ("Deep Field report", "Start research"); the Library's made-things view, filter and mention group say Made by Alevr. Routes stay `/automations`, `/connections`, `/research`, `/artifacts`.
- **Contracts.** `contracts/product/juno-shell-v1.json` labels (Orbit, Apps, Routines, Made by Alevr, Deep Field) with the Swift projection regenerated; the Work contract's Alevr phrases; the Mac tests that assert those labels.
- **Legal pages, product display name only.** Touched: `src/app/(legal)/legal/cgu/page.tsx`, `src/app/(legal)/legal/confidentialite/page.tsx`, `src/app/(legal)/legal/mentions-legales/page.tsx`. Entity placeholders, the domain chat.liams.dev and every e-mail address are unchanged.

## Sweep

`rg -i "juno|crew" src public`, classified with a syntax-tree pass (comment, string, code, CSS, path). Before the lane: 5,252 matches. After: 4,462, every one of them below.

| Class | Matches | Verdict |
|---|---:|---|
| `src/app/dev/**` | 1,455 | Keep. Dev galleries 404 in production (`NODE_ENV === "production"` → `notFound()`); `/dev/design/juno` is the V3 reference, never edited. |
| `src/lib/i18n-catalog.generated.ts` | 517 | Keep. Generated and gitignored; regenerated from source (`npm run i18n:extract`), so gallery copy is all that remains in it. |
| Code comments | 1,259 in 502 files | Keep. Internal prose and history. |
| Identifiers | 383 | Keep (stable code names), listed below. |
| CSS | 142 | Keep. Class names, custom properties, keyframes and comments. |
| File and directory names | 15 | Keep. |
| String literals | 679 | Keep, every one a stable identifier, listed below. |
| Imports and data | 12 | Keep. Module paths and the 3D kit's file names. |

### Intentional keeps: strings

None of these is read by a person as the product's name.

- **Storage keys, events and channels.** `juno:*` localStorage keys and window events (`juno:new-chat`, `juno:search`, `juno:settings`, `juno:composer-seed`, `juno:agent-updated`, `juno:ui-translations:<locale>:v1`, `juno:sidebar:*`, `juno:code:*`, `juno:onboarded:v1` and the rest), `juno.*` storage namespaces (`juno.memory.sort`, `juno.voice.persona`), the BroadcastChannel and service-worker message names (`juno:notifications-changed`), sandbox postMessage types (`juno:sandbox-ready`, `juno:artifact`, `juno:forget`, `juno:design-ops`) and the push tag `juno`.
- **HTTP headers.** `X-Juno-Request-Id`, `X-Juno-Contract-Version`, `X-Juno-Export-Notes`, `X-Juno-Export-Validator`, `X-Juno-Artifact-Version`, `X-Juno-Content-Sha256`, `X-Juno-Validated`, `X-Juno-Validation-Warning`, `X-Juno-Cdp-Token`, `x-juno-file-name`.
- **User-Agent strings** sent to GitHub, connectors, MCP and search providers: `Juno`, `Juno-MCP-Client/1.0`, `Juno-Skill-Import`, `JunoResearch/2.0`, `JunoSearch/1.0`, `JunoAssistant/1.0`. Third parties identify and allowlist the client by them. MCP `clientInfo.name` `juno` likewise. (The OAuth client name a server shows on its consent screen is user-facing and now says Alevr.)
- **Ids and enum values.** Connector and tool ids (`juno_work`, `juno_agents`, `juno_runtime`, `juno_work:hand_off_to_teammate`, `juno_agents:*`), the handoff tool's `teammate` argument, capability ids (`juno_code_local`, `juno_code_remote`, `juno_work_agent`), the export format id `juno` and the import detector's `juno`, message role `juno`, design author `juno`, glow tone `juno`, icon keys (`juno-agents`, `crew`), mention and context-token kind `crew`, schema and digest ids (`juno.export.v2`, `juno.action-approval.*.v1`, `juno.work.*.v1`, `juno-setup-change-v1`, `juno-computer-view-v1`, `juno-native-access-v1`), the untrusted-content fence `JUNO_UNTRUSTED_BEGIN/END`, the code sandbox's `__JUNO_DATA_*__` markers and `_juno_*` helpers, CSS class and data-attribute strings (`data-juno-node`, `.prose-juno`, `--juno-sidebar-width`).
- **Bundle, product and scheme ids.** APNs topics `com.liammagnier.JunoMobile`, `com.liammagnier.JunoDesktop`; App Store product ids `com.liammagnier.juno.*`; the `juno://` and `com.liammagnier.juno://` auth callbacks; the iCal `PRODID:-//Juno//Connector//EN`.
- **Routes and API paths.** `/crew` (renders Orbit), `/agents`, `/api/assistants/[id]/move-to-crew`; repository paths `LiamMagnier/juno`, `LiamMagnier/juno-windows`; file names `juno-export.json`, `.juno.design.json`, `.juno-handoff.json`, `JUNO.md`; container and host paths for agent computers (`/var/lib/juno-computers`, `/tmp/.juno-*`, `juno-computer-docker-broker`).
- **Developer-facing text.** The Work contract drift error in `src/lib/work/contract.ts` names `contracts/work/juno-work-v1.json`. The icon catalogue's motion notes and group names in `src/components/ui/juno-icons/drawings.ts` ("Crew and time", "What Juno remembers…") are shown only by the dev icon gallery.
- **Environment variables and test values.** `JUNO_*` names, `juno.invalid` and `juno.test` placeholders, `JUNO_E2E_SMOKE_OK`.

### Intentional keeps: identifiers, files and assets

- **Identifiers.** Component, type and function names such as `JunoMark`, `JunoLogo`, `JunoGlyph*`, `JunoVoiceGlow`, `AskJunoBar`, `JunoAssistantConfig`, `CrewFace`, `CrewState`, `CREW_*`, `moveToCrew`, `resolveCrew`, `__junoSoftRoutePath` and the globals the sandbox and design host define (98 distinct names). Renaming them changes no word anybody reads.
- **Files and directories.** `src/components/ui/juno-icons/`, `juno-glyphs.tsx`, `juno-call-glyphs.tsx`, `juno-glyph-paths.ts`, `src/components/design/ask-juno-bar.tsx`, `src/app/(app)/crew/`, `src/app/api/assistants/[id]/move-to-crew/`, `public/crew/` (the shipped agent kit: manifest, `crew-*.glb`, `crew-kit.usdc`, textures), `contracts/**/juno-*.json`.
- **Raster assets.** `public/juno-mark.png` (the old mark, still drawn by `JunoMark` in the rail and auth screens), `public/og.png` (social card with the old wordmark baked in), `src/app/icon.png`, `src/app/apple-icon.png`, `src/app/favicon.ico`. The Continuum exports replace them in the brand-assets lane; until then the alt text and metadata already say Alevr.

## Left for other lanes

- **Sidebar Continuum mark and Alevr wordmark.** The shell port lane wires `src/components/brand/` into the sidebar header; until then the expanded header sets the name from `PRODUCT_NAME` and the rail draws the old mark.
- **"Artifact" in running copy.** About 170 sentences still say artifact. D-038 names a made thing by its real type (deck, document, site), which is a per-sentence copy pass, not a rename; the collection labels already say Made by Alevr.
- **Packages outside `src/`.** `runner/agent-core` (tool messages such as "Juno will not fetch that", compaction markers) and native Swift copy. Only their self-introductions changed here.
