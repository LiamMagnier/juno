# R1-lite spec: artifacts survive their chat, Recently deleted, and the re-emit guard

## 0. What ships, as flags

| Flag (env, read by `src/lib/artifact-flags.ts`) | Default | Plan name | Off means |
|---|---|---|---|
| `JUNO_LIFECYCLE_DETACH_ON_DELETE` | on (`!== "0"`) | `lifecycle.detachOnDelete` | A conversation delete cascades artifacts again (today's behaviour). The anchor stays hidden and stays refused. |
| `JUNO_AI_REEMIT_GUARD` | on | `ai.reemitGuard` | Every re-emit appends a version (today's behaviour). |
| `JUNO_ARTIFACTS_TRASH` | on | `artifacts.trash` | `DELETE /api/artifacts/[id]` hard-deletes (today's behaviour). Reads keep hiding rows that are already trashed. |
| `JUNO_ARTIFACTS_PURGE` | **off** (`=== "1"`) | — | The purge daemon only logs what it would delete. |

The plan's `FeatureFlag` table and `flags.ts` are deferred (§10). There is no flag plumbing today; X-01 used `JUNO_PREVIEW_ORIGIN_PUBLIC` in the same way (`src/lib/sandbox-policy.ts:93`).

## 1. What main already has (checked)

- `/a/{id}` exists (b4206be9). So do type immutability without the derivedFrom columns (6df1620d, `artifacts-store.ts:69-71,108-129`), X-07 core (91e49022), the compact image placeholder (d04065c6) and X-03/X-04 (7243613f).
- **The three delete paths.** `src/app/api/conversations/[id]/route.ts:80-90` (single), `src/app/api/conversations/route.ts:72-81` (bulk, which deletes **every** kind, code included) and `src/app/api/v1/mutations/route.ts:134-139` (native, inside a Serializable transaction at `:34-51`). There is also `src/lib/agents/store.ts:453`, which deletes a thread it has just created after losing a race; it never holds artifacts.
- **The only artifact hard delete** is `src/app/api/artifacts/[id]/route.ts:124`.
- **Change capture.** `juno_change_conversation` is `AFTER INSERT OR UPDATE OR DELETE … juno_record_account_change('conversation','direct')` with no WHEN clause (`20260716200000_account_change_log/migration.sql:112`). Artifacts use the `'conversation'` resolver (`:116`), and versions resolve by joining Artifact to Conversation (`20260815180000…/migration.sql:52-54`).
- **Sync loaders.** `src/lib/sync-entities.ts:109-136` (conversation) and `:227-262` (artifact and artifact_version). `buildEntityEnvelopes` (`src/lib/sync-entity-envelope.ts:45-71`) already turns "revision exists, loader omitted the row" into a well-formed tombstone. That is the projection mechanism this release uses for trash.
- **Tag parsing.** `parseArtifacts` skips empty bodies (`message-content.ts:101`). `splitMessageContent` still emits a card part for an empty-body tag (`:273-277`). On native, an empty body draws no card and leaves no tag text (`NativeMessageContentTests.swift:124-131`).
- **Scheduled jobs** are long-lived PM2 loops (`deploy/ecosystem.config.js:316-330`, `juno-code-sweeper`, `--daemon`) or a documented crontab entry (`deploy/VM_SETUP_GUIDE.md:274`).
- **CI constraints** (`deploy.yml`): "Migrations reproduce the schema" blocks on drift (`:299-326`); `CREATE INDEX CONCURRENTLY` is forbidden (`:247-262`); database suites each get their own step and database (`:352-396`); `npm test` runs without `--experimental-test-module-mocks`, so mock-based suites must skip when mocks are unavailable (pattern from edbb8456).
- **Title plumbing.** `document-title.tsx:28-63` and `route-title.ts:37` (`/a` → "Artifact").
- **Placeholder notes are unused in chat.** `normalizeDesignArtifactWithNotes` exists (`authoring.ts:271-293`), but verification calls `normalizeDesignArtifact` (`chat-artifact-verification.ts:108,142`).
- **Import accepts any kind string of 50 characters or less** (`history-import.ts:471` → `import/route.ts:652`). It must be coerced to chat or code.

## 2. Data model

### 2.1 Prisma diff (`prisma/schema.prisma`)

```prisma
model Conversation {
-  // Which surface owns this conversation: "chat" (web + app chat) or "code"
-  // (Juno Code sessions synced from the app).
+  // "chat" (web + app), "code" (Juno Code), or "anchor": the account's one hidden
+  // home for artifacts whose chat was deleted, id `anchor_<userId>`
+  // (src/lib/conversation-visibility.ts). Never listed, searched, counted, synced,
+  // or written to by a chat route (04-MERGE-PLAN §3.5). Exception to TWO_PRODUCTS §5,
+  // recorded in docs/OPEN_DECISIONS.md; ends at contraction (M10).
   kind              String    @default("chat")
 }

 model Project {
+  artifacts          Artifact[]
 }

 model Message {
+  artifactProposals ArtifactProposal[]
 }

 model Artifact {
   ... unchanged ...
+  /// The artifact's own project once it has no chat (it sits in the anchor).
+  /// Null while it is in a chat, whose projectId is the truth. SetNull on project delete.
+  projectId      String?
+  /// Recently deleted: hidden from lists, search, projects and sync; purged after 30 days.
+  deletedAt      DateTime?
+  /// "user" is the only writer in this release ("conversation" | "project" later).
+  deletedReason  String?
+
+  project   Project?           @relation(fields: [projectId], references: [id], onDelete: SetNull)
+  proposals ArtifactProposal[]
+
+  @@index([projectId])
+  @@index([deletedAt])
 }

+/// Juno's work that is not (yet) a version (04 §2.7). Never change-captured,
+/// never synced, never shared, never pinned. M4 (R7) adds the rest.
+model ArtifactProposal {
+  id          String    @id @default(cuid())
+  artifactId  String
+  baseVersion Int
+  role        String    @default("suggestion")  // suggestion | try | draft
+  kind        String    @default("REWRITE")     // REWRITE only in R1
+  payload     Json                              // { content, title, language }; content is the STORED form
+  summary     String    @default("")
+  messageId   String?
+  taint       String?                           // "untrusted-input" | null
+  status      String    @default("PENDING")     // PENDING | APPLIED | DISCARDED | STALE
+  createdAt   DateTime  @default(now())
+  resolvedAt  DateTime?
+
+  artifact Artifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
+  message  Message? @relation(fields: [messageId], references: [id], onDelete: Cascade)
+
+  @@index([artifactId, status])
+  @@index([messageId])
+}
```

- There is no userId column on either model, so `tests/ownership-guard.test.ts` and `db.ts` are untouched.
- Deleting a message deletes its proposals. That is deliberate: a suggestion only lives as long as the reply that made it, which covers edit-truncation (X-03 path) and chat deletion.

### 2.2 Migration SQL (`prisma/migrations/20260925120000_artifact_lifecycle_r1/migration.sql`)

Generate the DDL part with `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` so names match Prisma exactly, then append the trigger block. Expected shape:

```sql
ALTER TABLE "Artifact" ADD COLUMN "projectId" TEXT, ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedReason" TEXT;
CREATE TABLE "ArtifactProposal" (
  "id" TEXT NOT NULL, "artifactId" TEXT NOT NULL, "baseVersion" INTEGER NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'suggestion', "kind" TEXT NOT NULL DEFAULT 'REWRITE',
  "payload" JSONB NOT NULL, "summary" TEXT NOT NULL DEFAULT '', "messageId" TEXT, "taint" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "ArtifactProposal_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Artifact_projectId_idx" ON "Artifact"("projectId");
CREATE INDEX "Artifact_deletedAt_idx" ON "Artifact"("deletedAt");
CREATE INDEX "ArtifactProposal_artifactId_status_idx" ON "ArtifactProposal"("artifactId", "status");
CREATE INDEX "ArtifactProposal_messageId_idx" ON "ArtifactProposal"("messageId");
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArtifactProposal" ADD CONSTRAINT "ArtifactProposal_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactProposal" ADD CONSTRAINT "ArtifactProposal_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The account anchor never reaches the change feed (04 §3.5, §3.7 protection A).
-- One trigger per event set because a DELETE trigger's WHEN may not name NEW.
-- Same function, same arguments: no change to juno_record_account_change().
DROP TRIGGER IF EXISTS juno_change_conversation ON "Conversation";
CREATE TRIGGER juno_change_conversation AFTER INSERT OR UPDATE ON "Conversation"
  FOR EACH ROW WHEN (NEW."kind" <> 'anchor') EXECUTE FUNCTION juno_record_account_change('conversation', 'direct');
CREATE TRIGGER juno_change_conversation_delete AFTER DELETE ON "Conversation"
  FOR EACH ROW WHEN (OLD."kind" <> 'anchor') EXECUTE FUNCTION juno_record_account_change('conversation', 'direct');
```

- **Additive only.** No change to existing columns and no backfill: no anchors exist yet, and every new column is nullable or defaulted.
- **Locks.** The non-concurrent index builds on Artifact and the FK validation (all nulls) take short locks. Prisma wraps the file in one transaction, so the trigger swap is atomic; there is no moment when conversation changes go uncaptured.
- **What still fires, unchanged:**
  - `juno_change_artifact` fires on every move to the anchor, trash and restore. Owner resolution still works because the anchor row exists and has the owner's userId; parentEntityId becomes the anchor id.
  - `juno_change_artifact_version` fires on purge. Versions are deleted first, while the Artifact row still exists, so every version tombstone resolves an account.
  - ArtifactProposal has no trigger.
  - Account deletion: the anchor is deleted with no tombstone; its artifacts cascade exactly as today under the restored account-delete guard.
- Do not add a CHECK constraint or a partial index. The blocking drift check compares migrations against `schema.prisma`, and Prisma cannot declare either, so the check would fail.

## 3. Behaviour

### A. Artifacts survive chat deletion (slices S2, S1, S6)

**The anchor.**
- `ensureArtifactHome(tx, userId)` runs, inside the caller's transaction:
  `INSERT INTO "Conversation" ("id","userId","title","titleSource","kind","updatedAt") VALUES (anchor_<uid>, uid, 'Your artifacts', 'system', 'anchor', CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING`.
  It then re-reads `id, userId, kind` and throws if they don't match. The anchor never has a project, folder, pin, archive date, message or CHAT share: every write path refuses it (below).

**`deleteConversationsKeepingArtifacts(tx, userId, ids)`** (`src/lib/artifact-home.ts`) does four things:

1. Resolves the targets with `tx.conversation.findMany({ where: visibleConversationWhere({ userId, id: { in: ids } }) })`.
2. If the detach flag is on and any target has artifacts, calls `ensureArtifactHome` and runs:

   ```sql
   UPDATE "Artifact" a
      SET "conversationId" = ${home},
          "projectId"      = COALESCE(a."projectId", c."projectId"),
          "identifier"     = a."identifier" || '~' || a."id"
     FROM "Conversation" c
    WHERE a."conversationId" = c."id" AND c."userId" = ${userId}
      AND c."kind" <> 'anchor' AND c."id" IN (${Prisma.join(ids)})
   RETURNING a."id"
   ```

   - `updatedAt` is left as it was: moving an artifact must not reorder the Artifacts home.
   - `deletedAt` is untouched, so trashed artifacts stay trashed.
   - The `~<full id>` suffix makes identifiers unique inside the anchor by construction.
   - ARTIFACT shares carry `artifactId` and a null `conversationId` (`share.ts:125-134`), so they survive.
   - `messageId` clears itself through the existing SetNull when the messages go.
3. Detaches the files those bodies use. Only when rows moved, and only for conversations that have attachments:

   ```sql
   UPDATE "Attachment" f SET "conversationId" = NULL, "messageId" = NULL
    WHERE f."userId" = ${userId} AND f."conversationId" IN (${ids}) AND f."deletedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "ArtifactVersion" v
                   WHERE v."artifactId" IN (${movedIds})
                     AND strpos(v."content", '/api/files/' || f."storageKey") > 0)
   ```

4. Deletes: `tx.conversation.deleteMany({ where: visibleConversationWhere({ userId, id: { in: ids } }) })`. Messages, CHAT shares, memory, voice sessions, unreferenced attachments and proposals go with it, as the person asked. The function returns `{ deleted, keptArtifacts }`.

**Callers.**

| Route | Handling | Response |
|---|---|---|
| Single delete | `prisma.$transaction(tx => …, { timeout: 20_000 })` | `{ ok: true, keptArtifacts }` |
| Bulk delete | `deleteAllConversationsKeepingArtifacts(userId)` lists the visible ids and runs chunks of 50 conversations, each in its own transaction | `{ ok: true, deleted, keptArtifacts }` |
| Native mutation | Calls the helper with its Serializable `tx`; errors are unchanged, so a serialization failure surfaces as the existing retryable 5xx | unchanged |

`agents/store.ts:453` gets `// detach-safe: deletes a thread this call created a moment ago and never wrote to`.

**Refusals.** Anchor refusals answer 404, not the plan's 409, so there is no existence oracle. They come from `visibleConversationWhere` at:
- `conversations/[id]` GET, PATCH and DELETE;
- the native `conversation.rename`, `conversation.update`, `conversation.archive` and `conversation.delete` mutations;
- chat (`route.ts:488,703,1448,1450`), messages, fork and title;
- `createShare` CHAT (`share.ts:88`);
- stream, follow-ups, voice, research, generate, upload, `v1/attachments`.

**Visible surfaces.**

| Surface | Anchored artifact |
|---|---|
| `/chat/anchor_<uid>` | 404 (`getConversationThread` is guarded) |
| `/a/{id}` | Works (`load.ts:22-35` joins `conversation: { userId }`, and the anchor has the owner's userId). The "Open in chat" link (`artifact-read-view.tsx:133`) and the design workspace's "Chat" button (`design-workspace.tsx:185-190`) are hidden when `conversation.kind === "anchor"`. |
| Artifacts home | The row opens `/a/{id}`. "Open in conversation" is hidden (`page.tsx:283-285`); the subtitle reads "Not in a chat" instead of `in “…”` (`:924`). |
| Project Sources | The API scopes by effective project (below). `madeInConversations` (`artifact-links.ts:186-192`) keeps rows with `anchored: true`, because otherwise the client would drop them (`projects/[id]/page.tsx:347-351`). |
| Search | Links `/a/{id}` already (`engine.ts:437`). The SQL project column and filter become `CASE WHEN c."kind" = 'anchor' THEN a."projectId" ELSE c."projectId" END`. |

"Effective project" means `anchored ? artifact.projectId : conversation.projectId`. Artifact `projectId` is written only when an artifact moves into the anchor in this release; B1 at R5 fills it for every other row.

**Dialog copy.**

| Where | Copy |
|---|---|
| Sidebar delete and archived-chats delete (`app-sidebar.tsx:2329-2355, 2869-2887`); `ConfirmState.description` becomes `React.ReactNode` (`:156-161`) | "This permanently removes the conversation and its messages. {N} artifact(s) made here stay in Artifacts. This can't be undone." (the middle sentence only when N > 0 and `kept`) |
| Settings row (`data-privacy.tsx:101-110`) | "Every chat and its messages, at once. Artifacts, memories and projects stay." |
| Settings dialog (`:115-131`) | "Every conversation and its messages are deleted for good. Your {N} artifacts stay in Artifacts. Memories and projects stay. This can't be undone." |

N comes from `GET /api/conversations/kept-artifacts?id=` (no id means every visible conversation), which returns `{ count, kept }`; `kept` reflects the detach flag.

### B. Trash (slices S3, S2, S1, S5, S6)

**Routes.**

| Route | Behaviour |
|---|---|
| `DELETE /api/artifacts/[id]` | Owner check via `conversation: { userId }`. Trash on: set `deletedAt = now`, `deletedReason = "user"`, return `{ ok: true, trashed: true, purgeAt }`. Already trashed: same answer (native retries are idempotent). Trash off: `purgeArtifacts(tx, [id], { requireTrashed: false })`, return `{ ok: true, trashed: false }`. |
| `DELETE /api/artifacts/[id]?now=1` | Trashed rows only; otherwise 409 `{ error: "not_in_trash" }`. Returns `{ ok: true, deleted: true }`. |
| `POST /api/artifacts/[id]/restore` | Clears `deletedAt` and `deletedReason`. Returns `{ artifact: ClientArtifact }`; idempotent. |
| `GET /api/artifacts/[id]`, `POST`, `PATCH` | Filter `deletedAt: null`, so a trashed artifact is 404. A native open or save of a stale row reports "no longer available", exactly as after today's hard delete. |
| `GET /api/artifacts` | Live rows only. Each item adds `anchored: boolean`, and `conversationTitle` becomes `string \| null` (null when anchored). `?deleted=1` returns trashed rows ordered by `deletedAt` desc, each with `deletedAt` and `purgeAt`. `?projectId=` uses `artifactProjectWhere`. |
| `loadOwnedDesignArtifact` (`design/store.ts:33-39`) | Adds `deletedAt: null`, so the design GET, transactions and Ask Juno routes all 404 for a trashed design. |
| `/api/artifacts/[id]/poster` | Unchanged; the owner still sees posters in Recently deleted. |
| `/api/artifacts/[id]/export` | Unchanged. |

**Shares (`share.ts`).**
- `createShare` for an ARTIFACT requires `deletedAt: null`.
- `listShares` adds `OR: [{ artifactId: null }, { artifact: { deletedAt: null } }]`.
- `getSharedChatSnapshot`'s artifact list filters out trashed rows.
- New `sharedArtifactIsTrashed(share)`: the page renders `<ShareGone />` ("This page isn't shared any more", noindex); the poster route answers 410 with `no-store`. Run the gone check before the view-counting lookup.
- Restoring changes nothing on the Share row, so the same token works again.

**Purge.**
- `src/lib/artifact-trash.ts` exports `purgeArtifacts(tx, ids, { requireTrashed })`: first `tx.artifactVersion.deleteMany({ artifactId in ids })`, then `tx.artifact.deleteMany({ id in ids[, deletedAt not null] })`, in one transaction. Proposals and shares cascade.
- `purgeExpiredArtifacts({ now, days = 30, dryRun, batchSize = 50 })` uses `prismaUnguarded`.
- `scripts/purge-artifact-trash.ts` takes `--dry`, `--days` (at least 7) and `--daemon` (every 6 hours). It is dry unless `JUNO_ARTIFACTS_PURGE=1` and logs `[artifact-purge] eligible=… purged=…`.
- `npm run artifacts:purge`; PM2 app `juno-artifact-purge` copies the `juno-code-sweeper` block; one maintenance paragraph in `VM_SETUP_GUIDE.md`.

**Sync (S2).**
- The artifact loader (`sync-entities.ts:228-230`) adds `deletedAt: null`. Trash is an UPDATE, so it bumps the revision, and hydration returns a tombstone (`buildEntityEnvelopes`). Restore is another UPDATE, which delivers the row again.
- The `artifact_version` loader is **deliberately unchanged**: versions stay live on devices. Projecting them would leave a restored artifact without its versions on N0, because no version change is ever announced on restore.
- The conversation loader adds the anchor filter as defence in depth. With no revision behind it, the anchor is simply omitted, consistently.

**Web.**
- The chat thread still loads trashed artifacts (`queries.ts:117-121`), so cards can resolve them. Cards render "In Recently deleted — Restore"; the canvas panel, SessionOutputs and the open-artifact lookup filter them out (`chat-view.tsx:880,920,982,1937`).
- Artifacts home:
  - header toggle "Recently deleted" (`?deleted=1`);
  - rows read "Deleted {relative} · {n} days left" with Restore and "Delete now";
  - the Delete now confirmation reads "Delete “X” now? Every version and its public link are removed for good. This can't be undone.";
  - the main delete dialog reads "It moves to Recently deleted for 30 days, and its public link stops working until you restore it. The conversation it came from is untouched.";
  - the toast reads "Moved to Recently deleted" with Undo.
- `/a/{id}` for a trashed artifact always shows the read view, never the editor, with the bar "This artifact is in Recently deleted · Restore".

### C. The re-emit guard (slice S4 server, S5 and S6 UI)

**Decision** (`src/lib/artifact-proposals.ts`):

```ts
decideReemit({ type, currentOrigin, currentContent, nextContent, enabled })
  → { action: "append" } | { action: "suggest"; reason: "edited" | "structure" | "both"; summary }
```

- Rule 1: if `currentOrigin` is `"edit"` or `"restore"` → suggest. A design fold never folds into a generated version (`operations.ts:529-539`), so the current version's origin is an exact signal that a person edited after Juno's last write.
- Rule 2: if the type is DESIGN and `designStructureLoss(current, next)` is non-null → suggest.
  - It compares the counts of `components`, `variables`, `animations`, `interactions`, `comments` and the sum of node `effects` (`types.ts:768-789`).
  - Any category that drops from above zero counts as loss.
  - An unparseable current document counts as no loss.
- Rule 3: a null origin (legacy row) appends.
- Summaries read "You edited this after Juno's last version" or "Would remove 3 animations and 1 component", or both joined with " · ".

**Persist** (`artifacts-store.ts`):
- New `planHeldReemits(conversationId, artifacts): Promise<Map<identifier, proposalId>>`. It is read-only, uses `crypto.randomUUID()` ids, and decides on the stored form (`normalizeForStorage`).
- `persistArtifacts(conversationId, messageId, parsed, { heldIds? })` re-decides inside the write:
  - **Suggest:** in one transaction, mark earlier PENDING proposals for that artifact STALE and create the proposal (planned id, `baseVersion = currentVersion`, payload `{ content: storedForm, title, language }`, `summary`, `messageId`, `taint`). **Never** touch the Artifact row, so there is no sync churn. Return `serializeArtifact(existing + ARTIFACT_CLIENT_INCLUDE)`.
  - **Trashed row with the same identifier:** retire its identifier with `retiredIdentifier` and create a new artifact (the type-change branch).
  - **Race:** if the plan said append but a person saved in between, the write still holds it as a suggestion. The message then keeps its full body; this is logged as `held_unplanned`.
- `persistTargetedArtifactEdit` adds `deletedAt: null` to its compare-and-swap and is otherwise not guarded: it already has an explicit base.

**Chat route** (`chat/route.ts`):
- Success path (`:3094-3160`): after `prepareChatArtifactOutput` and before `persistAssistantTurn`, call `planHeldReemits`. Then `acc.replaceText(holdArtifactBodies(acc.text, held))`, which turns each held tag into `<juno:artifact identifier=… type=… title=… suggestion="<id>"></juno:artifact>` (the plan's §3.7 E legacy form). Then pass `{ heldIds: held }` to `persistArtifacts`.
- Do the same at the stop or cut-off path (`:3317-3341`). The research audit (`:3641`) passes no plan.
- Regenerate supersede (`:2600-2607`): add `prisma.artifactProposal.updateMany({ where: { messageId: stale.id, status: "PENDING" }, data: { status: "STALE", resolvedAt } })` and fix the `[, , updated]` destructuring.
- Model history (`:1871`): wrap with `describeHeldArtifactsForModel`, which replaces each held tag with `[Suggested revision of "<title>" (<identifier>) is waiting for the person's review; not applied.]`.
- Taint: `untrustedContentInTurn ? "untrusted-input" : null`.
- Keep exactly three `encryptJsonField(` calls: `tests/field-encryption-coverage.test.ts` counts them.

**Routes** under `src/app/api/artifacts/[id]/proposals/[proposalId]/`, all owner-checked and all 404 when the artifact is trashed:

| Route | Returns |
|---|---|
| `GET` | `{ proposal: { id, baseVersion, summary, status, createdAt, type, title, content: string \| null }, current: { version, content: string \| null } }`. Content is null for DESIGN. |
| `POST apply` with `{ baseVersion }` | In one transaction: `updateMany({ id, currentVersion: baseVersion, deletedAt: null }, { currentVersion: base + 1 })`, count 1 or 409 `{ error: "stale", artifact }`; create the version with `origin: "generated"` (**no new origin value**: native decodes origin as a closed enum, `NativeArtifactAPIClient.swift:449-455`); mark the proposal APPLIED and other PENDING ones STALE. The title does not change. A proposal that is no longer PENDING answers 409 `{ error: "resolved", artifact }`. Success returns `{ artifact }`. |
| `POST dismiss` | DISCARDED, `resolvedAt`. Returns `{ artifact }`. |
| `GET poster` | DESIGN only: `designPosterSvg(payload.content)` with `POSTER_CACHE_REVALIDATE`. |

**UI.** "Juno's suggestion is waiting · Compare · Apply · Dismiss" appears:
- on the card of the message whose id is `pendingSuggestion.messageId` (the card shows the current version);
- at the top of the canvas panel;
- on `/a/{id}`, in both the read view and the design workspace.

Toasts: "Applied as v{n}"; on stale, "This changed since the suggestion was made. Compare again before applying."; "Suggestion dismissed". The UI word is "Dismiss" (your scope); the stored status is `DISCARDED` (§3.1's enum, so M4 needs no rename). A pending suggestion does not block person saves; Apply's stale check covers them.

### D. Two small items

**D1, the tab title.**
- `src/lib/document-subject.ts` exports `claimDocumentSubject(pathname, title): () => void` (it returns a release function that clears the subject only if it is still the caller's), `subscribeDocumentSubject(fn)` and `getDocumentSubject(): { path, title } | null`.
- `src/components/app/document-subject.tsx` is `<DocumentSubject title />`, which calls `usePathname()` and claims in an effect.
- `route-title.ts` gains `documentTitleFor({ pathname, conversationTitle, subject })`.
- `DocumentTitle` uses `useSyncExternalStore` and passes the subject only when `subject.path === pathname`.
- Mounted in `artifact-read-view.tsx` (the title) and `design-workspace.tsx` (the live `name`, so renames follow). Result: "Pricing page · Juno".

**D2, placeholder notes.**
- `chat-artifact-verification.ts`: the DESIGN branch (`:101-127`, and `repairArtifact` `:142`) uses `normalizeDesignArtifactWithNotes`.
- The report gains `notes: ChatArtifactNote[]` with `{ identifier, code: "image_placeholder", detail }`. It is optional in the type, so reports persisted before this release still decode, and it never changes `status`.
- `artifactVerificationDetail` (`:249-269`) appends " {n} picture(s) became a placeholder."
- The card reads the count from `message.activity[].artifactVerification.notes` for its identifier and shows "1 picture became a placeholder" or "3 pictures became placeholders".
- Notes quote layer names, which the owner wrote, so they go only into the encrypted activity log and never into server logs.

## 4. Shared contracts (the names builders code against)

| Owner | Contract |
|---|---|
| S1 `src/lib/conversation-visibility.ts` | `ANCHOR_KIND = "anchor"`, `ANCHOR_TITLE = "Your artifacts"`, `anchorConversationId(userId)` → `anchor_${userId}`, `visibleConversationWhere<W extends Prisma.ConversationWhereInput>(where?: W): W & { AND: Prisma.ConversationWhereInput[] }` (appends `{ kind: { not: "anchor" } }` to AND, keeping top-level keys so `update({ where })` still type-checks), `visibleConversationSql(alias?: string): Prisma.Sql` (alias checked against `/^[a-z]\w*$/`) |
| S1 `src/lib/artifact-scope.ts` | `artifactProjectWhere(projectId): Prisma.ArtifactWhereInput` = `{ OR: [{ conversation: { projectId, kind: { not: "anchor" } } }, { projectId, conversation: { kind: "anchor" } }] }`; `artifactProjectSql(a = "a", c = "c")`; `effectiveArtifactProjectId(artifact, conversation)` |
| S1 `src/lib/artifact-flags.ts` | `detachOnDeleteEnabled()`, `reemitGuardEnabled()`, `artifactTrashEnabled()`, `artifactPurgeArmed()` |
| S1 `src/lib/serializers.ts` | `ARTIFACT_CLIENT_INCLUDE = { versions: true, proposals: { where: { status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 1, select: { id, baseVersion, messageId, summary, createdAt } } }`; `serializeArtifact(art & { proposals? })` adds `deletedAt` and `pendingSuggestion` **only when set**, so live payloads and existing test fixtures stay byte-identical |
| S1 `src/types/chat.ts` | `ClientArtifactSuggestion { id; baseVersion; messageId: string \| null; summary; createdAt }`; `ClientArtifact.deletedAt?: string \| null`, `ClientArtifact.pendingSuggestion?: ClientArtifactSuggestion \| null`; `artifactVerification.notes?: { identifier; code: "image_placeholder"; detail }[]` |
| S2 `src/lib/artifact-home.ts` | `ensureArtifactHome`, `anchoredIdentifier(identifier, id)` → `${identifier}~${id}`, `deleteConversationsKeepingArtifacts(tx, userId, ids)`, `deleteAllConversationsKeepingArtifacts(userId)`, `countKeptArtifacts(userId, conversationId?)`; route `GET /api/conversations/kept-artifacts[?id=]` → `{ count, kept }` |
| S3 `src/lib/artifact-trash.ts` | `TRASH_RETENTION_DAYS = 30`, `purgeAtFor(d)`, `trashArtifact`, `restoreArtifact`, `purgeArtifacts`, `purgeExpiredArtifacts`; `share.ts`: `sharedArtifactIsTrashed(share)`; the routes and JSON in §3B |
| S4 | `decideReemit`, `designStructureLoss`, `planHeldReemits`, `persistArtifacts(…, { heldIds })`, `holdArtifactBodies`, `describeHeldArtifactsForModel`; tag attribute `suggestion`; the proposal routes in §3C |
| S5 `src/components/artifacts/suggestion-bar.tsx` | `SuggestionBar({ artifactId, type, currentVersion, suggestion, variant: "card" \| "bar", onResolved(artifact: ClientArtifact) })`; `SuggestionCompareDialog({ artifactId, type, suggestionId, currentVersion, open, onOpenChange, onResolved })`. **S5 lands these two files first; S6 imports them.** |
| S6 | `DocumentSubject`, `claimDocumentSubject`, `documentTitleFor`, `resolveArtifactView({ …, trashed? })`, `madeInConversations` keeping `anchored` |

## 5. Slices (disjoint file ownership; S1a merges first)

**S1: contracts and visibility sweep.**
- **S1a**, merges first: `prisma/schema.prisma`; the migration; `src/lib/conversation-visibility.ts` (new); `src/lib/artifact-scope.ts` (new); `src/lib/artifact-flags.ts` (new); `src/lib/serializers.ts`; `src/types/chat.ts`; `docs/OPEN_DECISIONS.md` (the anchor exception, D13).
- **S1b**, the sweep, merges after S2, S3 and S4 because its guard test covers their files: `src/app/api/{research/route.ts:45, design/[artifactId]/edit/route.ts:136, memory/route.ts:82, memory/recap/route.ts:36, chat/stream/active/route.ts:26, chat/stream/[generationId]/route.ts:55, chat/follow-ups/route.ts:91, code/tasks/route.ts:302,353, code/tasks/[id]/steer/route.ts:183, voice/transcript/route.ts:78,117,223, conversations/[id]/fork/route.ts:33, conversations/[id]/messages/route.ts:62,130, conversations/[id]/title/route.ts:49,111,116, recents/route.ts:55, generate/route.ts:75,291, account/export/route.ts:79, import/route.ts:536 (+:652 coerce kind to chat or code), upload/route.ts:55, v1/attachments/route.ts:117}`; `src/lib/{code-autofix-dispatch.ts:453,458, code-task-outcome.ts:86,254, memory-dreamer.ts:51 (raw SQL, else the anchor keeps its account eligible forever),112, memory.ts:1016,1348, work/dispatch.ts:413, work/code-dispatch.ts:179,206, queries.ts:39,95 (+:117-121 ARTIFACT_CLIENT_INCLUDE), history-import.ts:471, search/sql.ts:200-215,330-356 (+ a."deletedAt" IS NULL + project CASE),470-481,490-512}`; `.github/workflows/deploy.yml` (new database steps).
- **Tests.**
  - `tests/conversation-visibility.test.ts`:
    - unit: the AND-merge keeps `kind: "code"`; a bad alias throws;
    - source guard: walk `src/**/*.ts(x)` except `.test.`; for every `\b(prisma|prismaUnguarded|tx|db)\s*\.\s*conversation\s*\.\s*(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|groupBy|aggregate|update|updateMany|upsert|delete|deleteMany)\s*\(`, take the balanced argument text and require `visibleConversationWhere(` or an `anchor-safe:` comment within 3 lines above;
    - every `(FROM|JOIN)\s+"Conversation"` inside a template literal needs `visibleConversationSql(` or `anchor-safe:`.
  - `tests/artifact-r1-schema.test.ts` (source): the migration contains no `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN`, CHECK or `WHERE`-index; both triggers carry their WHEN clauses; the schema declares the new fields.

**S2: anchor, delete paths, sync.**
- Files: `src/lib/artifact-home.ts` (new); `src/app/api/conversations/route.ts`; `src/app/api/conversations/[id]/route.ts` (GET, PATCH and DELETE guarded); `src/app/api/conversations/kept-artifacts/route.ts` (new); `src/app/api/v1/mutations/route.ts` (`:104,114,123,128,130,136`); `src/lib/agents/store.ts` (`:424,453,613`); `src/lib/sync-entities.ts`.
- Tests:
  - `tests/conversation-delete-keeps-artifacts.test.ts`:
    - source: every `conversation.(delete|deleteMany)(` in `src` is in `artifact-home.ts` or carries `// detach-safe:`; all three routes call the helper.
    - database: a chat in a project holds an artifact (v1 generated, v2 edit) with an ARTIFACT share and a CHAT share, one attachment the artifact references and one it doesn't. After the single, bulk and native paths:
      - the chat is gone and the artifact sits in `anchor_<uid>` with identifier `x~<id>`, `projectId` from the chat and both versions;
      - the artifact's share token still resolves through `getPublicShare`; the CHAT share is gone;
      - the referenced attachment survives with a null `conversationId`; the other one is gone;
      - no AccountChange or EntityRevision row exists with `entityId = anchor_<uid>`;
      - a second "delete all" leaves the anchor and its artifacts alone;
      - GET, PATCH and DELETE on `anchor_<uid>` return 404;
      - `ensureArtifactHome` run twice leaves one row.
    - The native path needs a NativeDeviceSession row and a mocked `@/lib/native-request`.
  - `tests/sync-anchor-trash-projection.test.ts` (database): `loadEntities("conversation", [anchor])` returns `[]`; a trashed artifact hydrates as a tombstone at the current revision while its versions stay live; restore hydrates it live; `listEntityIndex` never lists the anchor.

**S3: trash server, share, purge.**
- Files: `src/lib/artifact-trash.ts` (new); `src/app/api/artifacts/route.ts`; `src/app/api/artifacts/[id]/route.ts`; `src/app/api/artifacts/[id]/restore/route.ts` (new); `src/lib/design/store.ts` (the loader only); `src/lib/share.ts` (plus the CHAT guard at `:88`); `src/app/share/[token]/page.tsx`; `src/app/share/[token]/poster/route.ts`; `src/components/share/share-gone.tsx` (new); `scripts/purge-artifact-trash.ts` (new); `package.json` (one script line); `deploy/ecosystem.config.js`; `deploy/VM_SETUP_GUIDE.md`.
- Tests:
  - `tests/artifact-trash.test.ts`:
    - source: `artifact.(delete|deleteMany)(` and `artifactVersion.(delete|deleteMany)(` appear only in `artifact-trash.ts`.
    - stubbed routes: the list hides trashed rows; `?deleted=1` lists them with `purgeAt`.
    - database: trash, then GET/POST/PATCH are 404, the poster is 410, the page is gone; restore brings back the same token; Delete now on a live row is 409; on a trashed row it hard-deletes, versions first, with AccountChange tombstones for every version under the owner's account; `purgeExpiredArtifacts` touches only rows past the cutoff and a dry run writes nothing; `createShare` on a trashed row is null; `listShares` hides its link.
  - Update the stubs in `tests/artifacts-list-route.test.ts` (conversation `kind`).

**S4: re-emit guard, chat pipeline, placeholder notes.**
- Files: `src/lib/artifacts-store.ts`; `src/lib/artifact-proposals.ts` (new); `src/lib/message-content.ts`; `src/lib/chat-artifact-verification.ts`; `src/app/api/chat/route.ts` (also the guard at `:488,703,1448,1450,1726,3193,3342`, `// anchor-safe` on the locked raw SQL at `:1536`, and `deletedAt: null` on the `artifactEdit` lookup at `:1464`); the proposal routes `[proposalId]/route.ts`, `apply/route.ts`, `dismiss/route.ts`, `poster/route.ts` (new).
- Tests:
  - `tests/artifact-reemit-guard.test.ts`:
    - pure: every `decideReemit` rule; `designStructureLoss` counts; `holdArtifactBodies` leaves other tags alone; `parseArtifacts` skips a held tag; `splitMessageContent` still yields a card part; `describeHeldArtifactsForModel`.
    - database: a re-emit over an edit appends no version, `currentVersion` stays, one PENDING proposal carries the message id, and the saved message holds an empty-body tag; Apply at the current base appends a generated version; Apply at an older base is 409; Dismiss; a newer suggestion makes the older STALE; re-emitting a trashed identifier creates a new row.
    - **The plan's §8.10 exit checks with a suggestion waiting:** a native-style `POST /api/artifacts/[id]` at `baseVersion = currentVersion` succeeds; a design transaction succeeds; `/share` shows the current version, not the suggestion; `currentVersion = max(version)` after persist, Apply, POST and a transaction.
  - Extend `tests/chat-artifact-verification.test.ts` (an image node yields one note, status verified, the detail sentence).
  - Update the Prisma stub in `tests/artifact-type-immutability.test.ts` (`artifactVersion.findUnique`, `artifactProposal`).

**S5: chat UI.**
- Files: `src/components/artifacts/suggestion-bar.tsx` (new, lands first); `src/components/artifacts/suggestion-compare-dialog.tsx` (new; `diffLines` from `src/lib/line-diff.ts`, or two posters for DESIGN); `src/lib/artifact-card-state.ts` (new: `cardSuggestion(artifact, messageId)`, `placeholderCount(activity, identifier)`, `liveArtifacts(list)`); `src/components/chat/artifact-inline-card.tsx` (props `suggestion`, `trashed`, `placeholderCount`, `onArtifactChanged`); `src/components/chat/message-item.tsx`; `src/components/chat/message-list.tsx`; `src/components/chat/chat-view.tsx`; `src/components/canvas/canvas-panel.tsx`; `src/lib/chat-client-state.ts` (`replaceArtifactById`).
- Tests: `tests/artifact-card-state.test.ts` (new) and an extension of `tests/chat-client-state.test.ts`. Pure only: the repo has no jsdom (00 §9).

**S6: pages, dialogs, tab title.**
- Files: `src/app/(app)/a/[id]/{load.ts, page.tsx, artifact-read-view.tsx}`; `src/components/design/design-workspace.tsx` (hide Chat when anchored; bar; subject; delete toast with Undo); `src/lib/artifact-links.ts`; `src/app/(app)/artifacts/page.tsx`; `src/lib/artifacts-home.ts`; `src/app/(app)/projects/[id]/page.tsx`; `src/components/app/app-sidebar.tsx`; `src/components/app/kept-artifacts-note.tsx` (new); `src/components/settings/sections/data-privacy.tsx`; `src/components/app/document-title.tsx`; `src/lib/route-title.ts`; `src/lib/document-subject.ts` (new); `src/components/app/document-subject.tsx` (new).
- Tests: `tests/document-title.test.ts` (new: `documentTitleFor` and store claim, release and stale-release); extend `tests/artifact-routes.test.ts` (trashed means the read view with the bar; anchored means no chat link; stubs for `deletedAt`, `conversation.kind`, `proposals`); extend `tests/artifacts-home.test.ts` (row metadata, `madeInConversations` keeping anchored rows, the kept-count copy).

**Integration rules.**
- Branch per slice off `artifacts/r1-lifecycle`. Merge order: S1a → S2 → S3 → S4 → S1b → S5 → S6. Nothing deploys until the whole branch merges; the releaser cuts once.
- If another migration lands on main first, rename this one's timestamp so it is still the newest.
- No slice commits `src/lib/i18n-catalog.generated.ts`. It is regenerated once at integration; `deploy.yml` also runs `i18n:extract` itself.
- Tests that use `mock.module` skip when module mocks are unavailable (the edbb8456 pattern).
- S1b adds explicitly named CI steps, each with its own database: `artifactlife` (the existing `tests/artifact-lifecycle.test.ts`, never run in CI until now), `artifactdelete`, `artifacttrash`, `artifactguard`. Each sets `ARTIFACT_TEST_DATABASE_URL` and runs `npx tsx --test --experimental-test-module-mocks …` with `NODE_OPTIONS=--conditions=react-server`.

## 6. Installed native builds

N0 means Mac 1.6.0 and every current iPhone build. They use main's JunoNativeKit, and 04 §3.7 lists what they break on.

| Build | What they see | Verdict |
|---|---|---|
| **Mac 1.6.0** | The anchor never arrives: no revision exists for it, so there is no `missingEntity` (`NativeSyncAPIClient.swift:276-278`) and no search row. Anchored artifacts decode because `conversationId` is non-empty (`NativeArtifactStore.swift:142`), and the label falls back to "Conversation" (`:116-118`). The Artifacts screen has no conversation navigation (`DesktopArtifactsScreen.swift:860-861` only prints the title). Trash arrives as a hydration tombstone, which `NativeSyncAPIClient.swift:264-272` accepts and `NativeArtifactStore.swift:95` skips; restore re-delivers the row and its versions are still local. A Mac delete now soft-deletes, so the Mac's "can't be undone" wording becomes wrong; fixed in N1. Suggestions: never synced; the saved tag has an empty body, so there is no transcript card and no dock body (`NativeMessageContentTests.swift:124-131`); REST's extra keys are ignored and no new `origin` value is written. | **Safe.** Does not blank the library, does not crash. X-09 is still open and neither triggered nor worsened. |
| **iPhone (all current builds)** | Same decoders and sync. The artifact sheet's conversation chip calls `openConversation(artifact.conversationID)` (`JunoMobileWorkspaceViews.swift:1848-1854` → `JunoMobileRootView.swift:1326-1330`), which selects an unknown id and shows an empty transcript. Sending there answers 404 "Conversation not found." (guarded chat route); nothing is written to the anchor. The inline viewer is built from the tag body, which is empty, so it draws no card. | **Safe.** One dead end, the plan's accepted N0 behaviour, removed in N1 (`bootstrap.anchorId`, hide the chip). |
| Electron (not distributed) | Lists through the guarded `/api/conversations`; same sync. | Safe. |
| Glass branch (not shipped) | `ChatArtifactResolver` must treat an empty-body `suggestion=` tag as "no card", or as the current row. | For the N1 cherry-pick owner. |

No sync entity type, artifact kind, conversation kind on the wire, or mutation shape changes, so `contracts/openapi/juno-native-v1.yaml` stays as it is.

## 7. Rollback

1. **First resort: flags.** Set the env var to `0` and run `pm2 restart juno-backend --update-env`.
   - Detach off: deletes cascade as today.
   - Guard off: re-emits append.
   - Trash off: deletes are hard deletes through `purgeArtifacts`.
   - Purge stays dry unless armed.
   - Reads keep hiding anchors and trashed rows, so no half-state leaks.
2. **Code revert.** Revert S5, S6, S4 and S3 in any combination. **Never revert S1b or S2's refusals alone.** Pre-release code lists the anchor as a chat named "Your artifacts", and deleting that chat would cascade every anchored artifact. Under a code revert, trashed rows reappear as live on web and native, which loses nothing. Proposals are ignored; held tags still render the current version's card on the web.
3. **Schema.** Leave the columns and the table; they are harmless. The trigger can be restored if ever needed:
   ```sql
   DROP TRIGGER IF EXISTS juno_change_conversation_delete ON "Conversation";
   DROP TRIGGER IF EXISTS juno_change_conversation ON "Conversation";
   CREATE TRIGGER juno_change_conversation AFTER INSERT OR UPDATE OR DELETE ON "Conversation"
     FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('conversation','direct');
   ```
   This is safe because nothing ever updates an anchor after it is created. It is still not recommended.

## 8. Deferred, and deviations from the plan

| Item | Why |
|---|---|
| Deletion ledger (§3.4) | Needs `set_config` proven under the production pooler, and `Artifact.userId`, for attribution. This release's only hard deletes live in one module behind a source test, and conversation deletes no longer destroy artifacts. **Hard gate:** the purge stays unarmed until the ledger lands. R5 (2026-11-05) falls before the first row becomes eligible (R1 plus 30 days). This departs from §13.5 ("purge not before the ledger") only by shipping the job unarmed. |
| `Artifact.userId`, `ArtifactVersion.userId` | No reader in this release; the owner can be derived through the anchor or the chat, both the same account. B1 fills them at R5. |
| `ArtifactVersion.messageId` and `taint` | **R2 must add them before X-01a** (§13.5). The proposal carries `taint` now. |
| ArtifactFileRef and B12 | Replaced for the delete path by a scan at delete time. Designs inline images as data URLs (`use-design-document.ts:617-642`), so only model HTML or Markdown that quotes `/api/files/` depends on it. The Library delete and edit-truncation paths are unchanged, not worsened. |
| Partial unique index | The fixed id makes it unnecessary, and CI's drift check would reject it. |
| 409 on anchor refusals | 404 through the same helper; no existence oracle. |
| `~<last 6 chars>` suffix | The full id guarantees uniqueness inside the anchor. |
| FeatureFlag table | Env flags; no flag plumbing exists yet. |
| HolderChatLog, B3, `/api/design` creating into the anchor | R2 as planned. Bonus now: deleting a holder chat keeps its design. |
| "Also move them to Recently deleted" | R6 (Phase 1 UI). |
| Moving an artifact out on the first Ask; `titleSource` | R-027 and M0 later. Apply keeps the current title. |
| Rewriting the message tag after Apply | N0 transcripts show no card for that turn; the library shows the version. Mutating history isn't worth the risk. |
| True 410 status on the HTML share page | App Router can't set it; the gone view renders at 200 with noindex, and the poster answers 410. |
| Structure guard on targeted edits and Ask Juno | Both already carry an explicit base; Phase 3. |
| Native trash UI, the Mac's delete copy, `anchorId`, search filter | N1. |
| Shares of trashed artifacts in the native shared-links list | No change event exists to project; the link opens the gone page. |

## 9. Exit checklist

- CI green, including the drift check, the four new database steps, the guard test, `field-encryption-coverage` and `artifact-lifecycle`.
- A manual pass on Mac 1.6.0 and a current iPhone build:
  - delete a chat with artifacts from the web and from each app;
  - trash and restore from the web;
  - hold a suggestion on a hand-edited artifact;
  - check that the app library never blanks and that native search never shows "Your artifacts".
- The purge daemon's dry-run log shows 0 eligible rows.
- `/a/{id}` tab titles are correct for both the read view and the design workspace.

### Critical files for implementation
- /Users/liammagnier/Developer/project/juno/src/lib/artifacts-store.ts
- /Users/liammagnier/Developer/project/juno/src/app/api/chat/route.ts
- /Users/liammagnier/Developer/project/juno/src/lib/sync-entities.ts
- /Users/liammagnier/Developer/project/juno/src/app/api/v1/mutations/route.ts
- /Users/liammagnier/Developer/project/juno/prisma/schema.prisma

## Addendum (lead, 2026-09-24)
- S4 also adds `tx?: Prisma.TransactionClient` to `persistArtifacts`'s options: `persistArtifacts(conversationId, messageId, parsed, opts?: { heldIds?: Map<string,string>; tx?: Prisma.TransactionClient })`. When `opts.tx` is given, every write goes through it and no inner `$transaction` is opened (use the tx directly for the multi-write steps). The chat-rework session (web/rework-ws7) will call it for research reports; do not change the positional signature.
- The worktree has its own node_modules (not the main checkout's); `npx prisma generate` is safe there.
