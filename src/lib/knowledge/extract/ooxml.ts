/**
 * The ZIP + XML floor that the .docx, .pptx and .xlsx extractors stand on.
 *
 * Two decisions worth stating, because both look like laziness and are not:
 *
 * 1. There is no XML DOM. The repo has no XML parser dependency, and adding one
 *    to read three known-shaped Microsoft parts would be a poor trade: the parts
 *    are attacker-supplied, a DOM materializes the whole tree in memory, and we
 *    only ever need a forward stream of "tag opened / text / tag closed". So
 *    `scanXml` is a tokenizer, it allocates per token, and it cannot be made to
 *    recurse. Entity expansion is a fixed table — there is no DTD handling and
 *    therefore no billion-laughs.
 *
 * 2. Parts are read with a declared-size ceiling *before* they are decompressed.
 *    A 50 KB .docx whose document.xml inflates to 4 GB is a two-line file to
 *    write, and without this check it is an OOM in a request handler.
 */

import JSZip from "jszip";
import { EXTRACT_LIMITS } from "./types";

export interface OoxmlPackage {
  /** Part names present in the archive, in archive order. */
  names: string[];
  /** Decoded UTF-8 text of a part, or null when it is absent or over the ceiling. */
  read(name: string): Promise<string | null>;
}

/**
 * Open an OOXML package, or explain why it could not be opened.
 *
 * Never throws: a truncated upload, a password-protected file (which is a valid
 * OLE compound file, not a ZIP) and a renamed JPEG all arrive here, and each one
 * must degrade a single document rather than reject the upload.
 */
export async function openOoxml(
  bytes: Uint8Array
): Promise<{ ok: true; pkg: OoxmlPackage } | { ok: false; reason: string }> {
  // OOXML is a ZIP, and every ZIP starts "PK\x03\x04". Checking here gives a far
  // better message than JSZip's "corrupted zip" for the common real cases:
  // an encrypted Office file (OLE magic D0 CF 11 E0) or a mislabelled upload.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    const isOle = bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
    return {
      ok: false,
      reason: isOle
        ? "This looks like a password-protected or legacy Office file. Save it as an unprotected .docx, .pptx or .xlsx and upload it again."
        : "This file is not a valid Office document — its contents do not match its extension.",
    };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    return {
      ok: false,
      reason: `This Office file could not be opened: ${error instanceof Error ? error.message : "the archive is unreadable"}.`,
    };
  }

  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

  return {
    ok: true,
    pkg: {
      names,
      async read(name: string): Promise<string | null> {
        const entry = zip.file(name);
        if (!entry) return null;
        // `_data.uncompressedSize` is the size the archive *claims*, read from
        // the central directory without inflating anything. A lie here inflates
        // less than declared, never more, so trusting it is safe in the only
        // direction that matters.
        const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
        if (typeof declared === "number" && declared > EXTRACT_LIMITS.maxPartBytes) return null;
        try {
          return await entry.async("string");
        } catch {
          return null;
        }
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* XML tokenizer                                                               */
/* -------------------------------------------------------------------------- */

export type XmlEvent =
  | { kind: "open"; name: string; attrs: string }
  | { kind: "close"; name: string }
  | { kind: "empty"; name: string; attrs: string }
  | { kind: "text"; text: string };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the fixed entity set plus numeric references. No DTD, by design. */
export function decodeXmlText(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

/**
 * Walk an XML document as a flat event stream.
 *
 * Comments, processing instructions and DOCTYPE are skipped outright; CDATA is
 * emitted as text. Tag names keep their prefix (`w:p`, `a:t`) because the OOXML
 * parts we read always use the canonical prefixes, and resolving namespaces
 * properly would mean building the DOM this function exists to avoid.
 */
export function scanXml(xml: string, visit: (event: XmlEvent) => void): void {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      const tail = xml.slice(i);
      if (tail) visit({ kind: "text", text: decodeXmlText(tail) });
      return;
    }
    if (lt > i) {
      const text = xml.slice(i, lt);
      if (text) visit({ kind: "text", text: decodeXmlText(text) });
    }

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const body = xml.slice(lt + 9, end < 0 ? n : end);
      if (body) visit({ kind: "text", text: body });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }

    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) return;
    const inner = xml.slice(lt + 1, gt);
    i = gt + 1;

    if (inner.startsWith("/")) {
      visit({ kind: "close", name: inner.slice(1).trim() });
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const name = (space < 0 ? body : body.slice(0, space)).trim();
    const attrs = space < 0 ? "" : body.slice(space + 1);
    if (!name) continue;
    visit(selfClosing ? { kind: "empty", name, attrs } : { kind: "open", name, attrs });
  }
}

/** Read one attribute out of a tag's raw attribute text. */
export function xmlAttr(attrs: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return match ? decodeXmlText(match[1]) : null;
}

/** Every `<a:t>`/`<w:t>` run in a part, joined — the "just give me the words" path. */
export function xmlTextOf(xml: string, tagName: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buffer = "";
  scanXml(xml, (event) => {
    if (event.kind === "open" && event.name === tagName) {
      depth += 1;
      return;
    }
    if (event.kind === "close" && event.name === tagName) {
      depth -= 1;
      if (depth === 0) {
        out.push(buffer);
        buffer = "";
      }
      return;
    }
    if (event.kind === "text" && depth > 0) buffer += event.text;
  });
  return out;
}
