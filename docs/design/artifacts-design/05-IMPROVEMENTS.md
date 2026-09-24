# Improvement backlog: Juno Design & Artifacts

**Date:** 2026-09-24. **What this is:** step 3's backlog. It lists every audit defect (X-ids, from `00-AUDIT-OVERVIEW.md` §7) and every recommendation from the Claude/Figma gap analysis (R-ids, from `03-COMPETITIVE-AUDIT.md`), placed into the phases of `04-MERGE-PLAN.md` §13.

It is generated from `04` Appendix B (the phase placement), `wip/merge/backlog.clean.json` (the 101 consolidated, source-scrubbed recommendations) and `00` §7.1 (the verified defects). When they disagree, `04` wins. The item text is the gap analysts'; the placement is the plan's.

## How to read it

- **X-nn**: a verified defect in today's product. Its status says whether a branch already fixes it.
- **R-nnn**: an improvement. P0 is needed for the merge or fixes a loss of work or trust; P1 is core parity; P2 is a differentiator; P3 is polish. Effort runs S / M / L / XL.
- **Platforms**: web, mac, iphone. **Depends on**: X-ids, R-ids or audit ids (`Dn`, `Mnn`, `Lnn` in `01`; `Hn` and Mac `Mn` in `02`).
- An item split across phases appears in each phase, with the part noted in brackets.

## Phase 0 — the defects to fix first

Where each defect closes, from `04` Appendix B. Several close in stages; the stage is in brackets.

| ID | Defect | Severity | Where | Closes in | Status (2026-09-24) |
|---|---|---|---|---|---|
| X-01 | App CSP inherited into the `srcdoc` sandbox; every script preview blocked | critical | `src/middleware.ts:55-77`; `src/lib/csp.ts:31`; `sandbox-frame.tsx:918-929` | 0A (R0–R2) (owner half); 0B (N1, R4) (public half) | **Shipped 2026-09-24** in origin/main `1633a4b5` (`16fc3009`) and deployed: previews load a `/sandbox/v1/*` shell with its own CSP, and it answers only when `Sec-Fetch-Dest` is iframe. Public shares stay static until screening (X-32) and B11 exist; the separate preview domain is still to do. |
| X-02 | Canvas design editor remounts on a synthetic empty version | high | `canvas-panel.tsx:1243-1253,313-315,369-370,1237`; `migrations.ts:91-97` | 0A (R0–R2) (fix); 2 (structural) | **Shipped 2026-09-24** in origin/main `1633a4b5` (`499b6afd`) and deployed. Needs a signed-in check. The Mac bundle needs a rebuild to pick it up. |
| X-03 | Editing an earlier message hard-deletes later artifacts, versions and shares | critical | `src/app/api/messages/[id]/route.ts:38-40` (claim at 9-14) | 0A (R0–R2) | **Shipped 2026-09-24** in origin/main `1633a4b5` (`7243613f` via `04aced7b`) and deployed. |
| X-04 | Regenerate deletes the answer's artifacts; a re-emitted identifier comes back with a new id | high | `chat/route.ts:2566-2574`; `artifacts-store.ts:48-50,76-89` | 0A (R0–R2) | **Shipped 2026-09-24** in origin/main `1633a4b5` (`7243613f` via `04aced7b`) and deployed. |
| X-05 | Model revisions from stale history overwrite manual edits; no base check; P2002 race after the message is saved | high | `artifacts-store.ts:48-75`; `route.ts:1852-1861,3094-3112`; `context-assembly.ts:18-44` | 0A (R0–R2) (contained); 3 and N2 | Open |
| X-06 | A chat revision of a DESIGN rebuilds the document and drops editor-made structure | high | `authoring.ts:161-203,223-225`; `system-prompt.ts:257,291` | 0A (R0–R2) (contained); 3 and N2 | Open |
| X-07 | A truncated or stopped revision is saved as current and labelled "verified"; the saved tag is closed so it looks complete | high | `message-content.ts:100-115,144-151`; `chat-artifact-verification.ts:60-106,182`; `route.ts:3058-3112,3271-3292` | 0A (R0–R2) (core); 3 and N2 | **Merged to main 2026-09-24** (release train; deploy pending) (`91e49022`): an unfinished artifact is refused and never becomes current. |
| X-08 | DESIGN size is checked before expansion; the expanded document is stored with no second check | high | `chat-artifact-verification.ts:8,63`; `artifacts-store.ts:16-25,86` | 0A (R0–R2) | **Shipped 2026-09-24** in origin/main `1633a4b5` (`9161bcbc`) and deployed. M11 type immutability merged to main 2026-09-24 in the release train (deploy pending). |
| X-09 | The native artifact store fails closed on one oversized or unknown-type record, which blanks Artifacts and Design | high | `NativeArtifactStore.swift:102,111-112,144-147,157,283-287` | 0B (N1, R4) | Open |
| X-10 | The compact `image` node always refuses the whole design | high | `system-prompt.ts:286`; `authoring.ts:47,107-151`; `operations.ts:571-575,711` | 0A (R0–R2) (part); 3 and N2 | **Part merged to main 2026-09-24** (release train; deploy pending) (`d04065c6`): an image node becomes a placeholder instead of failing the design. |
| X-11 | The Mac dock and iPhone inline viewer cannot open chat-made designs (compact body in the message) | high | `chat-artifact-verification.ts:114-116,144-158`; `DesktopArtifactCanvas.swift:817`; `DesignDocumentCodec.swift:44-50`; `JunoMobileInlineArtifact.swift:62-65` | 0B (N1, R4) (Mac and iPhone, N1); 2 (web) | **In progress on** `mac/liquid-glass-chat` (Phase 2 stage 3, `2b1049c5`): renders from the stored row. |
| X-12 | The Mac dock keeps showing the previous revision under the same identifier | high | `DesktopArtifactCanvas.swift:404-416,552-565,865-867` | 0B (N1, R4) (Mac, N1); 2 (web) | **Addressed by** the glass branch row resolver (plan N1 cherry-picks it). |
| X-13 | Mac HTML previews block all CDN scripts, styles, fonts and images | high | `NativeArtifactPreview.swift:111-118,163-176`; `ArtifactCanvasView.swift:1234-1249` | 0B (N1, R4) (decision); After X-01b (the Mac allowlist, with sign-off) | Open |
| X-14 | The Swift `DesignDocument` has no `cornerSmoothing`, so every native save strips it | high | `DesignDocument.swift:478-537,541-690` | 0A (R0–R2) (server); 5 and N3 (generated mirror) | Open |
| X-15 | Mac design Save uses the synced version as its base; the canvas never adopts newer versions | high | `NativeArtifactStore.swift:321-335`; `DesktopArtifactCanvas.swift:973-979`; `DesktopDesignScreen.swift:574-582` | 0B (N1, R4) (base, Mac and iPhone); 3 and N2 | Open |
| X-16 | Unsaved Mac design drafts are dropped on Back, switching destination, quitting, or a remote delete | high | `DesktopDesignScreen.swift:215,258-264,444-446,520-523` | 0B (N1, R4) (prompt); 3 and N2 | Open |
| X-17 | Hosted editor CSS lacks the shared UI primitives (`surface-float`, `overlay-glass`, `inline-flex`, `size-8` and others) | high | `scripts/build-design-editor.mjs:171-172`; `src/components/design/host/editor.css` | 0B (N1, R4) | Open |
| X-18 | The hosted editor runs the `embedded` layout, so the inspector is hidden at the default window size | high | `host/main.tsx:65-71`; `design-editor.tsx:169,549-550`; `JunoDesktopApp.swift:148` | 0B (N1, R4) | Open |
| X-19 | The hosted editor bundle is stale and shipped in 1.6.0; the hash misses shared imports; only `release-ios.yml:76` checks it | high | `native/macOS/JunoDesktop/Resources/DesignEditor/index.html`; `scripts/build-design-editor.mjs:55-78` | 0B (N1, R4) | Open |
| X-20 | A shared DESIGN renders raw JSON; the inline card "Preview" is JSON in a `<pre>` labelled "Live" | high | `shared-artifact-viewer.tsx:29-33,76-78`; `sandbox-frame.tsx:786-803`; `artifact-inline-card.tsx:181` | 0A (R0–R2) (static); 2 | **Static part merged to main 2026-09-24** (release train; deploy pending) (`4c1a3bd8`, `989fb306`): server-drawn posters on the share page, library, chat card and Outputs. |
| X-21 | The project page reads `res.artifacts` while the API returns `items`; the fetch is also unscoped | high | `projects/[id]/page.tsx:305-318`; `api/artifacts/route.ts:20-25,80` | 0A (R0–R2); 4 (complete) | **Merged to main 2026-09-24** (release train; deploy pending) (`b4206be9`). |
| X-22 | Conversation delete, single or all, cascades artifacts, designs, files and shares; the copy mentions only messages | high | `app-sidebar.tsx:2268-2273,2777`; `data-privacy.tsx:106,118-121`; `schema.prisma:1137,853` | 0A (R0–R2) (detach); 1 (trash) | Open |
| X-23 | Design SVG, PDF and HTML exports return 500 when a design or layer name has a character above U+00FF | high | `design/[artifactId]/export/route.ts:173-182,213,241-249`; `export.ts:57-60` | 0A (R0–R2) | **Merged to main 2026-09-24** (release train; deploy pending) (`dd6817e3`). |
| X-24 | The renderer does not apply a container's opacity, rotation, blend or filter to its children; plain groups apply nothing | high | `render.ts:859-866,935-942,950,1024-1044` | 0A (R0–R2) | **Merged to main 2026-09-24** (release train; deploy pending) (`0bd1f8b1`). |
| X-25 | Word and PowerPoint deliverables have no web surface; the stage points to an Outputs panel that does not list them | high | `work-deliverable-stage.tsx:33-44,74-77`; `work-run-panel.tsx:356-358` | 0A (R0–R2) (kit); 4 (index); 5 and N3 (artifact rows) | Open |
| X-26 | Account deletion leaves every deliverable object in storage | high | `src/app/api/account/delete-account.ts:41-53,72` | 0A (R0–R2) | **Merged to main 2026-09-24** (release train; deploy pending) (`00ca0b1c`). |
| X-27 | Native event-derived deliverables ignore the cloud runner's envelope | high | `DesktopWorkWorkspace.swift:4956-4977`; `JunoMobileWorkView.swift:2237-2257` | 0B (N1, R4) | Open |
| X-28 | The Mac reads the durable deliverable index once per open | high | `NativeWorkModel.swift:1038,963-1020` | 0B (N1, R4) | Open |
| X-29 | Tasks started on native have no conversation and cannot be reached on the web | high | `NativeWorkClient.swift:361-405`; `work/recents.ts:162-179`; `work-url-migration.ts:185-187`; `search/engine.ts:489,509` | 4 (web); 5 and N3 | Open |
| X-30 | Every design transaction reads every version body two or three times; no rate limit | high | `store.ts:33-39,130-133,163-167,193-197`; `transactions/route.ts:34,77` | 1 | Open |
| X-31 | A banned user's shares keep serving; the only takedown is account deletion, which erases the flag | high | `share.ts:135-139`; `moderation.ts:149-186,192-199`; `schema.prisma:1397-1414` | 0B (N1, R4) | Open |
| X-32 | Public artifact content is never moderated: manual edits and share creation skip every classifier | high | `artifacts/[id]/route.ts:7-16,40-90`; `share.ts:85-106`; `sandbox-frame.tsx:85-86,878-896` | 0B (N1, R4) | Open |
| X-33 | Unbounded version storage is loaded wholesale into memory; forcing checkpoints with `origin:"restore"` makes a DoS | high | `store.ts:33-39`; `artifacts/[id]/route.ts:20-25`; `queries.ts:117-121`; `transactions/route.ts:14`; `ecosystem.config.js:127` | 0B (N1, R4) (lever); 1 | Open |

The unverified defects reported by a single auditor are listed in `00` §7.2. Fix them when you touch the code around them.

## Phase 0A — Stop the bleeding (W1–W4, server and web)

### R-003 · Delete removes keyframes, not layers, and the timeline works from the keyboard
`P0` · effort S · web, mac, iphone · editor · depends on M66, E6 (mac), L23, X-19
- **Build:** - Route keys by focus. While focus is in the timeline dock or a keyframe is selected, Delete removes the selected keyframes in one setKeyframes transaction ('Delete 3 keyframes', undoable). With a track row selected it removes the track. It never emits deleteNodes. Escape clears the keyframe selection first, then the layer selection.
- Keyframes become buttons in a roving-tabindex grid. ←/→ move between keyframes and ↑/↓ between tracks. ⇧←/→ nudges 10 ms and ⇧⌥ 100 ms. Enter opens easing and Space plays. Label example: 'Opacity keyframe, 240 ms, ease out, 2 of 4'. A selected keyframe is a foreground-ink diamond on a bg-selected halo, not the accent.
- Undoing 'Animate property' removes the empty track.
- Add a component test for the key routing, then rebuild the native bundle.
- **Why:** Pressing Delete on a keyframe never destroys the layer, and the timeline works without a mouse.
- **Reference:** Figma Motion: select a keyframe and press Delete to remove it. With a property row selected, Delete removes all its keyframes (help 41307938657559, 2026-06-24, primary). Users still ask for typed keyframe times and select-all per property (forum, 2026-06 to 08, secondary).
- **Juno today:** Delete or Backspace with a keyframe selected deletes the selected layers and their tracks (M66; design-editor.tsx:476-486). Diamonds cannot be focused or activated from the keyboard, and their only label is 'Keyframe at N ms' (E6 mac; motion-panel.tsx:683-722). Undoing 'Animate property' leaves an empty track (L23; operations.ts:1555-1559). The hosted bundle carries the defect to Mac and iPhone.

### R-004 · Artifacts belong to the account, not to the message that made them [lifecycle]
`P0` · effort L · web, mac, iphone · data-model · depends on R-001, X-03, X-04, X-22, X-09, 00-AUDIT §12.1
- **Build:** Schema:
- Artifact.userId: required, backfilled from conversation.userId.
- projectId: inherited from the made-in chat; changeable with Move to project.
- conversationId: nullable, meaning 'made in', with onDelete SetNull.
- deletedAt (R-006).
- Rename messageId to createdInMessageId. It is provenance only and never a delete key.
- One id per (conversation, identifier), permanently. The type is immutable per id: a type change creates a new artifact.
Behaviour:
- Edit and regenerate never delete. A re-emit appends a version to the same id (R-005). Versions made on an abandoned branch are labelled 'From an earlier reply'. The full Try 2 / Use this experience is R-029.
- Deleting a conversation detaches its artifacts. The dialog reads 'N artifacts made here stay in Artifacts', with an unchecked 'Also move them to Recently deleted'.
- Hand-made artifacts get no holder chat. The conversation is created on the first Ask (R-027).
- Info shows one home line: 'Made in <chat>', 'In <Project>' or 'Your artifacts'.
Migration: detach designs from holder chats that have zero user messages, then delete those chats. Native decodes owner, project and deletedAt as optional fields before the server emits them (R-001).
- **Why:** Fixing a typo, pressing Try again or tidying chats never destroys hours of work or a link someone was already sent.
- **Reference:** Claude after the merge: 'everything you make is saved to the Artifacts tab automatically' (help 9487310, 2026-09, primary). Since 2026-08-19, Cowork artifacts are 'saved to your account' (help 14729249, primary). The merge carried chats, projects and artifacts forward (claude.com/blog/cowork-is-now-claude, 2026-09-16, primary). Figma never creates a file without a home. Its late drafts migration (2024-10 to 2025-10) produced 'files disappeared' reports (figma.com/blog/updates-to-how-drafts-work, 2024-06-03, primary; forum, community). Counter-example: Claude's merge dropped conversation branching (help 16761823, primary).
- **Juno today:** - Ownership: Artifact has no userId. conversationId is required and cascades (schema.prisma:1125-1154).
- messageId is a delete key. Editing an earlier message (X-03; messages/[id]/route.ts:38-40) and regenerating (X-04; chat/route.ts:2566-2574) hard-delete artifacts, versions, design checkpoints and share links, and a re-emit gets a new id. A re-emit can also change the type (M11).
- Deleting a chat cascades to designs, files and shares, while the confirmation copy mentions only messages (X-22).
- Hand-started designs create empty holder chats, non-atomically (api/design/route.ts:69-90; M29).
- Native already treats Edit as a non-destructive branch (NativeConversationStore.swift:2304-2315).

### R-007 · A version becomes current only when it is complete, and the card says so honestly [core]
`P0` · effort M · web, mac, iphone · reliability · depends on R-005, X-07, X-08, M4, M14, M15, M21
- **Build:** - Persist `complete` on every version. A version stays a non-current draft when the tag was unclosed, the type verifier failed or the turn was stopped.
- One state machine, rendered identically on the card, the panel header and native: writing (vN+1 over vN) · checking · ready · stopped · refused(reason) · render-failed.
- Copy for each state:
  - Writing: 'Writing v4, showing v3', with v3 dimmed to 60%.
  - Checking: 'Checking…', shown only after 500 ms.
  - Stopped: 'Stopped before v5 finished · Keep v4 · Continue v5'. Continue patches the partial version.
  - Refused: 'Juno couldn't save this version: <reason> · Try again'.
- The version stepper shows v5 muted with 'Draft, incomplete', and it opens read-only.
- Check size after DESIGN expansion (X-08).
- Humanise refusals, for example: 'That diagram type (quadrantChart) isn't supported yet. I can redraw it as a flowchart.'
- An expected transition never flashes red. The status bar rises in 4px (duration-base, ease-out-soft) and exits on duration-exit ease-in. Labels swap by cross-fade (duration-fast).
- One aria-live=polite announcement: 'Sign-in screen updated to version 4', or 'Stopped; version 3 is still current'.
- **Why:** Pressing Stop or hitting a plan limit never replaces a working artifact with a broken one labelled 'verified'.
- **Reference:** Truncation at Claude's output limit leaves unclosed tags and a blank preview (Pagelive, secondary). Claude Code refuses bad UTF-8 at publish and gives the line and column (code.claude.com/docs/en/artifacts, primary). Claude's conflict copy: 'Someone saved a newer version. The latest files are reloading with your edits kept' (observed in the shipped Claude desktop app, primary).
- **Juno today:** - A stopped or truncated revision becomes current and is labelled 'Artifact verified'. The saved tag is closed, so it looks complete, and Continue cannot finish it (X-07; message-content.ts:100-115; chat-artifact-verification.ts:60-106).
- On Free's 8,192 output tokens, artifacts over about 30k chars cannot be revised safely.
- DESIGN size is checked before expansion (X-08). Refusals show a fixed sentence (M4).
- Between the closing tag and done, the card flips to a red 'Source unavailable' (M14). 'Writing' shows the old content (M15). Ghost artifacts give misleading errors (M21).

### R-012 · Previews run from their own origin under a written network policy [owner half]
`P0` · effort M · web, mac, iphone · reliability · depends on R-011, X-01, X-13, X-31, X-32
- **Build:** - Serve every preview by src from a separate registrable domain, with one subdomain per artifact version. This covers code artifacts, embeds (R-080) and Play on share pages.
- Access uses a signed token {artifactId, version|'latest', grant, exp ≤ 5 min}, re-validated on every load, so a revocation is simply a token refusal.
- Response CSP:
  - script-src: the CDN allowlist (cdnjs, jsDelivr /npm/, unpkg, Tailwind), with runtimes pinned by version rather than dev builds;
  - style-src and font-src: Google Fonts plus the same CDNs;
  - img-src https: data: blob:, which keeps the photos allowed by §2e;
  - connect-src 'self' only, which is the anti-exfiltration line;
  - form-action, base-uri and object-src 'none';
  - no top-level navigation.
- Mirror the allowlist in the Mac and iPhone WKContentRuleList (X-13).
- Cap each version's page at 16 MiB. Add a Chromium CI test that renders a React artifact under the production headers.
- Ship only after R-011.
Resolution: keep external images. Do not copy Claude's blanket block, which Juno's own audit found makes previews look broken. Control egress with connect-src and screening at publish time.
- **Why:** Every 'build me an app' renders again, the same way on web and native, without turning public links into a phishing channel.
- **Reference:** - Claude serves artifacts from a sandboxed *.claudeusercontent.com (code.claude.com/docs/en/artifacts, primary):
  - scripts come only from cdnjs, unpkg, cdn.tailwindcss.com, code.jquery.com and jsDelivr /npm/;
  - fetch, XHR and WebSocket reach only the page's own origin and Google Fonts;
  - external images are blocked;
  - pages are capped at 16 MiB.
- Claude Design previews use short-lived signed tokens that are re-validated on every open (Admin guide, 2026-09-16, primary).
- **Juno today:** Since fb3a42b5 (2026-08-26), the srcdoc sandbox inherits the app's nonce plus strict-dynamic CSP. That kills React, Tailwind, scripted HTML, Mermaid, the JS/Python console and public share previews (X-01; middleware.ts:55-77; csp.ts:31; sandbox-frame.tsx:918-929). PREMIUM_AUDIT §2e deliberately allows https images and fonts. The Mac blocks every CDN, so the same artifact renders differently there (X-13; NativeArtifactPreview.swift:111-118).

### R-020 · Instrument the merged surface before launching it
`P1` · effort S · web, mac, iphone · reliability · depends on 00-AUDIT §12.11
- **Build:** Record these signals:
- artifact intent (armed or automatic) and type;
- time to the first skeleton block and to the first content;
- completion: complete, stopped or truncated;
- proposals shown, applied and discarded, and hunks accepted or rejected;
- 'their words win' conflicts and 409 retries;
- preview render success per runtime, and thumbnail failures;
- shares by scope and version mode, and views excluding bots;
- unsupported kinds seen on native, and the editor bundle version in the field;
- document size, op latency p95 and render ms per frame (R-064).
Put a small internal dashboard on these before launch.
- **Why:** Problems like the four-week preview outage are caught in hours.
- **Reference:** The main complaints about Claude's merge were opaque routing and uncertain cost (HN 49729412; Fortune, 2026-09-16, secondary). Anthropic says usage 'may be measured slightly differently' during the rollout (help 16761823, primary).
- **Juno today:** src/lib/observability.ts is imported by nothing. No render, conflict, proposal or share signals exist (01-AUDIT-WEB §9; 00-AUDIT §12.11). The X-01 preview outage went unnoticed for about 4 weeks.

## Phase 0B — Installed clients and governance (W3–W5)

### R-001 · Native apps tolerate unknown kinds and bad rows before any new type ships
`P0` · effort M · mac, iphone · native-mac · depends on X-09, X-19, L23 (mac)
- **Build:** - Decode unknown kinds to .unsupported(kind), shown as the poster (R-014) plus 'Open on the web'. Skip and flag oversized or corrupt rows instead of failing the whole snapshot.
- Carry unknown DesignDocument fields as opaque JSON until the Swift mirror is generated from the JSON Schema (X-14).
- Ship this in a Mac and iPhone release at least one release before the server emits DOC, DECK or DESIGN_SYSTEM. Gate emission on a minimum-client-version header and fall back to MARKDOWN for older clients.
- Add DESIGN to the OpenAPI enum. Gate the editor bundle hash in native CI and in the Mac release (X-19).
- **Why:** Installed apps keep working the day new artifact types launch.
- **Reference:** Claude degrades rather than fails: phone apps show typed artifacts view-only, and live artifacts made before 2026-08-19 'work but can't be edited in place' (help 16923645, 14729249, primary). The merge rolled out account by account (help 16761823, primary).
- **Juno today:** NativeArtifactStore fails closed on one unknown type or one record over 200,000 chars. That blanks Artifacts and makes Design say 'No designs yet' (X-09; NativeArtifactStore.swift:102-157). The OpenAPI ArtifactKind has no DESIGN (L23 mac; juno-native-v1.yaml:1866-1868). The editor bundle is stale and nothing gates it (X-19).

### R-002 · iPhone design editing is read-only until its saves are safe
`P0` · effort S · iphone · reliability · depends on X-14, X-15, X-19, M13 (mac)
- **Build:** Until saves go through /api/design/[id]/transactions and adopt remote versions, make the iPhone design editor read-only with one honest line: 'Edit this design on the web or your Mac'. Keep view and zoom, and comment once R-040 lands. Lift the guard as part of the phone contract (R-069). This is split from FIA-15 (its P0 guard); the rest of FIA-15 is in R-069.
- **Why:** No silent data loss on the phone while the real phone editor is built.
- **Reference:** Figma's mobile app cannot edit Design files or Slides decks (help 1500007537281, primary). App Store reviews complain that screenshots suggest editing is possible (v26.36.0, community).
- **Juno today:** The iPhone library edits the latest design version with a whole-document generic POST, using the stale bundle. That save strips cornerSmoothing (X-14), uses a stale base (X-15), ships old code (X-19) and clears drafts whenever a remote version arrives (M13 mac; JunoMobileWorkspaceViews.swift:2062-2068).

### R-011 · Link governance ships before the preview-origin fix
`P0` · effort L · web, mac, iphone · sharing-governance · depends on X-31, X-32, X-33, 00-AUDIT §12.8
- **Build:** The preview origin (R-012) cannot ship without all of these:
1. Share.suspendedAt, set by a ban or takedown and reversible. ModerationFlag references a share or an artifact and survives account deletion.
2. Admin lookup by token, artifact or user, with Suspend and Restore.
3. A Report link in every public page footer (reason plus optional detail, no sign-in) that creates a ModerationReport. Past a threshold, the page is suspended automatically pending review.
4. Screening at Publish and at Update. A refusal names the reason in one sentence.
5. Rate limits via src/lib/rate-limit.ts:
   - publish and update: 30 per hour;
   - comments: 100 per hour;
   - grants and invites: 50 per day;
   - artifact writes: 600 per hour;
   - unnamed autosaves pruned per plan (X-33).
6. On every plan: link expiry, and 'Unpublish all' in Settings › Shared links.
7. Owner-visible activity in Info: Published v9, Updated to v11, Link expired, Suspended by Juno (with Appeal).
8. Views move to a daily aggregate table off the sync path, excluding bots and owners, with no IP addresses.
A suspended page reads 'This page isn't available', without the owner's name. Fill in the legal notice-and-action contact (owner Q7).
- **Why:** Public links can come back safely, owners see what happened to their links, and abuse can be taken down without deleting accounts.
- **Reference:** - Figma lets organisations turn off public links. Enterprise can force passwords and link expiry, and every link change is logged (help 5726756336791, 360040449533, primary). Comments are capped at 100 per hour (help 360041068574).
- Claude signs short-lived preview tokens and re-checks them on every open, so a revocation takes effect immediately (Admin guide, 2026-09-16, primary). Public viewers see 'Content is user-generated and unverified.' (code docs).
- Public claude.ai artifacts were used as a ClickFix lure (Anvilogic, 2026-02-19, secondary). Pluto Security exfiltrated synthetic credentials in 10 of 85 attempts (reported 2026-08-06, secondary).
- **Juno today:** - A ban does not take shares down. The only takedown is account deletion, which also erases the flag (X-31; share.ts:135-139; moderation.ts:149-199).
- Public bodies are never moderated (X-32).
- Unbounded versions plus forced 'restore' checkpoints allow a DoS (X-33). Share, artifact, design and transaction writes have no rate limits.
- There is no report link, and the legal contact is a placeholder (mentions-legales/page.tsx:41).
- Share.views counts owners and bots and writes into the owner's sync feed (share.ts:157).
- Fixing X-01 re-enables scripted public pages (00-AUDIT §12.8).

### R-012 · Previews run from their own origin under a written network policy
`P0` · effort M · web, mac, iphone · reliability · depends on R-011, X-01, X-13, X-31, X-32
- **Build:** - Serve every preview by src from a separate registrable domain, with one subdomain per artifact version. This covers code artifacts, embeds (R-080) and Play on share pages.
- Access uses a signed token {artifactId, version|'latest', grant, exp ≤ 5 min}, re-validated on every load, so a revocation is simply a token refusal.
- Response CSP:
  - script-src: the CDN allowlist (cdnjs, jsDelivr /npm/, unpkg, Tailwind), with runtimes pinned by version rather than dev builds;
  - style-src and font-src: Google Fonts plus the same CDNs;
  - img-src https: data: blob:, which keeps the photos allowed by §2e;
  - connect-src 'self' only, which is the anti-exfiltration line;
  - form-action, base-uri and object-src 'none';
  - no top-level navigation.
- Mirror the allowlist in the Mac and iPhone WKContentRuleList (X-13).
- Cap each version's page at 16 MiB. Add a Chromium CI test that renders a React artifact under the production headers.
- Ship only after R-011.
Resolution: keep external images. Do not copy Claude's blanket block, which Juno's own audit found makes previews look broken. Control egress with connect-src and screening at publish time.
- **Why:** Every 'build me an app' renders again, the same way on web and native, without turning public links into a phishing channel.
- **Reference:** - Claude serves artifacts from a sandboxed *.claudeusercontent.com (code.claude.com/docs/en/artifacts, primary):
  - scripts come only from cdnjs, unpkg, cdn.tailwindcss.com, code.jquery.com and jsDelivr /npm/;
  - fetch, XHR and WebSocket reach only the page's own origin and Google Fonts;
  - external images are blocked;
  - pages are capped at 16 MiB.
- Claude Design previews use short-lived signed tokens that are re-validated on every open (Admin guide, 2026-09-16, primary).
- **Juno today:** Since fb3a42b5 (2026-08-26), the srcdoc sandbox inherits the app's nonce plus strict-dynamic CSP. That kills React, Tailwind, scripted HTML, Mermaid, the JS/Python console and public share previews (X-01; middleware.ts:55-77; csp.ts:31; sandbox-frame.tsx:918-929). PREMIUM_AUDIT §2e deliberately allows https images and fonts. The Mac blocks every CDN, so the same artifact renders differently there (X-13; NativeArtifactPreview.swift:111-118).

### R-015 · Share dialog: nothing happens on open, Publish is pinned to a version, and Public is visible [part]
`P0` · effort L · web, mac, iphone · sharing-governance · depends on R-004, R-005, R-011, R-012, R-014, X-20, M30, M31, L5
- **Build:** Opening Share writes nothing. The dialog has two sections.
People:
- 'Only you can open this' until R-039 adds invites.
Publish to the web:
- A state line with a globe: regular weight when off, fill when on.
- Before publishing: 'Not published' and a primary 'Publish v9' button.
- After publishing:
  - 'Published · v9 · just now';
  - a read-only mono URL field with Copy (IconSwap copy→check, about 1.5 s);
  - a ⋯ menu: Unpublish · Link expires ▸ (Never/7/30 days) · View as a visitor · Reset link.
- When the head moves on, the line reads 'Published v9 · v11 has changes' and the button becomes 'Update to v11'.
- Update never changes the URL. Unpublish reserves the token, so republishing restores the same URL. Only Reset issues a new one.
- The primary button is never labelled Copy.
Data: Share.versionId pins an immutable version. Backfill it from snapshotAt, and flag rows that may have leaked fold edits.
Making 'public' visible:
- the header button reads 'Shared' with the filled globe;
- '· Published' in the meta line;
- a 12px globe on library tiles;
- Settings › Shared links rows open /a/{id}.
The public page:
- Signed-out viewers see a footer: 'Made by a Juno user · not verified by Juno · Report', plus legal links.
- One stated policy: no sign-in to view.
- Comments stay on the artifact and are never deleted to go public.
- A public DESIGN renders server-side, with an OG image (R-014).
- The publish-time screening verdict shows inline (R-011).
- The first Publish opens a sheet that states what becomes visible, including linked Library images.
- The popover shows bot-filtered numbers, for example '124 views · 81 people · 7 days', with no sparkline.
Native: add ARTIFACT publish, update and unpublish to NativeShareClient, using the same sheet. Revoking a link and changing its scope work on the phone.
Motion: the state line swaps with variants.swap (duration-fast). The URL and 'has changes' rows reveal with Collapse. Publish and Update use Button loading. No looping 'live' dot.
Resolution: public links are frozen, pinned snapshots with an explicit Update (FIA-04, OTH-03), not 'Latest' (CM-12, CA-05). Every public version has to pass publish-time screening (X-32). Live 'latest' links belong to people grants (R-039). This answers owner Q3.
- **Why:** Nothing goes public by accident. The owner always knows what the public sees and decides when it changes.
- **Reference:** - Claude after the merge (help 9547008, 14729249; code docs, primary):
  - audiences: Only you, people with access, the org, anyone with the link;
  - roles by type: Design and Slides can view, comment or edit; Docs can view or edit;
  - 'Always share latest version', or a pinned version.
- Figma Make and Sites have a separate Publish modal. Changes 'only appear after you update the published version', and Unpublish keeps the URL (help 31304586129559, 31242845959703, primary).
- ChatGPT Sites splits 'Save a version' from 'Deploy', with an audience ladder and bot-free visitor counts (learn.chatgpt.com/docs/sites, primary).
- Publish and Copy looking alike causes accidental shares (AI UX Playground, 2026-06-14, secondary).
- **Juno today:** - Opening ShareDialog creates a public link (L5; share-dialog.tsx:78-87).
- The copy says 'as it is now' but reuses an old snapshot (M30; share.ts:91-95).
- Snapshots resolve by timestamp, so design folds leak later edits (M31; share.ts:257-261).
- A shared DESIGN shows JSON (X-20).
- Nothing shows that an artifact is public.
- Native apps can share only chats (NativeShareClient.swift:61-80).

## Phase 1 — First-class artifacts (W6–W9)

### R-004 · Artifacts belong to the account, not to the message that made them
`P0` · effort L · web, mac, iphone · data-model · depends on R-001, X-03, X-04, X-22, X-09, 00-AUDIT §12.1
- **Build:** Schema:
- Artifact.userId: required, backfilled from conversation.userId.
- projectId: inherited from the made-in chat; changeable with Move to project.
- conversationId: nullable, meaning 'made in', with onDelete SetNull.
- deletedAt (R-006).
- Rename messageId to createdInMessageId. It is provenance only and never a delete key.
- One id per (conversation, identifier), permanently. The type is immutable per id: a type change creates a new artifact.
Behaviour:
- Edit and regenerate never delete. A re-emit appends a version to the same id (R-005). Versions made on an abandoned branch are labelled 'From an earlier reply'. The full Try 2 / Use this experience is R-029.
- Deleting a conversation detaches its artifacts. The dialog reads 'N artifacts made here stay in Artifacts', with an unchecked 'Also move them to Recently deleted'.
- Hand-made artifacts get no holder chat. The conversation is created on the first Ask (R-027).
- Info shows one home line: 'Made in <chat>', 'In <Project>' or 'Your artifacts'.
Migration: detach designs from holder chats that have zero user messages, then delete those chats. Native decodes owner, project and deletedAt as optional fields before the server emits them (R-001).
- **Why:** Fixing a typo, pressing Try again or tidying chats never destroys hours of work or a link someone was already sent.
- **Reference:** Claude after the merge: 'everything you make is saved to the Artifacts tab automatically' (help 9487310, 2026-09, primary). Since 2026-08-19, Cowork artifacts are 'saved to your account' (help 14729249, primary). The merge carried chats, projects and artifacts forward (claude.com/blog/cowork-is-now-claude, 2026-09-16, primary). Figma never creates a file without a home. Its late drafts migration (2024-10 to 2025-10) produced 'files disappeared' reports (figma.com/blog/updates-to-how-drafts-work, 2024-06-03, primary; forum, community). Counter-example: Claude's merge dropped conversation branching (help 16761823, primary).
- **Juno today:** - Ownership: Artifact has no userId. conversationId is required and cascades (schema.prisma:1125-1154).
- messageId is a delete key. Editing an earlier message (X-03; messages/[id]/route.ts:38-40) and regenerating (X-04; chat/route.ts:2566-2574) hard-delete artifacts, versions, design checkpoints and share links, and a re-emit gets a new id. A re-emit can also change the type (M11).
- Deleting a chat cascades to designs, files and shares, while the confirmation copy mentions only messages (X-22).
- Hand-started designs create empty holder chats, non-atomically (api/design/route.ts:69-90; M29).
- Native already treats Edit as a non-destructive branch (NativeConversationStore.swift:2304-2315).

