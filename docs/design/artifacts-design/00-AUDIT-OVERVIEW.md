# Artifacts and Design: cross-cutting audit overview

Repository: `project/juno`, branch `main`, HEAD `d0997af2`, 2026-09-23. This synthesis draws on 16 area audits: 9 on web, 3 on Mac, 1 on history and concepts, and 5 follow-ups covering lifecycle, scale, public links and model quality. Every file:line below is repo-relative and taken from those findings unless marked **self-checked**, which means I re-read or re-ran it during this synthesis.

---

## 0. How to read this

**Verification status**

| Status | Meaning |
|---|---|
| **confirmed** | An independent verifier re-read the code, and often ran it (browser, Node probe, measurement), and agreed. |
| **found-by-verifier** | A verifier found the problem while checking another finding. |
| **unverified** | One auditor reported it from reading or a scratch probe. Nobody re-checked it. |
| **uncertain** | Depends on runtime or browser behaviour this audit could not observe, or the findings disagree. |
| **inferred** | A conclusion or recommendation drawn from what was read. It is not an observation. |

**What I checked myself in this pass (self-checked)**

1. HEAD is still `d0997af2`. The only change in the working tree is the untracked `docs/design/artifacts-design/` folder, which holds a paused earlier audit run and its HANDOFF. No other session has half-edited the audited files on main.
2. `src/components/canvas/canvas-panel.tsx:1236-1256` still pushes `{ version, content: "", origin: "edit" }` inside a wrapper keyed by `selectedVersion`, so the top design defect is still present.
3. `src/middleware.ts:55-57` still claims the srcdoc iframe is "unaffected by any of this", and `src/lib/csp.ts:31` still sends `script-src 'self' 'nonce-…' 'strict-dynamic' …`. The preview defect is still present.
4. `node scripts/build-design-editor.mjs --check` prints `bundle is stale (expected 1.0.0+9cc1cfa8d4fe)` and exits 1. The last commit touching `native/macOS/JunoDesktop/Resources/DesignEditor` is `2fa09d35` (2026-09-17). The `--check` branch only reads files (`scripts/build-design-editor.mjs:190-205`).
5. **Contradiction resolved: is iPhone design editing read-only?** The brief and the mac-work-parity table say yes. The mac-design, history and lifecycle findings say no. The code says editable in the library: `native/iOS/JunoMobile/App/JunoMobileWorkspaceViews.swift:2062-2068` passes `readOnly: !isLatestVersion` and `onEdit: isLatestVersion ? { designDraft = $0 } : nil`. So the iPhone Artifacts library edits the latest version and saves it through the generic route. The inline chat viewer uses the default `readOnly: true` (`JunoMobileDesignArtifact.swift:408`).

**Other contradictions the findings themselves settled**

- *Recovery polling cost.* web-artifact-pipeline asked whether the recovery poll is expensive. The scale finding shows the hour-long 12 s poll was removed in `03780dc0` (2026-08-17). Every caller now uses a 6 s window (`src/hooks/use-chat.ts:869-873,1032,1132`). The comment at `src/lib/queries.ts:108-110` is out of date.
- *Native regenerate.* On main, native Try again is a no-op on a settled answer (`NativeConversationStore.swift:1747-1751,1928-1930`). The `mac/liquid-glass-chat` branch extends it to settled answers, which also widens exposure to defect X-04.
- *PDF deliverables* are not a generated kind (`src/lib/work/deliverables/index.ts:107-113`). The kinds that cannot be reached are .docx and .pptx.
- *`DESIGN_TOOLS`* (`src/lib/design/ai.ts:256-270`) is dead code. It advertises nothing to the model.
- *Design generation refusals* are visible, not silent: the saved message says "Artifact unavailable: verification failed…" (`src/app/api/chat/route.ts:441-444`). The reason is never shown (see §7).
- *When the native store fails,* the Design screen shows "No designs yet" (`DesktopDesignScreen.swift:373-378`), not "Artifacts unavailable".

---

## 1. Executive summary

1. **The data model is already the right shape for the merge. The product around it is fragmented.** DESIGN is a typed `Artifact` row that shares versions, share links, the library and sync with the six code and document types (`prisma/schema.prisma:1344-1356`). Anthropic's "typed artifacts at one link" is therefore mostly a product and UI unification, not a data migration. Around that model, though, Juno runs about ten separate systems for things it makes (§4). One design object has four editors with two save semantics. Four sidebar and panel surfaces each list part of the made things, and none lists all of them.

2. **Web artifact previews that need scripts are dead in production (critical, confirmed).** Since `fb3a42b5` (2026-08-26) the app sends an enforcing nonce plus `strict-dynamic` CSP. Browsers pass that policy into the `srcdoc` sandbox. React, scripted or Tailwind HTML, Mermaid (inline blocks included), the JS/Python console and public share previews are blank or static. Two auditors independently reproduced this in Chromium with the production header. It is the largest single user-facing defect.

3. **Design inside the conversation, the core of the merge, is broken on both platforms.** On web, the first saved edit to any AI-generated design in the chat Canvas remounts the editor on an empty version body ("This design can't be opened"). Seven audits traced this independently. On Mac, the chat dock cannot open *any* chat-generated design, because the message carries the compact authoring form and the native codec rejects it.

4. **Artifact lifetime is tied to chat messages, so ordinary chat gestures destroy user work.**
   - Editing an earlier message, or regenerating, hard-deletes artifacts together with their hand edits, design checkpoints and public share links. There is no warning.
   - A plain follow-up revision rebuilds from the model's own old text. That silently reverts manual edits. For designs it also deletes components, variables, effects, motion and comments.
   - A revision that is stopped or cut off becomes the current version and is labelled "verified".
   - Deleting a conversation cascades to designs that were started by hand.

5. **Size and decoding limits break both platforms at once.** A chat-authored design is size-checked in compact form and then expanded 5 to 11 times with no second check. A design of about 40 KB compact is stored above 200k characters. Every web edit to it is then refused, and the whole Mac and iPhone Artifacts library fails to load. That happens because the native store fails closed on one oversized record. It fails closed the same way on one unknown type, which blocks adding Docs, Slides or Design System types to builds already installed.

6. **Mac engineering is careful but has drifted from the web.**
   - What is good: the sandbox, the bridge validator, the offline store and version diffing.
   - The chat dock uses only the tag body and never the stored row, so it has no versions, save, share, export or design editing.
   - HTML that relies on a CDN renders broken.
   - There is no share link for artifacts.
   - The bundled design editor shipped in 1.6.0 is stale (self-checked). Its CSS is missing the shared primitives, so menus and tooltips probably have no surface. The inspector is hidden at the default window width.
   - Mac design saves lose data three ways: lost updates, `cornerSmoothing` stripped from every node, and drafts dropped without a prompt.

7. **Work deliverables are a second, unmerged system for things Juno makes.**
   - Storage is binary files in object storage, validated, with an unused provenance field. The source spec is thrown away.
   - Since the Work→Chat merge, web users cannot download .docx or .pptx files that a chat task produced.
   - Tasks started on Mac or iPhone cannot be reached from the web.
   - The iPhone's "Made" list is always empty for cloud runs.
   - Deleting an account leaves the deliverable files in the bucket.

8. **Public links, quotas and telemetry have no governance.**
   - A ban does not take a user's shares down.
   - There is no admin takedown, no moderation of artifact bodies, no report link, and the legal contact is a placeholder.
   - Nothing limits the rate or volume of artifact writes. Every read loads every version: an hour of design editing makes the thread about 9 to 27 MB, and one scripted account can force a backend restart.
   - `src/lib/observability.ts` is imported by nothing.

9. **Worth keeping:**
   - the validated, invertible design operation layer;
   - the exact-anchor patch protocol;
   - stale-write guards;
   - Office exports that are re-opened and checked;
   - sound reasoning about origin isolation for the sandbox;
   - one editor bundle shared by web, Mac and iPhone;
   - disciplined sync plumbing;
   - a mature motion token system (§8).

10. **Verdict (inferred).** The merge is feasible, and the table layer makes it cheaper than it looks. It needs about a dozen preconditions first:
    - previews from a separate origin, shipped together with share governance;
    - first-class, stable, soft-deletable artifacts decoupled from messages;
    - one versioning semantic;
    - one write path per type;
    - the model reading the current version;
    - native decoding that tolerates unknown kinds;
    - design thumbnails on every surface;
    - a decision on WorkArtifact.

---

## 2. Areas and sources

| Key | Area | Headline |
|---|---|---|
| web-artifact-pipeline | Generation, persistence, API, versions, sharing, security | CSP kills previews; model overwrites edits; regenerate deletes; truncation kept |
| web-artifact-surface | Canvas panel, inline cards, previews | Built for code artifacts; DESIGN broken or second-class at every step |
| web-library-ia | /artifacts, /design, navigation, IA | Four places to find things, four data models; project page shows 0 artifacts |
| web-design-model | Scene model, operations, layout, render, export, AI | Strong engine; canvas and export disagree; export 500 on non-Latin names |
| web-design-editor | Editor UI and UX | Full inspector; review mode leaks writes; Escape commits; no phone or touch |
| motion | Motion in documents and in the product | Rigorous maths; preview and export differ; no prototype player; Mac surfaces static |
| web-work-deliverables | Work deliverables after the merge | Good engine; UI unmounted; .docx/.pptx unreachable |
| mac-artifacts | Mac chat dock, Artifacts screen, previews | Three surfaces unaware of each other; stale revision in dock |
| mac-design | Mac Design screen, bundle, bridge | Stale and unstyled bundle; lost-update saves; cornerSmoothing stripped |
| mac-work-parity | Mac Work deliverables, sync, contracts, parity | Envelope bugs; native tasks invisible on web; fail-closed store |
| history-concepts | Decision history and the made-thing map | About ten made-thing systems; key decisions never written down |
| followup-artifact-lifecycle-data-loss | Destructive gestures versus user work | Edit and regenerate hard-delete; ghosts in client state |
| followup-artifact-scale-performance-telemetry | Payloads, bundles, sync, observability | Every read ships every version; no telemetry |
| followup-public-link-governance | Abuse, moderation, quotas, permissions | No takedown, no moderation, no quotas |
| followup-model-generation-quality | Model-side limits | Full re-emit from stale history; no evaluation of real outputs |

