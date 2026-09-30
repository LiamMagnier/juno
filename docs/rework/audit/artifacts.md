# Refoundation audit: Artifacts, Canvas and Design

Phase 0, read-only. Written 2026-09-30 against `rework/refoundation` (= main `1feb392c`). Web production runs `a4f8b992` or later, which already contains First light (`a6168f38`) and the X-01 preview fix (`16fc3009`). All code claims cite `path:line` in this worktree. Competitor claims cite URLs, with dates where the page gives one. **UNVERIFIED** marks claims I could not check from code or a primary source.

Prior art: `docs/design/artifacts-design/` holds about 1.1 MB of audit, research and merge-plan docs (00–05, HANDOFF, research/, wip/). This report re-checks those findings against today's main and does not repeat them. §2.2 has the defect-by-defect status.

---

## 0. Verdict in one paragraph

Juno's *making* half is strong. It has one `Artifact` row for all seven types, with append-only text versions, a line diff and restore, an honest stale-write guard, a real preview sandbox with its own CSP, verified Office export, and a serious design engine (validated transactions, server posters, 9 export formats). The *keeping and publishing* half is not built. An artifact still belongs to its chat and dies with it. The only public surface is a frozen, anonymous snapshot link. That link is minted the moment the Share dialog opens, cannot be updated, rolled back or pinned, and runs no scripts. Nothing can be duplicated, remixed or exported to GitHub. Native clients each implement a different subset. Judged against the lifecycle the market now treats as table stakes (publish → stable URL → private/org/public → deploy revision → roll back → export/fork), Juno scores **1.5 of 7** (§3.1). The unmerged `artifacts/r1-lifecycle` branch holds useful parts of the fix, but it is built on a workaround (a hidden "anchor" conversation) that a refoundation should not inherit.

---

## 1. Map

### 1.1 Data model (`prisma/schema.prisma`)

