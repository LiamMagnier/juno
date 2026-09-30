import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  libraryItemPlacement,
  libraryUse,
  libraryViewWhere,
  orphanedByMessageDelete,
  planLibraryRemoval,
  removeFromLibraryWith,
  settleLibraryRemovalsWith,
  type LibraryRemovalStore,
  type SentAttachmentRow,
} from "@/lib/library-removal-policy";
import { removalNotice } from "@/components/library/library-types";

/*
 * DELETING A FILE FROM THE LIBRARY MUST NOT DELETE IT FROM A CHAT.
 *
 * The Library lists every attachment the person owns, the files they sent in
 * chats included, and its delete used to tombstone the row: every chat path
 * reads attachments with `deletedAt: null`, so the file vanished from the chat
 * it was sent in and the model could no longer read it there. These pin the
 * split: a file a chat or project uses is only taken out of the Library, a
 * file nothing uses is deleted as before, each view holds exactly the rows it
 * should, and the page says which happened.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const at = new Date("2026-09-23T12:00:00.000Z");
const earlier = new Date("2026-09-20T09:30:00.000Z");

test("a file sent in a chat or kept in a project is in use; a loose upload is not", () => {
  assert.equal(libraryUse({ messageId: "m1", projectId: null }), "chat");
  assert.equal(libraryUse({ messageId: null, projectId: "p1" }), "project");
  // Seen in the chat, so that is where it is said to be.
  assert.equal(libraryUse({ messageId: "m1", projectId: "p1" }), "chat");
  assert.equal(libraryUse({ messageId: null, projectId: null }), null);
});

test("removal hides what is in use and deletes what is not", () => {
  assert.deepEqual(planLibraryRemoval({ messageId: "m1", projectId: null }), { mode: "hidden", keptIn: "chat" });
  assert.deepEqual(planLibraryRemoval({ messageId: null, projectId: "p1" }), { mode: "hidden", keptIn: "project" });
  assert.deepEqual(planLibraryRemoval({ messageId: null, projectId: null }), { mode: "deleted", keptIn: null });
});

type FakeRow = {
  id: string;
  userId: string;
  messageId: string | null;
  projectId: string | null;
  deletedAt?: Date | null;
  libraryRemovedAt?: Date | null;
};

/** A store over an array, recording which of its three operations ran. */
function fakeStore(rows: FakeRow[]) {
  const calls: string[] = [];
  const store: LibraryRemovalStore = {
    async lockLibraryRow(userId, id) {
      calls.push(`lock:${id}`);
      const row = rows.find((r) => r.id === id && r.userId === userId && !r.deletedAt && !r.libraryRemovedAt);
      return row ? { id: row.id, messageId: row.messageId, projectId: row.projectId } : null;
    },
    async hide(_userId, id, when) {
      calls.push(`hide:${id}:${when.toISOString()}`);
    },
    async tombstone(_userId, id) {
      calls.push(`tombstone:${id}`);
    },
  };
  return { store, calls };
}

test("removing a chat's file from the Library hides it and never tombstones it", async () => {
  const { store, calls } = fakeStore([{ id: "a1", userId: "u1", messageId: "m1", projectId: null }]);
  assert.deepEqual(await removeFromLibraryWith(store, "u1", "a1", at), { mode: "hidden", keptIn: "chat" });
  assert.deepEqual(calls, ["lock:a1", `hide:a1:${at.toISOString()}`]);
});

test("removing a project's file from the Library hides it too", async () => {
  const { store, calls } = fakeStore([{ id: "a2", userId: "u1", messageId: null, projectId: "p1" }]);
  assert.deepEqual(await removeFromLibraryWith(store, "u1", "a2", at), { mode: "hidden", keptIn: "project" });
  assert.deepEqual(calls, ["lock:a2", `hide:a2:${at.toISOString()}`]);
});

test("removing a file nothing uses deletes it, as a Library delete always did", async () => {
  const { store, calls } = fakeStore([{ id: "a3", userId: "u1", messageId: null, projectId: null }]);
  assert.deepEqual(await removeFromLibraryWith(store, "u1", "a3", at), { mode: "deleted", keptIn: null });
  assert.deepEqual(calls, ["lock:a3", "tombstone:a3"]);
});