Tests the auditors ran, all passing: artifact helpers 17/17 plus 51/51 in nearby files; design libraries 277/277 in 14 files; editor helpers 92/92; motion 48 plus export and canvas 62; deliverables 60; history and URL migration 33/33. **Every test covers pure helpers. None covers persistence, API routes, sharing, regenerate, the Canvas and design commit path, the sandbox under the enforcing CSP, or the Swift mirror against the generated contract.** Nearly every high-severity defect sits in one of those untested seams.

---

## 3. Decision timeline and documented intent

### 3.1 Timeline (read from git log and commit messages)

| Date | Commit | Event | Consequence today |
|---|---|---|---|
| 07-01 | `7ff31854` | Artifact, ArtifactVersion and Canvas in the first production commit | Artifacts are owned by conversations from day one |
| 07-04 | `6c6e91dc` | Code streams live inside artifacts | — |
| 07-11 | `f5bf223a`, `d5c4211c` | Public snapshot share links for chats and artifacts | Snapshot selected by timestamp (§12.7) |
| 07-17 | `947a7611` | Card rebuilt with a streaming sweep. The gallery's accents and sheen were removed later (`e47df155`, 09-08) | — |
| 07-18 | `cbc94c80`, `716feabc` | Canvas redesign with editable code and version `origin`. Targeted Canvas edits | Stale-write guard and patch protocol, both strengths |
| 07-22 / 07-26 | `719db31c`, `d66546a0` | Native artifact library, offline history, JunoDesktop Artifacts screen | — |
| **08-05** | `7c344b96` | **Juno Design**: DESIGN type, transaction model, one renderer, Mac WKWebView host, Swift `JunoDesignKit` mirror | Hand-written second schema (drift in §7 X-14) |
| **08-05** | `469c6c61` | **Juno Work domain, including `WorkArtifact`, on the same day.** No rationale is recorded anywhere for not reusing Artifact | The two made-thing tables in §4 |
| 08-05 | `3b9f06b0`, `9a842314` | The model learns to emit DESIGN. "New design" and `POST /api/design` | Compact grammar; empty holder chats |
| 08-06 | `bd886d59` → `31d50ab9` | Design is a mode, then a destination, within one day | Placement kept moving |
| 08-06 | `ea6ed46d`, `a184ad9d`, `e849ef6a`, `78bef990` | /design/[id] window and Ask Juno; checkpoint folding in place; image-asset guard; Mac door into Design | A second editor. Folding breaks append-only. The guard breaks compact `image` nodes (X-10) |
| 08-06 | `390ade91` | **Last change ever made to the Swift DesignDocument mirror** | — |
| 08-07 | `6e5e86b5` | iOS design editing (library) | The iPhone is not read-only (§0) |
| 08-15 | REWORK_PLAN; `c69ee98e` | "Artifacts folds into Library as a filter". Open question Q6: "Does design survive?". The same day, the web adds `cornerSmoothing` without bumping `schemaVersion` | The fold was never done. Q6 was never answered. The Mac strips the field (X-14) |
| 08-17 | `03780dc0` | Dropped-stream recovery is bounded | The scale concern is smaller than first reported |
| 08-21 | `e252e4b5` | 200k character cap on artifacts | Checked before DESIGN expansion (X-08) |
| **08-26** | `fb3a42b5` | **CSP switched from Report-Only to enforcing** | Script previews dead (X-01) |
| 09-03 | `a9648246`, `db7022f5` | Sidebar with Library / Projects / Artifacts / Design. No Mac artifact file changes after this date | Mac drift starts here |
| 09-09 / 09-12 / 09-13 | `d39d652a`, `22059f90`, `9d562a9a` | Artifacts grid with source previews; the model decides when to use Canvas (web toggle removed); Design becomes a nav row | The Mac still ships a Canvas toggle |
| 09-16 | — | Anthropic folds Cowork and Artifacts into one Claude interface (external) | The owner's target |
| 09-17 | `2853c43f`, `ff3963ec`, TWO_PRODUCTS.md, `2fa09d35` | Work stops being a place and /work retires. Library, Artifacts and Design stay as three siblings. **Last editor bundle build** | Deliverable UI unmounted (X-25); bundle stale (X-19) |
| 09-20 | `971ba294` | /artifacts had been broken for every account owning an artifact (int8 `left()`) | — |
| 09-21 | `a0e41c9b`, `fd449001`, `b3f580c6` | Sandbox meta CSP loosened ("verified" on standalone documents only); Design glyph becomes Shapes; Canvas lazy-loaded | A meta policy can only tighten, so X-01 remains |
| 09-22 / 09-23 | `5b2187c8`, `19941547`, `0a3087fe` | Design glyph becomes JunoDesign; DocumentViewer takes the Canvas column; **Mac 1.6.0 ships with the 09-17 bundle** | Stale bundle reaches users |

### 3.2 Stated decisions and principles compared with the code

| # | Stated intent (source) | Code today | Verdict |
|---|---|---|---|
| 1 | DESIGN reuses Artifact "so history, restore, sharing and the library work unchanged" (`schema.prisma:1350-1354`; `src/lib/design/store.ts:3-12`) | Share shows JSON; library tiles show JSON; restore exists only in the Canvas | Partial |
| 2 | "An edit is a validated transaction against a named revision, not a blob replacement" (`store.ts:9-11`; `transactions/route.ts:17-22`) | The generic `POST /api/artifacts/[id]` accepts any string for DESIGN, and Mac, iPhone and Canvas restore use it (`src/app/api/artifacts/[id]/route.ts:7-16`) | Violated |
| 3 | "The generated JSON Schema is the referee" (`DesignDocument.swift:12-16`) | No Swift code reads it. The web added a field with no version bump | Not enforced |
| 4 | One editor on every platform (`7c344b96`) | True by construction, but the Mac and iPhone bundle is stale | Holds in design, fails in delivery |
| 5 | "/design is a way in, not a second editor" (`src/app/(app)/design/page.tsx:11-13`) | /artifacts, search, Outputs and inline cards open designs in the embedded Canvas editor (`artifacts/page.tsx:529,596`; `src/lib/search/engine.ts:434`) | Violated |
| 6 | ArtifactVersion is append-only (`docs/JUNO.md:2522`; `share.ts:11-13`) | Design checkpoints rewrite rows in place for 30 s (`store.ts:179-203`; `operations.ts:511,529-539`) | Violated |
| 7 | "A regenerate must never lose what the user already had" (`chat/route.ts:2563-2565`); "an edit never destroys history" (`messages/[id]/route.ts:9-14`) | Both hard-delete artifacts (X-03, X-04) | Violated |
| 8 | The model decides on Canvas (`route.ts:2104-2111`) | The Mac still ships a toggle that does nothing (per the Liquid Glass plan doc) | Partial |
| 9 | The iframe, not the CSP, is the security boundary (PREMIUM_AUDIT §2e) | Correct as a security model, but the app CSP leaks into the iframe and blocks it. JUNO.md:507-508 and 2579-2581 list the sandbox flags wrongly | Holds in principle, broken in effect |
| 10 | "Artifacts is shared with Chat: one library of generated things" (`app-sidebar.tsx:1070-1073`) | Generated media, deliverables and research reports are missing from it | Partial |
| 11 | "Artifacts folds into Library as a filter" (REWORK_PLAN.md:153-154) | TWO_PRODUCTS §3 kept three siblings, and no reversal is recorded | Undecided |
| 12 | "Work is not a place"; deliverables live in the run panel (TWO_PRODUCTS.md:30-36) | Only the newest task, only previewable kinds, only after it finishes | Partial |
| 13 | "One concept, one drawing" (ICONS_AND_MOTION §1.1) | Four copies of the type→glyph map and three label vocabularies (§5) | Violated |
| 14 | "A control appears only when its backing operation exists" (MACOS_PRODUCT_SPEC.md:40-42) | The Mac dock has "Edit source" but can never save; the Mac Export menu has no working path | Violated |
| 15 | Private mode never persists artifacts (`route.ts:2107-2108`) | Holds | Holds |

### 3.3 Decisions that were never recorded

- Why `WorkArtifact` was built beside `Artifact` (`469c6c61`). No document explains it.
- REWORK_PLAN Q6, "Does design survive?" (REWORK_PLAN.md:321-322), and the Library fold (REWORK_PLAN.md:293), are both still marked open.
- `docs/design/OPEN_DECISIONS.md` has no entry for artifacts or design.
- **Juno Design has no section in `docs/JUNO.md`**: no routes, APIs, grammar, or notes on WKWebView host security. The only prose record is in commit messages and code comments.
- GAP-023 (native Canvas composer contract, `API_GAPS.md:388-397`) is still open.

---

## 4. The fragmentation map

### 4.1 Ten made-thing concepts

1. **Chat artifact** (HTML, REACT, CODE, MARKDOWN, SVG, MERMAID): `Artifact` and `ArtifactVersion` rows holding text.
2. **DESIGN artifact**: the same tables with a DesignDocument JSON body. It has a separate write path, folds versions in place, and has four editors.
3. **Work deliverable**: `WorkArtifact` and `WorkArtifactVersion`, holding bytes in object storage with a SHA-256, a validator verdict and a soft delete.
4. **Generated media**: an `Attachment` with `origin: "generated"` (`src/app/api/generate/route.ts:263-272`).
5. **Uploaded files, project sources and knowledge documents**: `Attachment` and `AttachmentVersion`, soft delete, and `KnowledgeDocument`.
6. **Research report**: stored three times, in `ResearchRun.report`, `ResearchReportRevision` (`schema.prisma:3616-3634`), and a MARKDOWN artifact that always uses the identifier `research-report`.
7. **Inline visual and learning blocks, and inline Mermaid**: inside the encrypted `Message.content`.
8. **Share snapshot**: `Share` of kind CHAT or ARTIFACT (`schema.prisma:1803-1834`).
9. **Code outputs**: PRs, diffs, previews and simulator captures, all outside the artifact system.
10. **Ephemeral sandbox outputs**: Pyodide blob downloads and server-side Python temp files.

