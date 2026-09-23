# Artifacts & Design audit — paused handoff (2026-09-23)

Paused on the user's request, relayed from the "macOS app installation and upgrade" session. **Only docs were added.**
No product code was changed and nothing was committed to main. The WIP is saved on its own branch ref, `wip/artifacts-design-audit`.
That ref was made with plumbing (commit-tree on a temporary index), so no checkout was involved. The files also sit untracked in the main checkout under `docs/design/artifacts-design/`.

## The ask (from the user)
1. Run a full audit of the current Artifacts & Design implementation on the Juno website and macOS.
2. When step 1 is completely done, run a full audit of how Claude handles Artifacts & Design, and how Figma handles Figma Design. Cover features, UI/UX, motion design, and anything else that could improve Juno Design & Artifacts.
3. Merge Artifacts and Design the way Anthropic merged Claude chat, Cowork and Artifacts on 16 Sept 2026. Sources: claude.com/blog/cowork-is-now-claude and TechCrunch, 2026-09-16.

## Done
- Scouted both codebases. On the web: chat artifacts (`<juno:artifact>`), the Canvas panel, `/artifacts`, `/design` with `src/lib/design` and `src/components/design`, and Work deliverables. On macOS: `DesktopArtifact*`, `DesktopDesign*`, `JunoChatKit/*Artifact*`, and the hosted editor bundle in `Resources/DesignEditor`.
- Gathered first-hand evidence of Claude's typed-artifact platform (the Design, Design System, Docs and Slides types, runtime capabilities, the merge): `research/claude-primary-evidence.md`.
- Ran Workflow 1 (**run `wf_4e23b542-7b4`**, task `w7igalgf7`, stopped cleanly at 16:5x). **10 of 11 audit areas finished and were adversarially verified**: web-artifact-pipeline, web-artifact-surface, web-library-ia, web-design-model, web-design-editor, motion, web-work-deliverables, mac-artifacts, mac-design, mac-work-parity. The raw structured results (findings plus verifier verdicts) are in `wip/raw/audit__<area>.json` and `wip/raw/verify__<area>.json`.

## In progress (not finished)
- The `history-concepts` area was mid-run when stopped and has no result. It covers the decision timeline and the fragmentation map of every "made thing".
- The completeness critic, its follow-up readers, and the three synthesis docs (`00-AUDIT-OVERVIEW.md`, `01-AUDIT-WEB.md`, `02-AUDIT-MAC.md`) have not run.
- Steps 2 and 3 of the ask (the Claude + Figma audit, then the merge plan) have not started.

## Exact next steps
1. **Same Claude session:** `Workflow({scriptPath: "/Users/liammagnier/.claude/projects/-Users-liammagnier-Developer-project-juno/bfdee244-0283-4629-a3f4-3c603fc89908/workflows/scripts/juno-artifacts-design-audit-wf_4e23b542-7b4.js", resumeFromRunId: "wf_4e23b542-7b4", args: {scratch: "<scratchpad>/audit"}})`. The cached agents return instantly; only history-concepts, the critic, follow-ups and synthesis run.
   **A new session:** `resumeFromRunId` is same-session only. Rerun the script above with a fresh scratch dir. Better still, write a smaller workflow that loads `wip/raw/*.json` instead of rerunning the 10 finished areas, then runs history-concepts, the critic and the synthesis. Journal: `~/.claude/projects/-Users-liammagnier-Developer-project-juno/bfdee244-0283-4629-a3f4-3c603fc89908/subagents/workflows/wf_4e23b542-7b4/journal.jsonl`.
2. Move the synthesised audit docs into this folder: `00-AUDIT-OVERVIEW.md`, `01-AUDIT-WEB.md`, `02-AUDIT-MAC.md`.
3. Run Workflow 2, the Claude + Figma audit. It has fact-checked research lenses:
   - Claude: Artifacts platform; Claude Design; Docs/Slides and the 16 Sept merge.
   - Figma: Design core/UI3; prototyping & motion (keyframes, animation styles, Smart Animate, shaders); AI and the product family (Make, Sites, Slides, Draw, Buzz, Weave); file browser, IA and sharing.

   Include one "others" lens. Local primary evidence for Figma's current API lives under `~/.claude/plugins/synced/*/figma/skills/` (figma-use-motion, figma-shaders, figma-use-slides, figma-generative-plugins, figma-use/references/plugin-api-standalone.d.ts). Pipeline: research → fact-check → gap analysis against the Juno audit. Output: `03-COMPETITIVE-AUDIT.md` plus `research/*.md`.
