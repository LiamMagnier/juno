/**
 * The chat canvas's design editor, across the checkpoints it makes itself.
 *
 * The defect (X-02 in docs/design/artifacts-design/00-AUDIT-OVERVIEW.md): the
 * first saved edit of a generated design allocates a new checkpoint, and the
 * canvas recorded it as a version with an EMPTY body inside a wrapper keyed by
 * the version. The editor remounted on "", failed to parse it, and showed
 * "This design can't be opened"; the undo stack went with the old mount, and
 * Copy, Download and the Code tab read the empty body until a reload.
 *
 * Two layers are pinned here. The envelope: a commit is recorded with the
 * document the store holds, byte for byte, whether it folded or allocated.
 * The editor: `useDesignDocument` is rendered for real and driven the way the
 * canvas drives it — its commits recorded into the host's envelope and that
 * body handed straight back as its content — against a fake store that uses
 * the store's own checkpoint rule. It must keep its document and its undo
 * stack across that echo, and still load a body it did not write.
 *
 * `tsx --test` has no DOM. react-dom's client renderer runs a component that
 * renders nothing with two window stubs, set below, and each test file runs in
 * its own process, so they reach no other test.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";

import { useRecordDesignCommit } from "../src/components/canvas/use-record-design-commit";
import { useDesignDocument, type DesignEditorState, type DesignTransport } from "../src/components/design/use-design-document";
import { recordCommittedDesign } from "../src/lib/design/committed-envelope";
import { parseStoredDesignDocument, serializeDesignDocument } from "../src/lib/design/migrations";
import { allocatesCheckpoint, applyTransaction, CHECKPOINT_WINDOW_MS } from "../src/lib/design/operations";
import type { DesignDocument } from "../src/lib/design/types";
import type { ClientArtifact } from "../src/types/chat";
import { run, signInDocument } from "./design-fixtures";

const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; window?: unknown };
globals.IS_REACT_ACT_ENVIRONMENT = true;
// Read by react-dom at update time (`window.event`) and at commit time
// (`instanceof window.HTMLIFrameElement`), and nothing else it needs here.
globals.window ??= { event: undefined, HTMLIFrameElement: class {} };

const GENERATED_AT = "2026-09-23T10:00:00.000Z";

/** A design as the chat pipeline leaves it: one generated version. */
function generatedArtifact(doc: DesignDocument): ClientArtifact {
  const content = serializeDesignDocument(doc);
  return {
    id: "artifact-1",
    identifier: "sign-in",
    type: "DESIGN",
    title: "Sign in",
    currentVersion: 1,
    content,
    versions: [{ version: 1, content, origin: "generated", createdAt: GENERATED_AT }],
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
  };
}

function bodyOf(artifact: ClientArtifact, version: number): string | undefined {
  return artifact.versions.find((v) => v.version === version)?.content;
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

test("a new checkpoint is recorded with the committed document, not an empty body", () => {
  const generated = signInDocument();
  const edited = run(generated, [{ op: "updateNode", nodeId: "screen", patch: { x: 40 } }]).document;
  const artifact = generatedArtifact(generated);

  const next = recordCommittedDesign(artifact, 2, edited, new Date("2026-09-23T10:01:00.000Z"));

  assert.equal(next.currentVersion, 2);
  assert.equal(next.versions.length, 2);
  assert.equal(bodyOf(next, 1), artifact.content, "the generated checkpoint is left as it was");
  assert.equal(bodyOf(next, 2), serializeDesignDocument(edited), "the body is the one the store wrote");
  assert.equal(next.content, bodyOf(next, 2), "Copy and Download read the latest body");
  assert.equal(next.versions[1].origin, "edit");
  assert.deepEqual(parseStoredDesignDocument(bodyOf(next, 2)!).nodes.screen.x, 40, "and it opens");
});

test("a fold rewrites the newest checkpoint's body in place", () => {
  const generated = signInDocument();
  const first = run(generated, [{ op: "updateNode", nodeId: "screen", patch: { x: 40 } }]).document;
  const second = run(first, [{ op: "updateNode", nodeId: "screen", patch: { x: 80 } }]).document;
  const afterFirst = recordCommittedDesign(generatedArtifact(generated), 2, first);

  const folded = recordCommittedDesign(afterFirst, 2, second);

  assert.equal(folded.currentVersion, 2);
  assert.equal(folded.versions.length, 2, "no row for a change the store folded");
  assert.equal(bodyOf(folded, 2), serializeDesignDocument(second));
  assert.equal(folded.content, serializeDesignDocument(second));
  assert.equal(folded.versions[1].createdAt, afterFirst.versions[1].createdAt, "the checkpoint keeps its own time");
});

test("a reply older than the envelope leaves it alone", () => {
  const generated = signInDocument();
  const edited = run(generated, [{ op: "updateNode", nodeId: "screen", patch: { x: 40 } }]).document;
  const atThree = { ...generatedArtifact(generated), currentVersion: 3 };
  assert.equal(recordCommittedDesign(atThree, 2, edited), atThree);
});

// ---------------------------------------------------------------------------
// The editor, driven the way the chat canvas drives it
// ---------------------------------------------------------------------------

/**
 * A store with `commitTransaction`'s semantics and no database: validated
 * against its own copy, a new checkpoint or a fold by `allocatesCheckpoint`,
 * and the document sent back over JSON as the route sends it. Each change
 * lands a second after the last unless `pause` says the person stopped for
 * longer than the checkpoint window between every one.
 */
function fakeStore(initial: DesignDocument, { pause = false }: { pause?: boolean } = {}) {
  const store = {
    document: initial,
    currentVersion: 1,
    latestOrigin: "generated" as string,
    commits: 0,
    transport: null as unknown as DesignTransport,
  };
  store.transport = {
    async commit(transaction, origin) {
      await Promise.resolve();
      let next: DesignDocument;
      try {
        next = applyTransaction(store.document, transaction).document;
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "refused", document: store.document };
      }
      const ageMs = pause ? CHECKPOINT_WINDOW_MS : 1_000;
      if (allocatesCheckpoint({ origin: store.latestOrigin, ageMs }, transaction, origin)) {
        store.currentVersion += 1;
        store.latestOrigin = origin;
      }
      store.document = JSON.parse(JSON.stringify(next)) as DesignDocument;
      store.commits += 1;
      return { ok: true, document: store.document, version: store.currentVersion };
    },
  };
  return store;
}