### 4.2 Web: concept × lifecycle

| Concept | Created | Stored | Listed | Opened | Edited | Versioned | Shared | Exported | Synced |
|---|---|---|---|---|---|---|---|---|---|
| Chat artifact | Model's `<juno:artifact>` tag (`system-prompt.ts:251-258`) → `persistArtifacts` (`artifacts-store.ts:38-95`). No manual create | Text in plain form, owned by the conversation, cascade delete (`schema.prisma:1125-1164`) | /artifacts (200 cap, `api/artifacts/route.ts:27`); Outputs popover (`session-outputs.tsx:97-106`); search (`search/sql.ts:329-353`); project page broken (X-21) | Canvas via card or `?artifact=`; /share | Canvas Code tab (generic POST); Ask/Modify patch (`artifact-edit.ts`); model re-emits the whole artifact | Append-only; origin generated/edit/restore; Canvas diff and restore | Snapshot link (`share.ts`); script previews dead (X-01) | Source download; MARKDOWN to docx/xlsx/pptx, checked before serving (`export/route.ts:100-163`) | `artifact`, `artifact_version` (`sync-entities.ts:222-260`); `origin` dropped |
| DESIGN | Model's compact JSON (`authoring.ts`); `POST /api/design` presets, which create an empty holder chat (`api/design/route.ts:69-90`); "New design" on /artifacts (phone preset) | Same tables; full JSON; folded in place within 30 s (`store.ts:122-127,179-203`) | /design (client-side filter of the 200, `design/page.tsx:75-79`); /artifacts "Designs" (JSON tile); Outputs (JSON); search (JSON keys) | **Two editors, depending on the door**: /design/[id] window, or the embedded Canvas editor (`canvas-panel.tsx:1236-1255`) | Validated transactions; Ask Juno preview-then-accept (outside the transcript); chat re-emit rebuilds the document (X-06); generic POST bypasses validation | Checkpoints plus an in-memory undo tab; browsing versions only in the Canvas | Raw JSON (`shared-artifact-viewer.tsx:32`); no Share in the /design window | 9 formats (`export/route.ts:25`), 500 on non-Latin names (X-23); handoff bundle has no consumer | As an artifact; every fold re-sends the full body |
| Work deliverable | Runner's `create_deliverable` (`tools.ts:989-1051`; `work-runner.ts:1985-2078`); `POST /api/work/artifacts` has no caller | Object-storage bytes plus hash plus validation; **spec thrown away**; provenance never written (`schema.prisma:2608-2665`) | Only in the **newest** task's finished panel, only site/report/spreadsheet (`work-deliverable-stage.tsx:33-39`). Not in /artifacts, Outputs, search or Library | Inline stage (report via chat Markdown; spreadsheet via `/preview`; site in a sandbox) | None | Append-only per (session, identifier); cannot span turns | None (`ShareKind` is CHAT or ARTIFACT) | Download of the staged file only; `WorkDocuments` is unmounted (`work-documents.tsx:111`) | `work_*` synced but never read |
| Generated media | `/api/generate` | Attachment, origin "generated" (the schema comment omits this origin) | /library; Outputs | File viewer | Image edit overlay | AttachmentVersion | Only inside a chat share | Download | `attachment` |
| Files and knowledge | Upload | Attachment, soft delete and trash | /library (server search, sort, paging, bulk actions, trash); project Sources | DocumentViewer, which takes over the Canvas column; /knowledge/documents | Replace | AttachmentVersion | Inside a chat share | Download | `attachment` |
| Research report | Research writer, with a fixed identifier | Three copies | Canvas card and ReportDialog; not listed as research | ReportDialog or Canvas | Re-run; audit adds a version | Revisions and artifact versions | "Copy link (sign-in required)" (`report-reader.tsx:233-241`) | .md, print, Office through the artifact | No research entity |
| Inline visual blocks | Model fences | Inside `Message.content` | None | Inline | Regenerate | `MessageVersion` | Inside a chat share | None | `message` |
| Code outputs | Juno Code | CodeTask, PR URL | /code/pulls | Code panes | Code | Git | GitHub | Git | Code entities |
| Sandbox outputs | Pyodide or server Python | Not stored | None | Blob download | — | — | — | Blob | — |

### 4.3 Mac (iPhone noted where it differs)