4. Run Workflow 3, the merge design. Three independent proposals (Claude-faithful typed artifacts in the conversation; Figma-like one library of typed files; risk-first incremental), then judges, then a synthesis. Output: `04-MERGE-PLAN.md` and a prioritised `05-IMPROVEMENTS.md`. Then write `00-README.md` in the style of `docs/native/code-rework/00-README.md`.

## Findings that affect Mac artifact & design rendering (for the paused Liquid Glass Phase 2)
All of these were verified against code (confirmed, or found by the verifier). Full detail is in `wip/raw/audit__mac-*.json` and `wip/raw/verify__mac-*.json`.

**Artifact rendering (DesktopArtifactCanvas / JunoChatKit)**
- HIGH: HTML artifacts that load CDN scripts, styles, fonts or images render broken on the Mac but work on the web (`NativeArtifactPreview.swift:111`).
- HIGH: The chat dock keeps showing the previous revision when a revised artifact with the same identifier is opened (`DesktopArtifactCanvas.swift:552`).
- MEDIUM: One unknown or oversized record blanks both the Artifacts library and Design on the Mac and iPhone. The store decode is all-or-nothing (`NativeArtifactStore.swift:144/157`).
- MEDIUM: Deleting the open artifact lands the reader in a different artifact (`NativeArtifactStore.swift:365`). Unsaved library edits are discarded on switch or leave (`DesktopArtifactsScreen.swift:234`).
- LOW: DESIGN shows the raw wire value "DESIGN" in the chat card and dock (`DesktopArtifactCanvas.swift:168`). Clearing the dock source editor reverts the preview (`:865`). The regex re-runs twice per render (`:877`). Version-origin badges vanish on sync (`NativeArtifactStore.swift:265`, `src/lib/sync-entities.ts:249`).

**Design rendering (DesktopDesignScreen / hosted editor)**
- HIGH: The bundled CSS lacks the shared UI primitives' classes, so menus, tooltips and popovers have no surface and Buttons lose size and layout (`scripts/build-design-editor.mjs:172`).
- HIGH: Swift `DesignDocument` drops `cornerSmoothing`, so any Mac or iPhone save strips it (`JunoDesignKit/DesignDocument.swift:479`).
- HIGH: Lost update. Save uses the latest synced version as `baseVersion`, and the editor never takes in newer versions (`NativeArtifactStore.swift:331`).
- HIGH: Unsaved design edits are discarded on Back, on a destination switch or on quit (`DesktopDesignScreen.swift:444`). Edits made during an in-flight save are dropped (`:581`).
- MEDIUM: The shipped editor bundle is stale; Mac 1.6.0 went out without 11 editor commits, and nothing in CI or release rebuilds or checks it (`scripts/build-design-editor.mjs:190`). The freshness check in `.github/workflows/release-ios.yml:76` fails on the committed tree, which blocks the next iOS release.
- MEDIUM: Host colour tokens have drifted to indigo/zinc instead of the web's warm coral (`src/components/design/host/editor.css:21`). The hosted editor uses the "embedded" layout, so the inspector and layers rails vanish at common Mac widths (`host/main.tsx:65`).
- MEDIUM: Every Export menu item fails in the Mac and iPhone editor (`design-editor.tsx:304`). The Image tool does nothing on the Mac because there is no WKUIDelegate open panel (`DesktopDesignEditorHost.swift:199`).
- LOW: A non-fatal JS error permanently covers the editor (`host/main.tsx:126`). There is no WebContent-termination handling (`DesktopDesignEditorHost.swift:217`). "No designs yet" shows while loading or failed (`DesktopDesignScreen.swift:373`). There is no Ask Juno path on the Mac.

**Work deliverables on the Mac (relevant to Work-into-Chat)**
- HIGH: Cloud-run deliverables, plan and citations never appear from the event stream on the Mac or iPhone, because the envelope is ignored (`DesktopWorkWorkspace.swift:4961/4666`).
- HIGH: The durable deliverable index is read only once per task open (`NativeWorkModel.swift:1038`).
- HIGH: Tasks started on the Mac or iPhone are unreachable on the merged web (`NativeWorkClient.swift:361`).
- HIGH: Web chat lost the download path for non-previewable deliverables and older versions (`src/components/work/detail/work-deliverable-stage.tsx:73`).
