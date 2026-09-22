import { openOoxml, scanXml } from "./ooxml";
import { BlockCollector, EXTRACT_LIMITS, type ExtractionResult, type KnowledgeBlockType } from "./types";

/**
 * .odt / .ods / .odp → text blocks.
 *
 * OpenDocument is what LibreOffice, OpenOffice and Google Docs' "download as
 * ODF" produce, and Juno had no reader for any of it — so the upload was
 * refused and the person was told to convert a file that is, underneath, the
 * same shape as the .docx sitting next to it: a ZIP with an XML document
 * inside. The whole format costs one part (`content.xml`) and two element
 * names.
 *
 * DELIBERATELY ONE EXTRACTOR FOR ALL THREE. A text document, a spreadsheet and
 * a presentation differ in `content.xml` mostly by which elements wrap the
 * paragraphs; the paragraphs themselves are `<text:p>` in every one of them.
 * Splitting this into three modules would triple the surface to read the same
 * elements out of the same part.
 */

export const ODT_PARSER = "odt";
export const ODT_PARSER_VERSION = "1";

/** The single part that holds an OpenDocument's content, in all three kinds. */
const CONTENT_PART = "content.xml";

/**
 * Elements whose text is a heading rather than body prose.
 *
 * `text:h` carries the outline in a text document and the title on a slide;
 * marking it is what lets `documentOutline` produce a navigable list later
 * instead of an undifferentiated wall of paragraphs.
 */
const HEADING_TAGS = new Set(["text:h"]);
const PARAGRAPH_TAGS = new Set(["text:p", "text:h"]);

export async function extractOdt(input: {
  bytes: Uint8Array;
  fileName: string;
}): Promise<ExtractionResult> {
  const base = { parser: ODT_PARSER, parserVersion: ODT_PARSER_VERSION };

  const opened = await openOoxml(input.bytes);
  if (!opened.ok) {
    return { ...base, status: "failed", blocks: [], reason: opened.reason };
  }

  const content = await opened.pkg.read(CONTENT_PART);
  if (!content) {
    return {
      ...base,
      status: "failed",
      blocks: [],
      reason: "This OpenDocument file has no readable content part.",
    };
  }

  /*
   * Streamed rather than matched with a regex, because `<text:p>` nests:
   * a paragraph inside a table cell inside a paragraph is ordinary, and a
   * non-greedy regex would close the outer one at the inner one's tag. The
   * depth counter is what keeps a nested paragraph part of its parent rather
   * than a duplicate of it.
   */
  const collector = new BlockCollector();
  let depth = 0;
  let buffer = "";
  let heading = false;
  let ordinal = 0;

  scanXml(content, (event) => {
    if (event.kind === "open" && PARAGRAPH_TAGS.has(event.name)) {
      if (depth === 0) {
        buffer = "";
        heading = HEADING_TAGS.has(event.name);
      }
      depth += 1;
      return;
    }
    if (event.kind === "close" && PARAGRAPH_TAGS.has(event.name)) {
      depth -= 1;
      if (depth > 0) {
        // A nested paragraph ends: keep its text in the parent, with a space
        // so a table cell does not run into the next one.
        buffer += " ";
        return;
      }
      depth = 0;
      const text = buffer.replace(/\s+/g, " ").trim();
      buffer = "";
      if (!text || ordinal >= EXTRACT_LIMITS.maxBlocks) return;
      ordinal += 1;
      collector.push({
        type: (heading ? "heading" : "paragraph") satisfies KnowledgeBlockType,
        text,
        // OpenDocument has no page geometry until it is laid out, so the
        // honest locator is position within the document, not an invented page.
        path: input.fileName,
        lineStart: ordinal,
        lineEnd: ordinal,
        heading: [],
        confidence: 1,
      });
      return;
    }
    /*
     * `text:tab` and `text:line-break` are ELEMENTS, not characters, and they
     * are written self-closing — `<text:tab/>` — which `scanXml` reports as
     * `empty`, not as `open`. Matching only `open` dropped them silently and
     * ran the words on either side together: "the board approved theOntario
     * expansion".
     */
    if (
      (event.kind === "empty" || event.kind === "open") &&
      depth > 0 &&
      (event.name === "text:tab" || event.name === "text:line-break" || event.name === "text:s")
    ) {
      buffer += " ";
      return;
    }
    if (event.kind === "text" && depth > 0) buffer += event.text;
  });

  const blocks = collector.done();
  if (!blocks.length) {
    return {
      ...base,
      status: "degraded",
      blocks: [],
      reason: "This OpenDocument file contains no readable text — it may hold only images.",
    };
  }
  return { ...base, status: "ok", blocks };
}
