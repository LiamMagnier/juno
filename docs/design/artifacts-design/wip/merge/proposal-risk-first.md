# Merging Artifacts, Juno Design and Work deliverables: a risk-first (strangler) plan

**Date:** 2026-09-23 · **Angle:** risk-first incremental migration · **Target:** the same place Claude reached on 16 Sept 2026. Everything Juno makes becomes one typed, account-owned object at one link. It opens as a card, then a panel, then a full window, then a public page, then a phone sheet. Design becomes a type instead of a destination. Docs, Decks and a Design System join as typed kinds. Deliverables join the same index.

**The difference in this plan is how we get there.** A release is only allowed to ship if four things hold:
- it cannot lose user work;
- it cannot send an installed Mac or iPhone build a shape that build can't decode;
- it can be switched off without a deploy;
- it is measured.

Each release changes at most one thing a person can see in navigation.

**Evidence base:**
- `00-AUDIT-OVERVIEW.md` (X-01..X-33, §4 fragmentation, §12 preconditions, §13 questions), `01-AUDIT-WEB.md`, `02-AUDIT-MAC.md`
- `03-COMPETITIVE-AUDIT.md`, `research/claude-primary-evidence.md`
- the backlog (`backlog.clean.json`, R-001..R-101)
- `TWO_PRODUCTS.md`, `FLAT_UI.md`, `PREMIUM_AUDIT.md` §3, `ICONS_AND_MOTION.md`
- the in-flight Mac plan (`juno-glass/docs/native/MACOS_LIQUID_GLASS_REDESIGN.md`, read only, including its Phase 2 Stage 3 errata)
- code that I re-read for this proposal: `prisma/schema.prisma:1135-1160, 1813-1840, 2618-2665`; `src/lib/artifacts-store.ts`; `src/lib/artifact-runtime.ts:93-127`; `src/lib/sync-entities.ts:227-262`; `src/app/api/v1/bootstrap/route.ts` (`featureFlags: {}` exists and is empty); `src/app/api/design/route.ts:69-90`; `src/app/api/conversations/[id]/route.ts:80-90`; `src/lib/queries.ts:33-47`; `NativeArtifactStore.swift:95-170`; `NativeSyncAPIClient.swift:141-190`; `NativeConversationStore.swift:259-270`; `DesktopChatSidebar.swift:306-335`; commit `7243613f`

---

## 0. Three mechanisms carry the whole plan

The native store was re-read for this proposal. Three facts in it decide what can ship and when:
1. **One bad record fails the whole library.** `NativeArtifactStore.decodeArtifact` throws `corruptRecord`, which fails the entire snapshot, whenever:
   - `conversationId` is empty;
   - `type` is not a known `NativeArtifactKind`;
   - a version body is over 200,000 UTF-16 units.
2. **An unknown sync entity stops all syncing.** `NativeSyncAPIClient.entityTypes` *throws* on an entity type it does not know. That aborts sync for the whole account on that device.
3. **Unknown JSON keys are safe.** Swift `JSONDecoder` ignores them, so adding optional fields is harmless.

**Installed 1.6.0 Mac builds and every current iPhone build are therefore "N0 clients":** they break on nulls, unknown kinds, oversized rows and new entity types, and on nothing else. Three mechanisms keep the server inside that envelope until the compatibility window closes in Phase 6.

| Mechanism | What it is | Why it removes risk |
|---|---|---|
| **A. Made-in anchors** | A conversation that has to disappear (deleted by the user, or a hand-made design's holder chat) keeps its row, but as `kind: "anchor"`. Its messages are purged and its title becomes "Your artifacts". Artifacts keep a non-null `conversationId`. Native already drops unknown conversation kinds from lists (`NativeConversationStore.swift:268`). On the web, one `visibleConversationWhere` helper excludes anchors from every list. | Conversation delete stops cascading (X-22), and New can create an artifact without a visible chat (R-027), **without ever sending N0 a null `conversationId`**. The "first Ask starts the conversation" gesture becomes a one-column flip from `anchor` to `chat`, so no data moves. |
| **B. Kinds as profiles** | Doc, Deck and Design System are `Artifact.profile` values on types N0 already decodes: Doc = `MARKDOWN` + `profile: "doc"`; Deck = `DESIGN` + `"deck"`; Design System = `DESIGN` + `"system"`. **No new `ArtifactType` enum values and no new `DesignDocument` fields are added in this programme** until bridge v2 ships (Phase 5). | N0 degrades gracefully: a Doc renders as Markdown, a Deck opens as a design. X-09-class blanking cannot happen. X-14-class stripping cannot happen either (a hand-mirrored Swift struct silently dropping new fields on save). |
| **C. Capability-projected sync** | N1 clients send `X-Juno-Client: macos/1.6.1 (91)` and `X-Juno-Sync-Caps: artifacts.v2, artifact_comment, artifact_grant, …` on `/api/v1/*`. A missing header means N0. `/api/v1/changes` and `/api/v1/entities` project per capability set. For N0 they drop new namespaces, omit `status: "draft"` rows, incomplete versions and bodies over 200k, and keep full-body versions. For v2 clients they send the current body only. | New tables such as comments, grants and links can exist from day one without stopping any device's sync. The header also measures adoption, which is how the compatibility window closes. |

---

## 1. Thesis, principles, and day one

**Thesis.** The merge is an identity migration more than a UI project. Today the unit of identity is the chat message: artifacts die with it (X-03, X-04, X-22), the model rewrites from it (X-05), and the Mac dock renders from it (X-11, X-12). After the merge the unit is the **Artifact row**, owned by the account and addressed by `/a/{id}`. Juno's storage already has the right shape (`00` §1.1), so the work is to move every seam off the message one at a time, behind a flag, with the old path left working until the new one is proven.

**Principles**
1. **Nothing made is destroyed as a side effect.** A hard delete happens only through "Delete now" in Recently deleted, the 30-day purge, or account deletion.
   - A Postgres trigger on `Artifact` DELETE writes a **deletion ledger** row from `current_setting('juno.delete_reason')`.
   - An unset reason is an alert. The target is 0 per week.
2. **Old clients see old shapes.** Fields are added and existing ones never change meaning in place. A shape an N0 client can't decode ships only after the N1 window closes (§3.4).
3. **One write path per type, and it is the web's.** DESIGN goes through `/api/design/[id]/transactions`. Text goes through CAS appends. The generic `POST /api/artifacts/[id]` stays for native builds in the field, but validates and preserves fields (§3.2).
4. **Expand, migrate, contract.** Additive migrations ship first and are safe to roll back. Backfills are idempotent. A contraction ships only after two clean releases, with a table snapshot taken first.
5. **Reuse before build:**
   - the `/library` list machinery for the index;
   - `runtimeFor` becomes the kind registry;
   - design operations drive AI edits;
   - the export validator drives Office output;
   - on Mac, the glass branch's `TrailingDock` and `ChatArtifactResolver`.
6. **Governance before reach.** Nothing becomes more public or more scriptable than today unless takedown, report and ban propagation ship in the same release.
7. **Animation never keys identity.** X-02 is a view keyed by version so that it could fade. Hosts mount by `artifactId`, and a version is data (R-013).
8. **Measure first.** The telemetry spine ships in the first release (§12). Every phase has a metric that decides its exit.

**Day one of the programme (release R1–R2, ~2 weeks).** The owner notices little change on screen, and the obvious losses stop:
- A Tailwind or React page previews live again in their own chats (X-01a).
- A hand-edited design survives fixing a typo two messages up (X-03, from `7243613f`).
- A chat-made design appears in the transcript as a picture rather than JSON (X-20).
- Deleting an old chat says "2 artifacts made here stay in Artifacts".
- The sidebar is unchanged.

**Day one of the merged surface (release R11, the `ia.merged` flag).** The sidebar reads Library · Projects · Artifacts. The Design row stays for one release as a pointer, "Designs now live in Artifacts".
- Artifacts opens on a grid of real posters, with type chips and a **New** menu whose Design submenu keeps the four presets.
- A design card in chat opens the panel, and the editor still works after the first drag.
- ⌘⇧↩ expands the panel to a full window at `/a/{id}` with the composer still there.
- `/design` bookmarks land on the Designs filter, with presets pinned for 60 days.
- Nothing the owner made before the switch is missing, and the ledger proves it.

---

## 2. The object model after the merge

### 2.1 What an artifact is

An **artifact** is a typed, account-owned, versioned object with a stable id. Messages *reference its versions*; they do not own it.

| Aspect | Rule | Today → after |
|---|---|---|
| Identity | `Artifact.id` never changes. `(conversationId, identifier)` stays unique and maps the model's identifier to that id. A re-emit after edit or regenerate **appends a version to the same id** (`7243613f`). `type` and `profile` are immutable per id; a type change creates a new artifact linked by `ArtifactLink(kind:"replaces")`. | Re-emit made a new id (X-04). `persistArtifacts` overwrote `type` (`artifacts-store.ts:61-67`) → it now refuses. |
| Owner | `userId`, backfilled from `conversation.userId`. Enforced by one `canAccess(artifact, user, action)` helper. | Auth only through `artifact → conversation.userId` (`01` §3). |
| Home | `projectId` (nullable), inherited from the made-in chat and changeable with "Move to project". Otherwise the home is "Your artifacts". | Absent; the project page shows 0 (X-21). |
| Made in | `conversationId`, pointing at a real chat or an anchor (§0 A). Nullable only in Phase 6. `messageId` is provenance only; a lint rule forbids it in any delete `where`. | Required, cascading, used as a delete key. |
| Lifetime | Independent of messages. Message edit, regenerate and branch never delete. **Conversation delete detaches** the artifacts into its anchor, with an unchecked "Also move them to Recently deleted". Project delete sets `projectId` null. | Cascade everywhere (X-22). |
| Trash | `deletedAt` plus `deletedReason`. A 30-day Recently deleted list. While trashed: shares answer 410 "This page isn't shared any more", grants are suspended, comments hidden. Restore brings back versions, comments, grants and **the same token**. Account deletion purges immediately, including object storage (X-26). | Hard delete. |
| Status | `draft` (created, no complete version yet) or `ready`. Draft rows are not listed, not synced to N0, and appear only on their card. | Absent (X-07). |

### 2.2 Versions: sealed, head, published

- **Sealed versions** are append-only and immutable, with `ArtifactVersion` fields:
  - `authorKind`: `model | user | restore | agent | import`
  - `authorUserId`, `messageId` (the turn that made it), `model`
  - `complete` (false for stopped or truncated output)
  - `label`, `note`
  - `branchId`, `parentVersion` (Phase 5, R-029)
  - `byteSize`, `contentHash`
- **Current** is the newest `complete` sealed version on the main branch. An incomplete version is appended as a non-current draft ("Stopped before v5 finished · Keep v4 · Continue v5", R-007) and never labelled "verified".
- **Working head** (`ArtifactHead`, one mutable row per artifact, not change-captured) takes design editor transactions and Doc autosaves. It seals into a version when any of these happen:
  - 90 s idle;
  - closing the surface;
  - Share or Publish;
  - **before any Juno turn reads the artifact**;
  - before a bulk operation;
  - on Restore.

  This replaces fold-in-place (`store.ts:179-203`), which today rewrites rows that shares resolve by timestamp (M31).
- **Published** is a `Share.versionId` pin. Update moves the pin; Unpublish keeps the token reserved.
- **Pruning.** Unnamed, unpublished, uncommented autosaves are pruned per plan (decision D12). Named, published and commented versions never are.

### 2.3 The kind registry (`src/lib/artifact-kinds.ts`, R-008)

`runtimeFor` grows into the registry, keyed by `(type, profile)`. It is generated into Swift (as the tokens already are) and into the OpenAPI enum, which gains `DESIGN` (`juno-native-v1.yaml:1866-1868`). A lint fails any other file that maps a type to a glyph or label; that retires the four web maps and three Swift tables (`00` §5).

**The rule is the one in R-008.** A new *kind* exists only when the document root or the way people consume it differs. Draw, Prototype, Motion, Inspect and Present are *modes*.

| Kind (noun) | Storage | Editor | Runtime and preview | Thumbnail (R-014) | Exports | Comment anchor | Share roles | Phone contract (R-069) |
|---|---|---|---|---|---|---|---|---|
| **Design** | `DESIGN`, no profile | `DesignEditor` in window, panel and hosted (one mount keyed by id) | Design canvas; Play (Phase 5, after R-019) | `renderPageSvg` of the cover frame at `posterTimeMs` | SVG, PNG@1-3x, PDF, HTML prototype, React, SwiftUI, tokens, JSON, "Build it with Juno Code" | `{pageId, frameId, nodeId, dx, dy}` | view · comment · edit | View, pinch, Play, comment, Ask. Edit is read-only until bridge v2. |
| **Deck** | `DESIGN` + `profile:"deck"`. A "Slides" page of ordered 1920×1080 frames. Speaker notes are a hidden text node named "Speaker notes" in each frame. Transitions and build-ins use the existing interaction and motion models (no schema change). | Same editor in "slides" chrome: slide strip, ⇧D reveals the full rails (R-059) | Present = Play | Slide 1 | PPTX (Work presentation renderer, adapted), PDF, PNG per slide | `{slideId, elementId, x, y}` | view · comment · edit | View, Present, comment, reorder or hide slides |
| **Doc** | `MARKDOWN` + `profile:"doc"`. Pure GFM plus Juno fences (mermaid, `:::`, juno-visual). No front matter, so every renderer shows it cleanly. | Block editor over GFM (web, Phase 5). Patch protocol for Juno. | Prose at the reading measure | Title plus about 8 typeset lines (server SVG) | .docx, .pdf, .md through **one** OOXML renderer (`office-export.ts`) and `validate.ts`; the Work `document.ts` twin is retired | `{quote, prefix, suffix}` | view · comment · edit | View, comment, edit text in place |
| **Design System** | `DESIGN` + `profile:"system"`: variables with modes (colour, type, spacing, radius, **timing, easing**), a components page, a README frame | Design editor, opening on Variables | Browsable token and component sheet | Cover frame | Tokens (DTCG JSON), JSON | node | view · edit (owner-level "Publish as default") | View only |
| **Page** | `HTML` / `REACT` (meta reads "Page · React") | Code tab. Visual props later (R-044). | Preview origin (§9.4) | Typed placeholder plus excerpt. Headless capture on the preview origin in Phase 5. | HTML/zip, source, "Build it with Juno Code" | `{cssPath, xpath, textQuote, point%}` | view · comment · edit | View, comment |
| **Code** | `CODE` | Code surface | Console (JS or Python) only on click | Highlighted excerpt | Source file | `{startLine, endLine, contentHash}` | view · edit | View |
| **Diagram** | `MERMAID` | Source plus preview | Mermaid (bundled on Mac by the glass branch) | Excerpt until headless capture | SVG, PNG | region | view · comment · edit | View |
| **Graphic** | `SVG` | Source plus preview | Sanitised `<img>` | The SVG itself | SVG, PNG | region | view · edit | View |
| **Image** (indexed) | `Attachment` with origin `generated`, **by reference** (R-092). It stays a Library file. | Image edit overlay | Image viewer | The image | Download | point | inherits the chat or Library rules | View |
| **Deliverable** (indexed) | `WorkArtifact`, **by reference** (option A; §11). Kinds: spreadsheet, site, archive, pdf, plus document and presentation until they are linked to a Doc or Deck. | None; "Open as Doc" when linked | Existing `/api/work/artifacts/[id]/preview` routes | Kind poster (xlsx grid, site excerpt) | The validated file, every version (hash-verified) | none (v1) | not shareable in v1 | View, download |
| **Unsupported** | Anything a client build doesn't know | none | Poster plus "Open on the web" | Server poster | — | — | — | View |

Each registry entry records: id, noun and plural; the AppIcons glyph and its one `data-motion` gesture; runtime; editor; streaming renderer; thumbnail strategy; exporters; share roles; comment-anchor kind; `newLabel`; and **the kind's authoring section of the system prompt (Juno's SKILL.md)**. That section is loaded only for kinds that are armed or already in play (R-028). It replaces the monolithic `system-prompt.ts:238-300` block.

