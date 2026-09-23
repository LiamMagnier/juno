import type { Prisma } from "@prisma/client";

/*
 * REMOVING A FILE FROM THE LIBRARY IS NOT DELETING IT FROM A CHAT.
 *
 * The Library is a view over every `Attachment` row the person owns, and that
 * includes the files they sent in chats and the files in their projects. A
 * Library delete used to tombstone the row itself (`deletedAt`), and every
 * chat path reads attachments with `deletedAt: null`, so deleting a file from
 * the Library took it out of the chat it was sent in, and out of the model's
 * reach there too.
 *
 * Now the Library asks first whether anything else still uses the row. A file
 * sent in a chat or kept in a project is only taken out of the Library
 * (`libraryRemovedAt`): the row, its bytes and its knowledge index stay live
 * for that chat or project. A file nothing else uses is deleted as before, a
 * recoverable tombstone with its knowledge index redacted. Both land in
 * Recently deleted, and Restore puts either back.
 *
 * Pure on purpose: the route that acts on this is server-only and the
 * Library's hook is a client module, so a test can only reach the decisions if
 * they live on their own. The database half is src/lib/library-removal.ts.
 */

/** Where a file is still used outside the Library. */
export type LibraryUse = "chat" | "project";

/** The columns that say whether anything else uses a row, and no others. */
export interface LibraryUseRow {
  messageId: string | null;
  projectId: string | null;
}

/**
 * Whether a row is in use outside the Library: sent with a message (its chat
 * shows it and the model reads it there) or one of a project's files.
 *
 * `messageId`, not `conversationId`: the send path sets both together, and a
 * row whose message was deleted keeps its `conversationId` (the relation is
 * `SetNull` on the message only) while no chat shows it any more. A file sent
 * in a project's chat is reported as the chat, the place it is seen.
 */
export function libraryUse(row: LibraryUseRow): LibraryUse | null {
  if (row.messageId != null) return "chat";
  if (row.projectId != null) return "project";
  return null;
}

/** What removing one file from the Library does to it. */
export type LibraryRemoval =
  /** Only the Library lets go; the chat or project keeps the file. */
  | { mode: "hidden"; keptIn: LibraryUse }
  /** Nothing else uses it: tombstoned, as a Library delete always was. */
  | { mode: "deleted"; keptIn: null };

export function planLibraryRemoval(row: LibraryUseRow): LibraryRemoval {
  const keptIn = libraryUse(row);
  return keptIn ? { mode: "hidden", keptIn } : { mode: "deleted", keptIn: null };
}

/**
 * What `removeFromLibraryWith` needs from the database, all inside one
 * transaction. Shaped as the three things the decision does rather than as
 * Prisma calls, so a test can hand it a fake and read back which one ran.
 */
export interface LibraryRemovalStore {
  /**
   * The reader's row if it is still in their Library (neither deleted nor
   * removed), locked until the transaction ends: a send that claims the file
   * for a message in the meantime waits, and then finds it gone or finds it
   * kept, never half of each.
   */
  lockLibraryRow(userId: string, id: string): Promise<(LibraryUseRow & { id: string }) | null>;
  /** Take the row out of the Library, and nothing else. */
  hide(userId: string, id: string, at: Date): Promise<void>;
  /** The Library delete: tombstone the row and redact its knowledge index. */
  tombstone(userId: string, id: string): Promise<void>;
}

/**
 * Remove one file from the reader's Library. Null when there is no such file
 * in it: not theirs, already deleted, or already removed.
 */
