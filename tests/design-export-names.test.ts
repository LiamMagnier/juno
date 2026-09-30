import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  downloadDisposition,
  exportHtmlPrototype,
  exportNotesHeader,
  exportPdf,
  exportSvg,
  pngRequest,
  safeFileName,
} from "../src/lib/design/export";
import { fileNameFromDisposition } from "../src/lib/download-name";
import { PAGE_ID, signInDocument } from "./design-fixtures";
import type { DesignDocument } from "../src/lib/design/types";

/*
 * A DESIGN EXPORT NAMED IN ANY SCRIPT DOWNLOADS.
 *
 * SVG, PDF and HTML exports answered 500 when the design or a layer had a
 * character above U+00FF in its name (X-23 in
 * docs/design/artifacts-design/00-AUDIT-OVERVIEW.md). The file was built; the
 * name then went raw into `Content-Disposition` and, for a PDF, the layer names
 * went raw into `X-Juno-Export-Notes`. A header value is bytes, `Headers`
 * throws on "登录", and the route's catch turned that into "Export failed".
 *
 * The first tests pin the helpers. The last drives the real route handler with
 * the session, the store and object storage stood in, because the defect was
 * where a correct file met the response, and only the route puts them together.
 */

/** Names that each broke a different step: CJK, curly quotes, emoji, controls, bidi. */
const HOSTILE_NAMES = [
  "登录",
  "Café “Ω” ☕",
  "Dashboard 📊 — Q3",
  'Plain "quoted" name',
  "line\r\nbreak",
  "report\u202egpj.exe",
  "../../etc/passwd",
  "",
  "   ",
  "...hidden",
];

/** What a browser does with an RFC 6266 value: prefer `filename*`, else `filename`. */
function savedName(disposition: string): string {
  const extended = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
  if (extended) return decodeURIComponent(extended);
  return /filename="([^"]*)"/.exec(disposition)?.[1] ?? "";
}

/** The design every route test exports: a non-Latin document and layer names. */
function internationalDocument(): DesignDocument {
  const doc = signInDocument();
  doc.name = "登录 — Café ☕";
  doc.nodes.card = { ...doc.nodes.card, name: "卡片 “主要”" };
  doc.nodes.button = { ...doc.nodes.button, name: "按钮 😀" };
  return doc;
}

test("a file name keeps the person's script and loses only what a file system cannot hold", () => {
  assert.equal(safeFileName("登录", "svg"), "登录.svg");
  assert.equal(safeFileName("Café “Ω” ☕", "pdf"), "Café “Ω” ☕.pdf");
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j', "svg"), "a b c d e f g h i j.svg");
  assert.equal(safeFileName("line\r\nbreak\ttab\u0000nul", "svg"), "line break tab nul.svg");
  assert.equal(safeFileName("report\u202egpj.exe", "svg"), "reportgpj.exe.svg", "a direction override cannot disguise the extension");
  assert.equal(safeFileName("...hidden", "html"), "hidden.html", "never a dot file");
  assert.equal(safeFileName("../../etc/passwd", "svg"), "etc passwd.svg");
  assert.equal(safeFileName("", "svg"), "design.svg");
  assert.equal(safeFileName(" \u0007 ", "svg"), "design.svg");
});

test("a long name is clipped by character, never through the middle of an emoji", () => {
  const name = "😀".repeat(100);
  const file = safeFileName(name, "svg");
  assert.equal(Array.from(file.slice(0, -".svg".length)).length, 80);
  assert.doesNotMatch(file, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  // The case that used to break: 79 ASCII characters then an emoji straddling
  // the old UTF-16 cut at 80.
  const straddling = safeFileName(`${"a".repeat(79)}😀😀`, "svg");
  assert.equal(straddling, `${"a".repeat(79)}😀.svg`);
  assert.doesNotThrow(() => encodeURIComponent(straddling));
  // A lone surrogate from a malformed name is dropped rather than encoded.
  assert.equal(safeFileName("bad\ud800name", "svg"), "badname.svg");
});

test("every disposition is a valid header, and the browser saves the real name", () => {
  for (const name of HOSTILE_NAMES) {
    const fileName = safeFileName(name, "svg");
    const disposition = downloadDisposition(fileName);
    assert.doesNotThrow(() => new Headers({ "Content-Disposition": disposition }), `header for ${JSON.stringify(name)}`);
    assert.match(disposition, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~-]+$/);
    assert.equal(savedName(disposition), fileName, `saved name for ${JSON.stringify(name)}`);
    assert.ok(savedName(disposition).endsWith(".svg"));
  }
});

