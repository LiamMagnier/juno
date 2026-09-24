import assert from "node:assert/strict";
import test from "node:test";

import {
  authoredDesignSchema,
  expandAuthoredDesign,
  normalizeDesignArtifact,
  normalizeDesignArtifactWithNotes,
} from "../src/lib/design/authoring";
import { layoutPage } from "../src/lib/design/layout";
import { parseStoredDesignDocument, serializeDesignDocument } from "../src/lib/design/migrations";
import { buildSystemPromptSections } from "../src/lib/chat/system-prompt";
import { verifyAndRepairChatArtifacts } from "../src/lib/chat-artifact-verification";
import type { DesignDocument, DesignNode } from "../src/lib/design/types";

/*
 * A CHAT-MADE DESIGN WITH A PICTURE IN IT OPENS.
 *
 * The compact grammar taught the model an `image` node, but the grammar has no
 * way to name a picture and the operation layer refuses an image layer with no
 * asset. So every "design a screen with a photo" came back refused whole, and a
 * Free user lost one of their messages to it (X-10 in
 * docs/design/artifacts-design/00-AUDIT-OVERVIEW.md).
 *
 * The first-release fix has two halves, and both are pinned here: the prompt no
 * longer offers `image`, and a stray one (an old prompt in a long conversation,
 * or a model that slips) becomes the placeholder rectangle the prompt now asks
 * for, with a note, instead of taking the design down with it.
 */

const PROFILE = {
  name: "Profile",
  nodes: [
    {
      type: "frame" as const,
      name: "Screen",
      width: 375,
      height: 812,
      fill: "#ffffff",
      layout: { direction: "vertical" as const, gap: 16, padding: 24 },
      children: [
        { type: "text" as const, name: "Title", text: "Your profile", fontSize: 28 },
        { type: "image" as const, name: "Hero photo", width: 327, height: 200, radius: 12 },
        { type: "text" as const, name: "Caption", text: "Taken in Lisbon", fontSize: 14 },
      ],
    },
  ],
};

const byName = (doc: DesignDocument, name: string): DesignNode | undefined =>
  Object.values(doc.nodes).find((node) => node.name === name);

test("an image node becomes a placeholder rectangle, and the design is not refused", () => {
  const { content, notes } = normalizeDesignArtifactWithNotes(JSON.stringify(PROFILE), "profile");
  const doc = parseStoredDesignDocument(content);

  const hero = byName(doc, "Hero photo");
  assert.ok(hero, "the placeholder keeps the name the model gave it");
  assert.equal(hero.type, "rectangle");
  assert.equal(hero.width, 327);
  assert.equal(hero.height, 200);
  assert.equal(hero.cornerRadius, 12);
  assert.ok(!Object.values(doc.nodes).some((node) => node.type === "image"), "no image layer without a picture");

  // Filled, so the slot is visible on a white screen rather than an invisible gap.
  const fill = (hero as { fills?: { type: string }[] }).fills?.[0];
  assert.equal(fill?.type, "solid");

  assert.equal(notes.length, 1);
  assert.match(notes[0], /^nodes\.0\.children\.1: image “Hero photo” became a placeholder rectangle/);
  assert.match(notes[0], /Place one in the editor/);

  // Everything else the model wrote came through.
  assert.equal(byName(doc, "Title")?.type, "text");
  assert.equal(byName(doc, "Caption")?.type, "text");
});

test("the placeholder holds the image's place, so the layout around it does not move", () => {
  const asImage = expandAuthoredDesign(authoredDesignSchema.parse(PROFILE), "profile");
  const asRectangle = expandAuthoredDesign(
    authoredDesignSchema.parse({
      ...PROFILE,
      nodes: [
        {
          ...PROFILE.nodes[0],
          children: PROFILE.nodes[0].children.map((child) => (child.type === "image" ? { ...child, type: "rectangle" } : child)),
        },
      ],
    }),
    "profile"
  );
  const caption = (doc: DesignDocument) => layoutPage(doc, doc.pages[0].id).get(byName(doc, "Caption")!.id)!;
  assert.deepEqual(caption(asImage), caption(asRectangle));
  assert.ok(caption(asImage).y >= 24 + 200, "the caption sits below the photo's slot, not where the photo would have been");
});

