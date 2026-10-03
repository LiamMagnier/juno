/*
 * Where a sketch's vector document waits while its PNG rides the composer.
 *
 * Keyed by the attachment's file name (`sketchFileName` stamps it to the
 * second, and a clash gets a counter), because that is the one thing the
 * composer's upload row and the editor both know before the upload has an id.
 * Memory only, on purpose: the composer's own attachment row does not survive
 * a reload either, so a document that outlived its tile would have nothing to
 * reopen from.
 *
 * `draft` is the sketch that was closed without being attached, so an
 * accidental Escape costs nothing; attaching or clearing empties it.
 */

import type { SketchDoc } from "./sketch-core";

const docs = new Map<string, SketchDoc>();
let draft: SketchDoc | null = null;

export const sketchStore = {
  get: (fileName: string) => docs.get(fileName) ?? null,
  has: (fileName: string) => docs.has(fileName),
  put(fileName: string, doc: SketchDoc) {
    docs.set(fileName, doc);
    // A long session that attaches dozens of sketches keeps only the recent ones.
    if (docs.size > 24) docs.delete(docs.keys().next().value as string);
  },
  forget: (fileName: string) => void docs.delete(fileName),
  /** A name no live sketch already holds. */
  uniqueName(base: string) {
    if (!docs.has(base)) return base;
    for (let i = 2; ; i++) {
      const name = base.replace(/\.png$/, ` ${i}.png`);
      if (!docs.has(name)) return name;
    }
  },
  get draft() {
    return draft;
  },
  set draft(doc: SketchDoc | null) {
    draft = doc && doc.objects.length > 0 ? doc : null;
  },
};