**Vocabulary** (settled now, so it doesn't carry into the merged surface):

| Word | Meaning |
|---|---|
| "Artifacts" | The place |
| "panel" | The side surface |
| "Canvas" | Only the design drawing surface |
| "Share" | With people |
| "Publish" | To the public web |
| "Made here" | What one conversation produced (replaces "Outputs") |
| "Library" | Files you brought |

### 2.4 Provenance

- Every version knows its author, its turn (`messageId`), its model and its parent.
- The header menu offers "View in conversation", which scrolls to the turn and flashes it on `duration-emphasis`.
- The made-in conversation is private by default (R-073, C5).
- Deliverable provenance (`WorkArtifactVersion.provenance`, written by the runner, which it never does today) shows in the same Info panel.

---

## 3. Data model and migrations

### 3.1 Prisma changes (illustrative; M = migration number)

```prisma
model Artifact {                         // M1: all new columns nullable or defaulted
  userId        String?                  // M1 → required in M9 (after backfill + 2 clean releases)
  projectId     String?                  // SetNull on project delete
  conversationId String                  // stays required until Phase 6 (anchors); then String? + SetNull (M10)
  messageId     String?                  // unchanged name; provenance only (lint forbids use as a delete key)
  profile       String?                  // "doc" | "deck" | "system"
  status        String   @default("ready")   // "draft" | "ready"
  posterVersion Int?                     // version the thumbnail was rendered from
  deletedAt     DateTime?
  deletedReason String?                  // "user" | "conversation" | "project" | "account"
  @@index([userId, deletedAt, updatedAt])
  @@index([projectId, deletedAt])
}
model ArtifactVersion {                  // M1
  messageId String?; authorKind String?; authorUserId String?; model String?
  complete Boolean @default(true); label String?; note String?
  branchId String?; parentVersion Int?; byteSize Int?; contentHash String?
}
model ArtifactHead {                     // M3 — no sync trigger, never change-captured
  artifactId String @id; baseVersion Int; content String @db.Text
  opCount Int @default(0); updatedAt DateTime @updatedAt; updatedBy String
}
model Share {                            // M2
  versionId String?                      // published pin (backfilled from snapshotAt)
  suspendedAt DateTime?; suspendReason String?; expiresAt DateTime?
  unpublishedAt DateTime?                // token reserved; republish restores the same URL
  // views Int stays but stops being written (moved to ShareViewDaily; no owner sync churn)
}
model ShareViewDaily   { shareId String; day DateTime @db.Date; views Int; visitors Int; @@id([shareId, day]) }   // M2, no trigger
model ModerationReport { id String @id; shareId String?; artifactId String?; reason String; detail String?;
                         reporterHash String; status String @default("open"); createdAt DateTime @default(now()) }  // M2
model ModerationFlag   { /* + */ shareId String?; artifactId String?; subjectUserHash String?
                         /* userId relation → onDelete SetNull so a flag survives account deletion */ }   // M2
model ArtifactUserState{ artifactId String; userId String; lastOpenedAt DateTime?; pinnedAt DateTime?; @@id([artifactId,userId]) } // M4
model ArtifactLink     { id String @id; fromId String; toId String; kind String /* replaces|converted-from|uses-system|derived-file|embeds */;
                         toVersion Int?; createdAt DateTime @default(now()) }                                   // M4
model ArtifactComment  { /* R-040 fields */ }                                                                  // M7
model ArtifactGrant    { artifactId String; principalKind String; principalId String; role String /* VIEWER|COMMENTER|EDITOR */;
                         grantedBy String; acceptedAt DateTime?; expiresAt DateTime? }                        // M8
model WorkArtifactVersion { /* + */ spec Json?; specVersion Int? }                                            // M1
model WorkArtifact        { /* + */ linkedArtifactId String? }                                                // M6
model ProjectMember       { role ProjectRole /* enum; was unvalidated String (00 §7.2) */ }                   // M8
model FeatureFlag      { name String @id; percent Int @default(0); allowUserIds String[]; killed Boolean @default(false); updatedAt DateTime @updatedAt } // M0
```

`Conversation.kind` gains the value `"anchor"`. It is a value, not a schema change.

### 3.2 Backfills and one-time fixes (all idempotent, batched at 5k, resumable by cursor)

| # | Backfill | Verification |
|---|---|---|
| B1 | `Artifact.userId ← conversation.userId`; `projectId ← conversation.projectId` | For one release `canAccess` runs **shadow-compare** (old rule and new rule, log mismatches); enforce once there are 0 mismatches over 7 days. |
| B2 | `ArtifactVersion.authorKind ← origin` (generated→model, edit→user, restore→restore). Version 1 of a DESIGN whose conversation has zero user messages → `user` (hand-started via `/api/design`, `00` §5). | Counts per origin before and after. |
| B3 | Holder chats: `kind:"chat"`, `titleSource:"manual"`, zero user messages, and exactly the one DESIGN made by `/api/design` → `kind:"anchor"`, title "Your artifacts". | Recents count drops by exactly the number of converted rows. Native drops them automatically. |
| B4 | `Share.versionId ←` max version with `createdAt ≤ snapshotAt`. A DESIGN share whose chosen version has origin `edit` inside the 30 s fold window is flagged `mayHaveLeaked` and shown to the owner as "This link may show edits made after you shared it · Review". | Every ARTIFACT share has a pin. |
| B5 | **Production audit (answers owner Q9 before Phase 0 closes)**: read-only SQL counting `ArtifactVersion` rows over 200k UTF-16 units and `Share` rows pointing at DESIGN. Oversized rows are omitted from N0 sync (the N0 dock shows its existing "Version unavailable" state instead of blanking) and are offered "Split page into a new design" on the web. | Q9 answered; the X-09 exposure number is known. |
| B6 | `DesignDocument.comments` (never written; `types.ts:738-752`) → `ArtifactComment` rows in Phase 5. | Row count equals array lengths. |

**The generic POST path (Phase 0), which protects installed natives:**
- `POST /api/artifacts/[id]` with a DESIGN body is now zod-validated.
- It runs a **field-preserving merge** against its base version: for every node present in both documents, fields the incoming body omits but the base carries (today `cornerSmoothing`, and any future field) are copied back.
- That fixes X-14 for every Mac and iPhone build in the field **without a native release**.
- The version is appended with `authorKind: user`.
- Size is checked after expansion (X-08).

### 3.3 Sync and native contract changes

| Change | Emitted to N0? | Emitted to N1+ (caps) |
|---|---|---|
| New optional fields on `artifact` and `artifact_version` (userId, projectId, profile, authorKind, complete, label…) | Yes (ignored keys) | Yes |
| `deletedAt` set | As a **tombstone** (N0 removes it locally; restore re-creates it) | As the field, so trash can show offline |
| `status:"draft"` rows; `complete:false` versions | Omitted | Yes |
| Version body > 200k | Omitted; N0 shows "Version unavailable" | Metadata plus "open on the web" |
| Version bodies | Every version (as today) | **Current body only**; history via `GET /api/artifacts/{id}/versions/{n}` (payload diet) |
| `origin` / `authorKind` | Added (L6) | Yes |
| New namespaces (`artifact_comment`, `artifact_grant`, `artifact_link`, `artifact_user_state`) | **Never** (they would abort sync, `NativeSyncAPIClient.swift:141-152`) | Only when listed in `X-Juno-Sync-Caps` |
| `conversationId: null` | Never (anchors) | Only after Phase 6 contraction, to clients with `artifacts.nullableHome` |
| Caps grow on upgrade | — | `bootstrap` returns `resyncNamespaces: [...]`, and the client hydrates them from cursor 0 |

### 3.4 Ship order and compatibility windows

1. **N1 native release (Phase 0B), cut from main as 1.6.x and not tied to the glass ship date.** The memory note says the glass branch ships only when all its phases are done, so compatibility can't wait for it. N1 contains:
   - Tolerant `NativeArtifactStore` in JunoChatKit, shared with iOS. Unknown kind → `.unsupported(kind)`. Oversized or corrupt rows are skipped and reported. `conversationId` is optional.
   - The glass branch already wrote the skip logic (Stage 3 errata); cherry-pick it so both branches share one implementation.
   - The `X-Juno-Client` and `X-Juno-Sync-Caps` headers.
   - `bootstrap.featureFlags` read into a `NativeFeatureFlags` store.
   - Entity type strings for the four new namespaces, with caps declared.
   - `DesignNode.cornerSmoothing` (already on glass) plus opaque carriage of unknown node fields.
   - The rebuilt editor bundle, a CI gate, a CSS scan of the shared primitives, and `surface="window"` (X-17, X-18, X-19).
   - The Design screen's save base taken from the version the edit started from (X-15), and a draft-loss prompt (X-16).
   - **iPhone design editor read-only** ("Edit this design on the web or your Mac", R-002).
   - `.design` destination kept decodable.
2. **Server M0–M2 expand migrations.** They are additive and safe for N0, so they can land before N1 adoption.
3. **Backfills B1–B5.**
4. **Behaviour flags**, per phase (§13).
5. **Compatibility window.** A shape that N0 can't decode ships only when N1+ is at least 95% of active Mac devices **and** at least 90% of active iPhone devices over a trailing 14 days, **and** at least 45 days have passed since N1. Adoption is measured from `X-Juno-Client` on `/api/v1/changes`.
6. **Contraction (Phase 6).** Two releases after the window closes: `userId` becomes NOT NULL (M9); `conversationId` becomes nullable with SetNull; anchors are converted to null and deleted (M10); the `artifacts.legacy` projection is removed.

---

## 4. Information architecture and navigation

### 4.1 Web

| Area | Before (TWO_PRODUCTS §3) | After |
|---|---|---|
| Chat sidebar | New chat · Search · Library · Projects · Artifacts · **Design** · More | New chat · Search · Library · Projects · **Artifacts** · More. Design stays one release (R11) as a pointer, then is removed (R12). This amends TWO_PRODUCTS §3 and is recorded in `OPEN_DECISIONS.md` (owner Q2). |
| Code sidebar | Artifacts row flips the product to Chat (M27) | The Artifacts row opens `/artifacts` inside the Code shell. `tests/shell-product-column.test.ts:43-62` is updated. |
| ⌘K | No "New design", no artifact titles (L34) | New design ▸ presets, New doc, New deck, New page; artifact titles in results; typing "design" suggests the Designs filter. |
| Library | Files, generated media, trash | Unchanged: **files you brought**. Generated images stay here *and* are indexed in Artifacts › Images by reference. |
| Artifacts | Top 200, client search, no sort, paging or trash (M26) | The one index of **what Juno made** (§4.2). |
| Project page | Artifacts always 0 (X-21) | An "Artifacts" section reading `/api/artifacts?projectId=`, with Move to project, and New inside the project (inherits `projectId`). |
| Conversation header | Outputs popover | "Made here" popover (R-079): create tiles that arm the composer, and outputs grouped by kind, **including the run's deliverables** (fixes the dead pointer in X-25). |

**Library vs Artifacts: the recommendation.** Keep them as two siblings, inputs and outputs. REWORK_PLAN's "fold Artifacts into Library as a filter" is withdrawn in `OPEN_DECISIONS.md`. It would put two list semantics (files with Library removal policy versus versioned objects with trash and grants) behind one page. It would also churn the Library page, which is the best-built list in the product, while it is being reused as the engine. Both pages share `LibraryBrowser` primitives, so they look and behave alike.

### 4.2 The Artifacts home (R-018, built on `/api/library` machinery)

- **Header:**
  - "Artifacts" (rule 15: the page opens with its name);
  - server search (200 ms debounce; titles plus current text);
  - **New ▾** split button;
  - Grid/List toggle (IconSwap).
- **Type chips with counts:** All · Designs · Docs · Decks · Pages · Diagrams · Code · Images · From tasks. The chips wrap. A chip appears only when its count is above 0, except Designs, which always shows because it is the redirect target.
- **Scope menu:** Everything · Recents (`ArtifactUserState.lastOpenedAt`) · Pinned · Shared with me (Phase 5) · In project ▸.
- **Sort:** Last edited (default) · Last opened · Created · Name, remembered per scope on the server.
- **Rows** (rule 3, a list row is text on the panel; rule 6, one trailing signal): a 40×28 poster, the title, and one trailing signal (updated time, *or* a globe for Public).
- **Tiles:** a 4:3 poster, the title and one meta line. The kind word appears only under All.
- **Row menu:** Open · Open in conversation · Pin · Rename · Duplicate · Share… · Move to project ▸ · Move to Recently deleted.
- **Paging and bulk:** cursor paging, 50 per page; bulk select and delete.
- **Recently deleted (n) ›** at the foot of the page, using `LibraryBrowser`'s deleted view.
- **Empty state:** a single glyph tile, one sentence, and a New action, plus six starters.

### 4.3 Mac, on the Liquid Glass navigation

These changes are built on the glass plan and do not fight it:
- **Glass Phase 1 ships its sidebar as written**, including `Label("Design", image: .junoDesign)`. No churn is added to their Phase 1.
- **Glass Phase 4 (secondary pages, `JunoPage` template):**
  - The Artifacts page becomes the unified index: the `JunoPage` header "Artifacts"; controls row with search, a type `Menu` (All ▾, with counts; there are too many kinds for a segmented control), sort, Grid/List `JunoSegmented`, and "New ▾" as `.bordered`.
  - The **Design row's destination becomes `.artifacts(filter: .design)`**. `DesktopDesignScreen`'s launcher presets move into New ▾ › Design.
  - The glass release after that removes the row, mirroring the web's one-release pointer.
  - The `.design` raw value in `@SceneStorage("juno.desktop.destination")` decodes forever and maps to the filtered Artifacts page. So does Code's retired `.design` (`DesktopCodeStudio.swift:34-35`).
- **Dock.** Glass Stage 3 already has `TrailingDock`, row-backed through `ChatArtifactResolver`; that is the panel. The proposal adds the ArtifactSurface header parity (§6.2): stepper, Share, ⋯, and "Open in Window" as a restorable, row-backed `WindowGroup(for: ArtifactID)` (R-068).
- **Outputs popover (glass §7.5) becomes "Made here"**, with deliverable tiles showing Quick Look posters (glass Phase 5).
- **Library** stays files, per the glass §9 table.

### 4.4 iPhone

- **Artifacts section** in the workspace: the same scopes, chips and sort, a List by default, and swipe to Recently deleted with an Undo snackbar.
- **Chat card:** tap opens a sheet (medium and large detents) with the same header; "Open full" pushes the full detail.
- **Design editing is read-only** from N1 until bridge v2 (R-002 → R-069), with one line saying why.
- **Work tab:** "Made" rows open the Deliverable detail with a download (fixes X-27 for cloud runs).

---

## 5. Routes and redirects

| Route | Role | Notes |
|---|---|---|
| `/a/{id}` | **Canonical.** Full window. | `?v=` pins a version (read-only state of the same mount); `&node=`, `&page=`, `&comment=`, `&mode=design\|prototype\|motion\|inspect`, `&c={conversationId}` (opened from chat). No access → 404 until grants exist, then "You need access · Request access" (R-039). |
| `/a/{id}/play` | Play or Present (Phase 5) | Only after the motion conformance suite passes (R-019). |
| `/chat/{c}?a={id}` | Panel inside its conversation | Id-based. Expanding calls `history.replaceState('/a/{id}?c={c}')` on the **same mount** (undo, selection and zoom are kept); Esc or "Back to chat" collapses it. |
| `/chat/{c}?artifact={identifier}&v=` | Legacy | The server resolves `(c, identifier)` to an id, then `replaceState` to `?a=`. Kept forever; the hit count is tracked. |
| `/design` | Legacy destination | 308 → `/artifacts?type=design`, with a presets row pinned for 60 days. Behind `ia.merged`. |
| `/design/{id}` | Legacy editor window | 308 → `/a/{id}`. Behind `route.canonical`; the page keeps working until the flag flips. |
| `/artifacts?type=&scope=&sort=` | Index | `type` values come from the registry nouns. |
| `/projects/{p}` artifacts `?id=` | Legacy | Links rewritten to `/a/{id}`; `?id=` redirects. |
| Search results `?v=` | Honoured | M28. |
| `/new/design?preset=phone\|tablet\|desktop\|square`, `/new/doc`, `/new/deck`, `/new/page` | Quick create | These create the artifact, then 303 → `/a/{id}`. |
| `/share/{token}` | Published snapshot (public) | Tokens stay valid. The version is pinned by `Share.versionId`. Trashed → 410; suspended → "This page isn't available". |
| Preview origin `https://{versionId}.{preview-domain}/?t=` | Sandboxed runtime | Signed token `{artifactId, version, grant, exp ≤ 5 min}`, re-checked on every load (§9.4). |
| APIs `/api/artifacts/*`, `/api/design/*`, `/api/share` | Kept for native builds in the field | `/api/design` POST creates an **anchor**, not a chat. The generic POST validates and preserves fields (§3.2). |

**Mac and iPhone:**
- Universal links cover `/a/*` and `/share/*` (apple-app-site-association).
- Mac: a link opens in the dock if its made-in conversation is the one showing, otherwise in a document window.
- Open artifacts publish `NSUserActivity("com.juno.artifact", {id, v, mode})` for Handoff and window restoration.
- iPhone: `openArtifact(id, version, node, comment)`. Unknown kinds fall back to Safari.

---

## 6. One ArtifactSurface in five sizes

### 6.1 The sizes

- **One component, `ArtifactSurface`**, keyed by `artifactId` and sized by its container (PREMIUM rule 11). It is built by extracting `CanvasPanel` into a host plus registry-driven renderers.
- **Inline card (R-024):**
  - header: glyph, title, "Design · v4", Open;
  - a poster at its own aspect ratio in an `@container` box capped at 320–360 px;
  - at most two actions: Open, plus one verb (Play, Copy or Download).
  - A live sandbox mounts only when the card is the latest version, at least 50% visible, and the panel is closed.
  - Earlier turns fold to a one-line version receipt: "Updated Sign-in screen · v3 · latest is v5 · Open v3" (R-023).
- **Panel:**
  - Docked when the split is at least 64rem; below 50rem only the full size exists (the current `chat-view.tsx` rule is kept).
  - Header (44 px, 16 px gutters): title with inline rename, kind in muted ink, stepper, artifact switcher, mode control, Share, ⋯, Expand, Close.
- **Full window, `/a/{id}`:**
  - edge to edge;
  - the conversation stays reachable as a collapsible left column, or as the composer overlaid bottom-centre (≤680 px) with the last reply as a two-line snippet (MCP Apps rule; `03` §8 #12).
- **Shared page (`/share/{token}`):**
  - DESIGN is rendered server-side as SVG with a page switcher and Play;
  - Doc is typeset;
  - Page runs on the preview origin;
  - footer: "Made by a Juno user · not verified by Juno · Report".
- **Phone:** the sheet with detents (iPhone), or a bottom sheet with a grab handle at 50% or 92% (phone-width web).

### 6.2 Wireframes

**(a) Conversation with the panel (web, split ≥ 64rem).** The editor is the embedded host keyed by id. "Looking at" is the selection chip.

```
┌──────────────┬────────────────────────────────────┬─────────────────────────────────────────────┐
│ Juno         │ Onboarding redesign        Share ⋯ │ Sign-in screen · Design  ‹ v4 ›  ▾  Share ⋯ ⤢ ✕│
│ [Chat|Code]  │                                    │ [Design | Prototype | Motion | Inspect]  ◔ 2 │
│ + New chat   │  You  Make the CTA quieter         ├─────────┬──────────────────────┬────────────┤
│ ⌕ Search  ⌘K │                                    │ Layers  │                      │ Inspector  │
│ Library      │  Softened the CTA and reduced its  │ ▾ Page 1│   ┌──────────────┐   │ Button     │
│ Projects     │  weight.                           │  Sign-in│   │   390 × 844  │   │ Fill  2°   │
│ Artifacts    │  ┌ Edit · Sign-in screen · v4 ───┐ │  Home   │   │  [ Sign in ] │   │ Radius 12  │
│ More         │  │ CTA quieter · 3 layers        │ │         │   │              │   │ …          │
│              │  │ Applied            [ Undo ]   │ │         │   └──────────────┘   │            │
│ Pinned chats │  └───────────────────────────────┘ │         │    (changed layers   │            │
│ Recent       │  ┌───────────────────────────────┐ │         │     outline-fade)    │            │
│  Onboarding… │  │ [ poster 16:10              ] │ │         │                      │            │
│  Q3 memo     │  │ Design · Sign-in screen · v4  │ ├─────────┴──────────────────────┴────────────┤
│              │  │ [ Open ]  [ Play ]            │ │ Viewing latest · saved                      │
│              │  └───────────────────────────────┘ │                                             │
│              │ ╭────────────────────────────────╮ │                                             │
│              │ │ Looking at: Sign-in · v4 · CTA ×│ │                                             │
│              │ │ Ask about this design…       ⬆ │ │                                             │
│ Liam · Pro ⚙ │ ╰────────────────────────────────╯ │                                             │
└──────────────┴────────────────────────────────────┴─────────────────────────────────────────────┘
```

**(b) Full-window design at `/a/{id}`.** The composer is overlaid; the conversation is one keystroke away (⌘⌥C).

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│ ‹ Onboarding redesign   Sign-in screen · Design   ‹ v4 ›   [Design|Prototype|Motion|Inspect]  Share  ⋯ │
├────────────┬──────────────────────────────────────────────────────────────────────┬───────────┤
│ Layers     │                                                                      │ Inspector │
│ ▾ Page 1   │     ┌────────────┐     ┌────────────┐     ┌────────────┐              │ Frame     │
│   Sign-in  │     │  Sign-in   │     │   Home     │     │  Settings  │              │ 390 × 844 │
│   Home     │     │            │     │            │     │            │              │ Auto lay. │
│   Settings │     │ [ Sign in ]│     │            │     │            │              │ Fill      │
│ Components │     └────────────┘     └────────────┘     └────────────┘              │ Effects   │
│ Variables  │                                                                      │ …         │
│            │          ╭──────────────────────────────────────────────╮            │           │
│            │          │ Juno · Softened the CTA (v4)   Show chat ▴   │            │           │
│            │          │ Ask Juno about this design…               ⬆  │            │           │
│            │          ╰──────────────────────────────────────────────╯            │           │
└────────────┴──────────────────────────────────────────────────────────────────────┴───────────┘
  Below 1040 px: Layers becomes a drawer. Below 640 px: canvas only, with a contextual bar above the selection (R-017).
```

**(c) The Artifacts home with New open.**

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Artifacts                                       [⌕ Search artifacts      ]  [+ New ▾] [▦ | ≡] │
│ All 128 · Designs 14 · Docs 22 · Decks 3 · Pages 31 · Diagrams 9 · Code 30                    │
│ Images 12 · From tasks 7                          Everything ▾    Sort: Last edited ▾         │
│                                                                  ┌ New ────────────────────┐  │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐         │ Design ▸ Phone 390×844  │  │
│  │  poster   │ │  poster   │ │  poster   │ │  poster   │         │          Tablet 834×1194│  │
│  │   4:3     │ │           │ │           │ │           │         │          Desktop 1440×900  │
│  ├───────────┤ ├───────────┤ ├───────────┤ ├───────────┤         │          Square 1080×1080  │
│  │Sign-in  ⊕ │ │Q3 memo    │ │Pricing pg │ │Q3 report  │         │          Custom…        │  │
│  │Design · 2m│ │Doc · 1h   │ │Page · 3h  │ │From task  │         │ Doc                     │  │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘         │ Deck                    │  │
│  …                                                               │ Page                    │  │
│                                                                  │ From a template…        │  │
│  Recently deleted (3) ›                                          └─────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
  ⊕ = the 12 px globe (published). A tile carries a picture, then the glyph, noun and title, never colour alone.
```

**(d) The Share dialog (R-015 now, People in Phase 5). Opening it writes nothing.**

```
┌ Share “Sign-in screen” ──────────────────────────────────────── ✕ ┐     after Publish:
│ People                                                            │     │ ● Published · v9 · just now            ⋯ │
│   Only you can open this.                                         │     │ [ juno.app/share/k3f9…        ][ Copy ]  │
│   (Phase 5: invite field · role · “Who has access”)               │     │ v11 has changes      [ Update to v11 ]   │
│ ───────────────────────────────────────────────────────────────── │     │ 124 views · 81 people · 7 days           │
│ Publish to the web                                                │     ⋯ = Unpublish · Link expires ▸ ·
│   ○ Not published                                                 │         View as a visitor · Reset link
│   Anyone with the link will see v9 exactly as it is now.          │
│   2 Library images in it become visible too.                      │
│                                           [ Publish v9 ]          │
└───────────────────────────────────────────────────────────────────┘
```

**(e) Mac window (glass: system glass sidebar and toolbar; opaque content; opaque dock header; glass composer cluster).**

```
┌ ● ● ● ─ ⊟ ──── [Chat|Code] ┬─ Onboarding redesign ▾   Growth ───────── [Made here 3] [Share] [Private] ┐
│ [⌕ Search           ⌘K]    │                                   │ Sign-in screen · Design   v4 ▾   Share ⋯ ✕│
│ + New chat                 │  You  Make the CTA quieter        │ [Design|Prototype|Motion]      Open in Window│
│ Library                    │                                   ├───────────────────────────────────────────┤
│ Projects                   │  Softened the CTA…                │                                           │
│ Artifacts                  │  ┌ Design · Sign-in screen ─────┐ │   hosted editor, surface=window,          │
│ More                       │  │ [ server SVG poster ]        │ │   bundle hash-gated, row-backed           │
│                            │  │ v4 · Updated        [ Open ] │ │   (TrailingDock 400–60%, opens at 480)    │
│ Pinned chats ›             │  └──────────────────────────────┘ │                                           │
│ Recent ›                   │ ╭───────────────────────────────╮ │                                           │
│                            │ │ Sign-in · v4 · CTA ×           │ │                                           │
│                            │ │ Ask about this design…     ⬆  │ │                                           │
│ Liam · Pro           ⚙     │ ╰───────────────────────────────╯ │                                           │
└────────────────────────────┴───────────────────────────────────┴───────────────────────────────────────────┘
 Document window (⌥⌘O): unified NSToolbar = title + version menu · segmented mode · Play · Share · Comments ·
 History · Juno toggle (⌘⌥C shows the conversation as a trailing pane). Restorable via NSUserActivity.
```

**(f) iPhone: the sheet from a chat card (medium detent) and pushed detail (large).**

```
┌───────────────────────────┐      ┌───────────────────────────┐
│ ‹  Onboarding redesign    │      │ ‹  Sign-in screen    v4 ▾ │
│                           │      │ Design · Updated 2 min ago│
│ Softened the CTA…         │      │ ┌───────────────────────┐ │
│ ┌───────────────────────┐ │      │ │                       │ │
│ │ [ poster ]            │ │      │ │   frame               │ │
│ │ Design · v4    Open   │ │      │ │   (pinch, pan)        │ │
│ └───────────────────────┘ │      │ │                       │ │
│═══════════════════════════│      │ └───────────────────────┘ │
│           ───             │      │ Edit this design on the   │
│ Sign-in screen · v4    ⋯  │      │ web or your Mac.          │
│ ┌───────────────────────┐ │      │                           │
│ │ poster / live view    │ │      │ [Play] [Comment] [Ask] ⋯  │
│ └───────────────────────┘ │      │  44 pt targets            │
│ [ Open full ]  [ Play ]   │      └───────────────────────────┘
└───────────────────────────┘
 medium detent (from the card)       large detent / pushed detail
```

**(g) Card states (one state machine for card, panel header and native; R-007):**

```
Writing v5 · showing v4 (v4 dimmed to 60%)   → Checking… (only after 500 ms) → Ready · v5
Stopped before v5 finished · Keep v4 · Continue v5      Refused: That diagram type (quadrantChart) isn't supported yet. [Try again]
v5 didn't render · Show error · Try fixing              (never a red flash between the close tag and done; M14)
```

---

## 7. Creation and routing

1. **Automatic (unchanged default).**
   - The model decides, using the registry's authoring sections.
   - Visible routing: the card and panel lead with the kind word ("Deck · Q3 pipeline") and the status reads "Making a deck…" (R-028). The prose never narrates it.
   - DESIGN, Deck and REACT turns never go to the cheapest tier. Auto routing is currently mis-classing "build a SaaS dashboard" (`00` §7.2).
2. **Output picker.**
   - `+ › Make…` offers: Design (Auto · Phone · Tablet · Desktop · Square), Doc, Deck, Page, Diagram.
   - The choice arms a pill beside `+` exactly like Deep research (FLAT_UI §4). On Mac it is an armed mark inside the field, per glass §5.5.
   - `/design`, `/doc`, `/deck` and `/page` arm the same pill.
   - The server forces `type`, `profile` and the kind's skeleton path.
   - Settings › Capabilities has per-kind switches for people who want plain chat.
   - The Mac's no-op Canvas toggle is removed.
3. **New menu** (Artifacts, ⌘K, `/new/*`, Mac File › New Design/Doc):
   - one atomic `POST /api/artifacts {kind, profile, preset, projectId?}` creates the artifact **inside a fresh anchor**;
   - the person lands on `/a/{id}` with the editor and a collapsed composer strip, "Ask Juno about this design…";
   - **the first Ask flips the anchor to `kind:"chat"`**, titled after the artifact, and docks the transcript. The URL stays `/a/{id}`.
4. **Skeleton-first streaming (R-033).**
   - For Doc, Deck, Design and long Markdown, the model first emits the title and sections, slides or boards, each with a one-line intent.
   - The server sends an `artifact.skeleton` SSE event. The skeleton lives in the turn's stream state (resumable through the existing recovery path); **no row is created until the first section completes**, so N0 never sees a half-made row. After that the row is `status:"draft"` until the version completes.
   - Filling by kind:
     - Docs: block by block.
     - Designs: operations as NDJSON, validated in batches of at most 10 operations or 250 ms. Frames appear first as hairline outlines at their final size.
     - Pages: re-rendered in a hidden second iframe at structural checkpoints, cross-fading only on success.
   - Stop or token cap: the result becomes a non-current draft ("Stopped · Keep what's here · Discard"). Long outputs are built across calls instead of being truncated (X-07).
   - Auto-open: on the first artifact tag of a turn when the split is at least 50rem and the person hasn't closed the panel in the last 3 turns. It never takes focus, and it announces "Juno opened <title>".
   - While streaming, Send becomes **Steer**; steers apply at the next section boundary.

---

## 8. The AI editing loop

The chat re-emit channel and the Ask Juno channel become one. The model reads the current state and changes it by the smallest verb.

| Step | Mechanism | Reuses |
|---|---|---|
| Read | **Seal the head**, then put a context digest in the turn for every artifact that is open or was touched in the last N turns. The digest holds the id, kind, current version and its author, and either the body (if it fits) or an id-bearing digest: the design node tree with node, variable and component ids; Doc heading and block anchors; Deck slide titles. It also carries the motion digest (animations, tracks, interaction edges). | `selection-context.ts`; `route.ts:1450-1484` (Modify already loads the stored version) |
| Write | Three verbs replace "output the complete updated content" (`system-prompt.ts:257`). **create** (a new artifact; the compact DESIGN grammar survives *only* here, as operations against an empty document, so images, effects and tokens become expressible, which fixes X-10). **patch** (Page, Code, Doc, Diagram: at most 12 exact, unique anchors). **ops** (Design, Deck, System: `<juno:design-ops>`, at most 60 operations; above that the change lands on a branch in Phase 5). Agent-shaped `query`, `tree` and `setMany` expand server-side into validated `updateNode` operations, never model-written JavaScript. | `artifact-edit.ts`; `ai.ts:30-395`; `operations.ts` |
| Commit | Compare-and-swap on the version the turn read. On a 409, re-read and retry once. **Human wins:** a block or node a person edited during the turn is kept, and Juno says so: "You edited the pricing table while I worked, so I kept your version and applied the rest." | `persistTargetedArtifactEdit` (`artifacts-store.ts:103-127`) |
| Show | An **edit card in the transcript**: a summary, a size ("+12 −3 lines" or "12 layers changed"), and Apply and Discard while in review, then Undo. Each applied change is one undo entry, "Undo Juno: <summary>", and one version with `authorKind: model`. | Ask Juno's review card, reworked; M46 (review is read-only for canvas, layers and shortcuts) and M47 (honest failure) are fixed |
| Review policy | Apply directly while Juno drafts a new artifact. Review once a person has edited it by hand, with a one-time note. Also review above 60 operations or when more than one frame is touched. A guard: "Also removes 2 animations and 3 interactions", with **Keep them** preselected (R-009 §5). | — |
| Ask Juno, unified | The on-canvas prompt (⌘↵ or the pill) keeps its anchored `overlay-glass` form but **posts a turn into the artifact's conversation**, created lazily by the anchor flip. `/api/design/[id]/edit` is retired as an experience, and its validation is kept. Design edits never run on `qwen3.8-flash` (M41). | `ask-juno-bar.tsx` |
| Selection context | Every send made while a panel is open attaches `{artifactId, version, view, page/slide, selection ids \| text range \| element path, visible rect, dirty}`. It is shown as one removable chip: "Looking at: Sign-in · v4 · CTA". A "What Juno sees" disclosure lists the payload. Form values are never included. | `quote-context.ts` chip (made reachable by keyboard, M22) |
| Comments → turns | Phase 5: "Ask Juno" in a thread, or @Juno, batches threads into one turn carrying `{version, anchor, quote or node ids, crop}`. Juno answers in the thread: "Done in v12 · View change · Undo this" (R-041). | `DesignComment.transactionId` intent |
| Fix | "Try fixing with Juno" on every failed preview or refusal sends the error and the console as a turn (R-035). The refusal reason is shown (M4). | `canvas-panel.tsx:1223-1235` |

**Rollout order:**
1. Page, Code and Doc patches, where the protocol is already solid.
2. Design operations.
3. Deck and System.

Each step is behind `ai.editLoop.<kind>`. With the flag off, the legacy re-emit path stays, but it now **appends to the same id with `authorKind: model`**, so it can't delete anything.

**Gate:** the golden set (R-047, about 40 prompts × a model matrix) must pass first. Human edits must be preserved 100%, and "make the title bigger" on a design with 3 animations and 5 interactions must keep all 8.

---

## 9. Collaboration, sharing, publishing, governance, and the X-01 fix

### 9.1 Two sharing concepts (answers owner Q3)
- **Publish** is a frozen snapshot pinned to a version, public at `/share/{token}`.
  - Update moves the pin and never changes the URL.
  - Unpublish reserves the token; only Reset issues a new one.
  - Screening runs at Publish and at Update.
  - Opening the dialog publishes nothing (L5, M30).
  - Public state shows in three places: "Shared" with a filled globe in the header, "· Published" in the meta line, and a 12 px globe on tiles.
- **People** (Phase 5, R-039) are grants: viewer, commenter or editor.
  - Grants follow the latest version and inherit from the project ("Inherited: people in Growth can open it").
  - Up to 50 invites; pending invites expire after 30 days.
  - Request access puts a dot on Share.
  - One `canAccess` helper serves every artifact, design and comment route.
  - No seat gates. Plan limits are quotas on the owner.
- **Native.** `NativeShareClient` gains ARTIFACT publish, update and unpublish, with the same sheet. The phone can revoke and change scope. A failed load no longer reads "No shared links".

### 9.2 Comments (Phase 5, R-040)
- **Storage:** an `ArtifactComment` table outside the body, with anchors per kind from the registry.
- **Re-resolution on every version:** exact; "Moved"; or Lost with "Re-attach" or "Make general". A deleted node's pin moves to its parent frame.
- **Interaction:** C enters comment mode and ⇧C hides pins.
- **Deletion and limits:** soft delete with a 10 s Undo; 100 comments per hour.
- **Public snapshots carry no comments.** Guests can't comment on public links.
- **Native:** a bridge `comments` channel; on iPhone, long-press → "Comment here".

### 9.3 Governance (G1, R-011). All of it ships **before or in the same release as** scripted public previews.
1. `Share.suspendedAt`, set by a ban or a takedown and reversible. `ModerationFlag` references a share or artifact and **survives account deletion** (X-31).
2. Admin lookup by token, artifact or user, with Suspend and Restore.
3. A **Report** link in every public footer, with no sign-in, creating a `ModerationReport`. Past a threshold the page auto-suspends pending review.
4. Screening at Publish and at Update (X-32). A refusal names its reason in one sentence.
5. Rate limits through `src/lib/rate-limit.ts`:

   | Action | Limit |
   |---|---|
   | publish and update | 30 per hour |
   | comments | 100 per hour |
   | invites | 50 per day |
   | artifact writes | 600 per hour |
   | design transactions | 1,200 per hour |
   | client-chosen `origin:"restore"` | ignored (X-33) |

6. Link expiry and "Unpublish all" on every plan.
7. Owner-visible activity: "Published v9 · Updated to v11 · Suspended by Juno (Appeal)".
8. Views move to `ShareViewDaily`, bot-filtered with no IP addresses. The owner's sync feed no longer churns on every anonymous view (`share.ts:157`).
9. The legal notice-and-action contact replaces `[adresse e-mail de contact]` (owner Q7).

### 9.4 X-01, split so the biggest outage ends without widening exposure

| Step | What | Ships when | Why it is safe |
|---|---|---|---|
| **X-01a (R2)** | **Owner previews** move to a separate registrable domain, one subdomain per version, loaded by `src` with a signed token (≤5 min). The response CSP: `script-src` limited to the CDN allowlist (cdnjs, jsDelivr `/npm/`, unpkg, Tailwind; runtimes pinned, not dev builds); `img-src https: data: blob:` (keeps PREMIUM §2e's photos); **`connect-src 'self'`** (the exfiltration line); `form-action`, `base-uri` and `object-src 'none'`. The app CSP's `frame-src` adds the preview domain. `/share/*` ARTIFACT previews stay static: designs as server SVG, pages as the poster plus "Open source". Flag `preview.origin.owner`. | Phase 0A | Only the signed-in owner, looking at their own artifact, in an isolated origin. It is no more exposed than a local file, and public pages are unchanged. |
| **X-01b (R4)** | Public share pages run scripts from the same origin. Flag `preview.origin.public`. | With G1, never before | Governance is live. |
| **Mac (N2 / glass)** | The WKContentRuleList mirrors the same CDN allowlist (X-13). This **reverses the glass addendum's closed network, and needs the owner's sign-off (D6)**. Until then the Mac keeps its closed runtime and says so, as glass Stage 3 already does. | After X-01b | One link looks the same everywhere. |

**Coordination with the in-flight X-01 session.** If that fix lands differently, for example by loosening the app CSP for `srcdoc` on the same origin, treat it as X-01a only. `/share/*` stays static until G1. A preview on the app's own origin must not become the long-term answer, because it can't be revoked per token and can't carry its own policy. Turns that included untrusted web or connector content render their Page artifacts behind a "Run preview" click (D6).

---

## 10. Motion and visual design for the merged surface

Everything uses `src/lib/motion.ts`, the `globals.css:314-349` ladder, and `JunoMotion` on native. Only transform and opacity travel (ICONS §2.2 rule 8), hover is tonal, and nothing lifts.

| Moment | Web spec | Reduced motion | Mac / iPhone |
|---|---|---|---|
| Card → panel (card on screen at the click) | Shared element: framer `layoutId="artifact-{id}"` from the poster to the panel's content frame, on `spring.layout` (360 ms, bounce 0). The inner content cross-fades on `transition.fast` (thumbnail ≠ live view). Chrome fades in 60 ms later. The transcript reflows on `spring.standard`. | 120 ms opacity cross-fade (`duration-fast`) | Mac: `matchedGeometryEffect` on `JunoMotion.layout` (the ×0.75 `platformFactor` applies to springs). iPhone: `.navigationTransition(.zoom(sourceID:))`. |
| Panel open (deep link or library) | 16 px `x` plus fade, `duration-slow` on `ease-drawer` | Fade only (fixes L16) | `TrailingDock` enters on the drawer curve at `JunoMotion` base; **replace `canvasEnter`'s outExpo** (`JunoDesignTokens.swift:343`); `shift()` from the glass branch under Reduce Motion |
| Panel close | Exit to its edge on `duration-exit` / `ease-in`. **No fly-back into the card** (PREMIUM §2d: nothing travels across the scroller). Scroll position restored. | Fade | Same |
| Resize drag | Transitions off during the drag; the entrance never replays (L15) | — | `disablesAnimations` during the divider drag |
| Panel ↔ full window | framer `layout` on the surface frame, `spring.layout`. The transcript fades on `duration-exit`. The composer strip uses `variants.rise` after 80 ms. | Cross-fade | Document window opens with the system animation |
| New version lands | **Adopt, never remount** (R-013). Design: `editor.adoptDocument(next)`, keeping selection, viewport and undo (or a labelled boundary). Page: a hidden second iframe cross-fades on `duration-fast` / `ease-out-soft` when the new frame reports ready. Text: replace in place, anchored to the nearest heading. The version pill rolls (RollingNumber). | Instant swap plus the 120 ms fade | The bridge `adopt` message; SwiftUI `.opacity` on `JunoMotion.fast` |
| Change reveal (Juno's edits only) | Changed nodes get the selection-outline style, fading over **`duration-emphasis` (560) on `ease-out-expo`**, the rung "reserved for a change the user did NOT cause". Text blocks get a tonal fill that fades the same way. One shot, no travelling band (rule 14). | Static outline for 1.5 s, then a `duration-fast` fade | Hosted editor, same CSS |
| Streaming | The skeleton appears **only after 500 ms**, on `duration-fast`. Blocks and nodes enter with `variants.rise` at `STAGGER.tight` (30 ms), capped at 8. Later blocks move on `spring.standard` layout. The camera fits once and never chases. | Opacity only | Same tokens |
| Juno is working (a node, a comment or a tile) | One live-state animation product-wide (`status-glow` brightness breathe on `ease-breathe`), which fixes L17 | Static tint | `JunoStatusDot` live tone |
| Library | Rows deal in with `motion-safe:animate-rise-in` and `staggerDelay(i,"base")`, capped at 8, **first load only**. Posters cross-fade in on `duration-fast`. Filters cross-fade. Deleted rows fold with `Collapse` and fade on `exit`. Undo re-inserts with rise-in. | Fades | `.junoPress`, hover tint, a stagger capped at 8 (fixes the "dumped" grid) |
| Status bars, banners, save bar, proposal card | Every exit animates (`exit` variant or `Collapse`), which retires the `01` §5.1 missing-exit debt | Rows snap, the fade stays | — |

**Visual design:**
- **Flat:** hairlines, tonal state, one accent used for state. The layers, tools and Ask Juno chip move off the `bg-primary/10` accent tint to `bg-selected` (FLAT_UI §3.1).
- **Radii** come from the ladder, with the concentric rule.
- **Glyphs** come from the registry (JunoDesign for Design).
- **Mac: Liquid Glass stays on chrome only** (glass §0.1). The system toolbar, the sidebar and the glass composer cluster are glass. The dock header, cards, posters and the hosted editor are **opaque on the warm canvas**. There is no glass on glass.
- **The hosted editor** gets the web's warm tokens and the shared primitives (X-17) and the user's accent, instead of indigo and zinc.
- An in-app **Motion setting** ("System | Reduced — reduces animation in streaming responses and made things") arrives in Phase 5 (R-072).

---

## 11. Work deliverables

**Recommendation (owner Q1): index now (option A), fold documents and presentations into Doc and Deck later (B-lite), and keep binary-truth kinds as deliverables permanently.**

| Deliverable kind | Now (Phase 3) | Later (Phase 5) |
|---|---|---|
| document (.docx) | Indexed under "From tasks"; opens a Deliverable detail with the validated file and every version | The runner's `create_deliverable` also writes a **Doc** (MARKDOWN + `profile:"doc"`) converted from the typed spec. The .docx becomes a derived export attached to that Doc version (`ArtifactLink kind:"derived-file"`, `WorkArtifact.linkedArtifactId`). |
| presentation (.pptx) | Indexed | The spec's five fixed layouts become frame templates in a **Deck**; PPTX is exported from the Deck |
| spreadsheet, site, archive, pdf, image | Indexed; windowed and sandboxed previews as today | Stay deliverables. Bytes are the truth, and a Sheet kind is not proposed (D16). |

**Starting now:**
- Persist the spec: `WorkArtifactVersion.spec` is written by `scripts/work-runner.ts:1985-2078`. It is cheap, and it keeps option B open.
- Fix reachability, all of it independent of the merge:
  - X-25: mount the unmounted `work-documents.tsx` kit in the run's terminal card, and every kind becomes downloadable;
  - X-26: purge objects on account deletion;
  - X-27: unwrap the envelope in `DesktopWorkWorkspace.swift:4956-4977` and `JunoMobileWorkView.swift:2237-2257`;
  - X-28: live refresh;
  - X-29: native-created sessions get a conversation link (glass Phase 5 adds `conversationID` to `WorkSessionSummary`).

**MARKDOWN → Office today:** it becomes Doc's export path through one OOXML renderer. The near-duplicate `work/deliverables/document.ts:173-358` is retired onto `office-export.ts`, and both keep the shared validator (`00` §4.5 "Office generation").

**Research reports:** indexed as Docs. The fixed `research-report` identifier becomes `research-report-{runId}`, which stops the collision (`route.ts:220-240`).

---

## 12. Performance and telemetry

### 12.1 Payload diet (X-30, X-33, R-064)
- **REST.** `serializers.ts:207-223` returns `versions: [current]` plus `versionIndex[]` (metadata only). History loads on demand. The target p95 thread payload is **≤ 1.5 MB**, from 9–27 MB after an hour of design editing.
- **Design transactions** read the head and the current version only, not every body two or three times (`store.ts:33-39`).
- **Sync.** v2 clients receive the current body only. Head writes are never change-captured, so a fold no longer wakes every device (`00` §12.6).
- **Canvas chunk.** The design editor splits out of the ~449 KB canvas chunk and loads dynamically only for `mode:"design"`. Inline cards mount sandboxes only when visible and latest.
- **Thumbnails.** `GET /api/artifacts/{id}/render?v=&frame=&w=` returns SVG, PNG or WebP, cached by `(id, version, frame, width, contentHash)` in object storage. Renders are generated **on seal**, never on each fold. X-24 (container opacity and rotation) is fixed first, so posters are correct.
- **Limits.** At 80% of the 200k budget: "Large design · 164k of 200k · Move images to asset storage · Split page". At 100%, only the save that would exceed it is refused, and the editor is never locked.

### 12.2 Telemetry spine (Phase 0, R-020)
- **Collection.** `src/lib/observability.ts` (imported by nothing today) writes structured events to a `MetricEvent` rollup table, plus client beacons to `/api/telemetry` (rate-limited, no content, no PII).
- **Dashboard:** an internal `/admin/metrics/artifacts` page.
- **Signals:**

| Signal | Why | Target |
|---|---|---|
| Deletion ledger: unexpected reasons | Principle 1 | 0 per week |
| Preview render success per runtime (`juno:status` ready vs error vs 8 s timeout) | X-01 went unnoticed for about 4 weeks | ≥ 99% for HTML, React, Mermaid |
| p95 thread payload; design transaction p95 latency | X-30 | ≤ 1.5 MB; ≤ 150 ms |
| Head seal rate, 409 rate, bridge refusals (`lastRefusal`, now reported), fields restored by the preserving merge | X-14, X-15 | Refusals under 0.5% of transactions |
| Verification refused, repaired, passed; incomplete-version rate | X-07, M4 | Truncated-as-current = 0 |
| Native client and bundle version distribution; unsupported kinds seen; skipped rows | X-09, X-19; compatibility window | Window thresholds (§3.4) |
| Legacy route hits (`?artifact=`, `/design`, `/design/{id}`, `?id=`) | Knowing when a redirect can retire | Trending down |
| Find rate: Artifacts open → item open within 30 s; search zero-result rate | The IA merge's real metric | Not worse than baseline, then better |
| Proposals shown, applied, discarded; human-wins conflicts; eval pass rate | The AI loop | Apply success ≥ 98% |
| Time to first skeleton, time to first content; completion states | Streaming | First skeleton ≤ 1.5 s p75 |
| Share views (bot-filtered), reports, suspensions, time from report to takedown | Governance | Takedown ≤ 5 min p95 once reviewed |

---

## 13. Phased roadmap

**Rules:**
- One releaser per train, from memory: other sessions commit on main concurrently. The releaser gates the exact tree they commit.
- A release goes out every 1–2 weeks, with at most one navigational change visible to users per release.
- **W1 is the week of 2026-09-28.**

### 13.1 Phases

| Phase | Weeks | Releases (what users see) | Closes | Exit criteria (all required) | Rollback | Native window |
|---|---|---|---|---|---|---|
| **0A. Stop the bleeding (server and web)** | W1–W2 | **R1:** deploy `7243613f` (X-03, X-04); X-02 (embedded editor keyed by `artifactId`, using the returned row and never a synthetic `""` version); X-08 (size checked after expansion); X-23 (`filename*`); X-21 (reads `items`, filters by `projectId`); conversation delete → anchor (copy "N artifacts made here stay in Artifacts"); holder chats → anchors (B3); deletion ledger; telemetry spine. **R2:** X-01a; DESIGN posters in the card, tiles and share page via server SVG (X-20 static); `ArtifactVersion.complete`, with incomplete versions never current (X-07 core); field-preserving DESIGN save (X-14 server-side); "Open full editor" link from the panel's design to `/design/{id}` (a stopgap for M17 and Ask Juno) | X-02, X-03, X-04, X-07 (core), X-08, X-14 (server), X-20 (static), X-21, X-22, X-23, X-01 (owner half); R-007 (part), R-020, R-006 (lifecycle half) | Ledger unexpected = 0 for 7 days; owner preview success ≥ 99%; X-02 repro test green; Q9 answered | Flags `lifecycle.detachOnDelete`, `preview.origin.owner`, `design.fieldPreservingSave` off. Bug fixes are plain reverts. | None; everything is N0-safe |
| **0B. Native compatibility and governance** | W2–W4 | **R3:** N1 (Mac 1.6.x off main; iPhone): tolerant decoding, headers and caps, flags, bundle rebuild and CI gate plus CSS scan plus `surface=window` (X-17, X-18, X-19), save base from the opened version (X-15), draft-loss prompt (X-16), iPhone design read-only. **R4:** G1 governance; Share dialog writes nothing on open; X-01b public previews | X-09, X-13 (decision only), X-15, X-16, X-17, X-18, X-19, X-31, X-32, X-33 (limits), X-01 (public half), L5, M30; R-001, R-002, R-011, R-012, R-015 (part) | N1 on ≥ 95% Mac / ≥ 90% iPhone active devices within 14 days (Mac auto-update); 0 "Artifacts unavailable" events on N1; takedown drill ≤ 5 min; ban → shares suspended ≤ 1 min | `preview.origin.public` off. N1 is forward-compatible, so it needs no rollback. | **N1 opens the window clock** |
| **1. Decouple artifacts from messages** | W4–W8 | **R5:** M1 and M2 expand migrations plus B1, B2, B4 (invisible); `canAccess` in shadow mode; payload diet (faster). **R6:** Recently deleted (web; N0 sees tombstones). **R7:** head and seal replace fold-in-place (`versions.head`); provenance fields; `Share.versionId` pins ("Published v9"). **R8:** thumbnails everywhere (X-24 first); account export includes artifacts (R-067) | X-22 (complete), X-24, X-26, X-30, X-33, M10, M31, M60; R-004, R-005, R-006, R-014, R-064 (part), R-067 | 0 shadow mismatches for 7 days, then enforce; p95 payload ≤ 1.5 MB; trash restore returns versions and token in 100% of drills; posters for ≥ 99% of sealed versions within 10 s | Flags `versions.head`, `artifacts.trash`, `share.pinned`, `payload.diet`, `thumbs.v1`, `auth.artifactOwner` off. Columns stay unused. | N0-safe (tombstones, omissions) |
| **2. Canonical route and one surface** | W8–W11 | **R9:** `/a/{id}` plus `ArtifactSurface` in the panel (`surface.v2` cohort: owner, then 10% → 50% → 100%); inline card v2; one live card per artifact; container-sized editor (R-017); Esc and focus contract (M23). **R10:** every entry point emits `/a/{id}` (search, library, share, projects, Outputs, notifications, native deep links); redirects for `?artifact=` and `/design/{id}` (`route.canonical`) | X-02 (structural), X-11 and X-12 (glass Stage 3 on Mac; iOS card to the stored row), X-20 (complete), M17, M23, M28, L9, L27; R-013, R-016, R-017, R-023, R-024, R-025 (part), R-021, R-070 (part) | 100% of entry points emit `/a/{id}`; redirect failure < 0.1%; panel open → interactive p75 ≤ 400 ms; 0 editor remounts per version change (instrumented) | `surface.v2` off returns the old CanvasPanel; `route.canonical` off stops the redirects. `/a/{id}` stays reachable. | N0-safe |
| **3. IA merge behind flags** | W11–W15 | **R11:** `ia.merged` (owner → internal → 10% → 50% → 100% over 2 weeks): the Artifacts home v2 on `/library` machinery; the New menu (anchors); Design row as a pointer; `/design` 308; "Made here" popover; deliverables and generated images indexed (`index.deliverables`); X-25 kit mounted. **R12:** Design row removed; ⌘K New design, doc and deck. **Mac:** glass Phase 4 Artifacts page, with the Design row repointed then removed. **iPhone:** same filters | X-21 (complete), X-25, X-27, X-28, X-29 (web link), M26, M27, L34; R-008, R-018, R-027, R-079, R-092; `00` §13 Q2 | Find rate ≥ baseline; 0 404s on `/design/*`; deliverable download success ≥ 99%; fewer than 3 "can't find my designs" reports per 1k weekly active users | `ia.merged` off restores the old sidebar and `/artifacts`. Redirects fall back to rendering the old pages. | N0 keeps its own Design screen, over the same rows |
| **4. AI editing loop** | W14–W22 | **R13+:** golden eval set (R-047) first; `ai.editLoop.page\|code\|doc`, then `.design`, then `.deck\|system`; edit cards and review; unified Ask Juno; selection chip; Make… picker (`ai.makePicker`); skeleton-first streaming (`stream.skeleton`); Try fixing | X-05, X-06, X-07 (complete), X-10, M4, M14, M15, M22, M40, M41, M46, M47; R-009, R-010, R-028, R-031, R-033, R-035, R-036, R-047 | Eval: human-edit preservation 100%; animations and interactions preserved 100%; proposal apply success ≥ 98%; truncated-as-current = 0 | Per-kind flags off fall back to legacy re-emit, which now appends to the same id | N0 sees only completed versions |
| **5. Parity** | W18–W32 | Comments and send-to-Juno; grants and People sharing; version stepper and compare; branches (Try 2 / Use this); Doc, Deck and System profiles (`kinds.doc`, `kinds.deck`, `kinds.system`); bridge v2 (operations over the bridge, `adopt`, proposals, comments, export through NSSavePanel, open panel); native transactions save and offline queue (R-065); the phone contract lifts the iPhone read-only guard (`phone.designEdit`); motion runtime and conformance, then Play; Mac document windows (R-068) | X-13, X-15 and X-16 (structural), M13 (Mac); R-022, R-029, R-030, R-039, R-040, R-041, R-042, R-051, R-058, R-059, R-060, R-065, R-066, R-068, R-069, R-019, R-057 | Per feature (comment loss < 0.1% with retry; offline drafts never cleared silently; Play preview = export in the conformance suite) | Per-feature flags | New namespaces are caps-gated; **DesignDocument additions only after bridge v2 plus opaque preservation** |
| **6. Contract and clean-up** | Window closed + 2 releases (≈ W24–W34) | `userId` NOT NULL (M9); `conversationId` nullable plus SetNull, anchors converted and deleted (M10); legacy projection removed; flags older than 2 releases at 100% deleted; `/api/design/[id]/edit` removed | — | Pre-contract snapshot of the Artifact, ArtifactVersion, Share and Conversation(anchor) tables; 0 N0 devices in 14 days | Restore from the snapshot (expand-only undo is impossible past this point, hence the gates) | **Window closed** |

### 13.2 Flag registry

- **Evaluation:**
  - `src/lib/flags.ts` over a `FeatureFlag` table with a 30 s cache.
  - The order is env override → owner allowlist → a stable hash of userId against the percent. `killed` wins over everything.
  - Flags are evaluated on the server and passed to the client from the app layout.
  - Native clients receive them through `bootstrap.featureFlags` (the field already exists and is `{}`).
- **Metadata:** each flag records an owner, the metric that decides it, and a removal date (two releases after reaching 100%).
- **The flags:**
  - `lifecycle.detachOnDelete`, `preview.origin.owner`, `preview.origin.public`, `design.fieldPreservingSave`
  - `auth.artifactOwner`, `versions.head`, `artifacts.trash`, `share.pinned`, `payload.diet`, `thumbs.v1`
  - `surface.v2`, `route.canonical`, `ia.merged`, `index.deliverables`
  - `ai.editLoop.{page,code,doc,design,deck,system}`, `ai.makePicker`, `stream.skeleton`
  - `comments.v1`, `grants.v1`, `kinds.{doc,deck,system}`, `phone.designEdit`, `play.v1`
  - Native only: `native.regenerateKeeps`. The glass build skips its "Regenerate this answer?" confirmation once `7243613f` is deployed, because nothing is replaced any more.

### 13.3 What must not ship before what

```
X-03/X-04 fix deployed ──► glass "regenerate settled answers" (already guarded by its confirmation)
G1 governance ───────────► X-01b scripted public pages ──► Mac CDN allowlist (D6)
N1 tolerant decode + caps ► any new sync namespace (comments, grants, links, user state)
                          ► v2 sync diet (current body only)
N1 window closed (+2 rel) ► conversationId null on the wire; anchors dropped; userId NOT NULL
bridge v2 + opaque fields ► ANY DesignDocument schema addition (incl. deck/system extras) ► iPhone design edit
thumbnails (X-24 first) ──► IA merge (the index must show pictures) ──► Design row removal
/a/{id} + redirects ──────► /design 308 (the redirect needs a target)
head + seal ──────────────► model reads current version (seal before read) ──► AI edit loop
CAS + human-wins ─────────► direct-apply of Juno edits to hand-edited artifacts
eval golden set ──────────► each ai.editLoop.<kind> above 10%
motion conformance (R-019) ► Play / Present / prototype share links
grants (commenter role) ──► comments by non-owners; phone "comment" for others
spec persisted ───────────► Doc/Deck dual-write from Work
```

---

## 14. Risks, mitigations and owner decisions

### 14.1 Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | A backfill assigns the wrong owner, leaking artifacts across accounts | Low / critical | `userId` is derived only from `conversation.userId`. `canAccess` runs in shadow for 7 days. Enforcement flips only at 0 mismatches. Conversation auth stays valid throughout, because anchors keep `conversationId`. |
| 2 | iPhone adoption lags, and the compatibility window never closes | Medium / medium | Mechanisms A–C mean nothing user-visible depends on the window except Phase 6 contraction and new namespaces for old devices. The window is measured, not assumed. |
| 3 | Anchors leak into lists (web recents, search, project lists, export) | Medium / low | One `visibleConversationWhere()` helper, plus a source-reading test that fails on any `prisma.conversation.findMany` without it (the repo already uses guard tests like this). Native already filters kinds. |
| 4 | Anchors retain private content from deleted chats | Low / high | Conversion purges messages and message versions, revokes CHAT shares, sets the title to "Your artifacts" and clears `titleSource`. Attachments follow today's policy, and the dialog names them. A test asserts that no Message row survives. |
| 5 | Two version semantics coexist during `versions.head` | Medium / medium | Cohort by account, not by request. Seal on every read by Juno. Shares already pin by id (R7 ships with the head). |
| 6 | The field-preserving merge revives a field the user deliberately removed | Low / low | It restores only fields the *Swift schema cannot represent* (an allowlist generated from the JSON Schema diff), never fields Swift knows. |
| 7 | The X-01 session ships public scripted previews before G1 | Medium / critical | §9.4 coordination rule: `/share/*` has its own flag, and the releaser's gate checks it. |
| 8 | Conflict with the glass branch, which is mid-Phase 2 (Stage 3 touches the same files) | High / medium | N1 cherry-picks glass's store skip logic, so there is one implementation. Mac IA changes land *in* glass Phase 4. The Design row is repointed rather than fought. The glass confirmation is retired by a server flag. |
| 9 | The IA merge hurts findability ("where did Design go?") | Medium / medium | A one-release pointer row; `/design` lands on Designs with presets pinned for 60 days; the find-rate metric gates each rollout step; the kill switch restores the old sidebar. |
| 10 | The AI loop regresses output quality (patches misfire, operations refused) | Medium / high | The eval gate, per-kind flags, and a legacy fallback that is now non-destructive. Refusals name the layer. Retry once on a 409. |
| 11 | Storage growth from never hard-deleting, and 30-day trash | High / low | Unnamed autosaves pruned per plan; head writes are not versions; purge job; quotas limit *creation*, never reading or export (R-067). |
| 12 | Flag sprawl | Medium / low | Removal dates enforced by a CI check that fails on flags past their date. |
| 13 | Artifact bodies are plaintext at rest while the privacy policy implies otherwise (`00` §12.1) | Certain / legal | Correct `legal/confidentialite` copy in R1. Encryption is a separate decision (D13). |
| 14 | Mac editor bundle drift recurs | Medium / high | The `design:editor:check` gate in `native.yml` and in `release-macos.sh`; the hash covers shared imports and CSS (X-19). |

### 14.2 Decisions the owner must make (with a recommendation for each)

| # | Decision | Recommendation |
|---|---|---|
| D1 | WorkArtifact: unify or index? (Q1) | **Index now (A).** Persist the spec now. Fold documents and presentations into Doc and Deck in Phase 5 (B-lite). Spreadsheets, sites and archives stay deliverables. |
| D2 | Library fold vs siblings; Design destination vs type (Q2) | **Siblings** (Library = inputs, Artifacts = outputs). **Design is a type**; its row goes after one pointer release. Amend TWO_PRODUCTS §3 in `OPEN_DECISIONS.md`. |
| D3 | Public link: snapshot, live, or both (Q3) | **Both, separated.** Publish = frozen, pinned, explicit Update. Live = people grants only. |
| D4 | New kinds as enum values or profiles | **Profiles** (Doc/MARKDOWN, Deck/DESIGN, System/DESIGN). No enum additions in this programme. |
| D5 | Where comments live (Q5) | **Their own table.** No guest comments on public links. |
| D6 | Preview egress and untrusted turns (Q6); Mac network | `connect-src 'self'`, a CDN script allowlist, https images; **click-to-run** for turns with web or connector content. The Mac opens to the same allowlist after X-01b (this reverses the glass addendum's closed network). |
| D7 | iPhone design editing (brief vs code) | **Read-only from N1 until bridge v2** (a temporary regression that trades convenience for no data loss). |
| D8 | Conversation delete default | **Detach** (keep artifacts), with opt-in "Also move them to Recently deleted". |
| D9 | Compatibility window threshold | ≥ 95% Mac / ≥ 90% iPhone active devices over 14 days, and at least 45 days after N1. |
| D10 | Legal contact; reversible suspension (Q7) | Name a notice-and-action address before R4. **Suspension is reversible**, and deletion never erases flags. |
| D11 | Artifacts in private chats (Q8) | **Keep them off.** The card offers "Continue in a saved chat" to keep the work. |
| D12 | Version retention per plan | Unnamed autosaves: Free 30 days, Pro 90 days, Max 1 year. Named, published and commented versions are kept forever. |
| D13 | Encrypting artifact bodies at rest | Defer; fix the policy copy now. Revisit once the search index can use a derived field. |
| D14 | Glass branch coordination | Ship its Phase 1 Design row unchanged; repoint it in glass Phase 4; remove it one release later. |
| D15 | Generated images: made things or files? | **Both.** They are Library files, indexed by reference under Artifacts › Images. |
| D16 | A Sheet kind | **No.** xlsx stays a deliverable and a Doc/Markdown export. |
| D17 | Production data (Q9) | Run the read-only SQL in W1. It decides whether the oversized-row omission (B5) is urgent. |