| Model | Lines | What it is | Notes |
|---|---|---|---|
| `Artifact` | 1208–1227 | One made thing: `identifier` (the model's handle), `title`, `type`, `language`, `currentVersion` | **Owned only through `conversationId`** (`onDelete: Cascade`, :1220). No `userId`, `projectId`, `deletedAt`, publish state or slug. `@@unique([conversationId, identifier])` |
| `ArtifactVersion` | 1229–1242 | Full body per version (`content Text`, `origin` generated/edit/restore) | Text types are append-only. **DESIGN checkpoints are rewritten in place** (see §3.2 B1) |
| `ArtifactType` enum | 1465–1478 | HTML, REACT, CODE, MARKDOWN, SVG, MERMAID, DESIGN | No Doc, Deck or Sheet type. "Typed" Office outputs live only in Work |
| `Share` | 1933–1968 | Token link to a CHAT or an ARTIFACT; `snapshotAt`, `views`, `revokedAt`, `takenDownAt/By/Reason` | No version pin, no audience or role, no publish state, no expiry |
| `ShareReport` | 1970–1995 | Anonymous visitor reports, for admin only | Real |
| `WorkArtifact` / `WorkArtifactVersion` | 2776–2841 | A **second artifact system** for agent deliverables (docx/xlsx/pptx/pdf/site…) in object storage, with SHA-256, validation and provenance | Not listed in Artifacts, not shareable, not in the Artifacts index |

### 1.2 Server routes

| Route | File | Does |
|---|---|---|
| `GET /api/artifacts[?projectId]` | `src/app/api/artifacts/route.ts:32-117` | Lists up to **200** (`take: 200`, :41), newest first, with a 1,200-char SQL `left()` preview. No pagination; search runs client-side |
| `GET/POST/PATCH/DELETE /api/artifacts/[id]` | `src/app/api/artifacts/[id]/route.ts` | GET returns **every version body** (`include: { versions: true }`, :20-25). POST appends a version with `baseVersion` CAS and a 409 (:40-90), **without validating a DESIGN body** and without a rate limit. DELETE is a **hard delete** that cascades shares (:113-126) |
| `GET /api/artifacts/[id]/export?format=` | `.../export/route.ts` | MARKDOWN → docx/xlsx/pptx. Formats are detected server-side, rate-limited, re-opened and verified before streaming (`office-export-verify.ts`) |
| `GET /api/artifacts/[id]/poster` | `.../poster/route.ts` | Server-rendered SVG poster of a design |
| `POST /api/design` | `src/app/api/design/route.ts:38-105` | "New design": **creates a hidden-purpose chat** titled after the design (:72-80) plus a DESIGN artifact, and returns `/a/{id}` |
| `POST/GET /api/design/[id]/transactions` | `.../transactions/route.ts` | The design write path. Validated ops against `baseRevision`, 409 on conflict, no rate limit |
| `POST /api/design/[id]/edit` | `.../edit/route.ts` | "Ask Juno" design proposals (ops), rate-limited |
| `GET /api/design/[id]/export` | `.../export/route.ts` | SVG/PDF/HTML/PNG/handoff bundle. No rate limit |
| `POST/GET /api/share`, `DELETE /api/share/[id]` | `src/app/api/share/*.ts` | Create or **reuse** a link, list links, revoke. No rate limit |
| `/share/[token]` + `/share/[token]/poster` | `src/app/share/[token]/*` | Public page, force-dynamic, noindex; poster rate-limited per IP |
| `/api/share/report`, `/api/admin/shares/*` | — | Report link, admin takedown and restore (`src/lib/share-moderation.ts`) |
| `/sandbox/v1/[profile]` | `src/app/sandbox/v1/[profile]/route.ts` | Preview shell with its own CSP. Refuses non-iframe `Sec-Fetch-Dest` |
| `/a/[id]` | `src/app/(app)/a/[id]/page.tsx` | Owner-only canonical page: the design editor at the latest version, otherwise the read view |
| `/design`, `/design/[id]` | `src/app/(app)/design/*` | 307 redirects to `/artifacts?type=DESIGN` and `/a/{id}` |

### 1.3 Web UI

- **Chat inline card**: `src/components/chat/artifact-inline-card.tsx` (554 lines). Live preview, view switch, "Open in canvas".
- **Canvas panel** (chat side panel): `src/components/canvas/canvas-panel.tsx` (1,411 lines). Preview / Console / Code tabs, device widths, element **inspect** → quote into composer, History rail with **diff** (`diffLines`, copy unified diff) and **Restore vN**, Share, Download, Office export (MARKDOWN only, `canExportOffice = isMarkdown && shareable`, :232), and the embedded `DesignEditor` for designs.
- **Sandbox**: `src/components/canvas/sandbox-frame.tsx` (1,024 lines), `sandbox-document-frame.tsx`; policy in `src/lib/sandbox-policy.ts`, shell in `src/lib/sandbox-shell.ts`.
- **Artifacts home**: `src/app/(app)/artifacts/page.tsx` (1,025 lines). Type-filter chips (Design is a filter), New menu with design size presets, grid and list, per-item menu Rename / Download source / Share / Delete (:289-303). Tiles come from `src/components/artifacts/artifact-preview.tsx`.
- **Artifact page**: `src/app/(app)/a/[id]/artifact-read-view.tsx`. Title, `‹ vN ›` stepper, Preview/Source, "Open in chat". **No Share, Restore, Export or Delete.**
- **Design**: `src/components/design/*` (about 13k lines). Editor shell, canvas, layers, inspector, effects, motion, interactions, history, Export menu; `design-workspace.tsx` adds rename, delete and the **Ask Juno** bar (web only).
- **Share**: `src/components/share/share-dialog.tsx` (creates on open), `shared-artifact-viewer.tsx`, `shared-chat-transcript.tsx` (artifacts appear as inert chips), `shared-links-card.tsx` (Settings), `report-share-dialog.tsx`.

### 1.4 Native (Mac, iPhone, iPad)

| Piece | File |
|---|---|
| Artifact store, sync projection, API client | `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeArtifactStore.swift`, `NativeArtifactAPIClient.swift`, `ChatArtifactResolver.swift` |
| Preview runtime (WKWebView, `juno-runtime:` bundle, **network closed**) | `NativeArtifactPreview.swift`, `NativeArtifactRuntime.swift` (:155-260), `NativeArtifactRuntimeWebView.swift` (`isOpen = false`, :418) |
| Design document mirror | `JunoDesignKit/DesignDocument.swift`, `DesignDocumentCodec.swift`, `DesignBridge.swift` |
| **Hosted web design editor** (same React editor, bundled) | `native/macOS/JunoDesktop/Resources/DesignEditor/{index.html,editor.js,editor.css}`; built by `scripts/build-design-editor.mjs`; CI freshness check in `.github/workflows/native.yml:146` and `release-ios.yml:76`; iPhone reuses the Mac folder (`JunoMobile.xcodeproj/project.pbxproj:185`) |
| Mac surfaces | `ArtifactPage.swift` (read-only page, plus the design editor with an explicit Save/Discard), `DesktopArtifactCanvas.swift` (chat dock), `InlineArtifactCard.swift`, `DesktopArtifactsScreen.swift` (list: Share…, Rename, Delete), `DesktopSharePopover.swift`, `ArtifactDesignStart.swift` (New design), `ArtifactPageSupport.swift` (diff engine) |
| iPhone/iPad surfaces | `JunoMobileWorkspaceViews.swift:750+` (Artifacts list), `:1787+` (`JunoMobileArtifactDetail`: version chip, Restore, Office export, system share of source, Delete, design edit + Save), `JunoMobileInlineArtifact.swift`, `JunoMobileDesignArtifact.swift`, `JunoMobileDesignEditorHost.swift` |

### 1.5 Data flows

1. **Chat creates or revises.** The model emits `<juno:artifact identifier type title>` (`src/lib/chat/system-prompt.ts:251`). The server then verifies it (`chat-artifact-verification.ts`: size, incomplete block refused as X-07) and persists after the assistant message (`src/app/api/chat/route.ts:3311-3316` → `persistArtifacts`, `src/lib/artifacts-store.ts:88-174`). Same identifier: append a version with no base check. Different type: retire the old row as `{id}~{tail}` and create a new one. DESIGN compact form → `normalizeDesignArtifact`, a full rebuild (:17-36). The `done` frame carries the rows, the card and canvas render, and the change log syncs `artifact` / `artifact_version` rows to native with full bodies (`src/lib/sync-entities.ts:227-262`).
2. **Targeted AI edit** (select text or element → "edit"): the patch protocol (`src/lib/artifact-edit.ts`) is applied with CAS (`persistTargetedArtifactEdit`, `artifacts-store.ts:182-206`). This path is correct.
3. **Manual edit / restore**: web canvas or iPhone → `POST /api/artifacts/[id]` with `baseVersion` → append (`origin` edit/restore).
4. **Design edits (web)**: every gesture → `POST /api/design/[id]/transactions`. It folds into the newest checkpoint row if that row is <30 s old and user-authored (`src/lib/design/store.ts:123-126`, `operations.ts:511,529-539`), otherwise it appends.
5. **Design edits (Mac/iPhone)**: the hosted editor keeps a local draft; **Save** posts the whole document to the generic `POST /api/artifacts/[id]` (`ArtifactPage.swift:196-198` → `NativeArtifactStore.swift:336-343`). That is a second save semantic that skips design validation.
6. **Share**: opening the dialog → `POST /api/share` → reuse the newest active link or mint a token with `snapshotAt = now` (`src/lib/share.ts:113-135`). The public page serves the newest version with `createdAt <= snapshotAt` (`share.ts:290-318`) in the `static` sandbox profile unless `JUNO_PREVIEW_ORIGIN_PUBLIC=1` (`sandbox-policy.ts:93-95`).

---

## 2. What is real, what is gated, what is dead

### 2.1 Capability ledger

| Capability | State | Evidence |
|---|---|---|
| Seven artifact types, live previews on web (HTML/React/TSX/Tailwind/Mermaid/SVG/Python console) | **Real** | `sandbox-frame.tsx`; shell policy `sandbox-policy.ts:214-254`; `/dev/sandbox` gallery (404 in prod, `src/app/dev/sandbox/page.tsx:13`) |
| Preview isolation (opaque origin, own CSP, frame-only shell, nosniff, egress allowlists) | **Real** | `sandbox-shell.ts:100-145`; `sandbox-policy.ts:117-188` |
| Separate preview **domain** | **Gated / not configured** | `NEXT_PUBLIC_SANDBOX_ORIGIN` commented out in `.env.example:52`; the nginx block is commented (`deploy/nginx.conf.template:127-141`). Previews use the app origin |
| Scripted public previews | **Gated off** (`static` profile) | `sandbox-policy.ts:93-95`. React, Mermaid and JS show as source on `/share` (`shared-artifact-viewer.tsx:55-60`); HTML renders without scripts |
| Version history, diff, restore | **Real on web canvas panel**, partial elsewhere | `canvas-panel.tsx:378-450,935-1095`. Not on `/a/{id}`; Mac has diff but **no restore**; iPhone has restore but **no diff** |
| Stale-write guard | **Real** for manual saves and targeted edits; **absent** for model re-emits (X-05) | `api/artifacts/[id]/route.ts:51-56`; `artifacts-store.ts:130-154` |
| Console | **Real** (web, Mac, iPhone) | `canvas-panel.tsx:151-200`; `ArtifactCanvasView.swift:229+` |
| Element inspect → "ask about this" | **Real on web only** | `canvas-panel.tsx:700-735`. The Mac runtime deliberately omits the inspector (`NativeArtifactRuntime.swift:180-181`) |
| Office export docx/xlsx/pptx | **Real** for MARKDOWN on web and iPhone; **dead on Mac** | Route verifies output (`export/route.ts:119-137`). Mac `exportLabel` (`ArtifactPageSupport.swift:564`) is never called; iPhone uses `exportArtifact` (`JunoMobileWorkspaceViews.swift:2137-2248`) |
| Design editor (web) | **Real**, deep | 13k lines; transactions, undo inverse, posters, 9 exports |
| Design editor (Mac/iPhone, hosted web bundle) | **Real but degraded** | Export and handoff menu **cannot work**: the hosted page's CSP is `connect-src 'none'` (`Resources/DesignEditor/index.html:16`), `exportAs` uses `fetch` (`design-editor.tsx:307-313`), and nothing gates on `isHosted()`. Popover and menu materials are missing (X-17). No Ask Juno |
| Canonical `/a/{id}` | **Real** (owner-only) | `a/[id]/page.tsx`; tab title is still "Artifact" (`src/lib/route-title.ts:37`) |
| Public share link | **Real but frozen snapshot**, anonymous only | `share.ts:11-17,120-124,290-318` |
| Governance (ban propagation, takedown, report, admin) | **Real** | `share.ts:165-182`; `share-moderation.ts:95-330`; `ShareReport` |
| Publish-time screening of content (X-32) | **Absent** | No classifier call in `share.ts` or the artifact routes. This is why scripted public previews stay off |
| Trash / Recently deleted | **Absent on main** (hard delete); WIP on `artifacts/r1-lifecycle` | `api/artifacts/[id]/route.ts:124` |
| Duplicate / remix / fork | **Absent** | No route or UI (grep for remix, fork and duplicate in the artifact code finds nothing) |
| GitHub export of an artifact | **Absent** | Only the design editor's "Juno Code handoff bundle…" (`design-editor.tsx:695`) |
| Account export includes artifacts | **Absent** | `src/app/api/account/export/route.ts:79-223` exports conversations, messages, memory, projects, attachments and summaries, and no Artifact, ArtifactVersion or Share rows |
| Work deliverables in the Artifacts index | **Absent** (separate system) | `/api/artifacts` queries only `prisma.artifact`; deliverables live in `src/components/work/work-documents.tsx` |

### 2.2 Status on main today of the 2026-09-24 defect index (`00-AUDIT-OVERVIEW.md` §7.1)

| ID | Defect | Status on `1feb392c` | Evidence |
|---|---|---|---|
| X-01 | CSP-dead previews | **Fixed, deployed** (shell origin); separate domain not set | `sandbox-policy.ts`; `.env.example:52` |
| X-02 | Canvas design editor remount | **Fixed** | `499b6afd` in main |
| X-03/04 | Edit/regenerate deleted artifacts | **Fixed** (detach, not delete) | `artifacts-store.ts:59-61`; `chat/route.ts:2694` |
| X-05 | Model re-emit overwrites user edits, no base check | **Open** | `persistArtifacts` appends unconditionally (`artifacts-store.ts:130-154`); only the targeted-edit path does CAS |
| X-06 | Chat revision of a design rebuilds the document | **Open** (structural) | `normalizeForStorage` → full `normalizeDesignArtifact` rebuild (`artifacts-store.ts:17-36`) |
| X-07 | Truncated revision saved as current | **Fixed** | `artifacts-store.ts:101`; `chat/route.ts:3311-3316` |
| X-08 | Design size unchecked after expansion | **Fixed** | `artifacts-store.ts:21-29` |
| X-09 | Native store fails closed | **Partly fixed**: unknown kinds and over-long versions are skipped; malformed records still throw | `NativeArtifactStore.swift:101-120,156,170` |
| X-10 | Compact `image` node refused the design | **Partly fixed** (placeholder) | `d04065c6` |
| X-11/12 | Mac dock showed a stale or compact body | **Fixed on Mac** (row resolver); iPhone **UNVERIFIED** | `ChatArtifactResolver.swift` |
| X-13 | Mac previews blocked all CDNs | **Changed, not closed**: engines bundled, but the network is closed, so any other CDN library, remote image or font fails on Mac while it works on web | `NativeArtifactRuntime.swift:229-248`; `NativeArtifactRuntimeWebView.swift:418` |
| X-14 | Swift lacks `cornerSmoothing` | **Fixed** | `DesignDocument.swift:501,563,670` |
| X-15 | Mac design Save uses the synced version as base | **Open on the path actually used**: the page calls the 2-arg `saveArtifact`, which takes `artifact.currentVersion` at save time; iPhone does the same | `ArtifactPage.swift:196-198`; `NativeArtifactStore.swift:336-343`; `JunoMobileWorkspaceViews.swift:2233-2236,2276` |
| X-16 | Unsaved Mac drafts dropped | **Open**: `draft` is view `@State`, with no leave guard | `ArtifactPage.swift:33,134-150` |
| X-17 | Hosted editor CSS lacks shared primitives | **Open**: `surface-float` and `overlay-glass` appear 0 times in the bundle CSS but 11 and 9 times in design components (defined in `src/app/globals.css:1125`) | `Resources/DesignEditor/editor.css` |
| X-18 | Hosted editor hid its inspector | **Likely fixed** (container-query layout, `design-editor.tsx:570`); visual check **UNVERIFIED** | — |
| X-19 | Stale hosted bundle | **Mitigated**: rebuilt 09-26/27, CI check in `native.yml:146` | `c9fd7959`, `d9cc5dcd` |
| X-20 | Shared design showed JSON | **Fixed** (poster) | `share/[token]/page.tsx:120-131` |
| X-21 | Project page artifacts | **Fixed** | `api/artifacts/route.ts:36-39` |
| X-22 | Chat delete cascades artifacts, versions and shares; copy says "messages" | **Open** | `schema.prisma:1220`; `api/conversations/[id]/route.ts:80-90`; copy at `app-sidebar.tsx:2481-2483` |
| X-23/24/26 | Export 500, renderer groups, deliverable purge | **Fixed** | release train 09-24 |
| X-30/33 | Design reads load every version; no rate limits; unbounded versions | **Open** | `design/store.ts:32-38`; `api/artifacts/[id]/route.ts:20-25`; no `rateLimit` in the transactions, artifact POST or share POST routes |
| X-31 | Banned user's shares serve | **Fixed** (ban read per request; takedown) | `share.ts:165-182` |
| X-32 | Public content never screened | **Open** | — |

---

## 3. Problems

### 3.1 Lifecycle readiness vs. the market

| Capability | Juno today | Claude (artifacts) | Lovable | v0 | Figma Sites |
|---|---|---|---|---|---|
| **Publish** as an explicit act | ✗ Opening Share **mints a public link** (`share-dialog.tsx:90-98`; Mac same, `DesktopSharePopover.swift:133`) | ✓ private until shared; Share control | ✓ Publish button, security scan first | ✓ Publish flow | ✓ Publish |
| **Stable live URL** | ✗ `/a/{id}` is owner-only; `/share/{token}` is frozen at `snapshotAt`; re-sharing returns the **same old snapshot** (`share.ts:120-124`) | ✓ same URL, "updates in place" | ✓ `*.lovable.app` or custom domain | ✓ "stable production URL" | ✓ same domain on republish |
| **Private / org / public** | Partial: owner-only or anonymous public. No people, org or roles. iPhone cannot link an artifact (`JunoMobileConversationsView.swift:495` shares chats only, though `NativeShareClient.share(artifactID:)` exists at :67) | ✓ private, org people or everyone, public; viewer/editor roles | ✓ public / workspace / custom (by plan) | ✓ visibility setting | ✓ |
| **Revision deploy** (push vN to the live link) | ✗ impossible without revoke + new URL | ✓ "each publish becomes a version"; pick the version viewers see; "Always share latest" default on | ✓ "Publish changes", with a dot for unpublished changes | ✓ each publish updates prod | ✓ Update |
| **Rollback** of what the public sees | ✗ restore changes only the owner's copy; the link stays frozen | ✓ choose an older version in Share | ✓ restore a version, then publish | ✓ Vercel rollbacks / "restore an earlier chat version, then publish again" | ✓ Republish a previous version |
| **GitHub export** | ✗ | n/a (page capture) | ✓ two-way GitHub/GitLab sync | ✓ PR or new repo per branch | n/a |
| **Remix / fork** | ✗ | ✓ copy a published artifact as your own (Free/Pro/Max) | ✓ Remix in project settings | ✓ fork main branch | ✓ duplicate |
| Abuse controls on public pages | ✓ report, takedown, ban propagation (ahead of most) | ✓ "user-generated and unverified" label; admin kill switch | ✓ pre-publish security scan | — | — |

Juno has one full capability (abuse controls) and a half on sharing, so **1.5 of 7**.

Sources (fetched 2026-09-30):
- Claude Code artifacts docs, https://code.claude.com/docs/en/artifacts (undated page): each publish is a version; "Always share latest version" toggle; org and public sharing; editor role; comments; the `Content is user-generated and unverified.` label; the `*.claudeusercontent.com` sandbox origin; org switch for external sharing.
- Claude support article, https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them ("updated this week"): artifacts are account-owned in the Artifacts tab; remix by copying a published artifact; exports of Docs, Slides and Designs.
- Claude blog, https://claude.com/blog/cowork-is-now-claude, and TechCrunch, https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/ (2026-09-16): Docs, Slides and Design live inside conversations.
- Lovable publish docs, https://docs.lovable.dev/features/publish (undated): snapshot to a stable URL, explicit "Publish changes", unpublish, visibility tiers, security scan. Remix and GitHub sync come from the search summary of https://docs.lovable.dev/integrations/github and the Lovable FAQ (not fetched in full).
- v0 deployments, https://v0.app/docs/deployments ("last updated 2026-09-30"): stable production URL, preview deployments, rollbacks via Vercel. GitHub PR or repo export comes from the search summary of https://v0.app/docs/github (not fetched in full).
- Figma, https://help.figma.com/hc/en-us/articles/31242845959703-Publish-update-or-unpublish-a-site (via search snippet, undated): publish / update / unpublish, the same domain on republish, "Republish" a previous version.
- ChatGPT Canvas was reportedly sunset May–Aug 2026 (https://www.ai-toolbox.co/..., secondary only). **UNVERIFIED**.

### 3.2 Correctness bugs (new in this pass, or re-confirmed)

- **B1. Post-share design edits leak into the public link.** A share is supposed to freeze at `snapshotAt`, and the dialog promises "Later edits stay private" (`share-dialog.tsx:133`). But a design edit inside the 30 s checkpoint window **rewrites the existing version row in place** (`design/store.ts:179-200`; window `operations.ts:511`), and `createdAt` does not change. The share resolver picks the newest version with `createdAt <= snapshotAt` (`share.ts:299-303`), so edits made up to about 30 s after sharing appear on the public poster, cached publicly for 5 min (`share/[token]/poster/route.ts:31-55`). The cause is that "version" is not immutable. Severity: medium (privacy promise broken, bounded window).
- **B2. The generic save bypasses design validation.** `POST /api/artifacts/[id]` stores any string up to 200k as a new version, whatever the type (`api/artifacts/[id]/route.ts:7-16,61-75`). The design route's own comment claims there is "deliberately no replace-the-document endpoint" (`transactions/route.ts:17-24`). Mac and iPhone design Save use exactly this generic route. So a native codec drift (X-14 was one) stores documents the web editor may refuse.
- **B3. Native saves overwrite newer versions (X-15, still live).** See §2.2. `saveArtifact(id:content:baseVersion:)` exists, but the page and iPhone call the 2-arg overload.
- **B4. Hosted editor Export is dead on Mac and iPhone.** The menu is always shown (`design-editor.tsx:673-697`) but its fetch is blocked by `connect-src 'none'` (`Resources/DesignEditor/index.html:16`). Runtime failure is inferred from the CSP; a click-through is **UNVERIFIED**.
- **B5. Deleting a "New design" deletes the design.** `POST /api/design` creates a conversation titled after the design (`api/design/route.ts:72-80`), which then sits in Recents. Deleting that "chat" cascades the design, its versions and its public links, and the copy says only "conversation and its messages" (`app-sidebar.tsx:2481-2483`). This is X-22's sharpest edge.
- **B6. No rate limits** on version append, design transactions, design export or share creation (grep: `rateLimit` appears only in the export, poster, edit and report routes). Combined with full-version loads (`include: { versions: true }`), a single account can exhaust memory (X-33).
- **B7. Two AI edit semantics on one design.** The web Ask Juno bar produces reviewable operation proposals (`/api/design/[id]/edit`). A chat request for the same design re-authors the whole document with no guard (X-05/X-06). Mac and iPhone have only the destructive path.
- **B8. Sync amplification (inferred).** Every folded design gesture UPDATEs an `ArtifactVersion` row, and the change-capture trigger ships the full body to every device (`sync-entities.ts:249-264`). **UNVERIFIED** in volume.

### 3.3 Product and UX coherence

- **Four "made-thing" homes remain.** Artifacts (`/artifacts`), Library (files, `/library`), Work Outputs (`work-documents.tsx`, `WorkArtifact`), and Research reports. Office documents are "real" only in Work (validated binaries); in chat an Office file is a Markdown export. Users get two different answers to "make me a deck".
- **Canvas vs page split.** Lifecycle actions are scattered. Share is in the canvas and the Artifacts list menu. Restore is only in the canvas. Delete is in the list and the design workspace. Export is in the canvas and the design editor. `/a/{id}`, the page every link now opens, has none of them (`artifact-read-view.tsx`). The sidebar also drops its selection on `/a/*` (`app-sidebar.tsx:1228`, `active: pathname === "/artifacts"`).
- **Share has no state model.** There is no "Published" indicator on tiles or pages, the only link list is in Settings (`shared-links-card.tsx`), views show inside the dialog, and nothing links "Unpublish" back to the thing.
- **Grid thumbnails of HTML and React are source code**, a 1,200-char excerpt in 10.5 px mono fading out (`artifact-preview.tsx:226-247`). Only designs and SVG get pictures. Claude and Figma show the thing.
- **Shared chats cannot open their artifacts.** They render as inert chips (`shared-chat-transcript.tsx:32-70`).
- **The Artifacts list is capped at 200 with client-side search** (`api/artifacts/route.ts:41`).
- **Docs debt.** The 04 plan is 320 KB with a release train to 2027-04 (`04-MERGE-PLAN.md:1605-1657`). First light already shipped 11 weeks early, so the calendar is fiction. It also still describes Settings › Shared links as retired, which it is not.

### 3.4 Visual: slop and Claude-imitation check

- **Status pills and dots: clean.** They were removed from the card and canvas ("owner directive 2026-09-26", `artifact-inline-card.tsx:289-302`; `canvas-panel.tsx:753`).
- **Gradient sweep while streaming**: an accent `bg-gradient-to-r … animate-gen-sweep` band on the card divider (`artifact-inline-card.tsx:432-435`), mirrored on Mac (`InlineArtifactCard.swift:526-541`), plus `animate-icon-breathe` on the glyph (:330). These are the area's only gradient and pulse. They are functional, but they are the pattern the owner rules call out. Replace with a plain hairline progress or nothing.
- **Share page footer CTA**: a painted `Plate` image under a `bg-card/85 backdrop-blur-xl` card inside a `stage` (`share/[token]/page.tsx:98-111`). That is card-on-image with a faked blur, the marketing-slop shape. The owner accepted "invite readers at the end" (`fb9725d1`), but the glass card is worth removing.
- **Faked materials in native.** The Mac and iPhone design editor is a WebView whose chrome relies on CSS `overlay-glass` and `surface-float`. Those classes are absent from the bundle, so menus are unstyled (X-17). Even when fixed, this is **CSS glass inside a native app**, against the "native Liquid Glass/system components, never faked materials" rule. The editor chrome (toolbar, menus, inspector sheets) should be native, with the web view reduced to the canvas.
- **Claude-imitation risk.** The concept ("Artifacts", `<juno:artifact>` tags, a side canvas, a merged Docs/Slides/Design plan) is openly modelled on Claude. The audit README's stated goal is to merge "the way Anthropic merged Claude chat, Cowork and Artifacts" (`00-README.md:5-8`), and the plan picked the "claude-faithful" proposal for product order (`HANDOFF.md`, "How the merge plan was judged"). The code surfaces do not copy Claude's visual language, and the copy is Juno's own ("Ask Juno", "Made with Juno"). The risk is **strategic, not visual**: a feature-for-feature chase of Claude's 16 Sept launch. Differentiate on what Claude lacks. Claude's docs describe no trash and no report link, and Juno already has multi-model, cost-visible, abuse controls and a native design engine.

### 3.5 Parity: Web / Mac / iPhone / iPad

| Capability | Web | Mac | iPhone | iPad |
|---|---|---|---|---|
| Live preview runtimes | ✓ CDN allowlist, https images | ✓ bundled engines, **network closed** | ✓ same kit | ✓ (iPhone app) |
| Element inspect → quote | ✓ | ✗ (by design) | ✗ | ✗ |
| Version stepper | ✓ canvas and `/a` | ✓ pager | ✓ chip | ✓ |
| Diff | ✓ | ✓ Compare Versions… | ✗ | ✗ |
| Restore | ✓ canvas only | **✗** | ✓ | ✓ |
| Office export (MD) | ✓ | **✗** (dead helper) | ✓ | ✓ |
| Design editor | ✓ autosave transactions, Ask Juno, Export | ⚠ hosted, explicit Save (whole-doc), **no Ask Juno, Export dead** | ⚠ same as Mac | ⚠ same |
| New design | ✓ | ✓ `ArtifactDesignStart.swift` | **✗** (no `/api/design` call in iOS) | ✗ |
| Public artifact link | ✓ (frozen) | ✓ from the list only; dock "Share" is the system ShareLink of **source** (`DesktopArtifactCanvas.swift:767`) | **✗** (system ShareLink of source only) | ✗ |
| Revoke / list links | ✓ | ✓ Settings | ✓ Settings | ✓ |
| Unsaved-draft protection | n/a (autosave) | ✗ | ✗ | ✗ |

---

## 4. Unmerged branches and parallel work

Checked with `git log main..<branch>` and `git cherry main <branch>`.

| Branch | Ahead / behind | Touches this area | Recommendation |
|---|---|---|---|
| `artifacts/r1-lifecycle` (`bf7591d1`, 2026-09-24, worktree `../juno-artifacts-r0`) | 1 WIP commit / **172 behind** | 58 files, +7,337/−237. Schema (`projectId`, `deletedAt`, `ArtifactProposal`, anchor trigger split); `artifact-home.ts` (hidden `anchor_<userId>` conversation); trash, restore and purge (`artifact-trash.ts`, `scripts/purge-artifact-trash.ts`, `share-gone.tsx`); re-emit guard (`artifact-proposals.ts`, `suggestion-bar.tsx`, `suggestion-compare-dialog.tsx`, `artifact-card-state.ts`); about 3,000 lines of tests. Handoff: S3, S4 and S6 are **half-written**, S1b and integration were never done, nothing is gated (`R1-HANDOFF.md`) | **Do not merge as-is.** Harvest the re-emit guard and proposals, the trash and purge, the share-gone page, and the tests. **Replace the anchor-conversation design** with first-class ownership (`Artifact.userId`, nullable `conversationId`) (Rec 1). The anchor exists only to avoid touching every `conversation: { userId }` join, and it adds a hidden conversation kind that every list, search, sync and trigger must exclude forever. Note: `web/rework-ws7` was coding against R1's `persistArtifacts(…, { heldIds, tx })` signature |
| `artifacts/merge-first-light-prerebase` | 10 / 204 | First light, pre-rebase | **Delete.** Every commit is on main (patch-equivalent or re-landed under the same subject: `b4206be9`, `f2ddb021`, `989fb306`, `91e49022`, …) |
| `artifacts/r0-size-and-type` | 1 / 204 | `db3766ab` M11 | **Delete** (`git cherry` shows it on main as `6df1620d`) |
| `wip/artifacts-design-audit` | 8 / 207 | Audit docs only | **Delete.** Main has the same docs (diff is 11 status lines in 3 files, and main is newer) |
| `claude/suspicious-borg-f3e3b4` | 2 / 205 | X-02 handoff note only | **Delete** (the fix shipped in `1633a4b5`) |
| `wip/p4-A-paused` | 1 | Mac Artifacts page and editor bundle, WIP | **Delete**: superseded by merge `8c0b1e62` the same day |
| `web/rework-ws5` | 20 | `artifact-inline-card.tsx` (+8/−3, caption alignment) | Fold in with the chat-rework lane; trivial conflict risk |
| `web/rework-ws7` | 26 | `src/lib/research/artifacts-shim.ts` (+35) | Coordinate: research writes artifacts through `persistArtifacts` (`chat/route.ts:3802`) |
| `agents/rework*`, `design/voice-motion`, `connectors/custom-mcp`, `web/rework-ws1/3b` | — | Only token digests or `shared.ts` name matches | Not relevant |

No other branch implements publish, rollback, remix or GitHub export.

---

## 5. Recommendations, ordered by leverage

**Rec 1. Give artifacts an owner of their own. This is the one schema change everything else needs.**
- Add `Artifact.userId` (backfilled from the conversation), `projectId`, `deletedAt`, and `originConversationId` / `originMessageId`, and make `conversationId` nullable with `SetNull`.
- Switch every ownership join from `conversation: { userId }` to `userId`, and delete the hidden-anchor idea from R1.
- Chat delete then keeps artifacts (X-22, B5), "New design" no longer needs a fake chat, trash becomes a column, and project scope becomes direct.
- Touches: `prisma/schema.prisma:1208-1242`, `src/app/api/artifacts/route.ts`, `src/app/api/artifacts/[id]/*`, `src/lib/design/store.ts:32-38`, `src/app/(app)/a/[id]/load.ts`, `src/lib/share.ts:113-116,293`, `src/lib/sync-entities.ts:227-262`, `src/app/api/design/route.ts:70-91`, the conversation delete routes, and the change-capture resolver migration. Harvest R1's trash, purge and tests.

**Rec 2. Make versions immutable, and add a working head.**
- A sealed `ArtifactVersion` never changes after creation.
- Design gesture folding writes to a separate `Artifact.workingContent` (or a `draft` row) that seals into a version on pause, restore or AI edit.
- This fixes B1 by construction, makes "publish vN" meaningful, and cuts sync churn (B8).
- Touches: `src/lib/design/store.ts:123-200`, `src/lib/design/operations.ts:511-539`, `ArtifactVersion` schema, sync loaders.

**Rec 3. Split Share (people, live) from Publish (public, pinned). This delivers a stable URL, revision deploy and rollback.**
- Replace the token-snapshot `Share` for artifacts with a `Publication`: one token per artifact (reused on republish), `versionId` pinned or "latest", `publishedAt` / `unpublishedAt`, and `screenedAt`.
- Add explicit **Publish / Update to vN / Unpublish / Reset link** actions, and an honest "Published" state on tiles, `/a/{id}` and the canvas header.
- **The dialog writes nothing on open.**
- Rollback is "publish an older version". Later, add people grants (viewer, commenter, editor) as a separate table.
- Touches: `src/lib/share.ts`, `src/app/api/share/*`, `src/components/share/share-dialog.tsx:89-98`, `src/app/share/[token]/*`, `native/macOS/JunoDesktop/App/DesktopSharePopover.swift`, `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeShareClient.swift`, iPhone detail (`JunoMobileWorkspaceViews.swift:1929-1960`).

**Rec 4. Turn on interactive public pages the safe way.**
1. Stand up the preview domain (`deploy/nginx.conf.template:127-141`, `NEXT_PUBLIC_SANDBOX_ORIGIN`).
2. Add publish-time screening (X-32) in the Publish action, not on dialog open.
3. Backfill-screen existing HTML and React shares (B11).
4. Add the "user-generated, unverified" label for signed-out viewers.
5. Flip `JUNO_PREVIEW_ORIGIN_PUBLIC=1`.

Without this, "publish" means "publish the source code" for React. Touches `src/lib/sandbox-policy.ts:93-95`, `src/lib/share-moderation.ts`, `src/components/share/shared-artifact-viewer.tsx:55-60`, and a new screening module.

**Rec 5. One validated write path per type, plus guards.**
- Reject DESIGN in the generic `POST /api/artifacts/[id]`, or route it through `parseStoredDesignDocument` plus a size check (B2).
- Native design Save passes the version it opened (`ArtifactPage.swift:196-198` → the 3-arg `saveArtifact`; `JunoMobileWorkspaceViews.swift:2233,2276`) (B3, X-15).
- Add a leave-with-unsaved-changes guard on Mac and iPhone (X-16).
- Rate-limit version append, transactions, design export and share create (B6).
- Stop `include: { versions: true }` in GET routes and design loads: load the head plus a version list (X-30, X-33).

**Rec 6. Land the re-emit guard (X-05, X-06, B7).**
- Harvest R1's `ArtifactProposal` model, the Compare/Apply/Dismiss bar and its tests.
- A model re-emission on top of a user-edited or newer version becomes a suggestion, never a silent new head.
- For designs, have chat edits go through the same ops proposal path as Ask Juno (`/api/design/[id]/edit`) instead of re-authoring.
- Touches `src/lib/artifacts-store.ts:88-174`, `src/app/api/chat/route.ts:3283-3316`, and the R1 files listed in §4.

**Rec 7. One artifact page with the full lifecycle, on every platform.**
- Put Share/Publish, Restore, Export (source, Office, design formats), Duplicate, Delete, and the version stepper with diff on `/a/{id}` and on the Mac ArtifactPage.
- The chat canvas keeps the same header component.
- Fix the `/a/*` sidebar selection and tab title.
- Mac gains Restore and Office export (wire the dead `exportLabel` / `NativeArtifactStore.exportArtifact`). iPhone gains artifact links, a diff view and "New design".
- Touches `src/app/(app)/a/[id]/artifact-read-view.tsx`, `src/components/canvas/canvas-panel.tsx` (extract the header), `native/macOS/JunoDesktop/App/ArtifactPage.swift`, `ArtifactPageSupport.swift:564`, and `JunoMobileWorkspaceViews.swift`.

**Rec 8. Fix the hosted design editor, or shrink it to a canvas.**
- Short term: hide Export and handoff when `isHosted()`, or bridge them to the native save panel through a new `HostCommand`.
- Include the shared primitives in the editor CSS (X-17).
- Longer term, per the owner's native rule: native SwiftUI chrome (toolbar, layers, inspector as system sheets and menus) around a web canvas only.
- Decide the Mac runtime network policy (web allowlist vs closed) so an artifact renders the same on both.
- Touches `src/components/design/design-editor.tsx:307-351,673-697`, `src/components/design/host/*`, `scripts/build-design-editor.mjs:160-180`, `NativeArtifactRuntimeWebView.swift:418`, `NativeArtifactRuntime.swift:212-248`.

**Rec 9. Remix, fork and GitHub export.**
- Add `POST /api/artifacts/[id]/duplicate` (copy at a version into a new owned artifact, `derivedFromId` / `derivedFromVersion`).
- Add "Make a copy" on the public page for signed-in visitors. Today the header CTA is a bare "Open in Juno" → `/`, at `share/[token]/page.tsx:85-87`.
- Add "Export to GitHub" (repo or gist) for HTML, React and CODE, reusing Juno Code's GitHub connection.
- Add ZIP download.
- These are cheap once Rec 1 lands, and they close three of the seven lifecycle gaps.

**Rec 10. Fold typed deliverables into the one index.**
- List `WorkArtifact` deliverables in Artifacts, as typed Document, Spreadsheet or Presentation items, with the same page, share and export.
- Make chat's Markdown → Office export the Doc type's export instead of a MARKDOWN-only special case (`canvas-panel.tsx:232`).
- Touches `src/app/api/artifacts/route.ts`, `src/app/(app)/artifacts/page.tsx`, `src/components/work/work-documents.tsx`, `prisma/schema.prisma:2776-2841`.

**Rec 11. Data rights and hygiene.**
- Include artifacts, versions and publications in the account export (`src/app/api/account/export/route.ts`).
- Fix the delete-chat copy until Rec 1 lands (`app-sidebar.tsx:2481-2483`).
- Paginate `/api/artifacts` with a server-side search.
- Rendered thumbnails for HTML and React (server screenshot or poster) replace the code-excerpt tiles (`artifact-preview.tsx:226-247`).
- Let shared chats open their artifacts.

**Rec 12. Visual cleanup and docs reset.**
- Drop the gradient sweep and icon breathe on artifact cards (web and Mac), and the blurred glass card on the share footer.
- Delete the five dead branches in §4.
- Replace `docs/design/artifacts-design/04-*` and `05-*` with a short living spec (object model, lifecycle states, publish contract, parity table). Keep 00–03 as history.

### Suggested order

1. **Rec 5 and the B1 hot-fix**: freeze published designs by forcing a new checkpoint when a share exists. This is days of work and stops data loss and the privacy leak.
2. **Rec 1 + Rec 2**: one migration train.
3. **Rec 3 + Rec 7**: the lifecycle UI on every platform.
4. **Rec 4**: public interactivity.
5. **Rec 6, Rec 9, Rec 10.**
6. **Rec 8**: native editor chrome.
