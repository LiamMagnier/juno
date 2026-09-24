# Merging Artifacts and Juno Design: the Claude-faithful proposal

**Status:** proposal, 2026-09-23. **Angle:** Claude-faithful. Mirror what Anthropic shipped on 16 Sept 2026 wherever Juno's strengths allow, and beat it where Claude is weak.

**Basis (read-only):**
- `main` at `d0997af2`.
- The unmerged X-03/X-04 fix `7243613f` on `claude/agitated-elion-a15fe9`.
- `mac/liquid-glass-chat` at `2b1049c5` (Phase 2 stage 3).

**Evidence:**
- The audits: `00-AUDIT-OVERVIEW.md`, `01-AUDIT-WEB.md`, `02-AUDIT-MAC.md`, `03-COMPETITIVE-AUDIT.md`.
- `research/claude-primary-evidence.md` and the backlog `R-001`…`R-101` (`scratchpad/merge/backlog.clean.json`).
- The design laws: `TWO_PRODUCTS.md`, `FLAT_UI.md`, `PREMIUM_AUDIT.md` and `ICONS_AND_MOTION.md`.
- `MACOS_LIQUID_GLASS_REDESIGN.md` on the glass branch.

**Id conventions:**
- `X-nn`: cross-cutting defects (00 §7).
- `Dn`, `Mnn`, `Lnn`: web defects (01 §6).
- `Hn` and "Mac `Mn`": Mac defects (02 §8).
- `R-nnn`: backlog items.
- `U#`, `A#`, `V#`, `C#`, `S#`, `L#`, `E#`, `N#`, `M#`: pattern ids from 03 §6–7.
- File references are repo-relative. A reference marked **(checked)** was re-read for this proposal.

---

## 0. Executive summary

1. **Thesis.** The conversation is where things are made; the artifact is what you keep. Everything Juno makes becomes a typed artifact with **one id, owned by the account**, and it follows Claude's one path:
   - a card in the reply;
   - a panel beside the conversation;
   - a full window at `/a/{id}`;
   - one link, which opens on the phone.