export async function removeFromLibraryWith(
  store: LibraryRemovalStore,
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<LibraryRemoval | null> {
  const row = await store.lockLibraryRow(userId, id);
  if (!row) return null;
  const removal = planLibraryRemoval(row);
  if (removal.mode === "hidden") await store.hide(userId, row.id, now);
  else await store.tombstone(userId, row.id);
  return removal;
}

/**
 * A FILE THE LIBRARY LET GO OF IS DELETED WHEN ITS CHAT LETS GO TOO.
 *
 * A hidden row stays live only because a message or a project still uses it.
 * Deleting the message it was sent with ends that use: an edit truncates every
 * later message, and `Attachment.message` is `SetNull`, so the row keeps its
 * `conversationId` and loses its `messageId`. Left alone it would be hidden
 * with nothing using it: in no chat, yet with a live link and a live index
 * the model's file tools in that conversation and search still read, sitting
 * in Recently deleted, which offers only Restore, forever. The reader asked
 * for it to be deleted and was told only the chat kept it, so once the chat
 * does not, the delete is carried out: the rows this picks are tombstoned in
 * the same transaction that deletes the messages, and stay recoverable from
 * Recently deleted like any other Library delete.
 *
 * A row a project still holds stays hidden: the project is still using it.
 */
export interface SentAttachmentRow {
  id: string;
  projectId: string | null;
  libraryRemovedAt: Date | null;
}

export function orphanedByMessageDelete(row: SentAttachmentRow): boolean {
  return row.libraryRemovedAt != null && libraryUse({ messageId: null, projectId: row.projectId }) === null;
}

/** What `settleLibraryRemovalsWith` needs from the database, inside the transaction that deletes the messages. */
export interface MessageDeleteStore {
  /**
   * The live attachments sent with the messages about to be deleted, every
   * one of them, locked until the transaction ends. Every one and not only the
   * hidden ones: a Library removal that commits while this waits must be seen,
   * and a row filtered on the column it is about to change would be skipped
   * instead of waited for.
   */
  lockSentAttachments(): Promise<SentAttachmentRow[]>;
  /** The Library delete: tombstone the row and redact its knowledge index. */
  tombstone(id: string): Promise<void>;
}

/** Finish the Library delete of every hidden file the message delete leaves unused. Returns their ids. */
export async function settleLibraryRemovalsWith(store: MessageDeleteStore): Promise<string[]> {
  const orphaned = (await store.lockSentAttachments()).filter(orphanedByMessageDelete);
  for (const row of orphaned) await store.tombstone(row.id);
  return orphaned.map((row) => row.id);
}

/**
 * Which rows each of the page's two lists holds. The Library is what is
 * neither deleted nor removed; Recently deleted is either one. The route's
 * rows, its counts and its total all start from this, and so do the routes
 * that act on one list or the other, so none of them can disagree about where
 * a file is.
 */
export function libraryViewWhere(view: "library" | "deleted"): Prisma.AttachmentWhereInput {
  return view === "deleted"
    ? { OR: [{ deletedAt: { not: null } }, { libraryRemovedAt: { not: null } }] }
    : { deletedAt: null, libraryRemovedAt: null };
}

/** The columns `libraryItemPlacement` reads. */
export interface LibraryPlacementRow extends LibraryUseRow {
  deletedAt: Date | null;
  libraryRemovedAt: Date | null;
}

/**
 * Where a row stands, as `/api/library` reports it.
 *
 * `deletedAt` is ONE date for "in Recently deleted", whichever way the file
 * got there, so the page (and anything else reading the field) files a
 * removed row where it is shown without learning a second column. `withheld`
 * is true only for a tombstone: a removed file's bytes are live in its chat,
 * so its link stays. `inUse` is said for every live row, so the page knows
 * before a delete lands whether a chat or project will keep the file; `keptIn`
 * is the same fact for a removed row, the note Recently deleted shows.
 */
export function libraryItemPlacement(row: LibraryPlacementRow) {
  const inUse = row.deletedAt ? null : libraryUse(row);
  return {
    deletedAt: (row.deletedAt ?? row.libraryRemovedAt)?.toISOString() ?? null,
    withheld: row.deletedAt != null,
    inUse,
    keptIn: row.libraryRemovedAt ? inUse : null,
  };
}