### R-005 · Versions are append-only, with a working head, provenance and labels
`P0` · effort L · web, mac, iphone · data-model · depends on R-004, X-33, M10, M31, M60, L6, 00-AUDIT §12.1
- **Build:** - Add a mutable working head row that is not a version. Bursts of hand edits fold into it.
- The head seals into an immutable version after 60 s to 2 min idle, on close, on share or publish, before any Juno turn, before a bulk operation, and on restore.
- Every model apply and every restore appends a version. Restore seals the current head first, so nothing is lost, and never rewinds the revision (M10).
- ArtifactVersion gains messageId, authorKind (model | user | restore | agent), complete, label and note. branchId and parentVersionId are added for R-029.
- Named, published and commented versions are never pruned. Unnamed autosaves are pruned per plan (X-33).
- A failed save keeps its operations queued with Retry and never wipes undo (M60).
- Sync carries authorKind (L6).
The version UI is R-022. Priority is P0: FIG-04 and CD-03 said P0 and FIA-14 and FIG-26 said P1. R-007, R-009, R-013 and R-015 all depend on immutable version ids.
- **Why:** Nothing a person or Juno does is lost, and every version says who made it.
- **Reference:** - Figma saves a checkpoint every 30 min and on disconnect, and collapses checkpoints between named versions. 'Restoring a version doesn't delete any work' (help 360038006754; Make help, primary).
- Claude: every publish is a version with an optional label ('Draft to legal'), and a publish over a newer version is refused (claude-primary-evidence.md).
- Claude Design and Docs shipped with no version history (help 14604416, 16923645, primary). PCWorld: 'The undo wiped everything' (2026-04-17, secondary).
- **Juno today:** - Design checkpoints are rewritten in place within 30 s (store.ts:179-203; operations.ts:511-539). That breaks append-only (JUNO.md:2522) and leaks later edits into share snapshots, which are resolved by timestamp (M31).
- ArtifactVersion records only origin generated|edit|restore: no author, messageId, label or completeness flag. 'generated' is also written for hand-started designs, and sync drops origin (L6).
- Restore rewinds the revision (M10). One failed save wipes undo (M60).
- Versions are unbounded and loaded wholesale (X-33).

### R-006 · Recently deleted: a 30-day trash that restores versions, comments and the same link
`P0` · effort M · web, mac, iphone · reliability · depends on R-004, X-22, X-26
- **Build:** - Soft delete via Artifact.deletedAt. Delete shows a toast: 'Moved to Recently deleted · Undo' (6 s).
- 'Recently deleted' sits at the foot of the Artifacts list and reuses LibraryBrowser's deleted view. Each row shows 'Removed in 27 days' and a Restore action. 'Delete now' is the only permanent action, behind a destructive confirmation.
- While an artifact is in the trash, its public links answer 410 'This page isn't shared any more', its grants are suspended and its comments are hidden. Restore brings back versions, comments, grants and the same share token.
- Purge after 30 days. Account deletion purges immediately, including storage objects (X-26).
- Comments are soft-deleted too: the author gets a 10 s Undo, and the owner can restore.
- Motion: the removed row folds with Collapse (duration-base, ease-in-out) while it fades on duration-exit ease-in. Undo re-inserts it with rise-in. Under reduced motion: fade only.
- Mac: ⌘⌫ moves to the trash with no dialog, undoable through NSUndoManager. iPhone: swipe to delete, with an Undo snackbar.
This item is split from CA-01 and CM-02 (their trash parts).
- **Why:** A mis-click or an over-eager clean-up can be undone, and links already sent work again after a restore.
- **Reference:** Figma Drafts has a Deleted files tab with Restore. Deleting a Figma comment is permanent, even across a version restore (help 14381406380183, 360041547593, primary). Claude Docs has 'no trash', and unpublishing deletes stored data (help 16923645, 9547008, primary).
- **Juno today:** DELETE /api/artifacts/[id] hard-deletes versions and shares (01-AUDIT-WEB §2.1), and the dialog says 'Every version is removed' (artifacts/page.tsx:681-683). The Mac library, the Mac Design screen and the iPhone also delete permanently. /library already has a Recently deleted view with Restore (library-browser.tsx:59; api/library/route.ts:37-171). Account deletion leaves deliverables in storage (X-26).

### R-007 · A version becomes current only when it is complete, and the card says so honestly
`P0` · effort M · web, mac, iphone · reliability · depends on R-005, X-07, X-08, M4, M14, M15, M21
- **Build:** - Persist `complete` on every version. A version stays a non-current draft when the tag was unclosed, the type verifier failed or the turn was stopped.
- One state machine, rendered identically on the card, the panel header and native: writing (vN+1 over vN) · checking · ready · stopped · refused(reason) · render-failed.
- Copy for each state:
  - Writing: 'Writing v4, showing v3', with v3 dimmed to 60%.
  - Checking: 'Checking…', shown only after 500 ms.
  - Stopped: 'Stopped before v5 finished · Keep v4 · Continue v5'. Continue patches the partial version.
  - Refused: 'Juno couldn't save this version: <reason> · Try again'.
- The version stepper shows v5 muted with 'Draft, incomplete', and it opens read-only.
- Check size after DESIGN expansion (X-08).
- Humanise refusals, for example: 'That diagram type (quadrantChart) isn't supported yet. I can redraw it as a flowchart.'
- An expected transition never flashes red. The status bar rises in 4px (duration-base, ease-out-soft) and exits on duration-exit ease-in. Labels swap by cross-fade (duration-fast).
- One aria-live=polite announcement: 'Sign-in screen updated to version 4', or 'Stopped; version 3 is still current'.
- **Why:** Pressing Stop or hitting a plan limit never replaces a working artifact with a broken one labelled 'verified'.
- **Reference:** Truncation at Claude's output limit leaves unclosed tags and a blank preview (Pagelive, secondary). Claude Code refuses bad UTF-8 at publish and gives the line and column (code.claude.com/docs/en/artifacts, primary). Claude's conflict copy: 'Someone saved a newer version. The latest files are reloading with your edits kept' (observed in the shipped Claude desktop app, primary).
- **Juno today:** - A stopped or truncated revision becomes current and is labelled 'Artifact verified'. The saved tag is closed, so it looks complete, and Continue cannot finish it (X-07; message-content.ts:100-115; chat-artifact-verification.ts:60-106).
- On Free's 8,192 output tokens, artifacts over about 30k chars cannot be revised safely.
- DESIGN size is checked before expansion (X-08). Refusals show a fixed sentence (M4).
- Between the closing tag and done, the card flips to a red 'Source unavailable' (M14). 'Writing' shows the old content (M15). Ghost artifacts give misleading errors (M21).

### R-008 · One artifact-kind registry, generated for web, Swift and OpenAPI
`P0` · effort M · web, mac, iphone · merge-core · depends on R-001, X-09, X-14, 00-AUDIT §5
- **Build:** - Write docs/design/ARTIFACT_TYPES.md with one rule: a new type exists only when the document root or the way it is consumed differs.
- Types: Design (a canvas of frames), Deck (a sequence you present), Doc (flowing blocks), Design system (tokens, styles and components), Page (HTML or React).
- Light kinds: Code, Diagram (Mermaid or SVG), Graphic, Image. Each stands alone or is embedded (R-080).
- Draw, Prototype, Motion, Inspect and Present are modes, never types.
- src/lib/artifact-kinds.ts is the single source. It is generated into Swift (like tokens) and into the OpenAPI enum. Each kind records:
  - id, noun and plural;
  - glyph (AppIcons key) and its one data-motion gesture;
  - runtime, editor, streaming renderer and thumbnail strategy;
  - exporters, share roles, comment-anchor kind and capabilities;
  - newLabel;
  - the model's authoring section, which is Juno's SKILL.md. It is loaded only for kinds in play or armed (R-028).
- Lint: no other file maps a type to a glyph or label. A test binds the registry to the Prisma and OpenAPI enums.
- One vocabulary:
  - 'Artifacts' is the place.
  - 'panel' is the side surface. 'Canvas' is used only for the design drawing surface.
  - 'Share' means with people. 'Publish' means to the public web.
  - 'Pin' is the only word for keeping something in the sidebar.
  - Unknown kinds show as 'Artifact' (R-001).
- **Why:** Every surface calls a thing by the same name and mark, and new kinds arrive without breaking installed apps.
- **Reference:** - Claude's typed artifacts are published artifacts with a fixed runtime and a SKILL.md the model reads. There are four core types: Design, Design System, Docs and Slides (claude-primary-evidence.md, 2026-09-23).
- Figma adds a file type only when the document root or the way it is consumed differs. Draw and Motion are modes, and code is a 'material' on the Design canvas (help 'Explore Figma Draw'; figma.com/blog/config-2026-recap, 2026-06-24, primary).
- Claude uses one set of card kinds, each with its own glyph and hover animation (observed in the shipped Claude desktop app, primary).
- **Juno today:** - Strength to keep: runtimeFor lets a type own its editor (artifact-runtime.ts:93-127).
- The web has four type-to-glyph maps and three label vocabularies (artifacts/page.tsx:41-60; artifact-preview.tsx:36; artifact-inline-card.tsx:49; session-outputs.tsx:53-61).
- Swift has three more naming tables, including the raw wire word 'DESIGN' (DesktopArtifactCanvas.swift:153-194; JunoMobileInlineArtifact.swift:144-166).
- 'Canvas' has 7 meanings and 'Document' 5 (00-AUDIT §5).
- All authoring rules sit in one prompt block (system-prompt.ts:238-300).
- REWORK_PLAN Q6, 'Does design survive?', is still unanswered.

### R-014 · Every artifact has a picture: server-rendered thumbnails and posters everywhere
`P0` · effort L · web, mac, iphone · visual-design · depends on R-005, R-012, X-20, X-24, L72, 00-AUDIT §12.7
- **Build:** - Add GET /api/artifacts/{id}/render?v=&frame=&w=, returning SVG, PNG or WebP.
  - Cache by (artifactId, version, frame, width, contentHash).
  - Generate when a version completes, never on each design fold.
  - Use capability-scoped asset URLs, so Library images are not owner-only holes (§12.7).
- Render strategy per kind, recorded in the registry (R-008):
  - DESIGN: renderPageSvg of the cover frame. The cover is the first top-level frame, or the one chosen with 'Set as thumbnail' / 'Restore default' in the frame menu. Render at posterTimeMs, the settled state after on-enter animations, never t=0. The timeline offers 'Use playhead as poster'.
  - HTML and React: a headless 1280×800 capture on the preview origin. Until then, a typed placeholder plus an excerpt.
  - Doc and Markdown: the title plus about 8 typeset lines.
  - Mermaid and SVG: the drawing itself.
  - Code: a highlighted excerpt.
  - Deck: slide 1.
- Where posters are used:
  - inline cards (R-024): a 16:10 poster, or up to 4 frames plus '+N', and no 'Live' label;
  - Artifacts tiles, and 40×28 list-row thumbnails;
  - the switcher and Outputs;
  - share pages: full-resolution SVG with a page switcher, plus 'Play' when interactive;
  - og:image (L72), search, project Sources;
  - Mac Quick Look and native tiles, where static images replace live WKWebViews.
- Every tile also carries the glyph, noun and title, never colour alone.
- A design with interactions or animations shows one quiet Play glyph in the tile corner. On fine pointers, a 400 ms hover plays its first on-enter animation once. Never under reduced motion or on coarse pointers.
- States:
  - Skeleton at the exact aspect, shown only after 500 ms.
  - Failure: a glyph tile reading 'Preview unavailable', plus Open.
  - An image the viewer cannot access draws as a neutral hatched box.
  - A new poster cross-fades over the old one (duration-base, ease-out-soft).
- Fix X-24 first so posters are correct.
- **Why:** People recognise what they made at a glance, in chat, the library, shared links and link previews, instead of reading JSON.
- **Reference:** - Figma removed folder previews on 2026-08-03 and restored them on 2026-09-16, after 'the single most common piece of feedback' (forum 57057; release notes, primary/community).
- Figma thumbnails default to the first page and can be changed with 'Set as thumbnail' (help 360038511413).
- Claude library cards show the name, last-edited date, a view count and a Published tag (ai-toolbox, 2026-09-16, secondary). Claude transcript cards carry a 56×56 thumbnail (observed in the shipped Claude desktop app).
- MCP Apps guidance: skeletons match the final layout, and inline content has no spinners (design-guidelines.md, primary).
- **Juno today:** - Outside its editor, a DESIGN shows raw JSON on the share page, in the inline card (a <pre> labelled 'Live'), on library tiles and in Outputs (X-20; M16; L30; sandbox-frame.tsx:786-803; artifact-inline-card.tsx:181).
- Other tiles show 20 source lines (artifact-preview.tsx:59-129).
- Mac tiles are live WKWebViews, so a responsive page shows its phone layout. Mac designs show only a glyph.
- Link unfurls have no og:image (L72).
- A pure renderer already exists (render.ts:1062 renderPageSvg; export.ts:66 exportSvg), but it ignores container opacity and rotation (X-24).

### R-015 · Share dialog: nothing happens on open, Publish is pinned to a version, and Public is visible [pins]
`P0` · effort L · web, mac, iphone · sharing-governance · depends on R-004, R-005, R-011, R-012, R-014, X-20, M30, M31, L5
- **Build:** Opening Share writes nothing. The dialog has two sections.
People:
- 'Only you can open this' until R-039 adds invites.
Publish to the web:
- A state line with a globe: regular weight when off, fill when on.
- Before publishing: 'Not published' and a primary 'Publish v9' button.
- After publishing:
  - 'Published · v9 · just now';
  - a read-only mono URL field with Copy (IconSwap copy→check, about 1.5 s);
  - a ⋯ menu: Unpublish · Link expires ▸ (Never/7/30 days) · View as a visitor · Reset link.
- When the head moves on, the line reads 'Published v9 · v11 has changes' and the button becomes 'Update to v11'.
- Update never changes the URL. Unpublish reserves the token, so republishing restores the same URL. Only Reset issues a new one.
- The primary button is never labelled Copy.
Data: Share.versionId pins an immutable version. Backfill it from snapshotAt, and flag rows that may have leaked fold edits.
Making 'public' visible:
- the header button reads 'Shared' with the filled globe;
- '· Published' in the meta line;
- a 12px globe on library tiles;
- Settings › Shared links rows open /a/{id}.
The public page:
- Signed-out viewers see a footer: 'Made by a Juno user · not verified by Juno · Report', plus legal links.
- One stated policy: no sign-in to view.
- Comments stay on the artifact and are never deleted to go public.
- A public DESIGN renders server-side, with an OG image (R-014).
- The publish-time screening verdict shows inline (R-011).
- The first Publish opens a sheet that states what becomes visible, including linked Library images.
- The popover shows bot-filtered numbers, for example '124 views · 81 people · 7 days', with no sparkline.
Native: add ARTIFACT publish, update and unpublish to NativeShareClient, using the same sheet. Revoking a link and changing its scope work on the phone.
Motion: the state line swaps with variants.swap (duration-fast). The URL and 'has changes' rows reveal with Collapse. Publish and Update use Button loading. No looping 'live' dot.
Resolution: public links are frozen, pinned snapshots with an explicit Update (FIA-04, OTH-03), not 'Latest' (CM-12, CA-05). Every public version has to pass publish-time screening (X-32). Live 'latest' links belong to people grants (R-039). This answers owner Q3.
- **Why:** Nothing goes public by accident. The owner always knows what the public sees and decides when it changes.
- **Reference:** - Claude after the merge (help 9547008, 14729249; code docs, primary):
  - audiences: Only you, people with access, the org, anyone with the link;
  - roles by type: Design and Slides can view, comment or edit; Docs can view or edit;
  - 'Always share latest version', or a pinned version.
- Figma Make and Sites have a separate Publish modal. Changes 'only appear after you update the published version', and Unpublish keeps the URL (help 31304586129559, 31242845959703, primary).
- ChatGPT Sites splits 'Save a version' from 'Deploy', with an audience ladder and bot-free visitor counts (learn.chatgpt.com/docs/sites, primary).
- Publish and Copy looking alike causes accidental shares (AI UX Playground, 2026-06-14, secondary).
- **Juno today:** - Opening ShareDialog creates a public link (L5; share-dialog.tsx:78-87).
- The copy says 'as it is now' but reuses an old snapshot (M30; share.ts:91-95).
- Snapshots resolve by timestamp, so design folds leak later edits (M31; share.ts:257-261).
- A shared DESIGN shows JSON (X-20).
- Nothing shows that an artifact is public.
- Native apps can share only chats (NativeShareClient.swift:61-80).

### R-047 · Craft rules, a deterministic design lint and a golden eval set
`P1` · effort M · web, mac, iphone · ai-editing · depends on R-009, M41, 00-AUDIT §12.9
- **Build:** 1. Craft rules: add a craft section to the design authoring rules in the registry (R-008). It covers the rules above, plus real names and placeholders such as [Your price].
2. Deterministic lint: after each apply, run a lint on layout.ts and render.ts. It checks:
   - text overflow and clipping;
   - overlapping siblings;
   - contrast below 4.5:1;
   - targets below 44pt on phone frames;
   - raw colours and off-scale spacing when a design system is installed;
   - placeholder text;
   - detached instances.
3. Findings:
   - Blocking findings trigger one silent repair turn, made of operations.
   - Other findings appear as a quiet '2 suggestions' chip: a number, never a meter.
   - Each fix is an operation, and 'Fix all' is one proposal.
   - Inspect mode and /check show the findings.
4. Send a render with every ask.
5. Golden eval: before the merge ships, build a set of about 40 design prompts × models, scored for validity, lint findings and a visual rubric.
Resolution: neither Claude's 'never verify' rule nor a costly screenshot verifier on every turn. A deterministic lint costs almost nothing, and it is free on every plan, not only Enterprise.
- **Why:** First drafts are legible, accessible and on-brand without the user having to catch the basics.
- **Reference:** - Claude's Design-type craft rules: no lorem ipsum or fake stats, 1-3 typefaces, 0-2 accents, targets of at least 44px, contrast of 4.5:1 (claude-primary-evidence.md, primary).
- Since June 2026, Claude 'checks its output against your design system, and makes corrections' (claude.com, primary).
- Figma Check designs (2026-06-04, Org/Ent plans only) flags hard-coded values, WCAG contrast failures and detached components, with a one-click token swap (release notes, primary).
- Reviewers see a 'recognizable aesthetic' in Claude Design output (Salesdorado, 2026-06-09, secondary).
- **Juno today:** - The DESIGN prompt has grammar rules but no visual craft rules (system-prompt.ts:285-292).
- Ask Juno cannot see the design (M41).
- Verification is structural only.
- No real outputs are evaluated (scripts/eval-juno.ts; 01-AUDIT-WEB §9).

### R-064 · Scale without a lock: size checks, an asset store, and limits that explain themselves [part]
`P1` · effort L · web, mac, iphone · performance · depends on R-005, X-08, X-09, X-30, X-33, M12, M60, L24
- **Build:** Limits:
- Check the size after expansion (X-08).
- At 80%, the header shows a quiet note: 'Large design · 164k of 200k'. Numbers only, no meter. It offers 'Move images to asset storage' and 'Split page into a new design'.
- At 100%, never lock the design. Refuse only the save that would exceed the limit, and say why. Edits stay local, and undo and split still work.
Assets: an external, content-addressed asset store with capability-scoped URLs. Images are downscaled on the client to twice their placed size. Paste and drop work.
Loading: pages and version bodies load on demand. By default, fetch metadata plus the current body only (X-30).
Rendering: a per-node SVG memo keyed by node revision. Playback updates only the animated nodes (L24).
Telemetry: document size, op latency p95 and render ms per frame (R-020).
- **Why:** Big designs keep working, and every limit comes with a way forward.
- **Reference:** - Figma allows 2 GB per tab. It shows a red alert at 90% that can't be dismissed, and locks the file at 100%, which then needs recovery mode. Pages load on demand (help 360040528173, primary).
- Figma has a WebGPU renderer with a WebGL fallback (blog, 2025-09-18).
- Users report Figma using 12 GB of RAM (forum, 2025-11-16).
- **Juno today:** - Each document is capped at 200k characters, and images up to 96 KB are inlined as data URLs (use-design-document.ts:560-608).
- Compact bodies expand 5-11× with no second size check. After that, every edit is refused (X-08) and the native library goes blank (X-09).
- Every read ships every version (M12, X-30).
- Playback re-renders the whole page SVG (L24).
- One failed save wipes undo (M60).

### R-067 · Your work stays yours: the account export includes artifacts, and a downgrade never removes access
`P1` · effort S · web, mac, iphone · export-handoff · depends on R-004, X-22, X-23, X-25, X-26, M9
- **Build:** Account export includes every artifact with its versions:
- designs as JSON, per-frame PNG and SVG, and the handoff bundle;
- docs and decks as source plus Office and PDF;
- pages as source.
Downgrades:
- A plan downgrade turns artifacts read-only but never removes viewing or exporting.
- Quotas may limit creating new artifacts, never access to existing ones.
- Settings › Data and the plan page say: 'Your artifacts stay yours after a downgrade'.
Deletion: deleting a conversation detaches its artifacts (R-004), and the dialog names anything else that would go.
- **Why:** People can invest in Juno designs without fearing lock-in.
- **Reference:** - HN, 'Tell HN: Don't use Claude Design, lost access to my projects after unsubscribing' (HN 48128003, 2026-05-13, 302 points, community). Anthropic promised downloads would stay possible.
- Claude Docs export to Word, PDF, Markdown and Google Docs (help 16923645).
- **Juno today:** - The account data export and import skip every Artifact and ArtifactVersion (M9; api/account/export/route.ts:29-60).
- Deleting a chat cascades to its designs and shares (X-22).
- Deliverables are left in storage when an account is deleted (X-26).
- Office deliverables cannot be reached on the web (X-25).

## Phase 2 — One surface, and the merge for the owner: First light (W10–W11)