test("the ASCII fallback keeps what it can and never goes empty", () => {
  const fallback = (fileName: string) => /filename="([^"]*)"/.exec(downloadDisposition(fileName))?.[1];
  assert.equal(fallback("Café.svg"), "Cafe.svg", "an accent is folded rather than dropped");
  assert.equal(fallback("登录.pdf"), "design.pdf");
  assert.equal(fallback("Sign in.html"), "Sign in.html");
  assert.equal(fallback("sign-in.juno.design.json"), "sign-in.juno.design.json");
  // A name that reaches the helper raw (the JSON export's identifier) is
  // cleaned by it too, not trusted to have been cleaned upstream.
  assert.equal(fallback('evil"; filename="x.exe.json'), "evil ; filename= x.exe.json");
  assert.doesNotThrow(() => new Headers({ "Content-Disposition": downloadDisposition("登录\r\n.juno.design.json") }));
});

test("the web editor saves the real name, not the ASCII fallback", () => {
  // The editor fetches an export as a blob and names the file itself, from the
  // header. It read only `filename=`, so "登录" saved as "design.svg" even
  // after the route learned to send the real name.
  for (const name of HOSTILE_NAMES) {
    const fileName = safeFileName(name, "svg");
    assert.equal(fileNameFromDisposition(downloadDisposition(fileName)), fileName, JSON.stringify(name));
  }
  assert.equal(fileNameFromDisposition('attachment; filename="plain.svg"'), "plain.svg", "an ASCII-only header still names the file");
  assert.equal(
    fileNameFromDisposition(`attachment; filename="design.svg"; filename*=UTF-8''%E0%A4%A.svg`),
    "design.svg",
    "a malformed UTF-8 form falls back to the ASCII one"
  );
  assert.equal(fileNameFromDisposition(null), null);
});

test("the PDF notes header is ASCII, parses back to the same notes, and is cut at a whole note", () => {
  const notes = ["卡片 “主要”: corner radius is not drawn in PDF", "按钮 😀: shadow is not drawn", "plain note"];
  const header = exportNotesHeader(notes);
  assert.match(header, /^[\x20-\x7e]*$/);
  assert.doesNotThrow(() => new Headers({ "X-Juno-Export-Notes": header }));
  assert.deepEqual(JSON.parse(header), notes);

  const many = Array.from({ length: 200 }, (_, i) => `图层 ${i}: gradient falls back to its first stop`);
  const cut = exportNotesHeader(many, 2_000);
  assert.ok(cut.length <= 2_000);
  const parsed = JSON.parse(cut) as string[];
  assert.ok(parsed.length > 0 && parsed.length < many.length);
  assert.deepEqual(parsed, many.slice(0, parsed.length), "a prefix of whole notes, none cut short");

  assert.equal(exportNotesHeader([]), "[]");
  assert.equal(exportNotesHeader(["x".repeat(5_000)]), "[]", "a note too long to fit is left out, not truncated");
});

