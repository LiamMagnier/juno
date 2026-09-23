# Merge proposal: object-first (Figma-grade)

**Status:** proposal, 2026-09-23. **Angle:** artifacts are first-class objects, like Figma files. The library is the spine, and the conversation is a companion that opens beside any object. **Basis:** `main` at `7f92324f`, read only. **Inputs:** `00-AUDIT-OVERVIEW.md` (X-ids, §12 preconditions, §13 questions), `01-AUDIT-WEB.md` (D/M/L ids), `02-AUDIT-MAC.md` (H/M ids), `03-COMPETITIVE-AUDIT.md` (pattern ids U/A/V/C/S/L/E/N and motion M1–M16), `research/claude-primary-evidence.md`, the consolidated backlog (`R-001`…`R-101`), `TWO_PRODUCTS.md`, `FLAT_UI.md`, `PREMIUM_AUDIT.md`, `ICONS_AND_MOTION.md`, and the Liquid Glass plan in the `juno-glass` worktree (`MACOS_LIQUID_GLASS_REDESIGN.md`, read only).

**What is in flight elsewhere, and assumed here, not redone:** X-03 and X-04 are fixed on `claude/agitated-elion-a15fe9` (`7243613f`). The Liquid Glass branch (`2b1049c5`) makes the Mac card and dock row-backed (X-11, X-12), skips unknown kinds and oversized rows instead of failing the store (X-09 on Mac), carries `cornerSmoothing` (X-14), draws designs inline from the server SVG, confirms regenerate, and runs Mac previews in a closed sandbox. Other sessions may be fixing X-01 and X-02. Where this proposal depends on one of these, it says so and gives the gate.

---

## 0. The proposal on one screen

1. **An artifact is a file.** It has an id, an owner, a home (a project or "Your artifacts"), a history and a canonical URL, `/a/{id}`. It is not an attachment to a message. No chat gesture can delete it: not editing a message, not regenerating, not deleting the chat.
2. **Every artifact has a thread.** The thread is the conversation it was made in, created lazily for anything made by hand. Each collaborator gets their own private thread, so sharing an artifact never shares anyone's chat. Comments sent to Juno arrive in the sender's thread as turns, and Juno's reply comes back to the comment.
3. **Conversation on the left, object on the right, at every size:** the transcript card, the panel beside the chat, the full window (where the chat folds into a leading "Chat" pane), the Mac document window and the phone sheet. It is one `ArtifactSurface`, mounted by artifact id and never remounted by version.
4. **The library is the spine.** The sidebar keeps one **Artifacts** row, and **Design** stops being a place. It becomes a kind, a filter and an item in the **New** menu. Artifacts home has thumbnails, server search, sort, scopes (Recents, Starred, Shared with me, In project, Published), trash and a New menu. New creates the object first; the conversation starts with the first Ask.
5. **Juno edits the object, not its own memory of it.** Every AI change reads the current version and arrives as a proposal in the thread: patches for text and code, validated design operations for designs and decks. When a person has hand-edited, their words win. Ask Juno, on-canvas prompts, comments and chat are one channel.
6. **Figma-grade where the engine already is.** The scene model, the 37 invertible operations, auto layout with grid, effects, variables and motion are strong (`00` §8). Push them to parity: live components with overrides, variables bound to every field, motion model v2, one runtime, Play and Present, Inspect, keyboard and clipboard. Hold back on what the engine lacks (vector networks, multiplayer cursors) and say so in one line.
7. **Share is people; Publish is the public web.** Grants (viewer, commenter, editor) give live access. Publish is a snapshot pinned to a version, with Update and Unpublish and the same URL each time. Governance (suspend, takedown, report, screening, rate limits, egress policy) ships **before** scripted public pages. The X-01 origin fix ships in two gates: private first, public after governance.
8. **Work deliverables become artifacts.** They are indexed now (option A) and stored as typed artifacts later (option B): Doc, Deck and Sheet with the spec as source, plus binary-backed File versions. Office files and PDFs become derived exports of a version. One OOXML renderer.
9. **Order is everything.** Native builds that tolerate unknown kinds and entity types ship first. Ownership, versions, trash and governance come next. Then the surface and redirects, then the AI loop, then collaboration and typed kinds, with a parallel editor track. Six phases, each with an exit test and a flag (§13).

---

## 1. Thesis, principles and day one

### 1.1 Thesis

Juno already stores designs as typed artifacts in one table (`schema.prisma:1135-1170`, DESIGN in `ArtifactType`). What it lacks is the thing that makes Figma trustworthy: **the object is the unit of identity, ownership and history, and every other surface is a view of it.** Today the unit is the message. That is why an edit deletes work (X-03), a regenerate re-mints ids (X-04), a chat delete takes designs with it (X-22), the Mac dock shows a copy of the tag instead of the row (X-11, X-12), and the model rewrites from its own memory (X-05, X-06).

Anthropic's merge had the same dependency. The storage step (account-owned artifacts, 2026-08-19) came four weeks before the UI toggle went away (`03` §2.3). This proposal starts from the object and designs outward. A conversation stays the fastest way to make something, but it becomes one of three ways in, beside **New** and **Turn into…**, and one of two ways to change something, beside direct editing.

### 1.2 Principles