### R-013 · New versions land in place: adopt, don't remount
`P0` · effort M · web, mac, iphone · reliability · depends on R-005, R-012, X-02, X-11, X-12, X-15, M14, M15
- **Build:** - Every host (web panel, full window, Mac dock, iPhone) mounts by artifactId. The version is data, never a React key or a SwiftUI identity.
- DESIGN: editor.adoptDocument(next).
  - Keep the selection (ids still present), viewport, rails and scroll.
  - Keep undo when the base matches. Otherwise insert a labelled boundary ('Undo Juno's change too?').
  - Rebase queued local operations through the op layer. If that fails, show 'Juno updated this while you were editing · Review changes'. Never replace silently.
- HTML, React, SVG and Mermaid:
  - Render the new document into a hidden second iframe.
  - On juno:status 'ready', or after 1.5 s, fade it in over the old one (duration-fast, ease-out-soft) and unmount the old one. Carry scroll across with a juno:scroll bridge message.
  - A failed version keeps the last good frame under 'v8 didn't render · Show error · Try fixing' (R-035).
- Markdown and code: replace the text in place, with scroll anchored to the nearest heading or line.
- Viewing an older version is a read-only state of the same mount: 'Viewing v2 · Restore as v6 · Back to latest'.
- When a new version lands, it gets the change reveal (R-034), and the version number rolls with RollingNumber.
- Reduced motion keeps the 120 ms fade (ICONS_AND_MOTION §2.2 rule 10) and drops travel.
- Mac and iPhone receive an 'adopt' bridge message, with SwiftUI .opacity on JunoMotion.fast. The dock looks up the row by (conversationID, identifier), which fixes X-11 and X-12.
- **Why:** The first edit no longer breaks a design. Revisions appear where the user is looking without flicker, and zoom, selection and undo survive.
- **Reference:** Claude cross-fades frame content over 120 ms when a framed page swaps, and swaps instantly under reduced motion (observed in the shipped Claude desktop app, primary). Hosted artifacts 'refresh in place' (claude.com/blog/artifacts-in-claude-code, 2026-06-18, primary). Cursor Design Mode hot-reloads as agents finish (cursor.com/blog/design-mode, 2026-06-05, primary).
- **Juno today:** Preview, markdown and design containers are keyed by selectedVersion (canvas-panel.tsx:1237,1260,1284). For designs that key causes X-02: the editor remounts on a synthetic empty version, shows 'This design can't be opened' and loses undo. The Mac dock keeps showing the previous revision (X-12), and the Mac editor never adopts newer versions (X-15). Apply swaps the whole scene in one frame, and nothing marks that a new version landed (01-AUDIT-WEB §5.1).

### R-016 · One ArtifactSurface keyed by artifact id at /a/{id}: panel, full window and picture-in-picture
`P0` · effort L · web, mac, iphone · merge-core · depends on R-004, R-013, R-014, X-02, X-11, X-12, X-17, X-18, X-19, X-20, M23, M28, L27, 00-AUDIT §12.3, 00-AUDIT §12.10
- **Build:** Build one ArtifactSurface, keyed by artifact id and sized by its container (PREMIUM rule 11). It renders in four sizes:
1. Inline card (R-024).
2. Panel docked beside the conversation, when the content column is at least 64rem. Auto-open rules are in R-033.
3. Full window at /a/{id}, edge to edge:
   - The conversation stays reachable, never hidden (MCP Apps rule): either as a collapsible left column, or as the composer overlaid bottom-centre (at most 680px) with the last reply as a two-line snippet.
   - Panel and full window share one mount. Expand calls replaceState(/a/{id}?from=chat). Esc or 'Back to chat' collapses it, keeping undo, selection and zoom.
   - Below 50rem, this is the only open size.
4. Picture-in-picture, only for live things (a playing prototype, a presented deck, a running job, a streaming generation):
   - a 320×200 tile at the top right of the transcript when the user scrolls away mid-run;
   - a click restores the panel;
   - it docks back into its card when the run ends.
Header: one 44px row with 16px gutters:
- title (inline rename), with the type in muted ink;
- version stepper (R-022);
- artifact switcher when the conversation made more than one (it lists what Outputs lists);
- mode control (R-026);
- Share;
- ⋯ menu: Open in full window (⌘⇧↩), View in conversation, Duplicate, Export ▸, Move to trash;
- Expand and Close.
Every entry point opens /a/{id}: search, library, share, projects, Outputs, notifications and native deep links. /design/{id} and /chat?artifact= redirect (00-AUDIT §12.10). Designs get Ask Juno, zoom and the full inspector in every host.
States:
- Loading: frame outlines at the artboard sizes.
- Unavailable: the reason plus 'Open source'. Never JSON by default.
- A newer version arrived: adopt it in place (R-013).
Mac: the dock, library document view, Design screen and detached window are one row-backed view at different widths.
- Look the row up by (conversationID, identifier). Fall back to the tag body only until sync lands.
- ⌘-click on a card opens its own restorable window.
- Esc closes the dock. Details are in R-068.
iPhone: a sheet with medium and large detents and the same header.
Focus: a user-initiated open focuses the panel heading, and fullscreen traps focus (M23). The full keyboard contract is R-063.
- **Why:** A design, page or doc is the same object with the same tools wherever it is opened: chat, library, link or another device.
- **Reference:** - Every Claude artifact is a hosted page at one private-by-default URL, claude.ai/artifact/{id}. Docs open in the desktop side panel, and one link opens on a phone (claude-primary-evidence.md; help 9487310; blog 2026-09-16, primary).
- Claude's panel header has Switch artifact, Pop out, Expand and Full screen (observed in the shipped Claude desktop app).
- Claude Science's menu has Open, Open beside session, View in context, Versions and Copy link. Cmd-click opens full screen (claude.com/docs/claude-science/artifacts, primary).
- ChatGPT Apps SDK: inline cards have at most 2 actions, fullscreen keeps the composer overlaid, and PiP pins to the top (developers.openai.com/apps-sdk, primary).
- In Figma, Design, Draw, Dev and Motion are modes of one file (help, primary).
- **Juno today:** - There is no canonical route. Code types open at /chat/{c}?artifact={identifier}, which breaks when the artifact is re-created. ?v= and ?id= are ignored (M28, L27).
- One DESIGN has four editors with two save semantics (00-AUDIT §4.4). The Canvas editor remounts on the first save (X-02). /design/[id] has Ask Juno but no link back to the chat (design-workspace.tsx:176-181).
- Fullscreen is aria-modal but has no focus trap (M23).
- The Mac dock is built from the tag body. It has no versions, save or share, and cannot open chat-made designs (X-11, X-12; DesktopArtifactCanvas.swift:33-54). The hosted editor is stale, unstyled and hides its inspector (X-17 to X-19).

### R-017 · The design editor is sized by its container: docked rails, sheets and a contextual bar
`P0` · effort M · web, mac, iphone · editor · depends on R-016, M17, M58, X-18
- **Build:** A ResizeObserver (container query) on the editor root picks the layout:
- 1040px and wider:
  - layers (240) and inspector (280) are docked and resizable from 200 to 400;
  - widths are saved in account prefs, not localStorage.
- 640 to 1039px:
  - the inspector stays docked;
  - Layers becomes an overlay drawer opened from a header button (ease-drawer, duration-base in, 160 ms ease-in exit, no scrim, Esc closes).
- Under 640px:
  - canvas only;
  - a floating contextual bar sits above the selection (overlay-glass, 36px tall, 32px targets, 44px on coarse pointers). Its controls depend on the selection:
    - text: family, size, weight, colour, alignment;
    - auto-layout frame: direction, gap, padding, alignment;
    - shape: fill, stroke, radius;
    - always: Ask · Comment · ⋯, where ⋯ opens the full inspector as a bottom sheet with 40% and 90% detents;
  - the bar pops in 120 ms after the selection settles, never animates during a drag and hides during pan and zoom.
Rules:
- Never open a rail on selection.
- A closed inspector's button shows the selected layer's glyph.
- Every rail is always reachable. ⌘\ toggles both rails.
- Collapsing a docked rail keeps the viewport centre fixed.
- A docked collapse is instant, with no width tween. Drawers and sheets travel on transform. Reduced motion fades only.
Mac: pass surface='window' now as a stopgap (X-18), then adopt the container logic.
Resolution: keep Juno's full layers panel and precise fields. Do not simplify to Claude's contextual-only editing (CD-15 do-not-copy).
- **Why:** A design opened beside the chat keeps its layers and properties, laptops keep the inspector, and phones get a usable canvas.
- **Reference:** - Figma's UI3 beta used floating panels that 'cramped the canvas'. They were reverted to fixed, resizable panels (figma.com/blog/our-approach-to-designing-ui3, 2024-10-01, primary).
- Minimize UI opens the properties panel on its own, and it catches clicks (forum 2024-09-25, community).
- Claude Design's inspector is contextual: font options for text, layout options on a grid (Builder.io, 2026-04-29, secondary). Critics call it 'Squarespace with AI attached', with no layers (UX Pilot, 2026-05-04, secondary).
- **Juno today:** - Embedded rails hide by viewport width (`hidden md:flex` / `lg:flex`) with no way back, and take about 464px of a 449px panel (M17; design-editor.tsx:549-550).
- The window surface never collapses, and the toolbar needs about 865px, so the canvas is 0px wide on a phone (M58).
- The Mac inspector is hidden at the default 1240pt window (X-18; host/main.tsx:65-71).
- Mac rail widths are not persisted.

### R-018 · One Artifacts index with type filters; Design becomes a filter and a New action
`P0` · effort L · web, mac, iphone · ia-navigation · depends on R-004, R-006, R-008, R-014, R-016, X-19, X-21, M26, M27, M28, L34, 00-AUDIT §12.2, 00-AUDIT §12.10
- **Build:** Sidebar:
- One row, Artifacts. JunoDesign stays as the Design glyph. Drop the Design row.
- Record the decision in OPEN_DECISIONS: it amends TWO_PRODUCTS §3 and answers owner Q2.
/artifacts header:
- the page name, server search (debounced 200 ms, over titles and current text), a New split button (R-027) and a list/grid toggle;
- type chips with counts: All · Designs · Docs · Decks · Pages · Diagrams · Code · Images · From tasks. Deliverables appear by reference (option A of §12.1);
- a scope menu: Everything · Recents · Pinned · Shared with me (R-039) · In project ▸;
- sort: Last opened · Last edited · Created · Name, remembered per scope on the server.
Reuse the /library machinery:
- cursor paging (50 per page), bulk select, Recently deleted (R-006);
- ArtifactOpen (throttled to once a minute) for Recents;
- ArtifactPin for the sidebar Pinned fold (R-075).
Rows and tiles:
- Rows: a 40×28 thumbnail, the title and one trailing signal (updated time, or 'Public').
- Grid tiles: a 4:3 poster, the title and one meta line. The kind word appears only under All.
- Row menu: Open · Open in conversation · Pin · Rename · Duplicate · Share… · Move to project ▸ · Delete.
Redirects and rollout:
- /design → 308 to /artifacts?type=design, with the presets pinned at the top for 60 days.
- /design/{id} → /a/{id}.
- Keep the Design row for one release as a pointer with 'Designs now live in Artifacts', then remove it.
- Ship web, Mac and iPhone in one window, gated on the editor bundle (X-19).
Fixes:
- The project page reads the same API with ?projectId (X-21).
- Code's Artifacts row stays in Code (M27).
- ⌘K lists titles plus New design, New doc and New deck (L34).
Native:
- Mac folds the Design screen into Artifacts, keeping .design decodable and routing it to the filter. Do not ship the glass branch's Design row.
- iPhone gets the same scopes and filters.
Motion: rows deal in with rise-in (stagger capped at 8) on first load only. Filter changes cross-fade (duration-fast). The view toggle uses IconSwap.
Priority: P0. CA-07, FIG-02 and FIG-06 said P0; CM-15 and FIA-06 said P1. The merge cannot ship with Design as a separate destination, and the redirects must exist from day one.
Naming: 'Artifacts' is the working name. If the owner keeps the REWORK_PLAN fold, the same index becomes Library with a Made-by-Juno filter (OTH-10).
- **Why:** One place answers 'where is the thing Juno made' on every device, and it remembers the last view.
- **Reference:** - After the merge, Claude has one Artifacts tab with templates (help 9487310, primary) and 'one Recents list' (help 16761823).
- On HN: 'designer is always there, I never need to bring up artifacts' (saratogacx, HN 49729412, 2026-09-16, community).
- Figma's file browser has Recents, Drafts, Starred and Trash, plus ⌘/ search with type filters and sorts (help 14381406380183, 4422774037271, primary). Folder users complained that the sort resets on every visit (forum 57057, 2026-08).
- ChatGPT has a Library plus a separate Sites library (help snippet; releases.sh, 2026-09-09).
- **Juno today:** Juno has seven partial 'what Juno made' paths (00-AUDIT §4.5):
- /artifacts: client-side search over at most 200 rows, with no sort, paging or trash (M26);
- /design: a client-side filter;
- /library: files only, but with the right machinery (server search, 4 sorts, cursor paging, bulk actions, trash);
- Outputs and the Work stage;
- project Sources, which always shows 0 (X-21);
- search, where ?v= is ignored (M28).
The sidebar has both Artifacts and Design rows (app-sidebar.tsx:1068-1125; TWO_PRODUCTS §3), and the Mac glass branch adds a fourth Design row. Code's Artifacts row switches the product to Chat (M27). ⌘K has no New design and no artifact titles (L34). REWORK_PLAN's fold into Library is unresolved (owner Q2).

### R-021 · Motion hygiene: make artifact surfaces obey Juno's own motion law
`P1` · effort M · web, mac · motion · depends on L15, L16, L17, L18, L19, L16 (mac), L17 (mac), X-17, X-19
- **Build:** Web:
- Entrances play on mount only, using a hasEntered ref as the thought dock's animateDock does.
- Exits get fade-only motion-reduce variants.
- Every conditional banner, toolbar and card exits through Collapse or AnimatePresence (duration-exit, ease-in).
- Transitions are off during resize drags.
- Add the .pressable reset to the unlayered reduced-motion block.
- Replace animate-pulse with status-glow.
Mac:
- canvasEnter uses the drawer curve (0.32, 0.72, 0, 1) at Duration.base.
- Insertion is .opacity only under Reduce Motion.
- Keep disablesAnimations on during a divider drag.
- Add .junoPress and a hover tint to tiles and rows.
- Cross-fade from library to document.
- Deal the Recent list with a stagger capped at 8.
- Rebuild the bundle CSS so the pop and tooltip recipes ship (X-17).
Guard: a source-reading test next to tests/design-host-motion-tokens.test.ts asserting that every dock or panel exit has a reduced-motion branch, and that no artifact surface uses outExpo.
- **Why:** Panels feel settled rather than jumpy, and people who asked for less motion get it.
- **Reference:** Claude turns transitions off while resizing. Rail bodies enter after the panel and leave at once, and reduced motion turns scrims and smooth scrolling off (observed in the shipped Claude desktop app, primary). Juno's own ICONS_AND_MOTION law is the reference.
- **Juno today:** Web:
- The Canvas replays its entrance after every resize (L15).
- Dock exits slide under reduced motion (L16).
- The save bar, conflict and failure banners, selection toolbar, proposal and Tune cards, Ask Juno error, fullscreen exit and deleted rows all vanish in one frame (01-AUDIT-WEB §5.1).
- The live dot uses the off-ladder animate-pulse (L17). The stagger is dead (L18). Raw .pressable still scales under reduced motion (L19).
Mac:
- The dock inserts with .offset even under Reduce Motion (L16 mac; DesktopArtifactCanvas.swift:433-439), on outExpo (L17 mac; JunoDesignTokens.swift:343).
- 10 .plain buttons give no press feedback.
- Library to document is a hard cut, and the Recent list is dumped rather than dealt.
- The bundle CSS lacks the pop and tooltip recipes (X-17).

### R-022 · Version stepper: see any earlier version, compare it, restore it and find the turn that made it
`P1` · effort L · web, mac, iphone · editor · depends on R-005, R-013, R-014, R-016, M28, X-24
- **Build:** Stepper:
- '‹ v7 ›' in the header. Proposed keys: ⌥[ and ⌥].
- Tooltip: 'Version 7 of 9 · by Juno · 2 min ago'.
Versions popover (click the stepper; pops in from the trigger):
- Each row shows an author mark (You, Juno plus model, Restore, or a collaborator), an optional label, the time, a server thumbnail and one trailing signal.
- A 'From this message' link scrolls the transcript and flashes that turn (bg-accent, duration-emphasis).
- Named versions are pinned. Unnamed autosaves fold under '12 autosaves'.
- Row menu: Name… · Copy link · Compare · Duplicate as new artifact · Restore.
Viewing an older version:
- It renders read-only in the same renderer, with no remount (R-013).
- A bar reads 'Viewing v5 · Restore as v10 · Compare · Back to latest'.
- The switch is a cross-fade on duration-fast.
Compare:
- Code and docs: a line diff, or an inline redline.
- HTML and SVG: side by side at 900px and wider; otherwise a wipe slider (44/32px handle, transform only, following the pointer 1:1 with no easing).
- DESIGN:
  - split view with linked pan and zoom, or an onion-skin overlay with an opacity slider;
  - hold B to flip (cross-fade, duration-fast);
  - a change list from the transaction log, marked Added (success), Edited (warning) and Removed (destructive). Clicking an entry frames the node in both cameras.
- When unseen versions exist, the header shows 'Changes since you last viewed · Compare'.
Also:
- Honour ?v= everywhere (M28).
- Restore always appends a new version.
- Mac: the same stepper in the dock and windows, plus View › Previous/Next Version.
Priority is P1 (CD-03 said P0). The P0 part, immutable versions and their fields, is R-005; this item is the UI on top.
- **Why:** People can see what earlier states looked like, compare them, and undo any AI change at any time.
- **Reference:** - Claude Science has a version stepper and a diff toggle, and chat links point to the version that existed at the time (claude.com/docs/claude-science/artifacts, primary).
- Cowork can compare and restore versions (help 14729249).
- Figma's compare view is side by side, or an overlay with an opacity slider, and the layer tree marks layers Edited, Added or Deleted (help 15023193382935, primary).
- Figma Make: previewing does not create a version; versions can be favourited and renamed; 'Restoring a version doesn't delete any work' (help, re-fetched 2026-09-23).
- Claude Design and Docs shipped without history (help 14604416, 16923645).
- **Juno today:** - The Canvas rail diffs text only and cannot render an older version. A DESIGN diff is one line of minified JSON (canvas-panel.tsx:374-459, 407-410).
- Every card shows the latest version (L9).
- The /design window and the Mac Design screen have no history. The editor's History tab is the in-memory undo list (design-editor.tsx:723).
- The Mac library already renders older versions read-only, with a glass 'Viewing vN · Restore' badge and a diff computed off the main thread (DesktopArtifactsScreen.swift:1016-1141). Reuse it.

### R-023 · One live card per artifact; earlier turns keep a version receipt
`P1` · effort M · web, mac, iphone · merge-core · depends on R-022, R-005, X-03, X-04
- **Build:** - The newest card for an artifact is the full card (R-024).
- Earlier turns that created or revised it fold to a one-line receipt pinned to their version: glyph · 'Updated Sign-in screen' · 'v3 · latest is v5' · 'Open v3'. Open v3 opens the panel pinned to v3.
- Receipts are text on the panel, with one trailing signal and no fill until hover (PREMIUM rules 3 and 6).
- When a new version lands, the previous full card folds with Collapse (duration-base, ease-in-out) and the new one rises in. Under reduced motion, rows snap and the fade stays.
- A card whose artifact was revised by a regenerated answer reads 'v4 · updated' instead of vanishing.
- **Why:** The transcript reads as the history of one object and stays light, and each turn still shows what it changed.
- **Reference:** Claude hides non-last edit cards with opacity-0 (observed in the shipped Claude desktop app), which leaves dead space. Claude Science points each chat link at the version that existed at the time (primary).
- **Juno today:** Every card for an identifier shows the latest version, never the one its own turn produced (L9; message-item.tsx:1370-1375). Each revision card also mounts its own sandbox (M16, M24).

### R-024 · Transcript card: a picture, at most two actions, and a live preview only when needed
`P1` · effort M · web, mac, iphone · visual-design · depends on R-014, R-008, R-016, M24, L17
- **Build:** Anatomy:
- Header: the registry glyph, the title, 'Design · v3', and one trailing Open.
- Body: a static poster (R-014) at its own aspect ratio, in an @container box capped at 320-360px.
- At most two actions: Open (primary) plus one verb for the type: Play for designs and decks, Copy for code, Download for files.
- Code and Console move into the panel. Console kinds never auto-run.
Live preview: a sandbox mounts only when the card is the latest version, at least 50% visible, and the panel is closed. It unmounts when off-screen.
Interaction:
- Hover: the fill cross-fades to bg-accent (duration-fast), and the glyph plays its one data-motion gesture. No lift, shadow or scale.
- Press is tonal. The focus ring is drawn on the card.
- Segments are 32px for fine pointers and 44px for coarse.
The morph from card to panel is R-070.
Mac: the same anatomy in SwiftUI, with .junoPress, a hover tint and the cached PNG. iPhone: tapping opens the sheet.
- **Why:** Long chats stay fast and calm, and a preview runs live only when it matters.
- **Reference:** MCP Apps guidelines for inline cards: height fits the content, no nested scroll, at most 2 actions, no menus. Closing fullscreen returns to the same scroll position (design-guidelines.md, primary). Claude's card is at most 520px wide, with a 56×56 thumbnail and the focus ring drawn on the card (observed in the shipped Claude desktop app).
- **Juno today:** - The web card is a live mini-surface with Preview, Code and Console at h-[min(44vh,360px)]. That size comes from the viewport, which breaks PREMIUM rule 11 (artifact-inline-card.tsx:378).
- Its segments are h-6, under the 32px minimum.
- Sandboxes mount eagerly, and consoles auto-run on every render (M24).
- The live dot is off the motion ladder (L17).
- The Canvas opens only on click (chat-view.tsx:897-993).
- The Mac card has no preview.

### R-025 · Canonical links: deep links to a frame, version or comment, plus universal links, Handoff and quick-create
`P1` · effort M · web, mac, iphone · ia-navigation · depends on R-016, R-015, M28, L27, L57
- **Build:** URL grammar: /a/{id}[/play]?v=&node=&page=&comment=&mode=view|edit|inspect|motion.
- Every surface emits it. When a model reply names a frame, it becomes a chip that opens with node=.
Copy link: to a frame (frame menu), to a comment (thread menu) and to a version (version row).
Focus view: double-click a frame title.
- One frame, centred on the page colour.
- ←/→ step through frames, showing 'n of N'.
- A temporary width slider and a Light/Dark switch; neither writes to the document.
- Entering is a camera move (R-070) while the other frames fade out over duration-base.
Quick create:
- /new/design?preset=phone|tablet|desktop|square, /new/doc, /new/deck and /new/page.
- ⌘K lists the same actions.
Native:
- apple-app-site-association covers /a/* and /share/*.
- iPhone: openArtifact(id, version, node, comment). Unknown kinds fall back to the web.
- Mac: links open in the panel or in a document window.
- Open artifacts publish an NSUserActivity (com.juno.artifact, webpageURL) for Handoff.
- iPhone Spotlight indexes artifact titles.
Access: people without access see Request access (R-039). Published snapshots stay at /share/{token}.
- **Why:** A link sent in Messages opens the same object in the app on any device, at the exact frame, version or comment.
- **Reference:** - Figma's Copy link points at the selected frame, and there are links to a comment or a version. Dev Mode has a focus view with 'Copy link to focus view' (help 360040531773, 23919923330455, primary).
- figma.new and figjam.new create files directly (help 360038511153).
- Figma Mirror disconnects and freezes (App Store reviews, community).
- **Juno today:** - Search ?v= and project ?id= are ignored (M28, L27).
- Frame titles cannot be clicked, although a code comment says they can (L57; design-canvas.tsx:1058).
- iPhone launch requests have no artifact case (JunoMobileIntents.swift:19-26), and neither app declares associated domains.
- The Mac has no NSUserActivity or Handoff, and detached windows are not restored.

### R-026 · Editor modes in one segmented control: Design, Prototype, Motion and Inspect
`P1` · effort M · web, mac, iphone · editor · depends on R-016, R-017, X-18, M17
- **Build:** One segmented control in the surface header. The modes for each type come from the registry:
- DESIGN: Design · Prototype · Motion · Inspect, plus ▶ Play (R-057).
- Page: View · Code · Console.
- Doc: Read · Edit.
Viewers and commenters land in View. Editors land in Design or Edit.
What each DESIGN mode shows:
- Design: tools and the inspector.
- Prototype: the interactions rail and Play.
- Motion: the timeline docked open, plus the keyframe inspector.
- Inspect: a read-only canvas with Alt-hover measurement, and the code, tokens and assets rail (R-082).
Shortcuts:
- ⇧D toggles Inspect (Figma muscle memory) and ⇧M toggles Motion. Prototype is chosen by click.
- ⇧1 to ⇧4 stay free because ⇧0, ⇧1 and ⇧2 are Figma's zoom keys (R-061).
- The mode is remembered per artifact and appears in the URL.
Behaviour:
- A mode switch swaps rail contents only. It never remounts or moves the canvas.
- The thumb slides on transform (spring.standard). Rail content cross-fades (duration-fast). Tool sets swap with IconSwapSet. Reduced motion fades only.
Resolution (FPM anti-pattern): modes change emphasis and rails only. They never change the coordinate origin or lock component properties, and the timeline dock can open from any mode.
- **Why:** One editor changes shape for the job (designing, wiring, animating or handing off) without losing anything.
- **Reference:** In Figma, Draw and Motion are toolbar toggles on one file, and Dev Mode is 'the same file with different panels' (Shift+D) (help; Config 2026 recap, primary). Figma users click Motion mode by accident and find the split between Design and Motion state confusing. Position is measured from the centre in Motion mode (forum 2026-06-30; help 41352588622615).
- **Juno today:** - The right rail has Design and Prototype tabs (design-editor.tsx:836-849).
- Motion is a separate bottom Collapse, opened by a toolbar button (:645, :811).
- History is a left-rail tab.
- Exports sit in a menu, and there is no inspect view.
- Rails can hide with no way back (M17).

### R-027 · New creates the artifact first; the conversation starts with the first Ask
`P1` · effort M · web, mac, iphone · merge-core · depends on R-004, R-008, R-016, R-018, M29, L34
- **Build:** New menu:
- A '+ New' split button in the Artifacts toolbar and in ⌘K:
  - Design ▸ Phone 390×844 · Tablet 834×1194 · Desktop 1440×900 · Square 1080×1080 · Portrait 1080×1350 · Custom…;
  - Doc, Deck, Page;
  - 'From a template…'.
- Templates are Juno starters plus the user's own 'Save as template' artifacts. A row of 6 appears only when the list is empty, or under New.
Creating:
- One atomic POST /api/artifacts {kind, preset, projectId?}. No conversation is created.
- The user lands on /a/{id} full-window, with the editor and a collapsed composer strip: 'Ask Juno about this design…'.
- The first message creates the made-in conversation (titled after the artifact) and docks the transcript. The URL stays /a/{id}.
- Artifacts started inside a project inherit it.
Platforms:
- Mac: the same New menu, plus a New Design command.
- iPhone: + offers Doc and Design.
Motion: the panel keeps ease-drawer. The empty canvas fades in on duration-base. The composer strip rises in once the editor reports ready.
- **Why:** Start from the thing itself, with Juno one sentence away, and no more empty 'Untitled design' chats.
- **Reference:** - Figma's + Create offers Design, FigJam, Slides, Sites, Make and Buzz. New files land in Drafts or in the folder being viewed (help 360038511153, primary).
- Claude has templates in the Artifacts tab, and Design 'now works inside your conversations' (help 9487310; blog 2026-09-16).
- Share → 'Duplicate as Template' (getpushtoprod, 2026-04-19, secondary).
- **Juno today:** - Hand creation is limited to four design presets.
- Each POST /api/design creates an empty holder chat plus the artifact, non-atomically (api/design/route.ts:69-90; M29).
- New on /artifacts always uses Phone (artifacts/page.tsx:279).
- ⌘K has no New design (L34), and no starter chip mentions design.

### R-063 · Keyboard and screen-reader contract for the panel and the canvas [surface]
`P1` · effort M · web, mac · editor · depends on R-061, M22, M23, L58, L60, L66, E6 (mac)
- **Build:** Panel:
- role=region, with aria-label '{Kind}: {title}'.
- Opening it by hand focuses the heading. Auto-open does not move focus.
- Esc closes nested layers first, then the panel. Focus returns to the card's Open button or the composer.
- Fullscreen traps focus, and Esc exits it.
- F6 cycles transcript → panel → composer. Inside the editor it cycles toolbar → layers → canvas → inspector → timeline.
- ⌥[ and ⌥] step versions. ⌘⇧A ('Ask about selection') reaches the selection toolbar (M22).
- All of these appear in the shortcuts sheet.
Canvas:
- The global focus-visible ring, as an inset variant (L66).
- A polite live region announces the selection, for example 'Rectangle Card bg, 320 by 180, in frame Hero'.
- A keyboard marquee on ⌥Space: the arrows move it, ⇧ moves ×10, and Enter selects.
- Rail tabs become role=tablist.
- Disabled buttons are wrapped so their tooltips still show (L60).
- Frame titles use muted-foreground at 4.5:1 or better (L58).
- The layers tree stays the primary screen-reader view.
- An optional 'Show property labels' setting.
Mac:
- Esc closes the dock, and @FocusState returns focus to the card.
- View menu: Show/Hide Canvas, Previous/Next Version, Expand.
- A keyboard alternative for the dock's resize handle.
- **Why:** Keyboard and screen-reader users can open, use and leave made things without getting lost (WCAG 2.1.1, 2.4.3).
- **Reference:** - Claude's panel is a region labelled 'Artifact panel: {title}'. Escape closes it unless a popover is open, and focus returns to the trigger or the composer (observed in the shipped Claude desktop app, primary).
- Figma keyboard-only use: ⌥Space draws a keyboard marquee, Tab moves through children, F6 goes to the toolbar, and there is a screen-reader preference (help 360040328653, primary).
- **Juno today:** - There is no focus management. Opening below the split drops focus to the body; fullscreen is aria-modal with no focus trap; closing returns focus nowhere (M23; canvas-panel.tsx:786-788).
- The Ask/Modify toolbar is unreachable by keyboard (M22).
- Esc closes the thought dock but not the Canvas.
- The canvas is role=application with its outline removed (L66). Rail tabs are aria-pressed buttons.
- Disabled keys never show tooltips (L60). Keyframe diamonds cannot be operated (E6).
- Frame titles are about 2.1:1 in dark mode (L58).
- On Mac, Esc doesn't close the dock, and there are no menu commands.

### R-070 · One motion spec for the merged surface: card-to-panel morph, camera, version landing and exits
`P2` · effort M · web, mac, iphone · motion · depends on R-021, R-016, R-024, L15
- **Build:** Everything uses the token ladder, and only transform and opacity move.
Card to panel or window:
- The poster morphs into the content frame as a shared element, via framer layoutId or startViewTransition with view-transition-name artifact-<id> (spring.layout 360ms, bounce 0, or duration-slow on ease-drawer).
- The inner content cross-fades (duration-fast), because the thumbnail and the live view differ.
- The chrome fades in 60-80ms later, and the transcript reflows on spring.standard.
- On close, the panel collapses back into the card if the card is on screen. Otherwise it exits to its edge (ease-drawer, duration-exit). The scroll position is restored.
- A resize drag never replays an entrance.
Other transitions:
- Auto-dock, which the user did not trigger: a 24px move plus a fade on duration-slow ease-drawer. It does not take focus.
- Panel to full window: layout grows on spring.emphasized while the transcript fades on duration-exit.
- Programmatic camera moves (fit, selection, comment, change, search hit, follow): zoom interpolates in log space and pan linearly, on duration-base ease-in-out. Beyond 3 viewport widths it zooms out, pans and zooms in, capped at duration-slow. Any wheel, pinch or drag cancels the move. Direct gestures stay 1:1.
- Selection outlines fade in on duration-press. Hover outlines are instant.
- Version landing: the version pill swaps with IconSwap, the poster cross-fades on duration-emphasis, and changes are revealed as in R-034.
- Every exit animates, on duration-exit ease-in.
Reduced motion:
- Every morph becomes a 160ms cross-fade.
- The camera cuts, with a 120ms cross-fade. Fades keep their timing.
Native: the Mac uses matchedGeometryEffect on JunoMotion's layout spring, and the iPhone uses navigationTransition(.zoom). Guard against regressions with offscreen snapshot tests.
- **Why:** People can see where things come from and what changed, and nothing jumps.
- **Reference:** - No source documents the durations Claude uses for its panel (research gap; the spec below is inferred).
- Claude's image preview morphs using View Transitions (.35s cubic-bezier(.32,.72,0,1); observed in the shipped Claude desktop app).
- MCP Apps: 'Inline cards expand to fullscreen with a smooth transition', and closing returns to the same scroll position (primary).
- Figma documents little of its UI motion: 'Speed is a feature'.
- **Juno today:** - The Canvas docks with a 16px slide and no shared element (L15), and nothing morphs from the card into the panel.
- zoomTo sets the viewport in one frame (design-canvas.tsx:258-272).
- Nothing marks the arrival of a new version.
- On Mac, the library to document transition is a hard cut, and canvasEnter uses outExpo.

### R-071 · One visual language for 'Juno is working'
`P2` · effort M · web, mac, iphone · motion · depends on L17, L18, L38, L65
- **Build:** Four primitives, on web and Swift, all in Juno tokens:
- LiveMark: one dot breathing brightness .9→1.1 and scale .92→1 on --ease-breathe over 2.4s. It is the only 'Juno is making this' mark, used on the card, the panel header, the sidebar row and the Mac dock.
- StatusLabel: text announced once, with a copy ladder keyed to elapsed time and real progress. For example 'Writing Sign-in screen…', then after 20s 'Still writing — 2 of 3 screens'. No percentages.
- DelayedSkeleton: shows nothing for 500ms, then a skeleton shaped like the content that fades in on duration-fast. One per surface, never a skeleton followed by a spinner.
- SavedTick: an IconSwap check that reverts after 2.5s on duration-base.
All loops stop under reduced motion, and LiveMark then holds at full brightness. Remove the gen-sweep bar and the Mac double spinner.
Resolution: StatusLabel breathes instead of using Claude's travelling shimmer band (PREMIUM rule 14). There is no second 'AI colour'.
- **Why:** 'Juno is working' looks the same everywhere. Fast loads never flash, and slow ones say honestly what is happening.
- **Reference:** Observed in the shipped Claude desktop app (primary):
- a shimmer text clone (3s);
- a 1.8s dot pulse;
- a status breathe from scale .86 to 1 over 3s;
- a copy ladder, 'Thinking…' then 'Still thinking…';
- skeletons that reveal after 0.5s;
- a 'saved' check that fades after 2.5s.
- **Juno today:** - The card's live dot uses animate-pulse, while the Canvas header uses status-glow (L17).
- The card has a gen-sweep bar.
- The Mac shows a thinking matrix, and a double spinner: a native ProgressView over 'Opening design…'.
- There is no skeleton delay. Skeleton, then spinner, then editor flash in turn (L65). The /artifacts skeleton shifts (L38), and the stagger is dead (L18).

### R-072 · A Motion setting that covers streaming and made things
`P2` · effort M · web, mac, iphone · motion · depends on R-021
- **Build:** - Add 'Motion: System | Reduced' under Text size, stored per device, with the description 'Reduce animation in streaming replies, the panel and designs.'
- Web: the pre-hydration theme script sets html[data-motion=reduced]. The motion-safe and motion-reduce variants also match that attribute, and MotionConfig switches to 'always'.
- Native: JunoMotion reads either the override or accessibilityReduceMotion.
- Scope: all product motion, the stream-tail mask, and autoplay of authored design motion in thumbnails and cards. An explicit Play still plays.
- Keep Juno's tiered policy: fades keep their timing.
- **Why:** People sensitive to motion can calm Juno without changing their whole OS.
- **Reference:** Claude has Settings › Appearance › Motion: 'System | Reduced', described as 'Reduce animation in streaming responses and other interface elements' (observed in the shipped Claude desktop app, primary).
- **Juno today:** - Appearance offers only Theme, Accent and Text size (general.tsx:219-300).
- Motion follows the OS only, via MotionConfig reducedMotion='user' (app-shell.tsx:461).
- The stream-tail mask is removed only by the media query (globals.css:3100-3106).

### R-079 · 'Made here': one small index of everything a conversation produced [the list]
`P2` · effort M · web, mac, iphone · ia-navigation · depends on R-078, R-029, X-25
- **Build:** - Rename it 'Made here', one noun, and keep it a popover from the conversation header.
- At the top, five create tiles: Doc, Deck, Design, Page, Diagram. A tile only prefills an editable composer prompt with the type armed (R-028). Nothing runs without Send.
- Below, outputs grouped by type, with counts and several per type. Include WorkArtifact deliverables and images, which fixes the dead pointer in X-25.
- A generating row reads 'Writing', with a percentage only when one is real. The row is clickable, and the rest stay usable.
- Row ⋯ menu: Open, Turn into…, Revise with settings (a small form per type that produces a sibling branch), Share, Delete.
- Mac: the Liquid Glass Outputs popover adopts this. iPhone: a sheet from the title.
- Motion: pops in from its trigger, rows rise in (stagger capped at 8), and a new output enters via layout with a one-shot bg-selected fade.
- **Why:** Everything a chat produced, deliverables included, sits in one small place, and the next output is one tap away.
- **Reference:** NotebookLM Studio puts creation tiles on top and several outputs per type below, and one output can be used while another generates (blog.google, 2025-07-29, primary). Its tiles start generating as soon as they are tapped.
- **Juno today:** - session-outputs.tsx is a good index that needs no fetch, and it has 'Used in this session'. But its labels disagree with /artifacts (00-AUDIT §5).
- Deliverables are missing from it, even though the stage points users there (X-25).
- It has no way to create anything and no generating state.

## Phase 3 (+ native N2) — Juno edits what is there (W12–W17)

### R-009 · The model edits the current version with targeted changes, and people's edits win
`P0` · effort XL · web, mac, iphone · ai-editing · depends on R-005, R-007, X-05, X-06, X-08, X-10, M40, M41, M42, 00-AUDIT §12.9
- **Build:** 1. Context digest for every artifact that is open or was touched in the last N turns. It contains:
   - id, type, current version and its author;
   - the body when it fits, otherwise an id-bearing digest: the DESIGN node tree with node, variable and component ids (selection-context.ts), Doc block ids, or Deck slide titles;
   - a motion digest: animations, tracks and interaction edges.
2. Three verbs replace 'output the complete updated content':
   - create;
   - patch, for code, markdown and docs, with at most 12 exact, unique anchors;
   - design operations against the current revision, for DESIGN and DECK.
   Rewrite only when the user asks or the patch limits are exceeded. The compact grammar becomes creation-only (operations on an empty document), so images, effects, components, tokens and motion become expressible.
3. Agent-shaped scene operations: query {selector}, tree {nodeId, depth} and setMany {selector|ids, patch}. The server expands them into validated, invertible updateNode operations. Never model-written JavaScript.
4. Every model write is a compare-and-swap on the version the turn read. On a 409, re-read and retry once. If a block or node that a human wrote was touched, keep the human's version and say so: 'You edited the pricing table while I worked, so I kept your version and applied the rest.'
5. Proposal guard. If a proposal removes animations, tracks or interactions that the request did not mention, the review shows 'Also removes 2 animations and 3 interactions' with 'Keep them' selected. deleteNodes also removes interactions and tracks that point at deleted nodes (M42).
6. Never stream a rewrite as delete-then-retype. Stage it and swap it in (R-013).
7. Golden tests: a design with 3 animations and 5 interactions, revised with 'make the title bigger', keeps all 8. Add these to the §12.9 eval set. Refusals name the layer, not the schema path.
- **Why:** 'Make the title bigger' changes the title and nothing else, and a person's own edits survive every follow-up.
- **Reference:** - Claude moved from full regeneration to create, update and rewrite, with exact-match updates and a 3-4x shorter wait (Rui Quintino, 2024-11-02, community).
- The Claude Design type re-reads the current files and changes only what was asked. On a conflict it re-reads, redoes the change once, then tells the user. The Docs connector guards blocks by content hash, so a person's words win (claude-primary-evidence.md; Docs topic.editing, first-hand 2026-09-23, primary).
- Figma's agent uses node.query(selector).set() and screenshots (plugin-api-standalone.d.ts L10110-10162, primary).
- Anti-pattern: a UI that 'slowly deletes every line of code before rewriting it' (BigGo, 2025-07-16, secondary).
- **Juno today:** - A turn sees only 24-31 message texts (route.ts:1852-1861; context-assembly.ts:18-44), and the prompt demands 'output the complete updated content' (system-prompt.ts:238-300). Hand edits are therefore reverted (X-05).
- A DESIGN revision rebuilds the document from the 7-node compact grammar. It drops components, variables, effects, motion, interactions and comments (X-06; authoring.ts:161-203). Image nodes always refuse the whole design (X-10).
- Unscoped Ask Juno sees only top-level ids (M40) and no image (M41).
- Strengths to reuse: Canvas Modify's exact-anchor patch with compare-and-swap (artifact-edit.ts; artifacts-store.ts:103-127), and Ask Juno's validated operations (ai.ts).

### R-010 · One AI edit channel: every Juno change is a proposal in the artifact's conversation
`P0` · effort L · web, mac, iphone · ai-editing · depends on R-009, M41, M46, M47, M59, 00-AUDIT §12.4
- **Build:** - The conversation composer is the only prompt. With a design open and a selection, it shows a removable selection chip (R-031).
- The on-canvas prompt (⌘↵ or the existing pill) keeps its anchored overlay-glass form but posts a turn into the artifact's conversation. That conversation is created lazily on the first ask (R-027).
- Retire /api/design/[id]/edit as a separate experience; keep its validation. Never route design generation to the flash model.
- Each AI edit appears in the transcript as an edit card with:
  - a summary ('Tightened the intro, added Risks');
  - a size ('+12 −3 lines' or '12 layers changed');
  - Apply and Discard while reviewing, then Undo after Apply.
  Each applied change is one undo entry ('Undo Juno: <summary>') and one version with authorKind model.
- When to review:
  - Apply directly while Juno drafts a new artifact.
  - Switch to review once the user has edited the artifact by hand, with a one-time inline note.
  - Also review when a change exceeds 60 operations or touches more than one frame. Big changes open in Compare (R-029). Hunk-level review is R-030.
- While a proposal is pending, the committed document is read-only for the canvas, layers and shortcuts (M46). Apply reports failure honestly (M47).
- Up to 3 parallel prompts on disjoint scopes. Overlapping scopes queue and say so.
- Actions that leave Juno stay on the existing risk-classed approval card.
- Mac and iPhone use bridge 'proposal' and 'resolveProposal' channels (R-060).
Resolution: FIG-03's travelling shimmer band is replaced by R-034's breathing outline (PREMIUM rule 14).
- **Why:** There is one place to ask, see what Juno changed and undo it, on every host.
- **Reference:** - The Figma agent (beta 2026-05-20, open beta 2026-06-23) replaced First Draft. Prompts start from any layer or with Cmd/Ctrl+Enter, and undo lives in the chat (help 'Work with the Figma agent'; blog 2026-05-20, primary).
- Claude: 'Claude Design now works inside your conversations' (blog 2026-09-16, primary).
- Cowork's permission control is Manual (Allow/Deny) or Auto (help 13345190, primary).
- **Juno today:** Juno has two AI channels that cannot see each other (01-AUDIT-WEB §4.6):
- Chat re-emit applies immediately.
- Ask Juno is single-turn and blocks for up to 120 s. It does not stream, cannot see the design, and is never written to the transcript. For designs started at /design it runs on qwen3.8-flash (M41; edit/route.ts:22,150-155). It is missing from the Canvas host and the Mac (host/main.tsx:65-71).
During review, shortcuts and Layers write to the hidden document (M46). Apply reports success when it failed (M47).

### R-015 · Share dialog: nothing happens on open, Publish is pinned to a version, and Public is visible
`P0` · effort L · web, mac, iphone · sharing-governance · depends on R-004, R-005, R-011, R-012, R-014, X-20, M30, M31, L5
- **Build:** Opening Share writes nothing. The dialog has two sections.
People:
- 'Only you can open this' until R-039 adds invites.
Publish to the web:
- A state line with a globe: regular weight when off, fill when on.
- Before publishing: 'Not published' and a primary 'Publish v9' button.
- After publishing:
  - 'Published · v9 · just now';
  - a read-only mono URL field with Copy (IconSwap copy→check, about 1.5 s);
  - a ⋯ menu: Unpublish · Link expires ▸ (Never/7/30 days) · View as a visitor · Reset link.
- When the head moves on, the line reads 'Published v9 · v11 has changes' and the button becomes 'Update to v11'.
- Update never changes the URL. Unpublish reserves the token, so republishing restores the same URL. Only Reset issues a new one.
- The primary button is never labelled Copy.
Data: Share.versionId pins an immutable version. Backfill it from snapshotAt, and flag rows that may have leaked fold edits.
Making 'public' visible:
- the header button reads 'Shared' with the filled globe;
- '· Published' in the meta line;
- a 12px globe on library tiles;
- Settings › Shared links rows open /a/{id}.
The public page:
- Signed-out viewers see a footer: 'Made by a Juno user · not verified by Juno · Report', plus legal links.
- One stated policy: no sign-in to view.
- Comments stay on the artifact and are never deleted to go public.
- A public DESIGN renders server-side, with an OG image (R-014).
- The publish-time screening verdict shows inline (R-011).
- The first Publish opens a sheet that states what becomes visible, including linked Library images.
- The popover shows bot-filtered numbers, for example '124 views · 81 people · 7 days', with no sparkline.
Native: add ARTIFACT publish, update and unpublish to NativeShareClient, using the same sheet. Revoking a link and changing its scope work on the phone.
Motion: the state line swaps with variants.swap (duration-fast). The URL and 'has changes' rows reveal with Collapse. Publish and Update use Button loading. No looping 'live' dot.
Resolution: public links are frozen, pinned snapshots with an explicit Update (FIA-04, OTH-03), not 'Latest' (CM-12, CA-05). Every public version has to pass publish-time screening (X-32). Live 'latest' links belong to people grants (R-039). This answers owner Q3.
- **Why:** Nothing goes public by accident. The owner always knows what the public sees and decides when it changes.
- **Reference:** - Claude after the merge (help 9547008, 14729249; code docs, primary):
  - audiences: Only you, people with access, the org, anyone with the link;
  - roles by type: Design and Slides can view, comment or edit; Docs can view or edit;
  - 'Always share latest version', or a pinned version.
- Figma Make and Sites have a separate Publish modal. Changes 'only appear after you update the published version', and Unpublish keeps the URL (help 31304586129559, 31242845959703, primary).
- ChatGPT Sites splits 'Save a version' from 'Deploy', with an audience ladder and bot-free visitor counts (learn.chatgpt.com/docs/sites, primary).
- Publish and Copy looking alike causes accidental shares (AI UX Playground, 2026-06-14, secondary).
- **Juno today:** - Opening ShareDialog creates a public link (L5; share-dialog.tsx:78-87).
- The copy says 'as it is now' but reuses an old snapshot (M30; share.ts:91-95).
- Snapshots resolve by timestamp, so design folds leak later edits (M31; share.ts:257-261).
- A shared DESIGN shows JSON (X-20).
- Nothing shows that an artifact is public.
- Native apps can share only chats (NativeShareClient.swift:61-80).

### R-028 · An optional 'Make…' choice in the composer, and routing the user can see
`P1` · effort S · web, mac, iphone · ia-navigation · depends on R-008, R-016, M7
- **Build:** Arming a type:
- '+ › Make…' is a submenu with registry glyphs: Design (Auto, Phone, Tablet, Desktop, Square), Doc, Deck, Page, Diagram.
- Picking one arms a removable pill beside +, for example 'Design · Phone ×', exactly like Deep research. The pill clears after send.
- /design, /doc, /deck and /page arm the same pill. /artifact stays untyped.
- The pill sends artifactIntent/outputType. The server forces the type and loads that kind's authoring section and skeleton path (R-033).
- With no pill, the model decides as it does today.
- On send with a type armed, the panel opens with a typed placeholder, for example an empty 390×844 outline captioned 'Juno is designing…', revealed after 500 ms.
Visible routing:
- The card and the panel always lead with the type word ('Deck · Q3 pipeline'), and the status reads 'Making a deck…'.
- The overflow menu offers 'Make this a page instead'.
- The prose does not narrate any of this.
Model tier: DESIGN, DECK and REACT turns never go to the cheapest tier.
Settings › Capabilities: per-type switches (Designs, Docs, Decks) for people who want chat-only answers.
Remove the Mac's no-op Canvas toggle.
- **Why:** People who know they want a deck get one in one press. Everyone else types as usual and can see what Juno chose.
- **Reference:** - Claude kept explicit ways to pick an output after it automated routing: 'select Output in the message box', Output › Docs or Design, and the /docs and /design commands (help 9487310, 16923645, 14604416, primary).
- HN users want to 'know they are being routed', and a guaranteed chat-only mode (HN 49729412, 2026-09-16, community).
- Fortune worried about the cost of routing simple asks to heavy paths (2026-09-16, secondary).
- **Juno today:** - The model alone decides, and is told never to mention Canvas (system-prompt.ts:238-247).
- /artifact only pre-fills 'Create an artifact that ' (composer.tsx:1593-1600).
- Auto routes build and design prompts to the cheapest model (M7; auto-model.ts:61-66).
- FLAT_UI §4 limits the controls row. The + menu already has an 'armed for this message' group, where the deep-research pill lives (composer-plus-menu.tsx:30-50).
- The Mac ships a Canvas toggle that does nothing.
- TWO_PRODUCTS §2.2 removed 'Do this as a task'.

### R-029 · Branches: Try again and Edit make siblings, and big AI changes open in Compare
`P1` · effort L · web, mac, iphone · data-model · depends on R-004, R-005, R-022
- **Build:** Data: ArtifactVersion.branchId (null means main) and parentVersionId. currentVersion stays main's head, and there is still one artifact id per identifier.
When branches are created:
- Try again, Switch model or More concise on a turn that made or revised an artifact: the output becomes a sibling on 'Try 2' of the same artifact. The card gets a ‹ 2/2 › pager, like message versions, and 'Use this' makes it main.
- Editing an earlier message branches from the version that existed at that message. Later versions stay.
- AI changes above the review thresholds (more than 12 hunks, more than 60 operations, or several pages) land on a branch 'Juno: <summary>' and open in Compare.
Compare:
- two live renders side by side, a Swap control and the change list;
- actions: 'Use this' (merge, origin merge) · 'Keep both' (split into '… (alt)') · 'Discard'.
Platforms: Mac gets a branch picker in History; iPhone gets the pager plus 'Use this version'.
Words: 'Try 2', 'Use this' and 'Keep both'. Never branch, PR or merge.
Motion: paging shifts content ±12px with a cross-fade (duration-base, ease-out-soft). Compare narrows main with framer layout (spring.layout), never a width tween.
Priority: P1. The P0 guarantee, never deleting, is in R-004.
- **Why:** Trying again never costs what the user already had, and big AI changes are judged side by side first.
- **Reference:** - Framer 3.0 (2026-06-16) added isolated branches, compare and merge: 'Iterate safely by moving AI agent edits to a branch' (framer.com/blog/framer-3; framer.com/agents, primary).
- v0 offers an optional branch per chat (vercel.com/blog/introducing-the-new-v0, 2026-02-03).
- NotebookLM regenerates 'as a new deck' (2026-03-20).
- HN asked Claude for tree branching after Claude dropped branching (HN 49729412).
- **Juno today:** - Versions are linear.
- Regenerate hard-deletes the artifact and re-creates it with a new id (X-04).
- Editing an earlier message hard-deletes later artifacts (X-03).
- Native already branches on Edit (NativeConversationStore.swift:2304-2398).
- Design checkpoints fold in place.

### R-031 · Juno knows what the user is looking at and has selected, and shows it
`P1` · effort M · web, mac, iphone · ai-editing · depends on R-009, R-010, R-012, R-016, M22, M40, M41
- **Build:** View context:
- Every send from a conversation with a panel open attaches a typed view context: {artifactId, version, view (preview|code|design|play), tab/page/slide, selection (node ids | text range | element path), visible rect, dirty, pendingDraftVersion}.
- The server resolves 'this', 'here' and 'the button' against it and scopes patch and operation targets (R-009).
Visible chip:
- One removable chip above the composer, for example 'Looking at: Onboarding · v4 · 2 layers' or 'Sign-in button · +2'.
- With nothing selected, the placeholder reads 'Ask about Sign-in screen, or select layers'.
- Unsaved hand edits autosave first, or Juno asks 'Save your edits first?'.
Selection packet for pages:
- cssPath and xpath; tag, role and aria-label; truncated attributes; the rect in px and %;
- a subset of computed styles;
- the React component's displayName and JSON-safe props, at most 2 KB (via __reactFiber$ on the dev UMD runtime);
- a JPEG crop of at most 1024px, for multimodal models.
Selection packet for DESIGN: node ids and names, resolved post-layout boxes and styles, and a renderPageSvg crop.
Budget and privacy:
- At most 6 KB of JSON and one image per element, for at most 4 elements.
- Never include form field values.
- A 'What Juno sees' disclosure lists exactly what is sent.
Platforms: Mac and iPhone read the bridge selection and send the same shape, taking crops with WKWebView.takeSnapshot.
Keyboard: the chip and the Ask toolbar are reachable with Tab, then Enter (M22).
Resolution: Claude's view context is invisible to the user; Juno shows the chip.
- **Why:** 'Make this blue' acts on what the user is pointing at, and the user can see what Juno will look at.
- **Reference:** - The Claude Docs viewer publishes an <artifact-view-context> with mode, tab, node, selected block ids, dirty, rev and edit count. Claude Design passes 'this artboard' and the selection (claude-primary-evidence.md, primary).
- Cursor Design Mode sends the xpath, component attributes, computed styles, fiber props and a screenshot (cursor.com/blog/design-mode, 2026-06-05, primary).
- v0 attaches an element screenshot (v0.app/docs/design-mode).
- **Juno today:** - Only the Canvas Modify path loads the stored version (route.ts:1450-1484).
- An ArtifactQuote carries only the selector, an outerHTML snippet and the text (quote-context.ts:24-41).
- Design selection context feeds only Ask Juno, with includeImage:false (edit/route.ts:155; M41). With nothing selected it sees only top-level ids (M40).
- The Mac bridge reports the selection, and nothing reads it (DesktopDesignEditorHost.swift:53,164-165).
- The Ask/Modify toolbar cannot be reached by keyboard (M22).

### R-032 · One agent tool contract that every kind implements, shared with Juno Code and external agents
`P1` · effort L · web, mac, iphone · ai-editing · depends on R-008, R-009, R-014
- **Build:** The contract. Every registry kind implements:
- artifact_read(id, version?, scope): the source, or an id-bearing digest;
- artifact_render(id, version?, nodeId?): a PNG, via R-014;
- artifact_propose(id, baseVersion, ops|patch): a validated proposal, not a write;
- artifact_create(kind, spec);
- artifact_search(query, kind?);
- for DESIGN, also query, tree and setMany (R-009).
Consumers: chat, the on-canvas prompt, comments sent to Juno, Juno Code, and an external MCP server for Claude Code and Cursor, with the same auth and grants.
Guarantees:
- A conformance test fails CI when a kind lacks any verb.
- Publish the DesignDocument JSON Schema (contracts/design/design-document.v1.schema.json).
- Exports carry the source.
- All five write paths collapse into propose, then apply.
- **Why:** Juno and the user's other tools can read, see and change every kind of thing they make.
- **Reference:** Figma's MCP has three tool families (developers.figma.com tools doc; albertsikkema.com 2026-01-23):
- read: get_design_context, get_metadata, get_screenshot, get_variable_defs, get_motion_context;
- write: use_figma, create_new_file;
- design system: search_design_system, get_libraries, Code Connect.
Their reach is uneven: create_new_file cannot make Buzz, Sites or Make files, and the REST API rejects Make files.
- **Juno today:** - DESIGN_TOOLS advertises a render tool that nothing uses (ai.ts:256-270).
- Ask Juno never sees a render (M41), and chat never sees the current version (X-05).
- The Juno Code handoff bundle has no consumer.
- Five separate write paths lead into one table (00-AUDIT §4.6).

### R-033 · Stream into the panel: open at birth, plan first, fill in place, steer mid-run
`P1` · effort L · web, mac, iphone · merge-core · depends on R-007, R-009, R-012, R-013, R-016, X-07, M14, M15
- **Build:** Auto-open:
- Open on the first artifact tag of a turn when the split is at least 50rem, no other panel is open, and the user hasn't closed the panel in this conversation during the last 3 turns.
- Never take focus. Announce with aria-live: 'Juno opened <title>'.
- Below 50rem, the card is the live view, with an Open button.
Plan first (Doc, Deck, Design and long Markdown):
- The model emits the title plus sections, slides or boards, each with a one-line intent.
- The server creates the row (status drafting) and sends artifact.skeleton.
- Pending blocks show their intent in muted ink above a skeleton shaped like the content: paragraph lines, a table grid, a 16:9 slide or a phone frame.
Fill, by kind:
- Docs: tokens stream into the active block (batched per animation frame), and each finished block is committed as an operation.
- Code: streams under .stream-tail, auto-following until the user scrolls.
- HTML and SVG: re-render in the hidden second iframe (R-013) at structural checkpoints (a closed top-level element, at most every 600 ms), cross-fading only when the render succeeds. Scripts are held to the end.
- DESIGN: operations stream as NDJSON and are validated per batch (at most 10 operations or 250 ms) into a preview layer. Frames appear first, as hairline outlines at their final size, then their children. The camera fits once, when the first frame lands, and never chases the stream.
Stop or token cap:
- Finished work stays as a non-current draft: 'Stopped · Keep what's here · Discard', or 'Not written yet · Continue'. It never becomes current (X-07).
- When a turn would exceed the output budget, build the frames or sections across calls instead of truncating.
Steering: while streaming, the placeholder reads 'Steer this design…' and Send becomes Steer. Steers queue in steering.above and apply at the next section boundary.
Chat: at most one quiet line per section.
Motion:
- The skeleton deals in with rise-in, stagger capped at 8.
- Nodes and blocks enter with opacity 0→1 on duration-fast ease-out-soft and a 4px rise, staggered 30 ms, at most 8 per batch. No blur, no scale.
- Later blocks slide down with framer layout (spring.standard).
- Auto-scroll only at the live edge; otherwise show a 'Writing: Risks ↓' chip.
- Reduced motion: opacity only.
Resolution: the lenses disagreed on entrance timing (duration-fast vs duration-base) and effect (scale vs rise). This uses duration-fast with a 4px rise, which every lens allowed.
- **Why:** The plan appears within seconds and can be corrected early. No blank panel, no wall of text, no false errors.
- **Reference:** - The Claude Docs connector's first call creates a skeleton (title, byline, one pending block per section) that opens on screen. It then fills one section per call, because 'a call streams nothing' (topic.index, first-hand 2026-09-23, primary).
- Claude's visualize contract: style first, scripts last, and no hidden sections during streaming, because gradients and blur flash during DOM diffs (read_me, primary).
- Google Stitch 'streams its work straight to the canvas' and lets you 'steer iterations before the final product is done' (blog.google, 2026-05-19, primary).
- Claude Design generation takes minutes (Builder.io 2026-04-29; UX Pilot 2026-05-04, secondary).
- **Juno today:** - The Canvas never opens by itself (chat-view.tsx:897-993) and shows nothing until done (canvas-panel.tsx:313-315; route.ts:3016).
- The card shows the old source under 'Writing' (M15), then a red 'Source unavailable' (M14).
- Designs arrive as one compact JSON blob, expanded only after the tag closes (authoring.ts).
- A stop saves the cut-off version as current (X-07).
- The composer already has a steering contract with an 'above' slot (composer.tsx:155-198).

### R-034 · Juno's presence and change reveal: where it is working, and exactly what it changed
`P1` · effort M · web, mac, iphone · motion · depends on R-010, R-013, M46, M47
- **Build:** While Juno works:
- The target scope gets a 1.5px accent/60% outline. Its brightness breathes 0.92↔1.0 over 1.6-1.8 s (--ease-breathe), and only while the work is live.
- A chip sits at the scope's top-left (overlay-glass, caption): the Juno mark, the current step ('Laying out 3 cards') and Stop. It pops in from its origin (duration-fast).
- Clicking the chip scrolls to the turn.
- A 'working' operation declares the scope, and 'done' clears it.
Proposal:
- The chip swaps (IconSwap) to '3 changes · Review'.
- Modified nodes get a 1.5px accent outline and an 8% fill.
- Added nodes rise in (4px, duration-base, ease-spring, 30 ms stagger, at most 8).
- Deleted nodes stay as dashed ghosts at 40% until Apply.
- Hold B, or 'Show before', to cross-fade to the previous render (duration-fast).
- Layers rows of changed nodes carry a dot for the session.
- Code and Markdown get gutter marks. HTML previews outline changed elements through the inspector bridge.
Apply:
- The old render cross-fades out over the new one (duration-base).
- Halos hold about 800 ms, then fade over duration-emphasis. Deleted ghosts fade on duration-exit ease-in.
- The version chip swaps v8→v9 (IconSwap).
- Off-screen changes show an edge chip, '4 changes ↓', that frames them (duration-slow, ease-in-out). Any wheel or drag cancels the camera move.
- Camera, selection and Play state are kept. The scene is patched, never remounted.
Reject: the outlines and chip leave with pop-out.
Reduced motion: a static outline with no loop and no rise, and the camera jumps. Fades keep their timing.
Resolution: FIG-03's travelling 6% shimmer band is replaced by the breathing outline, because PREMIUM rule 14 bans borrowed loading sweeps. The accent is allowed here because Juno acting is a state (FLAT_UI §2.4).
- **Why:** People see where Juno is working and exactly what it changed, and can keep working elsewhere meanwhile.
- **Reference:** - Figma: 'Each active prompt shows an animated loading indicator on the canvas', and prompts run in parallel (help 'Work with the Figma agent', primary). node.placeholder is 'the in-progress shimmer overlay' (plugin d.ts L10150-10153).
- Paper's agents must call finish_working_on_nodes (local plugin).
- Claude pulses a comment's highlight while Claude works on it (1.6 s ease-in-out; a static underline under reduced motion; observed in the shipped Claude desktop app).
- Juno reserves --dur-emphasis (560 ms) for changes the user did not cause (globals.css).
- **Juno today:** - A proposal preview or Apply swaps the whole scene in one frame, and zoom-to-fit jumps.
- Nothing marks which layers are being worked on, or that a version landed (01-AUDIT-WEB §5.1).
- Design operations already name the node ids they touch (operations.ts).

### R-035 · Render check and 'Fix with Juno' on every broken preview
`P1` · effort M · web, mac, iphone · reliability · depends on R-007, R-009, R-012, M4
- **Build:** Automatic check:
- After every generation or revision, the sandbox or WKWebView reports status, uncaught errors, failed loads and blank renders (an empty body, or a root under 4px tall).
- On failure, the status word cross-fades to 'Checking', and Juno gets one automatic, free repair turn (R-036) with the errors attached. The repair lands only if its result renders.
- The repair is never unbounded and always visible.
When repair fails, or on later errors:
- An inline strip, not a modal: 'This page hit an error · Fix with Juno · Details' (rise-in 4px, duration-base). The card's error state gets the same action.
- Fix with Juno adds a queued ask (R-038) with the version, the first 3 errors and their stacks, the last 20 console lines and the failing line, then focuses the composer. It runs on the patch path, and the transcript shows a chip such as 'Fix: TypeError at App.tsx:12'.
- Second action: 'Show last working version (v4)'.
Decks with more than 8 slides: an optional per-slide render check for overflow and overlap.
Refusals: humanise them everywhere. The Mac shows a glass banner: 'Juno couldn't apply that change: <reason>'.
Log render failures to telemetry (R-020).
- **Why:** A broken preview is one click from repaired, and Juno stops handing back blank artifacts labelled 'verified'.
- **Reference:** - Claude's 'Try fixing with Claude' copies the error into a new message, and success isn't guaranteed (help 9487310, primary).
- ChatGPT Work presentations check the rendered slides before returning the deck (learn.chatgpt.com, primary).
- Claude's Design type is told not to verify its own output (claude-primary-evidence.md).
- **Juno today:** - The failure banner offers only Console and 'View vN' (canvas-panel.tsx:1223-1235).
- Verification is structural only (chat-artifact-verification.ts).
- Ask Juno refusals show raw schema paths (ai.ts:106-110).
- The Mac never shows lastRefusal: a bridge refusal snaps back silently (DesktopDesignEditorHost.swift:185-188).

### R-036 · Fair usage: editing by hand is free, only sending to Juno is metered, and failures are refunded
`P1` · effort S · web, mac, iphone · ai-editing · depends on R-007, X-07, X-10, M4
- **Build:** Write the contract into docs/JUNO.md §9b.
Never metered:
- manual editing in any editor;
- text-mode edits compiled to patches, tweaks and direct property edits;
- comments, replies and resolving;
- restore, compare and switching branches;
- Play and publishing.
Metered like a message: Send to Juno, Ask and Modify, Suggest, Turn into, Directions.
Refunded:
- generations that end refused, truncated or failing validation. The card says why and offers 'Try again (free)';
- the automatic repair turn (R-035).
UI:
- The Send-to-Juno tooltip names the model.
- Near a limit, the composer shows one sentence: 'Your 5-hour limit frees up at 14:00'.
- A large generation's taste-form footer may state a number: '3 directions · about 6% of your 5-hour window'. Numbers, never meters (PREMIUM rule 7).
- No per-action price tags, and no separate design allowance.
- **Why:** People reach for direct manipulation without worrying about cost, and Juno stops charging for its own failures.
- **Reference:** - Lovable: inline text edits are free within daily limits, commenting is free, and only sending costs credits (docs.lovable.dev; changelog 2026-04-02, primary).
- PCWorld used 80% of the weekly Claude Design allowance in about 25 minutes and was locked out for a week (2026-04-17, secondary). Since 17 June, Design shares Claude's limits, and 'Larger requests… use more of your limit' (claude.com/product/design, primary).
- Figma Make users report 60 to 98 credits for trivial edits (forum 2026-01-21, community).
- **Juno today:** - A design with an image node is always refused, and Free users lose one of their 15 messages to it (X-10).
- Refusals give no reason (M4).
- A truncated revision is kept as current (X-07).
- Rolling windows are the enforcement model (TWO_PRODUCTS §4).

### R-038 · Point, then ask: an ask bar at the selection, and queued asks above the composer
`P1` · effort M · web, mac, iphone · ai-editing · depends on R-031, R-037, R-010, X-05
- **Build:** Ask bar:
- A small bar pops from any selection (pop-in, duration-base, ease-spring): 'Ask Juno about this…'.
- ↩ sends now. ⇧↩ queues.
- ⌘⇧E (proposed) focuses it. Esc cancels and never commits.
Queue tray:
- Queued asks stack as chips in a tray above the composer. The tray opens with Collapse, and chips pop in.
- Each chip names its anchor ('Hero · CTA button', '¶ 3') and shows its first words.
- Drag to reorder (framer Reorder, spring.interactive), × to remove, click to edit.
- The artifact switcher shows a count per artifact.
Sending:
- The tray becomes one targeted-edit turn (R-009).
- The user bubble shows the asks as anchored cards, which scroll the panel to their anchor.
Running:
- Edits to the same artifact run one at a time, each against the then-current version (compare-and-swap).
- Edits to different artifacts run at most 2 in parallel.
- An anchor that no longer resolves is re-planned once; otherwise it is flagged 'Needs you · target changed'.
- A running chip folds out of the tray, and the running line's label cross-fades to its text.
Resolution: serialise per artifact. Do not copy Cursor's parallel writers on one object.
- **Why:** Review in one pass (point, queue, send) instead of waiting for each change.
- **Reference:** - Claude: 'Each request is added to your next message, and the file list shows how many requests are waiting' (help 9487310, primary). Claude Science shows pending comments above the message box, up to 1,000 chars (docs, primary).
- Cursor: 'send another edit before the first one has finished' (2026-06-05).
- Lovable: a visible, reorderable prompt queue (2026-02-05, 2026-06-10).
- **Juno today:** - The composer queues plain text while a reply streams (composer.tsx:1255-1265), and has a steering 'above' slot (composer.tsx:193). Queued items aren't tied to an element or a version.
- Ask Juno blocks for up to 120 s.

### R-045 · Ground the first draft: a taste form in the conversation, and a New-design sheet with style levers
`P1` · effort M · web, mac, iphone · ai-editing · depends on R-027, R-010, M41
- **Build:** Taste form:
- New question kinds in PreflightClarificationQuestionType:
  - visual-options: 2-4 wireframes drawn by Juno's renderer from small op documents;
  - swatches, including the installed design system;
  - segmented: fidelity, and size presets;
  - slider: density, or quiet↔expressive;
  - a design-system picker (R-051);
  - reference: a screenshot or URL.
- At most 6 questions, each skippable. A form-level 'Decide for me' fills in the defaults and submits.
- It appears inline under the user's message, not as a modal.
- Typing in the composer adds an answer and never discards the form. Nothing auto-sends.
- After submit it collapses to one line that can be reopened: 'Phone · High fidelity · Warm editorial · Juno DS'.
- Skip the form for revisions, and for requests that are already specific.
New-design sheet (from the New menu, ⌘K or /new/design):
- a size row, an optional 'Describe it' field, and a Style row: the account's default design system · Wireframe greys · None;
- with a description, the first turn runs on arrival and builds frames through operations grounded in the chosen system.
Style strip: after any generation, a strip under the header offers four levers (Accent, Type pairing, Density, Radius). They work through variable edits and setVariableMode, so they are instant and free. 'Keep' dismisses the strip.
Motion: questions rise in (stagger capped at 8). A selected option is bg-selected with foreground ink, with no hover lift. The form collapses on duration-base ease-in-out.
Resolution: variety comes from the answers and the design system, never from canned templates.
- **Why:** A minute of taps replaces three rounds of 'no, more like…', and first drafts land on-brand.
- **Reference:** - Claude Design asks multiple-choice clarifying questions before it builds. PCWorld spent about a minute answering them (2026-04-17), and Builder.io calls the form a 'taste exam' that uses the whole canvas (2026-04-29, secondary).
- Figma First Draft: pick a library, write a prompt, then use style controls (help, primary).
- Figma pulled Make Designs in 2024 over look-alikes of Apple Weather (AlternativeTo, secondary).
- **Juno today:** - Chat preflight clarification exists, with 4 question kinds (preflight-clarification.ts:3; clarify/route.ts; preflight-card.tsx), but it knows nothing about design.
- The /design presets ask only for a size and create an empty document.
- Ask Juno then runs on the flash model (M41).

### R-065 · Offline edits never vanish: drafts on disk, a visible 'Not synced' state, and a choice on conflict
`P1` · effort M · mac, iphone · reliability · depends on R-005, X-15, X-16, M4 (mac), M13 (mac)
- **Build:** Saving:
- Write design transactions (not whole documents) to disk as they are made, keyed by (artifactId, baseVersion).
- Rows and the header show 'Not synced' (a cloud-slash glyph and a muted caption) as their one trailing signal.
On reconnect:
- Replay the transactions in order through /transactions.
- If a newer version refuses some of them, rebase what still applies and show: 'Some changes conflict with v14 · Review · Keep both · Discard mine'.
  - Review opens Compare.
  - Keep both creates 'Copy of … (your edits)'.
Closing or quitting with pending edits asks: 'Quit and keep edits on this Mac' / 'Discard' / 'Cancel'.
Rules: never clear a draft silently. The offline Save message tells the truth (M4 mac).
Motion: the banner enters with Collapse. On sync, the glyph swaps to a check (IconSwap) that fades after 1.5 s.
- **Why:** Work done on a plane is still there when you land, and a conflict is a choice, not a loss.
- **Reference:** Figma keeps offline edits in IndexedDB for up to 30 days (7 in Safari). It shows an unsynced icon and 'Open to sync', and offers Review or Dismiss on conflicts. The desktop app asks before closing with unsynced edits (help 360040328553, primary).
- **Juno today:** - Artifacts are read-only offline.
- Mac design drafts are dropped on Back, on switching destination, on quit and on remote delete (X-16; DesktopDesignScreen.swift:215,444-446,520-523).
- An offline Save says 'saved' when nothing was saved (M4 mac).
- Mac saves use a stale base (X-15).
- The iPhone clears drafts when a newer version arrives (M13 mac).
- On the web, failed saves clear undo (M60).

### R-068 · On the Mac, artifacts behave like Mac documents: real windows, a dock backed by the stored row, and a Finder-grade browser [part]
`P1` · effort L · mac · native-mac · depends on R-016, R-018, R-022, R-025, R-060, X-11, X-12, X-15, X-16, X-17, X-18, X-19
- **Build:** Dock, on the Liquid Glass rework:
- Look up the row by (conversationID, identifier).
- Use the ArtifactSurface header: title, stepper, Share, ⋯.
- One view control: Preview | Source, with Console as a disclosure.
- Design edits autosave through transactions and show the saved tick. ⌘S becomes 'Save now' and is never required.
- Use surface='window' (X-18). Native title and actions go in the window toolbar; the editor's tool row is the only row inside (bridge setChrome native).
- Esc closes the dock, and focus returns to the card.
Document windows:
- 'Open in Window' (⌥⌘O, double-click, or ⌘-click on a card) opens a row-backed, editable window.
- It is restorable, using NSUserActivity with artifact id, mode and version.
- A unified NSToolbar holds: title and version menu, a native segmented mode control, Play, Share, Comments, History, and a Juno toggle.
- The Juno toggle (⌘⌥C) shows the artifact's conversation as a trailing pane that can pop out.
- Closing with unsynced edits asks first (R-065).
Artifacts browser:
- List and grid (⌘1/⌘2). Scopes and the type filter live in the toolbar, and the sort is remembered on the server.
- Arrows move the selection and Return opens.
- Space opens Quick Look, showing the R-014 image or a rendered PDF.
- ⌘⌫ moves to Recently deleted, undoable. ⌘F searches. ⌘I shows Info.
- Drag a tile out as a promised file: PNG or SVG for designs, HTML for pages, md for docs, pptx for decks.
- Menu bar: File › New Design/Doc, Open in Conversation (⌥⌘O), Share…, Publish…, Export ▸, Rename, Move to Project ▸. Edit › Undo is wired to the editor.
Motion:
- Selection is tonal on JunoMotion.fast, with no lift.
- Library to document uses matchedGeometryEffect.
- Mode changes cross-fade.
- Under Reduce Motion, everything cross-fades and nothing slides.
Resolution: the conversation is docked by default. The pop-out is an option, not an always-on-top default.
- **Why:** Designs work inside conversations on the Mac and behave like Mac documents: windows, menus, undo, Quick Look, drag-out and restoration.
- **Reference:** - Claude desktop has Pop out, Expand and Full screen. Split view tiles panes; Cmd-click or drag opens a session in its own window; and transitions are off while resizing (observed in the shipped Claude desktop app, v2.7032.0, primary).
- Figma desktop (2026-08-26) lets the agent chat pop out into its own window (release notes, primary).
- Figma asks before closing with unsynced edits.
- **Juno today:** The dock:
- It is built from the tag body, so it has no versions, save, share or design editing. It fails on chat-made designs (X-11) and shows stale revisions (X-12) (DesktopArtifactCanvas.swift:33-54).
- Canvas mode stacks three segmented controls, and 'Edit source' can never be saved.
The Design screen:
- It requires ⌘S, even though transactions are already committed (DesktopDesignEditorHost.swift:167-170).
- A native command bar sits on top of the web toolbar (DesktopDesignScreen.swift:421-438).
Windows: 'Open in New Window' is an immutable 820×620 snapshot (DesktopArtifactsScreen.swift:1449-1473).
The Artifacts screen:
- It is a grid only, with no list view, sort or keyboard support.
- Return, Space, ⌫ and ⌘F do nothing, and there are no menu commands, drag-out, restoration or Handoff.
- The library cannot open an artifact's conversation (DesktopAccountScreens.swift:98-103).

### R-069 · The phone contract: view, Play, comment, ask, tweak and make small edits, stated honestly [part]
`P1` · effort L · iphone, web · mobile · depends on R-002, R-016, R-040, R-043, R-057, X-11, X-15, X-16, M13 (mac), M57, M58
- **Build:** Write one phone contract, covering the iPhone and phone-width web, into the help pages and in-app copy. App Store screenshots show only what works.
v1, what a phone can do:
- open any artifact from its link, full-bleed, with pinch and pan;
- step through versions;
- Play prototypes and Present decks;
- comment with long-press or tap pins (0.4 s, medium haptic);
- select, then Ask by voice or text, with the selection chip;
- apply tweaks, in a sheet with medium and large detents;
- edit text in place (Docs, and design text layers by double-tap);
- reorder and hide slides and layers;
- replace an image from Photos;
- change share settings and revoke links;
- get notified when a turn finishes.
v1.1, once touch pan and pinch land in the editor (M57):
- tap to select, drag to move, and colour from tokens, on designs;
- one-finger pan on empty canvas, and a long-press menu.
Desktop and iPad only, said in one line rather than shown as a disabled toolbar: drawing, resizing, auto layout and keyframe tracks. The full editor appears only when the container is 768pt or wider.
Layout:
- A bottom bar: Play · Comment · Tweaks · Ask (44pt targets).
- The inspector and layers are bottom sheets (animate-sheet-in, ease-drawer).
- The selection bar sits above the keyboard.
- On phone-width web, the Canvas is a bottom sheet with a 44px grab handle. It follows the finger and settles at 50% or 92% (duration-slow, ease-drawer).
Saving:
- Saves go through transactions with autosave.
- Drafts are kept per (artifact, base version) and never cleared silently: 'Updated to v8 · Keep my edits on top / Keep as a copy'.
- This lifts R-002's guard.
Resolution: this sequencing honours both views. FIA-15 and FIG-19 wanted editing through fields and Juno; CM-20 and CUX-20 wanted direct moves. Fields and Ask come first, direct moves after M57.
- **Why:** The 'open it on your phone' promise holds. People can review, comment and fix a detail without a laptop, and know exactly what works there.
- **Reference:** - Claude's help says Design, Docs and Slides are view-only on phones: 'Editing on the canvas and changing sharing settings need Claude on web or desktop' (help 14604416, 16923645, 9547008, primary). Yet the launch blog promised 'one shareable link you can open on your phone', and TechCrunch said users can 'edit them on their phone' (2026-09-16).
- Figma's mobile app cannot edit Design or Slides files, but can comment with a long-press and run prototypes (help 1500007537281, primary).
- Figma Buzz lets marketers edit only approved fields.
- The Claude Docs viewer ships a BottomSheet module.
- **Juno today:** iPhone:
- The library edits the latest design through the generic POST and drops drafts when a remote version arrives (JunoMobileWorkspaceViews.swift:2062-2068; M13 mac).
- The inline viewer is read-only (JunoMobileDesignArtifact.swift:408) and cannot open chat-made designs (X-11).
- Native apps cannot share artifacts.
Phone-width web:
- No touch pan or pinch (M57), and the canvas collapses to 0px (M58).
- The Canvas replaces the chat below 50rem.
- The history rail is a fixed w-48.

### R-079 · 'Made here': one small index of everything a conversation produced [tries]
`P2` · effort M · web, mac, iphone · ia-navigation · depends on R-078, R-029, X-25
- **Build:** - Rename it 'Made here', one noun, and keep it a popover from the conversation header.
- At the top, five create tiles: Doc, Deck, Design, Page, Diagram. A tile only prefills an editable composer prompt with the type armed (R-028). Nothing runs without Send.
- Below, outputs grouped by type, with counts and several per type. Include WorkArtifact deliverables and images, which fixes the dead pointer in X-25.
- A generating row reads 'Writing', with a percentage only when one is real. The row is clickable, and the rest stay usable.
- Row ⋯ menu: Open, Turn into…, Revise with settings (a small form per type that produces a sibling branch), Share, Delete.
- Mac: the Liquid Glass Outputs popover adopts this. iPhone: a sheet from the title.
- Motion: pops in from its trigger, rows rise in (stagger capped at 8), and a new output enters via layout with a one-shot bg-selected fade.
- **Why:** Everything a chat produced, deliverables included, sits in one small place, and the next output is one tap away.
- **Reference:** NotebookLM Studio puts creation tiles on top and several outputs per type below, and one output can be used while another generates (blog.google, 2025-07-29, primary). Its tiles start generating as soon as they are tapped.
- **Juno today:** - session-outputs.tsx is a good index that needs no fetch, and it has 'Used in this session'. But its labels disagree with /artifacts (00-AUDIT §5).
- Deliverables are missing from it, even though the stage points users there (X-25).
- It has no way to create anything and no generating state.

## Phase 4 — Everyone gets the merge: Day one (W16–W21)

### R-068 · On the Mac, artifacts behave like Mac documents: real windows, a dock backed by the stored row, and a Finder-grade browser [with the glass release]
`P1` · effort L · mac · native-mac · depends on R-016, R-018, R-022, R-025, R-060, X-11, X-12, X-15, X-16, X-17, X-18, X-19
- **Build:** Dock, on the Liquid Glass rework:
- Look up the row by (conversationID, identifier).
- Use the ArtifactSurface header: title, stepper, Share, ⋯.
- One view control: Preview | Source, with Console as a disclosure.
- Design edits autosave through transactions and show the saved tick. ⌘S becomes 'Save now' and is never required.
- Use surface='window' (X-18). Native title and actions go in the window toolbar; the editor's tool row is the only row inside (bridge setChrome native).
- Esc closes the dock, and focus returns to the card.
Document windows:
- 'Open in Window' (⌥⌘O, double-click, or ⌘-click on a card) opens a row-backed, editable window.
- It is restorable, using NSUserActivity with artifact id, mode and version.
- A unified NSToolbar holds: title and version menu, a native segmented mode control, Play, Share, Comments, History, and a Juno toggle.
- The Juno toggle (⌘⌥C) shows the artifact's conversation as a trailing pane that can pop out.
- Closing with unsynced edits asks first (R-065).
Artifacts browser:
- List and grid (⌘1/⌘2). Scopes and the type filter live in the toolbar, and the sort is remembered on the server.
- Arrows move the selection and Return opens.
- Space opens Quick Look, showing the R-014 image or a rendered PDF.
- ⌘⌫ moves to Recently deleted, undoable. ⌘F searches. ⌘I shows Info.
- Drag a tile out as a promised file: PNG or SVG for designs, HTML for pages, md for docs, pptx for decks.
- Menu bar: File › New Design/Doc, Open in Conversation (⌥⌘O), Share…, Publish…, Export ▸, Rename, Move to Project ▸. Edit › Undo is wired to the editor.
Motion:
- Selection is tonal on JunoMotion.fast, with no lift.
- Library to document uses matchedGeometryEffect.
- Mode changes cross-fade.
- Under Reduce Motion, everything cross-fades and nothing slides.
Resolution: the conversation is docked by default. The pop-out is an option, not an always-on-top default.
- **Why:** Designs work inside conversations on the Mac and behave like Mac documents: windows, menus, undo, Quick Look, drag-out and restoration.
- **Reference:** - Claude desktop has Pop out, Expand and Full screen. Split view tiles panes; Cmd-click or drag opens a session in its own window; and transitions are off while resizing (observed in the shipped Claude desktop app, v2.7032.0, primary).
- Figma desktop (2026-08-26) lets the agent chat pop out into its own window (release notes, primary).
- Figma asks before closing with unsynced edits.
- **Juno today:** The dock:
- It is built from the tag body, so it has no versions, save, share or design editing. It fails on chat-made designs (X-11) and shows stale revisions (X-12) (DesktopArtifactCanvas.swift:33-54).
- Canvas mode stacks three segmented controls, and 'Edit source' can never be saved.
The Design screen:
- It requires ⌘S, even though transactions are already committed (DesktopDesignEditorHost.swift:167-170).
- A native command bar sits on top of the web toolbar (DesktopDesignScreen.swift:421-438).
Windows: 'Open in New Window' is an immutable 820×620 snapshot (DesktopArtifactsScreen.swift:1449-1473).
The Artifacts screen:
- It is a grid only, with no list view, sort or keyboard support.
- Return, Space, ⌫ and ⌘F do nothing, and there are no menu commands, drag-out, restoration or Handoff.
- The library cannot open an artifact's conversation (DesktopAccountScreens.swift:98-103).

### R-075 · Duplicate, make a copy, continue in a new chat, pin, and attach by reference [pin]
`P2` · effort S · web, mac, iphone · ia-navigation · depends on R-004, R-018, R-039
- **Build:** Row and overflow actions:
- Duplicate (owner or editor): creates 'Copy of <title>' in the same project, with the current version only and no comments, shares or conversation. Info reads 'Duplicated from <title> v12'.
- Make a copy (signed-in viewers of a grant or a published page): the copy lands in their Artifacts, marked 'Copied from <owner>'s <title>'. A per-link 'Allow copies' setting is on for grants and off for public links.
- Duplicate as new artifact: on a version row.
- Continue in a new chat: starts a conversation whose first context is the artifact digest. The artifact is linked, not copied.
- Pin to sidebar: uses ArtifactPin and shows as a plain text row in the Pinned fold. A filled pin means pinned.
Forking a conversation carries its artifacts along by reference.
Composer: '+ › Add from Library' gains a 'Made' tab. Picking an artifact attaches a reference chip, pinned to its version at send. Juno reads the current body and edits that artifact, or offers 'Make a copy here'.
Motion: a new row rises in, with one highlight that fades over duration-emphasis.
- **Why:** People can branch an idea, reuse someone's work, or bring something they made into a new chat, without touching the original.
- **Reference:** - Figma offers Duplicate, and Duplicate to drafts for viewers. Copies are named 'Copy of …' and carry no comments or history, and Community copies get no updates (help 360038511533, 360038510873, primary).
- Claude had Remix (2024) and today offers 'Build on a published artifact' by copying it into a new chat. Artifacts can be pinned to the sidebar (help 9547008; Artifact tool contract).
- ChatGPT has 'Add from library' in the composer (help snippet).
- **Juno today:** - There is no duplicate or remix (01-AUDIT-WEB §2.8).
- Forking a conversation drops its artifacts (fork/route.ts:17-27).
- The sidebar has Pinned folds for projects and chats, but not for artifacts.
- The composer's Library picker attaches only IMAGE and FILE items, as server clones (library-picker.tsx).

### R-092 · Generated media join the index, and image actions live on image layers
`P2` · effort M · web, mac, iphone · merge-core · depends on R-018, R-034, 00-AUDIT §12.4
- **Build:** Index: the Artifacts index lists generated images and videos under Images, by reference. They stay Attachments.
Image actions: selecting an image layer in Design shows:
- Remove background;
- Upscale ×2;
- Extend to frame;
- Restyle, with a strength slider and a style taken from the design system;
- Variations ×4.
Each action:
- creates a new asset version and keeps the original;
- is one undoable operation;
- previews with R-034 presence.
Usage: everything draws on the same usage windows as chat. No separate place, account or credit type.
- **Why:** Images Juno makes can be found with everything else, and edited where they are used.
- **Reference:** - Figma Weave 'lives outside the Figma file browser', with separate paid credits. Weave tools inside Design are parameterised image tasks.
- Figma Design Actions include Remove background, Boost resolution, Expand image and Vectorize (help; blog 2026-06-24, primary).
- **Juno today:** - Generated media are Attachment rows (origin 'generated') and are listed only in /library (00-AUDIT §4.1, §4.3).
- Images in designs are inlined up to 96KB and cannot be edited.

## Phase 5 (+ native N3) — Docs, Decks and Work: Launch (W18–W27)

### R-019 · One motion runtime for canvas, Play, share, exports and native, proven by conformance tests
`P0` · effort L · web, mac, iphone · motion · depends on R-012, X-19, M61, M62, M63, M64, M65, L20, L21, L22, L24, L25, L26
- **Build:** Create src/lib/design/motion/, shared by web and the native bundle:
(a) compileMotion(doc) → MotionIR.
- Structure: animations → cohorts → tracks {nodeId, channel, composition set|offset|scale, transformOrigin, keyframes [{t, value, easing}]}.
- Easing is resolved to a bezier, a sampled spring or a hold. Tokens are resolved per mode.
(b) sample(ir, animationId, tMs), a pure function.
- The canvas lays out once at rest and applies sampled deltas as SVG transform, opacity and fill on per-node groups.
- It re-lays-out only subtrees with animated width, height or gap (fixes L24).
(c) emitWebAnimations(ir): WAAPI or CSS keyframes, with springs as CSS linear() sampled at about 60 points (fixes L20). This is the runtime for Play, share links and HTML export.
(d) emitMotionDev and emitSwiftUI, for handoff (R-082).
Reduced motion follows the product tiers (ICONS_AND_MOTION §2.2 rule 10):
- translate, scale and rotate jump to their end values;
- opacity and colour keep their timing;
- loops stop after one cycle;
- each animation can override this: 'Fade only (default) | Keep (essential) | Off'.
Conformance:
- Playwright loads each fixture's HTML output and seeks with animation.currentTime to 0, 25, 50, 75 and 100%.
- It compares the computed transform and opacity with sample(), within 0.5px and 0.01.
- The audit repros M62 to M65, L20 to L22 and L26 become fixtures.
- Every exporter lists all its unsupported notes (L25).
- Play (R-057) must not ship before this suite passes.
Resolution: FPM-03 and FPM-04 each depended on the other. Build the runtime and the conformance suite on today's schema first, then migrate to schema v2 (R-049).
- **Why:** What a person scrubs in the editor is exactly what plays in the panel, at the link, on the phone and in exported code.
- **Reference:** Figma drives Dev Mode's timeline, its CSS, React and JSON snippets, and MCP get_motion_context from one keyframe model, with a mandatory prefers-reduced-motion guard (help 41296356954263; figma-implement-motion/SKILL.md, primary). Figma's end-state flash, and overlay animations that did not play, lasted about 12 weeks (forum; reported 2026-06-26, fixed 2026-09-16).
- **Juno today:** - Preview and export disagree in five reproduced cases (M64, M65, L20, L21, L22).
- In the HTML runtime, delay timers start at load and key triggers fire from hidden frames (M62). Reverse sticks (M63). Hover and press fire once (L26).
- Transitions reach no runtime (M61).
- Playback re-lays-out and re-serialises the whole page SVG every frame (L24; design-canvas.tsx:177-193).
- Reduced motion is a blanket animation:none (export.ts:1157).
- Exports show only their first unsupported note (L25).

### R-030 · Suggested edits: hunk-by-hunk review when Juno changes work the user has touched
`P1` · effort L · web, mac, iphone · ai-editing · depends on R-010, R-005, R-029, M46, M47
- **Build:** When a change becomes a suggestion set rather than the current version:
- the artifact has user-authored versions since the model last wrote (by authorKind); or
- the per-artifact 'Suggest, don't apply' toggle is on. It defaults on for Docs and off for a fresh model draft.
- Larger changes go to a branch instead (R-029).
Review UI:
- A bar under the header: 'Suggestions · 2 of 6', Accept all, Reject all, close.
- Hunks shown inline: deletions struck through in muted-foreground, insertions on bg-selected, and the current hunk in a 1px foreground/30 ring.
- A floating mini bar: Accept (Y/↵) · Reject (N/⌫) · Next (J) · Previous (K). ⇧Y accepts the rest. Any hunk can be clicked, in any order.
DESIGN hunks:
- Each hunk is an operation group, keyed by its top-level node. Each card has a before/after crop from renderPageSvg.
- Dependent groups are linked and accept together.
- Hovering a card cross-fades between committed and proposed.
Committing:
- Accepted hunks compose into one version (origin ai-suggestion, linked to the message).
- Rejected hunks are recorded, so the next turn knows.
- Every accept re-validates. A hunk that fails stays open as 'Can't apply — this part changed' (fixes M47).
- A stale set offers Re-suggest.
Platforms:
- Mac: the same review over the bridge proposal channel.
- iPhone: a sheet of hunk cards. Swipe right to accept, left to reject; 44pt targets.
Motion:
- The bar rises in 6px.
- The ring fades between hunks with no travel (PREMIUM §2d).
- Auto-scroll puts the hunk at about 35% of the height, and jumps under reduced motion.
- The fill on an accepted insertion fades over duration-slow.
- Rejected hunks fold with Collapse.
Priority: P1. OTH-01 said P0 and CM-09 P1. The P0 guarantee that hand edits are never overwritten comes from R-009's compare-and-swap and human-wins rule; this hunk-level review is the experience on top.
- **Why:** Keep the good parts of an AI pass and drop the rest, without ever losing hand edits.
- **Reference:** Notion Suggested Edits (2026-08-28): 'move top to bottom to approve each one' (notion.com/releases/2026-08-28, primary). Claude revises in place, with conflict refusal but no per-change approval (claude-primary-evidence.md).
- **Juno today:** No AI write channel lets the user review change by change:
- chat re-emit overwrites (X-05, X-06);
- Canvas Modify commits directly;
- Ask Juno is all-or-nothing Apply or Reject (design-editor.tsx:964-1015). It leaks writes during review (M46) and reports false success (M47).

### R-052 · Animation presets: the fast path for people and for the model
`P1` · effort M · web, mac, iphone · motion · depends on R-019, R-049, R-050
- **Build:** Data: node.animationStyles[] = {id, preset, params, offsetMs, duration|alias, easing|alias}. Presets compile into the IR (R-019) without expanding into tracks, so each stays one control.
Presets, named after Juno's product motion:
- Fade;
- Rise (6px);
- Pop (from 0.96);
- Slide (direction and distance);
- Scale;
- Rotate;
- Reveal (clip inset);
- Draw (path trim, after R-089);
- Stagger children (tight, base or loose, capped at 10);
- Parallax (speed).
Composites can be saved as named Animation styles in the document or in the design system.
UI:
- An 'Animate' section under Effects. Its + opens a preset menu with glyphs, and hovering a preset plays it once on the selection.
- An applied preset is one row, for example 'Rise · in · base · Soft out', with visibility and remove controls. ⇧ multi-selects rows.
- The dock shows each preset as a named bar with resize handles.
- On a phone, the Animate section is the whole motion editor. Keyframe tracks are desktop-only, and one line says so.
AI operation: applyAnimationStyle {nodeIds, preset, params, duration:'@motion.base', easing:'@ease.out-soft', stagger:'base'} replaces raw keyframes.
- **Why:** Entrances, reveals and staggers take two clicks or one sentence, and each stays one editable control.
- **Reference:** - Figma Motion's Animations section has presets (Fade, Move, Scale, Rotate, Resize) that can be stacked or sequenced. Custom styles are 'coming soon'. Users complain that presets show raw properties and have no multi-select (help 41307886266135; forum, primary/secondary).
- Framer Agents take prompts such as 'Set up staggered animations on the feature cards…' (framer.com/agents, primary).
- **Juno today:** - There are no presets. Every animation is built from hand-made tracks (motion-panel.tsx).
- The AI emits raw keyframes with physical springs (ai.ts:272-299).
- The product already has named recipes (fade, a 6px rise-in, a pop-in from 0.96 with 4px) and a stagger scale (tight 30, base 45, loose 60 ms, capped at 10) (src/lib/motion.ts).

### R-055 · Transitions that actually run, with smart animate matched by a copied match key
`P1` · effort L · web, mac, iphone · motion · depends on R-019
- **Build:** Transition kinds, all implemented in the runtime:
- dissolve;
- move-in and move-out: one frame slides over or away;
- push: both frames translate;
- slide-in and slide-out: a 30% offset plus a dissolve.
Add the -out phases so Figma's kinds map one to one.
Smart animate:
- For each match key present in both frames, FLIP the box: translate and scale from the source rect to the destination rect.
- Animate rotation, opacity, radius, stroke weight and solid fill. Interpolate colour in OKLab.
- Unmatched outgoing layers fade out over the first half (ease-in). Unmatched incoming layers fade in over the second half (ease-out-soft).
- Shadows, effects, images and changed text cross-fade.
- Overlays can smart-animate too.
Matching:
- Add node.matchKey. duplicateNodes copies it, or copies the source id, so duplicated frames match.
- The inspector gets a 'Match as' field.
- Name-and-path matching is only a fallback, and is labelled as such.
Other:
- The Prototype tab gets 'Preview transition', which plays once in place.
- The default stays dissolve, 220 ms, ease-in-out.
- Under reduced motion, every transition becomes a dissolve of the same duration.
- **Why:** Screens animate the way they were designed, and matching survives duplication and renaming.
- **Reference:** - Figma transitions: Instant, Dissolve, Smart Animate, Move in/out, Push and Slide in/out, with durations of 1-10,000 ms.
- Figma's Smart Animate matches layers by name and hierarchy. It animates position, scale, rotation, opacity and fills, and cannot smart-animate overlays (help 360040522373, 360039818874, primary).
- **Juno today:** - TransitionKind covers instant, dissolve, slide, push and move, with a direction and a matchStableIds flag (types.ts:666-685). No runtime plays them (M61).
- duplicateNodes gives copies fresh ids and records no lineage (operations.ts:853-878), so frames cannot be matched.
- matchStableIds is read only by the handoff JSON (export.ts:1809).

### R-056 · Prototype behaviour: triggers, playback, scrolling frames, sticky layers and overlays
`P1` · effort L · web, mac, iphone · motion · depends on R-019, M42, M62, M63, L26
- **Build:** Animations:
- playback: once | loop | ping-pong.
- autoplay: on-frame-enter (the default) | on-trigger | never.
- play-animation gains mode: play | reverse | toggle | pause | restart. The runtime keeps each animation's direction and progress (fixes M63).
- Dock rows show the setting, for example 'Plays: on enter · once'.
Triggers:
- Triggers are scoped to the visible frame. Delay timers start when their frame appears and are cancelled when it leaves. Key listeners attach only while their frame or overlay is on top (fixes M62).
- Hover and press become 'while' triggers that reverse on leave or release (fixes L26).
- Add one-shot mouse-enter and mouse-leave triggers.
- An interaction can hold up to 3 actions, run in order.
- Scroll-into-view gains a threshold (0-100%) and a choice of once or every time.
Scrolling:
- A frame gets overflow: none | vertical | horizontal | both.
- A child gets scrollBehavior: scroll | fixed | sticky. Sticky stays within its parent.
- A 'scrolls' chip appears on the frame title, and Play has momentum scrolling.
- navigate.resetScroll is on by default.
Overlays:
- Position: centre, an edge, or manual.
- Backdrop: none, or a dim colour (default: ink at 40%).
- Close on outside click: on by default.
- Entrance transition: sheets slide up on ease-drawer over 360 ms; dialogs pop from 0.96 on ease-spring over 220 ms.
- On close: reverse, fade (160 ms, ease-in) or none.
- Add swap-overlay, and back with a history stack.
Cleanup: deleting a node removes the interactions that point at it. The Prototype tab flags old dangling links as 'Destination deleted' (M42).
Later (P3): scroll-linked progress.
- **Why:** Buttons, hovers, delays, keys, scrolling and sheets behave the way they were built, every time.
- **Reference:** - Figma Motion animations cannot be triggered by interactions (staff, 2026-06-29 and 07-02). Users want an Animation section with autoplay and loop settings (2026-07-30), and report sheets replaying backwards on close (2026-06-25) (forum).
- Figma triggers: While hovering and While pressing revert when released; Mouse enter/leave; After delay (help 360040035834).
- Figma scrolling: overflow directions, fixed and sticky children, and preserve or reset scroll. Overlays have Open, Close and Swap, with position, background and close-on-outside (help 360039818734, 360040035874, primary).
- Figma has no scroll-into-view trigger.
- **Juno today:** - play-animation {animationId, reverse} exists (types.ts:664), but reverse sticks (M63).
- Delay timers start at page load, and key triggers fire from hidden frames (M62). Hover and press fire only once (L26).
- Animations have only loop:boolean (types.ts:723). An interaction takes one action. There is no mouse enter or leave.
- Frames have only clipsContent (types.ts:507). open-overlay takes only a target, and the runtime implements neither overlays nor back (export.ts:1175-1233).
- Deleting a target leaves dangling interactions that blank the export (M42).
- Juno already has a scroll-into-view trigger.

### R-057 · Play mode: one player for prototypes and decks, in the panel, full window and at the link
`P1` · effort L · web, mac, iphone · motion · depends on R-012, R-014, R-015, R-019, R-055, R-056, M42, M61
- **Build:** Entry points:
- ▶ Play in the surface header, and as the card's second action, for every kind that can run:
  - DESIGN plays the prototype from the start of its flow;
  - DECK opens Present;
  - a Page switches to Interact.
- ⇧Space toggles Play in place.
- ⌘⌥↩ opens full-window /a/{id}/play: the Fullscreen API on the web, a full-screen window on Mac (R-060), and a full-screen cover on iPhone.
- Esc exits.
Keys:
- R restarts; ←/→ step between frames or slides; Space or PageDown advances; Home and End jump.
- H toggles hotspot hints, and ⇧ reveals them all.
- C drops a comment (R-087).
- In Present: N toggles notes and B blanks the screen.
Player bar:
- surface-float, 16px above the bottom edge.
- Contents: Restart, Previous/Next, the frame name and position ('Checkout · 3/7'), a Flow menu, Scale (Fit, Fill, 100%), and ⋯ (Device frame, Hints, Preview reduced motion).
- It fades out after 2 s idle (duration-exit, no travel) and back in on movement (duration-fast). On touch, tapping the stage shows it.
Hints: a click that misses outlines the visible hotspots (1px accent; 120 ms in, 600 ms hold, 160 ms out).
Runtime:
- One runtime (R-019) for Play, share links and HTML export.
- Frames and slides stay mounted (hidden), so video and iframe state survives.
- The URL carries ?frame=.
States:
- Loading shows the poster, and the runtime cross-fades in when ready.
- Empty: 'Nothing here reacts yet · Add interaction'.
- Error: the poster, one sentence, and Restart.
Switching modes:
- The rails exit (160 ms, ease-in), the camera fits the start frame (360 ms, ease-in-out), and the bar rises 6px (220 ms, ease-spring).
- Under reduced motion, the switch is a 160 ms cross-fade and every transition becomes a dissolve of the same duration.
Sharing: the Share dialog offers 'Opens in: Canvas | Play', defaulting to Play when the design is interactive (R-088). In a container narrower than 560px, non-editors open in Play by default.
Resolution: one Play mode, reached the same way for every kind, instead of Figma's three separate playback places.
- **Why:** Anything that moves or reacts can be tried in the chat, full screen, at its link and on a phone, with the same controls every time.
- **Reference:** - Figma Present (⌘⌥↩) opens a separate tab with a flows sidebar: R restarts, the arrows move between frames, hints show on click, and there are scale options. The inline preview (⇧Space) follows edits (help 360040318013, primary).
- Claude Design artboards link to each other with <a href> in Play mode, and canvas.json launch.view picks what opens. Claude Slides have Present (claude-primary-evidence.md).
- **Juno today:** - There is no player anywhere, and the Prototype tab says so (interactions-panel.tsx:19-25; M61).
- HTML export navigation toggles hidden root frames (export.ts:1168,1201).
- A shared DESIGN renders as JSON (X-20), and scripted previews are dead (X-01).

### R-058 · Doc becomes a typed artifact, with Office and PDF as derived exports
`P1` · effort XL · web, mac, iphone · docs-slides · depends on R-001, R-004, R-008, R-009, X-25, M72
- **Build:** The type: register DOC.
Body:
- Tabs, each holding blocks with stable ids: heading, paragraph, list, task, table, chart, mermaid, callout, image, divider.
- Chips for dates, mentions and status.
- Markdown-compatible, so existing MARKDOWN artifacts open as Docs ('Convert to Doc').
Editor:
- Blocks are set at the reading measure, and '/' inserts a block.
- Autosave goes through the patch protocol.
- Tabs appear as a menu when docked, and as a left outline in the full window.
Exports: .docx, .pdf and .md through one OOXML renderer and the existing validator (validate.ts). Retire the second renderer.
Work:
- create_deliverable for documents writes a DOC artifact and keeps the spec as its source.
- The file becomes a derived export attached to the version.
- The run's final card links to the artifact.
- This answers owner Q1 with option A now and option B later.
Charts: charts pulled from data show 'Last refreshed' on the chart itself.
Native: after R-001, a native block view with plain text editing.
Docs ship with versions, trash, comments and a comment-only role from day one.
- **Why:** Documents Juno writes become editable objects with history that export to Office, instead of files that vanish after a task.
- **Reference:** Claude Docs (help 16923645, primary):
- living rich text with tabs: prose, tables, charts, task lists, Mermaid and LaTeX;
- chips for dates, mentions and status;
- 'Click into the doc and type… changes save automatically';
- @Claude in comment threads;
- export to Word, PDF, Markdown and Google Docs;
- 'Turn the doc into Claude Slides'.
Gaps: no version history and no trash.
- **Juno today:** - Docs are MARKDOWN artifacts that follow conventions (system-prompt.ts:293-297).
- Work's document and presentation specs are thrown away after rendering (M72; schema.prisma:2608-2665). WorkArtifact is a separate system.
- Word and PowerPoint deliverables cannot be reached on the web (X-25).
- There are two near-identical OOXML renderers (office-export.ts:450-611; work/deliverables/document.ts:173-358).

### R-059 · Decks on the design engine: a slide strip, Present, and one set of transitions and builds
`P1` · effort XL · web, mac, iphone · docs-slides · depends on R-008, R-052, R-055, R-057, R-058, X-24, X-17, X-19, M73
- **Build:** Model: DECK is a DesignDocument profile.
- A 'Slides' page whose ordered 1920×1080 top-level frames are the slides.
- Named frame groups are sections.
- Each slide has markdown speakerNotes (at most 4,000 characters) and a skip flag.
Default UI:
- A left slide strip: thumbnails from renderPageSvg, section headers and a grid toggle.
- The canvas.
- A right panel with two tabs:
  - Slide: layout presets, a theme from the design system, background;
  - Animate: transition and build-ins, each 'On click', 'With previous' or 'After previous', with a tight, base or loose stagger.
- ⇧D reveals the full design rails for the current slide. It is the same editor.
Transitions map onto R-055's kinds:
- fade is dissolve (default 360 ms, ease-in-out);
- push and slide take a direction (duration-slow, ease-drawer);
- magic is smart animate by match key (560 ms, ease-in-out).
Build-ins are the fade, rise and pop presets (R-052).
Present uses Play (R-057):
- → or Space advances one build; ← goes back; R restarts; N shows notes; B blanks the screen; Esc exits.
- On Mac, a presenter window on a second display shows the current slide, next slide, notes and a timer.
- Under reduced motion, every transition becomes a 160 ms fade.
Pickers: tokens are listed first, with 'Custom colour' one step away. Local variable modes are allowed.
Exports:
- PPTX with native text boxes and shapes. Fade and push are mapped; magic is listed as unsupported in the export UI.
- PDF via renderPageSvg, and a PNG per slide.
Authoring: the model builds slides with operations and knows only these transition names.
Work: persist Work presentation specs as DECK versions.
- **Why:** Decks get real design control and motion, can be presented from a link and exported to PowerPoint, with no second editor to learn.
- **Reference:** - Claude Slides: 1920×1080 slides; deck.json with an outline and at most 4 font faces; one HTML section per slide; transitions fade, push and magic (a morph); build-ins fade, rise and pop; Present; notes up to 4,000 characters; PDF and PPTX export (claude-primary-evidence.md).
- Figma Slides: SLIDE_GRID → SLIDE_ROW → SLIDE, with sections, speakerNotes and skip. Shift+D design mode unlocks layers, auto layout and components. 'Variable modes cannot be created in Figma Slides'. .pptx import and export (help; figma-use-slides skill, primary).
- go9x reports that Claude Slides' colour picker offers only design-system colours (2026-09-23, secondary).
- **Juno today:** - Decks are Markdown with --- separators, exported by a Markdown-to-pptx converter (office-export.ts).
- Work's 5 fixed layouts overflow while still marked valid (M73; presentation.ts:30-39).
- The Design scene already has pages, frames, auto layout, components, variables, keyframes and prototype transitions, including move with matchStableIds (types.ts:436-789). It has no player.

### R-060 · Design bridge v2, and Play on Mac and iPhone
`P1` · effort M · mac, iphone · native-mac · depends on R-057, X-11, X-17, X-19, 00-AUDIT §12.5
- **Build:** Bridge v2 commands and events, all with the same nonce and revision checks:
- appearance {scheme, accent};
- reduceMotion {bool}, read from NSWorkspace or UIAccessibility and observed live;
- undoState, which drives the Mac Edit menu;
- selection, read by the composer chip (R-031);
- proposal and resolveProposal (R-010);
- comments.list, create and resolve (R-040);
- adopt (R-013);
- play {flowId?, frameId?} and stop;
- setChrome native, which hides the editor's own top bar (R-068).
Mac:
- View › Play Prototype (⌥⌘↩), and a Play/Stop toolbar button.
- 'Present in New Window': chromeless, full screen on a second display, with R, the arrows and Esc. Slide notes stay in the main window.
iPhone:
- Play on the inline viewer and in the library editor.
- Tap acts as click and long-press as press. Hover-only interactions show as hint outlines.
- Swiping between frames works only on frames without a drag trigger.
- A 44pt Close button sits at the top left.
Release gate: check the bundle build in native CI and in the Mac release (X-19).
- **Why:** Designs and decks play on the Mac and iPhone just as on the web, and follow the system Reduce Motion setting.
- **Reference:** - Figma Present opens a dedicated surface with keyboard navigation (help 360040318013).
- Claude: one link you can open on your phone, and Present for Slides (claude-primary-evidence.md).
- **Juno today:** - The bridge carries only document snapshots. It has no theme, accent, undo, proposal, selection, comments or playback channels (00-AUDIT §12.5; DesignBridge.swift:94-251).
- The bundle is stale and shipped in 1.6.0 (X-19), and its CSS lacks the shared primitives (X-17).
- The Mac dock slides even under Reduce Motion.
- No native surface can play a prototype.
- The iPhone inline viewer is read-only (JunoMobileDesignArtifact.swift:408) and cannot open chat-made designs (X-11).

### R-061 · Keyboard and clipboard shortcuts designers already know, and Escape always cancels
`P1` · effort M · web, mac, iphone · editor · depends on R-060, M48, L52, L69
- **Build:** 1. Escape cancels a draft everywhere. One shared field primitive replaces six hand-written patterns (M48).
2. System clipboard:
   - ⌘C writes application/x-juno-design+json (nodes plus the assets and variables they reference), with image/svg+xml and image/png fallbacks.
   - ⌘V pastes in place if the source is visible, otherwise at the viewport centre. An image becomes an image node, SVG becomes a vector group, and text becomes a text node.
   - ⌘X cuts. ⌥⌘C/⌥⌘V copy and paste properties.
3. Navigation: hold Space, or H, for the hand; ⇧1 fits; ⇧2 zooms to the selection; ⇧0 is 100%; ⌘+/⌘- zoom.
4. Structure and editing:
   - Enter goes to children, ⇧Enter to the parent, and Tab/⇧Tab to siblings.
   - ⌘R renames. ⇧A adds or wraps auto layout.
   - Alt-drag duplicates; panning moves to Space or the middle button.
   - Shift locks the axis. Alt-hover shows distances.
5. ⌃⇧? opens a searchable shortcut sheet (animate-modal-in).
Guards:
- readOnly disables tool keys (L69).
- Keys fire only when focus is in the editor, never from the chat composer.
- Fix L52.
Mac: route undo, redo, cut, copy, paste and delete through NSResponder to bridge commands, so the Edit menu shows the real state (R-060).
Resolution: ⇧0, ⇧1 and ⇧2 stay the zoom keys (Figma muscle memory), so modes use ⇧D and ⇧M (R-026), and Play uses ⇧Space and ⌘⌥↩ (R-057).
- **Why:** Figma muscle memory works, copy and paste work across designs and apps, and Escape never saves by accident.
- **Reference:** - Figma: Space-drag or H pans; the arrows pan with nothing selected; Cmd+scroll or pinch zooms; Tab/⇧Tab moves through children; F6 goes to the toolbar; Ctrl+⇧+? opens the shortcuts panel; Cmd+R renames; I is the eyedropper; ⇧A adds auto layout (help 30925881896727, 360040328653; UI3 guide 2025-03-25, primary).
- 'Speed is a feature' (blog, 2024-10-01).
- **Juno today:** - Existing shortcuts: ⌘Z/⇧⌘Z, ⌘D, ⌘G/⇧⌘G, ⌥⌘K, ⌘A, ⌘[ ⌘], nudging, and tools V F R O L T I (design-editor.tsx:410-516).
- Missing:
  - ⌘C/⌘V/⌘X (copy is a context-menu list of ids);
  - Space/H to pan, and zoom keys;
  - Enter/⇧Enter to move through the hierarchy;
  - Shift to lock an axis;
  - Alt-drag to duplicate (Alt pans instead).
- Escape commits in six fields and renames on the server (M48).
- Tool keys ignore readOnly (L69).
- ⇧⌘G does not ungroup a single group (L52).
- On Mac, ⌘Z works only when the web view has focus, and the Edit menu isn't wired.

### R-063 · Keyboard and screen-reader contract for the panel and the canvas [editor]
`P1` · effort M · web, mac · editor · depends on R-061, M22, M23, L58, L60, L66, E6 (mac)
- **Build:** Panel:
- role=region, with aria-label '{Kind}: {title}'.
- Opening it by hand focuses the heading. Auto-open does not move focus.
- Esc closes nested layers first, then the panel. Focus returns to the card's Open button or the composer.
- Fullscreen traps focus, and Esc exits it.
- F6 cycles transcript → panel → composer. Inside the editor it cycles toolbar → layers → canvas → inspector → timeline.
- ⌥[ and ⌥] step versions. ⌘⇧A ('Ask about selection') reaches the selection toolbar (M22).
- All of these appear in the shortcuts sheet.
Canvas:
- The global focus-visible ring, as an inset variant (L66).
- A polite live region announces the selection, for example 'Rectangle Card bg, 320 by 180, in frame Hero'.
- A keyboard marquee on ⌥Space: the arrows move it, ⇧ moves ×10, and Enter selects.
- Rail tabs become role=tablist.
- Disabled buttons are wrapped so their tooltips still show (L60).
- Frame titles use muted-foreground at 4.5:1 or better (L58).
- The layers tree stays the primary screen-reader view.
- An optional 'Show property labels' setting.
Mac:
- Esc closes the dock, and @FocusState returns focus to the card.
- View menu: Show/Hide Canvas, Previous/Next Version, Expand.
- A keyboard alternative for the dock's resize handle.
- **Why:** Keyboard and screen-reader users can open, use and leave made things without getting lost (WCAG 2.1.1, 2.4.3).
- **Reference:** - Claude's panel is a region labelled 'Artifact panel: {title}'. Escape closes it unless a popover is open, and focus returns to the trigger or the composer (observed in the shipped Claude desktop app, primary).
- Figma keyboard-only use: ⌥Space draws a keyboard marquee, Tab moves through children, F6 goes to the toolbar, and there is a screen-reader preference (help 360040328653, primary).
- **Juno today:** - There is no focus management. Opening below the split drops focus to the body; fullscreen is aria-modal with no focus trap; closing returns focus nowhere (M23; canvas-panel.tsx:786-788).
- The Ask/Modify toolbar is unreachable by keyboard (M22).
- Esc closes the thought dock but not the Canvas.
- The canvas is role=application with its outline removed (L66). Rail tabs are aria-pressed buttons.
- Disabled keys never show tooltips (L60). Keyframe diamonds cannot be operated (E6).
- Frame titles are about 2.1:1 in dark mode (L58).
- On Mac, Esc doesn't close the dock, and there are no menu commands.

### R-064 · Scale without a lock: size checks, an asset store, and limits that explain themselves [rest]
`P1` · effort L · web, mac, iphone · performance · depends on R-005, X-08, X-09, X-30, X-33, M12, M60, L24
- **Build:** Limits:
- Check the size after expansion (X-08).
- At 80%, the header shows a quiet note: 'Large design · 164k of 200k'. Numbers only, no meter. It offers 'Move images to asset storage' and 'Split page into a new design'.
- At 100%, never lock the design. Refuse only the save that would exceed the limit, and say why. Edits stay local, and undo and split still work.
Assets: an external, content-addressed asset store with capability-scoped URLs. Images are downscaled on the client to twice their placed size. Paste and drop work.
Loading: pages and version bodies load on demand. By default, fetch metadata plus the current body only (X-30).
Rendering: a per-node SVG memo keyed by node revision. Playback updates only the animated nodes (L24).
Telemetry: document size, op latency p95 and render ms per frame (R-020).
- **Why:** Big designs keep working, and every limit comes with a way forward.
- **Reference:** - Figma allows 2 GB per tab. It shows a red alert at 90% that can't be dismissed, and locks the file at 100%, which then needs recovery mode. Pages load on demand (help 360040528173, primary).
- Figma has a WebGPU renderer with a WebGL fallback (blog, 2025-09-18).
- Users report Figma using 12 GB of RAM (forum, 2025-11-16).
- **Juno today:** - Each document is capped at 200k characters, and images up to 96 KB are inlined as data URLs (use-design-document.ts:560-608).
- Compact bodies expand 5-11× with no second size check. After that, every edit is refused (X-08) and the native library goes blank (X-09).
- Every read ships every version (M12, X-30).
- Playback re-renders the whole page SVG (L24).
- One failed save wipes undo (M60).

### R-066 · One export sheet with honest losses and native saves, plus 'Build it with Juno Code'
`P1` · effort M · web, mac, iphone · export-handoff · depends on R-008, R-014, X-23, M43, M7 (mac), L25, L67
- **Build:** The sheet:
- 'Export ▸' in the surface overflow opens a sheet generated from the registry's exporters.
- Scope is a segmented control: Selection · Frame · Page · All frames. It defaults to the current frame and never narrows silently (L67).
- Groups:
  - Image: PNG @1x/2x/3x, SVG;
  - Document: PDF, one frame per page;
  - Code: HTML prototype, React, SwiftUI;
  - Data: tokens, JSON;
  - Office, for Docs and Decks.
- Every loss is listed before download: '3 things won't carry over: …' (L25).
Build it with Juno Code (the primary action):
- It opens a Code session seeded with the handoff bundle (a README with intent, interactions with duration and easing, tokens, and per-frame PNGs), or with the page source.
- The session links back to the artifact: 'From design: Sign-in v7'.
Fixes:
- X-23: use an RFC 5987 filename*.
- M43: keep PDF alpha and text.
- M7 (mac): Mac and iPhone route exports through the host (NSSavePanel or the share sheet) over the bridge.
Pages must declare downloads rather than trigger them.
Make the Juno Code path excellent before adding any partner connectors.
- **Why:** A design or page leaves Juno in a usable format, or goes straight into a real build, with no surprises about what was lost.
- **Reference:** - Claude Design exports .zip, PDF, PPTX and standalone HTML (Google Slides only in the standalone app). It offers 15 'Send to' destinations and hands off to Claude Code or a local agent (help 14604416, primary).
- Each Claude artboard exports as PNG or PDF (code docs).
- Anthropic: 'a handoff bundle that you can pass to Claude Code with a single instruction' (anthropic.com, 2026-04-17).
- Builder.io: developers 'recreate implementation from scratch' (secondary).
- **Juno today:** - The editor's Export menu has 9 formats and silently narrows to the selected layer (design-editor.tsx:298-345,656-682; L67). It shows only the first unsupported note (L25).
- Exports return 500 on names with characters above U+00FF (X-23).
- PDF drops alpha and text styling (M43).
- Every Export item fails in the Mac and iPhone editor, because of connect-src 'none' (M7 mac).
- Nothing consumes the handoff bundle (export.ts:1685-1851). The Mac launcher promises 'hand to Juno Code' with nothing behind it (DesktopDesignScreen.swift:297-299).
- Code export is absolutely positioned.

### R-077 · Keep inline visuals: save as artifact, copy as image, and render them in shares
`P2` · effort M · web, mac, iphone · export-handoff · depends on R-012, R-016, X-01
- **Build:** Actions:
- Every inline block, chart and diagram gets a ⋯ button revealed on hover (32px, with a tooltip):
  - Copy as image (2× raster);
  - Download SVG or PNG;
  - Open as artifact: promotes the block to a MARKDOWN, MERMAID or SVG artifact at v1, with origin 'promoted' and derivedFrom set to the message. It opens in the panel using the R-070 morph.
Share pages render a static version of every block for every viewer:
- a quiz shows its question and options, with answers hidden;
- a step lab shows step 1 and 'n steps';
- Mermaid is rendered on the server.
Rules:
- The host keeps expansion. Model content never controls display mode.
- Inline means an ephemeral explanation. An artifact means something to keep.
- BUILD replies stay free of blocks, and every visual must teach something concrete.
- **Why:** A good diagram is never lost to scrollback, and a shared link shows everything the sender saw.
- **Reference:** - Claude's inline visuals are 'temporary', with Copy as image, Download (.svg/.html) and Save as artifact. They don't render in Claude's phone apps, or for logged-out and Cowork share viewers ('Interactive visual hidden when shared') (help 13979539, 2026-04-22; observed in the shipped Claude desktop app, primary).
- On HN, visuals raise 'perceived confidence … but [don't] do much for correctness' (HN 47352751).
- **Juno today:** - Typed ':::' blocks, inline Mermaid and juno-visual render natively on Mac and iPhone, which is ahead of Claude. But they can't be listed, kept or exported (00-AUDIT §4.2).
- Shared chats omit them (shared-chat-transcript.tsx:70).
- Inline Mermaid is dead on the web (X-01).
- A host-level 'Focus' expand exists (inline-visual-block.tsx:293).

### R-078 · 'Turn into…': linked conversions that know when their source has changed
`P2` · effort M · web, mac, iphone · merge-core · depends on R-029, R-030, R-058, R-059, M72, M1
- **Build:** - '⋯ › Turn into ▸' offers Deck, Doc, Design, Page and Diagram. It also appears in Made here, and in the Make menu while an artifact is in view.
- The result is a new artifact with derivedFrom {artifactId, version}. Its header shows 'From Q3 plan · v4', which opens the source.
- When the source moves ahead, the chip adds 'Source updated · Review'. Review runs the update as suggestions (R-030), never as a silent regeneration.
- Both artifacts share the default design system.
- Motion: the new artifact settles with one highlight. 'Source updated' cross-fades in, with no pulse.
- **Why:** A plan becomes a deck or a site in one move, and stays visibly connected to its source.
- **Reference:** - Gemini Canvas's 'Create' turns a document into a web page, infographic, quiz, Audio Overview or slides, as one-way copies (support.google.com/gemini/answer/16047321, primary).
- Claude can turn a doc into Slides, and its launch blog says the report and slides 'already match' (help 16923645; blog 2026-09-16).
- NotebookLM regenerates per-slide feedback as a new deck (2026-03-20).
- **Juno today:** - Conversions happen only through prose.
- Markdown → pptx is a file export, not an editable deck.
- Work's presentation spec is thrown away (M72).
- Artifacts carry no provenance linking them to each other.
- Research reports reuse a fixed identifier and overwrite each other (M1).

### R-079 · 'Made here': one small index of everything a conversation produced [Turn into]
`P2` · effort M · web, mac, iphone · ia-navigation · depends on R-078, R-029, X-25
- **Build:** - Rename it 'Made here', one noun, and keep it a popover from the conversation header.
- At the top, five create tiles: Doc, Deck, Design, Page, Diagram. A tile only prefills an editable composer prompt with the type armed (R-028). Nothing runs without Send.
- Below, outputs grouped by type, with counts and several per type. Include WorkArtifact deliverables and images, which fixes the dead pointer in X-25.
- A generating row reads 'Writing', with a percentage only when one is real. The row is clickable, and the rest stay usable.
- Row ⋯ menu: Open, Turn into…, Revise with settings (a small form per type that produces a sibling branch), Share, Delete.
- Mac: the Liquid Glass Outputs popover adopts this. iPhone: a sheet from the title.
- Motion: pops in from its trigger, rows rise in (stagger capped at 8), and a new output enters via layout with a one-shot bg-selected fade.
- **Why:** Everything a chat produced, deliverables included, sits in one small place, and the next output is one tap away.
- **Reference:** NotebookLM Studio puts creation tiles on top and several outputs per type below, and one output can be used while another generates (blog.google, 2025-07-29, primary). Its tiles start generating as soon as they are tapped.
- **Juno today:** - session-outputs.tsx is a good index that needs no fetch, and it has 'Used in this session'. But its labels disagree with /artifacts (00-AUDIT §5).
- Deliverables are missing from it, even though the stage points users there (X-25).
- It has no way to create anything and no generating state.

## Phase 6 — People (W24–W33)

### R-039 · People access: view, comment and edit grants, project inheritance, and Request access
`P1` · effort L · web, mac, iphone · sharing-governance · depends on R-004, R-011, R-015, 00-AUDIT §12.8
- **Build:** Data:
- ArtifactGrant(artifactId, principal user|pending email|project, role VIEWER|COMMENTER|EDITOR, grantedBy, createdAt, acceptedAt, expiresAt for pending invites).
- ProjectMember roles become a validated enum.
Two access states:
- In a project: 'Inherited: people in <Project> can open it'.
- Otherwise: 'Limited: only people added here'.
Share › People:
- An invite field that autocompletes project members, and a role select.
- 'Who has access': the Owner, a collapsed 'From <Project> · 4 people', then individuals, each with a role menu and Remove.
- A link line: 'Only people with access', or '…can comment (sign-in required)'.
- Grantees get live links that follow the latest version.
- At most 50 invites per artifact; pending invites expire after 30 days.
- 'People you invite' is offered on every plan.
Request access:
- A signed-in person without access sees one tile, 'You need access', and 'Request access' with an optional note.
- The owner gets a Needs-you row and an email (R-042), and an accent dot on Share until they handle it: 'Ana asked to comment · Allow as commenter / Deny'.
Enforcement:
- One helper, canAccess(artifact, user, action), used by every artifact, design and comment route.
- Only the owner publishes, deletes or changes access.
- No seat gate. Plan limits are quotas on the owner.
- Runtime capabilities (R-076) run as the viewer, and such artifacts cannot use 'Anyone with the link'.
Concurrency in v1: keep per-revision compare-and-swap, and show a soft lease ('Maya is editing Hero') instead of multiplayer cursors. Presence is R-074. Correct the 'stable' CRDT claim in capabilities.ts.
Motion: new person rows rise in, role changes cross-fade, and removals fold with Collapse.
Sync: add artifact_grant to the native sync allowlist before the server emits it.
Priority: P1. FIA-10 said P1; CA-19 and CM-13 said P2. Comments (R-040) and the phone contract need the commenter role.
- **Why:** Share with a colleague or client so they can look, comment or co-edit, without making anything public.
- **Reference:** - Claude's roles by type: Design and Slides can view, comment or edit; Docs can view or edit (help 9547008, primary).
- Claude caps email invites to outsiders at 50 per artifact, and pending invites expire after 30 days (help 16989529).
- A shared Claude artifact 'uses the viewer's own connectors and access' (help 14729249). Pro and Max plans share only by public link (help 16923645).
- Figma has had Inherited vs Limited access since 2026-08-03, and Ask to edit shows a red badge on Share (help 35361119554711, 4408435431319, primary).
- The separate seat and file-permission gates are the top 'I can't edit' cause in Figma (forum, community).
- **Juno today:** - Every artifact and design route authorises only through conversation.userId (00-AUDIT §12.8).
- ProjectMember's role is an unvalidated string, with no UI and no invitation (members/route.ts:36-43; schema.prisma:595-609).
- There is no commenter role.
- crdt.ts is text-only and unused, yet capabilities.ts lists 'Canvas CRDT Collaboration' as stable.

### R-040 · Comments in their own table: anchored per kind, aware of versions, honest about lost anchors
`P1` · effort XL · web, mac, iphone · collaboration · depends on R-005, R-013, R-037, R-039, X-06, 00-AUDIT §12.1, 00-AUDIT §12.6
- **Build:** Storage:
- An ArtifactComment table, outside the version body: id, artifactId, threadId, parentId, authorId, body (markdown, at most 4 KB), images (at most 5, in the asset store), anchor JSON, createdOnVersion, snapshotKey (a PNG crop at comment time), resolvedAt/By, deletedAt, toJuno, sentAt, junoTurnMessageId, producedVersion.
- Migrate existing DesignDocument.comments into rows.
Anchors per kind, from the registry:
- DESIGN: {pageId, frameId, deepest nodeId, dx, dy, region?};
- Doc and Markdown: {quote, prefix, suffix};
- Code: {startLine, endLine, contentHash};
- Page: {cssPath, xpath, textQuote, viewport, point%};
- Deck: {slideId, elementId, x, y};
- Graphic and Diagram: a region;
- Motion: {animationId, timeMs} (R-087).
Re-resolve anchors on every version:
- exact match: nothing to show;
- fuzzy match: 'Moved';
- unresolved: Lost, with 'Re-attach' or 'Make general'.
- A deleted node's pin moves to its parent frame, marked '(element removed)'.
UI:
- A Comments toggle in the header shows the open count.
- C enters comment mode: the cursor becomes a pin, tools go inert, and Esc exits.
- A click drops a numbered pin. A drag draws a region (accent hairline, 6% fill).
- A composer popover opens at the pin, with @mentions and image paste. ⌘↵ sends; Esc keeps the draft.
- A right rail (a sheet at narrow widths, a bottom sheet on phones) with filters (This version/All, Open/Resolved/Lost, Mine), search, and sorting by position or date.
- ⇧C hides pins. Pins show only in comment mode; otherwise the rail shows a count.
- Resolve is a check. Delete is soft: the author gets a 10 s Undo, and the owner can restore.
Reliability:
- Writes are optimistic, with retries and a persisted local draft. A comment is never lost.
- Public snapshots carry no comments, and comments are never deleted to go public.
- Guest comments on public links stay off (governance).
- Rate limit: 100 per hour (R-011).
- Add the artifact_comment sync entity to the allowlist first.
Platforms:
- Mac and iPhone: a bridge comments channel for the hosted editor, and native rails elsewhere.
- iPhone: long-press, then 'Comment here'.
Motion:
- A pin pops in (scale 0.8→1, ease-spring, duration-base), and the composer pops from the pin.
- Picking a thread moves the camera (ease-in-out, duration-slow), and the pin shows one accent ring that fades over duration-emphasis.
- Resolving fades and scales the pin to 0.9 (duration-exit) and folds the row.
- Reduced motion: the camera jumps, and everything else fades.
Resolution: anchor to the deepest node that still exists, which is better than Figma's top-level-only pins. Comments live in their own table (owner Q5).
- **Why:** Feedback stays on the exact thing it is about, survives edits and versions, and works for every kind of artifact.
- **Reference:** - Figma: C enters comment mode; a click pins and a drag makes a region. Pins attach only to the top-level frame, a long-standing complaint. Up to 5 images, 100 comments per hour, and deletion is permanent (help 360041068574, 360041547593, primary).
- Figma Make captures a screenshot with each comment and groups comments by version (help 38701587731735).
- Lovable pins show when their reference was lost after a layout change (docs.lovable.dev/features/project-comments, 2026-04-02, primary).
- Claude Design comments 'sometimes do not persist' (help 14604416, primary).
- Claude Docs allows up to 1,000 threads per doc, 100 comments per thread and 4 KB per comment (topic.comments, first-hand).
- **Juno today:** - DesignComment lives inside the DesignDocument JSON as {nodeId|null, pageId, x, y, body, resolvedAt, transactionId} (types.ts:738-752).
- No operation, UI, API or sync entity writes it, and a chat re-emit would drop it (X-06).
- No other kind has comments.

### R-041 · Send comments to Juno: a thread becomes a turn, and the reply and new version come back to it
`P1` · effort L · web, mac, iphone · ai-editing · depends on R-040, R-010, R-027, R-036
- **Build:** Sending:
- Editors use 'Ask Juno' in the thread footer, or '@Juno' in a reply. Commenters get 'Suggest to owner'.
- Each open thread has an 'Include in Juno's next edit' option. The rail footer's 'Send 3 to Juno' batches the selected threads into one turn.
- Queued notes appear as a chip above the composer: '3 notes · Send to Juno'.
- A send adds a user turn to the made-in conversation (created lazily, R-027), carrying {artifactId, version, anchor, quote or node ids, crop}.
- The transcript shows a quoted chip that links back: 'On Hero · v11: Make the CTA quieter'.
Juno's answer:
- It arrives as a proposal (R-010, R-030).
- On Apply, the version records producedVersion, and Juno replies in the thread: 'Done in v12: the CTA now uses the secondary style · View change · Undo this'.
- A person resolves the thread. 'Resolve when applied' is an option, off by default.
- When an editor sends while the owner is away, a background turn proposes a new version. It is never applied for a non-owner, and it posts 'Juno proposed v8 · Review'.
- Juno's own comments: when it makes a judgment call or needs a fact it doesn't have, it leaves an unresolved comment marked Juno.
While working:
- The pin ring breathes (only while live), and the thread reads 'Juno is working · Stop'. Under reduced motion, it shows 'Working' instead.
- On resolve, the pin swaps to a check (IconSwap), holds 1.5 s, then fades.
Limits: rate-limit Juno's replies per artifact per hour. Only Send is metered (R-036).
iPhone: the same action works from a push quick reply (R-042).
- **Why:** Review becomes the way to edit: point at five problems, send once, and see each one answered and undoable in place.
- **Reference:** - Claude: a comment 'sent to Claude' arrives in the session as a turn, and Claude answers in the thread. Only editors can send, and auto-replies pause after 60 per artifact per hour (claude-primary-evidence.md; code docs, primary).
- Claude Docs: @Claude replies, edits and explains, and Claude leaves its own comments while drafting (help 16923645).
- Figma Make's 'Annotate for agent' submits numbered callouts together as one prompt (blog 2026-07-30, primary).
- Figma's agent acts on comments only when asked from its chat.
- **Juno today:** - DesignComment.transactionId is documented as 'when it was sent to Juno as an edit request' (types.ts:748-751), but nothing writes it.
- Ask Juno edits are never written to the transcript.
- The Mac has no Ask Juno.

### R-042 · Notifications for comments, access requests and finished artifacts, where people already triage
`P1` · effort M · web, mac, iphone · collaboration · depends on R-025, R-039, R-040, X-25, X-27, X-28, X-29, M71
- **Build:** Events, stored in the existing Notification table:
- a mention;
- a reply in my thread;
- a new thread on my artifact;
- an access request, or access granted;
- Juno finished a comment request;
- an artifact finished in a run or a long generation ('Your deck is ready: Q3 pipeline (12 slides)').
Delivery:
- Web and Mac 'Needs you' fold: artifact rows with the title and one trailing signal ('2 comments', 'Access request', 'Ready'). A row opens /a/{id}?comment=… and marks the notification read.
- iPhone: push through APNs, with Reply and, for editors, Ask Juno actions.
- Email: a 30-minute digest grouped by artifact.
Settings:
- Per artifact, in the rail's ⋯ menu: All activity (the owner's default), Mentions and replies (the default for others), or Off.
- An account default in Settings › Notifications.
Runs:
- A run's final card lists what it made as artifact rows (poster, type, Open).
- An artifact opened mid-run shows 'Juno is still working: section 3 of 6', with pending sections read-only.
- When it finishes, the status dot stops and 'Writing' swaps to a check (IconSwap).
Motion: the fold appears with Collapse, rows rise in, and counts cross-fade. Nothing pulses.
- **Why:** Collaborators hear about feedback where they already triage, and a 'deck is ready' notification opens straight to the deck.
- **Reference:** - Figma notifications are set per file (Everything / Mentions and replies / Nothing). Comment emails go out every 30 minutes, the in-app bell holds 50, and there is push and a mobile quick reply (help 360041547813, 1500007537281, primary).
- Claude cloud sessions notify the phone when a task finishes or needs input (claude.com/blog/cowork-web-mobile, 2026-07-07; help 15520349, primary).
- **Juno today:** - A Notification model and /api/notifications exist, but no client reads them (schema.prisma:612-627).
- APNs is wired (apns.ts), but iOS sends notifications only for Code.
- TWO_PRODUCTS §2.2 rules out an inbox. Triage lives in the sidebar's 'Needs you' fold (app-sidebar.tsx:296-306).
- Only the newest task's newest previewable file is staged (M71).
- Word and PowerPoint deliverables cannot be reached on the web (X-25). Native tasks cannot be reached on the web (X-29), and native lists drop cloud deliverables (X-27, X-28).

### R-043 · Tweaks: lasting controls on the artifact, suggested by Juno, that never call the model
`P1` · effort M · web, mac, iphone · editor · depends on R-010, R-012, R-017, X-14, L56
- **Build:** Data:
- DesignDocument.tweaks: TweakDef[] {label, control slider|number|colour|segmented|toggle|font, binding, min/max/step}.
- A binding points to a variable (preferred) or else to a list of node properties.
- Requires a schemaVersion bump and a Swift mirror generated from the schema (X-14).
- New bindable properties: layout.gap, padding, typography size and weight, and variable values.
Where tweaks come from:
- Juno proposes 2-3 with every new design, for cross-cutting properties such as spacing, colour and layout (the levers Anthropic's launch post names), not for copy.
- 'Keep' turns a Tune adjustment into a tweak.
- 'Pin as tweak' on any inspector field.
- 'More tweaks' asks Juno.
Each tweak binds a set of properties no other tweak touches. When one overrides another, it says so ('Overridden by Accent').
Panel:
- A 'Tweaks' header toggle opens an overlay-glass card anchored bottom-right: 280px wide (the inspector width, R-017), collapsible sections, draggable header.
- Under 600px, or on phones, it becomes a bottom sheet. For editors it is also the first section of the inspector.
- Dragging previews at pointer speed, with no transition and no network call.
- Releasing commits one transaction. Closing the panel leaves one undo step. Reset reverts.
- 'Apply across design' sends the change to Juno.
Page artifacts: tweaks are declared with data-juno-tweak or a JSON manifest, bound to CSS custom properties, and set live by the sandbox bridge. Releasing commits one patch to the declared defaults.
Tweaks appear in the agent context, so 'make it warmer' can move a tweak. Tweaks are never metered.
Motion: the panel pops in from the toggle (duration-base, ease-spring). The segmented thumb uses ease-out-back (duration-fast).
Resolution: the panel uses Juno's overlay-glass material.
- **Why:** 'How round?' or 'how dense?' becomes a drag, not another prompt, and costs nothing.
- **Reference:** - The Claude Design launch offered 'custom sliders (made by Claude)' and 'adjustment knobs to tweak spacing, color, and layout live' (anthropic.com, 2026-04-17, primary).
- In Claude's Design type, each artboard declares its tweaks as typed data-props, which the editor shows as levers (claude-primary-evidence.md, primary).
- A reviewer: 'Sometimes tweaks are mutually exclusive, and not all permutations actually react' (Builder.io, 2026-04-29, secondary).
- Figma has generative plugins and shader controls (help, Config 2026, primary).
- **Juno today:** - DesignAdjustments ('Tune Juno's change') offers slider, colour and segmented controls, at most 6. They cover 7 numeric properties, fills.0.color, variants and variable modes (design-adjustments.tsx; ai.ts:47-77).
- They appear only after an Ask Juno proposal, only in /design, and are dismissed along with it.
- Sliders have no live preview and commit duplicates (L56).
- The Mac has none.

### R-069 · The phone contract: view, Play, comment, ask, tweak and make small edits, stated honestly
`P1` · effort L · iphone, web · mobile · depends on R-002, R-016, R-040, R-043, R-057, X-11, X-15, X-16, M13 (mac), M57, M58
- **Build:** Write one phone contract, covering the iPhone and phone-width web, into the help pages and in-app copy. App Store screenshots show only what works.
v1, what a phone can do:
- open any artifact from its link, full-bleed, with pinch and pan;
- step through versions;
- Play prototypes and Present decks;
- comment with long-press or tap pins (0.4 s, medium haptic);
- select, then Ask by voice or text, with the selection chip;
- apply tweaks, in a sheet with medium and large detents;
- edit text in place (Docs, and design text layers by double-tap);
- reorder and hide slides and layers;
- replace an image from Photos;
- change share settings and revoke links;
- get notified when a turn finishes.
v1.1, once touch pan and pinch land in the editor (M57):
- tap to select, drag to move, and colour from tokens, on designs;
- one-finger pan on empty canvas, and a long-press menu.
Desktop and iPad only, said in one line rather than shown as a disabled toolbar: drawing, resizing, auto layout and keyframe tracks. The full editor appears only when the container is 768pt or wider.
Layout:
- A bottom bar: Play · Comment · Tweaks · Ask (44pt targets).
- The inspector and layers are bottom sheets (animate-sheet-in, ease-drawer).
- The selection bar sits above the keyboard.
- On phone-width web, the Canvas is a bottom sheet with a 44px grab handle. It follows the finger and settles at 50% or 92% (duration-slow, ease-drawer).
Saving:
- Saves go through transactions with autosave.
- Drafts are kept per (artifact, base version) and never cleared silently: 'Updated to v8 · Keep my edits on top / Keep as a copy'.
- This lifts R-002's guard.
Resolution: this sequencing honours both views. FIA-15 and FIG-19 wanted editing through fields and Juno; CM-20 and CUX-20 wanted direct moves. Fields and Ask come first, direct moves after M57.
- **Why:** The 'open it on your phone' promise holds. People can review, comment and fix a detail without a laptop, and know exactly what works there.
- **Reference:** - Claude's help says Design, Docs and Slides are view-only on phones: 'Editing on the canvas and changing sharing settings need Claude on web or desktop' (help 14604416, 16923645, 9547008, primary). Yet the launch blog promised 'one shareable link you can open on your phone', and TechCrunch said users can 'edit them on their phone' (2026-09-16).
- Figma's mobile app cannot edit Design or Slides files, but can comment with a long-press and run prototypes (help 1500007537281, primary).
- Figma Buzz lets marketers edit only approved fields.
- The Claude Docs viewer ships a BottomSheet module.
- **Juno today:** iPhone:
- The library edits the latest design through the generic POST and drops drafts when a remote version arrives (JunoMobileWorkspaceViews.swift:2062-2068; M13 mac).
- The inline viewer is read-only (JunoMobileDesignArtifact.swift:408) and cannot open chat-made designs (X-11).
- Native apps cannot share artifacts.
Phone-width web:
- No touch pan or pinch (M57), and the canvas collapses to 0px (M58).
- The Canvas replaces the chat below 50rem.
- The history rail is a fixed w-48.

### R-073 · How this was made: provenance for every version, with the conversation private by default
`P2` · effort M · web, mac, iphone · collaboration · depends on R-005, R-022, R-039
- **Build:** Info (⋯ or a rail tab):
- 'Made in <chat>' as a link, 'In <Project>', the owner, the creation date, the version count and the published state.
'How this was made', in the version popover:
- the author: You, Juno plus the model, Restore, or a collaborator;
- the turn, with View in conversation;
- the sources and files used;
- the tools that ran: search, Python, connectors;
- how fresh the data behind charts is.
Data visuals get a 'Data from …' chip in the chrome. Record provenance for Work deliverables too.
Conversation privacy:
- Sharing the artifact never shares its conversation.
- A switch in People, off by default: 'Let people with access read the conversation that made this'. When on, grantees see a read-only transcript, and only the owner can continue it.
Activity pane for grantees:
- versions;
- the artifact-scoped Juno turns that produced them, meaning on-canvas prompts and comments sent to Juno, never the private surrounding chat;
- comment threads.
Roles: commenters can ask Juno and see proposals, but Apply is disabled ('Only editors can apply'). When the artifact is shared, the on-canvas prompt says 'Visible to people with access'.
- **Why:** Collaborators can see why a design changed and where a chart's data came from, and private chats are never exposed by accident.
- **Reference:** - Claude Science's artifact menu has Provenance (Messages, Code, Execution Log, Environment, Review) and View in context (docs, primary).
- Claude Docs attributes each change to a person or to Claude (help 16923645).
- Figma made new agent chats visible by default on 2026-06-23, while its own help pages disagree on who can see them. View, Dev and Collab seats can chat but not edit (help 41272399602583, 37998629035799, primary).
- On HN: 'A slick presentation can distract people from … the accuracy of the underlying data' (HN 47352751).
- **Juno today:** - ArtifactVersion has no messageId, author or run id, and 'generated' is also written for designs started by hand (00-AUDIT §5).
- Work provenance is modelled but never written (work-runner.ts:1826).
- The Mac library cannot open the conversation an artifact came from.
- Ask Juno edits never reach a transcript.
- ProjectMember has no UI.

### R-074 · Presence, async first, with Juno as a participant [part: soft leases and presence]
`P2` · effort L · web, mac, iphone · collaboration · depends on R-039, R-018, R-011
- **Build:** Phase 1, async:
- A header stack of up to 3 avatars plus '+2', showing grantees who opened the artifact in the last 30 days (ArtifactOpen).
- A popover lists 'Viewing now' (a 30s heartbeat while visible, 60s TTL) and 'Viewed 2h ago'.
- Only signed-in grantees are named. Public visitors stay an aggregate count.
- Setting: 'Show when I've viewed shared artifacts', on in projects and off elsewhere.
Phase 2, live:
- Each viewer's selection shows as an outline in their colour, with a name tag.
- Cursors appear only in Edit mode, at most 20Hz, and only when two or more people are editing.
- Juno appears as a participant with its own colour while a proposal is live: 'Juno is editing Hero'.
- Follow draws a 2px ring in the leader's colour around the canvas, with a banner. The camera behaves as in R-070.
- Concurrent edits rebase operations on the server. The last write wins per property, with a note such as 'Anna changed this too'.
Motion:
- Avatars fade and scale from 0.8 to 1 (ease-spring, duration-base), leave on duration-exit, and reflow via layout.
- 'Viewing now' is a static ring, with no pulse.
- Remote cursors move on spring.interactive and fade after 10s idle.
- **Why:** People can see whether a reviewer has looked, and what Juno is touching, without chasing anyone.
- **Reference:** - Figma's viewer history shows 'Currently viewing' and 'Previously viewed' for signed-in members (help 29638316371479, primary). Following someone outlines the viewport in the leader's colour, and there is cursor chat (help 360040322673).
- Claude's room capability carries presence and cursors, with agent sessions joining as marked agents (claude-primary-evidence.md).
- Claude Design's help says multi-person editing 'may not work reliably' (help 14604416).
- **Juno today:** - There is no presence anywhere.
- Share.views counts owners and bots (share.ts:157).
- crdt.ts is text-only and unused, even though it is marked stable.
- Transactions already carry a base revision with a 409 guard.

### R-075 · Duplicate, make a copy, continue in a new chat, pin, and attach by reference [rest]
`P2` · effort S · web, mac, iphone · ia-navigation · depends on R-004, R-018, R-039
- **Build:** Row and overflow actions:
- Duplicate (owner or editor): creates 'Copy of <title>' in the same project, with the current version only and no comments, shares or conversation. Info reads 'Duplicated from <title> v12'.
- Make a copy (signed-in viewers of a grant or a published page): the copy lands in their Artifacts, marked 'Copied from <owner>'s <title>'. A per-link 'Allow copies' setting is on for grants and off for public links.
- Duplicate as new artifact: on a version row.
- Continue in a new chat: starts a conversation whose first context is the artifact digest. The artifact is linked, not copied.
- Pin to sidebar: uses ArtifactPin and shows as a plain text row in the Pinned fold. A filled pin means pinned.
Forking a conversation carries its artifacts along by reference.
Composer: '+ › Add from Library' gains a 'Made' tab. Picking an artifact attaches a reference chip, pinned to its version at send. Juno reads the current body and edits that artifact, or offers 'Make a copy here'.
Motion: a new row rises in, with one highlight that fades over duration-emphasis.
- **Why:** People can branch an idea, reuse someone's work, or bring something they made into a new chat, without touching the original.
- **Reference:** - Figma offers Duplicate, and Duplicate to drafts for viewers. Copies are named 'Copy of …' and carry no comments or history, and Community copies get no updates (help 360038511533, 360038510873, primary).
- Claude had Remix (2024) and today offers 'Build on a published artifact' by copying it into a new chat. Artifacts can be pinned to the sidebar (help 9547008; Artifact tool contract).
- ChatGPT has 'Add from library' in the composer (help snippet).
- **Juno today:** - There is no duplicate or remix (01-AUDIT-WEB §2.8).
- Forking a conversation drops its artifacts (fork/route.ts:17-27).
- The sidebar has Pinned folds for projects and chats, but not for artifacts.
- The composer's Library picker attaches only IMAGE and FILE items, as server clones (library-picker.tsx).

## Phase 7 — Design systems and beyond (from W34)

### R-044 · Visual property editing for Page artifacts: staged edits, a DOM tree and one Apply
`P1` · effort L · web, mac · editor · depends on R-012, R-030, R-037, M22
- **Build:** Editing:
- In Select mode (R-037), a Page gets a properties rail built from the design inspector's primitives: Layout, Size, Typography (from a family list), Fill, Border, Radius, Shadow, Opacity.
- A Tree tab shows the DOM, with actions such as 'Select all 6 matching .card'.
- Each change applies live through juno:tweak {selector, prop, value} as a pending inline override.
Staging:
- A chip above the composer: '4 staged edits', with a list where each edit can be removed.
- Before/after (hold B) · Reset · Apply (⌘↵).
Apply:
- Literal text or style changes that map 1:1 to a Tailwind utility or CSS compile locally into an exact-anchor patch. No model call, and free.
- Anything else becomes one targeted-patch turn with the change list and crops, delivered as suggestions (R-030).
Esc leaves the mode, and the whole flow works by keyboard (M22).
Platforms: on Mac, a SwiftUI inspector drives the same bridge. The iPhone doesn't offer this and says why.
- **Why:** Nudge a generated page's spacing and colour by feel, and get clean code back in one step.
- **Reference:** - Figma Make's editor has an Edit button that opens a Figma-style properties panel and a DOM tree. Edits are staged above the prompt box and committed with Apply as a version (blog 2026-07-30; help, primary).
- Cursor's browser visual editor offers sliders, palettes, tokens, flex/grid controls and React props, then 'ask the agent to apply' (cursor.com/blog/browser-visual-editor, 2025-12-11).
- v0 Design Mode shows live pending edits, before/after, and one Apply (v0.app/docs/design-mode).
- **Juno today:** - HTML and React artifacts can be edited only as source, or by describing the change.
- The Canvas can pick one element into a quote (canvas-panel.tsx:705-740) for an exact-anchor patch (artifact-edit.ts).
- The design inspector's field primitives (inspector-panel.tsx, effects-panel.tsx) could be reused.
- There is no style bridge into the sandbox, and all of this is dead while X-01 stands.

### R-046 · Directions: several takes side by side, that the user can mix by name
`P1` · effort L · web, mac, iphone · editor · depends on R-029, R-033, R-036, R-009
- **Build:** Creating directions:
- Asking for options, or using a 'Directions ×3' stepper (1-4) on the prompt, builds a 'Directions' row: N sibling frames 80px apart.
- Each frame is backed by a branch (R-029).
- Each is labelled with a badge ('1a', '1b', '1c') drawn as canvas chrome, plus a model-given name ('Editorial', 'Dense').
- Typing '1b' in the composer autocompletes to a mention chip bound to that frame.
Badge menu:
- Keep: promotes the frame to main. The others move to a hidden 'Explorations' page and are never deleted.
- More like this.
- Compare, using the R-022 wipe.
Rounds:
- New rounds stack above, and earlier rounds dim to 60%.
- The reply ends with 2-3 follow-up suggestion chips.
Multi-apply: ⇧-click several frames and prompt once. This creates one proposal per frame, grouped in the review queue with 'Accept for all'.
Scrolling: the wheel scrolls inside a frame only while that frame is focused in Play; otherwise it pans the canvas.
Limits: each direction is metered as one message, and there are at most 4.
iPhone: directions appear as a swipeable carousel.
Motion:
- Frames stream in as in R-033.
- The camera fits the set (duration-slow, ease-in-out) only after 1.5 s idle.
- On Keep, the other frames fade out (duration-exit) while the kept frame stays still.
- **Why:** Compare real alternatives and combine the best parts by name, instead of describing them again.
- **Reference:** - Claire Vo called three variations 'Claude Design's smartest UX choice' (Lenny's Newsletter, 2026-04-22, secondary).
- Builder.io found Claude's multi-option view buggy and pan-only (2026-04-29, secondary).
- Google Stitch's Agent Manager explores several ideas in parallel (blog.google, 2026-03-18, primary).
- **Juno today:** - Ask Juno and chat each return a single proposal. Getting alternatives means duplicating by hand.
- Pages and side-by-side frames already exist (types.ts:777).
- The camera jumps when fitting to content.

### R-048 · Live components: instances inherit, properties come first, overrides survive, then slots
`P1` · effort XL · web, mac, iphone · design-system · depends on R-001, X-09, X-14, M38, L40
- **Build:** Phase A (P1):
- An instance is stored as {mainId, overrides: Record<mainNodeId, patch>} and resolved in layout, render and every exporter, so edits to the main propagate.
- Overridden fields show a dot, with 'Reset' per field and 'Reset all'.
- Instance inspector order:
  1. a Component card: main name, Go to main (⌥-click), Detach (⌥⌘B), Swap…;
  2. properties: variant dropdowns, boolean switches, text fields and instance-swap pickers;
  3. everything else.
- The main shows 'Used 12×', and 'Affects 12 instances' while it is being edited.
- Right-click a text layer → 'Make text property'.
Phase B (P2):
- A frame inside a component can become a Slot property.
- Hovering a slot on an instance shows a dashed canvas-selection outline with '+ Add', preferred components first.
- Min/max counts are hints that never block.
Implementation:
- Resolve variants lazily, never loading whole sets.
- Bump schemaVersion, and ship tolerant Swift decoding (R-001) before the server writes the new shape.
- **Why:** A component changed once changes everywhere, and Juno can edit one component instead of 40 copies.
- **Reference:** - Figma component properties (Boolean, Instance swap, Text, Variant, Slot) are shown first on instances, and 'Expose properties from nested instances' lifts nested ones (help 5579474826519, primary).
- Figma slots reached GA in 2026-06. Their min/max limits guide but never block (help 38231200344599).
- Figma loads every component in a set into memory (memory help).
- **Juno today:** - createInstance copies the main subtree once. Nothing that draws reads variantProperties or overrides (instances.ts:1-33).
- ComponentProperty cannot drive instance nodes.
- There is no create-variant, detach or go-to-main.
- Undo loses data for instance and component deletes and for variants (M38, L40).
- The Swift mirror would drop new fields (X-14).

### R-049 · Motion model v2: relative transforms, anchor points, incoming easing, holds, and one easing vocabulary [behind `design.schema.v2`]
`P1` · effort L · web, mac, iphone · motion · depends on R-019, X-14, M64, M65, L20, L21
- **Build:** Schema v2 channels:
- translateX and translateY are additive, so they compose with auto layout (fixes M64).
- rotate is additive.
- scale, scaleX and scaleY multiply around a per-node transformOrigin, centred by default (fixes L21).
- Absolute channels: opacity, radius, fill and stroke colour, blur, font size, letter spacing, padding, gap and stroke width.
- x, y, width and height stay absolute, and only on absolutely positioned nodes. On auto-layout children they are disabled with: 'Auto layout places this layer — animate Move instead.'
Easing:
- Easing moves to the incoming segment. Add hold.
- The first and last keyframes hold implicitly.
- A keyframe cannot sit past the end. Dragging past it extends the duration and shows a ghost end (M65).
- EasingCurve v2 is one of: {named} | {bezier} | {spring durationMs? bounce 0-1} | {hold} | {token alias}.
- The named list is Juno's ladder with readable names: Soft out, Strong out, Expo out, In, In-out, Back out, Spring arrival, Linear, Hold.
Springs:
- Standard (220 ms, bounce 0.05) and Emphasized (360 ms, bounce 0.1) are the product springs.
- Figma's names import as aliases: Quick 220/0.05, Gentle 360/0, Bouncy 360/0.25, Slow 560/0.05.
- Physical springs convert once (as physicalSpringToNormalized does) and are solved over the segment so they land exactly (L20).
One easing popover, used everywhere: keyframe segments, transitions, slide transitions and presets.
- A preset list with 24px curve glyphs. A dot runs the curve once on hover or focus.
- A 160×120 editor with bezier handles, or bounce and duration sliders for springs.
- Open it by clicking the segment between two keyframes. Right-click offers Copy easing and Paste easing.
- It uses animate-pop-in and animate-pop-out.
Inspector: a 3×3 origin picker, and Option+R to drag the origin crosshair. One origin (top-left) everywhere, with no mode-specific coordinates.
Migration, in migrations.ts:
- x/y tracks become offsets;
- each easing shifts one keyframe later;
- keyframes past the end are clamped, with a one-time note.
Generate the Swift mirror from the schema first (X-14).
Resolution: adopt incoming easing (FPM-04) and one spring form (duration plus bounce). This settles FIG-12's 'choose at v2'; Figma's names become aliases.
- **Why:** Animations stop depending on layout quirks or track order, match what Figma users expect, and behave the same in the editor, in product code and in SwiftUI.
- **Reference:** How Figma Motion works (figma-use-motion references; d.ts; help 41352588622615, 41414048690839, primary):
- translate and rotate add to the resting transform; scale multiplies it;
- opacity, radius, padding, gap and colour are absolute;
- a keyframe's easing controls the segment that arrives at it;
- the first and last values hold;
- there is HOLD step easing;
- springs are GENTLE, QUICK, BOUNCY and SLOW, plus CUSTOM_SPRING {bounce 0-1};
- the anchor point is edited with Option+R.
Figma's prototype transitions still use physical springs and cannot save curves (help 360051748654), so Figma runs two spring systems that disagree.
- **Juno today:** - There are 13 absolute properties, including x, y and scale (types.ts:695-711).
- Easing governs the outgoing segment (types.ts:714-716).
- Springs are stiffness/damping/mass, defaulting to 180/20/1 (types.ts:672; motion-panel.tsx:958-1041). Product motion uses duration plus bounce, matching SwiftUI (src/lib/motion.ts:110-122).
- x/y tracks fight auto layout (M64). Track order moves the scale origin (L21). Springs jump about 50% and export as ease-out (L20). Keyframes past the duration fold (M65).
- There are no presets, no curve editor and no Hold.

### R-050 · Variables bind to every field, timing and easing become tokens with modes, and a docked variables table
`P1` · effort L · web, mac, iphone · design-system · depends on R-049, L43, L44
- **Build:** Binding:
- Every bindable field gets a variable affordance at its trailing edge on hover: fill and stroke colour, opacity, radius, gap, padding, W/H, font size, line height, tracking, effect parameters, keyframe duration and easing.
- A picker is filtered by type and scope. A bound field shows a token pill (swatch plus name), with detach on hover.
- Type-check bindings (L43), and make geometry bindings real (L44).
Timing and easing tokens:
- Add timing and easing variable types, aliasable per mode. A bound field reads, for example, 'base · 220 ms'.
- New designs seed a 'Motion' collection from the default design system. For Juno's own system, that is Juno's ladder.
- Modes such as 'Calm' or 'Snappy' retime a whole design.
Pages: HTML and React artifacts in a conversation with a design system receive the same tokens (--dur-*, --ease-*, colour and type) as CSS custom properties, and the authoring rules tell the model to use them.
Variables table:
- Docked under the canvas, sharing the timeline slot (tabs 'Motion · Variables'). Never full-screen.
- Columns are modes; rows are grouped by collection. Inline edit, search and a type filter.
- Modes can be set per frame ('Appearance: Light ▾') and per page.
Import and export: DTCG 1.0. Exporters write CSS custom properties, framer transition objects and Swift constants in the JunoMotion shape, all generated from one source.
Motion: the panel docks with Collapse, and tab switches cross-fade (duration-fast).
- **Why:** Tokens stay tokens, switching a theme or a motion feel is one click, and designs map cleanly onto code.
- **Reference:** - Figma variable types: BOOLEAN, COLOR, FLOAT and STRING, plus EASING and TIMING since 2026-08-05.
- Scopes decide which pickers show a variable. Modes are inherited, or pinned per node.
- The variables view is a table with a column per mode. DTCG 1.0 import and export are supported (help 15145852043927; developers.figma.com updates; figma.com/blog/schema-2025, primary).
- Complaint: the full-screen variables view blocks the canvas (forum 2026-01).
- **Juno today:** - Variables with modes and aliases exist, but only fills.0.color can be bound (inspector-panel.tsx:373-554).
- Geometry bindings have no effect (L44).
- bindVariable does no type check, which produces NaN geometry (L43).
- Variables are colour, number, string or boolean only (types.ts:618-640).
- Documents cannot reference Juno's product motion ladder (70/120/160/220/360/560 ms and 9 curves).

### R-051 · A Design System artifact that every kind installs and uses by default
`P1` · effort XL · web, mac, iphone · design-system · depends on R-001, R-008, R-009, R-048, R-050, X-09, X-14
- **Build:** What it holds:
- A DESIGN_SYSTEM type, labelled 'Design system' in the UI, never just 'Design'.
- Variable collections with modes and usage notes: colour, type scale, spacing, radius, effects, and motion timing and easing (R-050).
- Text, effect and motion styles; components as scene nodes (R-048); README guidelines; assets; a cover.
- The canonical data is structured tokens (DTCG 1.0). A DESIGN.md is generated alongside for exchange with other tools.
Ways to create one:
- 'Extract from this design', which promotes variables, repeated styles and components;
- 'Make a system from this' on a deck;
- uploaded brand assets or screenshots;
- a DESIGN.md, CSS variables or Figma variables file;
- a repo via Juno Code (Tailwind config, CSS variables, and tokens.generated.ts first).
Review screen:
- the palette with contrast pairs, and a WCAG lint on token pairs;
- type specimens and a component grid;
- 'Used by 12 artifacts';
- Publish, and 'Default for new designs' per user or project. Admins may lock a system.
How artifacts use it:
- Artifacts store {dsId, version}.
- A header 'Theme' menu lists installed systems and their modes. Installing links variables by id.
- An update shows 'Design system v5 available · 12 changes · Review', which opens a before/after diff with Accept all or per-item choices. Updates are never automatic.
- Inspector colour and type pickers list tokens first, with 'Custom' one step away.
- Docs and Decks derive their themes from it. Pages get CSS custom properties.
- The model receives the token names (a summary of about 2k tokens) and binds fills and type to tokens. The lint (R-047) flags raw values.
Defaults and rollout:
- Juno's own design-law tokens are the default for people who have no system.
- Ship tolerant native decoding first (R-001). Native gets a read-only viewer first.
Resolution: tokens first in pickers, with custom colours one step away, rather than Claude Slides' design-system-only picker. One migration pass, with no separate standalone settings path.
- **Why:** Everything Juno makes starts on-brand, and a brand change reaches every artifact that opted in, after review.
- **Reference:** - Claude's Design System type holds a README brand book, tokens.json (themes, type, spacing, radius, shadow, with usage notes), components with live previews (mounted, not imitated), assets, and lastChange provenance.
- The default system applies to every new deck and design. Systems are built from a codebase or Figma and re-synced with /design-sync, and admins can lock one (claude-primary-evidence.md; help 14604416; Admin guide, primary).
- Without a system, output is 'functional but generic' (Admin guide).
- Figma library publishing shows a modal of changes, and subscribers review updates (help 360025508373).
- Google published DESIGN.md as an open draft spec (blog.google, 2026-04-21, primary).
- ChatGPT's Template Creator turns a deck into a template (learn.chatgpt.com).
- **Juno today:** - Variables, modes and components exist only inside each document (types.ts:768-789), and components are copied on create (00-AUDIT §7.2).
- There is a tokens export (export.ts), but no system shared across documents.
- tokens.generated.ts sitting next to the scene model is a naming collision (00-AUDIT §5).
- The native store fails closed on unknown types (X-09).

### R-053 · AI motion authoring: three variants in Juno's motion language, previewed inline and checked
`P1` · effort M · web, mac, iphone · ai-editing · depends on R-052, R-009, R-010
- **Build:** Flow:
- Motion requests go through the single AI thread against the current version (R-010).
- Juno returns up to 3 variants. Each is a small set of applyAnimationStyle operations using tokens.
- The proposal card shows one chip per variant: 'A · Rise, staggered, base', 'B · Pop, fast', 'C · Slide up, slow'.
- Focusing a chip plays that variant once on an isolated preview document. Replay plays it again.
- Apply commits one variant as a single transaction. Reject restores the design.
Tune adjustments: Duration (Fast/Base/Slow), Stagger (0-120 ms) and Bounce (0-0.3).
Motion lint, shown as one line:
- interface durations stay within 70-560 ms unless asked;
- no infinite loops unless asked;
- at most 10 staggered items;
- every animation has a reduced-motion policy;
- bounce stays at or below 0.3 unless asked.
Context: the model gets the motion digest (R-009) and a poster.
Previews never loop.
- **Why:** Choosing between three moving options beats describing timing in words, and the lint keeps Juno's motion within its own taste.
- **Reference:** - Figma's help suggests prompting 'Create 3 motion variants…', because narrowing three down to one beats getting the first try right. Its agent guidance: 0.25-0.7 s, stagger, ease-out, and avoid flashy loops and heavy bounce (help 41159708615319; figma-use-motion SKILL.md, primary).
- Figma users have to switch to Motion mode to compare variants.
- **Juno today:** - Ask Juno is single-turn, doesn't stream and can't see the design.
- Review isn't isolated (M46), and a proposal swaps in all at once, in one frame.
- The chat grammar cannot express motion (X-10, X-06).
- Ask Juno can emit raw keyframes (ai.ts:292).

### R-054 · Timeline dock ergonomics
`P1` · effort M · web, mac · editor · depends on R-003, R-049
- **Build:** Navigation: zoom with ⌘-wheel or pinch, a slider, or Fit. Ruler ticks adapt from 10 ms to 1 s.
Snapping:
- Snap to the grid, to other keyframes and to the playhead. ⌘ bypasses snapping.
- A snap shows a 1px accent guide for 120 ms.
Selection and editing:
- Marquee and ⇧-click select keyframes across tracks. Dragging moves the group, and ⌥-dragging the group's edge retimes it proportionally.
- ⌘C/⌘V pastes at the playhead. Segments have Copy easing and Paste easing.
- A typed time field.
- Tracks collapse per layer, and an 'Animated only' filter hides still properties.
- New tracks and keyframes land at the playhead. K adds a keyframe.
- ←/→ nudge 10 ms, and ⇧ 100 ms.
Playback:
- Once, Loop or Ping-pong, migrated from the loop boolean.
- The playhead moves by transform: translateX and can be dragged on the ruler.
Defaults: keep 1000 ms for new animations, with token snapping to 70, 120, 160, 220, 360 and 560 ms.
Auto-keyframe recording, if added, must be loud (a 1px accent edge on the dock and canvas) and turn itself off on Esc or when the user leaves the timeline.
Rendering: redraw only the animated nodes each frame (R-019).
P2 follow-up: a value-graph view.
- **Why:** Retiming a sequence takes seconds instead of dragging dozens of diamonds one by one.
- **Reference:** - Figma's timeline: Space plays; duration and current-time fields; Loop, Once and Ping-pong; zoom by slider or Cmd+wheel; tracks grouped by layer; drag to shift or stretch (help 41405906446999, primary).
- Users ask for snapping, typed times, multi-select, copying and pasting easing, a graph editor, and new layers landing at the playhead (forum, 2026-06-26 to 08-27).
- Figma's 2000 ms default contradicts its own 0.25-0.7 s guidance.
- **Juno today:** - The dock has named animations, a loop boolean, scrub and play, and a 1000 ms default (motion-panel.tsx:93,233).
- It has no zoom, multi-select, copy, snapping or recording (01-AUDIT-WEB §5.2).
- The playhead and ticks move with the left property (motion-panel.tsx:639,733), which breaks the rule that only transform and opacity travel.

### R-074 · Presence, async first, with Juno as a participant [rest: live cursors]
`P2` · effort L · web, mac, iphone · collaboration · depends on R-039, R-018, R-011
- **Build:** Phase 1, async:
- A header stack of up to 3 avatars plus '+2', showing grantees who opened the artifact in the last 30 days (ArtifactOpen).
- A popover lists 'Viewing now' (a 30s heartbeat while visible, 60s TTL) and 'Viewed 2h ago'.
- Only signed-in grantees are named. Public visitors stay an aggregate count.
- Setting: 'Show when I've viewed shared artifacts', on in projects and off elsewhere.
Phase 2, live:
- Each viewer's selection shows as an outline in their colour, with a name tag.
- Cursors appear only in Edit mode, at most 20Hz, and only when two or more people are editing.
- Juno appears as a participant with its own colour while a proposal is live: 'Juno is editing Hero'.
- Follow draws a 2px ring in the leader's colour around the canvas, with a banner. The camera behaves as in R-070.
- Concurrent edits rebase operations on the server. The last write wins per property, with a note such as 'Anna changed this too'.
Motion:
- Avatars fade and scale from 0.8 to 1 (ease-spring, duration-base), leave on duration-exit, and reflow via layout.
- 'Viewing now' is a static ring, with no pulse.
- Remote cursors move on spring.interactive and fade after 10s idle.
- **Why:** People can see whether a reviewer has looked, and what Juno is touching, without chasing anyone.
- **Reference:** - Figma's viewer history shows 'Currently viewing' and 'Previously viewed' for signed-in members (help 29638316371479, primary). Following someone outlines the viewport in the leader's colour, and there is cursor chat (help 360040322673).
- Claude's room capability carries presence and cursors, with agent sessions joining as marked agents (claude-primary-evidence.md).
- Claude Design's help says multi-person editing 'may not work reliably' (help 14604416).
- **Juno today:** - There is no presence anywhere.
- Share.views counts owners and bots (share.ts:157).
- crdt.ts is text-only and unused, even though it is marked stable.
- Transactions already carry a base revision with a 409 guard.

### R-076 · Artifacts that can ask Juno and keep data (runtime capabilities) [owner-only `data` first]
`P2` · effort L · web, mac, iphone · ai-editing · depends on R-012, R-015, R-039
- **Build:** Manifest:
- Each version carries a capability manifest declared by the model: ask, store:personal, store:shared, download.
- The header shows it as quiet chips: 'Asks Juno · Saves your data'.
Bridge: a postMessage bridge from the preview origin provides:
- juno.ask(prompt): the signed-in viewer pays, it is rate-limited, and it uses the viewer's default model;
- juno.store: a per-artifact key-value store with a size cap.
Storage rules:
- Storage works in drafts and in published versions alike.
- A failed write shows a visible error in the page and in the Console.
- Shared storage shows a one-time notice.
- Unpublishing never deletes stored data.
Connectors and sharing:
- Connector access comes later: per viewer, and never on public links.
- Artifacts that use capabilities cannot be shared as 'Anyone with the link'.
- **Why:** People can build small working tools, such as trackers, quizzes and AI calculators, that remember things and can be shared.
- **Reference:** - Claude-powered artifacts (June 2025): usage 'counts against their subscription, not yours' (claude.com/blog/claude-powered-artifacts, primary).
- Persistent storage is 20MB per artifact, personal or shared (help 9487310).
- Storage writes in drafts fail silently until the artifact is published (Caipi, 2026-06-12, community).
- Today's typed runtime declares capabilities: artifact, assets, comments, db, downloads, room, user, mcp (claude-primary-evidence.md).
- **Juno today:** The sandbox has only an in-memory storage stand-in. There is no model-call API, no persistent or shared storage, and no file or connector access (sandbox-frame.tsx:236-262).

### R-080 · Embed node: place artifacts inside designs, decks and docs, pinned to a version
`P2` · effort XL · web, mac, iphone · merge-core · depends on R-012, R-014, R-015, R-057, X-01, X-14
- **Build:** The node: an embed node in Design, Deck and Doc, {artifactId, nodeId?, version (a pinned id or 'latest'), fit, posterAssetId, interactive, params}.
Display:
- At rest it draws the R-014 poster.
- When selected, a strip reads 'Home screen · Design · v7 · Open'. ⌘↵ enters the embed in place, and Open goes to /a/{id}.
- In Play or Present, or via Play on its handle bar, a Page or React embed mounts live through the preview origin at the node's size.
Versions:
- A pinned embed shows 'v9 available · Update' and never updates silently.
- A 'latest' embed updates itself and says 'Updated from v7'.
- Detach makes an explicit local copy.
- Published snapshots resolve embeds at their pinned versions.
- Viewers without access see the snapshot image.
- If the source is deleted, the embed keeps its last image, marked 'Source deleted'.
Parameters:
- Parameters that the embedded artifact declares (its tweaks manifest) appear as inspector controls and can be keyframed.
- This gives shader-like backgrounds without putting a program in the scene.
Performance: at most 3 embeds animate at once, offscreen embeds pause, and nothing runs while idle in Edit.
Exports:
- SVG, PNG and PDF use the poster.
- HTML includes the iframe.
- React and SwiftUI get a placeholder and a note.
- Video uses the poster, or real frames if the artifact implements an optional render(t) contract.
Entry points:
- 'Place on board' on every Page, React, SVG and Mermaid card, and 'Put on canvas' from chat.
- The AI can emit an HTML artifact and an embed node in one proposal.
Priority: P2 (FIG-17 said P1). It needs the origin fix, posters, and the Doc and Deck types first.
- **Why:** A live prototype, static screens and diagrams sit on one board or slide, linked and current, without converting formats.
- **Reference:** - Claude Design is a canvas of up to 40 pages of live .dc.html artboards with prototype links (claude-primary-evidence.md), and Claude Slides supports <x-embed> (primary).
- Figma's Weave node syncs connected assets (release notes 2026-09-17), and Figma Slides library instances stay live.
- But in Figma, Make→Design 'changes don't sync back', and Buzz users 'manually replace every single asset' (help; forum, primary/community).
- Figma shaders: one animated shader per page, blank without WebGPU, and missing from code export (help 41147702210071).
- Canva Code 2.0 embeds interactive elements in decks (VentureBeat, 2026-07-14, secondary).
- **Juno today:** - DesignDocument has no embed or reference node (types.ts:436-446).
- A design cannot hold HTML, REACT, SVG or MERMAID artifacts.
- Components are copied on create.
- Shaders are deliberately excluded, because the exporters can't honour programs (types.ts:117-123).
- Previews are dead (X-01).

### R-081 · HTML ⇄ design conversion: open any page as editable layers, and send design changes back as a patch
`P2` · effort XL · web, mac, iphone · merge-core · depends on R-009, R-012, R-032, R-080, X-06, X-08, X-10
- **Build:** Entry points: 'Open in Design' on every HTML, React and SVG artifact; 'Extract to layers' on a code embed; and a text/html paste handler.
Extraction:
- Runs inside the preview sandbox (juno:extract): visible elements only, at most 40 levels deep and 1,500 nodes.
- For each node it captures {tag, rect, computed-style subset, text runs with metrics, img src, inline svg}.
Mapping, through the validated operation layer:
- block and flex → frames with auto layout;
- grid → grid;
- text → text nodes;
- images → the asset store, never inlined;
- border, radius, shadow, opacity and blur → strokes, radius and effects;
- inline SVG → paths.
Losses:
- Anything that can't be mapped (pseudo-elements, complex transforms, filters other than blur, fixed positioning) falls back to absolute position.
- These are listed in a dismissible banner: 'Imported with 7 approximations · Show'.
Output: a new DESIGN with derivedFrom set to the page version, and one page per width (390 and 1280).
Round trip:
- 'Update code from frame' diffs the frame against its extraction and sends a patch proposal to the page.
- 'Make code from frame' creates a linked page.
- ⌘D duplicates a code layer to compare.
Scope: static layers only. Repo import belongs to Juno Code. The Mac gets 'Capture to canvas' through the same extractor.
Resolution: operations against an empty document stay the default way to author designs (R-009), which is the consensus of CA-02, CD-02, CM-03 and FIG-07. HTML as the authoring format, OTH-11's strategic proposal, is an option to evaluate for owner decision §11.2 #5, not the default. Hence P2, though OTH-11 said P1. Never rewrite DESIGN as HTML artboards.
- **Why:** Any page Juno or another AI wrote can become a design the user drags and restyles, and design changes flow back as code.
- **Reference:** - Canva Code 2.0 (GA 2026-07-14) turns HTML 'from any source, including ChatGPT, Claude, Lovable, or Bolt' into a 'fully editable design' (VentureBeat, secondary).
- Figma code layers (closed beta 2026-06-24): 'extract designs' converts the current state to editable layers, and 'one click updates the code layer with your edits' (figma.com/blog/code-on-the-figma-canvas, primary).
- Subframe captures to canvas, and Paper pulls live sections of an app onto a canvas (primary).
- **Juno today:** - There is no HTML → scene import (01-AUDIT-WEB §2.6).
- Design export to HTML and React is one-way and absolutely positioned (export.ts:505-516).
- Chat-made designs use a 7-node grammar that refuses images (X-10) and is rebuilt on every revision (X-06).
- Owner decision §11.2 #5 (operations vs HTML artboards) is still open.

### R-082 · Inspect mode and code for layout and motion handoff
`P2` · effort L · web, mac · export-handoff · depends on R-026, R-049, R-066, L20, L45, L46, L47
- **Build:** Inspect (⇧D, R-026):
- A read-only canvas with hover measurement.
- For the selected layer, the right rail shows:
  - the box model, typography, and colours as token pills;
  - a code block with a language switch (CSS, Tailwind, React, SwiftUI). It emits flex or stack for auto layout, and absolute positioning only where the design uses it (L45 to L47);
  - assets, with download;
  - an optional 'Ready' status per frame, carried into the handoff.
Motion:
- Selecting an animated node shows a read-only timeline and code tabs:
  - CSS: @keyframes, custom properties and a prefers-reduced-motion block;
  - React: motion transition objects that reference token constants, {type:'spring', duration, bounce};
  - SwiftUI: KeyframeAnimator or .spring(duration:bounce:), which is lossless;
  - JSON: the v2 IR.
- The timeline dock also gets a Code view. Copy uses IconSwap.
- The Juno Code handoff bundle gains motion.json: the IR with cohorts, playback, autoplay, triggers and token references.
Access: open to anyone who can view the artifact. No paid seat.
Honesty: every exporter prints all its unsupported notes, including notes for shaders and embeds.
- **Why:** Developers and Juno Code get exact, token-based layout and motion code instead of a note.
- **Reference:** - Figma Dev Mode (⇧D): Inspect shows properties as code (CSS, iOS, Android) or as a list, plus variables, assets and Code Connect. The Motion tab copies CSS, JSON or motion.dev. It requires a paid seat (help 15023124644247, 41296356954263, primary).
- The MCP tool get_motion_context returns snippets, cohorts and transformOrigin, with a mandatory reduced-motion guard (figma-implement-motion).
- **Juno today:** - React and SwiftUI output is absolutely positioned (L45 to L47).
- Only the HTML export runs motion. React and SwiftUI print a note pointing at the handoff bundle (01-AUDIT-WEB §5.2), and springs export as ease-out (L20).
- Juno already uses framer-motion and has a SwiftUI exporter.

### R-083 · Video and GIF export for animated designs
`P2` · effort L · web, mac · export-handoff · depends on R-019, R-057, R-054, X-23
- **Build:** What it exports:
- Export ▸ Video/GIF, for any frame or selection, not only top-level frames.
- MP4 (H.264) or WebM (VP9) at 24, 30 or 60fps, at 1× or 2×, up to 120s at launch.
- GIF, with a loop count.
- A range taken from in and out marks on the timeline.
How it renders:
- In a worker: sample the IR through the SVG renderer into an OffscreenCanvas, and encode with WebCodecs. GIF uses a worker encoder with a palette per 16 frames.
- Or server-side: step the evaluator and rasterise renderPageSvg.
- On the Mac, fall back to AVAssetWriter via the bridge if WKWebView lacks WebCodecs.
The export row:
- Uses Button loading with a progress fraction, and Cancel.
- Shows limits before rendering, for example 'Glass renders with its fallback in video'.
- Saves the file as a version-pinned asset, then downloads it.
Checks: the model may render 5 frames to check its motion, but only when asked.
Plan limits: any limit is shown before the user sets up the export.
- **Why:** Animated designs can leave Juno as shareable video, not only as HTML.
- **Reference:** - Figma exports frames as MP4, WebM, GIF or animated SVG, with resolution, fps, quality and loop settings. Above 1920×1080 or 30fps needs a paid plan (help 41307983648407, primary). Lottie is promised.
- The Figma MCP exposes export_video.
- **Juno today:** - There is no video, GIF or Lottie export (01-AUDIT-WEB §5.2).
- Juno already has a deterministic, pure SVG renderer (render.ts) and a pure motion sampler (motion-model.ts).
- Exports return 500 on names with characters above U+00FF (X-23).

### R-084 · Accessible by construction: semantic roles on design nodes, and real elements in exports and the player
`P2` · effort M · web, mac · export-handoff · depends on R-032, R-057, R-012
- **Build:** - Node semantics: {role: button | link | heading (1-6) | image (alt) | textfield (label) | list | listitem | none}. Set in an Accessibility section of the inspector, and by the model, whose authoring rules require them.
- Exporters and the player emit real elements with accessible names. The player works from the keyboard.
- The inspector shows an AA or AAA badge on text, with a one-click switch to the nearest passing token (shared with R-047).
- On Export HTML or Publish, run axe-core on the preview origin and report: '2 issues · Review · Fix with Juno'.
- **Why:** What people publish or hand off works for keyboard and screen-reader users.
- **Reference:** - At launch, Figma Sites had 210 axe issues (33 critical), 101 divs with no role, and links and buttons implemented as handlers (adrianroselli.com, 2025-05-07, updated 2026-06-10, community). Figma added semantic elements on 2025-05-21.
- Claude's craft rules require real button, a and input+label elements even in mockups, and 4.5:1 contrast (claude-primary-evidence.md).
- Stitch output may fail WCAG (secondary).
- **Juno today:** - HTML, React and SwiftUI exports are absolutely positioned (export.ts:505-516).
- Nodes carry no semantics.
- There is no contrast or accessibility check.

### R-085 · Component states with declared transitions: a small, explicit state model
`P2` · effort L · web, mac, iphone · motion · depends on R-048, R-055, R-056
- **Build:** After live components land (R-048):
- A States section in the component inspector, and a States sub-tab in the Motion panel.
- Nodes are states: default, hover, pressed, selected, loading, disabled, or custom. Each maps to a variant and, optionally, an animation.
- Edges are a trigger (hover in or out, press, click, variable change) plus an R-055 transition or a preset.
- A state model is declared once and every instance inherits it. The runtime keeps a current state per instance.
- A boolean or string variable can drive a state, for example loading = true.
- Hovering and clicking the component in Play exercises the graph, so this doubles as the component player.
Export:
- HTML: a tiny state runtime.
- SwiftUI: @State plus .animation(.spring(duration:bounce:)).
- React: useState plus transitions.
Editor chrome: nodes are static. The active state takes bg-selected, and a firing edge cross-fades its highlight.
Scope: nothing beyond this. No node-graph state-machine editor.
- **Why:** A button's hover, press and loading motion is designed once and works in every instance, prototype and export.
- **Reference:** - Figma interactive components use 'Change to' between variants, and instances inherit it (help 360061175334). Smart animate between variants can't be keyframed (staff, 2026-07-02).
- Reviewers say Figma has no state machine and one timeline per artboard (Rive Masterclass, 2026-06-25, secondary).
- Rive's State Machine is a graph of states and transitions (rive.app docs, primary).
- **Juno today:** - MotionAnimation.state ('default|hover|pressed|selected|loading|string') exists but has no UI (types.ts:725-731).
- A set-variant action exists.
- Components are copied on create, so behaviour can't propagate (instances.ts:4-27).

### R-086 · Editable transition timelines: smart animate and keyframes as one model
`P2` · effort M · web, mac, iphone · motion · depends on R-054, R-055, M61
- **Build:** - 'Edit transition as timeline' on any smart-animate interaction generates an editable animation (transitionFor: interactionId).
- It has one track per matched element, taken from the FLIP deltas, plus fade tracks for unmatched layers. It starts at the transition's duration and easing.
- The dock opens on it. Designers can stagger, overshoot or delay each element, and the runtime plays this animation instead of the generic smart animate.
- 'Regenerate from frames' rebuilds it while keeping hand-edited tracks, matched by key.
- The AI writes these through the same operations, for example 'make the cards arrive one after another'.
- **Why:** Designers can choreograph a screen change element by element without rebuilding it.
- **Reference:** - figma.com/motion and the Motion launch list 'Every screen-to-screen transition now has a full timeline' as coming soon (2026-06-24, primary).
- Until then, Figma staff suggest cross-fading layers by hand (forum, 2026-07-02).
- **Juno today:** - A transition is only a kind plus a duration, with no per-element control, and nothing plays it (M61).
- Named animations and a play-animation action already exist.

### R-087 · Freeze the frame: point at a moment in motion, with comments anchored in time
`P2` · effort M · web, mac, iphone · collaboration · depends on R-037, R-040, R-041, R-057, M61, M64, M65
- **Build:** Freezing:
- Entering Draw or Comment on a moving artifact freezes it.
  - HTML: juno:freeze pauses document.getAnimations(), holds requestAnimationFrame, pauses video, and records the time offset.
  - DESIGN: pauses at the playhead.
- The mode bar shows 'Paused at 1.24s', with ◀ ▶ frame steps (1/60s) and a scrub strip. DESIGN uses the real timeline. HTML scrubs only WAAPI or CSS pages; pages driven by JS timers just show 'Paused'.
- Freezing is instant. A 1px foreground/20 ring marks the paused state and fades on resume.
Time-anchored comments:
- Anchors store t, plus the animationId or the flow, frame and state.
- Threads show the frame thumbnail with its time. Clicking a thread seeks and pauses there.
- On the timeline ruler, comment pins are 6px dots that move the playhead and open the thread.
- In Play, C drops a pin on the current frame and state.
- Send to Juno includes the crop, t, and the surrounding keyframes or CSS animation names. The result is a motion proposal (R-053).
- **Why:** 'At 240ms the card overshoots' becomes something people can point at, and Juno can fix.
- **Reference:** - Cursor Design Mode annotates 'over a frozen frame of the viewport', so you can mark part of an animated page (cursor.com/docs/agent/design-mode, primary).
- Figma Motion ties comments to a moment on the timeline (help 41274629073303, primary).
- **Juno today:** - The design keyframe timeline can scrub and play (motion-panel.tsx), but there are no comments.
- Once X-01 is fixed, animated HTML artifacts will have no way to pause.

### R-088 · Named flows and prototype-only share links
`P2` · effort S · web, mac, iphone · sharing-governance · depends on R-015, R-057, X-20, X-31
- **Build:** - page.flows[] = {id, name, startNodeId, description}. Flows are listed in the Prototype tab and in the player's Flow menu.
- The Share dialog for a DESIGN chooses what opens:
  - Play: prototype-only, with no layers, inspector or source;
  - Canvas.
- Links can target a flow or frame (?play=1&flow=…&frame=…) and a pinned version.
- Once grants exist, 'can view prototype' is a role below 'can view'.
- Embeds use the same Play surface, with chrome reduced to Restart and Fullscreen.
- A published prototype never links back to the working artifact or its chat unless the viewer has a grant.
- **Why:** A designer can send a stakeholder one link that opens straight into the right flow, without exposing the working file.
- **Reference:** - Figma flows are named start points with descriptions, several per page. Prototype-only access hides the file, links can open a specific frame, and there is embed code (help 360040314193, 360040531773, primary).
- Claude's canvas.json has launch {view, file, page}.
- **Juno today:** - There are no flows. The first root frame is the implicit start (export.ts:1168).
- Shares are anonymous timestamp snapshots that show JSON for designs (X-20).
- There are no per-person grants.

### R-089 · Effects parity, with effects kept as recipes: progressive blur, and animatable effect and layout fields
`P2` · effort M · web, mac, iphone · visual-design · depends on R-019, R-049
- **Build:** Progressive blur:
- Layer and background blur gain {startRadius, endRadius, start and end offsets from 0 to 1}.
- Export as stacked blur layers masked by a linear-gradient mask-image, with a note for SwiftUI and PDF.
Animatable channels, after schema v2:
- effects[i].radius, offsetX, offsetY, spread, color and opacity;
- glass refraction, lightAngle and lightIntensity;
- layout gap and each padding;
- pathTrimStart and pathTrimEnd, which enable the Draw preset.
Rules:
- Key effect channels by effect id, not by array index.
- Every new channel has an emitter in every exporter, or an explicit unsupported note.
- Every field that can be animated can also take a token.
- **Why:** Modern effects can be built and animated, and every exporter still honours them or says exactly what it can't.
- **Reference:** - Figma Draw added progressive blur, noise and texture (2025-05-07), and Glass left beta on 2026-01-27.
- Figma Motion can keyframe every numeric effect field, plus gap, padding and path trim (figma-use-motion; d.ts, primary).
- **Juno today:** - There are seven effect kinds, including noise, texture and glass, but no progressive blur.
- Only 13 properties can be animated, and blur is a single scalar (types.ts).

### R-091 · Context-aware ⌘K and slash actions for the open artifact
`P2` · effort M · web, mac · ia-navigation · depends on R-010, R-026, L34
- **Build:** With an artifact surface focused, ⌘K shows:
- first, 'In this design': Align…, Distribute, Add auto layout, Create component, Rename layers with Juno, Replace text content, Export selection…;
- as the last row, 'Ask Juno: <typed text>', which sends to the composer with the selection chip;
- then global actions: New design, New doc, New deck, Open…;
- recents when the query is empty.
Skills that declare an artifact scope appear as slash commands in the composer while a design is selected, for example /variants, /responsive and /check.
Extend the existing palette; do not add a second one. Reuse the modal and pop recipes.
- **Why:** Every design action is one search away, and Juno's skills become design commands.
- **Reference:** - Figma Actions (⌘K) offers AI actions, commands, asset search, plugins and recents (help 23570416033943).
- Figma's agent skills appear as slash commands (figma.com/blog/agent-custom-tools-context-skills, 2026-06-24, primary).
- **Juno today:** - The global palette has 'Open Design' and 'Open Artifacts', both keyed to 'canvas' (command-palette.tsx:1168-1169).
- There is no New design (L34), and there are no commands inside the editor.
- Juno already has a Skills product.

### R-093 · Embed a published artifact in other tools
`P3` · effort S · web · export-handoff · depends on R-011, R-012, R-015
- **Build:** - Publish ⋯ › Embed… gives an iframe snippet for https://<preview-origin>/e/{token}, with size presets.
- /share/{token} gets oEmbed discovery, so Notion and Slack unfurl it.
- An embed shows only the published version, with a small 'Open in Juno' footer.
- It reacts immediately to Unpublish, expiry and suspension, returning 410.
- frame-ancestors * applies only on /e/, never on the app.
- **Why:** Juno's work shows up live inside the docs and wikis teams already use.
- **Reference:** Figma's 'Get embed code' follows the file's share settings, and embeds are used in Notion, Confluence and Jira (help 360039827134, primary).
- **Juno today:** - There is no embed (01-AUDIT-WEB §2.8).
- Previews are dead (X-01).

### R-094 · Motion paths on the canvas
`P3` · effort M · web, mac · editor · depends on R-049, R-054
- **Build:** When the dock is open and the selection has translate keyframes, the canvas shows:
- a 1px muted path;
- 4px dots at equal time steps, so their spacing shows the easing;
- 8px keyframe handles;
- a filled dot for the playhead.
Dragging a handle moves that keyframe's offset, with one commit per gesture. ⌘-drag pulls out curve handles, stored on the segment. A hint reveals the modifier the first time. The path hides during pan and in Play.
- **Why:** Arcs are shaped by hand, not by typing offsets.
- **Reference:** Figma draws position keyframes on the canvas as boxes, with dots spaced by the easing. ⌘-drag pulls out bezier handles (help 41780233501591, primary).
- **Juno today:** Position motion can be edited only as numbers on tracks (motion-panel.tsx).

### R-095 · Titles arrive rather than pop
`P3` · effort S · web, mac, iphone · motion · depends on R-007
- **Build:** Use ArrivingTitle for the artifact title in the card, the panel header and the sidebar, whenever Juno sets or renames it:
- the old text fades out (duration-exit, ease-in);
- new graphemes fade in with a 2px rise over duration-fast, staggered 20ms and capped at 16, with the rest arriving together;
- the full string is sr-only;
- no filter:blur;
- reduced motion: one cross-fade.
Never apply it to streaming response text.
- **Why:** A small signal that Juno named or renamed the thing, without reflow or noise.
- **Reference:** Claude reveals sidebar and renamed titles grapheme by grapheme: opacity 0 plus 6px blur to clear over 90ms, with a 30ms stagger. The old text blurs out over 200ms, and an sr-only copy carries the full string (observed in the shipped Claude desktop app, primary).
- **Juno today:** - Artifact and conversation titles swap in one frame.
- Juno removed per-word blur from response text because of compositor cost (markdown.tsx:344-352).

### R-096 · A fixed inspector order and density
`P3` · effort S · web, mac · visual-design
- **Build:** Section order is fixed:
1. Component or instance;
2. Layout: W/H with Hug/Fill/Fixed chips, flow, gap, padding, alignment grid, clip;
3. Position: X/Y, rotation, constraints;
4. Appearance: opacity, radius, blend, mode;
5. Fill;
6. Stroke;
7. Effects;
8. Text;
9. Export, in Inspect only.
Behaviour:
- Sections never reorder.
- An empty section collapses to a header with '+', and its caret rotates over 220ms.
Controls:
- A font picker with previews, and named weights.
- The selected state is bg-selected with foreground ink.
- Rows are 28px for a pointer and 44px for coarse input.
- **Why:** Controls are where the hand expects them, every time.
- **Reference:** - Figma UI3 puts the component section first, merges the auto-layout controls into one Layout section, and makes labels optional (blog 2024-10-01, primary).
- Figma users complain that controls 'move depending on component complexity'.
- **Juno today:** - The inspector is broad, but spread across huge modules (effects-panel.tsx is 2,236 lines).
- Font family is free text, and weight is a bare number.
- Selected states use an accent tint (layers-panel.tsx:436,463,552,619), which breaks FLAT_UI §3.1.

### R-097 · Size variants and bulk fields inside Design
`P3` · effort L · web, mac · editor · depends on R-048, R-069
- **Build:** No new type is needed.
- 'Resize to…' on a frame creates linked variants at chosen presets, as instances with size overrides, laid out in a grid on a 'Sizes' page.
- Auto layout and constraints reflow each variant, and edits to the master propagate.
- Text and image layers can be marked as Fields, shown with a badge in the layers panel.
- 'Lock layout' dims layers that aren't Fields and shows a lock cursor. The state is marked with a dashed hairline and a lock glyph, not colour-coded outlines.
- A table view shows variants as rows and fields as columns. CSV import creates one variant per row.
- Phone field editing (R-069) reuses Fields.
- **Why:** One post in every size, kept in sync.
- **Reference:** - Figma Buzz has templates with locked fields, a grid of every size, a table for bulk edits, and bulk creation from CSV or XLSX.
- Buzz complaints: parents aren't responsive, library updates don't sync, and locking is too coarse (help; blog 2025-05-07; forum, primary/community).
- **Juno today:** - There is one square preset.
- Auto layout, constraints, components and variants already exist.
- Components are copied on create.

### R-098 · Re-apply a brand to existing work in one reviewed step
`P3` · effort L · web, mac · design-system · depends on R-018, R-030, R-051, L43
- **Build:** - Select several items in the Library, then 'Apply design system…', then pick a system.
- This creates one suggestion set per artifact (R-030), mapping hard-coded values to tokens:
  - DESIGN: through bindVariable, extended to stroke, text colour, radius, spacing and font, with type checks;
  - HTML: by rewriting CSS custom properties or the Tailwind theme;
  - decks: by swapping the theme while keeping the content.
- A results sheet lists each artifact: '12 changes · Review', 'Nothing to change', or 'Couldn't map 3 colours'.
- Never one unreviewed rewrite.
- **Why:** A rebrand reaches everything already made, without redoing it by hand.
- **Reference:** - Canva Brand Intelligence 'supports retroactive updates to existing designs in one action' (CMSWire, 2026-04-16, secondary).
- Gamma restyles a deck to an uploaded brand guideline (aitoolssme, 2026-06-29).
- **Juno today:** - There is no design-system type.
- Only fills.0.color can be bound to a variable, and bindVariable has no type check (L43).
- /artifacts has no bulk actions.

### R-099 · Several pinned comments on a generated image, sent as one revision
`P3` · effort M · web, mac, iphone · mobile · depends on R-040, R-016
- **Build:** - Numbered pins (tap) and regions (drag), each with its own instruction.
- 'Revise (3)' sends one edit with a combined mask and the list of instructions.
- Pins persist as image-region comments (R-040), so the result can be checked against them.
- On a phone, the image opens full screen with the composer overlaid.
- Copy says 'around here': regions guide the edit, they don't lock pixels.
- **Why:** Fix three things in an image in one pass, comfortably on a phone.
- **Reference:** - ChatGPT (2026-09-08): on mobile, open a generated image full-screen to edit it or add comments telling ChatGPT what to change (releases.sh mirror, primary).
- The per-comment positions come from a secondary source (atlascloud, 2026-09-16).
- **Juno today:** - ImageEditOverlay supports one marquee region and one description, which become a mask and an edit (image-edit-overlay.tsx).
- It works with touch, but nothing is persisted.

### R-100 · Preview one artifact across appearances and devices side by side
`P3` · effort M · web, mac · visual-design · depends on R-012
- **Build:** - 'Compare views' in the view menu shows 2-4 renders side by side, for example Light and Dark at 390 and 1280.
- HTML: separate sandbox frames. At load, @media (prefers-color-scheme: dark) is rewritten to a [data-juno-scheme=dark] flag.
- DESIGN: a static renderPageSvg for each variable mode.
- The Mac later adds Tinted and Clear for Liquid Glass assets.
- **Why:** Catch dark-mode and phone-layout breakages before sharing.
- **Reference:** Apple Icon Composer previews the Default, Dark and Mono appearances side by side in one file (developer.apple.com/icon-composer, primary).
- **Juno today:** - The Canvas width presets (Fit, 834, 390) show one width at a time (canvas-panel.tsx:64-72).
- Design variable modes switch one at a time.

### R-101 · Point and speak: voice edits scoped to a selection
`P3` · effort M · web, mac, iphone · mobile · depends on R-037, R-038
- **Build:** - A mic segment in the mode bar, plus a Mac hotkey: press and hold, and speak while pointing.
- The selection at release is attached, and the transcript becomes a queued ask (R-038).
- iPhone: hold the mic on a full-screen artifact and tap elements while speaking.
- Allow artifacts in voice calls: keep the dock open, and let voice turns produce proposals.
- Press-to-talk with a visible live state. No always-on mic.
- **Why:** Edit with little typing, which matters most on a phone.
- **Reference:** - Google Stitch: 'speak directly to your canvas' (blog.google, 2026-03-18, primary).
- Cursor 3.7: the mic stays available while an agent is running (changelog 2026-06-04).
- **Juno today:** - Dictation and voice mode exist (composer-dictation.tsx).
- Canvas is turned off for voice turns (route.ts:2104-2111).
- The Mac dock closes when a voice call starts.

## Editor track (gates nothing, never touches the format)

### R-037 · One mode bar on every rendered artifact: V select, T text, D draw, C comment
`P1` · effort M · web, mac, iphone · editor · depends on R-012, R-016, M22, M56
- **Build:** The bar:
- One ArtifactModeBar for HTML, React, SVG, Mermaid, Markdown and Decks.
- It sits bottom-centre, 12px above the panel edge (overlay-glass, rounded-full): Interact (Esc) · Select V · Text T · Draw D · Comment C · ⋯ (hide, reset position).
- The design editor adds C and D to its tool row, so V, T, D and C mean the same everywhere.
- The keys work only while focus is in the artifact surface.
Select:
- Hover shows an outline and a name chip. Click selects; ⇧- or ⌘-click adds; dragging on empty space draws a region.
- A mini bar above the selection: Ask · Modify · Comment · Copy selector.
- The selection rides into the composer as chips (R-031).
Text:
- Click text to make it contenteditable in the sandbox.
- On blur or ⌘↵, the bridge returns (selector, old, new). This compiles locally into an exact-anchor patch and a user version, with no model call (R-036).
- If the old text isn't unique, because code generates it: 'This text is made by code — Ask Juno to change it'.
Draw:
- An annotation layer that is never a scene node and never exported: pen, arrow, ellipse, rectangle (strokes are cleaned up), stickies in 8 low-chroma tones, and heading notes.
- Moving artifacts freeze first (R-087).
- Annotations made while Juno streams queue as a 'Notes (2)' chip and attach to the next send as a crop plus anchors. They clear once Juno acts, and the clear can be undone.
Comment: see R-040.
Platforms:
- iPhone: a 44pt segmented control above the composer, with tap to select, 'Select more' and finger drawing.
- Mac: a SwiftUI bar over the WKWebView with the same keys and bridge messages. It replaces the regex menu.
Motion:
- The bar rises in 120 ms after the preview is ready (6px, duration-base).
- The active fill slides between mounted segments.
- The mini bar pops in from the selection.
- Strokes follow the pointer 1:1. Stickies pop in (ease-spring).
- Reduced motion fades only.
Resolution: V for select, as in Juno and Figma, rather than Lovable's S. Select and Draw are never metered.
- **Why:** One gesture vocabulary for pointing at anything Juno made, and fixing a typo in a generated page costs nothing.
- **Reference:** - Lovable's preview toolbar (2026-06-10): S select, T inline text, D draw (shapes are cleaned up), C comment. It can be dragged and minimised (docs.lovable.dev/features/design, primary).
- Cursor 3.0: ⌘⇧D, and Shift-drag to select an area (2026-04-02).
- Claude Design annotations: rectangle, oval, pen, arrow, and stickies in 8 colours (claude-primary-evidence.md). Draw mode queues annotations to send together (getpushtoprod 2026-04-19, secondary).
- Builder.io describes a scratchpad usable while the agent works (2026-04-29).
- **Juno today:** - The sandbox has a dormant element inspector that feeds Ask/Modify quote chips (sandbox-frame.tsx:310-430; canvas-panel.tsx:568-740,1392-1420). Its toolbar cannot be reached by keyboard (M22).
- There is no text-edit, draw or comment mode. The document viewer supports 'area' quotes.
- The design editor's tools are V F R O L T I. C and D are unbound. There is no annotation layer, and the line tool draws only horizontal lines.
- The Mac uses a regex 'Select component' menu that writes prose into the composer (DesktopArtifactCanvas.swift:748-775).

### R-062 · Direct-manipulation feedback: live drawing, on-canvas auto-layout handles, drag to reorder, and measurement
`P1` · effort L · web, mac, iphone · editor · depends on M37, M51, M52, M53, M54, M55, L62
- **Build:** First, fix the M37 layout engine so what is drawn matches what is computed.
Gestures:
- A move starts only after 3 screen px (M52), and pointercancel aborts (L62).
- Hug and Fill are kept unless a handle actually moves, and W/H show them as chips (M51).
- Drawing and rotating show the live shape and a readout pill (W×H or °) in mono on overlay-glass (M55).
Auto-layout children:
- Dragging reorders. Siblings slide open (transform, spring.interactive) and a 2px accent insertion bar marks the slot.
- ⌘-drag lifts a child out as absolute (M53).
Selected auto-layout frame:
- Hover shows hatched padding bands and gap handles with value labels. Shift snaps to 8.
- Grid frames show track pills with draggable edges.
Other:
- Alt-hover draws distance lines.
- A marquee started on empty space inside a frame selects its children (M54).
- Handles fade in (duration-fast), with no travel.
- Use one canvas-selection hue and one measure hue, both from tokens.
- **Why:** Editing layout becomes predictable, and auto layout stops fighting the person using it.
- **Reference:** - Figma auto layout: on-canvas padding and gap handles, a 9-grid alignment control, and 'Ignore auto layout' (help 360040451373).
- Figma grid flow shows track pills (Fixed, Fill 1fr, Hug) on hover (help 31289469907863, GA 2026-05-22).
- Holding ⌘ while resizing ignores constraints (primary).
- **Juno today:** - There is no live preview while drawing or rotating (M55).
- Dragging or nudging auto-layout children writes coordinates that layout ignores, and bloats undo (M53).
- Clicking a handle flips Hug or Fill to Fixed (M51).
- A click can jitter-move a layer by up to 24pt at 25% zoom (M52).
- There is no marquee inside frames (M54), and pointercancel commits (L62).
- The layout engine overflows horizontal Fill, gets cross-axis Fill wrong and has no grid columns (M37; layout.ts:335-355, 505-516).

### R-090 · A minimal drawing set, done properly
`P2` · effort M · web, mac · editor · depends on X-24, M56
- **Build:** - Fix X-24, and draw every stroke.
- Line at any angle: Shift snaps to 45°, with an 8px hit tolerance (M56).
- Arrow: a line with end caps, also usable for review callouts.
- Pen (P): straight and cubic segments, close path, and Enter to edit points.
- Boolean union, subtract and intersect.
- Stop there: no brushes, textures, noise, pattern fills, shape builder, shaders or 3D.
- **Why:** Simple icons, arrows and callouts can be drawn without leaving Juno.
- **Reference:** - Figma's toolbar has Rectangle, Line, Arrow, Ellipse, Polygon, Star, Image/Video, Pen, Pencil and Text.
- Figma Draw adds brushes, textures, noise and a shape builder (help 360041064174; release notes 2025-05-07 and 2026-08-24, primary).
- **Juno today:** - The tools are V F R O L T I.
- The line tool draws only horizontal lines, and zero-height lines are nearly impossible to click (M56; render.ts:966-969).
- There is no pen, polygon or arrow.
- Only the first stroke is drawn, and container opacity and rotation are ignored (X-24).

### R-096 · A fixed inspector order and density
`P3` · effort S · web, mac · visual-design
- **Build:** Section order is fixed:
1. Component or instance;
2. Layout: W/H with Hug/Fill/Fixed chips, flow, gap, padding, alignment grid, clip;
3. Position: X/Y, rotation, constraints;
4. Appearance: opacity, radius, blend, mode;
5. Fill;
6. Stroke;
7. Effects;
8. Text;
9. Export, in Inspect only.
Behaviour:
- Sections never reorder.
- An empty section collapses to a header with '+', and its caret rotates over 220ms.
Controls:
- A font picker with previews, and named weights.
- The selected state is bg-selected with foreground ink.
- Rows are 28px for a pointer and 44px for coarse input.
- **Why:** Controls are where the hand expects them, every time.
- **Reference:** - Figma UI3 puts the component section first, merges the auto-layout controls into one Layout section, and makes labels optional (blog 2024-10-01, primary).
- Figma users complain that controls 'move depending on component complexity'.
- **Juno today:** - The inspector is broad, but spread across huge modules (effects-panel.tsx is 2,236 lines).
- Font family is free text, and weight is a bare number.
- Selected states use an accent tint (layers-panel.tsx:436,463,552,619), which breaks FLAT_UI §3.1.

## What not to copy

- **Shipping a new artifact type without version history, a trash or a comment-only role. Claude Design says it 'doesn't have version history yet'; Claude Docs says 'Version history isn't available yet' and 'There's no trash'.** When people and AI edit the same object, versions are the safety net. Every Juno kind (Doc, Deck, Design System) ships with append-only versions, the stepper, restore and a 30-day trash from day one (R-005, R-006, R-022).
- **Removal that destroys data. On Claude, unpublishing deletes stored data and the artifact can never be republished, and Docs deletion is permanent. On Figma, deleting a comment is permanent, even across a version restore.** Juno already loses work through hard deletes (X-03, X-04, X-22). Revoking a link never touches data, every delete is reversible for 30 days, and comments are soft-deleted (R-006).
- **Regenerating the whole artifact for a small request, or streaming a rewrite by deleting every line and retyping it. This includes 'retroactive' whole-document rewrites applied without review (Claude's 2024 Improve; BigGo 2025-07-16; Canva Brand Intelligence 'in one action').** This is how Juno reverts hand edits and strips design structure today (X-05, X-06), and it looks like data loss even when it isn't. Patch or apply operations, stage the change, swap it in, and ask for review when hand edits exist (R-009, R-013, R-030).
- **An undo that can wipe whole AI-generated variations, where undo reads like a back button (PCWorld 2026-04-17).** Each AI turn is one labelled undo entry with a version behind it. No single control should destroy a round of exploration (R-005, R-010).
- **Dropping conversation branching to simplify the merged surface (Claude's merge, known limitations).** Juno's native apps already branch on Edit, and the web's destructive edit is X-03. Every platform should branch, not lose data (R-004, R-029).
- **Leaving objects without an owner and migrating them later (Figma drafts, 2024-10 to 2025-10, which led to 'my files disappeared' posts).** Give artifacts an owner and a home now, before sharing and grants make a migration harder (R-004).
- **Tying access to things people made to their current plan (HN 48128003, a lost-projects incident after unsubscribing).** Quotas may limit creating new artifacts, never reading or exporting existing ones (R-067).
- **Every deploy goes straight to production, and deletion is permanent (ChatGPT Sites).** Juno keeps a pinned published version separate from the working copy, plus a trash. Otherwise publishing repeats the X-31 and X-32 governance gaps (R-006, R-015).
- **Several generations of the same object running side by side. Claude has legacy chat artifacts that need Publish next to auto-saved ones, live artifacts that are 'viewable but non-editable', and three URL schemes. Figma's new Make editor applies only to newly created files.** Juno migrates in place. Every old URL redirects to /a/{id}, schemaVersion migrates on read, and each kind has one editor (R-016, R-018).
- **A standalone design app, with its own projects, settings, analytics and exports, kept next to the integrated one (claude.ai/design).** This is the same shape as Juno's four-editors-for-one-design defect (00-AUDIT §4.4). The fix is one editor, one store, and a one-pass migration (R-016).
- **A top-level sidebar destination for each type (Design next to Artifacts, then Docs and Slides), or a separate library for each output kind (HN 49729412 calls it clutter; ChatGPT has a separate Sites library).** Juno's sidebar and Liquid Glass branch already give Design its own row. Types should be filters and New actions inside one index (R-018).
- **A new file type or sibling product for every capability. Figma has three homes for code (Make, Sites code layers, Design code layers), two grid products (Slides and Buzz), and Weave outside the file browser with its own sign-in and credits.** This splits navigation and duplicates editors. Juno already has about ten systems for things it makes. The type charter admits a type only for a genuinely new document root (R-008).
- **Deep folder trees, and renaming the container concept (Figma turned projects into folders, 10 levels deep).** It forced Figma to rethink permissions and add a share modal that explains inheritance. Juno keeps Projects as its only container.
- **Two labels for one concept (Figma's 'Starred' and 'Add to your favorites').** Juno already has four glyph maps and three label vocabularies. The merge needs one noun per concept, from one registry (R-008).
- **Removing thumbnails in a navigation redesign (Figma folders, 2026-08-03). Previews were restored six weeks later, after 'the single most common piece of feedback'.** People recognise work by its picture, not by a type icon. Juno design tiles that show JSON (X-20, L30) are the same failure (R-014).
- **Clipboard copy as the bridge between types. In Figma, Make changes 'don't sync back' to Design, and Buzz users 'manually replace every single asset'.** Link with a version pin and an 'Update available' prompt instead (R-080).
- **Removing one of the surface's sizes: a full-width mode that hides the chat entirely (Claude), or deleting the side panel for inline-only output (ChatGPT removed Canvas, 2026-05-28).** The conversation is where the reasoning happens and where edits are made. The composer stays reachable in full screen, and the panel stays as one of four sizes (R-016).
- **Chrome that competes with the canvas: floating panels over it, a properties panel that opens on selection, a bottom-centre tool bar on desktop, a permanent navigation rail that can't be hidden, and a full-screen variables view (Figma UI3 beta, Minimize UI, the 2026 nav bar, variables view).** Juno's editor already fights for width inside a chat panel (M17). Rails open only on an explicit action, and tables dock under the canvas (R-017, R-050).
- **Modes that hide tools with no visible way back, and motion as a separate mode with its own coordinate origin and locked properties (Figma Draw; Figma Motion mode).** In Juno, modes change emphasis and rails only. There is one origin, and the timeline dock opens from any mode (R-026).
- **Surfaces that lift, sweep light across, fan out an under-sheet or scale on hover (Claude's artifact card, observed in the shipped Claude desktop app: a 2px lift, a light sweep, an under-sheet at -4°; the older card scaled 1.035 on a springy curve).** FLAT_UI says no surface goes up or down; it changes shade. Hover is a tonal cross-fade plus the glyph's one gesture (R-024).
- **Superseded edit cards hidden with opacity-0 (Claude).** This leaves dead space and loses the link from a turn to the version it made. Fold superseded cards into version receipts instead (R-023).
- **Routing silently, with no way to see what is being made and no guaranteed plain-chat path, after removing the explicit mode (HN 49729412).** Name the output type on the card, make it reversible ('Make this a page instead'), offer an optional Make picker, and add per-type off switches (R-028).
- **Two AI channels or generation paths for one outcome: a second agent chat inside the editor, an agent chat list as its own destination, and generate_deck competing with use_figma (Figma).** Juno's split between chat re-emit and Ask Juno is the same defect. One channel through the conversation, and one write path per kind (R-010, R-032).
- **Replacing a validated scene-operation layer with HTML artboards whose properties panel rewrites inline styles (Claude's Design type), or with model-written JavaScript run against the document (Figma use_figma).** Juno's validated, invertible, id-deterministic operations are its strongest asset (00-AUDIT §8.1). Host code as embeds, and let the server expand selectors into operations (R-009, R-080).
- **Either extreme on verification: a blanket 'never verify unless the user asked' rule (Claude Slides and Design types), or an expensive screenshot check on every turn.** X-07 shows unverified output becoming current. Verify deterministically instead: completeness, validation, render success, console errors and a design lint (R-007, R-035, R-047).
- **Parallel agents writing to the same object with hot reload (Cursor subagents).** Juno versions by compare-and-swap, so this causes storms of 409 conflicts or lost edits. Serialize per artifact, and run in parallel only across artifacts (R-038).
- **Generating from a narrow set of canned templates (Figma pulled Make Designs in 2024 over Apple Weather look-alikes).** Templates cause look-alikes. Variety comes from taste-form answers, the design system and explicit directions (R-045, R-046).
- **Uneven agent and API reach across types, and formats the vendor's own API refuses (Figma's create_new_file can't make Buzz, Sites or Make files; get_metadata fails on Slides; REST rejects Make).** It makes some types second-class and reads as lock-in. Every Juno kind must pass the tool-contract conformance test, and exports always carry source (R-032).
- **Designing against reference UI that hasn't been verified, such as Figma's blue on-canvas status bubbles, which appear only in blog mockups.** Build on documented primitives. Use one presence cue and one label per scope (R-034).
- **Collapsing per-action risk approvals into one global Auto mode (Claude Cowork).** Juno's approval card, with risk classes and digest-bound receipts, is stronger for actions that leave Juno. Review versus Apply directly applies only to artifact edits (R-010).
- **Publish and Copy controls that look alike, so a link goes public by accident (AI UX Playground). Juno is worse: its dialog creates a public link just by opening.** Publishing must be one deliberate, labelled action. A dialog never publishes when it opens (R-015).
- **Contradictory first-party rules. Claude's help says every viewer needs an account, while its Code docs say public links need no sign-in. Figma's own pages disagree on who can see agent chats.** Sharing and privacy are trust decisions. Juno states one policy, inside the dialog itself (R-015, R-073).
- **Blocking all external images in previews (the CSP on Claude's hosted artifacts).** PREMIUM_AUDIT §2e found that previews without images read as broken sites. Control egress with connect-src and screening at publish time (R-012).
- **Turning comments off while an artifact is public, and deleting threads before it can go public (Claude Code docs).** Comments live on the artifact. The public link serves a snapshot without comments, so publishing never costs the discussion (R-015, R-040).
- **Public or prototype links that lead back into the working file (Figma's 'Open in editor' on Starter prototypes; its prototype-only link lives in presentation view).** A published snapshot never links to the editable artifact or its chat unless the viewer has a grant (R-015, R-088).
- **Guest comments on public links, turned on by default (Lovable, 2026-06-26).** Juno's public links have no takedown or moderation yet (X-31, X-32). Guest comments default off, behind screening and rate limits (R-011, R-040).
- **Gating core features and basic safety by plan or seat. Examples: Dev seats; Check designs only on Org/Ent; link passwords, expiry and logs only on Enterprise; seat type plus file permission as two separate gates; and export limits discovered only at export time (Figma).** Keep the editor, sharing safety and checks on every plan. One role per person per artifact, and show limits before the user sets anything up (R-011, R-039, R-047, R-083).
- **Making AI chats visible to collaborators by default, and changing that default for existing users (Figma agent chats, 2026-06-23).** Juno conversations mix private context with the work. Share only activity scoped to the artifact, labelled where the user types (R-073).
- **Viewer IP addresses in logs that owners or admins can see, with only an account-wide opt-out.** GDPR applies, since Juno's legal pages are French. Keep views as aggregates, name viewers only when they are signed-in grantees, and let people choose per context (R-011, R-074).
- **Blocking sharing changes on phones (Claude's native apps).** Revoking a leaked link is urgent and must work from any device (R-015, R-069).
- **Promising phone editing while shipping view-only. Claude's launch copy and TechCrunch said you could edit on your phone, while the help centre says view-only. Other cases: app screenshots or Mirror-style streaming that imply editing; types missing on mobile, or sharing that works only on desktop (Figma mobile, Gemini, NotebookLM, v0, ChatGPT Library).** Trust is lost in the gap between promise and product. Juno's iPhone already edits designs. Publish an explicit phone contract, and ship every type as at least readable and commentable on iPhone (R-069).
- **Comments that can disappear before the model reads them, or that are stored inside the document body (a known issue in Claude Design; Juno's DesignComment).** Comments must survive versions, folds and model edits, and need their own permissions. Store them in their own table, with optimistic writes and local drafts (R-040).
- **Comments anchored only to top-level frames, and lost across branches or versions (Figma).** Anchor to the deepest node by stable id, with fallbacks, and keep pins across versions (R-040).
- **A separate bell or inbox destination for notifications.** TWO_PRODUCTS §2.2 already rejected an inbox. Use the Needs you fold, push notifications and email digests (R-042).
- **Building audio, cursor chat and spotlight before asynchronous review works.** Comments, notifications and viewer history deliver value first (R-040, R-042, R-074).
- **Single-player AI design with no shared version history and hard generation caps (Google Stitch).** Directions and streaming are safe only when every result is a version that can be commented on and restored (R-046).
- **Git vocabulary in a chat product ('branch per chat, PRs against main' in v0; 'Branching, Merge' in Framer).** Say 'Try 2', 'Use this' and 'Keep both'. Git words belong in Juno Code (R-029).
- **Auto-send that fires before the user is ready (Builder.io on Claude Design).** It sends before the user has finished answering. Typed text becomes an extra answer, and the user sends when ready (R-045).
- **Creation tiles that start generating the moment they are tapped (NotebookLM Studio).** Nothing runs without Send (TWO_PRODUCTS §2.2). Tiles only prefill the composer (R-079).
- **A multi-option canvas that switches into a pan-only mode, where mocks can't be scrolled or clicked (Builder.io on Claude Design).** Directions are useful only if each one can be inspected and played. Panning and interaction never trap each other (R-046).
- **Opaque or punitive metering: a hidden weekly design allowance that locked a reviewer out for a week; charging credits for trivial or deterministic edits (60 to 98 credits for a label); metering pointing, drawing and inline text edits (PCWorld; Figma Make forum; Lovable).** Juno meters only sending to Juno, shows plain numbers, and refunds its own failures (R-036).
- **A camera that follows the agent while it streams.** It fights the user's own navigation. Pan only when new content is fully off-screen and the user has been idle for 1.5 s (R-033, R-046).
- **Silent failures and surfaces disabled without explanation: storage writes that fail until publish, blocked localStorage, and an editor greyed out with 'no ETA' (Claude; v0 Design Mode 2026-02/03).** Juno's worst defects are silent: X-01, X-07, dropped Mac drafts, and a false 'No designs yet'. Every failed write, render or save says so where the user is looking, with one next step (R-007, R-035).
- **Silent lossy handoff or import: dropped interactions and missing shader visuals in Figma's MCP, and lossy HTML imports called 'fully editable' (Canva Code 2.0).** List every loss where the person exports or imports (R-066, R-081, R-082).
- **Publishing generated output without semantic structure or accessibility checks (Figma Sites at launch: 210 axe issues and div soup; Stitch output).** Semantics must live in the model and the exporters before anything can be published (R-084, R-047).
- **Shipping through feature flags and waitlists, and irreversible, forced or silently phased migrations (Claude's 'can't switch back'; Figma's UI2 removal on 2025-04-30; the 2026 nav bar with no opt-in; Motion APIs behind a flag). Juno's capabilities.ts marks an unused CRDT as 'stable'.** Ship the merge behind a reversible flag, with redirects, a transition note and one release window across platforms (X-19). Label capabilities honestly (R-018, R-039).
- **Ambient or decorative motion in chrome: rotating tips or feature ads while work is live, and a travelling shimmer band on the composer or canvas (HN; ChatGPT Apps SDK composer; Figma blog mockups).** ICONS_AND_MOTION rule 9 allows loops only for live state, and PREMIUM rule 14 bans borrowed loading sweeps. Live states show progress with the breathe (R-034, R-071).
- **Fake progress: an asymptotic bar that approaches 95% and never passes it (Claude's context compaction, observed in the shipped Claude desktop app).** Numbers, never meters (PREMIUM rule 7; TWO_PRODUCTS §3). Show real counts, such as '2 of 3 screens' (R-071).
- **Extra meaning-bearing colours: a second brand colour for AI actions, pink, blue and purple affordance colours, colour-coded state outlines and callouts, and folders told apart only by colour (Claude's clay; Figma; Buzz; Make; Figma folders).** FLAT_UI allows one accent, used for state. Mark AI changes by provenance and the emphasis halo, and always pair colour with a glyph and text.
- **Per-word or per-grapheme animation on streaming response text (Claude's word fade; grapheme blur).** Juno removed it for compositor cost. The .stream-tail mask is the only 'still arriving' signal. Grapheme reveal is kept for titles only (R-095).
- **Instant swaps and zero-duration fades under reduced motion (Claude).** Juno's tiered policy (ICONS_AND_MOTION §2.2 rule 10) removes travel and scale but keeps fades, which stay readable without triggering motion sensitivity.
- **A second motion system: importing another product's token ladder, two spring models (physical for prototypes, bounce for keyframes), or several overlapping animation models (Claude desktop's token ladder; Figma prototypes, Motion, Slides and Sites).** One ladder and one duration-plus-bounce spring form, generated to CSS, framer and Swift, and one evaluator (R-019, R-049).
- **Colour pickers limited to design-system colours (go9x on Claude Slides).** Tokens come first, but real decks need one-off colours. Put custom colours one step away (R-051, R-059).
- **Locking the file with a recovery mode at a memory limit, and an undismissable red alert (Figma, 2 GB).** Refuse only the edit that would exceed the limit, explain why, and offer to split the file or move assets (R-064).
- **Eagerly loading every variant in a component set (Figma).** It costs memory. Resolve Juno instances lazily (R-048).
- **Chasing breadth before correctness: Figma's materials (shaders, brushes, textures, 3D) and trigger types (gamepad, video timestamps).** Juno's renderer ignores container opacity (X-24), its preview disagrees with export, and its core triggers are wrong. Fix correctness and the merge first (R-019, R-056, R-090).
- **Executable programs (shaders) in the scene's effect stack (Figma: one per page, blank without WebGPU, missing from code export and video).** Every effect stays a recipe that every exporter can honour. Live visuals go in sandboxed embeds with poster fallbacks (R-080).
- **Authored animation that auto-plays and can't be started, stopped or reversed by an interaction, and overlays that replay backwards on close with no control (Figma Motion).** Juno's play-animation action and explicit on-close behaviour must be honoured by the runtime (R-056).
- **Matching layers across screens by name and position in the hierarchy (Figma Smart Animate).** It breaks on rename. Match by a key that is copied when a layer is duplicated (R-055).
- **A record or auto-keyframe mode that stays on.** Stray edits become keyframes. Make it loud, and have it switch itself off (R-054).
- **Long default durations for interface motion (Figma defaults to 2000 ms, against its own 0.25 to 0.7 s guidance).** Keep 1000 ms, with the 70 to 560 ms token ladder (R-054).
- **One timeline per top-level frame; top-level frames that can't be animated; and export only from top-level frames.** Juno's named animations per document, plus states, are more expressive (R-083, R-085).
- **Shipping prototype motion without runtime conformance tests (Figma's end-state flash lasted about 12 weeks).** Play does not ship before R-019's conformance suite passes.
- **Tweaks that are mutually exclusive, or combinations that silently do nothing (Builder.io on Claude Design).** A control that does nothing destroys trust in the whole panel. Tweaks bind separate properties and say when one overrides another (R-043).
- **Inline visuals without a rule: artifacts and visuals chosen inconsistently for the same request, and unrequested visuals that make an answer look more certain than it is (HN 47352751).** One written rule: inline means an ephemeral explanation, an artifact means something to keep. BUILD replies get no blocks, and 'Save as artifact' is always available (R-077).
- **Inline visuals hidden in some shared views (shown only to logged-in viewers; Cowork's 'Interactive visual hidden when shared').** A shared link should show what the sender saw. Render static versions for every viewer (R-077).

## Coverage

- R-ids in the backlog: 101. Placed in a phase: 101. In the icebox: 0.
- Split across phases: R-004 (0A (lifecycle); 1), R-007 (0A (core); 1), R-012 (0A (owner half); 0B), R-015 (0B (part); 1 (pins); 3), R-063 (2 (surface); 5 (editor)), R-064 (1 (part); 5 (rest)), R-068 (3 (part); 4 (with the glass release)), R-069 (3 (part); 6), R-074 (6 (part: soft leases and presence); 7 (rest: live cursors)), R-075 (4 (pin); 6 (rest)), R-079 (2 (the list); 3 (tries); 5 (Turn into)), R-096 (7; ed).
- X-ids with a closing phase: 33 of 33; missing: none.