interface Mount {
  editor: () => DesignEditorState;
  envelope: () => ClientArtifact;
  /** Put an older version on screen, read-only — the rail's "View vN". */
  pin: (version: number | null) => Promise<void>;
  /** A body arriving from outside the editor: a regeneration in the chat. */
  replace: (artifact: ClientArtifact) => Promise<void>;
  /** Let the editor's queue drain and the host re-render. */
  settle: () => Promise<void>;
  unmount: () => Promise<void>;
}

/**
 * The canvas panel's embedded path, minus the chrome: an envelope in host
 * state that the host replaces wholesale (as chat-view's
 * `handleArtifactUpdated` does), the version on screen derived from it, the
 * editor fed that version's body and number, and every commit recorded back
 * through the panel's own `useRecordDesignCommit`.
 */
async function mountEmbedded(initial: ClientArtifact, transport: DesignTransport): Promise<Mount> {
  let editor: DesignEditorState | null = null;
  let envelope = initial;
  let setEnvelope: (next: ClientArtifact) => void = () => {};
  let setPinned: (version: number | null) => void = () => {};

  function Host() {
    const [artifact, setArtifact] = React.useState(initial);
    const [pinned, setPinnedState] = React.useState<number | null>(null);
    setEnvelope = setArtifact;
    setPinned = setPinnedState;
    envelope = artifact;

    const selected = pinned ?? artifact.currentVersion;
    const content = bodyOf(artifact, selected) ?? artifact.content;
    const recordCommit = useRecordDesignCommit(artifact, setArtifact);
    const state = useDesignDocument({
      artifactId: artifact.id,
      initialContent: content,
      version: selected,
      readOnly: selected !== artifact.currentVersion,
      transport,
      onCommitted: recordCommit,
    });
    editor = state;
    return null;
  }

  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: null,
    textContent: "",
    addEventListener() {},
    removeEventListener() {},
  };
  const root = createRoot(container as unknown as Element);
  await React.act(async () => root.render(React.createElement(Host)));

  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await React.act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });
      if (!editor!.saving) return;
    }
    throw new Error("the editor never finished saving");
  };

  return {
    editor: () => editor!,
    envelope: () => envelope,
    pin: async (version) => {
      await React.act(async () => setPinned(version));
    },
    replace: async (artifact) => {
      await React.act(async () => setEnvelope(artifact));
    },
    settle,
    unmount: async () => {
      await React.act(async () => root.unmount());
    },
  };
}