test("a file that is not in the reader's Library is not found, and nothing is written", async () => {
  const { store, calls } = fakeStore([
    { id: "theirs", userId: "u2", messageId: null, projectId: null },
    { id: "gone", userId: "u1", messageId: null, projectId: null, deletedAt: earlier },
    { id: "hidden", userId: "u1", messageId: "m1", projectId: null, libraryRemovedAt: earlier },
  ]);
  for (const id of ["theirs", "gone", "hidden", "missing"]) {
    assert.equal(await removeFromLibraryWith(store, "u1", id, at), null, id);
  }
  assert.deepEqual(calls, ["lock:theirs", "lock:gone", "lock:hidden", "lock:missing"]);
});

type Placement = { deletedAt: Date | null; libraryRemovedAt: Date | null };

/** Enough of Prisma's `where` to evaluate the two views: `null`, `{ not: null }`, `OR`. */
function holds(row: Placement, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === "OR") return (condition as Record<string, unknown>[]).some((branch) => holds(row, branch));
    const value = row[field as keyof Placement];
    if (condition === null) return value === null;
    if (condition && typeof condition === "object" && (condition as { not?: unknown }).not === null) return value !== null;
    throw new Error(`unexpected condition on ${field}`);
  });
}

test("every row is in exactly one of the Library and Recently deleted", () => {
  const library = libraryViewWhere("library");
  const deleted = libraryViewWhere("deleted");
  for (const deletedAt of [null, earlier]) {
    for (const libraryRemovedAt of [null, earlier]) {
      const row = { deletedAt, libraryRemovedAt };
      const label = JSON.stringify(row);
      assert.equal(holds(row, library), !deletedAt && !libraryRemovedAt, label);
      assert.notEqual(holds(row, library), holds(row, deleted), label);
    }
  }
});

test("the Library reports a hidden file as in Recently deleted, with its link and where it stayed", () => {
  const live = { messageId: "m1", projectId: null, deletedAt: null, libraryRemovedAt: null };
  assert.deepEqual(libraryItemPlacement(live), { deletedAt: null, withheld: false, inUse: "chat", keptIn: null });

  // Hidden: one date for "in Recently deleted", the bytes still served.
  assert.deepEqual(libraryItemPlacement({ ...live, libraryRemovedAt: at }), {
    deletedAt: at.toISOString(),
    withheld: false,
    inUse: "chat",
    keptIn: "chat",
  });

  // A real delete withholds the link and is in use nowhere, whatever its
  // message was: no chat shows a tombstone.
  assert.deepEqual(libraryItemPlacement({ ...live, deletedAt: at }), {
    deletedAt: at.toISOString(),
    withheld: true,
    inUse: null,
    keptIn: null,
  });

  // Hidden, then deleted where it was used (a project file the project page
  // removed): the delete is what the reader sees.
  assert.deepEqual(
    libraryItemPlacement({ messageId: null, projectId: "p1", deletedAt: at, libraryRemovedAt: earlier }),
    { deletedAt: at.toISOString(), withheld: true, inUse: null, keptIn: null },
  );

  // Hidden with nothing using it. An edit that deletes its message now
  // finishes the delete instead of leaving this (see the truncation tests
  // below), but a row in this state is still never said to be in a chat.
  assert.deepEqual(
    libraryItemPlacement({ messageId: null, projectId: null, deletedAt: null, libraryRemovedAt: earlier }),
    { deletedAt: earlier.toISOString(), withheld: false, inUse: null, keptIn: null },
  );
});

test("an edit that deletes a hidden file's message finishes its Library delete", () => {
  const sent = (overrides: Partial<SentAttachmentRow>): SentAttachmentRow => ({
    id: "a1",
    projectId: null,
    libraryRemovedAt: earlier,
    ...overrides,
  });
  // Taken out of the Library and used only by the message: nothing uses it
  // once the message is gone, so it is deleted as the reader asked.
  assert.equal(orphanedByMessageDelete(sent({})), true);
  // Still one of a project's files: the project keeps it, hidden.
  assert.equal(orphanedByMessageDelete(sent({ projectId: "p1" })), false);
  // Still in the Library: an ordinary file that outlives its message, untouched.
  assert.equal(orphanedByMessageDelete(sent({ libraryRemovedAt: null })), false);
});

test("the truncation tombstones exactly the hidden files it leaves unused, after locking every sent file", async () => {
  const calls: string[] = [];
  const rows: SentAttachmentRow[] = [
    { id: "hidden-chat-file", projectId: null, libraryRemovedAt: earlier },
    { id: "hidden-project-file", projectId: "p1", libraryRemovedAt: earlier },
    { id: "library-file", projectId: null, libraryRemovedAt: null },
  ];
  const settled = await settleLibraryRemovalsWith({
    async lockSentAttachments() {
      calls.push("lock");
      return rows;
    },
    async tombstone(id) {
      calls.push(`tombstone:${id}`);
    },
  });
  assert.deepEqual(settled, ["hidden-chat-file"]);
  assert.deepEqual(calls, ["lock", "tombstone:hidden-chat-file"]);

  const none = await settleLibraryRemovalsWith({
    async lockSentAttachments() {
      return [];
    },
    async tombstone() {
      throw new Error("nothing to tombstone");
    },
  });
  assert.deepEqual(none, []);
});