| Concept | Created | Stored | Listed | Opened | Edited | Versioned | Shared | Exported | Rendered |
|---|---|---|---|---|---|---|---|---|---|
| Chat artifact | Server (model only) | Encrypted local store; decoding **fails closed** (`NativeArtifactStore.swift:101-167`) | Artifacts screen grid (no list view, no keyboard navigation); search covers titles only (`NativeSearchStore.swift:193-203`) | **Chat dock built from the tag body only** (`DesktopArtifactCanvas.swift:33-54`); library document; detached window (read-only snapshot) | Library: latest version in a TextEditor, then `saveArtifact` with a 409 guard. Dock: "Edit source" is never saved | Library history, diff, restore; dock has none; `origin` is nil from sync | **No artifact link** (`NativeShareClient.swift:61-80` is CHAT only); the dock ShareLink sends source text | Save Source As; Office export in the library | HTML sandbox blocks every network URL (X-13); React has no runtime; Mermaid shows source only |
| DESIGN | Design screen presets (`DesktopDesignScreen.swift:100-118`); model | Same store | Design screen "Recent" (no loading or failure state); Artifacts library | Design screen; library (editable); detached window (read-only); **chat dock read-only, and it fails on chat-made designs (X-11)** | Bundled web editor (stale X-19, unstyled X-17, inspector hidden X-18), explicit Save through the generic POST (X-15, X-14, X-16) | Library only; not on the Design screen | None | Editor Export menu is broken (`connect-src 'none'`, file:// origin) | WKWebView host |
| iPhone DESIGN | Chat only (no create) | Same | Artifacts section | Library editable on the latest version (self-checked); inline read-only | Same generic POST; draft cleared on any remote version bump | Version menu and restore | None | None | Same bundle |
| Work deliverable | Cloud runner only; Mac-hosted runs cannot create one (`WorkCapabilityManifest.swift:76-95,155`) | Server | Work › task › Files & cost › "Made" (`DesktopWorkWorkspace.swift:3043-3121`); the durable list is read once (X-28); event rows drop cloud events (X-27) | No preview or Quick Look | None | Per-version history, provenance, verdict | None | NSSavePanel for any version (the only platform that can) | — |
| iPhone deliverable | — | — | Event rows only, always empty for cloud runs | — | — | — | — | **No download** | — |

### 4.4 One DESIGN object, four editors, two save semantics

| Editor | Host | Save path | Semantics | Ask Juno | State of the editor |
|---|---|---|---|---|---|
| /design/[id] window | Web `DesignWorkspace`, surface `window` | `/api/design/[id]/transactions` | Validated operations; folding; autosave | Yes | Best of the four |
| Chat Canvas | Web `CanvasPanel`, surface `embedded` | Same transactions | Same | No | **Breaks on the first new checkpoint (X-02)**; rails keyed to the viewport |
| Mac Design screen and library | WKWebView, surface `embedded` | Generic `POST /api/artifacts/[id]` on ⌘S | Whole document replaced; base version taken from sync (X-15) | No | Stale bundle, missing CSS |
| iPhone library | WKWebView | Same generic POST | Same; draft cleared on remote version bump | No | Same bundle |

### 4.5 User intents served more than once

| Intent | Paths today |
|---|---|
| "Show me what Juno made" | /artifacts, /design, /library, the per-chat Outputs popover, the Work finished stage, the project page (broken), search. Mac: Artifacts, Design, Library, Work › Made |
| "Make a document" | MARKDOWN artifact with Office export; Work `document` (.docx spec); Work `report`; research report |
| "Make slides" | Work `presentation` (.pptx spec); Markdown to pptx (`office-export.ts`) |
| "Make a spreadsheet" | Work `spreadsheet`; Markdown to xlsx; Pyodide with openpyxl |
| "Make a website" | HTML/REACT artifact (scripts run, when the CSP allows); Work `site` (zip; preview blocks the bundle's scripts, `work-site-preview.tsx:594-598`); Design HTML prototype export; Juno Code |
| "Make a diagram" | MERMAID artifact; inline ```mermaid; `juno-visual` block; SVG artifact |
| "Make an image" | Generated image (Attachment); SVG artifact; Design PNG export; Work `image` kind (no producer) |
| "Edit with AI" | Chat full re-emit; Canvas Ask/Modify patch; Design Ask Juno bar. Each keeps its own history, none shared |
| "Edit by hand" | Canvas Code tab; Canvas design editor; /design window; Mac Design screen; Mac Artifacts; iOS library |
| "See history" | ArtifactVersion; design folding plus undo tab; WorkArtifactVersion; AttachmentVersion; MessageVersion; ResearchReportRevision |
| "Share" | Share ARTIFACT (JSON for designs); research "copy link"; nothing for deliverables; native is CHAT only |
| Office generation | Two OOXML renderers, `office-export.ts:450-611` and `work/deliverables/document.ts:173-358`, nearly identical line for line and sharing only the validator |

### 4.6 Five write paths into one table

1. Chat turn: `persistArtifacts`. Appends a version. Overwrites title **and type** on reuse (`artifacts-store.ts:61-67`). No base check.
2. Targeted edit: `persistTargetedArtifactEdit`, a compare-and-swap (`artifacts-store.ts:103-127`).
3. Generic manual save: `POST /api/artifacts/[id]`. Base version is optional. **No per-type validation.** Used by the Canvas Code tab, restore, Mac and iPhone.
4. Design transactions: `commitTransaction`. Validated. **Rewrites the newest `edit` row in place within 30 s**; a client-chosen `origin: "restore"` always appends (`transactions/route.ts:14`).
5. Design creation: `POST /api/design`. Creates a Conversation and an Artifact, non-atomically (`api/design/route.ts:71-90`).

---

## 5. Naming inconsistencies

| Term | Meanings in the product today | Where |
|---|---|---|
| **Canvas** | (1) the chat side panel; (2) the model tool, the plan flag `PLANS[plan].canvas` (true on every plan, gates only the design routes) and the system-prompt section; (3) the design editor's drawing surface; (4) "the Canvas library" in the /api/artifacts comment; (5) the Mac composer toggle; (6) the native background token `junoCanvas`; (7) the Mac Code run area. ⌘K gives **both** Design and Artifacts the keyword "canvas" | `plans.ts:31`; `api/design/route.ts:42`; `design-canvas.tsx`; `api/artifacts/route.ts:19`; `command-palette.tsx:1168-1169` |
| **Artifact** | Chat Artifact; WorkArtifact (whose UI calls it deliverable, document or output); "release artifacts" in native docs; `AppIcons.artifactsTool`. There are two `serializeArtifact` functions | `src/lib/serializers.ts` and `src/lib/work/serializers.ts` |
| **Document** | DesignDocument; DocumentViewer (files); the Work `document` kind; KnowledgeDocument; `work-documents.tsx` (deliverables); the MARKDOWN chip "Documents" | several |
| **Design** | Juno Design (product and editor); the DESIGN type; the UI design system (`src/lib/design/tokens.generated.ts` sits next to the scene model; `JunoDesignSystem` versus `JunoDesignKit`); `docs/design/` (design law); Mac Code's Plan mode; "Design" / "Designs" / "Juno Design" | `src/lib/design/*`; `design/error.tsx:38` |
| **Outputs** | The per-chat popover (artifacts plus media) versus the old Work rail "Outputs" (deliverables). The deliverable stage still sends users to "Outputs", which does not list deliverables | `session-outputs.tsx:286`; `work-deliverable-stage.tsx:74-77` |
| **Library** | /library (files); "the library" meaning the artifact list in `store.ts`; REWORK_PLAN's Library (files plus artifacts) | — |
| **Files / Sources** | Attachments are "Library" in navigation, "Files" in search (`search/types.ts:45`) and "Sources" in projects | — |
| **ArtifactType labels** | /artifacts: Sites / Components / Code / Documents / Graphics / Diagrams / Designs. Outputs popover: Web page / Component / Code / Doc / Image / Diagram / Design. Row metadata from `runtimeFor`: HTML / React / Markdown / SVG / Mermaid / Design. Project page: the raw enum `MARKDOWN`. Mac library: Page / Component / Document / Graphic / Diagram / Design. Mac chat: HTML / React / Markdown / SVG / Diagram (no DESIGN) | `artifacts/page.tsx:51-60`; `session-outputs.tsx:53-61`; `artifact-runtime.ts:98-103`; `project-sources-list.tsx:332`; `DesktopArtifactsScreen.swift:2006-2048`; `DesktopArtifactCanvas.swift:160-248` |
| **Type glyphs** | Four copies of the web `Record<ArtifactType, Icon>`; the Mac uses `penTool` for designs; the Design mark changed three times | `artifacts/page.tsx:41`; `artifact-preview.tsx:36`; `artifact-inline-card.tsx:49`; `shared-chat-transcript.tsx:21` |
| **Version origin** | `generated` is also written for a blank design the user started by hand (`api/design/route.ts:88`), for targeted AI patches and for audit rewrites | `artifacts-store.ts:117`; `route.ts:3592` |
| **Lede copy** | "Everything Juno built with you" (/artifacts) is untrue: generated media and deliverables are missing. ⌘K "Open Library" carries the keywords "saved prompts snippets" | `artifacts/page.tsx:378`; `command-palette.tsx:1122-1181` |

---

## 6. Top 15 problems, ranked by user impact

The ranking weighs how many people are affected, how often it happens, and whether work or trust is lost. The IDs link to the full index in §7.

| # | Problem | Who and what | Status | Where |
|---|---|---|---|---|
| 1 | **Script previews are dead on the web** because the app CSP is inherited into the `srcdoc` sandbox (X-01) | Every web user, every React, scripted-HTML, Tailwind or Mermaid artifact, the JS/Python console and public share previews: blank or static frames | **confirmed** (reproduced in Chromium by auditor and verifier; lines self-checked; other browsers inferred) | `src/middleware.ts:55-77`; `src/lib/csp.ts:31`; `src/components/canvas/sandbox-frame.tsx:918-929` |
| 2 | **The chat Canvas design editor breaks on the first saved edit** of a generated design (X-02) | Everyone who edits a design inside a conversation. Editor shows "This design can't be opened"; undo is lost; Copy and Download produce empty output until a reload | **confirmed** (7 independent traces; read, not run; self-checked) | `src/components/canvas/canvas-panel.tsx:1243-1253,313-315,369-370,1237` |
| 3 | **Editing an earlier message or regenerating hard-deletes artifacts**, with hand edits, design checkpoints, comments and public links, and no warning (X-03, X-04) | Anyone who fixes a typo or presses Try again after working on an artifact. Shared links return 404 | **confirmed** (critical) | `src/app/api/messages/[id]/route.ts:38-40`; `src/app/api/chat/route.ts:2566-2574` |
| 4 | **Model revisions overwrite the user's own edits.** The model never sees the current version, and a DESIGN revision rebuilds the document, dropping components, variables, effects, motion and comments (X-05, X-06) | Every mixed human and AI editing flow, which is the core of the merge | **confirmed** | `src/lib/artifacts-store.ts:48-75`; `src/app/api/chat/route.ts:1852-1861`; `src/lib/design/authoring.ts:161-203` |
| 5 | **A stopped or cut-off revision becomes the current version**, labelled "Artifact verified", and Continue cannot finish it (X-07) | Free plan (8,192 output tokens, so no artifact over about 30k characters can be revised) and anyone who presses Stop | **confirmed** (probe) | `src/lib/message-content.ts:100-115`; `src/lib/chat-artifact-verification.ts:60-106`; `route.ts:3058-3112,3271-3292` |
| 6 | **Designs grow past the 200k limit after expansion.** Every web edit is then refused, and **the entire Mac and iPhone Artifacts library and Design screen stop loading**. One unknown artifact type does the same (X-08, X-09) | Dense or multi-screen chat designs (about 40 KB or more compact). Every native user who syncs such a row | **confirmed** (measured 5–11× expansion) | `chat-artifact-verification.ts:63`; `artifacts-store.ts:16-25,86`; `NativeArtifactStore.swift:102,111-112,144-147,157` |
| 7 | **Mac and iPhone design saving loses data**: lost updates (the base version comes from sync while the canvas never adopts newer versions), `cornerSmoothing` stripped from every node, and drafts dropped on Back, switching destination or quitting (X-14, X-15, X-16) | Every Mac design user; the iPhone library too | **confirmed** | `NativeArtifactStore.swift:321-335`; `DesignDocument.swift:478-537`; `DesktopDesignScreen.swift:215,444-446,520-523` |
| 8 | **The Mac-hosted design editor ships stale and unstyled**: the bundle predates 11 editor commits (1.6.0), the CSS has no shared primitives (menus, tooltips, buttons), and the inspector is hidden at the default window width (X-17, X-18, X-19) | Every Mac design user | **confirmed** (`--check` self-checked; CSS grep; rendering inferred) | `scripts/build-design-editor.mjs:55-78,171-172`; `src/components/design/host/main.tsx:65-71`; `design-editor.tsx:549-550` |
| 9 | **The Mac chat dock cannot open chat-made designs, and it keeps showing the previous revision** of an artifact after the model revises it (X-11, X-12) | Every Mac chat user working with artifacts | **found-by-verifier** (tsx-verified) and **confirmed** | `chat-artifact-verification.ts:144-158`; `DesktopArtifactCanvas.swift:552-565,817,865-867` |
| 10 | **Designs are invisible outside the editor.** The public share page, the inline chat card and the library and Outputs tiles all show raw DesignDocument JSON (X-20) | Anyone sharing or scanning designs; public visitors | **confirmed** | `src/components/share/shared-artifact-viewer.tsx:29-33`; `sandbox-frame.tsx:786-803`; `artifact-preview.tsx:79-84` |
| 11 | **Work deliverables cannot be reached**: no .docx or .pptx on the web, native-started tasks invisible on the web, the iPhone "Made" list empty for cloud runs, and the Mac list stale during a watched run (X-25, X-27, X-28, X-29) | Everyone who delegates a document, deck or spreadsheet task | **confirmed** | `work-deliverable-stage.tsx:33-44,74-77`; `DesktopWorkWorkspace.swift:4956-4977`; `NativeWorkModel.swift:1038`; `NativeWorkClient.swift:361-405` |
| 12 | **Public links have no governance**: a ban does not take shares down, there is no admin takedown or report link, artifact bodies are never moderated, and the legal contact is a placeholder (X-31, X-32) | Operator liability; people who visit phishing or illicit pages under Juno's chrome | **confirmed** (the exfiltration details depend on the browser; see §12.8) | `src/lib/share.ts:135-139`; `src/lib/moderation.ts:149-199`; `src/app/api/artifacts/[id]/route.ts:7-16,40-90`; `legal/mentions-legales/page.tsx:41` |
| 13 | **Version payloads and storage are unbounded.** Every read ships every version body (an hour of design editing makes the thread about 9–27 MB), design transactions read all versions twice, and a scripted account can force a backend restart (X-30, X-33) | Heavy design users (slow opens, slow saves); every user when the process restarts | **confirmed** (sizes measured; memory arithmetic inferred) | `src/lib/queries.ts:117-121`; `src/lib/serializers.ts:207-223`; `src/lib/design/store.ts:33-39,163-167,193-197`; `deploy/ecosystem.config.js:127` |
| 14 | **Deleting a conversation silently deletes its artifacts, designs, files and share links.** Hand-started designs live in empty "Untitled design" chats that look like clutter (X-22) | Anyone tidying Recents or using "Delete all conversations" | **confirmed** | `app-sidebar.tsx:2268-2273,2777`; `data-privacy.tsx:106,118-121`; `schema.prisma:1137,853`; `api/design/route.ts:69-90` |
| 15 | **Chat-authored designs with an `image` node are always refused**, and the compact grammar cannot express gradients, effects, components, variables, motion or pages (X-10) | Every "design a screen with a photo" request; Free users lose one of their 15 messages | **confirmed** (probe) | `src/lib/chat/system-prompt.ts:286`; `authoring.ts:47,107-151`; `operations.ts:571-575` |

**Next tier** (high severity, narrower impact): design export returns 500 for any name above U+00FF, including curly apostrophes (X-23). The canvas and the exports disagree about container opacity and rotation (X-24). The project page always shows zero artifacts (X-21). Account deletion leaves deliverable files in the bucket, an erasure failure (X-26). Mac HTML that uses a CDN renders broken (X-13).

---

## 7. Defect index

### 7.1 Verified defects, merged across areas

| ID | Defect | Severity | Status | Where | Source findings |
|---|---|---|---|---|---|
| X-01 | App CSP inherited into the `srcdoc` sandbox; every script preview blocked | critical | confirmed | `src/middleware.ts:55-77`; `src/lib/csp.ts:31`; `sandbox-frame.tsx:918-929` | web-artifact-pipeline-1 |
| X-02 | Canvas design editor remounts on a synthetic empty version | high | confirmed | `canvas-panel.tsx:1243-1253,313-315,369-370,1237`; `migrations.ts:91-97` | web-artifact-surface-1, motion-1, history-concepts-1, lifecycle-10, scale-3; found-by-verifier in web-library-ia and web-design-model |
| X-03 | Editing an earlier message hard-deletes later artifacts, versions and shares | critical | confirmed | `src/app/api/messages/[id]/route.ts:38-40` (claim at 9-14) | lifecycle-1; pipeline missed-1 |
| X-04 | Regenerate deletes the answer's artifacts; a re-emitted identifier comes back with a new id | high | confirmed | `chat/route.ts:2566-2574`; `artifacts-store.ts:48-50,76-89` | pipeline-3, lifecycle-2 |
| X-05 | Model revisions from stale history overwrite manual edits; no base check; P2002 race after the message is saved | high | confirmed | `artifacts-store.ts:48-75`; `route.ts:1852-1861,3094-3112`; `context-assembly.ts:18-44` | pipeline-2, gen-quality-4 |
| X-06 | A chat revision of a DESIGN rebuilds the document and drops editor-made structure | high | confirmed | `authoring.ts:161-203,223-225`; `system-prompt.ts:257,291` | gen-quality-3 |
| X-07 | A truncated or stopped revision is saved as current and labelled "verified"; the saved tag is closed so it looks complete | high | confirmed | `message-content.ts:100-115,144-151`; `chat-artifact-verification.ts:60-106,182`; `route.ts:3058-3112,3271-3292` | pipeline-4, gen-quality-1 |
| X-08 | DESIGN size is checked before expansion; the expanded document is stored with no second check | high | confirmed | `chat-artifact-verification.ts:8,63`; `artifacts-store.ts:16-25,86` | pipeline-6, mac-artifacts-missed-2 (found-by-verifier) |
| X-09 | The native artifact store fails closed on one oversized or unknown-type record, which blanks Artifacts and Design | high | confirmed | `NativeArtifactStore.swift:102,111-112,144-147,157,283-287` | mac-artifacts-11, mac-work-parity-5 |
| X-10 | The compact `image` node always refuses the whole design | high | confirmed | `system-prompt.ts:286`; `authoring.ts:47,107-151`; `operations.ts:571-575,711` | web-design-model-3, gen-quality-2 |
| X-11 | The Mac dock and iPhone inline viewer cannot open chat-made designs (compact body in the message) | high | found-by-verifier | `chat-artifact-verification.ts:114-116,144-158`; `DesktopArtifactCanvas.swift:817`; `DesignDocumentCodec.swift:44-50`; `JunoMobileInlineArtifact.swift:62-65` | mac-artifacts-missed-1 |
| X-12 | The Mac dock keeps showing the previous revision under the same identifier | high | confirmed | `DesktopArtifactCanvas.swift:404-416,552-565,865-867` | mac-artifacts-1 |
| X-13 | Mac HTML previews block all CDN scripts, styles, fonts and images | high | confirmed | `NativeArtifactPreview.swift:111-118,163-176`; `ArtifactCanvasView.swift:1234-1249` | mac-artifacts-2 |
| X-14 | The Swift `DesignDocument` has no `cornerSmoothing`, so every native save strips it | high | confirmed | `DesignDocument.swift:478-537,541-690` | mac-design-1 |
| X-15 | Mac design Save uses the synced version as its base; the canvas never adopts newer versions | high | confirmed | `NativeArtifactStore.swift:321-335`; `DesktopArtifactCanvas.swift:973-979`; `DesktopDesignScreen.swift:574-582` | mac-design-2 |
| X-16 | Unsaved Mac design drafts are dropped on Back, switching destination, quitting, or a remote delete | high | confirmed | `DesktopDesignScreen.swift:215,258-264,444-446,520-523` | mac-design-3; lifecycle UX |
| X-17 | Hosted editor CSS lacks the shared UI primitives (`surface-float`, `overlay-glass`, `inline-flex`, `size-8` and others) | high | confirmed (rendering inferred) | `scripts/build-design-editor.mjs:171-172`; `src/components/design/host/editor.css` | mac-design-5 |
| X-18 | The hosted editor runs the `embedded` layout, so the inspector is hidden at the default window size | high | confirmed | `host/main.tsx:65-71`; `design-editor.tsx:169,549-550`; `JunoDesktopApp.swift:148` | mac-design-11 |
| X-19 | The hosted editor bundle is stale and shipped in 1.6.0; the hash misses shared imports; only `release-ios.yml:76` checks it | high | confirmed (self-checked) | `native/macOS/JunoDesktop/Resources/DesignEditor/index.html`; `scripts/build-design-editor.mjs:55-78` | motion, mac-design |
| X-20 | A shared DESIGN renders raw JSON; the inline card "Preview" is JSON in a `<pre>` labelled "Live" | high | confirmed | `shared-artifact-viewer.tsx:29-33,76-78`; `sandbox-frame.tsx:786-803`; `artifact-inline-card.tsx:181` | web-library-ia-2, motion-15 (UX) |
| X-21 | The project page reads `res.artifacts` while the API returns `items`; the fetch is also unscoped | high | confirmed | `projects/[id]/page.tsx:305-318`; `api/artifacts/route.ts:20-25,80` | web-library-ia-1 |
| X-22 | Conversation delete, single or all, cascades artifacts, designs, files and shares; the copy mentions only messages | high | confirmed | `app-sidebar.tsx:2268-2273,2777`; `data-privacy.tsx:106,118-121`; `schema.prisma:1137,853` | web-library-ia-3, lifecycle-11 |
| X-23 | Design SVG, PDF and HTML exports return 500 when a design or layer name has a character above U+00FF | high | confirmed (Node) | `design/[artifactId]/export/route.ts:173-182,213,241-249`; `export.ts:57-60` | web-design-model-1 |
| X-24 | The renderer does not apply a container's opacity, rotation, blend or filter to its children; plain groups apply nothing | high | confirmed | `render.ts:859-866,935-942,950,1024-1044` | web-design-model-2 |
| X-25 | Word and PowerPoint deliverables have no web surface; the stage points to an Outputs panel that does not list them | high | confirmed | `work-deliverable-stage.tsx:33-44,74-77`; `work-run-panel.tsx:356-358` | web-work-deliverables-1, mac-work-parity-4 |
| X-26 | Account deletion leaves every deliverable object in storage | high | confirmed | `src/app/api/account/delete-account.ts:41-53,72` | web-work-deliverables-2 |
| X-27 | Native event-derived deliverables ignore the cloud runner's envelope | high | confirmed | `DesktopWorkWorkspace.swift:4956-4977`; `JunoMobileWorkView.swift:2237-2257` | mac-work-parity-1 |
| X-28 | The Mac reads the durable deliverable index once per open | high | confirmed | `NativeWorkModel.swift:1038,963-1020` | mac-work-parity-2 |
| X-29 | Tasks started on native have no conversation and cannot be reached on the web | high | confirmed | `NativeWorkClient.swift:361-405`; `work/recents.ts:162-179`; `work-url-migration.ts:185-187`; `search/engine.ts:489,509` | mac-work-parity-3 |
| X-30 | Every design transaction reads every version body two or three times; no rate limit | high | confirmed | `store.ts:33-39,130-133,163-167,193-197`; `transactions/route.ts:34,77` | scale-2 |
| X-31 | A banned user's shares keep serving; the only takedown is account deletion, which erases the flag | high | confirmed | `share.ts:135-139`; `moderation.ts:149-186,192-199`; `schema.prisma:1397-1414` | governance-1 |
| X-32 | Public artifact content is never moderated: manual edits and share creation skip every classifier | high | confirmed (exfiltration mechanics depend on the browser) | `artifacts/[id]/route.ts:7-16,40-90`; `share.ts:85-106`; `sandbox-frame.tsx:85-86,878-896` | governance-2 |
| X-33 | Unbounded version storage is loaded wholesale into memory; forcing checkpoints with `origin:"restore"` makes a DoS | high | confirmed (arithmetic inferred) | `store.ts:33-39`; `artifacts/[id]/route.ts:20-25`; `queries.ts:117-121`; `transactions/route.ts:14`; `ecosystem.config.js:127` | governance-3 |

**Confirmed UX-major observations with a clear defect shape:**

- Share dialog says "as it is now" but reuses an old snapshot (`share-dialog.tsx:120-122`; `share.ts:91-95`).
- Opening the share dialog creates a public link (`share-dialog.tsx:78-87`).
- A native failed load of shared links shows "No shared links" (`NativeShareClient.swift:82-92`; `NativeSharedLinksView.swift:34-39`).
- The refusal sentence gives no reason, and the stored reason is read by no UI (`route.ts:441-457`; `types/chat.ts:251`).
- Ghost artifacts after edit or regenerate produce misleading errors (`use-chat.ts:344-354`; `canvas-panel.tsx:431-456,526-546`).
- The Mac Design screen snaps to the launcher and the Artifacts screen switches to a different artifact after a remote delete (`NativeArtifactStore.swift:264-269`; `DesktopDesignScreen.swift:258-263`).
- The Mac dock's "Edit source" can never be saved (`DesktopArtifactCanvas.swift:777-792,847-855`).
- The same "Edit" gesture branches on native and destroys on web (`NativeConversationStore.swift:2304-2398`).

### 7.2 Reported by one auditor, not re-verified (status: unverified unless noted)

- **Pipeline:**
  - Research reports collide on the fixed identifier `research-report` (`route.ts:220-240,2819`).
  - Nine valid Mermaid forms are refused (`chat-artifact-verification.ts:60-106`).
  - A ```` ```json ````-fenced DESIGN is refused (`authoring.ts:216-221`; probe).
  - Library capped at 200 with no paging (`api/artifacts/route.ts:27`).
  - Design folding rewrites a row the share snapshot selects by `createdAt`, so shares leak later edits (`store.ts:179-203`; `share.ts:257-261`). Three areas reported this. The code path is clear; **uncertain** only in timing.
  - The type changes when an identifier is reused (`artifacts-store.ts:61-67`).
  - Forks drop artifacts, and the account export and import skip them (`fork/route.ts:17-27`; `account/export/route.ts:29-60`).
- **Canvas surface:**
  - A card shows "Source unavailable" between the close tag and `done` (`message-item.tsx:1372`; `use-chat.ts:658-678`).
  - Rewrites show old content under "Writing".
  - A non-memoised `openArtifactByIdentifier` defeats the MessageItem memo (`chat-view.tsx:969` → `message-list.tsx:353`).
  - Inline cards mount and run sandboxes as soon as the page loads, Python and JS included.
  - The unsaved Code draft is discarded when the Canvas closes.
  - Fullscreen has `aria-modal` with no focus trap.
  - The Ask/Modify toolbar cannot be reached from the keyboard.
- **Library and IA:**
  - The Code sidebar's Artifacts row flips the product to Chat, and a test locks that in (`product-switch.tsx:130-137`; `tests/shell-product-column.test.ts:43-62`).
  - `?v=` from search and `?id=` from projects are ignored.
  - The Design home error state has no retry.
- **Design model:**
  - Horizontal `fill` overflows its row, cross-axis fill uses the row height, grid has no column tracks, and baseline alignment is not implemented (`layout.ts:231-523`; auditor probes).
  - Several inverses lose data: instance delete, component delete, variants, ungroup.
  - Coalescing drops partial typography patches.
  - `bindVariable` does no type check.
  - Components copy on create, and `overrides` are never read (`instances.ts:4-27`).
- **Design editor** (the verifier's defect list was empty; everything here is unverified):
  - Keyboard shortcuts and the Layers panel stay live during proposal review and write to the hidden committed document. Apply still reports "applied" when it fails.
  - Escape commits instead of cancelling in six fields.
  - Gradient pads commit on every pointermove.
  - Clicking a resize handle turns hug or fill sizing into fixed.
  - Inline hex and opacity inputs have no draft.
  - The line tool only draws horizontal lines.
  - There is no touch pan or pinch (confirmed as UX).
- **Motion:**
  - Preview and export disagree in five reproduced cases, including x/y on auto-layout children, scale origin, text scale, keyframes past the duration and springs.
  - Interaction transitions reach no runtime.
  - HTML trigger semantics are wrong: delay timers start at load, key triggers fire on hidden frames, hover and press fire once, reverse sticks.
  - Playback re-renders the whole page every frame.
  - Delete with a keyframe selected deletes layers.
  - Dock exits slide 16px under reduced motion.
  - The Mac canvas slides under Reduce Motion and uses ease-out-expo.
- **Deliverables:**
  - The site validator rejects ordinary prose.
  - The POST replay cannot dedupe OOXML.
  - A subtitle prints above the first H1.
  - Date-only ISO cells are refused.
  - The spreadsheet preview ignores number formats.
  - The Mac file-name sanitiser replaces "0" with "-" (`DesktopWorkWorkspace.swift:3142`).
  - Mac-hosted runs cannot make deliverables.
- **Mac artifacts and design:**
  - Action errors go through the collection's error channel, whose Try Again reloads everything.
  - The Mac design editor's Export fetches from file:// under `connect-src 'none'`.
  - The Image tool has no `runOpenPanelWith`.
  - Edits made during an in-flight save are cleared.
  - The host colour tokens are cool zinc, not warm coral. The dark hue mismatch is confirmed as UX.
- **Scale:**
  - The canvas chunk is about 449 KB, about half of it design code, even for HTML artifacts (`canvas-panel.tsx:44`; esbuild approximation, not a Next build).
  - A fold wakes every device and re-sends the full body.
  - Native `snapshot()` decrypts the whole account store at least three times per wake-up.
- **Model quality:**
  - A `>` in a title corrupts it.
  - A literal close tag cuts the artifact short.
  - MIME-style types become CODE.
  - Auto classes "build a SaaS dashboard" as simple and routes it to the cheapest model.
  - A skill that requests only `canvas` strips every tool.
- **Governance:**
  - Every anonymous view increments the owner's sync feed (`share.ts:156-158`; `migration.sql:123`).
  - The ProjectMember role is an unvalidated String and trips the ownership guard (`members/route.ts:36-43`; `projects/[id]/route.ts:191,221`).
- **Uncertain:**
  - Whether cascaded `ArtifactVersion` deletes record tombstones. The trigger looks up the parent after it is deleted (`migration 20260815180000:52-57`). If not, deleted version bodies stay on devices indefinitely.
  - Whether X-01 applies in Firefox and Safari. The spec says yes; only Chromium was tested.

---

## 8. Top 10 strengths to keep in any merge

1. **One validated, invertible operation layer for designs.** Changes apply atomically on a clone, each operation returns its own inverse, ids come from the transaction, and zod checks everything. Undo, AI preview, replay and web/Mac parity all use it (`operations.ts:1-22,354-392`). This is the right basis for AI editing inside a conversation and for comments.
2. **The targeted patch protocol for code and documents.** Anchors must be exact and unique, there are limits on coverage and growth, the commit is a compare-and-swap against the base, and half a patch is never saved (`artifact-edit.ts:96-139`; `artifacts-store.ts:103-127`; `terminal-state.ts:98-101`).
3. **The one-table typed-artifact model plus the `runtimeFor` registry.** DESIGN already shows that a type can own its editor (`schema.prisma:1344-1356`; `artifact-runtime.ts:93-127`). Docs, Slides and Design System can be added the same way.
4. **Stale-write safety everywhere a human writes.** A 409 carries the latest version, a banner offers Discard or Save anyway, and a P2002 race is reported as stale (`api/artifacts/[id]/route.ts:51-87`; `canvas-panel.tsx:420-545`; `store.ts:179-203`).
5. **Sandbox isolation reasoning.** The iframe has an opaque origin, `postMessage` is trusted by source, outbound URLs are re-validated, and native previews fail closed behind a content-rule list (`sandbox-frame.tsx:72-88,849-916`; `NativeArtifactPreview.swift:102-274`). Keep the model. Move the sandbox to its own origin (§12).
6. **Check before serving.** Office bytes are re-opened by an independent reader. Refused artifacts never show as cards. Deliverable downloads re-hash the stored bytes (`export/route.ts:100-163`; `route.ts:425-462`; `download/route.ts:93-158`). The Work validator shared with chat Office export is the seed of a typed-artifact export layer.
7. **One editor implementation on web, Mac and iPhone,** through a pluggable `DesignTransport`, plus one native entry point, `DesktopDesignSurface`, and a strictly validated bridge (nonce, revision+1, full decode, JSON-data commands) (`use-design-document.ts:64-107`; `DesignBridge.swift:94-251`).
8. **Disciplined sync and contracts.** Change capture is trigger-based, loaders reuse the REST serializers, the envelope invariant is tested, the native allowlist rule is ship before emit, and the Work and Design contracts are generated with a digest (`sync-entities.ts`; `NativeSyncAPIClient.swift:141-190`; `contracts/design/design-document.v1.schema.json`).
9. **A mature product motion system.** One generated token ladder across CSS, framer and Swift, tiered reduced motion, IconSwap and Collapse primitives, and a written motion law that the web artifact surfaces mostly follow (`globals.css:314-349`; `src/lib/motion.ts`; `JunoDesignTokens.swift:204-530`).
10. **Honest states and honest limits.** Exports report what they cannot express; the Prototype tab says it has no player; Mac copy says when a runtime is not installed; native decoding refuses a newer schema with a reason; error copy is humanised and tested. The Library (`library/page.tsx`; `api/library/route.ts`) is also a ready reference for a unified list: server search, sort, cursor paging, bulk select and trash.

---

## 9. Scorecard (0–10)

| Dimension | Web | Mac | Combined | Justification |
|---|---|---|---|---|
| **Capability** | 6 | 4 | 5 | Web is broad: 7 types, a full design editor with about 37 operations, 9 exports, targeted edits, Office export, shares. But scripted previews are dead and there are no comments, collaboration, live links or deliverable library. The Mac dock is read-only, has no React or Mermaid runtime, no artifact share, a broken Export and no Ask Juno. |
| **UX** | 4 | 3 | 3 | Two editors for one design; JSON wherever designs appear outside an editor; destructive edit and regenerate with no warning; misleading ghost errors; hidden deliverables. The Mac adds dropped drafts, three doors with separate drafts, stacked toolbars and no Quick Look, drag-out or keyboard grid. |
| **Visual design** | 7 | 5 | 6 | The web mostly follows FLAT_UI and PREMIUM_AUDIT, with careful states and skeletons. It drifts on selection tint, raw `z-10` and small hit targets. On Mac, the hosted editor very probably draws menus and tooltips with no surface (inferred), and its palette is cool where native chrome is warm. |
| **Motion** | 7 | 4 | 5 | Web product motion is disciplined; the one slip is dock exits that ignore reduced motion. Document motion has rigorous maths but preview and export disagree, transitions never run and there is no player. Mac artifact surfaces are nearly static and slide under Reduce Motion. |
| **Reliability** | 2 | 3 | 2 | A critical production outage of script previews; several silent data-loss paths (edit, regenerate, re-emit, truncation, conversation delete, Mac saves); a design canvas that breaks on first edit; a native store that one row can blank; a stale shipped bundle. |
| **Code health** | 6 | 5 | 5 | Heavily reasoned comments, pure and deterministic libraries, 277 green design tests. But nothing tests the seams; there are five write paths into one table, duplicated maps, Office renderers and hosts, a hand-mirrored Swift schema and host CSS, dead code, comments that contradict behaviour, and a 5,297-line Mac Work file. |

---

## 10. Web / Mac / iPhone parity snapshot

| Feature | Web | Mac | iPhone |
|---|---|---|---|
| Live HTML/React/Mermaid preview | Built, but blocked by the CSP (X-01) | HTML without CDN; React source plus a note; Mermaid source | Same as Mac |
| Artifact panel inside the conversation | Canvas with versions, diff, restore, edit, share, export | Dock from the tag body only; none of those | Inline sheet: view, source, share text |
| DESIGN in the conversation | Embedded editor, broken on first edit (X-02) | Read-only, and fails on chat-made designs (X-11) | Same as Mac |
| Design create | /design presets, /artifacts, chat | Design screen presets, chat | Chat only |
| Design edit | Transactions, Ask Juno | Whole-document Save through the generic POST, no Ask Juno | Library editable on the latest version (self-checked) |
| Design export | 9 formats | Broken in the editor | None |
| Artifact share link | Yes (JSON for designs) | No | No |
| Library | /artifacts, /design | Artifacts screen, Design screen | Artifacts section |
| Deliverables view and download | Newest previewable file only | Every kind and version, no preview | Empty for cloud runs, no download |
| Comments | None | None | None |
| Search | Artifact content across versions, but no deliverables | Titles only | Titles only |
| Offline | n/a | Read artifacts and designs; no edits; Work shows nothing | Same as Mac |
| Work ↔ chat | Run card in the chat | Separate Work product with no link | Separate tab |

---

## 11. The Liquid Glass branch (`mac/liquid-glass-chat`)

- **Diff on audited paths** (`git diff main mac/liquid-glass-chat`, reported by the Mac areas):
  - `DesktopArtifactCanvas.swift`, `DesktopArtifactsScreen.swift` and `DesktopDesignScreen.swift` change only comments and icons (the JunoDesign mark replaces `pencil.tip`).
  - Design is promoted to a Chat navigation row (`sidebarCases [.library, .projects, .artifacts, .design]`).
  - The dock also wraps draft and private chats.
  - `.work` becomes `.legacyWork`, and a Work errand opens a new chat.
  - `NativeConversationStore` regenerate is extended to settled answers, which **widens exposure to X-04** until the server rule changes.
  - `tokens.generated.ts` has only its header changed.
  - Web files are unchanged. The branch is otherwise *behind* main (one `CodeSessionCommand.attempts` schema line).
- **Its plan** (`MACOS_LIQUID_GLASS_REDESIGN.md` in the juno-glass worktree):
  - It already records that Canvas edits are never saved (line ~130), the bundle is stale (~211, ~1562), and the Canvas toggle does nothing (~97).
  - Phase 5 adds deliverable tiles (Quick Look, opening into the canvas dock) and an Outputs popover.
  - The canvas dock is to get server export, a versions popover and bundled React and Mermaid.
  - It does **not** unify WorkArtifact, say how a text-only dock renders binary deliverables, add native artifact share links or comments, or mention the iPhone.
  - Another session has uncommitted edits in that worktree; the plan doc grew from 1861 to 1879 lines during the audit.
- **Net: the branch fixes none of the defects above.** Merge work on the Mac should build on this branch's navigation. It should *not* keep a fourth "Design" row if the merge makes Design a type (§12.2).

---

## 12. Preconditions and blockers for a Claude-style merge of Artifacts and Design

This is the target: Design, Docs, Slides and Design System as typed artifacts inside conversations, each at one shareable link, editable on a phone, with comments. Each blocker below cites its evidence. Everything under **Needed** is an inferred recommendation.

### 12.1 Data model

**Blockers (read)**

- `Artifact` has no `userId` and a required `conversationId` that cascades on delete (`schema.prisma:1125-1144`). Hand-started designs have to invent an empty chat (`api/design/route.ts:69-90`), and deleting a conversation destroys them (X-22).
- `messageId` is used as a delete key (`messages/[id]/route.ts:38-40`; `chat/route.ts:2573`). Identity is not stable: a re-emit after regenerate creates a new id (X-04).
- There is no `deletedAt` and no trash. Every removal is a hard delete that cascades to versions and shares.
- The table has two versioning semantics: append-only for artifacts, fold-in-place for designs (`store.ts:179-203` versus `JUNO.md:2522` and `share.ts:257-261`).
- `ArtifactVersion` has no `messageId`, author, branch or completeness marker (`schema.prisma:1146-1160`). Truncation and provenance cannot be recorded.
- Reusing an identifier can change the type (`artifacts-store.ts:61-67`).
- Two made-thing tables exist: `Artifact` holds text; `WorkArtifact` holds bytes, validation and provenance, and its spec is discarded (`schema.prisma:2608-2665`).
- Comments live inside the DesignDocument JSON, and no operation writes them (`types.ts:738-752`). No other type has comments at all.
- Artifact bodies are plaintext at rest to allow Postgres full-text search (`encrypt-columns.ts:23-28`), while the same body inside `Message` is encrypted. The privacy policy implies otherwise (`legal/confidentialite/page.tsx:46-48`).

**Needed (inferred)**

- Add `Artifact.userId`. Make `conversationId` nullable, meaning "made in", with `SetNull`. Add an optional `projectId` and `deletedAt` (30-day trash). Rename `messageId` to `createdInMessageId` and never use it as a delete key.
- Keep one artifact id per identifier across edit and regenerate. A type change creates a new artifact.
- Add `ArtifactVersion.messageId`, `authorKind` (model, user, restore, agent), a `complete` flag and a branch id.
- Keep published versions immutable, with a separate *working head* for design folding that is not change-captured on every gesture.
- Store comments in their own table keyed by artifact, version and anchor.
- Decide WorkArtifact's future:
  - **A.** A union index over both tables.
  - **B.** Deliverables become typed artifacts with binary-backed versions and a persisted spec as the editable source.
  - B is the Claude-shaped option. Either way, start persisting the spec now.

### 12.2 Information architecture

**Blockers**

- Things Juno made are split across /artifacts, /design, /library, the Outputs popover, the Work stage and project Sources. None is complete (§4.5).
- REWORK_PLAN (fold into Library) and TWO_PRODUCTS (three siblings) conflict, and the conflict is unresolved (§3.3).
- Code's Artifacts row flips the product to Chat.

**Needed**

- One **Artifacts** place with type filters (Designs, Docs, Slides, Sites, Diagrams, Code, Images, Deliverables) and a **New** menu (design presets plus a blank Doc, Deck or Site).
- Design becomes a type and a New action, not a destination.
- Library stays for files.
- The list reuses the Library's server search, sort, cursor paging, trash and bulk actions (`api/library/route.ts`).
- Settle naming first (§5): one noun per object and one type registry for labels and glyphs across web and native.

### 12.3 Routing

**Blockers**

- There is no canonical route per artifact. Code types open only at `/chat/{c}?artifact={identifier}`, which is identifier-based and breaks when the identifier is re-created. Designs open in two editors depending on the door.
- `?v=` and `?id=` are ignored.
- The share page has no design renderer.

**Needed**

- A canonical `/a/{artifactId}` (name illustrative). It renders full-window on its own, and the same component renders as the side panel inside the owning conversation. Search, share, projects, Outputs and native deep links all point at it.
- Version is a query parameter that the page honours.

### 12.4 Editor

**Blockers**

- The embedded Canvas editor breaks after the first checkpoint (X-02). It is keyed by version, and its rails follow the viewport rather than its container (`design-editor.tsx:549-550`).
- The Canvas has no Ask Juno and no link to the full editor.
- There are two AI channels: chat re-emit, and Ask Juno transactions that are never written to the transcript (`edit/route.ts` writes no message). Neither sees the other.
- The chat compact grammar (7 node types, `authoring.ts:46-88`) and the operation vocabulary (`ai.ts:272-299`) are two design languages.
- Size limits are 200k characters per document, 96 KB per image, and assets are inlined.
- There is no editor for Docs or Slides. Decks are MARKDOWN with conventions (`system-prompt.ts:293-297`).
- Web phone editing is broken: no touch pan, rails pinned, toolbar clipped.

**Needed**

- One editor mount keyed by artifact identity, sized by its container, with rails as sheets at narrow widths.
- One assistant thread that reads the current version and emits patches for code and documents, or design operations for DESIGN, shown as reviewable proposals in the transcript. The compact grammar retires or becomes "operations against an empty document".
- An external asset store.
- Per-kind editors for Docs and Slides on the same proposal and transaction contract.

### 12.5 Native hosting

**Blockers**

- The bundle is stale and nothing gates it (only `release-ios.yml:76` checks it). Its hash misses shared imports, and its CSS misses the primitives (X-17, X-19).
- The Swift schema mirror is written by hand and has already drifted (X-14).
- The Mac and iPhone hosts duplicate each other.
- The bridge carries only document snapshots: no AI proposals, comments, theme or accent, undo state, export or file-picker channels.
- The Mac dock is not backed by the stored row (`DesktopArtifactCanvas.swift:33-54`).
- `NativeArtifactStore` fails closed on unknown kinds (X-09).
- HTML sandbox policy is not at parity with the web (X-13).

**Needed**

- Build the bundle in an Xcode phase or a CI and release gate.
- Generate Swift from the JSON Schema, or carry unknown fields as opaque JSON.
- **Ship native builds that tolerate unknown kinds before the server emits any new type.**
- Look up the dock's row by (conversationID, identifier).
- Move Mac and iPhone saves onto the transactions protocol and adopt remote versions.
- Move the shared host core into JunoDesignKit.
- Extend the bridge with proposals, comments, appearance and undo.

### 12.6 Sync

**Blockers**

- `artifact_version` syncs full bodies for every version, and every fold re-sends one (the UPDATE trigger has no `WHEN`, `migration.sql:116-117`).
- `snapshot()` decrypts the whole account on every read.
- `origin` is dropped.
- Twelve `work_*` entities are synced and never read.
- There are no offline artifact mutations.
- Share view increments write into the owner's feed.
- Tombstones for cascaded deletes are uncertain (§7.2).

**Needed**

- Sync metadata plus the current body; fetch old versions on demand.
- Per-key or per-namespace store reads.
- Do not change-capture the working head on every gesture.
- Move view counting off the `Share` row.
- Add new entities (comments, grants) to the native allowlist before the server emits them (`NativeSyncAPIClient.swift:141-152`).

### 12.7 Sharing

**Blockers**

- Shares are anonymous, read-only snapshots resolved **by timestamp**, so in-place rewrites leak into them.
- Re-sharing returns an older snapshot while the dialog promises "as it is now".
- Opening the dialog publishes.
- A shared design shows JSON (X-20), and Library images in a design are owner-only paths (`api/files/[...key]/route.ts:19-36`).
- Native can only share chats.
- Deliverables cannot be shared.
- Deleting an artifact cascades its shares.

**Needed**

- Two concepts. A **published snapshot** pinned to a version id; backfill it from `snapshotAt`, knowing folded rows may already have leaked. And **shared-with-people** live access through grants.
- A public design renderer using server-side `renderPageSvg` or `exportSvg`, with a capability-scoped asset path.
- Share Open Graph images.
- An explicit Publish step.

### 12.8 Permissions, governance and quotas

**Blockers**

- Every artifact and design route authorises only through `artifact → conversation.userId`.
- `ProjectMember` has no UI, an unvalidated role, no COMMENTER role, and no connection to artifacts or conversations.
- A ban does not reach shares. There is no takedown, no report path, no moderation of artifact bodies, no rate limits on share, artifact, design, transaction or export writes, and no plan quotas (`plans.ts:4-36`).
- **Cross-cutting interaction (inferred from X-01 and X-32):** today the inherited CSP stops scripts running on public share pages in Chromium. That incidentally blocks the script-based exfiltration described in X-32, although `img-src https:` beacons are still allowed by both policies. **Fixing X-01 by moving previews to their own origin will re-enable scripted public pages, so the takedown, ban propagation, report path and egress policy must ship in the same release.**

**Needed**

- A per-artifact grant model (viewer, commenter, editor) independent of the chat.
- Admin lookup and takedown by token, artifact or user, with `ModerationFlag` able to reference an artifact or share and kept when the account is deleted.
- Screening at publish time.
- Quotas for artifacts, versions, bytes and active links.
- Rate limits on every write route. The atomic limiter already exists (`rate-limit.ts:17-38`).

### 12.9 Model and AI

**Blockers**

- Revisions come from the model's own message text (X-05); the current version never enters the prompt.
- Every revision is a full re-emit (`system-prompt.ts:257`).
- Truncation is kept (X-07).
- Auto routing ignores artifact size and type.
- The model gets no render or error feedback; Ask Juno runs single-turn, blind (`includeImage:false`), on `qwen3.8-flash` by default.
- There is no evaluation of real outputs (`scripts/eval-juno.ts` has no model calls).

**Needed**

- Put the current version, or a digest with ids, into the prompt.
- Route follow-ups through patches or operations.
- Add a completeness gate before a version becomes current.
- Size-aware routing.
- A render and console feedback loop.
- The golden-set evaluation outlined in the model-quality finding (about 40 prompts × a model matrix × validity, render success and a visual rubric). Build it **before** the merge so the merge can be measured.

### 12.10 Migrating existing URLs and Mac destinations

Entry points in use today, all of which must keep working:

| Surface | Existing entry | Migration (inferred) |
|---|---|---|
| Web | `/artifacts` | Becomes the unified list; add `?type=` filters and keep the list/grid preference |
| Web | `/design` | Permanent redirect to `/artifacts?type=DESIGN` with the New-design presets kept visible |
| Web | `/design/{artifactId}` | Permanent redirect to the canonical `/a/{artifactId}` (full-window editor) |
| Web | `/chat/{c}?artifact={identifier}` (`&v=`) | Resolve the identifier to an artifact id on the server; open the panel on that id; honour `v` |
| Web | `/share/{token}` | Tokens stay valid; add a version pin by backfill; add a design renderer |
| Web | `/projects/{id}` Sources, `?id=` links | Point at `/a/{id}`; scope the fetch to the project (fixes X-21) |
| Web | `/work/*` | Already mapped by `work-url-migration.ts`; add a target for native-created sessions that have no conversation (X-29) |
| API | `/api/artifacts/*`, `/api/design/*`, `/api/share` | Keep them as they are while native builds in the field still call them. Validate DESIGN bodies on the generic POST, or route them to transactions |
| Mac | `.artifacts`, `.design` destinations (footer on main, nav row on the glass branch) | Keep the `.design` enum case decodable for state restoration; route it to Artifacts filtered to DESIGN, with New design |
| Mac | Code's retired `.design` selection (`DesktopCodeStudio.swift:34-35`; `DesktopCodeWorkspace.swift:409-416`) | Keep it decodable; it already falls back to the landing |
| Mac | Work › Made; detached artifact windows | Point at the canonical artifact; the Liquid Glass Phase 5 tiles |
| iPhone | Artifacts section, Work tab | Same canonical id; tolerant decoding first |
| Data | Holder conversations of hand-started designs | Choose: detach (`conversationId` → null) or keep them as the design's thread. Do not leave them as unexplained empty chats |
| Contracts | OpenAPI `ArtifactKind` has no DESIGN; `/api/design` and `/api/share` are undeclared (`juno-native-v1.yaml:1866-1868`) | Update the contract, and add a test binding it to the Prisma enums |

### 12.11 Telemetry (precondition for judging the merge)

There is no metrics sink (`src/lib/observability.ts` has no importers). Sandbox failures, bridge refusals (`lastRefusal` is written and never read), 409, 413 and 422 outcomes, verification refusal rates, Share views over time and sync bytes are all invisible. The merge needs at least these signals:

- p95 thread payload;
- preview success rate per runtime;
- fold versus append ratio and conflict rate for designs;
- verification refused, repaired and passed rates;
- share views with bots filtered out;
- the native editor bundle version seen in the field.

---

## 13. Open questions for the owner (the ones that change the plan)

1. **Did WorkArtifact start separately on purpose?** Does the merge unify the tables (option B) or only the list (option A)? (§12.1)
2. **Does the Artifacts → Library fold still stand, or has TWO_PRODUCTS' three-siblings layout replaced it?** And is Design a destination or a type? (§3.3)
3. **Should a public link stay a frozen snapshot, become live, or offer both** (published versus shared-with-people)? This decides whether Share gains a version pin, grants, or both.
4. **Should regenerate ever delete an artifact?** The recommended answer is no: keep the row, add a version, and move the shares with it.
5. **Where do comments live**: in the document JSON, versioned and folded, or in a separate table open to non-owner and anonymous commenters?
6. **Once previews run again, what network egress should artifacts have?** And should artifacts from turns containing untrusted web or connector content render without a click?
7. **Legal:** who is the notice-and-action contact that replaces `[adresse e-mail de contact]`, and should a ban suspend shares reversibly?
8. **Should private (incognito) chats support artifacts** in the merged surface? Today Canvas is off there (`route.ts:958,973,990`).
9. **Production data:** how many `ArtifactVersion` rows exceed 200k UTF-16 units, and how many share rows point at a DESIGN? Both need read-only SQL. They decide whether X-09 is live for users today and how many public links show JSON.

---

## 14. What this means for merging Artifacts and Design

**The good news is structural.** Juno already did what Anthropic did at the storage layer. A design is a typed artifact in the same table as pages, documents and diagrams, with the same versions, share tokens, library and sync. Its editor is one React implementation that already runs inside the chat Canvas, a full window, the Mac and the iPhone. It has a validated operation vocabulary and a preview-then-accept AI loop. "Design inside the conversation" has a working host today. It fails on the first edit because of one synthetic-version bug, not because of architecture.

**The bad news is behavioural and cross-cutting.** Juno's made things behave like attachments of chat messages, not objects in their own right:
- they die when a message is edited or regenerated, or a chat is deleted;
- the model rewrites them from its memory, not their current state;
- truncation silently replaces them;
- their links are timestamp snapshots with no owner controls;
- designs cannot be seen anywhere outside an editor;
- the Mac shows a different copy (the tag body) from the library (the row);
- deliverables live in a parallel universe.

A merged surface magnifies every one of these problems, because the same object becomes reachable from more places, by more people, on more devices.

**Recommended sequence (inferred):**

1. **Stop the bleeding.**
   - Serve previews from their own origin (X-01), *together with* share governance: ban propagation, takedown, report link, egress policy.
   - Fix the Canvas design remount (X-02).
   - Remove `artifact.deleteMany` from edit and regenerate (X-03, X-04).
   - Refuse incomplete versions as current (X-07).
   - Check size after expansion (X-08).
   - Ship tolerant native decoding (X-09).
   - Rebuild and gate the editor bundle and fix its CSS scan (X-17, X-19).
   - Restore `cornerSmoothing` and a correct base version on Mac saves (X-14, X-15).
   - Stop Mac drafts vanishing (X-16).
2. **Make artifacts first-class.**
   - Direct ownership, soft delete, stable identity and version provenance.
   - Immutable published versions plus a working head.
   - Payload diet: current body only, history on demand.
   - Rate limits and quotas.
   - A telemetry spine.
3. **Build one surface.**
   - The canonical `/a/{id}`, rendered full-window and as the conversation panel.
   - One Artifacts list with type filters and a New menu; Design becomes a type.
   - Server-rendered thumbnails for every kind (the design SVG export already exists).
   - The model reads the current version and edits through patches and operations shown as proposals in the transcript.
   - The Mac dock backed by the stored row, on the Liquid Glass navigation.
4. **Reach Claude parity.**
   - A comments table.
   - Published links plus access grants.
   - Phone editing (container-sized editor and touch).
   - Docs and Slides as typed artifacts: decide on WorkArtifact and persist the specs.
   - A cross-document Design System.

The merge is achievable, and cheaper at the data layer than it looks. It should not start at the UI. If step 1 and the ownership and versioning changes in step 2 are skipped, a unified surface would make today's silent losses and dead previews visible in one prominent place.