test("each drawing export of a non-Latin design names a file a header can carry", () => {
  const doc = internationalDocument();
  const files = [
    exportSvg(doc, PAGE_ID).fileName,
    exportSvg(doc, PAGE_ID, "button").fileName,
    exportPdf(doc, PAGE_ID).fileName,
    exportHtmlPrototype(doc, PAGE_ID).fileName,
    pngRequest(doc, PAGE_ID).fileName,
  ];
  assert.deepEqual(files, ["登录 — Café ☕.svg", "按钮 😀.svg", "登录 — Café ☕.pdf", "登录 — Café ☕.html", "登录 — Café ☕.png"]);
  for (const file of files) {
    assert.doesNotThrow(() => new Headers({ "Content-Disposition": downloadDisposition(file) }));
    assert.equal(savedName(downloadDisposition(file)), file);
  }
});

// ---------------------------------------------------------------------------
// The route, end to end
// ---------------------------------------------------------------------------

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so the route suite skips there rather than failing.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!canMockModules) {
  test("design export route suite needs --experimental-test-module-mocks", { skip: true }, () => {});
} else {
  const artifact = { id: "art-1", identifier: "登录-screen", userId: "user-1" };
  let current: DesignDocument = internationalDocument();

  mock.module("@/lib/session", {
    namedExports: { getCurrentUser: async () => ({ id: "user-1", email: "ada@example.test", name: "Ada" }) },
  });
  mock.module("@/lib/design/store", {
    namedExports: {
      loadOwnedDesignArtifact: async (id: string, userId: string) => (id === artifact.id && userId === "user-1" ? artifact : null),
      documentFromArtifact: () => current,
    },
  });
  // The fixture has no image assets, so neither is reached; they are stood in
  // so importing the route does not construct a database client or an S3 one.
  mock.module("@/lib/prisma", {
    namedExports: { prisma: { attachment: { findFirst: async () => null } } },
  });
  mock.module("@/lib/storage", {
    namedExports: {
      headObject: async () => {
        throw new Error("not reached");
      },
    },
  });
  // The route's budget (the download bucket) is tested with the other artifact
  // limits; here it always lets the export through.
  mock.module("@/lib/artifact-rate-limit", {
    namedExports: { artifactWriteLimited: async () => null },
  });

  // Imported on first use, after the mocks above are in place.
  const exportAs = async (format: string, extra = "") => {
    const { GET } = await import("../src/app/api/design/[artifactId]/export/route");
    return GET(new Request(`http://juno.test/api/design/${artifact.id}/export?format=${format}${extra}`), {
      params: Promise.resolve({ artifactId: artifact.id }),
    });
  };

  test("SVG, PDF, HTML and JSON exports of a non-Latin design download instead of answering 500", async () => {
    current = internationalDocument();
    const expected: Record<string, string> = {
      svg: "登录 — Café ☕.svg",
      pdf: "登录 — Café ☕.pdf",
      html: "登录 — Café ☕.html",
      json: "登录-screen.juno.design.json",
    };
    for (const [format, name] of Object.entries(expected)) {
      const res = await exportAs(format);
      assert.equal(res.status, 200, `${format} exports`);
      const disposition = res.headers.get("Content-Disposition") ?? "";
      assert.equal(savedName(disposition), name, `${format} saves under the design's own name`);
      assert.match(disposition, /^attachment; filename="[\x20-\x7e]+"/);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      assert.ok((await res.text()).length > 0);
    }
  });

  test("one layer exports under the layer's name", async () => {
    current = internationalDocument();
    const res = await exportAs("svg", "&nodeId=button");
    assert.equal(res.status, 200);
    assert.equal(savedName(res.headers.get("Content-Disposition") ?? ""), "按钮 😀.svg");
  });

  test("the PDF's notes name non-Latin layers and still arrive as parseable JSON", async () => {
    current = internationalDocument();
    const res = await exportAs("pdf");
    assert.equal(res.status, 200);
    const notes = JSON.parse(res.headers.get("X-Juno-Export-Notes") ?? "null") as string[];
    assert.ok(Array.isArray(notes));
    assert.ok(
      notes.some((note) => note.startsWith("卡片 “主要”")),
      `the card's corner-radius note comes through intact: ${JSON.stringify(notes)}`
    );
  });
}