test("the first saved edit of a generated design keeps the editor, its document and its undo stack", async () => {
  const generated = signInDocument();
  const store = fakeStore(generated);
  const mount = await mountEmbedded(generatedArtifact(generated), store.transport);
  try {
    assert.equal(mount.editor().loadError, null);
    assert.equal(mount.editor().document?.nodes.screen.x, 0);

    await React.act(async () => {
      mount.editor().apply([{ op: "updateNode", nodeId: "screen", patch: { x: 40 } }], "Move");
    });
    await mount.settle();

    // The store gave the change a checkpoint of its own — the case that broke.
    assert.equal(store.currentVersion, 2);
    const envelope = mount.envelope();
    assert.equal(envelope.currentVersion, 2);
    assert.equal(bodyOf(envelope, 2), serializeDesignDocument(store.document), "the envelope holds the stored body");

    // And the editor came through its own echo untouched.
    const editor = mount.editor();
    assert.equal(editor.loadError, null, "no \"This design can't be opened\"");
    assert.equal(editor.document?.nodes.screen.x, 40, "it still shows the edit");
    assert.equal(editor.document?.revision, store.document.revision);
    assert.equal(editor.history.length, 1, "the undo stack survived the checkpoint");
    assert.equal(editor.canUndo, true);

    // Undo is a real transaction against the store, and it folds into v2.
    await React.act(async () => mount.editor().undo());
    await mount.settle();
    assert.equal(mount.editor().document?.nodes.screen.x, 0);
    assert.equal(mount.editor().canRedo, true, "the redo stack survived the fold's echo too");
    assert.equal(store.currentVersion, 2);
    assert.equal(store.document.nodes.screen.x, 0);
    assert.equal(bodyOf(mount.envelope(), 2), serializeDesignDocument(store.document));
    assert.equal(mount.envelope().versions.length, 2);
  } finally {
    await mount.unmount();
  }
});

test("checkpoints acknowledged before the host renders all reach the version rail", async () => {
  const generated = signInDocument();
  const store = fakeStore(generated, { pause: true });
  const mount = await mountEmbedded(generatedArtifact(generated), store.transport);
  try {
    // The first goes out alone; the next two wait and leave together. The
    // store answers both inside one act scope, so the second acknowledgement
    // is recorded before the host has rendered the first.
    await React.act(async () => {
      mount.editor().apply([{ op: "updateNode", nodeId: "screen", patch: { x: 10 } }], "Move");
      mount.editor().apply([{ op: "updateNode", nodeId: "screen", patch: { x: 20 } }], "Move");
      mount.editor().apply([{ op: "updateNode", nodeId: "screen", patch: { x: 30 } }], "Move");
    });
    await mount.settle();

    assert.equal(store.commits, 2);
    assert.equal(store.currentVersion, 3);
    assert.deepEqual(
      mount.envelope().versions.map((v) => v.version),
      [1, 2, 3],
      "v2 is still on the rail after v3 was recorded"
    );
    assert.equal(parseStoredDesignDocument(bodyOf(mount.envelope(), 2)!).nodes.screen.x, 10);
    assert.equal(bodyOf(mount.envelope(), 3), serializeDesignDocument(store.document));
    assert.equal(mount.editor().document?.nodes.screen.x, 30);
    assert.equal(mount.editor().history.length, 3, "and the editor kept all three steps");
  } finally {
    await mount.unmount();
  }
});

test("a body the editor did not write still loads", async () => {
  const generated = signInDocument();
  const store = fakeStore(generated);
  const mount = await mountEmbedded(generatedArtifact(generated), store.transport);
  try {
    await React.act(async () => {
      mount.editor().apply([{ op: "updateNode", nodeId: "screen", patch: { x: 40 } }], "Move");
    });
    await mount.settle();
    assert.equal(mount.editor().history.length, 1);

    // Juno re-emits the design from the chat: a v3 the editor never saw.
    const regenerated = run(generated, [{ op: "updateNode", nodeId: "screen", patch: { name: "Welcome" } }]).document;
    const body = serializeDesignDocument(regenerated);
    const current = mount.envelope();
    await mount.replace({
      ...current,
      currentVersion: 3,
      content: body,
      versions: [...current.versions, { version: 3, content: body, origin: "generated", createdAt: GENERATED_AT }],
    });

    assert.equal(mount.editor().document?.nodes.screen.name, "Welcome");
    assert.equal(mount.editor().document?.nodes.screen.x, 0);
    assert.equal(mount.editor().history.length, 0, "a different document starts a fresh history");
  } finally {
    await mount.unmount();
  }
});

test("an older version the editor wrote opens as that version, read-only, and the latest comes back after", async () => {
  const generated = signInDocument();
  const store = fakeStore(generated);
  const mount = await mountEmbedded(generatedArtifact(generated), store.transport);
  try {
    await React.act(async () => {
      mount.editor().apply([{ op: "updateNode", nodeId: "screen", patch: { x: 40 } }], "Move");
    });
    await mount.settle();
    assert.equal(mount.envelope().currentVersion, 2);

    await mount.pin(1);
    assert.equal(mount.editor().document?.nodes.screen.x, 0, "v1 is the generated document");
    assert.equal(mount.editor().canUndo, false, "and it is read-only");

    await mount.pin(null);
    assert.equal(mount.editor().document?.nodes.screen.x, 40, "back on the latest, which the editor wrote");
    assert.equal(mount.editor().loadError, null);
  } finally {
    await mount.unmount();
  }
});