2. **Design stops being a place and becomes a type.**
   - The sidebar keeps one **Artifacts** row. The Design row goes on the web and never ships on the Mac glass branch.
   - `/design` redirects to `/artifacts?type=design`, and `/design/{id}` redirects to `/a/{id}`.
   - You make a design in three ways: ask for one, pick **Make ▸ Design** in the composer (Claude's Output picker), or press **New ▸ Design** in Artifacts.
3. **Docs and Decks join as typed artifacts**, alongside Design, Page (HTML/React), Diagram, Graphic, Code, and Design system (later).
   - Docs and Decks are Juno's editors and formats. A Deck is a profile of the design engine, not HTML sections.
   - Office and PDF files become **derived exports** of a version. They are no longer a separate kind of made thing.
4. **Work deliverables are split by shape (hybrid decision).**
   - `document`, `report` and `presentation` become **Doc** and **Deck** artifacts, and their spec is kept as the editable source.
   - Binary outputs (`spreadsheet`, `pdf`, `bundle`, `archive`, `image`, `site` zip) stay in `WorkArtifact`. They are listed **by reference** in Artifacts under **Files**.
5. **The data change comes first, because the storage layer already did most of the merge.** DESIGN is already an `ArtifactType` row (`prisma/schema.prisma:1354-1365`, checked). Additions:
   - `Artifact.userId`;
   - a nullable, `SetNull` "made-in" `conversationId`;
   - `projectId` and `deletedAt`, giving a 30-day trash;
   - an `ArtifactHead` working copy, which replaces design fold-in-place;
   - version provenance: `authorKind`, `messageId`, `complete`, `label`, `branchId`;
   - `Share.versionId`, plus comments, grants and exports tables.
6. **The order is Claude's order, and it is enforced.** Claude shipped one home (07-07), then account-owned artifacts (08-19), then the merge (09-16), and removed the toggle last. Juno follows the same sequence:
   1. **Phase 0:** stop the bleeding.
   2. **Phase 1:** first-class artifacts.
   3. **Phase 2:** one surface.
   4. **Phase 3:** Juno edits what is there.
   5. **Phase 4:** Docs, Decks and Work. **Public launch.**
   6. **Phase 5:** people.
   7. **Phase 6:** design systems.
7. **Native tolerance ships before any contract change.** One unknown kind or one oversized row blanks the whole Mac and iPhone library (X-09), and one unknown sync entity stops sync for the whole account (`NativeSyncAPIClient.swift:141-190`, checked). So:
   - A small "tolerant" 1.6.x release is cut **from `main`**, because the glass branch ships only when all its phases are done.
   - The server down-converts new kinds for older clients, keyed on an `artifacts=2` client-contract header.
8. **X-01 ships with governance, not before it.**
   - Previews move to a separate registrable domain with one subdomain per artifact version, signed short-lived tokens, and `connect-src 'self'`.
   - The same release adds ban propagation, admin takedown, a Report link, screening at share time, rate limits, and view counts moved off the sync feed.
9. **One AI channel, reading the current version.**
   - Every turn sees a digest of the current version of each artifact that is open or was recently touched.
   - Follow-ups become **patches** (text and code), **block operations** (Docs) or **design operations** (Design and Deck), using a compare-and-swap on the version the turn read.
   - People's edits win.
   - Changes appear as reviewable **edit cards in the transcript**.
   - Ask Juno folds into the conversation.
   - The stored transcript **references** artifact versions instead of carrying their bodies. That removes the cause of X-05.
10. **One ArtifactSurface, keyed by artifact id, in six sizes:** card, panel, full window, picture-in-picture, shared page and phone sheet. The version is data, never a React key or a SwiftUI identity. That is the root fix for X-02, X-11 and X-12.
11. **Where Juno beats Claude:**
    - Every type ships with versions, a stepper, restore and trash on day one. Claude Docs and Design have neither history nor trash.
    - Every type has a comment-only role.
    - Publishing is separate from sharing, pinned to a version, and visible.
    - The phone contract is **view, Play, comment, ask, tweak, text edits and sharing management**, not view-only.
    - The Mac treats artifacts as real documents: restorable windows, Quick Look and drag-out.
12. **The motion is already in Juno's tokens.** Claude's snap curve equals `ease-drawer`. Specifically:
    - card to panel is a poster `layoutId` morph on `duration-slow` + `ease-drawer`;
    - a version change is a `duration-fast` cross-fade, never a remount;
    - the change reveal fades on `duration-emphasis`;
    - skeletons appear only after a new `--delay-reveal: 500ms` token;
    - one breathing "Juno is working" state;
    - reduced motion keeps fades and drops travel.
13. **The owner dogfoods from Phase 2.** The public launch is Phase 4, when Docs and Decks arrive with the Design door already gone. That is Claude's pattern: new types land with the merge, and the toggle goes last.
14. **Guard rails:**
    - Every step sits behind reversible, per-account flags.
    - Redirects are 307 until the public launch, and 308 only after it.
    - Migrations are additive before any constraint flips.
    - A must-not-ship-before table (§13.3) that release review checks.
15. **Decisions the owner must make (§14.2, 20 in total, each with a recommended answer).** The ones that change the plan:
    - The Work hybrid.
    - Artifacts stays a sibling of Library.
    - Publish is a pinned snapshot, while grants give live access.
    - Regenerate never deletes: merge `7243613f` now.
    - Comments live in their own table.
    - One egress allowlist on every platform.
    - A reversible ban suspension, and a real legal contact.
    - Private chats keep Canvas off in v1.
    - The canonical URL is `/a/{id}`.
    - Spreadsheets are not a type in v1.
    - The release vehicle for the tolerant native build.

---

## 1. Thesis, principles, and what the owner experiences on day one

### 1.1 Thesis

**The conversation is the workshop. The artifact is the product.**

Anthropic's 16 September merge removed the question "which place does this belong in?" Claude reads the ask and makes a chat reply, runs a task, or makes a typed artifact. Whatever it makes is saved to the account and follows one path:

1. a card in the reply;
2. a panel beside the conversation;
3. full screen;
4. one link that opens on a phone.

Claude Design stopped being a destination and became one of four typed artifacts: Design, Docs, Slides and Design System. An **Output** picker and a **New artifact** button were added so people who know what they want can say so.

Juno already made the hard part of this move at the storage layer, by accident. A design is an `Artifact` row with `type DESIGN`. It shares versions, share tokens, the library and sync with pages, code and diagrams (00 §1.1). What Juno lacks is the lifecycle and the surface:

- Artifacts die with the message that made them (X-03, X-04, X-22).
- The model rewrites them from memory (X-05, X-06).
- Designs are invisible outside an editor (X-20).
- One design has four editors with two save semantics (00 §4.4).
- The Mac shows the tag body instead of the stored row (X-11, X-12).
- Deliverables live in a parallel universe (X-25 to X-29).

The Claude-faithful merge means three things:

- **Make the artifact the unit of identity.** It has an owner, a home, a stable id, versions and a trash.
- **Give it one surface in several sizes.** Design is a type, not a place.
- **Make the conversation the only way Juno changes it.** Juno reads what is actually there.

### 1.2 What Claude did, what Juno copies, and where Juno goes further

| Claude, 16 Sept 2026 [P] | Juno after the merge | Where Juno goes further |
|---|---|---|
| No mode choice before typing. Claude decides what to make | The model already decides (Canvas toggle removed 09-12, `route.ts:2104-2111`) | The card always names the type ("Deck · Q3 pipeline"), and the overflow menu offers "Make this a Doc instead". Settings has per-type off switches. This answers the top HN complaint about opaque routing (03 §2.3) |
| An **Output** picker in the message box | `+ › Make ▸` Design / Doc / Deck / Page / Diagram arms a pill beside `+`, the same way Deep research does (FLAT_UI §4) | The pill carries a size preset ("Design · Phone"), and the server forces the kind and model tier |
| An **Artifacts** tab with Filter by, a templates gallery and **New artifact** | `/artifacts`: type chips, scopes, server search, sort, cursor paging, a New split button, templates, and Recently deleted (reusing `/library` machinery) | A picture on every tile (Claude's gallery has none). Trash (Claude Docs: "There's no trash"). Deliverables and generated images appear by reference |
| Everything saved to the account (since 08-19) | `Artifact.userId`, a made-in conversation, a project, trash | Hand-made artifacts need no holder chat (fixes M29). Deleting a chat detaches its artifacts instead of destroying them |
| Card, panel, full screen, one link, phone | One `ArtifactSurface` keyed by id | Full window keeps the conversation or the composer, where Claude's full width hides the chat (03 §2.1). Picture-in-picture for live runs. A phone sheet that edits |
| Typed artifacts: Design, Docs, Slides, Design System | Design, Doc, Deck, Page, Design system, plus light kinds | Validated, invertible design operations instead of HTML string replacement (00 §8.1). Decks run on the design engine, so a slide *is* a frame |
| The model re-reads current files and changes only what was asked | A current-version digest in context; patches, block operations and design operations; compare-and-swap; people's edits win | Proposals are reviewable, each is one labelled undo entry and one version, and big changes open in Compare. Claude edits in place with no review |
| Share: audience, Latest or Specific version, roles by type | Share has two sections, **People** (grants) and **Publish to the web** (a pinned snapshot) | Opening the dialog writes nothing (Juno today publishes on open, L5). "Update to v11". Unpublish keeps the URL. A comment-only role on **every** type (Claude Docs has none) |
| Comments sent to Claude become a turn | The same | A comments table that survives versions, orphaned-anchor states, and payloads that carry the thread, anchor and crop |
| Docs and Design have "no version history yet" | **Every type ships with versions, a stepper, restore and trash** | Directly addresses Claude's most-cited gap (03 §2.3) |
| Mobile apps are view-only and cannot change sharing | A written **phone contract** | View, Play, comment, ask, tweaks, text edits, and revoking or changing links from the phone |
| Types ship as data (SKILL.md plus a runtime) | The registry holds each kind's authoring section, loaded only for kinds in play or armed. A client-contract header gates new kinds | Native down-conversion for old clients, where Claude falls back to "view-only" |
| Staged rollout, account by account, irreversible | Per-account flags, and redirects that are 307 until the public launch | Reversible at every phase (§13.4) |

**Deliberately not copied** (03 §8):
- the card lift, light sweep and under-sheet fan (ICONS_AND_MOTION §2.2 rule 1);
- a second colour for AI actions (FLAT_UI §2.4);
- hiding superseded cards at opacity 0 (Juno folds them into version receipts);
- a full-width mode that hides the chat;
- a blanket block on external images (PREMIUM_AUDIT §2e);
- keeping a standalone Design app beside the integrated one;
- unpublish that destroys data;
- an irreversible per-account switch;
- dropping branching.

### 1.3 Principles

1. **The conversation is the workshop; the artifact is the product.** Made things are born in a conversation and live in the account. A conversation can end, fork or be deleted, and what it made stays (R-004).
2. **One object, one id, one path.** Card, panel, full window, link and phone are one component in one state at different sizes. No entry point opens a second editor (R-016; U2).
3. **Types, not places.** A new type exists only when its **document root** or **the way it is consumed** differs: a canvas of frames, a flow of blocks, a sequence you present, a running page, or a token set. Prototype, Motion, Inspect, Present and Draw are **modes** of a type, never types or destinations (R-008; U3; Figma's rule in 03 §3.3).
4. **Juno edits what is there, not what it remembers.** Every turn reads the current version and writes a targeted change against it. When a person and Juno touch the same thing, the person's edit wins and Juno says so (R-009).
5. **Nothing made is lost.**
   - Every change is a version.
   - Edit and regenerate make siblings, never deletions.
   - Every delete can be undone for 30 days.
   - A stopped or truncated output never becomes current (R-004 to R-007).
6. **Every made thing has a picture.** A server-rendered poster on every card, tile, list row, share page, unfurl and Quick Look. JSON never appears by default (R-014; L2).
7. **Public is a deliberate act, and ships with its safeguards.** Sharing with people and publishing to the web are separate. A published link is a pinned version. No scripted public page exists without takedown, report and egress control (R-011, R-012, R-015).
8. **Say what each device can do, and make the phone useful.** One honest phone contract that does more than Claude's, and Mac artifacts that behave like Mac documents (R-068, R-069).

### 1.4 The owner's day one

The owner's day one is the morning the `artifacts.merged` flag set turns on for their account. That is the end of Phase 3 (§13), about two weeks of dogfooding before Docs and Decks arrive.

1. **Sidebar.** The Chat sidebar reads: New chat · Search · Library · Projects · **Artifacts** · More. There is no Design row. The old Design bookmark (`/design`) lands on **Artifacts** filtered to **Designs**, with a one-time line "Designs now live in Artifacts" and the four presets pinned at the top.
2. **Asking.** The owner types "Design a sign-in screen for the Juno iPhone app. Warm, quiet." The reply opens with one line. A card appears:
   - it reads **Design · Sign-in screen** and says "Making a design · 1 of 2 frames";
   - the panel docks beside the transcript, without taking focus;
   - hairline frame outlines at 390×844 appear, then fill in as operations land.
   There is no JSON anywhere, not on the card, the tile, the share page or the phone.
3. **Editing by hand.** In the panel the owner changes the CTA colour in the inspector. The header shows "Saved". The change folds into the working head, not into a rewritten version.
4. **Following up.** "Make the title bigger and the CTA quieter." Juno reads the current state, including the owner's colour change:
   - Because the design has hand edits, the change arrives as an **edit card**: "Quieter CTA, larger title · 4 layers · Review".
   - The canvas outlines the four changed nodes. Holding B shows the before state. **Apply** makes v4, which is one undo entry.
   - The owner's colour is kept, and Juno says so in one sentence.
5. **Expanding.** ⌘⇧↩ grows the panel into the full window at `/a/{id}?from=chat`:
   - the conversation collapses into a left column;
   - the composer stays;
   - undo, selection and zoom survive, because it is the same mount.
6. **Versions.** "‹ v4 ›" in the header opens the version list: You, Juno (with the model name) and Restore rows with thumbnails, and "From this message" links. Viewing v2 is read-only in the same renderer. **Restore as v5** never loses v4.
7. **Sharing.** Opening Share writes nothing:
   - **Publish v4** creates the public link, and the header button now reads **Shared** with a filled globe.
   - The owner makes another edit, and the dialog reads "Published v4 · v5 has changes · Update to v5".
8. **Phone.** The owner opens the link on the iPhone:
   - the Juno app opens the artifact as a sheet;
   - the design can be pinched, played, commented on (after Phase 5) and asked about by voice;
   - text and colour can be edited through fields, once R-069 lifts the R-002 guard.
9. **Mac.**
   - The Mac chat shows the same card, with the poster drawn from the stored row.
   - The dock is the same surface, backed by that row (already built in glass stage 3).
   - ⌘-click opens the design in its own restorable window.
   - Space in Artifacts shows it in Quick Look.
10. **Tidying.** Deleting the chat shows "3 artifacts made here stay in Artifacts". Deleting the design shows "Moved to Recently deleted · Undo". The public link then answers 410 until the design is restored, and restoring brings back the same URL.
11. **Tasks.** A delegated "Build me a pricing spreadsheet and a one-page brief" task finishes. Its run card lists **Doc · Pricing brief** (a real Doc) and **File · pricing.xlsx**. Both also appear in Artifacts: Docs and Files.

**Not there yet on day one** (and said plainly in the UI, never shown as disabled controls):
- Docs and Decks as new types, Play and Present: Phase 4.
- Comments, people grants and notifications: Phase 5.
- Design systems: Phase 6.

---

## 2. The object model

### 2.1 What an artifact is after the merge

> **An artifact is an account-owned, typed, versioned object that Juno or a person made.** It has one stable id, one owner, an optional *made-in* conversation, an optional project, a mutable working head, immutable sealed versions, an optional published version, access grants, comments, and derived exports. Its type is fixed for life, except through a registered lossless upgrade.

What is **not** an artifact, and why:
- **An uploaded file** is Library material: you brought it; Juno did not make it.
- **An inline visual** (`juno-visual`, inline Mermaid) is an ephemeral explanation. "Open as artifact" promotes it (R-077). This is Claude's rule: inline visuals are "not artifacts".
- **A PR or diff** belongs to Code.
- **A Pyodide blob** is a sandbox by-product.

### 2.2 The ten made-thing systems (00 §4.1), and what happens to each

| # | Today | After the merge | Stored as | Listed in Artifacts |
|---|---|---|---|---|
| 1 | Chat artifact (HTML, REACT, CODE, MARKDOWN, SVG, MERMAID) | Page, Code, Doc (Markdown), Graphic, Diagram | `Artifact` | yes |
| 2 | DESIGN artifact | Design | `Artifact` + `ArtifactHead` | yes |
| 3 | Work deliverable | `document`, `report` and `presentation` become **Doc** and **Deck** artifacts. Binaries stay `WorkArtifact` | `Artifact` + `ArtifactExport`; `WorkArtifact` | yes; binaries by reference under **Files** |
| 4 | Generated media | Image, by reference; it stays an `Attachment` | `Attachment` (`origin: generated`) | yes, under **Images** (also in Library) |
| 5 | Uploads, sources, knowledge | Unchanged: Library | `Attachment`, `KnowledgeDocument` | no |
| 6 | Research report (three copies) | One **Doc** per run (identifier `research-report-{runId}`, fixing M1). `ResearchReportRevision` becomes that Doc's versions | `Artifact` | yes |
| 7 | Inline visual blocks | Ephemeral, with "Open as artifact" | `Message.content` | only after promotion |
| 8 | Share snapshot | A published version pointer plus people grants | `Share.versionId`, `ArtifactGrant` | as the Published state |
| 9 | Code outputs | Unchanged: Code | CodeTask | no; the Code sidebar keeps its Artifacts row (M27 fixed) |
| 10 | Sandbox outputs | Unchanged: ephemeral | none | no |

### 2.3 The type charter and registry

**The charter,** written to a new `docs/design/ARTIFACT_TYPES.md`:
- A type exists only when its document root or the way it is consumed differs.
- Everything else is a mode, a runtime or a light kind.

**The registry** (`src/lib/artifact-kinds.ts`) is the single source for everything a surface needs to know about a kind:
- the noun, plural and filter chip;
- the glyph and its one `data-motion` gesture;
- editor, runtime, streaming renderer and poster strategy;
- exporters, the AI edit verb, the comment-anchor kind, share roles and capabilities;
- the "New" label;
- the model's authoring section, which is Juno's SKILL.md.

It is generated into Swift (`JunoArtifactKinds.swift`, the way tokens are) and into the OpenAPI `ArtifactKind` enum. A lint rejects any other type-to-glyph or type-to-label map. That retires the four web maps and three Swift naming tables (00 §5; `artifacts/page.tsx:41-60`, `artifact-preview.tsx:36`, `artifact-inline-card.tsx:49`, `session-outputs.tsx:53-61`, `DesktopArtifactCanvas.swift:153-194`, `JunoMobileInlineArtifact.swift:144-166`). A test binds the registry to the Prisma `ArtifactType` enum and the OpenAPI enum.

#### Core types (document roots)

**Design** (enum `DESIGN`, filter "Designs"; exists today)

| Aspect | Specification |
|---|---|
| Body | `DesignDocument` v1: pages, then top-level frames and scene nodes, variables, components, motion, interactions. Assets move to an external store (R-064) |
| Editor | The one `DesignEditor` bundle. Surfaces: panel and window, sized by container (R-017). Hosted on Mac and iPhone over bridge v2 (R-060) |
| Renderer and runtime | `renderPageSvg` (static). The motion runtime for Play (R-019) |
| Streaming | Operations stream as NDJSON: frame outlines first, then children |
| Poster | The cover frame's SVG, drawn at `posterTimeMs` |
| Exports | PNG @1–3×, SVG, PDF, HTML prototype, React, SwiftUI, tokens, JSON, and the handoff bundle, which feeds "Build it with Juno Code" |
| AI edit verb | Design operations: the 37 operations plus the agent-shaped `query`, `tree` and `setMany` |
| Comment anchor | `{pageId, frameId, nodeId, dx, dy}` |
| Roles | View · Comment · Edit |
| Capabilities | versions, head, comments, assets, exports, play, tweaks, inspect |
| Mac | Edit through transactions, with autosave |
| iPhone | View, Play, comment, ask, tweaks, and text or colour field edits. Read-only until R-069 lifts the R-002 guard |

**Doc** (enum `DOC`, filter "Docs"; new in Phase 4)

| Aspect | Specification |
|---|---|
| Body | A block document: tabs of blocks, each with a stable id (heading, paragraph, list, task, table, chart, mermaid, callout, image, divider) and inline chips. It has a Markdown projection |
| Editor | Doc editor: reading measure, `/` to insert a block, tabs as a menu in the panel and an outline in the window |
| Renderer | Juno prose, reusing the Markdown renderer |
| Streaming | A skeleton of pending blocks, each showing its intent, filled one section at a time in reading order |
| Poster | The title plus about 8 typeset lines |
| Exports | .docx and .pdf through one OOXML renderer; .md |
| AI edit verb | Block operations (insert, update, move, delete, setTab), with an exact-anchor patch inside a block |
| Comment anchor | `{tabId, blockId, quote, prefix, suffix}` |
| Roles | View · Comment · Edit |
| Capabilities | versions, head, comments, exports |
| Mac and iPhone | A native block view with plain-text editing |

**Deck** (enum `DECK`, filter "Decks"; new in Phase 4)

| Aspect | Specification |
|---|---|
| Body | A `DesignDocument` with `profile: "deck"`: one Slides page of ordered 1920×1080 frames, sections, notes, transitions and builds |
| Editor | `DesignEditor` in its deck profile: a slide strip and a Slide/Animate panel. ⇧D reveals the full design rails |
| Renderer and runtime | `renderPageSvg` per slide. Present runs on the Play runtime |
| Streaming | Slide outlines titled first, then each slide filled in |
| Poster | Slide 1 |
| Exports | .pptx with native text and shapes, .pdf, and a PNG per slide |
| AI edit verb | Design operations plus deck operations (addSlide, reorder, setTransition, setNotes) |
| Comment anchor | `{slideId, nodeId, x, y}` |
| Roles | View · Comment · Edit |
| Capabilities | versions, head, comments, exports, present, tweaks (theme) |
| Mac | Present, including a presenter window on a second display |
| iPhone | Present with notes, comment, text edits |

**Page** (enums `HTML` and `REACT`, filter "Pages"; the meta line shows "HTML" or "React"; exists today)

| Aspect | Specification |
|---|---|
| Body | Single-file HTML or TSX |
| Editor | Preview, the Code tab (`code-surface.tsx`) and Console. Visual property editing comes later (R-044) |
| Runtime | The sandbox on the preview origin (R-012) |
| Streaming | Checkpoints rendered into a hidden second iframe, then cross-faded in (R-013) |
| Poster | A headless 1280×800 capture |
| Exports | Source file, .zip, and "Build it with Juno Code" |
| AI edit verb | A patch of up to 12 exact anchors (`artifact-edit.ts`) |
| Comment anchor | `{cssPath, xpath, textQuote, point%}` |
| Roles | View · Comment · Edit |
| Capabilities | versions, comments, play (interact), tweaks (`data-juno-tweak`). Later: ask and data (R-076) |
| Mac and iPhone | The runtime follows the network-policy decision (§9.8) |

**Design system** (enum `DESIGN_SYSTEM`, a "Design systems" chip that appears only when one exists; new in Phase 6)

| Aspect | Specification |
|---|---|
| Body | Tokens (DTCG 1.0, including timing and easing), styles, components, a README and assets. A DESIGN.md is generated from it |
| Editor | A review screen, plus `DesignEditor` for components |
| Renderer | Specimens |
| Poster | A palette and type specimen card |
| Exports | DTCG JSON, DESIGN.md, CSS variables, Tailwind and Swift token files |
| AI edit verb | Token and component operations |
| Comment anchor | `{tokenId | componentId}` |
| Roles | View · Comment · Edit, with an admin lock |
| Capabilities | versions, install, default-for-new |
| Mac and iPhone | A read-only viewer |

#### Light kinds (stand alone, or embedded later, R-080)

| Kind | Noun · filter | Body and editor | Renderer, poster, exports | AI verb · anchor · roles | Status |
|---|---|---|---|---|---|
| `CODE` | Code · Code | Text with a language, edited in CodeSurface | JS/Python console where supported; otherwise source. Poster: a highlighted excerpt. Export: the source file | Patch · `{startLine, endLine, contentHash}` · V/C/E | exists |
| `MERMAID` | Diagram · Diagrams | Mermaid source; Code plus Preview | Mermaid on the preview origin, bundled on Mac (glass stage 3). Poster: the drawing, rendered server-side. Exports: SVG, PNG, .mmd | Patch · region · V/C/E | exists |
| `SVG` | Graphic · Diagrams | SVG source | The image. Exports: SVG, PNG | Patch · region · V/C/E | exists |
| `MARKDOWN` | Doc (Markdown) · Docs | Legacy Markdown; opens in the Doc reader | Prose. Poster: title plus lines. Exports: docx, xlsx, pptx, as today | Patch · text quote · V/C/E | exists. **Upgrade to Doc** is lossless, runs on the server, and records version origin `upgrade` |
| Image (reference) | Image · Images | An `Attachment` with `origin: generated`. Viewer with the edit overlay | The pixels. Poster: the image. Export: download | An image-edit turn · region · follows the chat's sharing | exists, indexed by reference |
| File (reference) | File · Files | `WorkArtifact` bytes: .xlsx, .pdf, bundle, archive, image, site .zip | Spreadsheet preview, site preview on the preview origin, Quick Look on Mac. Poster: first sheet or page, or the Quick Look thumbnail. Export: a hash-verified download | Juno produces new versions through a task · no anchor · owner only in v1 | Phase 4, indexed by reference |

**The spreadsheet decision.** Spreadsheets are a **File** kind in v1, and SHEET is a candidate type for later:
- Claude has no Sheets type.
- A spreadsheet's document root (a grid of typed cells) needs its own editor, which is out of proportion to the merge.
- The Work spreadsheet spec (`src/lib/work/deliverables/spreadsheet.ts`) is **persisted as source from Phase 4**, so a SHEET type can arrive later without losing data.

**Site zips** from Work stay Files. "Open as Page" imports `index.html` as a Page.

### 2.4 Capabilities: Claude's model, Juno's version

Claude's typed artifacts declare runtime capabilities: `artifact`, `assets`, `comments`, `db`, `downloads`, `room`, `user`, `mcp` and `sample` (primary evidence). The registry declares Juno's equivalents per kind, and **the surface draws a control only when its capability exists**. This enforces `MACOS_PRODUCT_SPEC.md:40-42`, which 00 §3.2 row 14 found violated.

| Capability | Meaning in Juno | Kinds (v1) | Claude equivalent |
|---|---|---|---|
| `versions` | Immutable sealed versions, a stepper, compare, restore | all | `artifact` (Claude Docs and Design lack the UI) |
| `head` | An autosaved working copy that seals into versions | Design, Doc, Deck, Design system | self-saving pages |
| `comments` | Anchored threads in `ArtifactComment` | all except Image and File (Phase 5) | `comments` |
| `assets` | A content-addressed asset store with capability-scoped URLs | Design, Deck, Doc | `assets` |
| `exports` | Derived files, validated before they are served | all | `downloads` |
| `play` | Runs in the Play runtime | Design, Deck (Present), Page (Interact) | Play mode |
| `tweaks` | Lasting controls bound to variables or CSS properties, with no model call | Design, Deck, Page (Phase 6 for Page) | Tweaks (`data-props`) |
| `inspect` | Code, tokens and measurements for handoff | Design, Deck | — |
| `room` | Presence (phase 2 of R-074) | later | `room` |
| `ask` / `data` | The page can call Juno, or keep per-artifact data (R-076) | later; never on public links | `sample` / `db` |
| `connectors` | Viewer-scoped connector data | later; never public | `mcp` |

### 2.5 Identity, ownership and lifetime

**Identity.**
- `Artifact.id` (a cuid) is permanent. It is what `/a/{id}`, shares, grants, comments, search and native deep links use.
- `identifier` stays, unique per `(conversationId, identifier)`, so the model can address "sign-in-screen" within a conversation. Postgres treats NULLs as distinct, so hand-made artifacts never collide.
- **Type is immutable per id.** If the model re-emits an identifier with a different type, the result is a **new** artifact with `derivedFromId`, never a mutated row (fixes M11 and X-11-class 404s). The one exception is a registered lossless upgrade (MARKDOWN to DOC), run on the server, with version origin `upgrade`.
- **The title is sticky** once a person renames it (`titleSource = "user"`).

**Ownership.**
- `userId` (the owner) is required.
- `conversationId` means *made in*. It is nullable and set to NULL when the conversation is deleted.
- `projectId` is inherited from the made-in chat at creation and changed with "Move to project".
- `createdInMessageId` is provenance only, **never a delete key**. The unmerged fix `7243613f` already stops using it as one.
- Every artifact route authorises through one helper, `canAccess(artifact, user, action)`, which reads `userId`, and grants from Phase 5.
- `Artifact` joins the Prisma ownership guard (`src/lib/db.ts:22-25`).

**What happens to an artifact when…**

| Event | Today | After the merge |
|---|---|---|
| The model re-emits the identifier | Appends a version, but overwrites title and type (`artifacts-store.ts:61-67`) | Appends a version. The title is kept if the user renamed it. A type change becomes a new artifact |
| An earlier message is edited | Hard delete (X-03), fixed on `7243613f` | The artifact is untouched. Phase 0 detaches it. From Phase 3, the edit branches, and versions made on an abandoned branch are labelled "From an earlier reply" (R-029) |
| An answer is regenerated | Hard delete, and the re-emit gets a new id (X-04) | The same id. Phase 0 detaches and re-claims it (`7243613f`). Phase 3 makes the output a sibling "Try 2", and "Use this" makes it main |
| A conversation is deleted | Cascades to artifacts, designs and shares (X-22) | Artifacts are detached (`conversationId` NULL). The dialog says "3 artifacts made here stay in Artifacts", with an unchecked "Also move them to Recently deleted" |
| The artifact is deleted | Hard delete of versions and shares | `deletedAt` is set, and the artifact sits in Recently deleted for 30 days. Links answer 410, grants are suspended, comments are hidden. Restore brings all of it back, including the same share token |
| The account is deleted | Deliverable objects are left in the bucket (X-26) | Immediate purge of rows **and** storage objects, including exports and posters |
| A conversation is forked | Artifacts are dropped (`fork/route.ts:17-27`) | The fork carries them **by reference**, and the fork's first turn sees their digest |
| A hand-made artifact is created | An empty holder chat is created, non-atomically (M29) | No conversation until the first Ask, which creates the made-in chat titled after the artifact (R-027) |
| The owner downgrades plan | — | Artifacts become read-only above quota, and are never hidden or unexportable (R-067) |

### 2.6 Versions: working head, sealed versions, published pointer, branches

Juno has two versioning semantics in one table: append-only for artifacts, and fold-in-place for designs (`store.ts:179-203`, checked). The fold-in-place leaks into share snapshots (M31) and syncs a full body on every fold (M35). The merge replaces it with one model.

```
              hand edits (autosave · design ops · doc ops)
                        │
 v7 ─────▶  ArtifactHead { baseVersion: 7, revision: 41, dirty }       (mutable, not change-captured)
                        │  seal on: 90 s idle · close · before a Juno turn reads ·
                        │           share/publish · restore · bulk op (> 60 ops)
                        ▼
                 v8  authorKind=user            (immutable, synced, pinnable)
                        │
 Juno turn read v8 ── proposal ── Apply ──▶ v9  authorKind=model, messageId=m123, complete=true
 Try again ─────────────────────────────▶ v10 branchId=b1 ("Try 2") ── Use this ──▶ v11 (origin merge)
 Stop mid-revision ─────────────────────▶ v12 complete=false  → never current; "Keep v11 · Continue v12"
 Share.versionId ──────────────────────▶ v9   "Published v9 · v11 has changes · Update to v11"
```

**The rules:**
- **Sealed versions are immutable.** Nothing ever rewrites a version row again: remove `rewriteVersion`, and make `store.ts` fold into the head.
- **`currentVersion` is the newest complete version on main.** A `complete=false` version can be viewed, labelled "Draft, incomplete", and continued, but it never becomes current (fixes X-07).
- **Restore** seals the head first, then appends a copy as a new version with origin `restore`. It never rewinds the revision (fixes M10).
- **Retention.** Named, published, commented, model-authored and restore versions are kept forever. Unnamed user autosaves are pruned on a per-plan schedule (§14.2 D17), which addresses X-33.
- **Viewing** a version is a read-only state of the same mount ("Viewing v5 · Restore as v12 · Compare · Back to latest"). It is never a remount (R-013).
- **Links carry a version.** `?v=` is honoured everywhere (M28). Chat receipts pin the version their turn made (L9).

### 2.7 Provenance

Each version records:
- `authorKind`: model, user, restore, agent (a Work runner) or system;
- `authorId`;
- `model` when the author is the model;
- `messageId`, which answers "From this message";
- `runId` for Work;
- `provenance` in the `WorkArtifactVersion.provenance` shape: sources, files and connectors read, and tools that ran;
- `derivedFrom` for Duplicate, Turn into and Promote.

This surfaces as "How this was made" in the version popover, with "View in conversation" (R-073; C5). **Sharing an artifact never shares its conversation.** An explicit, off-by-default switch in People does (R-073).

### 2.8 Soft delete, trash and purge

- `Artifact.deletedAt`, plus a nightly purge job 30 days later.
- **Recently deleted** sits at the foot of Artifacts and reuses LibraryBrowser's deleted view (`library-browser.tsx:59`; `api/library/route.ts:37-171`).
- **Delete now** is the only permanent action, behind a destructive confirmation.
- On the Mac, ⌘⌫ is undoable through `NSUndoManager`. On the iPhone, swipe to delete, with an Undo snackbar (R-006).
- Comments are soft-deleted as well: the author gets a 10 s Undo, and the owner can restore.

---

## 3. Data model and migrations

### 3.1 Prisma changes

All migrations are additive first (§3.6). Comments marked NEW or CHANGED are the diff against `prisma/schema.prisma:1135-1170` (checked).

```prisma
enum ArtifactType {           // append only; ordinals untouched
  HTML
  REACT
  CODE
  MARKDOWN
  SVG
  MERMAID
  DESIGN
  DOC            // NEW (Phase 4)
  DECK           // NEW (Phase 4)
  DESIGN_SYSTEM  // NEW (Phase 6)
}

enum ArtifactStatus { DRAFTING READY }   // NEW: a row exists from the skeleton on (R-033)

model Artifact {
  id                 String         @id @default(cuid())
  userId             String         // NEW. Owner. Backfilled from conversation.userId
  conversationId     String?        // CHANGED: "made in". Was required + onDelete Cascade
  projectId          String?        // NEW
  createdInMessageId String?        @map("messageId") // RENAMED in Prisma only; column kept; never a delete key
  identifier         String
  title              String
  titleSource        String         @default("model") // NEW: "user" once renamed (M11)
  type               ArtifactType   // immutable per id, except registered upgrades
  language           String?
  status             ArtifactStatus @default(READY)   // NEW
  currentVersion     Int            @default(1)       // newest COMPLETE version on main
  coverNodeId        String?        // NEW: "Set as thumbnail" (Design, Deck)
  posterTimeMs       Int?           // NEW: poster after on-enter motion settles
  derivedFromId      String?        // NEW: Duplicate / Turn into / Promote / type change
  derivedFromVersion Int?           // NEW
  deletedAt          DateTime?      // NEW: Recently deleted
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt

  user         User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  conversation Conversation?     @relation(fields: [conversationId], references: [id], onDelete: SetNull)
  project      Project?          @relation(fields: [projectId], references: [id], onDelete: SetNull)
  message      Message?          @relation(fields: [createdInMessageId], references: [id], onDelete: SetNull)
  head         ArtifactHead?
  versions     ArtifactVersion[]
  shares       Share[]
  comments     ArtifactComment[]
  grants       ArtifactGrant[]
  exports      ArtifactExport[]

  @@unique([conversationId, identifier])
  @@index([userId, deletedAt, updatedAt])
  @@index([projectId, deletedAt])
  @@index([conversationId])
}

model ArtifactVersion {
  id            String   @id @default(cuid())
  artifactId    String
  version       Int                       // one monotonic sequence per artifact, all branches
  content       String   @db.Text         // stays NON-NULL: old native builds decode it as String
  origin        String?  // generated | edit | restore | merge | import | promoted | upgrade | suggestion
  authorKind    String?  // NEW: model | user | restore | agent | system
  authorId      String?  // NEW
  model         String?  // NEW
  messageId     String?  // NEW: the turn that produced it (L9)
  runId         String?  // NEW: WorkRun, for task-made versions
  complete      Boolean  @default(true)   // NEW: false = stopped / truncated / refused draft (X-07)
  label         String?  // NEW: "Draft to legal"
  note          String?  // NEW: change summary shown on edit cards and in history
  branchId      String?  // NEW: null = main (R-029)
  parentVersion Int?     // NEW
  contentHash   String?  // NEW: sha256 (poster cache key, anchor re-resolution, dedupe)
  byteSize      Int?     // NEW
  provenance    Json?    // NEW: sources/tools (WorkArtifactVersion.provenance shape)
  createdAt     DateTime @default(now())

  artifact Artifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)

  @@unique([artifactId, version])
  @@index([messageId])
}

/// The mutable working copy (replaces fold-in-place, store.ts:179-203).
/// Deliberately NOT change-captured: no sync trigger, no share visibility.
model ArtifactHead {
  artifactId  String   @id
  baseVersion Int                      // the sealed version it started from
  revision    Int      @default(0)     // compare-and-swap counter (bridge baseRevision)
  content     String   @db.Text
  dirty       Boolean  @default(false)
  updatedById String?
  updatedAt   DateTime @updatedAt
  artifact    Artifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  @@index([dirty, updatedAt])          // the sealing sweeper
}

model ArtifactExport {                 // NEW: derived files per version (Office, PDF, zip)
  id          String   @id @default(cuid())
  artifactId  String
  version     Int
  format      String                   // docx | pptx | xlsx | pdf | zip | png | svg …
  storageKey  String
  byteSize    Int
  contentHash String
  validation  Json?                    // the validate.ts verdict, same shape as WorkArtifactVersion
  createdAt   DateTime @default(now())
  artifact    Artifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  @@unique([artifactId, version, format])
}

model ArtifactComment {                // NEW (Phase 5) — fields per R-040
  id                String    @id @default(cuid())
  artifactId        String
  threadId          String
  parentId          String?
  authorId          String?            // null = Juno
  body              String    @db.Text // ≤ 4 KB markdown
  images            Json      @default("[]")
  anchor            Json               // per-kind anchor from the registry
  anchorState       String    @default("exact") // exact | moved | lost
  createdOnVersion  Int
  snapshotKey       String?            // PNG crop at comment time
  toJuno            Boolean   @default(false)
  sentAt            DateTime?
  junoTurnMessageId String?
  producedVersion   Int?
  answered          Boolean   @default(false)   // stops a second session answering twice
  resolvedAt        DateTime?
  resolvedById      String?
  deletedAt         DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  artifact          Artifact  @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  @@index([artifactId, threadId])
  @@index([artifactId, resolvedAt, deletedAt])
}

enum ArtifactRole { VIEWER COMMENTER EDITOR }

model ArtifactGrant {                  // NEW (Phase 5) — R-039
  id          String       @id @default(cuid())
  artifactId  String
  userId      String?                  // a user principal
  email       String?                  // a pending invite
  projectId   String?                  // inherited from a project
  role        ArtifactRole
  grantedById String
  acceptedAt  DateTime?
  expiresAt   DateTime?                // pending invites: 30 days
  suspendedAt DateTime?                // while the artifact is in the trash
  createdAt   DateTime     @default(now())
  artifact    Artifact     @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  @@index([artifactId])
  @@index([userId])
}

model ArtifactOpen { userId String; artifactId String; openedAt DateTime @default(now()); @@id([userId, artifactId]) }  // Recents; throttled 1/min
model ArtifactPin  { userId String; artifactId String; position Int; createdAt DateTime @default(now()); @@id([userId, artifactId]) }

model Share {                          // CHANGED
  // … existing fields (share.ts; schema.prisma:1818-1840) …
  versionId      String?     // NEW: pins an immutable ArtifactVersion (backfilled from snapshotAt)
  suspendedAt    DateTime?   // NEW: ban / takedown; reversible
  suspendReason  String?     // NEW
  unpublishedAt  DateTime?   // NEW: the token is reserved, so republishing restores the same URL
  expiresAt      DateTime?   // NEW: on every plan
  opensIn        String      @default("canvas") // NEW: canvas | play
  mayHaveLeaked  Boolean     @default(false)    // NEW: backfill flag for fold-era DESIGN snapshots (M31)
  // `views` stops being written (it fires the sync trigger, M33); see ShareViewDaily
}

model ShareViewDaily { shareId String; day DateTime @db.Date; views Int; people Int; @@id([shareId, day]) }  // NEW; bots and owner excluded, no IPs

model ModerationFlag {                 // CHANGED
  // … existing …
  userId     String?   // CHANGED: nullable, SetNull, so the flag survives account deletion (X-31)
  subjectKey String?   // NEW: a hash of the deleted user, for repeat-offender checks
  artifactId String?   // NEW
  shareId    String?   // NEW
}

model ModerationReport {               // NEW: the public Report link
  id String @id @default(cuid()); shareId String; reason String; detail String? @db.Text
  status String @default("open"); createdAt DateTime @default(now())
  @@index([shareId, status])
}

model WorkArtifact {                   // CHANGED (narrowed; §11)
  // … existing …
  conversationId String?  // NEW: denormalised from WorkSession for the Artifacts index
  artifactId     String?  // NEW: set when the deliverable IS a Doc or Deck (its export lives in ArtifactExport)
  specVersion    Int?     // NEW: the persisted typed spec (no longer thrown away, M72)
}
```

Other schema changes:
- `ProjectMember.role` becomes a validated enum (`OWNER | EDITOR | COMMENTER | VIEWER`), fixing L71.
- `capabilities.ts:49-55` stops calling the unused CRDT "stable".

### 3.2 One write service, instead of five paths into one table (00 §4.6)

`src/lib/artifacts/write.ts` becomes the only module that writes `Artifact`, `ArtifactHead` or `ArtifactVersion`. Every write validates by kind through the registry, is a compare-and-swap on a version or head revision, is rate-limited, and records provenance.

| Path today | After |
|---|---|
| `persistArtifacts` (chat turn) | `write.appendModelVersion({ baseVersion, content \| patch \| ops, messageId, complete })`. The base is the version the turn read. A 409 re-reads and retries once, keeping the human's edits (§8.3) |
| `persistTargetedArtifactEdit` | The same call. It is already compare-and-swap (`artifacts-store.ts:103-127`, checked) |
| Generic `POST /api/artifacts/[id]` | `write.appendUserVersion`, **with per-kind validation**. A DESIGN body must parse and validate against the schema, or it is refused (fixes Mac M9 and M10). Native builds keep calling it until bridge v2 moves them to transactions |
| `POST /api/design/[id]/transactions` | `write.commitHead({ ops, baseRevision })`, which folds into the **head**, never into a version |
| `POST /api/design` (holder chat) | `POST /api/artifacts { kind, preset, projectId? }`, atomic, with no conversation (fixes M29) |
| Work `create_deliverable` (document, report, presentation) | `write.create` / `appendModelVersion` for DOC or DECK, with `runId` and provenance, plus an `ArtifactExport` for the Office file |
| The research writer and citation audit (L7) | `write.create` or `appendModelVersion` against the run's own Doc |

`DESIGN_TOOLS` (`ai.ts:256-270`), which is dead code today, becomes the tool contract (§7.5; R-032).

### 3.3 Backfills (batched at 10k, idempotent, measured first)

**0. Read-only counts before any write** (open question Q9):
- `ArtifactVersion` rows with more than 200k UTF-16 units;
- DESIGN shares;
- holder chats (conversations with artifacts and zero messages);
- versions with `origin` null.

**1. Owner and project.**
```sql
UPDATE "Artifact" a SET "userId" = c."userId", "projectId" = c."projectId"
FROM "Conversation" c WHERE a."conversationId" = c.id AND a."userId" IS NULL;
```

**2. Holder chats.** For conversations with no `Message` rows whose artifacts are all DESIGN:
- set `Artifact.conversationId = NULL`;
- delete the conversation;
- log the ids for rollback.

**3. Version authors.**
- `origin='generated'` with `Artifact.messageId IS NULL AND version=1` becomes `authorKind='user'` (hand-started designs, `api/design/route.ts:88`).
- Other `generated` versions become `model`, `edit` becomes `user`, and `restore` becomes `restore`.
- v1's `messageId` comes from `Artifact.messageId`. Later versions are left NULL ("Unknown turn"), which is honest rather than guessed.

**4. Hashes.** `contentHash` and `byteSize` for every version (a CPU batch job off the request path).

**5. Share version pins.** `Share.versionId` is set to the highest version with `createdAt ≤ snapshotAt`. DESIGN shares whose pinned version has origin `edit` get `mayHaveLeaked = true`, because the 30 s fold may already have rewritten that row (M31). The owner decides whether to tell affected users (§14.2 D9).

**6. Heads.** A DESIGN whose newest version is a recent `edit` fold gets an `ArtifactHead` with `content` equal to that body. From then on, folds go to the head.

**7. Oversized rows.** Rows over the cap get `status` left as is and a `notes` flag. The native tolerant build skips them (X-09). Their owners see "Large design · move images to asset storage" on the web (R-064).

**8. Design comments.** `DesignDocument.comments` rows become `ArtifactComment`. This is expected to be zero, because nothing writes them.

### 3.4 Sync and native contract changes

**Entity changes:**

| Entity | Change |
|---|---|
| `artifact` | Add `userId`, `projectId`, `deletedAt`, `status` and `titleSource`. `conversationId` becomes optional |
| `artifact_version` | Add `origin` (fixes L6), `authorKind`, `complete`, `label`, `note`, `branchId` and `messageId`. For clients at `artifacts=2`, **only the current version carries `content`**; older bodies are fetched on demand (fixes M35; §12) |
| `artifact_comment`, `artifact_grant` | New entity types, in the allowlist in release N1, emitted in Phase 5 |
| `share` | Add `versionId`, `suspendedAt`, `unpublishedAt` and `expiresAt`. Stop the `views` increment (M33) |
| `artifact_head` | **Not synced.** Clients fetch the head over REST when opening an editor; sync carries sealed versions only |

**Loaders.** `sync-entities.ts:227-260` authorises artifacts through `artifact.conversation.userId` (checked). That changes to `artifact.userId` **in the same deploy** that makes `conversationId` nullable.

**The client contract header.** Every native and web request sends `X-Juno-Client: <platform>/<version> (<build>); artifacts=<n>`. For clients below `artifacts=2`, the server:
- down-converts `DOC` to `MARKDOWN` (its Markdown projection) and `DECK` to `MARKDOWN` (an outline plus "Open this deck on the web");
- omits `DESIGN_SYSTEM`;
- omits artifacts with a NULL `conversationId`, because old builds decode it as non-optional;
- keeps sending full `content` for every version;
- rewrites reference tags in the `message` entity back into full tag bodies (§7.5).

**OpenAPI.** `contracts/openapi/juno-native-v1.yaml:1866-1868` adds DESIGN, DOC, DECK and DESIGN_SYSTEM, and declares `/api/design`, `/api/share` and the new `/api/artifacts/*` routes (fixes L23 mac). A test binds the OpenAPI enum to Prisma and the registry.

**Swift design document.** Carry unknown `DesignDocument` fields as opaque JSON until the Swift mirror is generated from `contracts/design/design-document.v1.schema.json` (X-14). Glass stage 3 added `cornerSmoothing`; the opaque carry stops the next drift too.

### 3.5 Contract ship order (what must land where, in sequence)

| Step | Where | What | Gate to move on |
|---|---|---|---|
| **N0** | server | Phase 0 fixes with no contract change (X-02, X-03/X-04 via `7243613f`, X-07 minimal, X-08, governance, preview origin) | Chromium CI renders React under production headers; lifecycle tests green on `main` |
| **N1** | **Mac 1.6.x + iPhone, cut from `main`** | The tolerance release: unknown kinds become `.unsupported(kind)` (poster plus "Open on the web"); oversized or corrupt rows are skipped; `conversationId`/`projectId`/`deletedAt` and every new version field are optional; `artifact_comment` and `artifact_grant` are allowlisted; the `artifacts=2` header; opaque design fields; the fixed H10 envelope reader; the `design:editor:check` gate in `native.yml` and `release-macos.*` | ≥ 95% of active native devices send `artifacts=2`, **or** 30 days plus an update prompt for older builds |
| **N2** | server | Additive migration: nullable columns and new tables; dual-write `userId`; backfills 1–6; the write service; heads | Backfill verification queries return zero misses |
| **N3** | server | Constraint flip: `userId NOT NULL`; `conversationId` nullable with `SetNull`; sync loaders by `userId`; down-conversion live | N1 gate met. Old-client fixture tests pass (an old build sees no null-conversation rows) |
| **N4** | web + Mac glass + iPhone | The unified surface (Phase 2), behind a flag | §13 Phase 2 exit |
| **N5** | server | Emit DOC and DECK to clients at `artifacts=2`; down-convert for others | Old-client fixture tests pass for every new kind |
| **N6** | server | Emit `artifact_comment` and `artifact_grant` | The allowlist is in the **oldest supported** build |

**Coordination.** The memory note says the glass branch ships only when all its phases are done. N1 therefore **cannot wait for glass**. It is a small tolerance release from `main`, and the glass branch merges it, since stage 3 already skips unknown kinds, which is the same behaviour. A second releaser must not cut from the glass worktree.

---

## 4. Information architecture and navigation

### 4.1 One noun per concept

This is decided before any surface ships (R-008; 00 §5):

| Concept | The one word | Retired words |
|---|---|---|
| Everything made | **Artifacts** (the place), **artifact** (the thing) | "Outputs" as a place, "Canvas library", "Designs" as a place |
| The side surface | **panel** | "Canvas", which now means only the design drawing surface, and "dock" in UI copy |
| Types | Design · Doc · Deck · Page · Design system · Code · Diagram · Graphic · Image · File | the wire words `DESIGN` and `MARKDOWN`, and "Sites", "Components", "Graphics" as nouns |
| With people | **Share** | — |
| To the public web | **Publish** / **Update** / **Unpublish** | "Share link" for public |
| Kept in the sidebar | **Pin** | Star |
| Per-conversation list | **Made here** | "Outputs" |
| A try of the same artifact | **Try 2**, **Use this**, **Keep both** | branch, merge, PR (R-029) |

### 4.2 Web sidebar

```
Chat sidebar — before (TWO_PRODUCTS §3)        Chat sidebar — after
────────────────────────────────────────        ─────────────────────────────────────────
Juno                                   ◧        Juno                                   ◧
[ Chat | Code ]                                 [ Chat | Code ]
+ New chat                                      + New chat
Search                                          Search
Library                                         Library
Projects                                        Projects
Artifacts                                       Artifacts          ← one row, one index
Design                ← removed                 More
More
                                                Needs you  (only when non-empty)
Needs you                                       Pinned             ← chats AND artifacts;
Pinned projects                                                      an artifact's one trailing
Pinned chats                                                         signal is its type noun
Recent                                          Recent
Liam · Pro                                      Liam · Pro
```

- `app-sidebar.tsx:1100` drops the `{ href: "/design" }` entry (checked). For **one release** it stays as a pointer row that opens `/artifacts?type=design` with the note "Designs now live in Artifacts". It is then removed.
- The decision is recorded in `docs/OPEN_DECISIONS.md` as an amendment to TWO_PRODUCTS §3 (open question Q2).
- In Code, the **Artifacts** row stays in Code (fixes M27; update `tests/shell-product-column.test.ts:43-62`, which locks in the defect).
- **Pinned artifacts** are text rows with no leading glyph (PREMIUM_AUDIT rule 4: glyphs mark destinations, not documents), and their type noun is their one trailing signal.

### 4.3 The Artifacts home (`/artifacts`)

The page opens with its name (PREMIUM_AUDIT rule 15). The list machinery is `/library`'s (`api/library/route.ts`): server search, sort, cursor paging (50 per page), bulk select and Recently deleted.

- **Header:** "Artifacts", then a search field (debounced 200 ms, over titles and current text; replaces the client filter over the 200-row cap, M26), **New ▾**, and a list/grid toggle.
- **Type chips with counts:** All · Designs · Docs · Decks · Pages · Diagrams · Code · Images · Files. A chip shows only when its count is above 0 (L31). Design systems appear from Phase 6.
- **Scope:** Everything · Recent (from `ArtifactOpen`) · Pinned · Shared with me (Phase 5) · In project ▸.
- **Sort:** Last opened · Last edited · Created · Name, remembered on the server per scope.
- **Rows:** a 40×28 poster, the title, and **one** trailing signal: the updated time, "Published", or "Not synced" on native (PREMIUM_AUDIT rule 6).
- **Tiles:** a 4:3 poster, the title and one meta line. The type word appears only under All. A Play glyph appears on interactive designs.
- **Row menu:** Open · Open in conversation · Pin · Rename · Duplicate · Share… · Move to project ▸ · Delete.
- **New ▾:** Design ▸ (Phone 390×844 · Tablet 834×1194 · Desktop 1440×900 · Square 1080×1080 · Portrait 1080×1350 · Custom…) · Doc · Deck · Page · From a template…. Doc and Deck appear from Phase 4.
- **Templates:** Juno starters plus the user's own "Save as template". A row of six shows only when the list is empty, or under New.
- **Recently deleted:** a row at the foot, with the count.
- **Empty state:** a single muted glyph, one sentence ("Everything Juno makes with you lands here."), and one action (New ▾).

**The index query.** The Artifacts index is a `UNION ALL` over three tables, cursor-paged on `(updatedAt, id)` and served by `(userId, deletedAt, updatedAt)` indexes:
- `Artifact` rows;
- `WorkArtifact` binaries (kinds `spreadsheet|pdf|bundle|archive|image|site`);
- `Attachment` rows with `origin = generated`.

It runs as `$queryRaw`, as `search/sql.ts` already does. **Deliverables and images are listed by reference.** Their rows open their own viewers through `/a/{id}`-style routes (§5.1).

### 4.4 Library versus Artifacts

- **Library** holds files: what you brought (uploads, project sources, knowledge documents) and every `Attachment`, including generated media, because those are files.
- **Artifacts** holds what Juno and you **made**: every `Artifact` row, plus generated images and task files by reference.
- **Generated images appear in both.** It is the same object and opens in the same viewer. This is the ChatGPT Library shape (03 §4 row 5), and it avoids hiding images from a Library users already use.
- The composer's **+ › Add from Library** gains a **Made** tab. Picking an artifact attaches a reference chip pinned to its version (R-075).
- **Recommendation on the fold.** REWORK_PLAN's "Artifacts folds into Library as a filter" (`docs/native/REWORK_PLAN.md:153-154`) is **withdrawn**. The Claude-faithful target is an Artifacts home, and Claude's own project Library holds "files and artifacts" as two sections (03 §2.3).

### 4.5 Projects

- An artifact inherits `projectId` from its made-in chat, and "New" inside a project inherits it too.
- The project page gets an **Artifacts** section rendered by the same list component with `?projectId=`. This fixes X-21, which read `res.artifacts` while the API returns `items`, and whose fetch was unscoped.
- Sources rows link to `/a/{id}`, fixing L27.
- **Move to project ▸** works on any artifact.
- Access is inherited from project members in Phase 5: "Inherited: people in *Juno app* can open it" (R-039).

### 4.6 Inside a conversation: "Made here"

- The Outputs popover (`session-outputs.tsx:97-106`) becomes **Made here** (R-079, Phase 4).
- At the top, five create tiles (Doc · Deck · Design · Page · Diagram). A tile only arms the composer's Make pill; **nothing runs without Send** (TWO_PRODUCTS §2.2).
- Below, outputs are grouped by type, including this chat's Work files and images. That fixes the dead "N more files under Outputs" pointer (X-25).
- The panel's header gets an **artifact switcher** that lists the same set.

### 4.7 Mac, on top of the Liquid Glass navigation

The glass plan's structure stands: one `NavigationSplitView`, a system sidebar, a declared-once toolbar, a `TrailingDock`, and `JunoPage` pages. Four changes:

1. **Sidebar (glass §2.1).** Drop `Label("Design", image: .junoDesign).tag(Destination.design)`. The nav block becomes New chat · Library · Projects · **Artifacts** · More.
   - Keep `Destination.design` **decodable** for state restoration and route it to `.artifacts(filter: .design)`.
   - Code's retired `.design` selection (`DesktopCodeStudio.swift:34-35`) stays decodable and falls back as today.
   - The glass §9 "Design" page row is dropped.
   - The launcher presets move into **New ▾ › Design** on the Artifacts page, and into File › New Design (⇧⌘N stays private chat; New Design is ⌥⌘N).
2. **The Artifacts page (glass §9, Phase 4).** The web's controls, drawn as a native page:
   - a `JunoSegmented` type filter (only when there is more than one type), search, a sort `Menu`, and Grid/List (⌘1/⌘2 inside the page);
   - **New ▾** as `.bordered`;
   - Recently deleted as a header toggle, the way Library does it (glass §9 Library row);
   - Space for Quick Look (the R-014 poster, or a rendered PDF), Return to open, ⌘⌫ to trash;
   - drag-out as a promised file.
   - Opening an artifact that has a made-in chat routes to that chat and slides in the dock, as glass §9 says. A hand-made artifact opens in a **document window**.
3. **The dock is the ArtifactSurface at panel size.** Glass stage 3 already built the foundations: `TrailingDock`, `ChatArtifactResolver` (a row lookup by `(conversation, identifier)`), designs opening from the stored row, and a save on top of the edit-start version. The merge adds:
   - the ArtifactSurface header (title, `‹ v4 ›` stepper, mode control, Share, ⋯);
   - autosave through transactions (⌘S becomes "Save now");
   - `surface="window"`;
   - bridge v2's `setChrome native`, so the editor's own top bar hides and the hosted editor has one tool row (fixes the stacked chrome in 02 §5).
4. **Document windows** (R-068):
   - `WindowGroup(id: "artifact", for: ArtifactID.self)`, restorable through `NSUserActivity("com.juno.artifact")` carrying id, version and mode;
   - opened with ⌘-click on a card, double-click in Artifacts, or ⌥⌘O;
   - a unified `NSToolbar`: title and version menu · a native segmented mode control · Play · Share · Comments · History · a Juno toggle (⌘⌥C);
   - the Juno toggle shows the made-in conversation as a trailing pane.
   - These replace the detached read-only snapshot windows (`DesktopArtifactsScreen.swift:1449-1473`).

**Phase alignment with glass** (execution order 1 → 2 → 5 → 3 → 4 → 6):

| Glass phase | Merge work it carries |
|---|---|
| Phase 2 stage 3 (built) | Phase 0 and Phase 2 foundations (X-11, X-12, X-14 and the H9 decision) |
| Phase 5 (Work in Chat) | Work run cards whose deliverable tiles are artifact rows (§11) |
| Phase 3 (popovers) | The Share popover with People and Publish, instead of glass §7.3's chat-link-only popover. Made here replaces the Outputs popover (§7.5) |
| Phase 4 (pages) | The Artifacts page as above; no Design page |
| Phase 6 (sync tooling) | Generated `JunoArtifactKinds.swift`; the editor bundle gate |

### 4.8 iPhone

- `JunoMobileSection` (checked) has `.artifacts` and **no Design section**, so nothing is removed.
- The Artifacts screen gains the same scopes, type chips, New (Doc and Design), Recently deleted and posters.
- The `.work` section stays until glass Phase 5 ports Work into Chat on iOS (TWO_PRODUCTS §2 keeps the phone's product until then).
- **From a chat card**, the artifact opens as a **sheet** with medium and large detents. **From Artifacts**, it opens as a full-screen push. Both use the same header.
- Search results select the artifact, as today.
- Universal links for `/a/*` and `/share/*` open it (`apple-app-site-association`).

### 4.9 ⌘K and search

- ⌘K lists artifact titles plus **New design / New doc / New deck / New page** (fixes L34), and drops the double "canvas" keyword.
- Unified search has an **Artifacts** scope. It honours `?v=` and opens `/a/{id}?v=` (M28).
- Search matches the current text of designs, meaning layer names and text content, never JSON keys (fixes L36).

---

## 5. Routes and redirects

### 5.1 URL grammar

| URL | What it is |
|---|---|
| `/a/{id}` | **Canonical.** The full window: `ArtifactSurface size="window"` |
| `/a/{id}?v=7` | Version 7, read-only in the same renderer ("Viewing v7 · Restore as v12") |
| `/a/{id}?mode=design\|prototype\|motion\|inspect\|code\|read\|edit` | Mode, remembered per artifact |
| `/a/{id}?node=…&page=…&comment=…` | Deep link to a frame, page or comment thread |
| `/a/{id}?from=chat` | Full window entered from a panel; shows the made-in conversation column |
| `/a/{id}/play[?frame=…]` | Play (prototype), Present (deck) or Interact (page), full window (Phase 4) |
| `/chat/{c}?a={id}[&v=…&node=…]` | The conversation with the panel open on artifact `id` |
| `/new/design?preset=phone\|tablet\|desktop\|square\|portrait`, `/new/doc`, `/new/deck`, `/new/page` | Quick create (R-025, R-027) |
| `/artifacts?type=design&scope=…&sort=…` | The home, filtered |
| `/share/{token}[/play]` | A published snapshot pinned to `Share.versionId`. Existing tokens stay valid |
| `https://{version-hash}.juno-usercontent.com/r/{token}` | The preview origin: a sandbox document, loaded only by `src` from Juno's own pages (§9.7) |
| `/a/{id}/f/{fileId}` | A File-kind reference (WorkArtifact) in the same shell: poster, preview or Quick Look, and Download |
| `/a/img/{attachmentId}` | An Image reference in the same shell |

**Why `/a/{id}`:**
- It is short.
- It carries no type, so a type change never breaks a link.
- It survives renames.
- One `apple-app-site-association` pattern covers it.
- It matches the backlog (R-016, R-025). Claude's equivalent is `/artifact/{id}`.

### 5.2 Panel and full window are one mount

```
 card ──click──▶ panel  (/chat/{c}?a={id})
                  │  ⌘⇧↩ / Expand  → history.replaceState("/a/{id}?from=chat"); same React tree grows
                  │  Esc / "Back to chat" → replaceState("/chat/{c}?a={id}"); undo, selection, zoom kept
 library / search / share / notification / native link ──▶ /a/{id}  (window; no chat column unless ?from=chat)
 below a 50rem content column: panel size does not exist → /a/{id} (web) · sheet (iPhone)
```

- `CanvasPanel` becomes a thin docking host: it keeps chat-view's width, coexistence and resize rules (`chat-view.tsx:897-993, 2479-2541`) and renders `<ArtifactSurface id size="panel">`.
- `/a/[id]/page.tsx` renders `<ArtifactSurface id size="window">`.
- Neither keys any child by version.

### 5.3 Redirects

All redirects are **307 while flags are in beta** and **308 only after the public launch**, so a rollback is never stuck in browser caches.

| From | To | Notes |
|---|---|---|
| `/design` | `/artifacts?type=design` | Presets pinned at the top for 60 days |
| `/design/{artifactId}` | `/a/{artifactId}?mode=design` | The full-window editor. Ask Juno is now the composer |
| `/chat/{c}?artifact={identifier}[&v=]` | `/chat/{c}?a={id}[&v=]` | Resolved on the server by `(c, identifier)` in `chat/[id]/page.tsx` (checked: `searchParams.artifact`) |
| `/artifacts?id={id}` | `/a/{id}` | Project Sources (L27) |
| Search hits `?v=` | `/a/{id}?v=` | M28 |
| `/work/*` | Unchanged (`work-url-migration.ts`) | Adds a target for native sessions with no conversation, a read-only task view (X-29) |
| `/share/{token}` of a trashed artifact | 410 "This page isn't shared any more" | Restore brings the token back |

### 5.4 API surface

The existing routes are **kept**, because native builds in the field call them:
- `/api/artifacts`, `/api/artifacts/[id]`, `/api/artifacts/[id]/export`;
- `/api/design`, `/api/design/[id]/transactions`, `/api/design/[id]/export`;
- `/api/share`.

Behind them, everything calls the write service. New routes:
- `POST /api/artifacts` creates an artifact (kind, preset, project).
- `GET /api/artifacts?type=&scope=&q=&sort=&cursor=` is the unified index.
- `GET /api/artifacts/{id}` returns metadata plus the current body; `?include=head` adds the head.
- `GET /api/artifacts/{id}/versions?cursor=` returns metadata; `/versions/{n}` returns a body.
- `POST /api/artifacts/{id}/head` commits operations or a patch against a head revision.
- `POST /api/artifacts/{id}/seal`, `/restore`, `/duplicate`, `/move`.
- `DELETE /api/artifacts/{id}` sends the artifact to the trash; `POST /api/artifacts/{id}/untrash` restores it.
- `GET /api/artifacts/{id}/render?v=&frame=&w=&fmt=svg|png|webp` returns a poster.
- `/api/artifacts/{id}/exports/{format}`.
- `/api/artifacts/{id}/publish` supports GET, POST (Publish or Update), and DELETE (Unpublish).
- `/api/artifacts/{id}/comments` and `/grants` (Phase 5).
- `/api/admin/shares` (lookup, suspend, restore) and `POST /api/report`.

### 5.5 Mac and iPhone destinations and restoration

| Platform | Entry | Mapping |
|---|---|---|
| Mac | `.design` destination (main footer row, glass nav row) | Decodes and routes to `.artifacts(filter: .design)` |
| Mac | `.artifacts` scene storage | The page restores its filter, scope and sort |
| Mac | Document windows | `WindowGroup(for: ArtifactID.self)` with `NSUserActivity`. Restores id, version and mode, and falls back to the Artifacts page if the artifact is trashed ("This artifact is in Recently deleted · Restore") |
| Mac | Work › Made; the legacy detached windows | Point at the canonical artifact or file reference |
| Mac | Handoff | `NSUserActivity.webpageURL = https://…/a/{id}` |
| iPhone | Artifacts section; universal links | `openArtifact(id, version, node, comment)`. Unknown kinds become a poster plus "Open on the web" (N1) |
| Both | Code's retired `.design` | Stays decodable and falls back to the landing, as today |

---

## 6. The unified artifact view

### 6.1 Anatomy

`ArtifactSurface` (web: `src/components/artifact/artifact-surface.tsx`; native: `ArtifactSurfaceView` in JunoChatKit) takes `{ id, size, version?, mode? }`. It is sized by its **container**, never the viewport (PREMIUM_AUDIT rule 11).

- **Header**, one 44px row with 16px gutters:
  - the title, with inline rename, and the type noun in muted ink;
  - the `‹ vN ›` stepper;
  - the artifact switcher, when this conversation made more than one;
  - the mode control, from the registry;
  - Comments (the open count, Phase 5);
  - **Share**, which reads **Shared** with a filled globe when published;
  - ⋯: Open in full window ⌘⇧↩ · View in conversation · Duplicate · Turn into ▸ (Phase 6) · Export ▸ · Move to project ▸ · Move to trash;
  - Expand and Close.
- **Body:** the kind's renderer or editor, from the registry.
- **Bars** (at most one at a time, under the header): Viewing an older version · Suggestions (Phase 5+) · Stopped draft · Render failed · Juno updated this while you were editing.
- **Floating layers** (`overlay-glass` on the web; system popovers on the Mac): the contextual bar under 640px, the Tweaks card, and Juno's presence chip.

### 6.2 Sizes and their contracts

| Size | Where | Contract |
|---|---|---|
| **Card** | Transcript | A poster at its own aspect ratio in an `@container` box capped at 320–360px, **at most two actions** (Open, plus one verb for the kind: Play, Copy or Download), and no "Live" label. A live sandbox mounts only when the card is the latest version, at least 50% visible, and the panel is closed (M24). **One live card per artifact.** Earlier turns fold into a **version receipt** ("Updated Sign-in screen · v3 · latest is v5 · Open v3", R-023) |
| **Panel** | Beside the conversation, when the content column is at least 64rem (the split rule is unchanged) | The full header and body. Auto-opens on the first artifact of a turn when there is room and the user hasn't closed it in the last three turns (R-033). Never takes focus. Esc closes it and returns focus to the trigger or the composer (U7) |
| **Full window** | `/a/{id}` | Edge to edge. **The conversation stays reachable:** a collapsible left column when `?from=chat`, otherwise a composer strip bottom-centre (at most 680px) with the last reply as a two-line snippet (MCP Apps rule; 03 §4 row 6). The focus trap fixes M23 |
| **Picture-in-picture** | Top right of the transcript | Only for live things: a streaming generation, a playing prototype, a presented deck, a running task. A 320×200 tile when the user scrolls away mid-run. A click restores the panel. It docks back into its card when the run ends |
| **Shared page** | `/share/{token}` | The pinned version. A server-rendered SVG for Design and Deck (fixes X-20), the preview origin for Page, typeset HTML for Doc. Play when interactive. A footer: "Made by a Juno user · not verified by Juno · Report", plus legal links. No comments, no conversation, no editor link without a grant |
| **Phone** | iPhone sheet; web below 50rem | Full-bleed, with a bottom bar: Play · Comment · Tweaks · Ask (44pt). Inspector and layers are bottom sheets. The contract is in §6.4 |

### 6.3 Wireframes

**WF-1. Conversation with the panel (web, content column ≥ 64rem)**

```
┌────────────┬──────────────────────────────────┬─────────────────────────────────────────────────┐
│ Juno     ◧ │ Sign-in flow                   ⋯ │ Sign-in screen  Design   ‹ v4 ›      Share ⋯ ⤢ ✕ │
│ Chat|Code  │                                  │ Design · Prototype · Motion · Inspect   ▶ Play  │
│ + New chat │         Design a sign-in screen  │ ┌──────┬───────────────────────────┬──────────┐ │
│ Search     │         for the iPhone app.      │ │Layers│                           │Inspector │ │
│ Library    │         Warm, quiet.             │ │▾Sign │   ┌───────────────────┐   │Frame     │ │
│ Projects   │                                  │ │ Hero │   │  (o)              │   │390 × 844 │ │
│ Artifacts  │ ┌──────────────────────────────┐ │ │ Form │   │  Welcome back      │   │Fill      │ │
│ More       │ │ ▣ Sign-in screen        Open │ │ │ CTA •│   │  [ email       ]   │   │#FAF9F6   │ │
│            │ │   Design · v4                │ │ │      │   │  [ password    ]   │   │Layout    │ │
│ Pinned     │ │ ┌──────────────────────────┐ │ │ │      │   │  [  Continue   ]   │   │↓ 16 · 24 │ │
│ Recent     │ │ │      poster (16:10)      │ │ │ │      │   └───────────────────┘   │          │ │
│ Sign-in fl…│ │ └──────────────────────────┘ │ │ │      │  ┌ Juno · 4 changes ─────┐ │          │ │
│ Q3 plan    │ │ Open                  ▶ Play │ │ │      │  │ Review · Hold B: before│ │          │ │
│            │ └──────────────────────────────┘ │ │      │  └───────────────────────┘ │          │ │
│            │ ┌ Juno changed Sign-in screen ─┐ │ └──────┴───────────────────────────┴──────────┘ │
│            │ │ Quieter CTA, larger title    │ │                                                 │
│            │ │ 4 layers · v3 → v4           │ │                                                 │
│            │ │ Undo                 Compare │ │                                                 │
│            │ └──────────────────────────────┘ │                                                 │
│            │ ┌──────────────────────────────┐ │                                                 │
│            │ │ Sign-in screen · v4 · CTA  × │ │  ← selection chip (R-031)                       │
│            │ │ Ask about Sign-in screen…    │ │                                                 │
│ Liam · Pro │ │ +  Design · Phone ×   Auto  ↑│ │  ← armed Make pill (Output picker)              │
└────────────┴─┴──────────────────────────────┴─┴─────────────────────────────────────────────────┘
```

**WF-2. The full-window design, `/a/{id}?from=chat`**

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ‹ Chat   Sign-in screen  Design  ‹ v4 ›   Design · Prototype · Motion · Inspect   ▶   Share  ⋯  ✕ │
├───────────────────┬─────────┬────────────────────────────────────────────────┬───────────────────┤
│ Sign-in flow    « │ Layers  │                                                │ Inspector         │
│                   │ ▾ Page 1│      ┌──────────┐     ┌──────────┐             │ Selection: CTA    │
│ Juno changed      │  ▾ Sign │      │ Sign-in  │     │ Signed in│             │ Fill  primary     │
│ Sign-in screen    │    Hero │      │          │ ──▶ │          │             │ Radius 12 · ◠ 60% │
│ v3 → v4 · Undo    │    Form │      │ [Contin.]│     │          │             │ Layout ↔ fill     │
│                   │    CTA  │      └──────────┘     └──────────┘             │ Motion  +         │
│ You: make the CTA │  ▸ Home │                                                │                   │
│ quieter           │         │                     − 100% +   Fit             │ Tweaks ▸          │
│ ┌───────────────┐ │         │                                                │                   │
│ │Ask about this…│ │         │                                                │                   │
│ │+       Auto  ↑│ │         │                                                │                   │
│ └───────────────┘ │         │                                                │                   │
└───────────────────┴─────────┴────────────────────────────────────────────────┴───────────────────┘
  Without ?from=chat the left column is absent and the composer is a strip, bottom-centre, ≤ 680px:
  ┌──────────────────────────────────────────────────────────┐
  │ Juno: "Quieter CTA, larger title." · Ask about this…   ↑ │
  └──────────────────────────────────────────────────────────┘
```

**WF-3. The Artifacts home, with New open**

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Artifacts                                  [ Search artifacts            ] [ + New ▾ ] [≣|▦] │
│ All 142 · Designs 18 · Docs 31 · Decks 6 · Pages 40 · Diagrams 22 · Code 19 · Images 4 · Files 2│
│ Everything ▾     Last edited ▾                  ┌──────────────────────────────────────────┐ │
│                                                 │ ▣ Design      ▸ │ Phone      390 × 844    │ │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │ ▤ Doc           │ Tablet     834 × 1194   │ │
│ │  [poster]   │ │  [poster]   │ │  [poster]   │ │ ▭ Deck          │ Desktop   1440 × 900    │ │
│ │           ▶ │ │             │ │             │ │ ‹› Page         │ Square    1080 × 1080   │ │
│ └─────────────┘ └─────────────┘ └─────────────┘ │ ─────────────── │ Portrait  1080 × 1350   │ │
│ Sign-in screen  Q3 pipeline     Pricing brief   │ From a template…│ Custom…                 │ │
│ Design · 2h     Deck · Published Doc · Yesterday└─────────────────┴─────────────────────────┘ │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                              │
│ │  [poster]   │ │  [poster]   │ │ [xlsx page] │ │ [diagram]   │                              │
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘                              │
│ Onboarding      Landing page    pricing.xlsx    Auth flow                                    │
│ Design · Mon    Page · React    File · Task     Diagram · Sep 19                             │
│                                                                                              │
│ Recently deleted · 3                                                                         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**WF-4. The Share dialog (People plus Publish; opening writes nothing)**

```
┌ Share "Sign-in screen" ──────────────────────────────────────────────────────┐
│ People                                                                        │
│ [ Add people or emails                        ] [ Can comment ▾ ] [ Invite ]  │
│ Who has access                                                                │
│   Liam Magnier (you)                                               Owner      │
│   ▸ From "Juno app" · 4 people                                     Can edit ▾ │
│   ana@studio.fr · invited 2d                                     Can comment ▾│
│ Link: Only people with access                                   Copy link    │
│ ───────────────────────────────────────────────────────────────────────────── │
│ Publish to the web                                                            │
│ (globe) Published · v9 · 2 days ago                          v11 has changes │
│ [ https://juno.ai/share/k3F…q                              ]  Copy     ⋯      │
│                                                   ⋯ = Unpublish · Link expires ▸│
│ [ Update to v11 ]                                     · View as a visitor ·   │
│ Opens in: ( Canvas | Play )                             Reset link            │
│ 124 views · 81 people · 7 days                                                │
│ Visitors see: "Made by a Juno user · not verified by Juno · Report"           │
└───────────────────────────────────────────────────────────────────────────────┘
 Before the first Publish: "Not published" and a primary [ Publish v9 ]; the first Publish opens a
 sheet that lists what becomes visible, including linked Library images, and the screening verdict.
 Phases 0–4: People reads "Only you can open this" (grants arrive in Phase 5).
```

**WF-5. The Mac, on Liquid Glass (a chat window with the dock, and a document window)**

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  ◧                [Chat|Code] │ Sign-in flow ▾                Made here 2   Share   Private │ ← system glass toolbar
├─────────────────────────────────────┼───────────────────────────────┬──────────────────────────┤
│ + New chat                          │ (opaque warm canvas)          │ Sign-in screen  ‹v4›  ⋯ ✕ │ ← dock header, opaque
│ Library                             │                               │ [Design|Prototype|Motion] ▶│
│ Projects                            │  You: Design a sign-in…       │ ┌──────────────────────┐ │
│ Artifacts                           │  ┌─────────────────────────┐  │ │ hosted editor         │ │
│ More                                │  │ ▣ Sign-in screen   Open │  │ │ bundle v2 · chrome    │ │
│                                     │  │ Design · v4 · Updated   │  │ │ native · autosave     │ │
│ Pinned ▾                            │  │ [poster from stored row]│  │ │                       │ │
│ Recent ▾                            │  └─────────────────────────┘  │ └──────────────────────┘ │
│   Sign-in flow                    • │  Edit card: 4 changes·Review  │ Saved · v4               │
│                                     │  ╭ composer (glass cluster) ╮ │                          │
│ Liam · Pro                 ⚙        │  ╰──────────────────────────╯ │                          │
└─────────────────────────────────────┴───────────────────────────────┴──────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  Sign-in screen ▾  v4   [Design|Prototype|Motion|Inspect]  ▶  Comments  History  Share  Juno│ ← NSToolbar
├──────────┬─────────────────────────────────────────────────────────┬────────────┬──────────────┤
│ Layers   │                        canvas                           │ Inspector  │ Sign-in flow │
│          │                                                         │            │ (made-in chat│
│          │                                                         │            │  ⌘⌥C)        │
└──────────┴─────────────────────────────────────────────────────────┴────────────┴──────────────┘
 Restorable (NSUserActivity com.juno.artifact) · File › Export ▸ · Edit › Undo wired to the editor
```

**WF-6. iPhone: a sheet from a chat card (medium detent, then large)**

```
┌───────────────────────────┐    ┌───────────────────────────┐
│ ‹  Sign-in flow        ⋯  │    │           ─────           │  grab handle
│                           │    │ ✕  Sign-in screen   ‹v4›  ⋯│
│ …transcript…              │    │    Design · Published      │
│ ┌───────────────────────┐ │    │ ┌───────────────────────┐ │
│ │ ▣ Sign-in screen  Open│ │    │ │                       │ │
│ │ Design · v4           │ │    │ │        canvas         │ │
│ │ [poster]              │ │    │ │    pinch · pan · tap  │ │
│ └───────────────────────┘ │    │ │                       │ │
│───────────── ─────────────│    │ └───────────────────────┘ │
│ ✕ Sign-in screen    ‹v4› ⋯│    │ Selected: Title  [Aa][■]  │  text / colour fields
│ ┌───────────────────────┐ │    │                           │
│ │   canvas (medium)     │ │    │  Play  Comment  Tweaks  Ask│  44 pt bottom bar
│ └───────────────────────┘ │    │                           │
└───────────────────────────┘    └───────────────────────────┘
  Long-press on the canvas → "Comment here" (0.4 s, medium haptic). Ask: voice or text, with the selection chip.
```

**WF-7. The transcript card and the version receipt**

```
Juno
┌──────────────────────────────────────────────────┐
│ ▣  Sign-in screen                          Open  │   glyph · title · one trailing Open
│    Design · v4                                   │   type noun always first (visible routing)
│ ┌──────────────────────────────────────────────┐ │
│ │            poster (static, @container)        │ │   ≤ 360 px tall; never JSON
│ └──────────────────────────────────────────────┘ │
│ Open                                     ▶ Play  │   ≤ 2 actions
└──────────────────────────────────────────────────┘
While making:  "Making a design · 1 of 2 frames" · outlines fill in (§10)
Stopped:       "Stopped before v5 finished · Keep v4 · Continue v5"
Earlier turn:  ▣ Updated Sign-in screen · v3 · latest is v4                          Open v3
```

### 6.4 States, and the phone contract

| State | Rendered as |
|---|---|
| Loading | Frame outlines at the artboard sizes (Design), block skeletons (Doc), a slide strip (Deck). Revealed only after 500 ms |
| Writing | "Writing v5, showing v4" with v4 at 60% (R-007), or the object filling in place (R-033) |
| Checking | "Checking…", only after 500 ms |
| Stopped | "Stopped before v5 finished · Keep v4 · Continue v5". v5 appears in the stepper as "Draft, incomplete" |
| Refused | "Juno couldn't save this version: that diagram type (quadrantChart) isn't supported yet · Try again". The reason is always shown (M4) |
| Render failed | The last good frame, under "v8 didn't render · Show error · Fix with Juno" (R-035) |
| Unavailable | The reason plus "Open source". **Never JSON by default** |
| Newer version arrived | Adopted in place (R-013). If there are local edits: "Juno updated this while you were editing · Review changes" |
| Offline (native) | "Not synced" as the one trailing signal. Edits queue to disk by `(artifactId, baseVersion)` (R-065) |
| Unsupported kind (native) | The poster plus "Open on the web" |

**The phone contract** (R-069), stated in help and in-app copy, identically on iPhone and phone-width web:

- **v1:**
  - open any artifact from its link, full-bleed, with pinch and pan;
  - step through versions;
  - Play prototypes and Present decks;
  - comment by long-press;
  - select, then Ask by voice or text;
  - apply tweaks;
  - edit text in place (Docs; design text layers by double-tap);
  - reorder and hide slides and layers;
  - replace an image from Photos;
  - **change sharing and revoke links**;
  - get notified when Juno finishes.
- **v1.1**, once touch pan and pinch land in the editor (M57): tap to select, drag to move, colour from tokens.
- **Desktop and iPad only**, said in one line rather than shown as disabled controls: drawing, resizing, auto layout and keyframe tracks.
- **Until v1 ships**, the iPhone design editor is read-only (R-002), because its save path strips data and overwrites newer versions (X-14, X-15, X-19, Mac M13). The copy reads "Edit this design on the web or your Mac".

---

## 7. Creation and routing

### 7.1 Three ways in (Claude's three)

1. **Ask.** The model decides whether a reply is plain text, a task, or a typed artifact, as it has since `22059f90`. The registry's per-kind "when to make" rules replace the single Canvas block in `system-prompt.ts:238-300`:
   - **Doc:** a doc-shaped ask (a plan, memo, brief, spec or report) meant to be kept, shared or edited, typically over ~300 words of structured prose. The chat reply is **one line plus the card**, which is Claude's Docs rule.
   - **Deck:** slides, a deck, a presentation, a pitch.
   - **Design:** a visual composition: screens, UI, mockups, posters, social visuals. It is not running code.
   - **Page:** something that must *run*: an app, a calculator, a game, an interactive demo.
   - **Diagram:** a flow or architecture meant to be kept. A one-off explanation stays an inline visual (R-077).
   - **Code:** a self-contained file of about 20 lines or more, to take away. Shorter code stays fenced in the reply.
   - **Ambiguous** ("a landing page"): "design" or "mock" makes a Design; "build" or "working" makes a Page. The card's ⋯ menu offers "Make this a Page instead".
2. **The Output picker, "Make ▸" in `+`** (R-028):
   - The entries, with registry glyphs: Design ▸ (Auto · Phone · Tablet · Desktop · Square) · Doc · Deck · Page · Diagram.
   - Picking one arms a **removable pill** beside `+` ("Design · Phone ×"), exactly like Deep research. The pill clears after send.
   - `/design`, `/doc`, `/deck` and `/page` arm the same pill.
   - The request carries `outputType` and `preset`. The server forces the kind, loads only that kind's authoring section, and uses the kind's model tier.
3. **New ▾** in Artifacts, ⌘K, `/new/*` and the Mac File menu (R-027):
   - It creates the artifact first, with an atomic `POST /api/artifacts`, and lands on `/a/{id}` in the full window with a collapsed composer strip ("Ask Juno about this design…").
   - **The first message creates the made-in conversation**, titled after the artifact and in its project. The URL stays `/a/{id}`.
   - Templates: New ▸ From a template… (Phase 4 for Docs and Decks).

**Reconciling this with TWO_PRODUCTS §2.2.** That decision removed "Do this as a task" because it made the reader classify *which capability* their sentence needed, a decision the model is better placed to make. The Output picker asks something different: **which format the reader wants to keep**, a decision the reader is better placed to make ("I need slides for Monday"). It is optional and absent by default, and the default path stays model-decided. Record this in `docs/OPEN_DECISIONS.md` as a scoped amendment. Claude made the same distinction on 16 Sept: it removed the Chat/Cowork toggle and added Output.

### 7.2 Model tier and budget

- DESIGN, DECK and REACT turns, and DOC turns planning over 2k words, **never route to the cheapest tier**. `auto-model.ts:61-66` today classes "build a SaaS dashboard" as simple (M7).
- On-canvas asks never use `qwen3.8-flash`, the Ask Juno default today (M41).
- **The output budget becomes a plan, not a cap.**
  - FREE's 8,192 output tokens (`plans.ts`) can no longer truncate a large artifact into a current version.
  - For Doc, Deck and Design, the turn plans sections, slides or frames, then fills them across calls (R-033). A turn that still runs out leaves a non-current draft with **Continue**, which patches the draft rather than restarting.
  - Truncated or refused generations are **refunded** (R-036).

### 7.3 Visible routing

- The card and the panel always lead with the type word: "Deck · Q3 pipeline".
- The status line reads "Making a deck…".
- The prose never narrates the mechanism (Claude's craft rule: tell the user what happens on the canvas, never how).
- **Settings › Capabilities** has per-type switches (Designs · Docs · Decks · Pages) for people who want chat-only answers. This answers the HN "no chat-only mode" complaint (03 §2.3).
- The Mac's no-op Canvas toggle is removed (00 §3.2 row 8; the glass plan removes it too).

### 7.4 Skeleton first: streaming into the object

**Server flow** for Doc, Deck, Design and long Markdown:

1. The model emits an **intent**: kind, title, and sections, slides or frames, each with a one-line intent.
2. The server creates the row with `status DRAFTING` and a non-current draft version, and sends SSE `artifact.skeleton`.
3. The panel auto-opens when there is room (§6.2). Pending blocks show their intent in muted ink over a skeleton **shaped like the content**: paragraph lines, a 16:9 slide, or a phone frame.
4. Content streams as `artifact.delta` frames:

   | Kind | How it streams |
   |---|---|
   | **Doc** | Tokens stream into the active block, batched per animation frame. Each finished block is committed as a block operation, in reading order |
   | **Deck** | Each slide fills on its frame, in order. The strip thumbnail updates when its slide completes |
   | **Design** | Operations stream as NDJSON and are validated per batch (at most 10 operations or 250 ms) into a preview layer. Frames appear first as hairline outlines at their final size, then their children. **The camera fits once**, when the first frame lands, and never chases the stream |
   | **Page (HTML, SVG)** | The page re-renders in a hidden second iframe at structural checkpoints (a closed top-level element, at most every 600 ms), and cross-fades in only when the render succeeds. Scripts are held to the end |
   | **Code** | Streams under the existing `.stream-tail` mask. **Old content is never shown under "Writing"** (M15) |

5. `artifact.done` seals the version (`complete=true`) and triggers the poster render. **Only then** does the card flip to Ready. The red "Source unavailable" between the closing tag and `done` is gone (M14).

**Steering.** While a turn streams, the composer placeholder reads "Steer this design…" and Send becomes **Steer**. Steers queue in the existing steering slot and apply at the next section boundary (the TWO_PRODUCTS steering pattern).

**Stop.** Finished work stays as a **non-current draft**: "Stopped · Keep what's here · Discard", or "Not written yet · Continue". It never becomes current (fixes X-07).

### 7.5 The wire: tools for typed kinds, references in the transcript

- **Typed kinds (Doc, Deck, Design, Design system) are created and edited through tools**, never tags. The tools are `artifact_create`, `artifact_read`, `artifact_propose` (a patch or operations against a base version), `artifact_render` and `artifact_search`, the R-032 contract, which `DESIGN_TOOLS` pre-figured.
  - Tool arguments stream, which is what makes the skeleton-first behaviour in §7.4 possible.
  - For models without reliable tool use, the same verbs are accepted as `<juno:patch>` and `<juno:design-ops>` blocks. Both parsers already exist (`artifact-edit.ts`; `design/ai.ts`).
- **Legacy tag kinds (HTML, REACT, CODE, SVG, MERMAID, MARKDOWN)** keep `<juno:artifact>` for creation until Phase 3's patch path is proven. Revisions move to patches in Phase 3.
- **The stored transcript references versions instead of containing them.** After a turn, `Message.content` keeps `<juno:artifact ref="{id}" identifier="…" type="…" title="…" version="4"/>`, and the body lives only in `ArtifactVersion`.
  - This removes the stale-text source of X-05: the model cannot rebuild from old message text that is no longer there, and it gets the current-version digest instead (§8.1).
  - It removes duplicate bodies from thread payloads (M12, M13).
  - Chat share snapshots render each reference as the **poster of the version pinned at that message**, better than today's inert chips.
  - For clients below `artifacts=2`, the `message` sync loader rewrites references back into full tag bodies of the referenced version (§3.4).
  - This ships in Phase 3, after the digest.

---

## 8. The AI editing loop

### 8.1 The model reads the current version

Every turn in a conversation assembles an **artifact context** for each artifact that is open in the panel, named in the message, or touched in the last N turns. Heads are sealed first (§2.6). The context holds:
- id, kind, current version, its author, and whether a person edited it since Juno last wrote;
- **the body when it fits**. Otherwise an id-bearing digest: the DESIGN node tree with node, variable and component ids from `selection-context.ts` (extended beyond top-level nodes, M40), Doc block ids and headings, Deck slide titles and ids, or Page and Code source with line numbers;
- a **motion and interaction digest** (animations, tracks, interaction edges), so a revision cannot drop them unknowingly (X-06);
- **view context** from the panel (§8.6).

The 24–31 message window (`route.ts:1852-1861`) stays for conversation text. The artifact context sits outside it.

### 8.2 Verbs, per kind

| Kind | Verb | Limits and guarantees |
|---|---|---|
| Page, Code, Diagram, Graphic, Markdown | `patch`: at most 12 exact, unique anchors | Coverage and growth limits and compare-and-swap, as today (`artifact-edit.ts:96-139`). Half a patch is never saved |
| Doc | Block operations, plus an in-block patch | Block ids are stable. Hand-edited blocks are hash-guarded ("their words win", the Claude Docs connector rule) |
| Design, Deck | Design operations (37 validated, invertible operations) plus `query`, `tree` and `setMany`. The server expands selectors into `updateNode` operations; the model never writes JavaScript | Validated on a clone, scope-checked, and an inverse recorded per operation. `deleteNodes` also removes tracks and interactions pointing at deleted nodes (M42). **The compact authoring grammar becomes creation-only**, meaning operations against an empty document, so images, effects, components, tokens and motion become expressible (X-06, X-10) |
| Any | `rewrite` | Only when the user asks, or when patch or operation limits are exceeded. It always goes through review (§8.4) |

### 8.3 People's edits win

- Every model write is a **compare-and-swap on the version or head revision the turn read**.
- On a conflict, Juno re-reads, rebases through the operation layer (ids are stable), and retries once.
- Operations that touch a node or block a **person** changed after the read are dropped, and Juno says so in one sentence: "You edited the pricing table while I worked, so I kept your version and applied the rest."
- **The proposal guard:** a proposal that would remove animations, tracks or interactions the request didn't mention shows "Also removes 2 animations and 3 interactions", with **Keep them** selected by default (R-009 §5).
- **The golden test:** a design with 3 animations and 5 interactions, revised with "make the title bigger", keeps all 8.

### 8.4 Proposals in the transcript

Each Juno change appears in the transcript as an **edit card**:
- a summary ("Tightened the intro, added Risks");
- a size ("+12 −3 lines" or "12 layers changed");
- `v3 → v4`;
- **Apply** and **Discard** while reviewing, then **Undo** and **Compare** after.

Each applied change is **one undo entry** ("Undo Juno: Quieter CTA") and **one version** with `authorKind: model`.

**When Juno applies directly, and when it asks for review:**
- **Apply directly** while Juno drafts a new artifact, when no person has edited it since Juno last wrote.
- **Review** once the artifact has person-authored versions since Juno's last write. A one-time inline note explains the switch.
- **Review** also when a change exceeds 60 operations, touches more than one frame or section, or is a `rewrite`.
- **Compare** for large changes, which land on a branch ("Juno: <summary>") and open side by side, with Use this · Keep both · Discard (R-029). Hunk-by-hunk review is R-030. It defaults on for Docs, as Notion does with suggested edits.

**While a proposal is pending,** the committed document is **read-only**: the canvas, Layers and shortcuts (fixes M46). Apply reports failure honestly (fixes M47).

**Parallelism:** up to three parallel asks on disjoint scopes. Overlapping scopes queue and say so. Writes are serialised per artifact, so there is no 409 storm (03 §8 anti-pattern).

### 8.5 Ask Juno becomes the conversation

- The on-canvas prompt (⌘↵, or the existing pill) keeps its anchored `overlay-glass` form, but **posts a turn into the artifact's made-in conversation**. If the artifact has none, the first ask creates it.
- Its selection travels as the composer's selection chip.
- `/api/design/[id]/edit` is retired as a separate experience. Its validation (`ai.ts` parse, validate and scope-check) is reused by the chat route's design-operations path.
- **Ask Juno in the Canvas host and on the Mac** comes free, because the conversation is the channel. Mac and iPhone use bridge v2's `proposal` and `resolveProposal` channels (R-060).
- Actions that leave Juno (connectors, tasks) keep the existing risk-classed approval card. Review versus Apply-directly applies only to artifact edits.

### 8.6 Selection context in the composer

Every send from a conversation with the panel open attaches a **view context** (R-031):

```
{artifactId, version, view (preview|code|design|play), tab/page/slide,
 selection (node ids | text range | element path), visibleRect, dirty, pendingDraftVersion}
```

- The server resolves "this", "here" and "the button" against it and scopes the patch or operation targets.
- **Juno shows it, where Claude hides it:** one removable chip above the field ("Sign-in screen · v4 · CTA ×"). With nothing selected, the placeholder reads "Ask about Sign-in screen, or select layers".
- **Page selection packets** carry the CSS path or XPath, role and aria-label, the rect, a subset of computed styles, the React display name and props (at most 2 KB), and a crop of at most 1024px.
- **Design selection packets** carry node ids and names, post-layout boxes and styles, and a `renderPageSvg` crop.
- **Budget:** at most 6 KB of JSON and one image per element, for at most four elements. **Form field values are never included.** A "What Juno sees" disclosure lists exactly what is sent.
- The chip and the Ask toolbar are keyboard reachable (fixes M22).

### 8.7 Comments sent to Juno (Phase 5)

- Editors choose **Ask Juno** in a thread footer, or write `@Juno`. Commenters get **Suggest to owner**.
- "Send 3 to Juno" batches the selected threads into one turn in the made-in conversation, carrying `{artifactId, version, anchor, quote or node ids, crop}`.
- The transcript shows a quoted chip that links back: "On Hero · v11: Make the CTA quieter".
- Juno's answer arrives as a proposal. On Apply, Juno replies **in the thread**: "Done in v12 · View change · Undo this". `answered` is set, so a second session never answers twice.
- **When the owner is away,** an editor's send runs a background turn that *proposes* a new version, never applies it for a non-owner, and posts "Juno proposed v8 · Review".
- **Juno leaves its own comments** when it makes a judgment call or lacks a fact (Claude Docs does this).
- Replies are rate-limited per artifact per hour, like Claude's 60 activations per artifact per hour.

### 8.8 Render check and "Fix with Juno"

- After every generation or revision, the sandbox or WKWebView reports status, uncaught errors, failed loads and blank renders.
- On failure, Juno gets **one free, visible repair turn**. The repair lands only if its result renders.
- Otherwise an inline strip appears: "This page hit an error · Fix with Juno · Details". Fix with Juno adds a queued ask carrying the errors, the last 20 console lines and the failing line, and runs on the patch path (R-035; Claude's "Try fixing with Claude").

### 8.9 Metering (R-036)

- **Never metered:** hand editing, tweaks, comments, restore, compare, switching branches, Play, publishing.
- **Metered like a message:** Send to Juno, Ask, Modify, Suggest, Turn into, Directions.
- **Refunded:** refused, truncated or invalid generations, and the automatic repair turn.
- The copy uses numbers, never meters: "Your 5-hour limit frees up at 14:00" (TWO_PRODUCTS §4).

---

## 9. Collaboration, sharing, publishing and governance

### 9.1 Two concepts, answering Q3

| | **People (grants)** | **Publish to the web** |
|---|---|---|
| Audience | Named people, pending emails, project members | Anyone with the link, **no sign-in** (one stated policy, resolving Claude's own contradiction) |
| Version | **Live**: always the latest | **Pinned**: `Share.versionId`, with an explicit **Update to vN** |
| Roles | Viewer · **Commenter** · Editor, on **every** type | View only; opens in Canvas or Play |
| Comments | Yes | Never. The snapshot carries none, and comments are never deleted to go public |
| Conversation | Private by default; an off-by-default switch lets people with access read the made-in chat | Never |
| Revoke | Remove the person | **Unpublish** reserves the token, so republishing restores the URL; **Reset link** issues a new one; link expiry on every plan |
| Phase | 5 (R-039) | 1 for the version pin and "no publish on open"; 2 for the full dialog (R-015) |

**Roles versus Claude's:** Claude gives Docs View and Edit only, and Design and Slides View, Comment and Edit. Juno gives **Commenter to every type**, because comments are the channel to Juno (C1, C2).

**Enforcement:**
- one helper, `canAccess(artifact, user, action)`, in every artifact, design, comment and export route;
- only the owner publishes, deletes or changes access;
- no seat gate: plan limits are quotas on the owner;
- concurrency in v1 is per-revision compare-and-swap plus a soft lease ("Maya is editing Hero"). Multiplayer cursors are R-074 (P2).

**Request access.** A signed-in person without access sees "You need access · Request access". The owner sees an accent dot on Share and a row in **Needs you**: "Ana asked to comment · Allow as commenter / Deny".

### 9.2 Comments (Phase 5; R-040)

- Comments live in the `ArtifactComment` table (§3.1), with anchors per kind from the registry, re-resolved on every version:
  - **exact:** nothing to show;
  - **fuzzy:** "Moved";
  - **unresolved:** **Lost**, with Re-attach or Make general.
  - A deleted node's pin moves to its parent frame, marked "(element removed)".
- **C** enters comment mode and **⇧C** hides pins. A right rail (a sheet at narrow widths) has filters for This version / All, Open / Resolved / Lost, and Mine.
- Writes are optimistic, with persisted local drafts, so **a comment is never lost**. That is Claude Design's known bug (03 §2.2).
- 100 comments per hour. Guest comments on public links stay **off**.

### 9.3 Notifications (Phase 5; R-042)

- Events are stored in the existing `Notification` table (`schema.prisma:612-630`): mention · reply · new thread on my artifact · access request or grant · Juno finished a comment request · an artifact finished in a run.
- **Web and Mac:** rows in the **Needs you** fold, not a bell or inbox destination (TWO_PRODUCTS §2.2).
- **iPhone:** APNs with Reply and, for editors, Ask Juno.
- **Email:** a 30-minute digest per artifact.

### 9.4 Governance (R-011): ships in Phase 0, with the preview origin

The preview origin does **not** ship unless every item below is live:

1. **Ban propagation.** `Share.suspendedAt` is set by a ban or a takedown, and is reversible. `ModerationFlag` can reference an artifact or share and **survives account deletion** (fixes X-31).
2. **Admin lookup and takedown**, by token, artifact or user, with Suspend and Restore, in the existing admin panel.
3. **A Report link** in every public page footer: a reason plus optional detail, no sign-in. It creates a `ModerationReport`. Above a threshold, the page is suspended pending review.
4. **Screening.**
   - Phase 0: at share creation (`POST /api/share`), which today skips every classifier (`share.ts:85-106`), and on manual writes to an artifact that has a live share (X-32).
   - Phase 2: at **Publish** and **Update**.
   - A refusal names its reason in one sentence.
   - A version produced in a turn that read untrusted web or connector content carries `taint: untrusted-input` in its provenance. Publishing it requires a screening pass.
5. **Rate limits**, through the existing atomic limiter (`rate-limit.ts:17-38`):
   - share and publish: 30 per hour;
   - head commits: 120 per minute per artifact and 3,000 per hour per account;
   - sealed versions: 60 per hour per artifact;
   - manual `POST /api/artifacts/[id]`: 600 per hour;
   - design export: 60 per hour;
   - comments: 100 per hour (Phase 5);
   - invites: 50 per day (Phase 5);
   - `origin: "restore"` is no longer client-chosen, which closes the X-33 DoS lever.
6. **Views move off the sync path** into `ShareViewDaily`, with bots and the owner excluded and no IP addresses (fixes M33; GDPR).
7. **The public footer:** "Made by a Juno user · not verified by Juno · Report", plus legal links. A suspended page reads "This page isn't available", without the owner's name.
8. **The legal notice-and-action contact** replaces `[adresse e-mail de contact]` (`legal/mentions-legales/page.tsx:41`). The owner supplies it (Q7).
9. **Quotas**, per plan, on the owner (§14.2 D16): active public links, stored bytes, and retention of unnamed versions. A downgrade never removes read or export access (R-067).
10. **Owner-visible activity** in Info: "Published v9 · Updated to v11 · Link expired · Suspended by Juno (Appeal)".

### 9.5 How the X-01 fix ships (R-012)

**The design:**
- Every preview is served **by `src`**, never `srcdoc`, from a **separate registrable domain** (for example `juno-usercontent.com`), with **one subdomain per artifact version** (`{hash(artifactId,version)}.juno-usercontent.com`). The parent's nonce and `strict-dynamic` policy (`csp.ts:31`) can therefore never be inherited again (`middleware.ts:55-77`; `sandbox-frame.tsx:918-929`).
- Access is a signed token `{artifactId, version | 'latest', grant, exp ≤ 5 min}`, re-validated on every load. Revoking means refusing the token.
- **The response CSP:**
  - `script-src`: cdnjs, jsDelivr `/npm/`, unpkg and Tailwind, with **runtimes pinned by version** and no dev UMD builds or unpinned Babel (`sandbox-frame.tsx:7-12`);
  - `style-src` and `font-src`: Google Fonts plus the same CDNs;
  - `img-src https: data: blob:`, which keeps PREMIUM_AUDIT §2e's photos;
  - **`connect-src 'self'`**, which is the anti-exfiltration line;
  - `form-action`, `base-uri` and `object-src` set to `'none'`;
  - no top-level navigation.
- The iframe keeps `sandbox` without `allow-same-origin`. Every guarantee `postMessage` relies on today is kept (source-checked bridge, re-validated URLs).
- Pages are capped at 16 MiB per version. A Chromium CI test renders a React artifact under the production headers. Firefox and Safari checks are added (the audit only tested Chromium).

**The release coupling.** Two flags:
- `artifacts.shareGovernance` deploys dark first and is then turned on for all accounts.
- `artifacts.previewOrigin` turns on only after it, per account, starting with the owner.
- In-app previews move first. Public `/share/*` pages move last, after governance has run clean for 7 days.

**Coordination.** A separate session may be fixing X-01. If it ships a same-host `src` route excluded from the middleware CSP as a stopgap, that route is acceptable **for in-app previews only**. Public share pages must keep scripts off until governance is live. The separate domain is still required before publishing is promoted, because the ClickFix campaign abused exactly a trusted first-party domain (03 §2.1).

### 9.6 Egress parity on Mac and iPhone (Q6)

- Today the web allows any `https:` source, and the Mac glass runtime is **fully closed**: `ArtifactRuntimeNetwork.isOpen = false`, a deliberate choice recorded in glass errata #21, pending the owner's sign-off.
- **Recommendation:** one written network policy, the allowlist in §9.5, **enforced identically** on the web preview origin and in the Mac and iPhone `WKContentRuleList`, with `connect-src 'self'` everywhere. Flip `ArtifactRuntimeNetwork` from closed to **allowlist** (not fully open) in the same release as R-012. That fixes H9 (X-13) without widening exfiltration.
- Bundling React, TypeScript and Pyodide runtimes on the Mac stays the long-term path, so offline previews work. The allowlist covers the gap until then.

---

## 10. Motion and visual design for the merged surface

### 10.1 Visual rules

- **Flat, one accent, tonal state** (FLAT_UI):
  - the surface is opaque on the warm canvas;
  - selected rows and chips are `bg-selected` with foreground ink, never `bg-primary/10` (fixes the drift in 01 §4.9);
  - the accent marks Juno acting (presence outlines, the changed-node halo), the primary action and the published globe's fill state, and nothing else.
- **Picture first, glyph second** (R-014):
  - posters on every card, tile, row (40×28), switcher entry, Made-here row, share page, `og:image`, search hit and Quick Look;
  - never colour alone;
  - skeletons are at the exact aspect ratio;
  - failure is a glyph tile reading "Preview unavailable", with Open.
- **Not copied from Claude:** the card lift, light sweep, under-sheet fan and tilt; clay reserved for AI. Hover is `hover:bg-accent` over `duration-fast` + `ease-out-soft`, plus the glyph's one `data-motion` gesture (ICONS_AND_MOTION §2.2 rule 1).
- **Hit targets:** 32px on fine pointers and 44px on coarse (web). 28pt pointer controls on the Mac (glass §0.6).
- **Radii** come from the ladder (`rounded-card` for cards, `rounded-control` inside), concentric per FLAT_UI §6. This fixes the inline card's off-ladder `rounded-md`.
- **Stacking** uses the four named rungs only (`z-popper`, `z-modal`, `z-toolbar`, `z-toast`).

### 10.2 Product motion, in Juno's tokens

Every value below is an existing token from `src/lib/motion.ts` or `globals.css:314-349`. One token is added: `--delay-reveal: 500ms` for skeletons (03 §7.1 names it as the missing piece).

| Moment | Spec | Reduced motion |
|---|---|---|
| **Card to panel** (only when the card is on screen at the click) | The poster morphs into the panel's content frame as a shared element: framer `layoutId="artifact-poster-{id}"`, `duration-slow` 360 on `ease-drawer` (numerically Claude's snap curve, `.32,.72,0,1`). The inner content cross-fades on `transition.fast`, because thumbnail and live view differ. The chrome fades in 60 ms later. The chat column narrows on `spring.layout` | Cross-fade, `duration-fast` |
| **Panel open** from a deep link or the library | 16px `x` plus fade on `duration-slow` + `ease-drawer` (the dock's current entrance) | Fade only (fixes L16) |
| **Auto-dock** (Juno opened it; the user did not) | 24px plus fade on `duration-slow` + `ease-drawer`. No focus. `aria-live`: "Juno opened Sign-in screen" | Fade only |
| **Panel close** | Exits to its edge on `duration-exit` 160 + `ease-in`. **No fly-back into the card**: selection never travels across a scroller (PREMIUM_AUDIT §2d). Scroll position restored | Fade |
| **Resize drag** | All transitions off while dragging, so the panel tracks the pointer 1:1. No entrance replay afterwards (fixes L15) | — |
| **Panel to full window** | The same mount grows with framer `layout` on `spring.layout` (360, bounce 0). The user caused it, so no emphasised spring. The transcript collapses into its column on `transition.exit` | Cross-fade `duration-fast` |
| **Full window back to chat** | Reverse on `spring.layout`. The transcript scroll offset is restored | Cross-fade |
| **Version change** (stepper, restore, a new version landing) | **A swap, never a remount.** Code and HTML render into a hidden frame, then cross-fade over `transition.fast`. Design adopts in the mounted editor (`adoptDocument`). The version number rolls (`RollingNumber`); the pill swaps with `IconSwap` | Instant swap with a 120 ms fade kept (rule 10) |
| **Change reveal** (Juno's edit lands) | Changed nodes get the selection-outline style, and changed text blocks a tonal fill, held about 800 ms and faded over `duration-emphasis` 560 on `ease-out-expo`, the rung "reserved for a change the user did NOT cause". Deleted ghosts fade on `transition.exit`. Off-screen changes show an edge chip, "4 changes ↓" | Static outline for 1.5 s, then a `duration-fast` fade |
| **Streaming into the object** | Skeleton blocks deal in with `animate-rise-in` and `staggerDelay(i, "tight")` (30 ms, cap 10). Filled blocks enter with `variants.fadeUp`. Design nodes enter with `variants.fade` on `transition.fast`. Later blocks move with framer `layout` on `spring.standard`. Auto-scroll only at the live edge; otherwise a "Writing: Risks ↓" chip | Opacity only |
| **Skeleton reveal** | After `--delay-reveal` 500 ms, fade in on `duration-fast`. The `.skeleton` breathe (1.8 s, `ease-breathe`) runs only while waiting for data | A static placeholder |
| **"Juno is working here"** | The target's outline breathes in brightness on `ease-breathe` at the live glyph's rhythm, and stops the moment the work lands. **One live-state animation product-wide** (fixes L17). A presence chip pops in with `variants.pop` | A static tint, no loop |
| **Edit card, receipts** | A new edit card rises with `variants.rise`. A superseded full card folds with `Collapse` and becomes a receipt | Rows snap; fade kept |
| **Library tiles** | Dealt with `staggerDelay(i, "base")` (45 ms, cap 10) on first load only. The poster cross-fades in on `duration-fast`. Filter changes cross-fade. The list/grid toggle uses `IconSwap` and does not replay the stagger | Fade only |
| **Camera** (fit, go to comment, frame changes) | `duration-slow` on `ease-in-out`, interruptible: any wheel, pinch or drag cancels it | Jump with a 120 ms cross-fade |
| **Tweaks and inspector drags** | No transition during the drag, so the canvas tracks the pointer. Release settles on `spring.interactive` | Unchanged; this is direct manipulation |
| **Exits** everywhere (save bar, conflict banner, proposal card, fullscreen, deleted rows) | The `exit` variant under `AnimatePresence`, or `Collapse` (fixes the 01 §5.1 missing exits) | Fade |

**Settings › Appearance › Motion: System | Reduced** ("Reduce animation in streaming replies, the panel and designs"). It sets `html[data-motion=reduced]`, which the existing tiered rules read alongside the OS query. On the Mac it maps to `JunoMotion.reduced` (R-072). The scope covers product motion, the stream-tail mask, and autoplay of authored motion in posters and cards. An explicit **Play** still plays.

### 10.3 Motion inside documents

Play, share pages and HTML export run **one runtime**: `compileMotion` to MotionIR, then `sample()`, then `emitWebAnimations` (R-019). It is proven by a Playwright conformance suite (preview equals export at 0, 25, 50, 75 and 100%) **before Play ships**. The five reproduced mismatches (M64, M65, L20, L21, L22) become fixtures.

Deck transitions use Claude's small vocabulary with Juno's timings (03 §7.4):
- **fade:** `duration-slow` + `ease-in-out`;
- **push:** `duration-slow` + `ease-drawer`;
- **magic:** matched nodes on `spring.layout`, the rest fading on `duration-fast`;
- **build-ins:** `variants.fade`, `rise` and `pop`, grouped at `STAGGER.base`;
- under reduced motion, every transition becomes a `duration-fast` cross-fade.

### 10.4 The Mac: Liquid Glass placement and JunoMotion

- **Glass stays chrome-only.** The glass plan allows system chrome plus exactly five custom sites (glass §0.1).
  - The ArtifactSurface header and body in the dock are **opaque**, as glass §9 specifies ("an opaque header row").
  - Floating layers that are overlay-glass on the web become **system popovers** on the Mac, drawn with system glass: the Tweaks card, the comment composer, the version list and the Share popover. That adds **no sixth custom glass site**.
  - Play and Present windows use the system toolbar, which auto-hides in full screen, instead of a custom player bar.
- **Motion:**
  - The dock enters on `JunoMotion.layout`, or the drawer curve, **not** `canvasEnter = outExpo` (fixes L17 mac, `JunoDesignTokens.swift:343`).
  - Under Reduce Motion, `shift()` removes the offset (fixes L16 mac).
  - The card-to-dock and library-to-window moves use `matchedGeometryEffect` on `JunoMotion.layout`.
  - Tiles press with `.junoPress` and hover with a tint on `JunoMotion.fast`.
  - State swaps use `.contentTransition(.symbolEffect(.replace))`.
  - Icons don't articulate on hover on the Mac (glass §0.8 #8).
- **Offscreen snapshot tests** guard the dock, card, window and the Artifacts page in light and dark, with the system accent set to Blue (the project memory's verification rule; the glass Phase 1 gate).

### 10.5 iPhone

- The sheet uses `animate-sheet-in` semantics: `duration-slow` + `ease-drawer`, detents at 50% and 92%, following the finger with transitions off while dragging.
- Card to sheet uses `navigationTransition(.zoom)` from the poster.
- Haptics: pin (existing), comment placed (medium), proposal applied (success).
- Reduce Motion becomes cross-fades.

---

## 11. Work deliverables

### 11.1 The decision: a hybrid, split by shape (Q1)

The schema records why `WorkArtifact` was built separately (`schema.prisma:2613-2618`, checked):

> "chat artifacts are text documents keyed to a conversation… a Work deliverable can be a 4 MB workbook in object storage… Sharing one table would mean `content String @db.Text` holding a base64 xlsx."

That reasoning is **right for binaries and wrong for documents**:
- a .docx or .pptx is a *rendering* of a typed spec;
- the spec is thrown away today (M72, 01 §2.7);
- so nothing can be edited, versioned with the conversation, shared or commented on.

Claude's merge made Docs and Slides typed artifacts and made files their exports.

| Work kind | After the merge | Editable source | File |
|---|---|---|---|
| `document` | **Doc** artifact | The Doc block JSON (the Work `document` spec maps 1:1 onto Doc blocks) | .docx and .pdf as `ArtifactExport` rows, validated by `validate.ts` |
| `report` | **Doc** artifact | Doc blocks (it is Markdown today) | .md, .docx, .pdf |
| `presentation` | **Deck** artifact | A Deck `DesignDocument`. The five fixed layouts in `presentation.ts:30-39` become frame templates | .pptx and .pdf as `ArtifactExport` |
| `spreadsheet` | **File** (`WorkArtifact`) | The spec is **persisted** (`specVersion`) for a future SHEET type | .xlsx, hash-verified |
| `pdf`, `bundle`, `archive`, `image` | **File** (`WorkArtifact`) | — | as today |
| `site` | **File** (`WorkArtifact`) | — | .zip. The preview runs on the preview origin. "Open as Page" imports `index.html` |

**Run behaviour after the merge:**
- `create_deliverable` for `document`, `report` or `presentation` calls the write service. It creates or appends the Doc or Deck with `authorKind: agent`, `runId`, and provenance, which **is now recorded** (fixes M72, `work-runner.ts:1826`). It then renders the export.
- Artifact identity is **per conversation**, `(conversationId, identifier)`, not per session. A deck revised in a later task is the same artifact, where `WorkArtifactVersion` today cannot span turns.
- The run's terminal card lists what the run made as **artifact rows** (poster, type, Open). It replaces the newest-previewable-file-only stage (`work-deliverable-stage.tsx:33-44`), which fixes X-25. That is a Phase 0 remount of the existing card kit, and a Phase 4 switch to artifact rows.
- Binary files appear in Artifacts › Files and in Made here, by reference.
- Work tasks started on the Mac or iPhone carry `conversationId` from glass Phase 5 (fixes X-29). Legacy tasks without one appear read-only under Search › Tasks.

### 11.2 Office export: one renderer

- `office-export.ts:450-611` and `work/deliverables/document.ts:173-358` are nearly identical OOXML renderers (00 §4.5). **Keep one**, the Work renderer with its validator, behind `exports.docx(doc)` in the registry.
- The MARKDOWN artifact's docx, xlsx and pptx export becomes "Upgrade to Doc, then export". Until then it calls the same renderer.
- Decks export PPTX **from the scene**, with native text boxes and shapes. The design exporter is absolutely positioned (`export.ts:505-516`), which is exactly PPTX's model.
- Fade and push map to PPTX transitions. Magic is listed as unsupported in the export sheet (every loss is listed before download, R-066).

### 11.3 Native Work fixes that ride along

- **The H10 envelope reader** (every cloud-run deliverable dropped on Mac and iPhone): fixed in the N1 tolerance release.
- **The H11 one-shot index read:** re-read on stream `artifact` events and on `.done`.
- **Mac-hosted runs producing deliverables** (`WorkCapabilityManifest.swift:76-95`): deferred until glass Phase 5.
- **Quick Look** for File references uses `NativeFilePreview`, which exists but is unwired.

### 11.4 Legacy rows

- Existing `WorkArtifact` rows of kind `document` or `presentation` have **no spec** to convert.
- They stay Files, read-only, labelled "From a task · file only".
- "Ask Juno to rebuild as a Doc" creates a new artifact from the extracted text, with `derivedFrom` pointing at the file.
- Nothing is converted silently.

---

## 12. Performance and telemetry

### 12.1 Payload diet

| Today | After |
|---|---|
| Every thread read ships every version body (`queries.ts:117-121`, `serializers.ts:207-223`): 9–27 MB raw after an hour of design editing (X-30, M12) | Metadata plus the **current body only**. Versions are paged metadata (`/versions?cursor=`), and bodies are fetched on demand |
| The SSE `done` frame and its encrypted stream log carry every version of each touched artifact (M13) | Touched artifacts only: metadata plus the new version's body. Posters load by URL |
| Message content duplicates artifact bodies | Reference tags (§7.5) |
| Each design transaction reads every version twice (`store.ts:33-39, 163-167`) | Reads the head row plus `currentVersion` metadata |
| Every design fold writes two sync changes and re-sends the full body to every device (M35: 135–400 MB per device per hour, inferred) | Heads aren't change-captured. Seals happen at most once per 90 s idle, and only the current body syncs |
| Every inline card mounts a sandbox eagerly (M24) | Static posters, and a live mount only for the latest card in view with the panel closed |
| The Canvas chunk statically imports `DesignEditor` (about 225 KB of about 449 KB, `canvas-panel.tsx:44`) | Kind renderers load lazily from the registry. A Page panel never loads design code |
| The native `snapshot()` decrypts the whole store about 8 times per wake-up (Mac M14) | Per-namespace reads (`AccountScopedStorage`), outside this proposal's code but a prerequisite for thousands of artifacts |
| The design library cannot serve large documents (X-08, X-09) | A size check after expansion; an external asset store; "Large design · 164k of 200k" at 80%; refuse only the one save that would exceed the limit, never lock the document (R-064) |

### 12.2 The poster pipeline (R-014)

- `GET /api/artifacts/{id}/render?v=&frame=&w=&fmt=`, cached in object storage under `(artifactId, version, frame, width, contentHash)`, with CDN headers.
- **Generated when a version seals, never per fold.**
- **Per kind:**
  - Design and Deck: `renderPageSvg`, after X-24 is fixed so container opacity and rotation are correct.
  - Page: a headless 1280×800 capture on the preview origin, through a small render worker (Playwright in a PM2 process, CPU-bounded and queued).
  - Doc: typeset lines.
  - Diagram: server-side Mermaid.
- Capability-scoped asset URLs, so owner-only Library images don't become holes (`api/files/[...key]/route.ts:19-36`).

### 12.3 Telemetry spine (R-020)

`src/lib/observability.ts` is imported by nothing today. X-01 went unnoticed for about four weeks.

- Wire it to one sink (§14.2 D19; recommended: a first-party `TelemetryEvent` table with sampled writes and a daily rollup, plus an error sink), with an internal dashboard at `/admin/artifacts`.
- Events carry no content, only ids, kinds, sizes and outcomes.

| Metric | Budget or alert (guard rail for flag rollout) |
|---|---|
| Preview render success, per runtime and platform | ≥ 98%. Alert below 95% (would have caught X-01 on day one) |
| Poster render success and p95 latency | ≥ 99%; p95 < 3 s after seal |
| Time to the first skeleton and to first content, per kind | Skeleton p95 < 1.5 s after send |
| Completion (complete / stopped / truncated / refused, with reason) | Truncation below 2% for Design, Deck and Doc |
| Proposals shown / applied / discarded; hunks accepted | Tracked; no fixed budget in v1 |
| 409 retries; "their words win" drops | Tracked; alert on a spike |
| Head commit p95; seal count per artifact-hour; fold-to-seal ratio | Commit p95 < 250 ms |
| Thread payload p95 (raw and gzip) | < 1.5 MB raw at the p95 conversation |
| Artifact open p95 (panel, window, native) | < 800 ms web, < 1 s Mac |
| Shares by scope and pinned versus latest; bot-filtered views | Tracked |
| Suspensions, reports, screening refusals | Every one reviewed |
| Native: unsupported kinds seen, skipped rows, bridge refusals (`lastRefusal`, now reported), editor bundle version in the field, `artifacts=n` adoption | The N1 gate: ≥ 95% adoption |
| Output picker use; "Make this a … instead" use; per-type off switches | Routing quality signal |

**The golden evaluation** (00 §12.9) is built **before Phase 3**: about 40 prompts across kinds × a model matrix, measuring validity, render success, a visual rubric and structure preservation. `scripts/eval-juno.ts` makes no model calls today. Phase 3 and Phase 4 exits require no regression against it.

---

## 13. Roadmap

### 13.1 The staging principle

Claude staged its merge:
1. one home for projects and artifacts (07-07);
2. an account-owned, versioned artifact system (08-19);
3. the merge, with Docs and Slides, and the toggle removed last (09-16).

Juno follows the same order. **Data first, then the surface, then the AI loop, then new types, and the Design door removed from the world last.** The owner dogfoods every step.

### 13.2 Phases

Each phase lists what it contains, what it closes, its exit criteria, its flags and its rollback. Effort is indicative, for one engineer plus the model: S under a week, M 1–2 weeks, L 2–4 weeks.

#### Phase 0: stop the bleeding (M–L; now)

**Contents:**
- **Merge and deploy `7243613f`** (X-03, X-04). Until it is deployed, the glass branch's settled-answer regenerate must not ship; stage 3's confirmation dialog stays either way.
- **X-02 fix:** mount the Canvas design editor by artifact id and use the returned artifact, never a synthetic `""` version. A separate session may own this, so this proposal only requires that the fix mounts by id (R-013's rule).
- **X-01 with governance** (R-011, R-012, §9.4, §9.5).
- **X-07 minimal:** an unclosed tag or a stop never updates `currentVersion`; the card says "Stopped". The full `complete` flag lands in Phase 1.
- **X-08:** a size check after expansion.
- **X-10:** drop `image` from the compact grammar in the prompt until assets exist.
- **X-23:** RFC 5987 `filename*`.
- **X-21:** read `items` and scope by project.
- **X-20, minimal:** DESIGN cards, tiles and share pages render `exportSvg` instead of JSON.
- **X-22, minimal:** delete dialogs name the artifacts that will go.
- **X-25:** remount the deliverable card kit for all kinds, with verdicts.
- **X-26:** account deletion purges deliverable objects.
- **Native N1 tolerance release** from `main` (R-001, X-09, H10), with the X-19 bundle gate and CSS fix (X-17), `surface="window"` (X-18), and the R-002 iPhone read-only guard.
- **R-003:** keyframe Delete no longer deletes layers.
- **R-020:** the telemetry spine.

**Closes:** X-01, X-02, X-03, X-04, X-07 (partial), X-08, X-09, X-10 (partial), X-17, X-18, X-19, X-20 (partial), X-21, X-22 (partial), X-23, X-25, X-26, X-31, X-32 (partial), X-33 (partial), L5.
**Backlog:** R-001, R-002, R-003, R-011, R-012, R-020.

**Exit:**
- the Chromium CI test passes on the preview origin under production headers;
- the Firefox and Safari manual checks are recorded;
- the ban-suspension test is green;
- the lifecycle tests (`tests/artifact-lifecycle.test.ts`) are green on `main`;
- `node scripts/build-design-editor.mjs --check` passes in `native.yml` and the Mac release;
- the N1 release is published;
- the preview success metric is live.

**Flags:** `artifacts.shareGovernance` (on for all), `artifacts.previewOrigin` (per account).
**Rollback:** turning `previewOrigin` off returns to srcdoc, where previews are dead but safe. Governance stays on.

#### Phase 1: first-class artifacts (L)

**Contents:**
- the N2 additive migration, backfills 1–6 and the write service (§3.2);
- `ArtifactHead`, replacing fold-in-place;
- the version fields and `complete` (R-005, R-007);
- trash (R-006);
- the registry, charter and generated Swift/OpenAPI (R-008);
- **N3 constraint flip after the N1 gate**: ownership, a nullable made-in conversation, conversation delete detaching (R-004);
- `Share.versionId`; the share dialog stops publishing on open; "Update to vN" (the R-015 core);
- the payload diet (§12.1);
- the X-24 renderer fix (a poster prerequisite);
- account export includes artifacts (R-067);
- native drafts on disk (R-065, Mac and iPhone).

**Closes:** X-07, X-22, X-24, X-30, X-33, M9, M10, M11, M12, M13, M29, M30, M31, M33, M35, L6, L9 (data).
**Backlog:** R-004, R-005, R-006, R-007, R-008, R-015 (core), R-064, R-065, R-067.

**Exit:**
- 100% of artifacts have `userId`;
- the detach-on-conversation-delete test passes;
- restoring from the trash returns the same share token (test);
- no code path updates an `ArtifactVersion.content` (grep test plus a DB trigger that raises on UPDATE of `content`);
- the share leak test for M31 passes;
- thread payload p95 is within budget;
- old-client fixtures pass.

**Flags:** `artifacts.ownership` (server), `artifacts.workingHead`.
**Rollback:**
- The migrations are additive.
- The constraint flip is reversible by re-adding NOT NULL only after re-attaching.
- With `workingHead` off, transactions **append** versions, never fold in place again.

#### Phase 2: one surface; Design becomes a type (L). The owner dogfoods from here.

**Contents:**
- `ArtifactSurface` in all sizes (R-016), with adopt-not-remount (R-013);
- posters everywhere (R-014);
- the container-sized editor (R-017);
- the Artifacts home on Library machinery, with Design as a filter and a New action (R-018);
- the stepper, compare and restore (R-022);
- one live card plus receipts (R-023); the card anatomy (R-024);
- canonical links, universal links and Handoff (R-025);
- modes in one segmented control (R-026);
- New creates the artifact first (R-027);
- **the Output picker** (R-028);
- the keyboard and screen-reader contract (R-063);
- motion hygiene and the motion spec (R-021, R-070, R-071, R-072);
- pin (R-075, the pin part);
- the redirects (307);
- **Mac:** the Artifacts page without a Design row, the row-backed dock with the surface header, document windows (R-068), on glass Phases 4 and 5 or a `main` backport;
- **iPhone:** the sheet and Artifacts filters.

**Closes:** X-11, X-12, X-15, X-16, X-20, M14, M15, M16, M17, M19, M20, M21, M22, M23, M24, M26, M27, M28, L8, L15, L16, L17, L18, L27, L30, L31, L32, L34, L36, L37, L38, L39; 02 §5 "three doors".
**Backlog:** R-013, R-014, R-016, R-017, R-018, R-021, R-022, R-023, R-024, R-025, R-026, R-027, R-028, R-063, R-068, R-070, R-071, R-072, R-075 (pin).

**Exit:**
- Every entry point opens `/a/{id}` or the panel on the same id.
- A DOM test asserts that no surface renders `"schemaVersion"` by default.
- The type-to-glyph lint passes.
- 10 consecutive checkpoints in the panel editor happen without a remount (component test; add testing-library and jsdom, which Juno lacks today, 01 §9).
- The Mac dock, library and window are one row-backed view, and offscreen snapshot tests are green.
- `/dev` galleries exist for the surface, the Artifacts home and the share page (the project memory's web verification rule).
- Open p95 is within budget.

**Flags:** `artifacts.unifiedSurface`, `artifacts.designAsType` (sidebar row and redirects), `artifacts.outputPicker`.
**Rollback:** flags off bring back `CanvasPanel`'s old body and the `/design` pages. The 307 redirects stop.

#### Phase 3: Juno edits what is there (L–XL)

**Contents:**
- the current-version digest, verbs, compare-and-swap and people-win (R-009);
- one AI channel with edit cards, and Ask Juno folded in (R-010);
- branches: Try 2, Use this, Compare (R-029);
- view context and the selection chip (R-031);
- the tool contract (R-032);
- skeleton-first streaming and steering (R-033);
- presence and change reveal (R-034);
- the render check and Fix with Juno (R-035);
- fair usage (R-036);
- queued asks (R-038);
- craft rules, the design lint and the golden evaluation (R-047);
- the taste form for first drafts (R-045);
- **reference tags in the transcript** (§7.5).

**Closes:** X-05, X-06, X-10, M1, M4, M7, M40, M41, M42, M46, M47, M59, L1, L3, L87, L88.
**Backlog:** R-009, R-010, R-029, R-030 (Docs default), R-031, R-032, R-033, R-034, R-035, R-036, R-038, R-045, R-047.

**Exit:**
- The golden evaluation baseline is recorded, with no regression.
- The 3-animations-and-5-interactions test passes.
- The hand-edit-survives-follow-up test passes.
- `/api/design/[id]/edit` has no UI caller.
- A stopped turn never becomes current (probe).
- The truncation rate is within budget.
- Proposal telemetry is live.

**This is the owner's day one (§1.4).**
**Flags:** `artifacts.modelEditsCurrent`, `artifacts.transcriptRefs`.
**Rollback:** turning the flag off restores full re-emits, **keeping** compare-and-swap and complete checks. Reference tags are rewritten back on read.

#### Phase 4: Docs, Decks and Work. **Public launch** (XL)

**Contents:**
- the Doc type (R-058) and the Deck type on the design engine (R-059);
- the motion runtime and conformance (R-019), transitions (R-055), prototype behaviour (R-056), Play and Present (R-057), bridge v2 with Play on Mac and iPhone (R-060), animation presets (R-052);
- one export sheet with honest losses and "Build it with Juno Code" (R-066);
- the Work hybrid (§11): X-25 moves to artifact rows; X-27, X-28 and X-29 through glass Phase 5 plus the web;
- Made here (R-079);
- generated media in the index (R-092);
- inline visuals kept (R-077);
- templates;
- N5 emission of the new kinds, with down-conversion;
- **the public launch:** the Design pointer row is removed, and redirects become 308.

**Closes:** X-25, X-27, X-28, X-29, M61, M62, M63, M64, M65, M69, M70, M71, M72, M73, M74, L20, L21, L22, L24, L25, L26, L67.
**Backlog:** R-019, R-052, R-055, R-056, R-057, R-058, R-059, R-060, R-066, R-077, R-079, R-092.

**Exit:**
- Docs and Decks ship **with versions, trash, the stepper and a commenter-ready role**, which avoids Claude's anti-pattern.
- PPTX and DOCX pass `validate.ts` and open in Keynote and Word (manual matrix).
- Work `document` and `presentation` produce artifacts.
- The conformance suite is green.
- Old clients see down-converted kinds, not a blank library (fixture test plus an installed-1.6.0 manual check).

**Flags:** `artifacts.types.doc`, `artifacts.types.deck`, `artifacts.play`, `work.deliverablesAsArtifacts`.
**Rollback:** turning a type off stops the model emitting it. Existing Docs and Decks stay readable and exportable, and are never deleted.

#### Phase 5: people (L–XL)

**Contents:**
- grants, project inheritance and Request access (R-039);
- comments (R-040);
- sending comments to Juno (R-041);
- notifications (R-042);
- the phone contract, which lifts R-002 (R-069);
- provenance and conversation privacy (R-073);
- tweaks (R-043);
- async presence (R-074, the first part);
- N6 comment and grant entities.

**Closes:** 03 §5 matrix rows 42, 43, 46, 50, 64 and 65; L71.
**Backlog:** R-039, R-040, R-041, R-042, R-043, R-069, R-073, R-074 (part).

**Exit:**
- An invite can view, comment, request and get approved, end to end.
- A comment survives five versions, including an orphan case.
- Send to Juno round-trips and replies in the thread.
- iPhone design edits go through transactions and adopt remote versions.

**Flags:** `artifacts.grants`, `artifacts.comments`, `artifacts.phoneEditing`.
**Rollback:** flags off hide the features. Data is kept.

#### Phase 6: design systems and beyond (XL, continuous)

R-051 (the Design system type), R-048, R-049, R-050, R-053, R-054, R-044, R-046, R-078 (Turn into), R-080 (embeds), R-081, R-082, R-083, R-085 to R-089, R-093 to R-101.

**The editor-craft track runs in parallel from Phase 1 and gates nothing:** R-061, R-062, R-090, R-096 (M48 to M58, L52 to L66).

### 13.3 What must NOT ship before what

| Must not ship… | …before | Why |
|---|---|---|
| The preview origin (X-01 fix) for public pages | Governance (R-011) live for 7 days | Scripted public pages without takedown or egress control repeat ClickFix (00 §12.8) |
| Any server emission of DOC, DECK or DESIGN_SYSTEM | The N1 tolerance build as the minimum supported version, **or** down-conversion live | One unknown kind blanks the native library (X-09) |
| Any new sync entity (`artifact_comment`, `artifact_grant`) | Its string in the allowlist of the **oldest supported** build | An unknown entity stops that device syncing for the whole account (`NativeSyncAPIClient.swift:141-190`) |
| `conversationId` nullable (N3) | N1 decodes it as optional, **and** sync loaders authorise by `userId` | Old builds fail closed; loaders would leak or drop rows |
| The glass branch's settled-answer regenerate | `7243613f` deployed | Widens X-04 exposure |
| Removing the Design row or redirecting `/design` | Posters (R-014), the X-02 fix, the row-backed Mac dock, the X-19 bundle gate | Otherwise the merge makes the JSON and the broken editor the front door |
| Model edits against the current version (R-009) | Immutable versions and heads (R-005) | Compare-and-swap needs stable version ids; folds break it |
| Publish and Update UI | The `Share.versionId` backfill | Pinning needs a version to pin |
| Play or Present, anywhere | The R-019 conformance suite green | Figma's Motion end-state flash lasted about 12 weeks (03 §3.2) |
| Docs and Decks | Versions, trash, stepper, commenter role | Claude's most-cited gap is exactly this (03 §8 #1) |
| Re-enabling iPhone design editing | Transactions plus adopt plus drafts on disk (R-065, R-069) | X-14, X-15, M13 (mac) |
| Comments sent to Juno | The comments table plus a lazily created made-in conversation | Comments must survive versions and have somewhere to become a turn |
| Reference tags in the transcript | The artifact digest in context (R-009) | Otherwise the model loses the artifact entirely |
| 308 (permanent) redirects | The public launch | Rollback must not be cached |
| Grants for Page artifacts with runtime capabilities (R-076) | The viewer-scoped connector model | Connector-backed artifacts can never be public (Claude rule) |

### 13.4 Flags

- A small `src/lib/flags.ts`: defaults from the environment, per-account overrides in a `UserFlag` table, and flags exposed to native through `/api/v1/bootstrap` (glass Phase 6 plans server-driven items there).
- The owner is first on every flag.
- Every flag has a telemetry guard rail from §12.3.
- Flags: `shareGovernance`, `previewOrigin`, `ownership`, `workingHead`, `unifiedSurface`, `designAsType`, `outputPicker`, `modelEditsCurrent`, `transcriptRefs`, `types.doc`, `types.deck`, `play`, `work.deliverablesAsArtifacts`, `grants`, `comments`, `phoneEditing`, `types.designSystem`.
- `capabilities.ts` statuses are updated honestly as flags flip (03 §8 anti-pattern).

### 13.5 Coordinating concurrent sessions

- **One releaser per phase** (project memory). `canvas-panel.tsx` and `chat-view.tsx` are touched by the X-02 session and by Phase 2, so Phase 2 starts **after** the X-02 fix lands and rebases on it.
- **Glass:** the merge's Mac work lands in the glass worktree's phase order. The N1 tolerance release is the one exception and is cut from `main`. Nothing in this proposal edits the glass worktree.

---

## 14. Risks, and decisions for the owner

### 14.1 Risks and mitigations

| # | Risk | Likelihood · impact | Mitigation |
|---|---|---|---|
| 1 | Native fleet on old builds: new kinds or entities blank libraries or stop sync | High · critical | N1 first; `artifacts=2` header; server down-conversion; null-conversation rows filtered for old clients; allowlist-before-emit; installed-1.6.0 manual check at every phase exit |
| 2 | The glass branch ships late, and the merge's Mac surface waits on it | High · medium | N1 comes from `main`. Phase 2's Mac scope is the minimum on `main` if glass slips (dock header, Artifacts filter, no Design row); the full Mac document experience rides glass |
| 3 | The preview origin re-enables abuse | Medium · high | Governance first; a separate registrable domain; `connect-src 'self'`; screening at share and publish; takedown and ban propagation; public pages last |
| 4 | Working-head semantics confuse people ("where did my edit go?") | Medium · medium | "Saved" in the header; the stepper's top row reads "Current edits"; seal on share, publish and Juno turns; restore always seals first |
| 5 | Patches and operations fail more on weaker models | Medium · medium | Kind-aware tier routing; rewrite-with-review fallback; the golden evaluation gates Phase 3; refunds (R-036) |
| 6 | Doc and Deck editors balloon in scope | High · high | Doc v1 is a minimal block set. Deck **reuses** the design editor in a profile. SHEET is deferred. Claude-faithful "types ship with versions" beats feature breadth |
| 7 | Timestamp shares already leaked fold edits (M31) | Known · medium | `mayHaveLeaked` backfill; the owner decides on notification (D9); pinned versions from Phase 1 |
| 8 | The union index is slow for large accounts | Low · medium | `(userId, deletedAt, updatedAt)` indexes; a `(updatedAt, id)` cursor; a materialised view if p95 exceeds 300 ms |
| 9 | Permanent redirects cached during rollback | Medium · medium | 307 until the public launch |
| 10 | Concurrent sessions collide in canvas and chat files | High · medium | One releaser; Phase 2 after X-02 lands; gate the exact tree committed (project memory) |
| 11 | Stronger-tier routing for designs raises spend | Medium · low | Usage windows already bound it (TWO_PRODUCTS §4); telemetry per kind; refunds only for Juno's failures |
| 12 | The interim iPhone read-only guard (R-002) reads as a regression of a Juno lead | Certain · low | Honest copy; time-boxed to Phase 5; view, Play and Ask stay |
| 13 | Opaque routing complaints (Claude's top HN issue) | Medium · medium | Type word on every card; "Make this a … instead"; the Output picker; per-type off switches |
| 14 | Losing Juno's strengths in the refactor: the operation layer, patch compare-and-swap, one bundle, the token ladder | Low · high | The write service wraps, not replaces, `operations.ts` and `artifact-edit.ts`; the bundle gate; token-only motion; "Where Juno already leads" (03 §1) as a review checklist |
| 15 | GDPR: views, comments on public pages, reported content | Medium · high | Aggregate views without IPs; guest comments off; the legal contact filled; takedown evidence survives account deletion |

### 14.2 Decisions the owner must make (each with a recommendation)

| # | Decision | Recommendation |
|---|---|---|
| **D1** (Q1) | WorkArtifact: unify the tables, or only the list? | **Hybrid.** Document, report and presentation become Doc and Deck artifacts with the spec as source and Office files as `ArtifactExport`. Binaries stay `WorkArtifact`, listed by reference. Persist every spec from Phase 4 |
| **D2** (Q2) | Library fold or three siblings? Design a destination or a type? | **Artifacts stays a sibling of Library. Design becomes a type, a filter and a New action.** Withdraw REWORK_PLAN's fold; amend TWO_PRODUCTS §3 in `docs/OPEN_DECISIONS.md` |
| **D3** (Q3) | Public link: frozen, live, or both? | **Both, as separate concepts.** Publish is a pinned snapshot with Update and Unpublish that keeps the URL. People grants are live latest |
| **D4** (Q4) | Should regenerate ever delete an artifact? | **Never.** Merge and deploy `7243613f` now; Try 2 siblings in Phase 3 |
| **D5** (Q5) | Where do comments live? | **In their own table**, anchored per kind, version-aware. Guest comments on public links off |
| **D6** (Q6) | Artifact network egress; untrusted-turn artifacts | **One allowlist policy on web, Mac and iPhone** (pinned CDNs, Google Fonts, https images, `connect-src 'self'`). Flip the Mac runtime from closed to allowlist. Untrusted-input versions need screening to publish; they run normally in the app |
| **D7** (Q7) | Legal contact; reversible ban suspension | **Suspend reversibly** (`Share.suspendedAt`). The owner names the notice-and-action contact before Phase 0 exit |
| **D8** (Q8) | Artifacts in private chats | **Keep Canvas off in private chats for v1** (Claude's incognito also falls back). Revisit with session-only, never-persisted artifacts after Phase 4 |
| **D9** (Q9) | Run the production counts; notify leaked-share owners? | **Run the read-only SQL before Phase 1.** Notify owners of `mayHaveLeaked` DESIGN shares in-app ("This link may show later edits · Review"), not by email |
| **D10** | Ship the Output picker, given TWO_PRODUCTS §2.2 | **Yes, optional and default-off**, recorded as a scoped amendment (format choice is not capability choice) |
| **D11** | Deck format: HTML sections (Claude) or the design engine | **The design engine** (a DesignDocument profile). One editor, operations, posters, PPTX from absolute positions |
| **D12** | Canonical URL | **`/a/{id}`** (short, typeless, rename-proof, one AASA pattern) |
| **D13** | iPhone design editing until saves are safe | **Read-only now (R-002)**, lifted by the phone contract in Phase 5 |
| **D14** | Spreadsheet as a type | **Not in v1.** A File kind with its spec persisted; SHEET considered after Doc tables ship |
| **D15** | The preview domain | **Buy and configure a separate registrable domain** (for example `juno-usercontent.com`) with a wildcard certificate, before Phase 0 exit |
| **D16** | Quotas per plan | **Proposed:** active public links 3 (Free) / 100 (Pro) / 1,000 (Max); stored artifact bytes 1 GB / 20 GB / 100 GB. Never limit read or export |
| **D17** | Version retention | **Keep** named, published, commented, model and restore versions forever. **Prune** unnamed user autosaves beyond 50 per artifact, keeping one per hour for 30 days |
| **D18** | Generated images in Library, Artifacts or both | **Both** (one object, one viewer) |
| **D19** | Telemetry sink | **A first-party `TelemetryEvent` table plus an internal dashboard**, with no content and no IPs, and a vendor error sink if one is already approved in `docs/SUBPROCESSORS.md` |
| **D20** | Release vehicle for the N1 tolerance build | **A 1.6.x patch from `main` for Mac and iPhone now.** The glass branch merges it. Do not wait for glass to finish |

---

## Appendix A: audit defects (X-ids) by phase

| Phase | X-ids closed |
|---|---|
| 0 | X-01, X-02, X-03, X-04, X-07 (partial), X-08, X-09, X-10 (partial), X-17, X-18, X-19, X-20 (partial), X-21, X-22 (partial), X-23, X-25 (remount), X-26, X-31, X-32 (partial), X-33 (partial) |
| 1 | X-07, X-22, X-24, X-30, X-33 |
| 2 | X-11, X-12, X-15, X-16, X-20 |
| 3 | X-05, X-06, X-10 |
| 4 | X-25 (artifact rows), X-27, X-28, X-29 |
| 5 | X-14 closed for good through the generated Swift mirror (patched in glass stage 3); X-32 fully (screening at publish plus reports) |
| Decision | X-13, through D6 (one allowlist on every platform) |

## Appendix B: backlog (R-ids) by phase

| Phase | R-ids |
|---|---|
| 0 | R-001, R-002, R-003, R-011, R-012, R-020 |
| 1 | R-004, R-005, R-006, R-007, R-008, R-015 (core), R-064, R-065, R-067 |
| 2 | R-013, R-014, R-016, R-017, R-018, R-021, R-022, R-023, R-024, R-025, R-026, R-027, R-028, R-063, R-068, R-070, R-071, R-072, R-075 (pin) |
| 3 | R-009, R-010, R-029, R-030, R-031, R-032, R-033, R-034, R-035, R-036, R-038, R-045, R-047 |
| 4 | R-019, R-052, R-055, R-056, R-057, R-058, R-059, R-060, R-066, R-077, R-079, R-092 |
| 5 | R-039, R-040, R-041, R-042, R-043, R-069, R-073, R-074 (part) |
| 6 | R-044, R-046, R-048, R-049, R-050, R-051, R-053, R-054, R-075 (rest), R-076, R-078, R-080, R-081, R-082, R-083, R-084, R-085, R-086, R-087, R-088, R-089, R-091, R-093, R-094, R-095, R-097, R-098, R-099, R-100, R-101 |
| Editor-craft track (parallel, gates nothing) | R-037, R-061, R-062, R-090, R-096 |

## Appendix C: open questions (00 §13) and where this proposal answers them

| Question | Answer |
|---|---|
| Q1 | D1 |
| Q2 | D2 |
| Q3 | D3 |
| Q4 | D4 |
| Q5 | D5 |
| Q6 | D6 |
| Q7 | D7 |
| Q8 | D8 |
| Q9 | D9, and backfill step 0 |

REWORK_PLAN Q6, "Does design survive?", is answered as follows: **yes, as a type.** Its editor, operations and export survive intact. Only the destination goes.
