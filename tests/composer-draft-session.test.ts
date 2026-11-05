import test from "node:test";
import assert from "node:assert/strict";
import { createComposerDraftSession } from "@/lib/chat/composer-draft-session";
import type { ContextToken } from "@/lib/chat/context-tokens";

test("a late first-send receipt clears the accepted draft in the replacement field", () => {
  const session = createComposerDraftSession("private:new");
  session.setText("The submitted prompt");
  const ticket = session.submissions.begin({ scope: session.scope, revision: session.getSnapshot().revision })!;
  const home = session.subscribe(() => {});
  home();
  let dockText = session.getSnapshot().text;
  const dock = session.subscribe(() => { dockText = session.getSnapshot().text; });
  assert.equal(session.clearIfCurrent(ticket.revision), true);
  assert.equal(dockText, "");
  assert.equal(session.getSnapshot().tokens.length, 0);
  dock();
});

test("typing during preflight survives the landing-to-dock remount and its late receipt", () => {
  const session = createComposerDraftSession("private:new");
  session.setText("The submitted prompt");
  const ticket = session.submissions.begin({ scope: session.scope, revision: session.getSnapshot().revision })!;
  session.setText("A newer draft");
  const restored = session.getSnapshot();
  assert.equal(restored.text, "A newer draft");
  assert.equal(session.clearIfCurrent(ticket.revision), false);
  assert.equal(session.getSnapshot(), restored);
  assert.equal(session.submissions.begin({ scope: session.scope, revision: restored.revision }), null, "remount cannot bypass the pending-send guard");
  session.submissions.finish(ticket);
  assert.ok(session.submissions.begin({ scope: session.scope, revision: restored.revision }));
});

test("the editor republishing identical tokens at mount does not invent an edit", () => {
  const session = createComposerDraftSession("saved:conversation");
  const token: ContextToken = { kind: "app", id: "github", label: "GitHub", range: { start: 4, end: 10 }, meta: { icon: "app:github" } };
  session.setTokens([token]);
  session.setText("Use GitHub");
  const before = session.getSnapshot();
  session.setTokens([{ ...token, range: { ...token.range! }, meta: { ...token.meta } }]);
  session.setText("Use GitHub");
  assert.equal(session.getSnapshot(), before);
  assert.equal(session.clearIfCurrent(before.revision), true);
});

test("text replacements keep only tokens still attached to their original words", () => {
  const session = createComposerDraftSession("saved:conversation");
  const token: ContextToken = { kind: "app", id: "github", label: "GitHub", range: { start: 4, end: 10 } };
  session.setTokens([token]);
  session.setText("Use GitHub");
  assert.equal(session.getSnapshot().tokens.length, 1);
  session.setText("Compare GitHub");
  assert.equal(session.getSnapshot().tokens.length, 0, "never reattach a chip by searching its name");
});

test("private sessions hold no module-level content and cannot populate a saved session", () => {
  const privateDraft = createComposerDraftSession("private:new");
  privateDraft.setText("Private draft text");
  const saved = createComposerDraftSession("saved:new");
  const nextPrivate = createComposerDraftSession("private:new");
  assert.equal(saved.getSnapshot().text, "");
  assert.equal(nextPrivate.getSnapshot().text, "");
  assert.equal(privateDraft.getSnapshot().text, "Private draft text");
});

test("an upload finishing after the landing field unmounts updates the docked field", () => {
  const session = createComposerDraftSession("saved:new");
  session.uploads.add({ localId: "up-pending", fileName: "next-turn.txt", size: 12, progress: 0, status: "uploading" });
  let landingEvents = 0;
  const unmountLanding = session.uploads.subscribe(() => { landingEvents++; });
  unmountLanding();

  let dockedUploads = session.uploads.getSnapshot();
  const unmountDock = session.uploads.subscribe(() => { dockedUploads = session.uploads.getSnapshot(); });
  session.uploads.update("up-pending", {
    progress: 100,
    status: "done",
    attachment: { id: "new-attachment", kind: "FILE", fileName: "next-turn.txt", size: 12, mimeType: "text/plain", url: "/api/files/new-attachment" },
  });
  assert.equal(landingEvents, 0, "unmounted field no longer owns the upload");
  assert.equal(dockedUploads.length, 1);
  assert.equal(dockedUploads[0]?.status, "done");
  assert.equal(dockedUploads[0]?.attachment?.id, "new-attachment");
  unmountDock();
});

test("a submitted file is removed without clearing files added during preflight", () => {
  const session = createComposerDraftSession("saved:new");
  const makeUpload = (localId: string) => ({
    localId, fileName: localId + ".txt", size: 4, progress: 100, status: "done" as const,
    attachment: { id: localId, kind: "FILE" as const, fileName: localId + ".txt", size: 4, mimeType: "text/plain", url: "/api/files/" + localId },
  });
  session.uploads.add(makeUpload("sent"));
  const submittedIds = new Set(session.uploads.getSnapshot().map((upload) => upload.attachment!.id));
  session.uploads.add(makeUpload("new"));
  for (const upload of session.uploads.getSnapshot()) {
    if (upload.attachment && submittedIds.has(upload.attachment.id)) session.uploads.remove(upload.localId);
  }
  assert.deepEqual(session.uploads.getSnapshot().map((upload) => upload.attachment?.id), ["new"]);
});

test("uploads remain scoped to their draft session, including incognito", () => {
  const saved = createComposerDraftSession("saved:new");
  const privateDraft = createComposerDraftSession("private:new");
  saved.uploads.add({ localId: "a", fileName: "a.txt", size: 1, progress: 0, status: "uploading" });
  assert.equal(privateDraft.uploads.getSnapshot().length, 0);
  saved.uploads.clear();
  assert.equal(saved.uploads.getSnapshot().length, 0);
  assert.equal(createComposerDraftSession("saved:new").uploads.getSnapshot().length, 0);
});