test("the edit route settles hidden files inside its transaction, before the messages go", () => {
  const route = read("src/app/api/messages/[id]/route.ts");
  // Interactive, so the settle and the delete share one transaction.
  assert.match(route, /prisma\.\$transaction\(async \(tx\) =>/);
  const settle = route.indexOf("settleLibraryRemovalsBeforeTruncation(tx, user.id, message.id)");
  const truncate = route.indexOf("tx.message.deleteMany(");
  assert.ok(settle !== -1, "the edit route settles Library removals");
  assert.ok(truncate !== -1, "the edit route truncates inside the transaction");
  assert.ok(settle < truncate, "settled before the messages (and their messageIds) go");

  const removal = read("src/lib/library-removal.ts");
  // The rows the deleteMany takes, stated the same way, every one locked (not
  // only the hidden ones, so a removal committing meanwhile is waited for).
  assert.match(removal, /later\."createdAt" > edited\."createdAt"/);
  assert.match(removal, /FOR UPDATE OF a/);
  assert.doesNotMatch(removal, /"libraryRemovedAt" IS NOT NULL\s+FOR UPDATE OF a/);
  assert.match(removal, /tombstoneAttachment\(tx, userId, \{ id \}\)/);
});

test("restoring a hidden file only clears the column while it is still only hidden", () => {
  const restore = read("src/app/api/attachments/[id]/restore/route.ts");
  // A delete from the project page landing between the read and the write
  // must not be reported as restored.
  assert.match(
    restore,
    /updateMany\(\{\s*where: \{ id: attachment\.id, userId: user\.id, deletedAt: null, libraryRemovedAt: \{ not: null \} \}/,
  );
  assert.match(restore, /shown\.count === 1/);
  assert.doesNotMatch(restore, /prisma\.attachment\.update\(\{\s*where: \{ id: attachment\.id, userId: user\.id \},\s*data: \{ libraryRemovedAt: null \}/);
});

test("native sync carries the column without filtering on it, and the iPhone Library uses it", () => {
  const sync = read("src/lib/sync-entities.ts");
  // The chat and the project on every client read this entity, so a hidden
  // file must still resolve; only a client's Library leaves it out.
  assert.match(sync, /prisma\.attachment\.findMany\(\{ where: \{ id: \{ in: ids \}, userId: accountId, deletedAt: null \} \}\)/);
  assert.match(sync, /libraryRemovedAt: row\.libraryRemovedAt\?\.toISOString\(\) \?\? null/);
  assert.doesNotMatch(sync, /libraryRemovedAt: (null|\{)/);

  const client = read("native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeProjectAPIClient.swift");
  assert.match(client, /path: "\/api\/library\/\\\(id\)"/);
  // The project screens' delete stays the real one.
  assert.match(client, /path: "\/api\/attachments\/\\\(id\)",\s*method: \.delete/);

  const view = read("native/iOS/JunoMobile/App/JunoMobileLibraryView.swift");
  assert.match(view, /model\.removeFromLibrary\(id: file\.id\)/);
  assert.doesNotMatch(view, /model\.deleteFile\(/);
  assert.match(view, /model\.libraryFiles/);
  assert.doesNotMatch(view, /model\.files\b/);
});

test("the toast says a file a chat or project uses stays there", () => {
  assert.deepEqual(removalNotice([{ inUse: null }]), { title: "Moved to Recently deleted" });
  assert.deepEqual(removalNotice([{ inUse: null }, { inUse: null }]), { title: "Moved to Recently deleted" });
  assert.deepEqual(removalNotice([{ inUse: "chat" }]), {
    title: "Removed from your library",
    description: "It stays in the chat that uses it.",
  });
  assert.deepEqual(removalNotice([{ inUse: "project" }]), {
    title: "Removed from your library",
    description: "It stays in the project that uses it.",
  });
  assert.deepEqual(removalNotice([{ inUse: "chat" }, { inUse: "chat" }]), {
    title: "Removed from your library",
    description: "They stay in the chats that use them.",
  });
  assert.deepEqual(removalNotice([{ inUse: "project" }, { inUse: "project" }]), {
    title: "Removed from your library",
    description: "They stay in the projects that use them.",
  });
  for (const mix of [
    [{ inUse: "chat" as const }, { inUse: "project" as const }],
    [{ inUse: "chat" as const }, { inUse: null }],
  ]) {
    assert.deepEqual(removalNotice(mix), {
      title: "Removed from your library",
      description: "Chats and projects keep the files they use.",
    });
  }
});

test("the Library deletes through its own route, and the attachment route stays a real delete", () => {
  const hook = read("src/components/library/use-library.ts");
  assert.match(hook, /fetch\(`\/api\/library\/\$\{target\.id\}`, \{ method: "DELETE" \}\)/);
  assert.doesNotMatch(hook, /fetch\(`\/api\/attachments\/\$\{target\.id\}`, \{ method: "DELETE" \}\)/);

  const libraryRoute = read("src/app/api/library/[id]/route.ts");
  assert.match(libraryRoute, /export async function DELETE/);
  assert.match(libraryRoute, /removeFromLibrary\(user\.id, id\)/);

  // The project page and the native project client delete project files and
  // covers through this route; it must not quietly become a hide.
  const attachmentRoute = read("src/app/api/attachments/[id]/route.ts");
  assert.match(attachmentRoute, /tombstoneAttachment\(tx, user\.id, attachment\)/);
  assert.doesNotMatch(attachmentRoute, /removeFromLibrary/);

  const removal = read("src/lib/library-removal.ts");
  assert.match(removal, /data: \{ deletedAt, parserState: "deleted" \}/);
  assert.match(removal, /knowledgeChunk\.updateMany/);
  // Locked before deciding, so a send that claims the file meanwhile cannot
  // leave it tombstoned under a message.
  assert.match(removal, /FOR UPDATE/);
  assert.match(removal, /data: \{ libraryRemovedAt: at \}/);
});

test("the list routes use the shared views and restore brings a hidden file straight back", () => {
  const list = read("src/app/api/library/route.ts");
  assert.match(list, /libraryViewWhere\(includeDeleted \? "deleted" : "library"\)/);
  // Only a tombstone's link is withheld; a hidden file's bytes are live.
  assert.match(list, /placement\.withheld \? \{ url: "" \}/);
  assert.doesNotMatch(list, /a\.deletedAt \? \{ url: "" \}/);
  // "Add from library" and a file token in a chat message share one clone,
  // and it reads only files still in the Library.
  assert.match(read("src/app/api/library/attach/route.ts"), /cloneLibraryAttachments\(/);
  assert.match(read("src/lib/library-attach.ts"), /libraryViewWhere\("library"\)/);
  const restore = read("src/app/api/attachments/[id]/restore/route.ts");
  assert.match(restore, /libraryViewWhere\("deleted"\)/);
  assert.match(restore, /data: \{ libraryRemovedAt: null \}/);
  assert.match(restore, /deletedAt: null, libraryRemovedAt: null/);
});

test("the account archive carries the column, and an import only hides what something there still uses", () => {
  const exported = read("src/app/api/account/export/route.ts");
  assert.match(exported, /libraryRemovedAt: true/);
  assert.match(exported, /libraryRemovedAt: attachment\.libraryRemovedAt/);
  // A hidden row nothing in the new account uses would sit in Recently
  // deleted with nothing to show it; it goes back to the Library instead.
  const imported = read("src/app/api/import/route.ts");
  assert.match(imported, /!deletedAt && libraryUse\(\{ messageId, projectId \}\)/);
  assert.match(imported, /dateValue\(rawAttachment\.libraryRemovedAt\)/);
});

test("no chat path reads the Library's column", () => {
  // The chat, its reload and the file readers keep a file the Library let go
  // of (native sync carries the column but never filters on it; see above). A chat path that learned to filter on this column would
  // bring the bug straight back.
  for (const path of [
    "src/lib/queries.ts",
    "src/app/api/chat/route.ts",
    "src/app/api/files/[...key]/route.ts",
    "src/app/api/attachments/[id]/document/route.ts",
    "src/app/api/attachments/[id]/preview/route.ts",
    // The model's file tools in that chat, and search, which links a file to
    // the chat or project it lives in and reads its (still live) index.
    "src/lib/agent/attachments.ts",
    "src/lib/search/sql.ts",
    "src/app/api/knowledge/documents/[id]/route.ts",
  ]) {
    assert.doesNotMatch(read(path), /libraryRemovedAt/, path);
  }
});