test("an image the model gave a fill keeps it", () => {
  const doc = expandAuthoredDesign(
    authoredDesignSchema.parse({ nodes: [{ type: "image", name: "Avatar", width: 48, height: 48, fill: "#ff0000" }] }),
    "avatar"
  );
  const avatar = byName(doc, "Avatar") as DesignNode & { fills: { color: { r: number; g: number; b: number } }[] };
  assert.equal(avatar.fills[0].color.r, 1);
  assert.equal(avatar.fills[0].color.g, 0);
});

test("container fields and children on an image are dropped with the image, and the note counts them", () => {
  const notes: string[] = [];
  const doc = expandAuthoredDesign(
    authoredDesignSchema.parse({
      nodes: [
        {
          type: "frame",
          name: "Screen",
          width: 375,
          height: 812,
          children: [
            {
              type: "image",
              width: 100,
              height: 100,
              clip: true,
              layout: { direction: "horizontal" },
              children: [{ type: "text", name: "Overlay", text: "Hi" }, { type: "rectangle", name: "Scrim" }],
            },
            // Unknown keys a model reaches for are ignored, not stored.
            { type: "image", name: "Logo", src: "https://example.com/logo.png" },
          ],
        },
      ],
    }),
    "stray",
    notes
  );
  assert.equal(byName(doc, "Overlay"), undefined);
  assert.equal(byName(doc, "Scrim"), undefined);
  assert.equal(byName(doc, "Image")?.type, "rectangle", "an unnamed image is named for what it was");
  assert.equal(byName(doc, "Logo")?.type, "rectangle");
  assert.doesNotMatch(serializeDesignDocument(doc), /example\.com/);

  assert.equal(notes.length, 2);
  assert.match(notes[0], /^nodes\.0\.children\.0: image “Image”/);
  assert.match(notes[0], /Its 2 child layers were dropped\.$/);
  assert.match(notes[1], /^nodes\.0\.children\.1: image “Logo”/);
});

test("a design without images, and a full document, expand with no notes", () => {
  const plain = { nodes: [{ type: "rectangle", name: "Card", width: 100, height: 60 }] };
  assert.deepEqual(normalizeDesignArtifactWithNotes(JSON.stringify(plain), "plain").notes, []);

  const stored = normalizeDesignArtifact(JSON.stringify(PROFILE), "profile");
  const again = normalizeDesignArtifactWithNotes(stored, "profile");
  assert.deepEqual(again.notes, [], "a stored document is passed through, never re-expanded");
  assert.equal(again.content, stored);
});

test("a chat-made design with an image is accepted by verification, not refused", () => {
  const result = verifyAndRepairChatArtifacts([
    { identifier: "profile", type: "DESIGN", title: "Profile", content: JSON.stringify(PROFILE) },
  ]);
  assert.deepEqual(result.report.refused, []);
  assert.equal(result.report.status, "verified");
  assert.equal(result.artifacts.length, 1);
  // And what the store then writes is the placeholder, through the same function.
  const doc = parseStoredDesignDocument(normalizeDesignArtifact(result.artifacts[0].content, "profile"));
  assert.equal(byName(doc, "Hero photo")?.type, "rectangle");
});

test("the prompt no longer teaches an image node, and says what to draw instead", () => {
  const { stable } = buildSystemPromptSections({ memoryEnabled: false, canvas: true, voiceMode: false });
  const nodeTypes = /- Node types: ([^\n.]+)\./.exec(stable)?.[1];
  assert.ok(nodeTypes, "the DESIGN rules still list node types");
  assert.deepEqual(
    nodeTypes.split(",").map((type) => type.trim()),
    ["frame", "group", "rectangle", "ellipse", "line", "text"]
  );
  assert.match(stable, /There is no image node/);
  assert.match(stable, /draw a rectangle at its size with a neutral fill/);
});