1. **The object is the unit.** An artifact has an id, an owner, a home, versions and a URL from its first byte. Conversations, messages and projects point at it; none of them owns its lifetime. Every removal is reversible for 30 days.
2. **One surface, five sizes.** Card, panel, full window, public page and phone sheet are one `ArtifactSurface` with one header, one state machine and one mount keyed by artifact id. A version is data, never a React key or SwiftUI identity. That rule is the X-02 root cause, stated as a law.
3. **Conversation left, object right.** In the chat the transcript is left and the panel right. In the full window the chat folds into the leading pane. On the Mac the TrailingDock and the document window keep the same order. People never have to re-find the conversation.
4. **Juno works in the open.** Juno reads the current version and proposes targeted changes in the thread. People review, apply and undo. Every Juno change is one version and one undo entry, and a human edit made while Juno works is kept and reported.
5. **Every kind ships whole or not at all.** No kind ships without versions and the stepper, trash, comments, a server-rendered picture, a phone contract and native decoding. This is the anti-pattern Claude Docs and Design shipped with (`03` §8 #1).
6. **Share is people; Publish is public.** Opening a dialog never writes anything. A public link is a pinned snapshot with a visible state, and governance ships with the first public script.
7. **Figma-grade where the engine is strong, honest where it isn't.** Keep Juno's precise inspector and layers; do not simplify to Claude's contextual-only editing (R-017 resolution). A capability that is absent says why in one line (v0's lesson, `03` §4 #18).
8. **Old doors keep working, and native learns first.** Every URL and native destination redirects to the object. A kind or sync entity reaches installed builds before the server emits it (`NativeSyncAPIClient.swift:140-175`).

These sit under Juno's existing laws. FLAT_UI governs material (one plane, tonal state, one accent used for state). PREMIUM_AUDIT §3 governs composition: rule 2 (two panes), rule 6 (one trailing signal), rule 7 (no meters), rule 11 (container sizing) and rule 14 (no borrowed loading gestures). ICONS_AND_MOTION §2 governs motion. Where this proposal reads a law, it says how (for example §6.1 on rule 2).

### 1.3 The bets that make this angle different

- **The canonical URL belongs to the object** (`/a/{id}`), not to the chat (`/chat/{c}?artifact=`). A chat is one place an object can be open.
- **Per-person threads** instead of one shared chat. This is Figma's agent-chat-per-file model, but private by default (`03` §8 #24).
- **New is as cheap as asking.** It is one atomic `POST /api/artifacts` with no holder chat (M29), and it lands in the full editor.
- **The full window is the real editor.** The panel is a working view. At a typical 500–600 px panel the design editor runs its compact layout (canvas, contextual bar, sheets), and one gesture expands it to the Figma-grade window without losing undo, selection or zoom.
- **Projects are folders for objects**, not just chat groupings. They supply the grant inheritance the Share dialog explains.

### 1.4 What the owner experiences on day one

Day one is the first release with the Phase 2 flags on (§13).

- **Sidebar.** Library, Projects and **Artifacts**; there is no Design row. For one release a small pointer row reads "Designs now live in Artifacts" and then goes away. The Pinned fold can hold artifacts as text rows with the kind as the one trailing word ("Q3 pipeline · Deck").
- **Artifacts home.** A grid of real pictures: design covers, deck slide 1, page captures, typeset doc excerpts. There are chips (All, Designs, Docs, Decks, Pages, Diagrams, Code, Images, From tasks), a search that finds text inside things, "Last edited" sort, and **+ New ▾** with Design ▸ Phone, Tablet, Desktop, Square, Portrait and Custom, then Deck, Doc, Page and From a template. Trash is at the foot as "Recently deleted".
- **In a chat,** "Design a pricing page for a note-taking app" makes the panel open by itself (without taking focus) on "Design · Desktop", with hairline frame outlines at their final size. Frames fill in as operations stream. The card in the transcript shows the poster and "Making a design · 2 of 3 frames". Stop keeps the finished frames as a draft, never as the current version.
- **Selecting the hero** puts a chip in the composer ("Looking at: Pricing · v1 · Hero ×"). "Quieter CTA" produces an edit card in the transcript ("3 layers changed · Apply · Discard"), and the canvas outlines the three layers. Apply makes v2. Undo is "Undo Juno: Quieter CTA".
- **Expand (⌘⇧↩).** The panel grows to the full window. The transcript folds into the leading **Chat** pane and the composer moves with it, keeping its draft. Layers is one tab away; the inspector is on the right. The URL is now `/a/{id}`. Back or Esc returns to the chat exactly where it was.
- **Editing a typo in an earlier message** changes nothing about the design, apart from a "From an earlier reply" label on versions that branch. Deleting the chat asks "3 artifacts made here stay in Artifacts", with an unchecked "Also move them to Recently deleted".
- **Share** opens on "Only you can open this" and "Not published". Publish v2 opens a sheet stating what becomes visible. After that, the header button reads "Shared" with a filled globe, and the tile carries a 12 px globe.
- **On the iPhone,** the same design opens from its link or the Artifacts section in a sheet with pinch, Play, Comment and Ask. Editing is honest ("Edit layers on the web or your Mac") until phone saves go through transactions (R-002, then R-069).

---

## 2. The object model

### 2.1 What an artifact is after the merge

> An **artifact** is an account-owned, typed, versioned object. It has a stable id, a kind from the registry (§2.8), a mutable **working head** and immutable **versions**, an optional **home project**, an optional **made-in conversation**, and one private **thread** per person working on it. It carries comments, grants and published snapshots. It lives at `/a/{id}` and is removed only through a 30-day trash.

What stays outside the object:
- **Inline visuals** (`juno-visual`, inline Mermaid) remain ephemeral transcript content. They can be kept with "Open as artifact" (R-077), which creates a v1 with `authorKind: MODEL`, `origin` "promoted" and `derivedFromMessageId`.
- **Uploads** stay Attachments in the Library.
- **Code PRs** stay in Juno Code.

### 2.2 Identity

- **One id per `(conversationId, identifier)`, permanently.** A re-emit of the identifier by any later turn, including after edit or regenerate, appends a version to the same id. This is the server half of R-004; the delete half is in flight (X-03, X-04).
- **The kind is immutable per id.** If the model re-emits an identifier with a different kind, a *new* artifact is created. The card says "Made a page instead of updating the component" and links both. This fixes M11 and the type overwrite at `artifacts-store.ts:61-67`.
- **The title is sticky** once a person renames it. A model re-emit may propose a title, but it never overwrites a user rename; `titleSetBy` is `USER` or `MODEL`.
- **Addressing across chats.** When a conversation references an artifact made elsewhere (an "Add from Artifacts" chip, R-075), the model addresses it by id (`<juno:artifact op="patch" id="…">`, or the `artifact_*` tools of R-032), never by identifier. Identifiers are only a per-conversation convenience.

### 2.3 Ownership, home and threads

| Field | Meaning | On delete of the parent |
|---|---|---|
| `userId` | The owner. Only the owner publishes, deletes or changes access. | Account delete purges immediately, storage included (X-26) |
| `projectId` | Home folder. Inherited from the made-in chat, or from where New was pressed; changed with "Move to project". Grants inherit from it (§9.1). | `SetNull`: the artifact moves to "Your artifacts" |
| `conversationId` | **Made in.** Provenance, and the owner's default thread. | `SetNull` (**detach**, not cascade; X-22) |
| `ArtifactThread(artifactId, userId, conversationId)` | Each person's private chat with Juno about this object. The owner's row points at the made-in conversation. Other rows are created on that person's first Ask and appear in their own Recents, titled "About <artifact>". | The row goes; a new thread is created lazily on the next Ask |

**Why per-person threads.** R-073 requires that sharing an artifact never shares the conversation that made it. If a grantee's Ask landed in the owner's chat, the grantee's request would run with the owner's private context, and the reply would be visible to the grantee. Per-person threads avoid that by construction. Each person's Asks bill their own plan (R-036). There is also an opt-in, "Let people with access read the conversation that made this" (R-073), which exposes the made-in transcript **read-only** to grantees.

**Artifact-scoped turns.** A message sent from an artifact surface (an on-canvas prompt, a comment sent to Juno, a selection Ask) gets `Message.artifactScopeId`. For people with access, the artifact's **Activity** view (versions, applied proposals, comment threads) projects only these turns, and only their summaries and version links, never the surrounding chat (R-073).

### 2.4 Lifetime: every gesture and what it does

| Gesture | Today | After the merge |
|---|---|---|
| Edit an earlier message | Hard-deletes later artifacts, versions and shares (X-03) | Branches from the version that existed at that message. Later versions stay and are labelled "From an earlier reply" (R-029) |
| Try again / Switch model / More concise | Deletes and re-creates with a new id (X-04) | Appends a sibling on branch "Try 2" of the same id. The card gets a ‹ 2/2 › pager and "Use this" (R-029). The glass branch's "Its N artifacts will be replaced" confirmation is retired once this lands |
| Stop, or hitting the token cap | The cut version becomes current, labelled "verified" (X-07) | A non-current draft (`complete=false`): "Stopped before v5 finished · Keep v4 · Continue v5" (R-007) |
| Plain chat follow-up | Full re-emit from stale text (X-05, X-06) | Proposal against the current head (§8) |
| Delete a conversation | Cascades artifacts, designs, files, shares (X-22) | Detaches. "3 artifacts made here stay in Artifacts" and an unchecked "Also move them to Recently deleted" |
| Delete a project | — | Artifacts move to "Your artifacts". The same dialog pattern offers "Also move them to Recently deleted" |
| Delete an artifact | Hard delete of versions and shares (01 §2.1) | Recently deleted for 30 days. Public links answer 410 "This page isn't shared any more", grants are suspended and comments hidden. Restore brings back the same token, grants and comments (R-006) |
| Delete the account | Leaves deliverable bytes in the bucket (X-26) | Immediate purge of rows and storage objects |
| Private (incognito) chat | Canvas off (`route.ts:958-990`) | Unchanged in v1 (decision D8, §14.2) |
| Fork a conversation | Drops artifacts (`fork/route.ts:17-27`) | The fork references the same artifacts (no copy) and gets its own thread rows when it Asks (R-075) |

### 2.5 Versions: working head, sealed versions, branches and published pins

The design store today folds edits into the newest version row for 30 seconds (`store.ts:179-203`). That breaks append-only history (`JUNO.md:2522`) and leaks later edits into timestamp-resolved shares (M31). Instead:

- **Working head** (`ArtifactHead`, one row per artifact). Bursts of hand edits and transactions land here. It carries `baseVersion` and a `revision` that every editor sends as its compare-and-swap key: the existing transaction protocol, moved off version rows. **It is not change-captured per gesture** (§3.4). Open editors receive head updates over the artifact's SSE channel.
- **Sealing** turns the head into an immutable `ArtifactVersion`:
  - after 90 s idle (inside R-005's 60 s–2 min band);
  - on close or blur of the last editor;
  - before any Juno turn reads the artifact, so Juno always patches a sealed base;
  - on Share or Publish;
  - on restore;
  - before a bulk operation (more than 60 operations);
  - on Name version.

  A seal is the only write the sync feed sees.
- **Every model apply and every restore appends a version.** Restore seals the head first and never rewinds (M10).
- **Branches.** `branchId` (null = main) and `parentVersion` on the version. `currentVersion` is main's newest *complete* version. Try again, edit-from-earlier and oversized AI changes land on branches (R-029). Branch words in the UI are "Try 2", "Use this" and "Keep both", never branch, PR or merge.
- **Published pins.** `Share.versionId` points at an immutable version. The public page resolves that id, never a timestamp. Backfill is in §3.3.
- **Retention.** Named, published, commented and branch-head versions are never pruned. Unnamed autosave seals fold under "12 autosaves" in the UI and are pruned per plan after 30 days (X-33; the owner sets the numbers, §14.2 D14).

### 2.6 Provenance

Every version records the following. The version popover shows it as "How this was made" (R-073).

- `authorKind`: `MODEL`, `USER`, `RESTORE`, `AGENT` (a Work run), `IMPORT` or `MERGE`;
- `authorUserId` and `model`;
- `messageId`, the turn that produced it, with "View in conversation";
- `runId` for Work;
- `provenance[]`: sources, files and connectors used;
- `validation` for exports;
- `complete`, `label` and `note`.

`origin` stays on the wire for old clients and is derived from `authorKind`. Sync starts carrying it (L6).

### 2.7 Trash

- `Artifact.deletedAt` and `deletedById`. Purge runs at 30 days by a job that deletes versions **before** the artifact inside one transaction, so the version tombstones can still resolve the owner. That closes the "uncertain" cascaded-tombstone question in `00` §7.2.
- UI: the toast "Moved to Recently deleted · Undo" (6 s); a "Recently deleted" list at the foot of Artifacts home, reusing `LibraryBrowser`'s deleted view (`library-browser.tsx:59`); "Delete now" behind a destructive confirmation.
- Mac: ⌘⌫ with `NSUndoManager`. iPhone: swipe, then an Undo snackbar (R-006).

### 2.8 The type registry

One source, `src/lib/artifact-kinds.ts`, generated into Swift (like the tokens) and into the OpenAPI enum. A test binds it to the Prisma enum (R-008). It replaces four web glyph maps, three web label vocabularies and three Swift naming tables (`00` §5). **The rule for a new kind:** it exists only when the document root or the way it is consumed differs. Draw, Prototype, Motion, Inspect and Present are **modes**, never kinds.

| Kind (UI noun) | Storage (`ArtifactType`) | Body | Editor and modes | Runtime | Streaming renderer | Picture (thumbnail/poster) | Exports | Comment anchor | Roles | Capabilities | Phone v1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Design** | `DESIGN` | `DesignDocument` JSON (pages → frames), assets external | `DesignEditor`: Design · Prototype · Motion · Inspect, plus Play | `render.ts` plus the one motion runtime (R-019) | Operations as NDJSON into a preview layer; frame outlines first (R-033) | `renderPageSvg` of the cover frame at `posterTimeMs` | PNG ×1/2/3, SVG, PDF, HTML prototype, React, SwiftUI, tokens, JSON, handoff bundle, video/GIF (P2) | `{pageId, frameId, nodeId, dx, dy, region?}` or `{animationId, timeMs}` | View, prototype-view (P2), comment, edit | comments, play, tweaks, embed, lint | View, Play, comment, tweaks, text edits (§6.7) |
| **Deck** | `DECK` (new) | `DesignDocument` with `profile: "deck"`: a Slides page of 1920×1080 frames, sections, `speakerNotes` | The same editor in the deck profile: slide strip, Slide and Animate panels; ⇧D reveals full design rails (R-059) | Motion runtime; Present = Play | Slides appear as outlined 16:9 frames, filled in order | Slide 1 | PPTX (native text boxes and shapes; magic listed as unsupported), PDF, PNG per slide | `{slideId, elementId, x, y}` | View, comment, edit | comments, present, notes, embed | View, Present, comment, reorder and hide slides |
| **Doc** | `MARKDOWN` now; `DOC` (block JSON with tabs) in Phase 5 | Markdown, then blocks with stable ids | Block editor at the reading measure: Read · Edit, `/` inserts, tabs as a menu docked and an outline in the window (R-058) | Prose renderer, Mermaid, charts | Skeleton of pending sections, each with its intent, filled in reading order (Claude Docs contract) | Title plus about 8 typeset lines | .docx, .pdf, .md via **one** OOXML renderer | `{quote, prefix, suffix}`, then `{blockId, range}` | View, comment, edit | comments, charts ("Last refreshed") | View, comment, edit text |
| **Page** | `HTML`, `REACT` (runtime variant) | Single file; a multi-file Site bundle in Phase 5 | View · Code · Console, plus a mode bar V/T/D/C (R-037) and a properties rail (R-044) | Preview origin sandbox (R-012) | Hidden second iframe re-rendered at structural checkpoints; cross-fade only on success | Headless 1280×800 capture on the preview origin | .html, .zip, "Build it with Juno Code" | `{cssPath, xpath, textQuote, point%}` | View, comment, edit | comments, tweaks (CSS props), ask/store (R-076, P2) | View, interact, comment |
| **Code** | `CODE` | Source plus a language | Code editor; Console for JS/TS/Python | JS console, Pyodide | Stream tail | Highlighted excerpt | Source file | `{startLine, endLine, contentHash}` | View, comment, edit | run | View |
| **Diagram** | `MERMAID` | Mermaid source | Preview · Source | Mermaid (pinned, bundled on native) | Re-render per closed statement | The diagram itself | SVG, PNG, .mmd | region | View, comment, edit | — | View |
| **Graphic** | `SVG` | SVG | Preview · Source | Sandbox, scripts off | Re-render at closed top-level elements | The drawing | SVG, PNG | region | View, comment, edit | — | View |
| **Image** | not an Artifact row: indexed `Attachment` with `origin: "generated"` (R-092) | Bytes | Image viewer, and image actions on Design image layers | — | Placeholder, then pixels | The image | PNG, JPEG, WebP | point | View, comment | — | View, comment |
| **Sheet** | `SHEET` (new, Phase 5) | Cell spec JSON (the Work spreadsheet spec, finally persisted) | Grid viewer, the existing windowed preview with number formats fixed; Ask; light cell edits in Phase 5+ | — | Rows stream in | Top-left 12×8 cells, typeset | .xlsx, .csv | `{sheet, cellRange}` | View, comment, edit | — | View |
| **Design system** | `DESIGN_SYSTEM` (new, Phase 5) | Tokens (DTCG), text, effect and motion styles, components as scene nodes, README, assets | Review screen: palette with contrast pairs, specimens, component grid, "Used by 12"; components open in the Design editor (R-051) | — | Sections fill in | The cover (palette plus type specimen) | DTCG JSON, CSS variables, Swift constants, DESIGN.md | node or token | View, edit (admins may lock) | install, publish, default | View |
| **File** | `FILE` (new, Phase 5) | Binary-backed versions (`storageKey`, `contentHash`) | Quick Look-style viewer | — | — | First page, via the existing attachment thumbnailer | Original bytes | page and point | View, comment | download | View, download |

Kind notes:
- **Deliverable kinds map onto these** (§11): `document` → Doc, `presentation` → Deck, `spreadsheet` → Sheet, `report` → Doc, `site` → Page (Site bundle), and `pdf`, `bundle`, `archive`, `image` → File.
- **Research reports become one Doc per run.** This ends the fixed `research-report` identifier collision (`route.ts:220-240`).
- **Each registry entry also records:** id, noun, plural, glyph (an `AppIcons` key plus its one `data-motion`), `newLabel`, lazy `Viewer` and `Editor` imports (so the design editor chunk loads only for Design and Deck, §12), the thumbnail strategy, exporters, the comment-anchor codec, share roles, the phone contract, and **the model's authoring section**, Juno's equivalent of a type's `SKILL.md`. That section is loaded only for kinds in play or armed (R-008, R-028).
- **Unknown kinds.** Any client that meets a kind it does not know renders the poster, "Artifact", and "Open on the web" (R-001).

### 2.9 Juno Design stays the product name

"Juno Design" remains the name of the editor family (Design, Deck and Design system share the scene engine) in help, marketing and ⌘K. In the product chrome the kind is "Design". The `JunoDesign` glyph becomes the Design kind's glyph in New, chips and headers. It no longer marks a destination, because Design no longer is one (ICONS_AND_MOTION §1.4 lets the mark move).

---

## 3. Data model and migrations

### 3.1 Prisma changes (expand first, contract later)

```prisma
enum ArtifactType {
  HTML
  REACT
  CODE
  MARKDOWN
  SVG
  MERMAID
  DESIGN
  // v2 kinds. Appended, never reordered. Rows are created only behind
  // `kinds_v2` and the per-account client gate (§3.5 step 6).
  DECK
  DOC
  SHEET
  DESIGN_SYSTEM
  FILE
}

enum ArtifactAuthorKind { MODEL USER RESTORE AGENT IMPORT MERGE }
enum ArtifactRole       { VIEWER COMMENTER EDITOR }
enum TitleSource        { MODEL USER }

model Artifact {
  id                  String        @id @default(cuid())
  userId              String        // NEW: owner. Nullable in M1, backfilled, then required in M3
  projectId           String?       // NEW: home folder
  conversationId      String?       // CHANGED: made-in; nullable, onDelete SetNull
  createdInMessageId  String?       @map("messageId") // RENAMED in code only; provenance, never a delete key
  identifier          String
  title               String
  titleSource         TitleSource   @default(MODEL)
  type                ArtifactType  // immutable per id
  language            String?
  currentVersion      Int           @default(1)  // newest COMPLETE version on main
  coverNodeId         String?       // "Set as thumbnail"
  posterTimeMs        Int?
  designSystemId      String?       // installed Design system artifact
  designSystemVersion Int?
  derivedFromId       String?       // Duplicate / Turn into…
  derivedFromVersion  Int?
  byteSize            Int           @default(0)  // current body; quotas and the 80% note (R-064)
  deletedAt           DateTime?
  deletedById         String?
  createdAt           DateTime      @default(now())
  updatedAt           DateTime      @updatedAt

  user         User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  project      Project?      @relation(fields: [projectId], references: [id], onDelete: SetNull)
  conversation Conversation? @relation(fields: [conversationId], references: [id], onDelete: SetNull)
  message      Message?      @relation(fields: [createdInMessageId], references: [id], onDelete: SetNull)
  versions     ArtifactVersion[]
  head         ArtifactHead?
  threads      ArtifactThread[]
  comments     ArtifactComment[]
  grants       ArtifactGrant[]
  proposals    ArtifactProposal[]
  exports      ArtifactExport[]
  shares       Share[]

  @@unique([conversationId, identifier])   // NULLs are distinct in Postgres: hand-made rows never collide
  @@index([userId, deletedAt, updatedAt])
  @@index([projectId, deletedAt, updatedAt])
}

model ArtifactVersion {
  id            String             @id @default(cuid())
  artifactId    String
  version       Int                // global per artifact, across branches
  content       String             @db.Text   // "" when storageKey is set
  storageKey    String?            // bodies > 256 KB, and FILE bytes
  contentHash   String?            // sha256; the poster cache key
  byteSize      Int                @default(0)
  origin        String?            // kept for old clients; derived from authorKind
  authorKind    ArtifactAuthorKind @default(MODEL)
  authorUserId  String?
  model         String?
  messageId     String?            // the turn that produced it (SetNull)
  runId         String?
  branchId      String?            // null = main
  parentVersion Int?
  complete      Boolean            @default(true)
  label         String?
  note          String?
  provenance    Json               @default("[]")
  validation    Json?
  createdAt     DateTime           @default(now())

  artifact Artifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  message  Message? @relation(fields: [messageId], references: [id], onDelete: SetNull)

  @@unique([artifactId, version])
  @@index([artifactId, branchId, version])
}
```

Two notes on this schema:
- `@map("messageId")` renames the field in code with no column rewrite. It also stops anyone treating it as a delete key by reading its name.
- `ModerationFlag.userId` becomes nullable with `SetNull` and gains `artifactId?` and `shareId?`, so a flag survives account deletion (X-31). `Message` gains `artifactScopeId String?` (§2.3).

### 3.2 New tables

| Table | Key columns | Change-captured? | Why |
|---|---|---|---|
| `ArtifactHead` | `artifactId` PK, `baseVersion`, `revision`, `content`, `dirtySince`, `updatedById` | **No.** Seals are captured instead | The working head (§2.5); no fold-per-gesture sync storms (X-30, `02` §3.3) |
| `ArtifactThread` | `artifactId`, `userId`, `conversationId`; unique (artifact, user) | No (derived from the conversation) | Per-person threads (§2.3) |
| `ArtifactProposal` | `id`, `artifactId`, `baseVersion`, `baseRevision`, `authorUserId`, `messageId`, `kind: PATCH\|OPS\|REWRITE`, `payload`, `summary`, `stats`, `status: PENDING\|APPLIED\|DISCARDED\|STALE\|FAILED`, `branchId?`, `hunks` | No; fetched with the thread and pushed over SSE | Proposals survive reloads and reach the Mac and iPhone (§8) |
| `ArtifactComment` | as R-040: `threadId`, `parentId`, `authorId`, `body` ≤ 4 KB, `images[]`, `anchor` JSON, `createdOnVersion`, `snapshotKey`, `resolvedAt/By`, `deletedAt`, `toJuno`, `sentAt`, `junoTurnMessageId`, `producedVersion` | **Yes**, as `artifact_comment` | Comments outside the body (owner Q5) |
| `ArtifactGrant` | `artifactId`, `principal` (user, pending email or project), `role`, `grantedBy`, `acceptedAt`, `expiresAt` | **Yes**, as `artifact_grant` | People access (R-039) |
| `ArtifactPin` | `userId`, `artifactId`, `position` | **Yes**, as `artifact_pin` | Starred and sidebar Pinned (R-075) |
| `ArtifactOpen` | `userId`, `artifactId`, `openedAt` (throttled to 1/min) | No | Recents, and presence phase 1 (R-074) |
| `ArtifactExport` | `artifactId`, `version`, `format`, `storageKey`, `contentHash`, `validation` | No | Derived Office/PDF files cached per version (§11) |
| `ArtifactAsset` | `id`, `userId`, `contentHash` (unique per user), `mime`, `bytes`, `w`, `h`, `storageKey` | No | External assets instead of 96 KB data URLs (R-064); capability-scoped URLs for public renders (`00` §12.7) |
| `ArtifactPoster` | `artifactId`, `version`, `frameId`, `width`, `format`, `storageKey`, `contentHash` | No | Poster cache index (R-014) |
| `Share` (changed) | `+ versionId`, `mode: PUBLISHED`, `suspendedAt`, `suspendedReason`, `expiresAt`, `opensIn: CANVAS\|PLAY`, `allowCopies`, `reservedAt` (Unpublish keeps the token) | Already captured | Pinned publish (R-015) |
| `ShareViewDaily` | `shareId`, `day`, `views`, `uniques` (bots and owner excluded, no IPs) | No | Views off the sync path (`share.ts:156-158`) |
| `ModerationReport` | `shareToken`, `reason`, `detail`, `status`, `createdAt`, `reporterHash` | No | Report link (R-011) |
| `SyncClient` | `userId`, `deviceId`, `platform`, `build`, `features[]`, `lastSeenAt` | No | The per-account client gate (§3.5) |
| `WorkArtifact` (changed) | `+ artifactId?` (the typed artifact that now backs it); `WorkArtifactVersion + specKey?` | Existing `work_*` | Persist the spec now; move to option B later (§11) |

### 3.3 Backfills

| # | Backfill | How | Risk |
|---|---|---|---|
| B1 | `Artifact.userId`, `projectId` | `UPDATE "Artifact" a SET "userId" = c."userId", "projectId" = c."projectId" FROM "Conversation" c WHERE c.id = a."conversationId"`, batched by id range | None; every row has a conversation today |
| B2 | `authorKind` from `origin` | `generated` → `MODEL`; `edit` → `USER`; `restore` → `RESTORE`; `null` → `MODEL`. **Exception:** v1 of a DESIGN whose conversation has zero user messages (the `/api/design` holder chats, `api/design/route.ts:69-90`) → `USER` | The exception needs a join on message count; run offline |
| B3 | `ArtifactVersion.messageId` | v1 = `Artifact.messageId`. Later versions stay null ("Earlier version · turn unknown"): message bodies are encrypted, so a SQL match is impossible | Honest gap |
| B4 | Holder chats | Detach designs from conversations that have zero user messages and a title of "Untitled design" (`conversationId` → null), then delete those conversations. **Only after M2's trigger change** (§3.5) | Must run after the owner lookup no longer needs a conversation |
| B5 | `Share.versionId` | `max(version) WHERE createdAt ≤ snapshotAt`. For DESIGN shares, set `needsReview`: fold rewrites leave no trace, so leakage can't be proven either way (M31). The owner sees a one-time note: "This link now shows v5 exactly as it was published" | Some DESIGN links may show a slightly earlier state than the last leaked fold |
| B6 | Oversized bodies | Versions > 256 KB move to object storage (`storageKey`, `content = ""`). Run owner Q9's read-only count first | Keeps native payloads bounded (X-09) |
| B7 | `DesignDocument.comments` | To `ArtifactComment` rows (expected near zero; no operation writes them, `types.ts:738-752`) | — |
| B8 | Posters | A job renders current-version posters, newest-updated first, rate-limited; failures leave a typed placeholder (R-014) | Load; run off-peak |
| B9 | `ArtifactThread` | One row per artifact with a conversation: `(artifactId, userId, conversationId)` | — |
| B10 | `WorkArtifact.artifactId` | None until Phase 5 (§11) | — |

### 3.4 Sync and native contract changes

- **Owner resolution in the change trigger.** `juno_record_account_change` currently resolves an artifact's account **through its conversation** (`migration 20260815180000:52-54`: `… FROM "Artifact" a JOIN "Conversation" c …`), and `Artifact` itself is captured with the `'conversation'` parent. **Making `conversationId` nullable without changing this silently removes detached artifacts from every device's sync.**
  - M2 rewrites the `'artifact'` branch to `SELECT "userId" FROM "Artifact"`.
  - M2 re-creates the `Artifact` trigger with the `'direct'` resolver.
  - `sync-entities.ts:227-260` authorises by `artifact.userId` instead of `artifact.conversation.userId`.
- **Payload diet.** `artifact_version` entities carry metadata, plus the body only when the version is current **and** 256 KB or smaller. Other bodies carry `bodyRef` and are fetched from `GET /api/artifacts/{id}/versions/{v}`. Old clients that do not send `X-Juno-Sync-Features: artifact-body-refs` keep full bodies through `/api/v1/entities`, which tailors per request. The head is never synced (§3.2).
- **New entity types**: `artifact_comment`, `artifact_grant` and `artifact_pin`. `NativeSyncAPIClient.entityTypes` **throws** on unknown types and ends syncing for the account on that device (`NativeSyncAPIClient.swift:140-175`). The strings therefore ship in native release N, and the triggers that emit them are applied only after N is the oldest build seen in `SyncClient` for 30 days. This is the rule the Work entities already followed. The same applies to `desktop-electron/src/main/sync/types.ts` if that client still ships.
- **Kinds.**
  - OpenAPI `ArtifactKind` (`juno-native-v1.yaml:1866-1868`) gains DESIGN and every v2 kind, marked `x-extensible-enum`.
  - Generated Swift decodes into `enum ArtifactKind { case known(Kind), unsupported(String) }`.
  - The store skips and flags oversized or corrupt rows instead of failing the snapshot. The Liquid Glass branch already does this for the Mac (errata §6.5); the iPhone must ship the same package change.
- **DesignDocument on native.** Generate Swift from `contracts/design/design-document.v1.schema.json`, or carry unknown fields as opaque JSON, so a newer field is never stripped again (X-14). Bump `schemaVersion` for every model change from now on (`00` §3.1, 08-15).
- **Structured stream events replace tag parsing on native.** SSE gains `artifact.birth`, `artifact.skeleton`, `artifact.ops`, `artifact.block`, `artifact.chunk`, `artifact.proposal` and `artifact.done`. Native renders these and retires the Swift twin of the tag parser (`NativeMessageContent.swift:281-336`), which carries the same edge-case bugs (`01` §8 #5). Tags remain the model-side transport (§8.3).
- **Offline writes.** Native design and doc edits queue as transactions keyed by `(artifactId, baseRevision)` and replay through `/transactions` on reconnect. They never go through the whole-document generic POST again (X-15, R-065).

### 3.5 Ship order (the load-bearing part)

| Step | What | Gate before the next step |
|---|---|---|
| **1. Native N (tolerant)** | Mac and iPhone point releases **from main**. The glass branch's store change (skip unknown kinds and oversized rows) is ported to `JunoChatKit` on main, because the Liquid Glass redesign ships only when all its phases are done and this cannot wait for it. Contents: `.unsupported` kinds; skip bad rows; decode `userId`, `projectId`, `deletedAt`, a nullable `conversationId` and the new version fields as optional; allowlist `artifact_comment`, `artifact_grant`, `artifact_pin`; send `X-Juno-Client`/`-Features` headers; generated `DesignDocument` or opaque unknowns; bundle hash gated (X-19) | N on ≥ 95% of devices active in the last 14 days (`SyncClient`) |
| **2. M1 (additive)** | Add every column and table nullable; code tolerates null `conversationId` on every read path; serializers emit new fields | Deploy; no behaviour change |
| **3. M2 (owner by userId)** | B1 backfill; rewrite trigger owner resolution; sync loaders use `userId`; B9 threads | Parity check: account change counts per account equal before and after on a staging copy |
| **4. B-behaviour** | Edit and regenerate never delete (merge `7243613f`); same-id re-emit; conversation delete detaches (flag `artifact_detach`); soft delete and trash; `complete` flag; heads replace folding | Lint: no `artifact.delete`/`deleteMany` outside the purge job |
| **5. M3 (contract)** | `userId` NOT NULL; B4 holder-chat cleanup; B5, B6 | Staging dry run on a production snapshot (owner Q9 SQL first) |
| **6. New entities live** | Comment, grant and pin triggers applied | Step 1's build is the oldest seen in 30 days |
| **7. New kinds** | `kinds_v2` per account: the server creates DECK, DOC, SHEET, DESIGN_SYSTEM or FILE rows only when every device seen for that account in 30 days reports `features ⊇ kinds-v2`; otherwise it falls back to MARKDOWN or DESIGN | Telemetry: `unsupported_kind_seen` stays near zero for 14 days |

**Rollback.** Every schema step is expand-then-contract. Up to step 5, reverting code leaves harmless nullable columns. Detached rows (null `conversationId`) remain readable by the reverted code only if step 2's null tolerance stays, so step 2's code is never reverted. After step 5, rollback is forward-fix only. The trash and detach behaviours sit behind `artifact_detach` and `artifact_soft_delete`, and turning them off reverts to "keep", never to "hard delete".

### 3.6 One write service instead of five write paths

Five write paths reach one table today (`00` §4.6). They collapse into `src/lib/artifacts/write.ts`:

```
propose(artifactId, base, {patch | ops | rewrite | body}, author) → ArtifactProposal
apply(proposalId | inline, actor)   → head or version (per-kind validator, compare-and-swap, size check after expansion)
seal(artifactId, reason)            → ArtifactVersion
restore(artifactId, version, actor) → seal + append
create(kind, spec, home, actor)     → artifact + v1 (or a drafting head)
```

- Every write validates **per kind**. A DESIGN body sent to the generic `POST /api/artifacts/[id]` is decoded and routed to operations, never stored raw (`00` §3.2 #2).
- `origin: "restore"` from a client can no longer force a checkpoint (X-33).
- The legacy routes (`/api/design/*`, the generic POST and `/api/design/[id]/edit`) become thin adapters until native builds stop calling them. Then they are removed.

---

## 4. Information architecture and navigation

### 4.1 Nouns (one per object; R-008 vocabulary)

| Noun | Means | Never |
|---|---|---|
| **Artifacts** | The place, and anything Juno or you made | "Outputs", "Canvas library", "Documents" |
| **Design · Deck · Doc · Page · Code · Diagram · Graphic · Image · Sheet · Design system · File** | Kinds | Wire words ("DESIGN", "MARKDOWN") in UI |
| **Panel** | The side surface in a conversation | "Canvas" (reserved for the design drawing surface) |
| **Chat** (pane) | The artifact's thread, shown in the full window | "Thread" in UI (a doc word only) |
| **Share** / **Publish** | People / the public web | "Copy link" as the primary button |
| **Made here** | The per-conversation list (formerly Outputs, R-079) | "Outputs" |
| **Recently deleted** | Trash | "Archive" |
| **Pin** | Keep in the sidebar | "Star" appears only as the Starred scope in the home |

### 4.2 Web sidebar

```
Chat sidebar (after)                       Code sidebar (after)
  Juno                                       Juno
  Chat | Code                                Chat | Code
  + New chat                                 …
  Search                                     Artifacts          ← stays in Code (M27)
  Library                                    Customize
  Projects                                   Pull requests
  Artifacts                                  More
  More
  ── Needs you · 2   (only when non-empty)   ── sessions …
  ── Pinned
       Launch            (project)
       Pricing redesign  (chat)
       Q3 pipeline  Deck (artifact; the kind word is its one trailing signal)
  ── Recent …
```

- **Design row:** removed. For one release it becomes a pointer row, "Designs now live in Artifacts", which opens `/artifacts?type=design`. Then it goes. This amends TWO_PRODUCTS §3's list; record it in `OPEN_DECISIONS.md` (R-018) and answer REWORK_PLAN Q6: Design survives as a kind.
- **Pinned** becomes one fold that mixes projects, chats and artifacts in the order the reader pinned them. Artifact rows are text on the panel (PREMIUM rule 3), with no glyph (rule 4: glyphs mark destinations, not documents).
- **Needs you** gains artifact rows: comments, access requests, "Your deck is ready" (R-042). It is still a fold, never an inbox (TWO_PRODUCTS §2.2).

### 4.3 Artifacts home (`/artifacts`)

- **Header:** "Artifacts" (the page opens with its name, rule 15). Trailing: **+ New ▾** (the one primary) and a List/Grid IconSwap.
- **Controls row:**
  - server search, debounced 200 ms, over titles and **current** bodies (a `tsvector` on the current body only, §12);
  - scope: Everything · Recents · Starred · Shared with me · Published · In project ▸;
  - sort: Last opened · Last edited · Created · Name, remembered per scope on the server.
- **Kind chips with counts:** All · Designs · Docs · Decks · Pages · Diagrams · Code · Images · Sheets · Design systems · From tasks. A chip shows only when its count is at least 1, except the first five.
- **Grid tile:**
  - a 4:3 poster from R-014, with glyph, noun and title, never colour alone;
  - one meta line: kind (under All only) · time, or "Public";
  - a 12 px globe when published;
  - a quiet Play glyph when the design is interactive.
- **List row:** a 40×28 poster, the title and one trailing signal.
- **Row menu:** Open · Open in conversation · Pin · Rename · Duplicate · Share… · Move to project ▸ · Delete.
- **Paging and bulk:** cursor pages of 50 and bulk select, both through the `/api/library` machinery (`00` §8 #10). **Recently deleted** sits at the foot.
- **Union list:** Artifacts, `WorkArtifact` rows without an `artifactId`, and generated `Attachment`s are listed together. Each source is queried with the same keyset `(sortKey, id)` at a limit of N+1, the results are merged, and the cursor is composite, one position per source. There is no new index table.
- **Empty state:** one muted glyph, one sentence ("Things you make with Juno land here"), New, and a row of six templates (R-027).
- **`/design`'s four presets** stay pinned above the grid for 60 days when `?type=design`.

### 4.4 Projects are folders for objects

- The project page gains a **Made** section that reads `GET /api/artifacts?projectId=` (fixing X-21's `res.artifacts` vs `items` mismatch and the unscoped fetch).
- Artifacts started in a project inherit it. "Move to project" is in every row menu and in the ⋯ menu.
- `ProjectMember.role` becomes a validated enum (`OWNER | EDITOR | COMMENTER | VIEWER`), and project membership is the "Inherited" grant (§9.1).
- On the Mac, the glass plan's Projects detail segments (Overview · Tasks · Sources · Settings) gain **Artifacts**.

### 4.5 Library vs Artifacts

| | Library | Artifacts |
|---|---|---|
| Holds | Files you brought: uploads, project sources, knowledge documents | Things made in Juno: by Juno, by you in Juno's editors, by tasks |
| Generated images | Not listed (they are made things) | **Images** chip, by reference; still `Attachment` rows (R-092) |
| Deliverables | Not listed | **From tasks** chip (option A), then native kinds (option B) |
| Composer "Add from…" | Library tab (files) | **Made** tab: attaches a reference chip pinned to its version at send (R-075) |

This settles REWORK_PLAN's "fold Artifacts into Library" against TWO_PRODUCTS' three siblings (owner Q2). **Recommendation: two siblings, split by origin: made vs brought.** Design is folded in as a kind, not kept as a third sibling.

### 4.6 Search and ⌘K

- Search results for artifacts open `/a/{id}?v=` (honouring M28; update `tests/unified-search.test.ts:530-534`).
- ⌘K lists artifact titles plus New design, New doc, New deck and New page (L34).
- With an artifact focused, ⌘K leads with "In this design" actions and ends with "Ask Juno: <query>" (R-091).

### 4.7 Mac, on the Liquid Glass navigation

The glass plan's shell stays: one `NavigationSplitView`, the system sidebar, the stable toolbar, `TrailingDock`, and glass only in its five places. The merge changes four things.

1. **Sidebar nav block:** New chat · Library · Projects · **Artifacts** · More. **Do not ship the `Design` row** that glass §2.1 adds. Keep `DesktopDestination.design` decodable for state restoration, routed to `.artifacts` with the Designs filter. This is a request to the glass session to amend §2.1, §9 (the Design page row) and the File ledger. Its own note already says Design's redesign is out of scope.
2. **Artifacts page** (glass Phase 4, on `JunoPage`):
   - `JunoSegmented` kind filter with counts, search, sort, and View › as Grid / as List (not ⌘1/⌘2, which switch Chat and Code, glass §1.4);
   - **New ▾** in place of "New design" (`.bordered`);
   - tiles from the server poster (`R-014`), replacing live `WKWebView` thumbnails;
   - Quick Look on Space, drag-out as promised files, ⌘⌫ to Recently deleted.

   Opening a tile routes to its thread and slides in the dock, as the plan says. ⌥-double-click or ⌘-click opens a **document window** instead (§6.6).
3. **Toolbar:** the glass Outputs button becomes **Made here** (R-079), a popover with create tiles and outputs grouped by kind, deliverables included.
4. **TrailingDock** hosts the native `ArtifactSurface` (title, stepper, Share, ⋯, Expand, Close). It is backed by the stored row, which the glass branch has already done. Expand opens the document window for the same artifact (a Mac window, not a web route) and closes the dock.

**Timing.** The glass redesign ships only when all its phases are done. If Phase 2 of the merge lands on the web first, the pre-glass Mac shell on main gets a minimal point release: the Design footer row (`DesktopSidebarDesignRow`) opens Artifacts filtered to Designs with a "Designs now live in Artifacts" line, and the Design screen's New tiles move to an Artifacts "New design" menu. The full Mac home, dock and document windows arrive with the glass release.

### 4.8 iPhone

- **Drawer:** Artifacts stays a section (`JunoMobileSection.artifacts`) and becomes the home: chips, search, scopes, and a **+** offering Doc and Design. Work stays until the iPhone's own Work-into-Chat pass.
- **In a chat:** a card tap opens the artifact sheet (§6.7).
- **Links:** universal links for `/a/*` and `/share/*` open the sheet. `JunoMobileIntents` gains `openArtifact(id, version, node, comment)` (R-025), and Spotlight indexes artifact titles.

---

## 5. Routes and redirects

### 5.1 URL grammar

```
/a/{id}                         full window (canonical; sign-in and access required)
   ?v={n|latest}                read-only view of version n ("Viewing v5 · Restore as v10 · Back to latest")
   &mode=design|prototype|motion|inspect|view|edit|code|console
   &node={nodeId}&page={pageId}&frame={frameId}&slide={id}
   &comment={threadId}          opens the rail on that thread and frames its anchor
   &branch={branchId}
   &c={conversationId}          the chat the reader expanded from (Chat pane shows it if they can read it)
/a/{id}/play[?flow=&frame=]     Play or Present, full screen
/chat/{c}?a={id}[&v=]           the conversation with the panel open on the artifact
/share/{token}[?play=1&flow=&frame=]   a published snapshot (public, no sign-in; §9.3)
/new/design?preset=phone|tablet|desktop|square|portrait[&describe=…]   /new/doc  /new/deck  /new/page
/artifacts?type=&scope=&project=&q=&sort=
```

### 5.2 Panel and full window share one mount

- **Inside a conversation**, the panel is `ArtifactSurface size="panel"` inside `chat-view`. The URL is `/chat/{c}?a={id}`.
- **Expand** (⌘⇧↩, or the header button) switches `chat-view` into its *window layout*: the transcript folds into the leading Chat pane and the surface fills the stage. It calls `history.pushState(null, "", "/a/{id}?c={c}")`. Next 15 integrates native `pushState` with its router, so the chat page stays mounted and `usePathname` updates. **Back** or **Esc** pops the state, and the layout collapses to the panel with undo, selection and zoom intact (R-016).
- **Loading `/a/{id}` directly** (reload, link, search) renders `app/(app)/a/[id]/page.tsx`:
  - the same `ArtifactSurface size="window"`;
  - a `ThreadPane` that loads the viewer's `ArtifactThread`, or the `c` conversation if the viewer owns it and it references the artifact;
  - the same visual as the expanded chat, so a reload never changes what the reader sees.
- **Closing** the full window from a direct load goes to the thread (`/chat/{thread}?a={id}`) if there is one, else back to `/artifacts`.
- **Every "Copy link"** yields `/a/{id}` (plus `?v`, `node` or `comment` when copied from a version row, a frame or a thread).

### 5.3 Share URLs

- **People with grants** use `/a/{id}` (sign-in; live, follows Latest).
- **Published snapshots** stay at `/share/{token}`, and existing tokens stay valid. The page is an app-origin shell (title, owner line or the unverified footer, Report, legal links). Its content is:
  - Design and Deck: a server-rendered SVG from `renderPageSvg`, with a page switcher and Play;
  - Page: an iframe `src`'d from the **preview origin**, `https://{shareToken}.{preview-domain}` (§9.4);
  - everything else: static rendering.
- **Prototype-only links** are `?play=1&flow=` (R-088, Phase 5).

### 5.4 Redirects

Use **307 during rollout** and switch to **308 after 30 days**, because browsers cache 308s and a rollback would otherwise strand people.

| From | To | Where |
|---|---|---|
| `/design` | `/artifacts?type=design` (presets pinned for 60 days) | `design/page.tsx` → `redirect()` |
| `/design/{artifactId}` | `/a/{artifactId}?mode=design` | `design/[artifactId]/page.tsx` |
| `/chat/{c}?artifact={identifier}&v=` | `/chat/{c}?a={id}&v=` (the server resolves `(c, identifier)`; a missing row shows the "no longer here" state, never a ghost, M21) | `chat/[id]/page.tsx` server component |
| Project `?id={artifactId}` (L27) | `/a/{id}` | project sources list |
| Search `?v=` (M28) | honoured by `/a/{id}` | `search/engine.ts:434` |
| Code-session artifact links (L28) | `/a/{id}` | Code panes |
| `/work/*` | unchanged (`work-url-migration.ts`); native-created sessions gain a conversation target (X-29) | — |
| `/share/{token}` | unchanged; `versionId` resolution | `share.ts` |
| APIs `/api/design/*`, `/api/artifacts/[id]`, `/api/share` | kept as adapters onto the write service (§3.6) until native N+2; DESIGN bodies validated | — |

### 5.5 Native destinations and state restoration

- **Mac.**
  - `DesktopDestination.design` decodes and routes to `.artifacts(filter: .design)`.
  - The Code studio's retired `.design` (`DesktopCodeStudio.swift:34-35`) still falls back to the landing.
  - Document windows are `WindowGroup(for: ArtifactRef.self)` with `NSUserActivity("com.juno.artifact")`, carrying `webpageURL = /a/{id}` plus `v` and `mode`, so windows restore and Handoff to the web or iPhone (R-025, R-068).
  - Links to `/a/*` open the dock when a chat for that artifact is frontmost, else a document window.
- **iPhone.** `apple-app-site-association` covers `/a/*` and `/share/*`. An unknown kind falls back to the web.
- **Web.** The Artifacts home's list/grid and sort are stored on the server per scope (R-018). The panel width stays in local storage.

---

## 6. The unified artifact view

### 6.1 The sizes

| Size | Where | What it can do | Layout law |
|---|---|---|---|
| **Card** | Transcript | A poster at its own aspect ratio (in an `@container`, capped at 320–360 px); "Design · v3"; **two actions at most**: Open and one verb (Play, Copy or Download). A live sandbox mounts only when the card is the newest version, at least 50% visible and the panel is closed (R-024). Earlier turns fold to a one-line **receipt** pinned to their version (R-023) | PREMIUM rules 3 and 6; 32 px segments, 44 px on coarse pointers |
| **Panel** | Beside the transcript when the content column is at least 64rem | Everything in the header (§6.9). The editor runs in its container band: 640–1039 px means the inspector is docked and Layers is a drawer; under 640 px means canvas, contextual bar and sheets (R-017) | Container-sized (rule 11) |
| **Full window** | `/a/{id}` or Expand | **Stage plus two panes:** a leading pane (Chat · Layers · Assets for Design; Chat · Slides for Deck; Chat · Outline for Doc; Chat · Tree for Page) and a trailing pane (Inspector or Comments). ⌘\ toggles both panes | **Reading of rule 2:** the object is the stage, and at most one leading and one trailing pane flank it; each pane is a tab set, never a third column |
| **Public page** | `/share/{token}` | A static render or Play; unverified footer; Report | Reading measure; one primary action |
| **Phone** | iPhone sheet; web below 50rem | View, Play, comment, Ask, tweaks, text edits; everything else is stated as desktop-only in one line | 44 pt targets; sheets on `ease-drawer` |
| **Picture-in-picture** (P2) | Top right of the transcript | Only for live things (a playing prototype, a presented deck, a streaming generation) when the reader scrolls away mid-run | 320×200; docks back into its card at the end |

### 6.2 Wireframe A: conversation with the panel (web, 1440 wide)

```
┌─ sidebar 304 ────┐┌─ chat column ─────────────────────────────────────┐┌─ panel · 46% (min 400) ──────────────────────────────────┐
│ Juno             ││ Pricing redesign ▾                 Made here 3   Share  ││ Pricing page  Design   ‹ v4 ›   Design ▾   Share  ⋯  ⤢  ✕ │ 44px
│ Chat | Code      ││                                                     ││──────────────────────────────────────────────────────────│
│ + New chat       ││  You  design a pricing page for a notes app         ││   ┌─────────────── Desktop 1440 ───────────────┐          │
│ Search      ⌘K   ││                                                     ││   │ Simple pricing        [ Annual | Monthly ] │          │
│ Library          ││  Juno  Three tiers with an annual toggle. I kept    ││   │ ┌ Free ─┐  ┌ Pro ───┐  ┌ Max ───┐         │          │
│ Projects         ││        the CTA in the secondary style.              ││   │ │ $0    │  │ $8     │  │ $16    │         │          │
│ Artifacts        ││   ┌──────────────────────────────────────┐          ││   │ └───────┘  └────────┘  └────────┘         │          │
│ More             ││   │ [ poster 16:10 ]                     │          ││   └────────────────────────────────────────────┘          │
│                  ││   │ Design · Pricing page · v4           │          ││                                                          │
│ Needs you · 1    ││   │ Open                          Play   │          ││     ┌ Hero ──────────────────────────┐  ← selection      │
│  Pricing · 2 cmts││   └──────────────────────────────────────┘          ││     │ Aa  Inter 48  ●  ≡  │ Ask  Comment ⋯ │  contextual  │
│ Pinned           ││   ‹ Updated Pricing page · v2 · latest is v4 · Open v2 ›  ││     └────────────────────────────────┘  bar (<640px)    │
│  Launch          ││                                                     ││                                                          │
│  Q3 pipeline Deck││  ┌ Looking at: Pricing page · v4 · Hero  × ┐        ││   V  ▢  ○  ╱  T  Img  C  D              Fit  100% ▾      │
│ Recent           ││  ┌───────────────────────────────────────────────┐ ││──────────────────────────────────────────────────────────│
│  …               ││  │ Ask about Hero, or select layers…         ⏎   │ ││  Open full window for layers and inspector   ⌘⇧↩     × │ one-time hint
└──────────────────┘│  └───────────────────────────────────────────────┘ │└──────────────────────────────────────────────────────────┘
                    └───────────────────────────────────────────────────┘
```

- The panel **auto-opens** on the first artifact tag of a turn when the split is at least 50rem, no other panel is open, and the reader has not closed it in this conversation in the last 3 turns (R-033). It never takes focus; `aria-live` says "Juno opened Pricing page".
- The mode control collapses to a menu (`Design ▾`) under 560 px of container.
- The receipt line is text on the panel with no fill until hover.

### 6.3 Wireframe B: full-window Design (`/a/{id}`)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ‹ Pricing redesign   Pricing page  Design  ‹ v4 ›   [ Design | Prototype | Motion | Inspect ]   Play  Comments 2  Shared  ⋯ │ 44px
├─ leading 320 (240–440) ─┬──────────────────────── stage ───────────────────────────────┬─ trailing 280 (200–400) ─┤
│ [ Chat | Layers | Assets ]│                                                              │ Frame · Hero              │
│─────────────────────────│      ┌──────────────── Desktop 1440 ─────────────────┐      │ W 1440  Fill   H Hug      │
│ You  quieter CTA, and   │      │ ┌ Hero ─────────────────────────────────────┐ │      │ Auto layout  ↓  ⋮  ⊞      │
│      tighten the hero   │      │ │ Simple pricing                            │ │      │ Gap  space.6 · 24         │
│                         │      │ │ [ Annual | Monthly ]                      │ │      │ Padding  64 · 64          │
│ Juno ┌────────────────┐ │      │ └───────────────────────────────────────────┘ │      │ Fill  surface.card  ◉     │
│      │ Tightened hero │ │      │  ┌ Free ─┐ ┌ Pro ──┐ ┌ Max ──┐                 │      │ Radius  radius.lg · 16    │
│      │ 3 layers  +1 −0│ │      │  └───────┘ └───────┘ └───────┘                 │      │ Effects                +  │
│      │ Apply  Discard │ │      └───────────────────────────────────────────────┘      │ Animate                +  │
│      └────────────────┘ │           ▫ Juno is working · Laying out 3 cards · Stop     │   Rise · in · base · Soft │
│                         │                                                              │ Component                 │
│ ┌ Hero · +2  × ┐        │                          ┌ Tweaks ─────────────────┐         │   Price card · Used 3×    │
│ ┌─────────────────────┐ │                          │ Accent   ◉ ◉ ◉ ◉        │         │   Go to main   Detach     │
│ │ Ask Juno…        ⏎  │ │                          │ Density  ─────○──       │         │                           │
│ └─────────────────────┘ │   V ▢ ○ ╱ T Img C D                 └─────────────────────────┘    Fit  100% ▾ │                           │
└─────────────────────────┴──────────────────────────────────────────────────────────────┴───────────────────────────┘
  The composer stays pinned at the bottom of the leading pane on every tab, so asking never needs a tab switch.
  With the leading pane collapsed (⌘\), the composer floats bottom-centre over the stage (≤ 680 px), with the last reply as a two-line snippet.
  Comments (C) swaps the trailing pane to the comment rail. Motion (⇧M) docks the timeline under the stage (shared slot: Motion · Variables).
```

**Container bands** (R-017):
- **1040 px and wider:** both panes docked; widths saved to account prefs, not `localStorage`, which the Mac's `.nonPersistent()` store loses.
- **640–1039 px:** the trailing pane stays docked; the leading pane becomes an overlay drawer.
- **Under 640 px:** canvas only, with the contextual bar and sheets. A rail never opens on selection (`03` §8 #16).

### 6.4 Wireframe C: Artifacts home with the New menu open

```
┌─ sidebar ─┐┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ …         ││ Artifacts                                                          [ + New ▾ ]   [ ≡ | ▦ ]    │
│ Artifacts ││ ┌ Search artifacts ───────────────────────┐   Everything ▾    Last edited ▾                   │
│ (selected)││ All 128 · Designs 14 · Docs 31 · Decks 6 · Pages 22 · Diagrams 9 · Code 30 · Images 12 · From tasks 4 │
│           ││                                                              ┌ New ───────────────────┐       │
│           ││ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │ Design               ▸ ├──┐    │
│           ││ │ [poster] │ │ [slide 1]│ │ [doc     │ │ [page    │          │ Deck                   │  │    │
│           ││ │          │ │          │ │  excerpt]│ │  capture]│          │ Doc                    │  │    │
│           ││ └──────────┘ └──────────┘ └──────────┘ └──────────┘          │ Page                   │  │    │
│           ││ Pricing page Q3 pipeline  Launch plan  Waitlist            │ ────────────────────── │  │    │
│           ││ Design · 2 h Deck · Public Doc · 1 d   Page · 3 d          │ From a template…       │  │    │
│           ││                                                              │ Import…                │  │    │
│           ││ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          └────────────────────────┘  │    │
│           ││ │ …        │ │ …        │ │ …        │ │ …        │     ┌ Design ─────────────────────┐ │    │
│           ││                                                          │ Phone      390 × 844        │◄┘    │
│           ││                                                          │ Tablet     834 × 1194       │      │
│           ││                                                          │ Desktop   1440 × 900        │      │
│           ││                                                          │ Square    1080 × 1080       │      │
│           ││                                                          │ Portrait  1080 × 1350       │      │
│           ││                                                          │ Custom…                     │      │
│           ││ Recently deleted · 3                                     └─────────────────────────────┘      │
└───────────┘└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Choosing a New item** opens a small sheet: size (for Design), an optional **Describe it** field, and **Style** (the default design system · Wireframe greys · None) (R-045).
- **Without a description**, one atomic `POST /api/artifacts {kind, preset, projectId?}` creates the object. The reader lands on `/a/{id}` with the collapsed composer strip "Ask Juno about this design…".
- **With a description**, the thread is created with that first turn and the Chat pane opens streaming. Either way, no holder chat is created (M29).

### 6.5 Wireframe D: the Share dialog

```
┌ Share "Pricing page" ──────────────────────────────────────────── ✕ ┐
│ People                                                               │
│ ┌ Add people or emails ───────────────────────┐ [ Can comment ▾ ] [ Invite ] │
│ Who has access                                                       │
│   LM  Liam Magnier (you)                                   Owner     │
│   ›   From Launch · 4 people                               Can edit  │   inherited, collapsed
│   AN  Ana Duarte                                   Can comment ▾     │
│ Link   Only people with access                         [ Copy link ] │   /a/{id}, live (Latest)
│   Let people with access read the conversation that made this   ○    │   off by default (R-073)
│ ──────────────────────────────────────────────────────────────────── │
│ Publish to the web                                                   │
│   ◍ Published · v9 · 3 days ago · v11 has changes   [ Update to v11 ] │
│   ┌ juno.app/share/k7f…9q ───────────────────────┐ [ Copy ]   ⋯      │   ⋯ = Unpublish · Link expires ▸ · View as a visitor · Reset link
│   Opens in  [ Play | Canvas ]            124 views · 81 people · 7 days │   numbers, never a meter
│   Visitors see: Made by a Juno user · not verified by Juno · Report  │
└──────────────────────────────────────────────────────────────────────┘
```

- **Before the first publish,** the section reads "◌ Not published" with a primary **Publish v9**. That opens a sheet stating what becomes visible, including linked Library images, and shows the screening verdict inline (R-011, R-015).
- **Opening the dialog writes nothing** (L5).
- **Until grants ship** (Phase 4), People reads "Only you can open this".

### 6.6 Wireframe E: the Mac (Liquid Glass shell)

```
Main window — chat with TrailingDock (glass plan §1.2; dock 400–60%, opens at 480)
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  ⟨sidebar⟩                  Pricing redesign ▾          [ Made here 3 | Share | Private ]  ← system glass toolbar │
├─ sidebar (glass) ──┬─ chat column (opaque, warm canvas) ─────────────┬─ TrailingDock: ArtifactSurface (opaque) ─┤
│ New chat           │  …transcript…                                   │ Pricing page  Design  ‹ v4 ›  Share ⋯ ⤢ ✕  │
│ Library            │  ┌ card: poster · Design · v4 · Open ┐          │ ┌──────── WKWebView editor ─────────┐     │
│ Projects           │  └───────────────────────────────────┘          │ │   (bundle, surface="window",      │     │
│ Artifacts          │                                                  │ │    setChrome native)              │     │
│ More               │  ╭──────────── composer (glass) ─────────────╮  │ └───────────────────────────────────┘     │
│ …                  │  ╰───────────────────────────────────────────╯  │                                            │
└────────────────────┴─────────────────────────────────────────────────┴────────────────────────────────────────────┘

Document window — ⤢ Expand, ⌥⌘O, ⌘-click a card, or double-click a tile (R-068). A WindowGroup(for: ArtifactRef), restorable
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  Pricing page ▾  v4 ▾   [ Design | Prototype | Motion | Inspect ]   Play   Comments   Share   Juno │ unified toolbar, system glass
├─ leading pane: [ Chat | Layers ] ─┬──────────── stage (opaque) ──────────────┬─ inspector (bundle rail) ───┤
│ native SwiftUI transcript (Chat)  │                                           │ web inspector, docked at    │
│ or the bundle's Layers rail       │        WKWebView design editor            │ ≥1040pt; drawer below       │
│ (bridge setRails leading:)        │                                           │                             │
│ ╭ composer (the glass cluster) ╮  │                                           │                             │
└───────────────────────────────────┴───────────────────────────────────────────┴─────────────────────────────┘
  Juno (⌘⌥C) toggles the leading pane. Layers is chosen in the pane's segmented control, not a third column.
  Plain HStack panes: no second NavigationSplitView and no .inspector (crash notes, glass §0.5; DesktopArtifactCanvas.swift:20-29).
  Menu bar: File › New ▸ Design ⌥⌘N / Doc / Deck / Page; Open in Conversation; Share… ; Publish… ; Export ▸ ; Rename; Move to Project ▸
            Edit › Undo/Redo/Cut/Copy/Paste routed to bridge commands (R-060/R-061); View › Previous/Next Version ⌥[ ⌥]; Play ⌥⌘↩
```

- **Glass budget respected.** No new custom glass sites. Artifact chrome in the document window is the system toolbar. Share, Versions and Made here are system popovers. The ask bar, contextual bar and player bar live inside the web bundle and use the web's `overlay-glass` recipe. Content is opaque on the warm canvas (glass §0.1, §10.2 #1).
- **Saves** autosave through transactions and show the saved tick. ⌘S becomes "Save now" and is never required (R-068). Closing with unsynced edits asks "Close and keep edits on this Mac / Discard / Cancel" (R-065).

### 6.7 Wireframe F: the iPhone sheet

```
Chat, card tapped                    Medium detent (50%)                 Large detent (92%) = the phone's full window
┌───────────────────────┐            ┌───────────────────────┐          ┌───────────────────────┐
│ ‹  Pricing redesign   │            │  ─── (grab)           │          │  ─── (grab)           │
│  …                    │            │ Pricing page      ⋯   │          │ Pricing page  ‹v4›  ⋯ │
│ ┌───────────────────┐ │            │ Design · v4           │          │ ┌───────────────────┐ │
│ │ [poster]          │ │  tap ───►  │ ┌───────────────────┐ │  drag ►  │ │                   │ │
│ │ Design · v4  Open │ │            │ │ [live canvas,     │ │          │ │  pinch, pan,      │ │
│ └───────────────────┘ │            │ │  pinch/pan]       │ │          │ │  double-tap text  │ │
│                       │            │ └───────────────────┘ │          │ │  to edit          │ │
│ ╭ composer ─────────╮ │            │ Play  Comment  Tweaks  Ask │    │ └───────────────────┘ │
└───────────────────────┘            └───────────────────────┘          │ ┌ Hero · Ask Juno… ⏎┐ │ selection bar above keyboard
                                                                        │ Play Comment Tweaks Ask │ 44pt targets
                                                                        └───────────────────────┘
  Long-press 0.4 s + medium haptic → "Comment here". The inspector and layers are bottom sheets (ease-drawer).
  One line where the phone stops: "Resize, auto layout and keyframes are on the web and Mac."
  Designs are read-only until saves go through transactions and adopt remote versions (R-002), then field edits land (R-069 v1).
```

### 6.8 The public page (`/share/{token}`)

- **Header:** the title, then one of two lines: "By Liam Magnier" for signed-in viewers who have a grant, or the footer line for everyone else. Trailing: **Play** when the artifact is interactive, **Make a copy** when `allowCopies` is on for signed-in viewers, and a download when the kind declares one.
- **Body:**
  - Design and Deck: server SVG with a page or slide switcher, and Play through the one runtime (R-019), gated on conformance.
  - Page: a preview-origin iframe.
  - Doc: typeset.
  - Diagram: server-rendered Mermaid.
- **Footer:** "Made by a Juno user · not verified by Juno · Report" plus legal links. Comments are never shown on public pages, and guest comments stay off.

### 6.9 Header anatomy and states (identical at every size)

- **The header is one 44 px row with 16 px gutters** (PREMIUM rules 8 and 12):
  - title, with inline rename and the kind in muted ink;
  - version stepper `‹ v7 ›` (⌥[ ⌥]);
  - an artifact switcher when the conversation made more than one;
  - the mode control, from the registry;
  - Play;
  - Comments with its count;
  - Share, which reads "Shared" with a filled globe when published;
  - ⋯: Open in full window, View in conversation, How this was made, Duplicate, Turn into ▸, Export ▸, Move to project ▸, Move to Recently deleted;
  - Expand and Close.
- **One state machine** is rendered the same way on the card, the panel header and native (R-007): writing (vN+1 over vN) · checking · ready · stopped · refused(reason) · render-failed · stale-head ("Juno updated this while you were editing · Review changes").
  - Copy follows R-007, for example "Writing v4, showing v3" with v3 dimmed to 60%.
  - An expected transition never flashes red. "Source unavailable" (M14) goes away.
- **Failure:** the last good render stays, under "v8 didn't render · Show error · Fix with Juno" (R-035).
- **Unavailable:** the reason plus "Open source", never JSON (X-20).

### 6.10 Juno Design, pushed to Figma-grade where the engine is already strong

The audit rates the engine's breadth "solid": 10 node types, 37 invertible operations, auto layout with grid and wrap, constraints, a 7-kind effect stack including glass, variables with modes, keyframe motion and 7×10 interactions (`01` §2.6). What holds it back is the surface. **Push:**

| Area | Today | Figma-grade target | Backlog |
|---|---|---|---|
| Layout engine | Horizontal Fill overflows; cross-axis Fill wrong; no grid tracks; no baseline (M37) | Correct hug/fill/fixed with min/max; grid tracks (Fixed, Fill fr, Hug) with on-canvas track pills; baseline; negative and auto gap | M37 then R-062 |
| Direct manipulation | Outline-only move; handles flip Hug to Fixed (M51); click-jitter (M52); no marquee in frames (M54) | Live drawing with readouts; padding and gap handles; drag to reorder in auto layout with an insertion bar; ⌘-drag to lift out; Alt-hover distances | R-062 |
| Keyboard and clipboard | No ⌘C/⌘V, no Space-pan; Escape commits (M48) | Figma muscle memory (⇧0/1/2, Enter/⇧Enter, ⇧A, Alt-drag, ⌘R); system clipboard `application/x-juno-design+json` with SVG and PNG fallbacks; Escape always cancels | R-061, R-063 |
| Modes | Design/Prototype tabs; Motion as a separate collapse; no Inspect | One segmented control: Design · Prototype · Motion · Inspect (⇧D, ⇧M); a mode swaps rails, never the canvas | R-026 |
| Components | Copy-on-create; overrides never read (`instances.ts:4-27`) | Live instances `{mainId, overrides}` resolved in layout, render and every exporter; properties first; Go to main, Detach, Reset; "Used 12×"; slots in Phase B | R-048 |
| Variables | Only `fills.0.color` bindable (L43, L44) | Bind every field; type-checked; timing and easing tokens with modes; a docked variables table sharing the timeline slot, never full-screen | R-050 |
| Motion | Absolute x/y tracks (M64); outgoing easing; springs export as ease-out (L20) | Relative transforms with anchor points, incoming easing, holds, duration + bounce springs, presets first | R-049, R-052, R-054 |
| Prototyping | 7 triggers × 10 actions; **no player** (M61) | One runtime and conformance suite (R-019); transitions that run, smart animate by match key (R-055); overlays, scrolling frames, sticky (R-056); **Play** in panel, window and link (R-057) | R-019, R-055–R-057 |
| Inspect and handoff | Handoff bundle with no consumer | Inspect mode (measurement, code for the selection and its motion); "Build it with Juno Code" as the primary export | R-066, R-082 |
| Design system | Per-document only | A Design system kind installed into every kind; lint with one-click token fixes | R-051, R-047 |

**Hold, and say so in one line:** vector networks and boolean operations (a minimal drawing set in R-090 first), multiplayer cursors (async presence first, R-074), shaders (Juno's no-programs-in-scene rule, `types.ts:117-123`; programs live in Page embeds, R-080), and plan-gated basics (`03` §8 #21: safety features and branching on every plan).

---

## 7. Creation and routing

### 7.1 Four ways in, one object

| Way in | What happens | Backlog |
|---|---|---|
| **Ask in any chat** (automatic) | The model decides, as since `22059f90`. The server loads the authoring sections only for kinds in play (open or touched artifacts, or ones the ask names), which shrinks the 238–300 line prompt block (`system-prompt.ts`) | R-008 |
| **Make… in the composer** | `+ › Make…` (registry glyphs): Design (Auto, Phone, Tablet, Desktop, Square), Doc, Deck, Page, Diagram. Picking one arms a pill beside `+` ("Design · Phone ×"), exactly like Deep research (FLAT_UI §4). `/design`, `/doc`, `/deck` and `/page` arm the same pill. The pill sends `outputKind`, and the server forces the kind | R-028 |
| **New** (home, ⌘K, `/new/*`, Mac File › New, iPhone +) | The object is created first; the thread starts on the first Ask (§6.4) | R-027 |
| **Turn into…** (⋯ on any artifact; Made here) | Deck, Doc, Design, Page, Diagram. A new artifact with `derivedFrom {id, version}`; its header reads "From Q3 plan · v4"; "Source updated · Review" runs the update as suggestions | R-078 |

### 7.2 Routing the user can see

- **The kind leads every surface:** "Deck · Q3 pipeline" on the card and panel. The status reads "Making a deck…".
- **Changing the kind:** ⋯ offers "Make this a page instead". The prose never narrates the routing.
- **Opting out:** Settings › Capabilities has per-kind switches (Designs, Docs, Decks) for people who want chat-only answers. This answers the top HN complaint about Claude's merge (`03` §2.3).
- **Model tier by kind and size:** Design, Deck and React turns never go to the cheapest tier (M7, `auto-model.ts:61-66`). Design generation never runs on `qwen3.8-flash` (M41). An artifact above about 30k characters is never revised on an 8,192-token output cap: the turn builds across calls or routes up (R-007).
- **Taste form before a first design** when the ask is underspecified (R-045):
  - inline question kinds in `PreflightClarificationQuestionType`: visual options drawn by `render.ts` from tiny op documents, swatches, fidelity, density, a design-system picker, a reference image;
  - at most 6 questions, each skippable, with "Decide for me";
  - it collapses to one line: "Phone · High fidelity · Warm editorial · Juno DS".

### 7.3 Skeleton first, streaming into the object

1. **Birth.** On the first tag or tool call, the server creates the row with a drafting head and emits `artifact.birth {id, kind, title, intent}`. The card and the auto-opened panel show a typed placeholder after 500 ms: an empty 390×844 outline captioned "Juno is designing…".
2. **Plan.** For Doc, Deck, Design and long Markdown, the model first emits the title plus sections, slides or frames, each with a one-line intent. The server sends `artifact.skeleton`, and pending blocks show the intent in muted ink over a skeleton of the right shape (Claude Docs' contract, `03` §2.3).
3. **Fill, by kind:**
   - **Design and Deck:** operations stream as NDJSON, validated per batch (at most 10 operations or 250 ms) into a preview layer. Frames appear as hairline outlines at their final size, then their children. The camera fits once, when the first frame lands, and never chases the stream.
   - **Doc:** tokens stream into the active block, batched per animation frame; each finished block commits as an operation.
   - **Page:** re-render in the hidden second iframe at structural checkpoints (at most every 600 ms); cross-fade only when the render succeeds; scripts are held to the end.
   - **Code:** the stream tail.
4. **Steering.** While streaming, the placeholder reads "Steer this design…" and Send becomes Steer. Steers queue in the composer's `steering.above` slot (`composer.tsx:155-198`) and apply at the next section boundary.
5. **Done or stopped.** A complete result seals v1 (or vN+1). A stopped or truncated result stays a non-current draft (X-07): "Stopped · Keep what's here · Discard". When a turn would exceed the output budget, the frames or sections are built across calls instead of being truncated (R-033).
6. **The compact grammar retires.** Chat-authored designs become "operations against an empty document", so images, effects, components, tokens and motion become expressible. X-10's image refusal disappears. Until then (Phase 0), `image` is removed from the prompt's grammar so it stops refusing whole designs.

---

## 8. The AI editing loop

### 8.1 What the model reads

Every turn from a thread, or from a conversation with the panel open, carries a **context digest** of each artifact that is open or was touched in the last N turns (R-009):
- id, kind, current version and its `authorKind`;
- the body when it fits; otherwise an id-bearing digest: the DESIGN node tree with node, variable and component ids (`selection-context.ts`), Doc block ids, or Deck slide titles and outlines;
- a motion digest (animations, tracks, interaction edges) and the tweaks manifest;
- a poster PNG for multimodal models (R-031, R-047 #4).

It also carries a **view context** (R-031): `{artifactId, version, view, page/slide/tab, selection (node ids | text range | element path), visible rect, dirty}`, shown to the reader as the removable composer chip ("Looking at: Onboarding · v4 · 2 layers"). A "What Juno sees" disclosure lists exactly what is sent. Form field values are never included.

### 8.2 What the model writes

Three verbs replace "output the complete updated content" (`system-prompt.ts:238-300`):

| Verb | For | Contract |
|---|---|---|
| `create` | New artifacts | Skeleton first (§7.3) |
| `patch` | Code, Markdown/Doc, Page, Diagram, Graphic | At most 12 exact, unique anchors; coverage and growth limits; compare-and-swap on the version the turn read. This is `artifact-edit.ts`, today's one path that works, promoted to the default |
| `ops` | Design, Deck, Design system | Validated, invertible operations from `operations.ts`, plus agent-shaped `query {selector}`, `tree {nodeId, depth}` and `setMany {selector\|ids, patch}`, which the server expands into `updateNode` operations. Never model-written JavaScript |

`rewrite` happens only when the reader asks, or the patch limits are exceeded, and then it lands as a branch (R-029). A rewrite is never streamed as delete-then-retype (`03` §8 #10).

### 8.3 Transport

- **Tags remain the model-side transport** for every provider, because Juno routes to many labs without uniform tool calling. The grammar becomes `<juno:artifact op="create|patch|ops|rewrite" id="…" base="7">`, and `<juno:design-ops>` merges into it.
- **Tool calls** (`artifact_create`, `artifact_read`, `artifact_propose`, `artifact_render`, `artifact_search`) are offered to tool-capable models. The same contract is exposed to Juno Code and to an external MCP server (R-032).
- **One server parser** emits the structured SSE events of §3.4. Clients never parse tags again.

### 8.4 Proposals in the transcript

- **Every Juno change is an `ArtifactProposal`** shown as an **edit card** in the thread: a summary ("Tightened the intro, added Risks"), a size ("+12 −3 lines" or "12 layers changed"), and Apply · Discard. After Apply the card shows Undo. The canvas shows the change with presence and reveal (§10.5).
- **When it applies directly and when it waits** (R-010, R-030):
  - It **applies directly** while Juno drafts a new artifact, or when every version since Juno's last write is Juno's.
  - It **waits for review** once the artifact has `USER` versions since the model last wrote, with a one-time inline note ("You've edited this, so Juno will suggest changes for you to review"). Docs default to suggest.
  - A change above 12 hunks, 60 operations or several pages **lands on a branch** "Juno: <summary>" and opens in Compare.
- **Review is isolated.** While a proposal is pending, the committed document is read-only for canvas, layers and shortcuts (M46). Apply reports failure honestly (M47). Accepted hunks compose into one version; rejected hunks are recorded so the next turn knows.
- **Human wins.** Every model write is a compare-and-swap on the base the turn read. On a 409 it re-reads and retries once. If a block or node a person wrote was touched, the person's version is kept and Juno says so: "You edited the pricing table while I worked, so I kept your version and applied the rest."
- **Guard for design structure:** a proposal that removes animations, tracks or interactions the request did not mention shows "Also removes 2 animations and 3 interactions", with "Keep them" selected (R-009 #5).
- **Undo:** "Undo Juno: <summary>" applies the operation inverses when the head still matches, otherwise appends a restore version. It is one undo entry per Juno change.

### 8.5 One channel

- **Ask Juno merges into the thread.** `ask-juno-bar.tsx` and `/api/design/[id]/edit` stop being a separate experience; their validation (`ai.ts`) becomes the server-side op validator for every design proposal.
- **The on-canvas prompt** (⌘↵, or the ask bar that pops from a selection) keeps its anchored overlay-glass form but **posts a turn into the reader's thread** with `artifactScopeId`. ↩ sends, ⇧↩ queues.
- **Queued asks** stack as chips above the composer, each naming its anchor ("Hero · CTA button"); they send as one targeted-edit turn. Edits to one artifact run serially against the then-current version; edits to different artifacts run at most two in parallel (R-038).
- **Fix with Juno:** a render failure attaches the errors, the console tail and the failing line as a queued ask. The automatic repair is free (R-035, R-036).

### 8.6 Comments to Juno

- **Sending.** "Ask Juno" in a thread footer, or "@Juno" in a reply, sends the comment thread, its anchor, a crop and the version **as a turn in the sender's thread**. The transcript shows a quoted chip, "On Hero · v11: Make the CTA quieter", which links back to the pin. "Send 3 to Juno" batches selected threads.
- **Answering.** Juno answers as a proposal. On Apply, the version records `producedVersion`, and Juno replies **in the comment thread**: "Done in v12: the CTA now uses the secondary style · View change · Undo this". A person resolves the thread; "Resolve when applied" is an opt-in (R-041).
- **Roles.** Commenters get "Suggest to owner", which creates a pending proposal that only editors can apply. A background turn never applies for a non-owner.
- **Juno's own comments.** When Juno makes a judgment call, or needs a fact it doesn't have, it leaves an unresolved comment marked Juno.
- **Rate limits:** Juno replies are limited per artifact per hour; writing a comment is free (R-036).

---

## 9. Collaboration, sharing, governance and the X-01 fix

### 9.1 Roles and access (R-039)

- **Roles:** Owner · Editor · Commenter · Viewer, with a Prototype viewer below Viewer in Phase 5 (R-088). One helper, `canAccess(artifact, user, action)`, guards every artifact, design, comment, proposal and export route. It replaces the `artifact → conversation.userId` authorisation (`00` §12.8), and `db.ts`'s ownership guard gains `Artifact`.
- **Two access states,** Figma's wording (`03` §3.4): "Inherited: people in <Project> can open it", or "Limited: only people added here".
- **Invites** are capped at 50 per artifact and expire after 30 days if pending. **Request access** gives the owner a Needs-you row, an email, and an accent dot on Share until handled ("Ana asked to comment · Allow as commenter / Deny").
- **Concurrency v1:** per-revision compare-and-swap plus a soft lease ("Maya is editing Hero"), with no cursors. Correct the "stable" CRDT claim in `capabilities.ts:49-55`.
- **No seat gates.** Plan limits are quotas on the owner.

### 9.2 Comments (R-040)

- **Storage:** the `ArtifactComment` table (§3.2), with anchors per kind from the registry (§2.8) and a PNG crop captured at comment time.
- **Anchors re-resolve on every version:**
  - an exact match shows nothing;
  - a fuzzy match shows "Moved";
  - an unresolved anchor shows **Lost**, with Re-attach or Make general (Lovable's orphan state, `03` §4 #1);
  - a deleted node's pin moves to its parent frame, marked "(element removed)".
- **Interaction:**
  - **C** enters comment mode; a click drops a numbered pin and a drag draws a region; ⇧C hides pins.
  - The rail (the trailing pane, a sheet when narrow, a bottom sheet on the phone) has filters: This version/All · Open/Resolved/Lost · Mine.
  - Resolve is a check. Delete is soft, with a 10 s Undo for the author and restore for the owner.
- **Reliability:** optimistic writes, retries and a persisted local draft; a comment is never lost. Comments are rate-limited to 100 per hour. Public snapshots carry no comments, and comments are never deleted to make something public.
- **Notifications** (R-042) use the existing `Notification` table (`schema.prisma:612-627`, currently unread by any client):
  - web and Mac: the Needs-you fold;
  - iPhone: APNs with Reply and Ask Juno actions;
  - email: a 30-minute digest grouped by artifact;
  - per artifact: All · Mentions and replies · Off.

### 9.3 Share vs Publish (R-015; answers owner Q3)

- **Share (people)** gives live access that follows Latest.
- **Publish (public)** is a snapshot pinned to `Share.versionId`, shown as **Not published / Published · v9 · v11 has changes**:
  - **Update** moves the pin and keeps the URL;
  - **Unpublish** reserves the token (`reservedAt`), so a later Publish restores the same URL;
  - only **Reset link** issues a new token;
  - link expiry and "Unpublish all" (Settings › Shared links) are on every plan.
- **Making public visible:** the header reads "Shared" with a filled globe; "· Published" appears in the meta line; tiles carry a 12 px globe; Settings › Shared links rows open `/a/{id}`.
- **Native:** `NativeShareClient` gains ARTIFACT publish, update, unpublish and revoke with the same sheet (glass Phase 3 Share popover, "Share this artifact"). Scope changes and revocation work from the phone (unlike Claude, `03` §2.3).
- **Views** move to `ShareViewDaily`, with bots and the owner excluded. The popover shows "124 views · 81 people · 7 days" and no sparkline.

### 9.4 Governance ships before scripted public pages (R-011)

Today the inherited CSP incidentally stops scripts on public share pages, which blocks X-32's script exfiltration. **Moving previews to their own origin re-enables scripted public pages** (`00` §12.8). The X-01 fix therefore ships in two gates:

| Gate | Ships | Required first |
|---|---|---|
| **G1: private previews** (Phase 0) | The preview origin serves artifact versions only to signed-in viewers with access. The token `{artifactId, version, userId, exp ≤ 5 min}` is re-validated on every load, so revocation is a refusal. `/share/*` keeps **static** rendering (posters and server SVG), with no scripts | The CSP below; Chromium CI rendering a React artifact under production headers |
| **G2: public scripted pages** (Phase 1) | `/share/{token}` Page content from `{token}.{preview-domain}`; Play on public designs (after R-019 conformance) | Everything in the list below |

G2 requires all of the following:
1. `Share.suspendedAt`, set by a ban or takedown and reversible. `ModerationFlag` can reference a share or artifact and survives account deletion (X-31).
2. Admin lookup by token, artifact or user, with Suspend and Restore.
3. A **Report** link in every public footer (reason and detail, no sign-in) that creates a `ModerationReport`. Past a threshold the page auto-suspends pending review.
4. **Screening at Publish and Update:** `moderation.ts` classifiers over the text body, plus deterministic HTML checks: a password `input`, cross-origin `form action`, brand-impersonation terms against the page title, and `window.location` to external hosts. A refusal names its reason in one sentence (X-32; Claude refuses impersonation and credential phishing, `claude-primary-evidence.md`).
5. **Rate limits** through `rate-limit.ts`:
   - publish and update: 30 per hour;
   - comments: 100 per hour;
   - invites: 50 per day;
   - artifact writes: 600 per hour;
   - transactions throttled per artifact;
   - forced `restore` checkpoints removed (X-33).
6. **Quotas** per plan: active published links, total version bytes, unnamed-autosave retention. Numbers are an owner decision (§14.2 D14). Quotas only ever limit creating, never reading or exporting (R-067).
7. **Owner-visible activity in Info:** Published v9, Updated to v11, Link expired, "Suspended by Juno", with Appeal.
8. **The legal notice-and-action contact** replaces `[adresse e-mail de contact]` (`mentions-legales/page.tsx:41`). This is owner Q7.

**The preview-origin response policy** (R-012), which the Mac and iPhone `WKContentRuleList` mirror (X-13) once the owner signs off on opening the Mac's closed sandbox (the glass branch's `ArtifactRuntimeNetwork.isOpen`):

```
script-src   https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://cdn.tailwindcss.com 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'
style-src    'self' 'unsafe-inline' https://fonts.googleapis.com + the CDNs above
font-src     https://fonts.gstatic.com data: + the CDNs above
img-src      https: data: blob:            (kept per PREMIUM §2e; beacon risk accepted, mitigated by screening)
connect-src  'self'                        (the anti-exfiltration line)
form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors {app origin}
```

- **Runtimes** are pinned by version. There are no dev UMD builds and no unpinned Babel (`sandbox-frame.tsx:7-12`). Pages are capped at 16 MiB per version.
- **Untrusted-content turns.** An artifact produced in a turn that read web or connector content opens as a poster with "Run page" until the reader clicks. This is owner Q6.
- **Domain.** The origin is a separate registrable domain with per-version subdomains (`{artifactId}-v{n}.{preview-domain}`). Buying it is an owner action (§14.2 D13).

---

## 10. Motion and visual design for the merged surface

All values are Juno tokens (`globals.css:314-349`, `src/lib/motion.ts`, `JunoDesignTokens.swift`):
- durations: press 70 · fast 120 · exit 160 · base 220 · slow 360 · emphasis 560;
- curves: `ease-out-soft`, `ease-out-strong`, `ease-in`, `ease-in-out`, `ease-breathe`, `ease-spring`, `ease-drawer` (= Claude's snap curve);
- springs: `spring.standard` (220, .05), `spring.emphasized` (360, .1), `spring.layout` (360, 0), `spring.interactive`.

Only transform and opacity travel. Hover is tonal, and nothing lifts. Loops are for live state only. Reduced motion keeps fades and drops travel.

### 10.1 Card to panel (continuity only when the card is on screen)

- **Shared element.** The card poster morphs into the panel stage through framer `layoutId="artifact-{id}"`, using `spring.layout`, 360 ms, bounce 0. For comparison, Claude's only shared-element morph is 350 ms on the same curve (`03` §2.4).
- **Inside it,** the content cross-fades on `duration-fast`, because the poster and the live view differ. The header chrome fades in 60–80 ms later. The transcript column narrows on `spring.standard`.
- **Deep link, library or auto-open:** the plain dock entrance, a 16 px `x` plus a fade on `duration-slow` / `ease-drawer`. Auto-open (the reader did not cause it) uses 24 px and takes no focus.
- **Close:** the panel exits to its edge on `duration-exit` / `ease-in`. It never flies back into the card, so nothing travels across the scroller (PREMIUM §2d; `03` M1). The originating card gets one `bg-selected` fade over `duration-emphasis` to say "you came from here".
- **Resizing:** all transitions are off while resizing, and the entrance does not replay after a resize (fixes L15, R-021).

### 10.2 Panel to full window: the signature motion

The object is the thing that moves.

1. The stage grows to fill on `spring.emphasized` (360 ms, bounce .1), as R-070 specifies. The `duration-emphasis` rung is not used, because it is reserved for changes the reader did not cause, and the reader caused this one.
2. The transcript does **not** reflow live, because text re-wrapping during a width tween is jank. It fades out on `duration-exit`. The leading pane's Chat tab fades in on `duration-fast` once the stage settles.
3. The **composer is the same view** (`layoutId="composer"`) and slides from the chat column's bottom to the leading pane's bottom, keeping focus and draft. This echoes the glass plan's composer-handoff signature (glass §10.1).
4. The trailing inspector slides in 16 px on `duration-base` / `ease-drawer`.

Collapsing reverses this, with the transcript scroll position restored. **Reduced motion:** a 160 ms cross-fade of the whole region.

### 10.3 Streaming states

- **DelayedSkeleton:** nothing for 500 ms, then a skeleton shaped like the content, fading in on `duration-fast`. There is one per surface, never a skeleton followed by a spinner (R-071, Claude's 0.5 s rule).
- **Frames, blocks and nodes arriving:** opacity 0→1 on `duration-fast` / `ease-out-soft` with a 4 px rise, staggered 30 ms, at most 8 per batch. No blur and no scale. Later blocks slide down with framer `layout` (`spring.standard`). Auto-scroll only at the live edge; otherwise a "Writing: Risks ↓" chip.
- **LiveMark:** one breathing dot, brightness .9↔1.1 and scale .92↔1 on `ease-breathe` over 2.4 s. It is the only "Juno is making this" mark, used on the card, panel header, sidebar row and Mac dock. It replaces `animate-pulse` and the gen-sweep bar (L17, PREMIUM rule 14). Under reduced motion it holds at full brightness.
- **StatusLabel:** text announced once, with a copy ladder keyed to elapsed time and real progress ("Writing Sign-in screen…", then after 20 s "Still writing · 2 of 3 screens"). Never a percentage that isn't real.

### 10.4 Version switching

A version change is a **swap, never a remount** (the X-02 law):
- **Code and Markdown:** replace in place, with scroll anchored to the nearest heading or line.
- **Page:** render into a hidden second iframe, then cross-fade on `duration-fast` when it reports ready.
- **Design:** `editor.adoptDocument(next)`, keeping selection, viewport and undo when the base matches.
- **Stepper:** the number rolls through `RollingNumber`. "Viewing v5" rises in 4 px on `duration-base`.
- **Compare:** a wipe slider for pages; onion-skin or split view with linked cameras for designs. The wipe follows the pointer 1:1 with no easing. Hold B to flip, which cross-fades on `duration-fast` (R-022).

### 10.5 Presence and change reveal (R-034)

- **While Juno works:** the target scope gets a 1.5 px accent/60% outline whose brightness breathes .92↔1.0 over 1.6–1.8 s (`ease-breathe`) only while live. The accent is allowed because "Juno is acting" is a state (FLAT_UI §2.4). A chip at the scope's top-left reads "Laying out 3 cards · Stop" and pops from its origin on `duration-fast`.
- **Proposal:** modified nodes get an accent outline with an 8% fill; added nodes rise in; deleted nodes are dashed ghosts at 40%. Hold B for "before".
- **Apply:** the old render cross-fades out on `duration-base`. Halos hold about 800 ms, then fade over `duration-emphasis` on `ease-out-expo`. The version pill swaps via `IconSwap`. Off-screen changes get an edge chip, "4 changes ↓", that frames them on `duration-slow` / `ease-in-out`, cancelled by any wheel or drag.

### 10.6 Library, comments and camera

- **Artifacts home:** tiles deal in on first load only (`staggerDelay(i, "base")`, 45 ms, capped at 8). Filter changes cross-fade on `duration-fast`. Switching list and grid never replays the stagger. Posters cross-fade over placeholders on `duration-base`. A trashed row folds with `Collapse` while fading on `duration-exit`.
- **Comment pins:** a pin pops in (scale .8→1, `ease-spring`, `duration-base`); picking a thread moves the camera (`ease-in-out`, `duration-slow`) and the pin shows one accent ring fading over `duration-emphasis`; resolving scales to .9 and fades on `duration-exit`. A Lost pin is a static dashed ring, with no motion.
- **Camera** (fit, selection, comment, search hit): zoom interpolates in log space and pan linearly, on `duration-base` / `ease-in-out`. Beyond 3 viewport widths it zooms out, pans and zooms in, capped at `duration-slow`. Any gesture cancels it (R-070).

### 10.7 Reduced motion and the in-app setting

- Settings › Appearance › **Motion: System | Reduced**, with the description "Reduce animation in streaming replies, the panel and designs" (R-072). It sets `html[data-motion=reduced]` in the pre-hydration theme script, and `JunoMotion` reads it on native.
- **Under reduced motion:**
  - morphs become 160 ms cross-fades;
  - the camera cuts, with a 120 ms cross-fade;
  - loops stop;
  - fades keep their timing;
  - authored design motion does not autoplay in cards and posters; explicit Play still plays.
- **Guard test:** next to `tests/design-host-motion-tokens.test.ts`, assert that every panel exit has a reduced-motion branch and that no artifact surface uses `ease-out-expo` for travel (R-021).

### 10.8 Liquid Glass on the Mac

- **Dock entrance:** `TrailingDock` enters on the drawer curve at `Duration.base`, *not* `outExpo` (`JunoDesignTokens.swift` still has `canvasEnter = outExpo`; L17 mac). Under Reduce Motion it is `.opacity` only, using the glass branch's `shift()`.
- **Library to document:** `matchedGeometryEffect` on `JunoMotion.layout`, with the platform's ×0.75 spring factor (glass §8.5).
- **Mode changes and version swaps:** cross-fade on `JunoMotion.fast`.
- **State swaps:** `.contentTransition(.symbolEffect(.replace))`, with no hover articulation (glass §0.8 #8).
- **No glass on content:** posters, tiles, the dock body, the stage and panes are opaque on the warm canvas. The document window's toolbar and popovers are system glass. There are no new custom glass sites (§6.6).
- **iPhone:** `navigationTransition(.zoom)` from card or tile to the full-screen artifact; sheets on `ease-drawer`.

### 10.9 Visual rules that apply to every new surface

- One accent: the primary action, and live or selected state. Selected rows are `bg-selected` with foreground ink, fixing the accent tint on layer rows, pages, tools and the Ask scope chip (`01` §4.9).
- Radii from the ladder, with the concentric rule. Named z-rungs only. 32 px pointer targets and 44 px coarse ones. Sentence case, with no caps eyebrows (PREMIUM rule 13).
- Hosted editor CSS is built from `globals.css`'s token and component layers, so it has warm hue-30 charcoal (not indigo or zinc) and the user's accent via the bridge `appearance` command (X-17, R-060).

---

## 11. Work deliverables

**Decision (owner Q1): unify, in two steps.**

| Step | Phase | What | Closes |
|---|---|---|---|
| **A. Index** | 2 | Artifacts home lists `WorkArtifact` rows under **From tasks** by reference (§4.3 union). A row opens the `ArtifactSurface` in a read-only File/viewer mode: report via the chat Markdown renderer, spreadsheet via `/preview`, site via the preview origin, and Office and PDF via server-rendered first-page posters plus Download (hash-verified, `download/route.ts:93-158`). The run's final card lists everything it made as artifact rows (poster, kind, Open), not only the newest previewable file (M71). **Start persisting the spec now** (`WorkArtifactVersion.specKey`) | X-25 (web Office downloads), X-27/X-28 on native through glass Phase 5 envelope and refresh fixes, M71 |
| **B. Typed** | 5 | `create_deliverable` for `document`, `report`, `presentation` and `spreadsheet` writes a typed **Doc / Deck / Sheet** artifact (owner = run owner, `projectId` from the session, `conversationId` from `WorkSession.conversationId`), with the spec as the editable source and `authorKind: AGENT`, `runId` and **provenance written** (fixing the never-written provenance at `work-runner.ts:1826`). The Office file becomes an `ArtifactExport` of that version, validated by the existing validator before serving. `site` → Page (Site bundle). `pdf`, `bundle`, `archive` and `image` → **File** with binary-backed versions whose `storageKey` points at the **same objects** (no byte copy). Existing `WorkArtifact` rows backfill to File artifacts, setting `WorkArtifact.artifactId`. `work_artifact*` sync entities become read-only aliases, then retire once native N+2 no longer reads them | The two made-thing tables become one; X-29 through conversation links; X-26 through the single purge path |

**How Docs and Slides relate to today's exports:**
- **One OOXML renderer.** `office-export.ts:450-611` and `work/deliverables/document.ts:173-358` are nearly identical line for line (`00` §4.5). Keep the Work one, which has typed specs and caps, as the only renderer. Markdown → docx, xlsx and pptx become "Doc → .docx", "Deck → .pptx" and "Sheet → .xlsx". Every file is re-opened by `validate.ts` before serving, as today.
- **MARKDOWN → Office stays** for legacy rows until DOC lands. It is then relabelled "Export ▸ Word" on Doc.
- **Decks stop being Markdown with `---` separators** (`system-prompt.ts:293-297`). A Deck is a DesignDocument profile, so Work's five fixed layouts that overflow while marked valid (M73) are replaced by auto layout frames with a per-slide overflow lint (R-035, R-059).
- **The research report** becomes one Doc per run; `ResearchReportRevision` versions map to Doc versions (the three copies in `00` §4.1 #6 collapse).

---

## 12. Performance and telemetry

### 12.1 Payload diet (X-30, X-33, M12)

| Path | Today | After | Budget |
|---|---|---|---|
| `GET /api/artifacts/{id}` | Every version body (`queries.ts:117-121`, `serializers.ts:207-223`) | Metadata, current body, version list without bodies, head revision, permissions, thread id | p95 ≤ 300 KB on the largest 1% of designs |
| Chat `done` SSE frame | Every version of each touched artifact | The touched version plus metadata | ≤ 1.2× the version body |
| Thread load | An hour of design editing ≈ 9–27 MB (`00` §1 #8) | Messages plus artifact metadata; bodies fetched by the surface | p95 ≤ 500 KB |
| Design transaction | Reads all versions two or three times (`store.ts:33-39`) | Reads the head row only | p95 ≤ 80 ms server time |
| Sync `artifact_version` | Full body per fold | Metadata; body only for current and ≤ 256 KB; the head never synced | No fold-driven wake-ups |
| Native store read | Whole-account decrypt about 8× per wake-up (`02` §3.3) | Per-namespace reads (`AccountScopedStorage` gains a namespace query) | One decrypt of the artifact namespace per wake-up |
| Search | `to_tsvector` over every version body, no GIN index (`search/sql.ts:329-355`) | A GIN-indexed `tsvector` on the **current** body; older versions via "Search history" | p95 ≤ 150 ms |

### 12.2 Pictures

- **When they render:** posters generate when a version **seals or completes**, never on each fold (R-014). They render server-side with `renderPageSvg` for Design and Deck, so X-24 (container opacity and rotation) must be fixed first.
- **Pages:** a headless capture on the preview origin, run in a worker pool with a 5 s cap. A typed placeholder plus excerpt shows until it is ready.
- **Sizes and caching:** 320, 640 and 1280 px WebP (SVG kept for Design), cached by `(artifactId, version, frame, width, contentHash)` behind the CDN. Native caches per version under `Caches/<bundle>/Posters/<account>/`, purged on sign-out, as the glass branch does for design previews.
- **Budgets:** poster p95 ≤ 2 s after seal; tile grid first 24 posters ≤ 600 ms p75 from cache.

### 12.3 Bundles

- **Split by kind.** The Canvas chunk (about 449 KB, about 225 KB of it design code, `canvas-panel.tsx:44`) splits by registry kind, so a Page never loads the design editor.
- **Runtime pins.** React production UMD with pinned Babel and Mermaid pinned by version.
- **Native bundle gate.** The editor bundle hash is checked in `native.yml` and in the Mac release, with the hash covering every compiled input (X-19) and a size budget.

### 12.4 Telemetry (R-020; X-01 went unnoticed for about four weeks)

`src/lib/observability.ts` has no importers today. The recommendation is to wire it to a **first-party** `ProductEvent` table with daily rollups: no third-party processor and no message content (owner decision D16). The merge's dashboard:

| Signal | Definition | Launch threshold |
|---|---|---|
| Preview render success | `juno:status ready` ÷ mounts, per runtime and per platform | ≥ 98% for HTML/React/Mermaid on web |
| Poster failures | Failed renders ÷ seals, per kind | ≤ 1% |
| Time to first skeleton / first content | Send → `artifact.skeleton` / first filled block | p75 ≤ 2 s / ≤ 6 s |
| Completion | complete / stopped / truncated / refused per version, with reasons | refused ≤ 3% |
| Proposal outcomes | shown, applied, discarded, stale, failed; hunks accepted or rejected | failed ≤ 1% |
| Human-wins conflicts | 409 retries and kept-human merges | reported, not gated |
| Destructive paths | Any hard delete outside purge (must be 0); trash restores | 0 |
| Share | publishes, updates, unpublishes; views without bots by scope; suspensions; reports | reported |
| Native health | `unsupported_kind_seen`, skipped rows, editor bundle version in the field, bridge refusals (`lastRefusal`, now sent) | skipped rows ≤ 0.1% |
| Size | Document size distribution, "large design" notes, 413s | 413s ≤ 0.1% of saves |
| Payloads | p95 thread and artifact payloads (§12.1) | within budget |
| Routing | armed vs automatic kind; "make this a page instead" rate | reported |

A small internal dashboard ships **before** any Phase 2 flag turns on. `/dev/artifacts` (a gallery of every kind at every size and state, light and dark) is the web visual check, following the project rule to verify in `/dev` galleries. Mac and iPhone use offscreen snapshot tests.

---

## 13. Roadmap

Durations are indicative. The phases are **gates**, not calendar promises. Track E (the editor) runs in parallel from Phase 1.

### Phase 0: Stop the bleeding (weeks 0–2)

| Work | Closes |
|---|---|
| Merge `7243613f` (edit and regenerate never delete) | X-03, X-04 |
| X-02: use the returned artifact, never a synthetic `""` version (another session may land it); **plus** the structural rule "mount by id" (R-013 starts) | X-02 |
| `complete` flag: stopped or truncated output never becomes current; honest card states | X-07, R-007 (part) |
| Size check after DESIGN expansion; `image` removed from the compact grammar prompt | X-08, X-10 |
| Guard: a chat re-emit that would drop a DESIGN's components, variables, motion, interactions or comments, **or** that overwrites a version whose `origin` is `edit`, lands as a non-current draft with "Compare" | X-05, X-06 (containment) |
| Native N (tolerant decode plus allowlist plus headers) as Mac 1.6.x and iOS point releases from main. The `JunoChatKit` store change is ported from the glass branch and not held for the full glass release. iPhone design editing read-only (R-002) | X-09, R-001, R-002 |
| Editor bundle rebuilt and gated; CSS from token layers; `surface="window"` in hosts | X-17, X-18, X-19 |
| `cornerSmoothing` (glass branch); Mac base version from edit start (glass branch) | X-14, X-15 (part) |
| X-21 project list; X-23 RFC 5987 `filename*`; X-20 shared DESIGN as server SVG | X-20, X-21, X-23 |
| X-01 **Gate G1**: private previews on the separate origin; public pages stay static | X-01 (owners) |
| Telemetry spine and dashboard skeleton | R-020 |

**Exit:**
- every script preview renders for owners in Chromium CI under production headers;
- no JSON is visible for any design on any surface (tested in `/dev/artifacts`);
- the native N build is on ≥ 95% of active devices;
- `design:editor:check` passes in CI.

### Phase 1: The object (weeks 2–6)

| Work | Backlog / closes |
|---|---|
| M1, M2 and M3 migrations; owner by `userId` in triggers and loaders; threads backfill | R-004; X-22 |
| Working head and sealing; append-only; provenance; retention | R-005; X-30, X-33, M10, M31 |
| Recently deleted; purge job; account purge incl. storage | R-006; X-26 |
| Kind registry generated to Swift and OpenAPI; vocabulary lint | R-008 |
| One write service; per-kind validation; legacy route adapters | `00` §4.6 |
| Governance core (§9.4 items 1–8) → **X-01 Gate G2** | R-011, R-012; X-31, X-32, X-13 (with sign-off) |
| New versions land in place, with no remount anywhere | R-013; X-12 (web) |
| Posters everywhere; X-24 first | R-014; X-20, X-24 |
| Payload diet and search index | R-064 (part); M12 |
| Account export includes artifacts | R-067 (part) |

**Exit:**
- a lint shows zero hard-delete paths;
- sync parity holds on staging;
- p95 payloads are within the §12.1 budgets;
- a public scripted page cannot `fetch` off-origin (CI);
- a ban suspends every share within 1 minute;
- the Report link works signed-out.

**Flags:** `artifact_detach`, `artifact_soft_delete`, `artifact_head`, `preview_origin_public`.

### Phase 2: One surface (weeks 6–10)

| Work | Backlog / closes |
|---|---|
| `ArtifactSurface` at every size; `/a/{id}`; panel/window `pushState`; redirects at 307 | R-016, R-025; M28, L27, L28, M23 |
| Artifacts home; Design becomes a kind, filter and New action; the Design row as a one-release pointer; Pinned artifacts | R-018, R-027, R-075 (pin, duplicate) |
| Container-sized editor (bands, drawers, contextual bar) | R-017; M17, M58, X-18 |
| Card, receipts, stepper, Compare | R-022, R-023, R-024; L9 |
| Make… pill; visible routing; per-kind capability switches | R-028; M7 |
| Share dialog v2 (Publish part; People says "Only you") | R-015; L5, M30 |
| Made here popover; generated images indexed; Work index (option A) | R-079, R-092, §11 A; X-25, M71 |
| Motion spec, hygiene, one live mark, Motion setting | R-070, R-021, R-071, R-072; L15–L18 |
| Keyboard and screen-reader contract | R-063; M22, M23 |
| **Mac:** glass Phase 3 (Share popover with artifacts, Made here) and Phase 4 (Artifacts page as home, no Design page or row); document windows; drafts on disk | R-068, R-065 (part); X-16 |
| **iPhone:** Artifacts home parity; sheet; universal links | R-025, R-069 (view part) |

**Exit:**
- every old entry point in §5.4 lands on the object (e2e test per row);
- the panel ↔ window round trip keeps undo, selection and zoom (component test);
- Mac, iPhone and web ship the Design-row removal in one window;
- the dashboard shows no regression in time to first content.

**Flags:** `artifact_surface` (per user, then everyone), `artifacts_home_v2`, `design_as_kind`. After 30 clean days: switch 307 → 308 and remove the pointer row.

### Phase 3: Juno in the object (weeks 10–14)

| Work | Backlog / closes |
|---|---|
| Context digest, view context and chip; three verbs; compare-and-swap with human-wins | R-009, R-031; X-05, X-06, M40, M41 |
| Proposals in the thread; review rules; isolated review; one channel (Ask Juno retired) | R-010, R-030; M46, M47 |
| Branches: Try 2, edit-from-earlier, big changes to Compare | R-029 |
| Skeleton-first streaming; auto-open; steering | R-033; M14, M15 |
| Presence and change reveal; Fix with Juno; fair usage | R-034, R-035, R-036 |
| Mode bar V/T/D/C; ask bar and queue; tweaks; Page properties | R-037, R-038, R-043, R-044 |
| Taste form; craft rules, lint and **golden eval** (built at the start of the phase, used as its exit) | R-045, R-047 |
| One tool contract (chat, Code, MCP) | R-032 |
| Compact grammar retired (create = ops on an empty document) | X-10 (fully) |

**Exit:**
- the golden set (about 40 prompts × models) passes: validity ≥ 97%, render success ≥ 98%, and **zero** structure loss on the "3 animations + 5 interactions, make the title bigger" family;
- the proposal failed rate is ≤ 1%.

**Flag:** `ai_edit_loop`, per kind: Page and Code first, then Doc, then Design.

### Phase 4: Together (weeks 14–18)

| Work | Backlog |
|---|---|
| Grants, project inheritance, Request access, `canAccess` | R-039 |
| Comments table, anchors, rail, orphans; comment entity live (§3.5 step 6) | R-040 |
| Send to Juno from comments; per-person threads for grantees | R-041, R-073 |
| Notifications (Needs you, APNs, digest) | R-042 |
| Phone contract v1: view, Play, comment, Ask, tweaks, text edits via transactions; lifts R-002 | R-069; M57 for v1.1 |
| Offline edits never vanish (native transactions queue) | R-065; X-15, X-16 |
| Presence phase 1 (who viewed) | R-074 |
| Duplicate, Make a copy, Continue in a new chat, attach by reference | R-075 |

**Exit:**
- a commenter on iPhone can comment and "Suggest to owner", and the owner applies from Mac;
- no comment is lost across 1,000 randomized version changes (anchor re-resolution test);
- a grantee never receives any text from the owner's thread (privacy test).

**Flags:** `grants`, `comments`, `phone_edit`.

### Phase 5: Typed kinds and deliverables (weeks 16–26; after N soaks)

| Work | Backlog |
|---|---|
| Doc (DOC blocks, tabs); MARKDOWN converts on first structural edit | R-058 |
| Deck on the design engine; Present | R-059 |
| Design system kind installed everywhere; DS lint | R-051, R-047 |
| Work option B: typed deliverables; File kind; one OOXML renderer; `WorkArtifact` aliasing | §11 B |
| Turn into…; embeds; HTML ⇄ design (P2) | R-078, R-080, R-081 |
| Runtime capabilities (ask/store), prototype-only links, presence phase 2 | R-076, R-088, R-074 |

**Exit:** each new kind passes the "ships whole" checklist of §1.2 principle 5: versions, trash, comments, poster, phone contract and native decode. `kinds_v2` stays gated per account on client features (§3.5 step 7).

### Track E: the Figma-grade editor (parallel, weeks 2–26)

| Stage | Work | Backlog |
|---|---|---|
| E1 (with Phase 1) | Layout engine fixes (M37); keyframe Delete fix; keyboard and clipboard; direct manipulation; X-24 | R-003, R-061, R-062 |
| E2 (with Phase 2) | One motion runtime and conformance suite; transitions; prototype behaviour; **Play** (gated on conformance) | R-019, R-055, R-056, R-057; M61–M65 |
| E3 (with Phases 3–4) | Motion model v2; presets; timeline ergonomics; live components (Phase A); variables everywhere; bridge v2 (Mac/iPhone Play, proposals, comments, undo, export) | R-049, R-052, R-054, R-048, R-050, R-060 |
| E4 (with Phase 5) | Inspect and handoff; export sheet with honest losses plus "Build it with Juno Code"; video/GIF; AI motion variants; directions | R-082, R-066, R-083, R-053, R-046 |
| E5 (with Phase 5) | Component states with declared transitions; editable transition timelines; effects parity (progressive blur, animatable effect and layout fields); accessible-by-construction roles on nodes and in exports and the player | R-085, R-086, R-089, R-084 |
| Later (P3) | Motion paths, size variants, brand re-apply, appearance previews, freeze-the-frame comments, drawing set, embeds of published artifacts in other tools, titles that arrive rather than pop, fixed inspector order and density, several pinned comments on a generated image sent as one revision | R-094, R-097, R-098, R-100, R-087, R-090, R-093, R-095, R-096, R-099 |

### Must not ship before

| This | Not before | Why |
|---|---|---|
| Any row of a new kind (DECK, DOC, SHEET, DESIGN_SYSTEM, FILE) | Tolerant native N on ≥ 95% of active devices, plus the per-account client gate | One unknown kind blanks installed libraries (X-09) |
| Any row of a new sync entity (comment, grant, pin) | Its string in the allowlist of the oldest build seen in 30 days | Unknown entity types stop the account syncing entirely (`NativeSyncAPIClient.swift:140-175`) |
| `conversationId` detach on chat delete (`artifact_detach`) | The trigger resolving the owner by `Artifact.userId` (M2) | Detached artifacts would vanish from every device |
| Scripted public share pages (X-01 G2) | Governance items 1–8 (§9.4) | The fix re-enables X-32 exfiltration |
| Play at share links | The R-019 conformance suite | Preview ≠ export today (M62–M65) |
| The AI patch/ops loop as default | Immutable versions plus `complete` (R-005, R-007) | Proposals need an immutable base to compare-and-swap against |
| Publish v2 | `Share.versionId` backfill (B5) | Otherwise public links jump versions |
| Removing the Design row (web, Mac, iPhone) | `/a/{id}`, the New menu and redirects on all three platforms, in one window | Old doors must keep working (principle 8) |
| iPhone design editing (lifting R-002) | Native saves through transactions and adopting remote versions | X-14/X-15-class lost updates |
| The glass branch's regenerate on settled answers | `7243613f` merged and deployed | It widens X-04 exposure (`00` §11) |
| The purge job | Versions-before-artifact deletion order | Tombstones for cascaded deletes are uncertain (`00` §7.2) |
| 308 redirects | 30 days of 307 | Browsers cache 308s; a rollback would strand people |

### Flags and rollback summary

| Flag | Default | Off means |
|---|---|---|
| `artifact_detach` | off → on in Phase 1 | Chat delete keeps artifacts attached and asks, as today's copy does (never hard-delete again) |
| `artifact_soft_delete` | on | Delete is still soft; the purge window extends |
| `artifact_head` | per kind | Designs fall back to append-per-transaction (more versions, correct) |
| `preview_origin_private` / `_public` | G1 on in Phase 0; G2 in Phase 1 | Public pages go static |
| `artifact_surface` | per user → all | The old panel and `?artifact=` routes (the redirects flip to 307 back) |
| `artifacts_home_v2`, `design_as_kind` | per user → all | The old `/artifacts` and the Design row |
| `ai_edit_loop` | per kind | Today's full re-emit, with the Phase 0 guard |
| `grants`, `comments`, `phone_edit` | off → on | Owner-only, no comments, phone read-only |
| `kinds_v2` | per account (client gate) | MARKDOWN and DESIGN are created instead |
| `work_as_artifacts` | off → on in Phase 5 | Index-only (option A) |

---

## 14. Risks and decisions

### 14.1 Risks and mitigations

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | **Sync silently drops detached artifacts** because the change trigger resolves the owner through the conversation | High if missed / severe | M2 before `artifact_detach`; a parity test on staging; a lint on trigger text in `tests/` |
| 2 | **Installed native builds break** on a new kind or entity | Certain without ordering / severe | §3.5 steps 1, 6 and 7; per-account client gate; `unsupported_kind_seen` on the dashboard |
| 3 | **Panel ↔ window `pushState` continuity is fragile** in the Next 15 router (scroll restoration, prefetch, `useSearchParams` races) | Medium / medium | A spike in Phase 2 week 1. Fallback: full window as a chat-route layout mode at `/chat/{c}?a={id}&view=full` while Copy link still yields `/a/{id}` |
| 4 | **The model does not follow patch/ops contracts** across providers (Qwen, MiMo and others) | Medium / high | Golden eval per model before `ai_edit_loop` per kind; size- and kind-aware tier routing; rewrite-to-branch fallback so failure never overwrites |
| 5 | **Public scripted pages get abused** once G2 opens (the ClickFix precedent, `03` §2.1) | Medium / severe | Governance first; screening at publish; unverified footer; auto-suspend on report threshold; `connect-src 'self'` |
| 6 | **Scope:** Figma-grade plus typed kinds plus collaboration is a year of work | High / medium | Gates, not a calendar. Track E runs in parallel; Phase 5 kinds only after Phases 1–3 prove the object; "Hold" list (§6.10) |
| 7 | **Two panes feel cramped** at a 1240 pt Mac window or 1280 px laptop with Chat + stage + inspector | Medium / medium | Container bands (§6.3); ⌘\; leading pane drawer below 1040 px; the panel stays the default working size |
| 8 | **Per-person threads confuse people** ("where is my conversation about this?") | Medium / low | The Chat tab always shows *your* thread; "Made in <chat>" in Info; the made-in transcript read-only when the owner allows |
| 9 | **Thumbnail cost** (headless captures) | Medium / medium | Generate on seal only; worker pool with cap; typed placeholder fallback; per-plan capture quota |
| 10 | **Removing the Design row** feels like a lost feature to people who used `/design` | Medium / low | One-release pointer row; presets pinned in the Designs filter for 60 days; ⌘K "New design"; `/new/design` |
| 11 | **Coordination with the Liquid Glass session** (the plan adds a Design row, has an explicit-Save dock, a closed sandbox) | High / medium | Explicit amendment requests (§4.7) through the owner; this proposal builds on glass Phases 2–5 rather than forking them |
| 12 | **Plaintext artifact bodies at rest** (for search) vs encrypted messages and the privacy policy (`00` §12.1) | Present / legal | Decision D17; if encrypted, search moves to a per-account encrypted index or titles-only |
| 13 | **Migration on large accounts** (versions > 200k, many folds) | Medium / medium | Owner Q9 SQL first; batched backfills; B6 moves big bodies to storage before native reads them |
| 14 | **Comment anchor drift** after AI structural edits | Medium / medium | Deepest-surviving-node anchoring; Moved/Lost states; the transaction log maps ids across `duplicateNodes` via match keys (R-055) |

### 14.2 Decisions the owner must make (with the recommended answer)

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | WorkArtifact: unify tables (B) or index only (A)? (Q1) | **A in Phase 2, B in Phase 5; persist the spec now** | Users get their files now; the object model ends with one table and no byte copies |
| D2 | Library fold vs three siblings; Design a destination or a type? (Q2) | **Two siblings (Library = brought, Artifacts = made); Design is a kind.** Record it in `OPEN_DECISIONS.md` and amend TWO_PRODUCTS §3 | One noun per object; Claude and Figma both hold many kinds in one browser; `03` §8 #7 |
| D3 | Public link: frozen, live, or both? (Q3) | **Both, split:** Publish = pinned snapshot with Update; Share = live grants | Screening applies to each published version; live links need access control |
| D4 | Should regenerate or edit ever delete? (Q4) | **Never.** Branches ("Try 2"), and shares move with the id | Native already branches; this matches principle 1 |
| D5 | Where do comments live? (Q5) | **Their own table; guest comments off on public links** | Survives versions and AI rewrites; anchors per kind |
| D6 | Preview egress, and untrusted-content turns? (Q6) | **CDN allowlist scripts, https images, `connect-src 'self'`; poster plus "Run page" for turns that read web or connector content** | Keeps honest previews working (PREMIUM §2e) and closes exfiltration |
| D7 | Legal contact; does a ban suspend shares reversibly? (Q7) | **Name a contact now; yes, `suspendedAt`, reversible** | Required before G2 |
| D8 | Artifacts in private chats? (Q8) | **Not in v1.** Later: ephemeral cards with an explicit "Save to Artifacts" that leaves private mode | Private mode never persists (`route.ts:2107-2108`, a stated principle) |
| D9 | Run the production read-only SQL (Q9) | **Yes, before M3:** versions > 200k UTF-16 units; shares pointing at DESIGN; holder chats | Sizes B4–B6 and shows whether X-09 is live |
| D10 | Thread model | **Per-person threads; the owner's is the made-in chat; grantees ask via their own thread or comments** | No context leakage; each person pays for their asks |
| D11 | The Liquid Glass Design row | **Drop it** (keep `.design` decodable → Artifacts filter) | One place for made things across platforms |
| D12 | iPhone design editing | **Read-only now (R-002); field edits and Ask in the phone contract (Phase 4)** | The current editing is lossy (X-14, X-15) |
| D13 | Preview origin domain | **Buy a separate registrable domain now** (per-version subdomains) | Gate G1 needs it; lead time |
| D14 | Quotas and retention numbers | **Owner sets:** published links, version bytes, unnamed-autosave retention per plan. Never limit reading or export | TWO_PRODUCTS §4 windows stay the AI meter |
| D15 | How far to take Figma-grade | **Yes:** auto layout/grid, live components, variables with modes, motion v2, one runtime, Play/Present, Inspect. **Not yet:** vector networks, boolean ops, live multiplayer | The engine is already strong where "yes" is; the rest is new engine work |
| D16 | Telemetry sink | **First-party `ProductEvent` table with rollups** | No third-party processor; enough for the launch dashboard |
| D17 | Artifact bodies encrypted at rest? | **Decide before Phase 4 grants.** Recommend encrypting bodies and moving search to a per-account index, or updating the privacy policy to match | Today's policy implies otherwise (`legal/confidentialite/page.tsx:46-48`) |
| D18 | Mac closed sandbox vs web allowlist (X-13) | **Mirror the web allowlist** in `WKContentRuleList` after G1 ships (flip `ArtifactRuntimeNetwork.isOpen`) | "One link looks the same everywhere"; the glass addendum defers to the owner |
