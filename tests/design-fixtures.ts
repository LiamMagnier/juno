/**
 * Shared design-document fixtures for the design tests.
 *
 * Built through the operation layer rather than as literals, so the fixtures
 * themselves are evidence that the operations produce valid documents — and so
 * a schema change that breaks construction fails loudly here instead of quietly
 * everywhere.
 */

import { createDesignDocument, parseDesignDocument } from "../src/lib/design/schema";
import { applyTransaction, type DesignOperation, type DesignTransaction } from "../src/lib/design/operations";
import type { DesignDocument } from "../src/lib/design/types";

export const PAGE_ID = "page1";

export function emptyDocument(): DesignDocument {
  return createDesignDocument({ id: "doc1", name: "Test document", pageId: PAGE_ID, now: "2026-01-01T00:00:00.000Z" });
}

let sequence = 0;

export function transaction(operations: DesignOperation[], overrides: Partial<DesignTransaction> = {}): DesignTransaction {
  return {
    id: `tx${sequence++}`,
    baseRevision: 0,
    operations,
    author: "user",
    summary: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Apply operations against `doc` at its current revision. */
export function run(doc: DesignDocument, operations: DesignOperation[], overrides: Partial<DesignTransaction> = {}) {
  return applyTransaction(doc, transaction(operations, { baseRevision: doc.revision, ...overrides }));
}

/**
 * A sign-in screen: a 375×812 frame with a vertical auto-layout card holding a
 * title, an email field and a primary button. Node ids are fixed so tests can
 * name them, which is the same property the product relies on.
 */
export function signInDocument(): DesignDocument {
  let doc = emptyDocument();

  doc = run(doc, [
    {
      op: "createNode",
      parentId: null,
      pageId: PAGE_ID,
      node: {
        type: "frame",
        id: "screen",
        name: "Sign in",
        patch: { x: 0, y: 0, width: 375, height: 812, clipsContent: true },
      },
    },
    {
      op: "createNode",
      parentId: "screen",
      pageId: PAGE_ID,
      node: {
        type: "frame",
        id: "card",
        name: "Card",
        patch: {
          x: 24,
          y: 200,
          width: 327,
          height: 240,
          cornerRadius: 16,
          layout: {
            direction: "vertical",
            padding: { top: 24, right: 24, bottom: 24, left: 24 },
            gap: 16,
            align: "start",
            justify: "start",
            wrap: false,
          },
          heightMode: "hug",
        },
      },
    },
    {
      op: "createNode",
      parentId: "card",
      pageId: PAGE_ID,
      node: { type: "text", id: "title", name: "Title", patch: { characters: "Welcome back", width: 279, widthMode: "fill" } },
    },
    {
      op: "createNode",
      parentId: "card",
      pageId: PAGE_ID,
      node: { type: "rectangle", id: "email", name: "Email field", patch: { width: 279, height: 44, cornerRadius: 8, widthMode: "fill" } },
    },
    {
      op: "createNode",
      parentId: "card",
      pageId: PAGE_ID,
      node: {
        type: "frame",
        id: "button",
        name: "Sign in button",
        patch: {
          width: 279,
          height: 48,
          cornerRadius: 8,
          widthMode: "fill",
          fills: [{ type: "solid", color: { r: 0.2, g: 0.3, b: 0.9, a: 1 } }],
        },
      },
    },
    {
      op: "createNode",
      parentId: "button",
      pageId: PAGE_ID,
      node: {
        type: "text",
        id: "buttonLabel",
        name: "Label",
        patch: { characters: "Sign in", width: 100, height: 20, x: 90, y: 14 },
      },
    },
  ]).document;

  return parseDesignDocument(JSON.parse(JSON.stringify(doc)));
}

/** A two-mode colour collection with an alias, for variable tests. */
export function withTokens(doc: DesignDocument): DesignDocument {
  return run(doc, [
    {
      op: "createVariable",
      collection: { id: "col1", name: "Theme", modes: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }] },
      variable: {
        id: "var-primary",
        collectionId: "col1",
        name: "primary",
        type: "color",
        valuesByMode: {
          light: { kind: "color", value: { r: 0.2, g: 0.3, b: 0.9, a: 1 } },
          dark: { kind: "color", value: { r: 0.5, g: 0.6, b: 1, a: 1 } },
        },
      },
    },
    {
      op: "createVariable",
      variable: {
        id: "var-accent",
        collectionId: "col1",
        name: "accent",
        // Alias → primary. Only a light value is declared, so Dark exercises
        // mode inheritance from the collection's first mode.
        type: "color",
        valuesByMode: { light: { kind: "alias", value: "var-primary" } },
      },
    },
  ]).document;
}
