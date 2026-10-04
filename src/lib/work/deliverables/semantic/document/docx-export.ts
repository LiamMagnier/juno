/**
 * Semantic document <-> .docx (BRIEF §29/§30). Server-only: imports `docx`.
 *
 * `exportDocumentDocx` writes the model as a Word file a person can keep
 * working in: real heading styles, real numbered and bulleted lists, tables
 * with a repeating header row, embedded figures, Word comments anchored on
 * their block, and pending suggestions as real tracked changes (accept/reject
 * in Word works on them).
 *
 * `readDocumentDocx` reads such a file — or a Word file from anywhere — back
 * into the model. Everything this writer marks with a named style the reader
 * recognises by that style, so export -> reopen gives the same blocks. Ids are
 * not stored in the file; the reader assigns fresh ones in document order.
 *
 * What the file cannot carry, and so a reopen does not restore:
 *   - block, comment, revision and source ids (reassigned: b1…, c1…, r1…, src1…);
 *   - accepted and rejected revisions (already applied or discarded; history only);
 *   - a figure's `widthPct` of exactly 100 (it is the default and reads back unset);
 *   - WebP figures: Word cannot embed WebP, so they export as a "[Image: alt]"
 *     placeholder and reopen as that paragraph;
 *   - `code` styling inside a callout title, and links inside tracked insertions
 *     of list/table text (lists and tables carry no tracked changes in the model).
 *
 * Resolved comments: `docx` 9.7.1 only writes the resolved ("done") flag when
 * comments are threaded replies, so this module adds the standard
 * `word/commentsExtended.xml` part itself after packing (w15:commentEx with
 * w15:done="1"), the same part Word writes. The reader reads it back.
 *
 * Images: only `data:` PNG, JPEG and GIF are embedded. An https figure is
 * never fetched (see `isAllowedImageSource` in ../shared.ts); it exports as a
 * "[Image: alt]" placeholder hyperlinked to its URL, which reopens as the same
 * figure.
 */

import {
  AlignmentType,
  BorderStyle,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  InsertedTextRun,
  LevelFormat,
  PageBreak,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphStyleOptions,
  type ICharacterStyleOptions,
  type ParagraphChild,
} from "docx";
import JSZip from "jszip";
import { SemanticError, decodeDataImage } from "@/lib/work/deliverables/semantic/shared";
import {
  normalizeDocument,
  parseInline,
  runsToMarkup,
  type Block,
  type Comment,
  type DocumentModel,
  type InlineRun,
  type Revision,
  type Source,
} from "@/lib/work/deliverables/semantic/document/model";

// ---------------------------------------------------------------------------
// Shared vocabulary between writer and reader
// ---------------------------------------------------------------------------

const MONO = "Consolas";
const MONO_FONTS = new Set(["consolas", "courier new", "courier", "menlo", "monaco", "sf mono", "source code pro"]);
/** 6.5in of text width at 96 dpi: a Letter or A4 page with 1in margins. */
const CONTENT_WIDTH_PX = 624;
const EMU_PER_PX = 9525;

const STYLE = {
  lead: "Lead",
  quote: "Quote",
  callout: { note: "CalloutNote", tip: "CalloutTip", warning: "CalloutWarning" },
  caption: "Caption",
  figure: "Figure",
  tableHeader: "TableHeader",
  tableSpacer: "TableSpacer",
  referencesHeading: "ReferencesHeading",
  reference: "Reference",
  commentQuote: "CommentQuote",
  // character styles
  inlineCode: "InlineCode",
  citation: "Citation",
  calloutTitle: "CalloutTitle",
  refTitle: "RefTitle",
  refPublisher: "RefPublisher",
  refUrl: "RefUrl",
  refAccessed: "RefAccessed",
} as const;

const NUMBERING = { bullet: "alevr-bullet", ordered: "alevr-ordered", refs: "alevr-refs" } as const;

const IMAGE_PLACEHOLDER = /^\[Image: ([\s\S]*)\]$/;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

interface RevisionStamp {
  kind: "ins" | "del";
  id: number;
  author: string;
  date: string;
}

interface ExportContext {
  sourceNumber: Map<string, number>;
  nextRevisionId: () => number;
  listInstance: () => number;
}

function stampFor(revision: Revision, kind: "ins" | "del", ctx: ExportContext): RevisionStamp {
  return { kind, id: ctx.nextRevisionId(), author: revision.author, date: revision.createdAt };
}

type RunOptions = {
  text?: string;
  bold?: boolean;
  italics?: boolean;
  style?: string;
  break?: number;
};

function makeRun(options: RunOptions, stamp?: RevisionStamp): ParagraphChild {
  if (!stamp) return new TextRun(options);
  const tracked = { ...options, id: stamp.id, author: stamp.author, date: stamp.date };
  return stamp.kind === "ins" ? new InsertedTextRun(tracked) : new DeletedTextRun(tracked);
}

/** One inline run -> text runs, a `\n` becoming a line break. */
function runPieces(run: InlineRun, ctx: ExportContext, styleOverride: string | undefined, stamp?: RevisionStamp): ParagraphChild[] {
  if (run.cite) {
    const number = ctx.sourceNumber.get(run.cite);
    return [makeRun({ text: number ? `[${number}]` : `[@${run.cite}]`, style: STYLE.citation }, stamp)];
  }
  const style = styleOverride ?? (run.code ? STYLE.inlineCode : run.link ? "Hyperlink" : undefined);
  return run.text.split("\n").map((piece, index) =>
    makeRun(
      {
        text: piece,
        ...(index > 0 ? { break: 1 } : {}),
        ...(run.bold ? { bold: true } : {}),
        ...(run.italic ? { italics: true } : {}),
        ...(style ? { style } : {}),
      },
      stamp
    )
  );
}

/** Inline markup -> paragraph children, links grouped into one hyperlink each. */
function inlineChildren(
  text: string,
  ctx: ExportContext,
  options: { stamp?: RevisionStamp; style?: string } = {}
): ParagraphChild[] {
  const runs = parseInline(text);
  const out: ParagraphChild[] = [];
  let i = 0;
  while (i < runs.length) {
    const run = runs[i];
    if (run.link && !run.cite) {
      let j = i;
      const group: ParagraphChild[] = [];
      while (j < runs.length && runs[j].link === run.link && !runs[j].cite) {
        group.push(...runPieces(runs[j], ctx, options.style, options.stamp));
        j++;
      }
      out.push(new ExternalHyperlink({ link: run.link, children: group }));
      i = j;
      continue;
    }
    out.push(...runPieces(run, ctx, options.style, options.stamp));
    i++;
  }
  return out;
}

/** Wraps a block's first paragraph children in its Word comments. */
function anchorComments(children: ParagraphChild[], commentIds: number[]): ParagraphChild[] {
  if (commentIds.length === 0) return children;
  return [
    ...commentIds.map((id) => new CommentRangeStart(id)),
    ...children,
    ...commentIds.flatMap((id) => [new CommentRangeEnd(id), new TextRun({ children: [new CommentReference(id)] })]),
  ];
}

interface ImageSize {
  width: number;
  height: number;
}

/** Intrinsic pixel size from a PNG, GIF or JPEG header; null when unreadable. */
function imageSize(bytes: Buffer, extension: string): ImageSize | null {
  try {
    if (extension === "png" && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (extension === "gif" && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (extension === "jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function figureParagraphs(block: Extract<Block, { type: "figure" }>, commentIds: number[], ctx: ExportContext): Paragraph[] {
  const out: Paragraph[] = [];
  const image = decodeDataImage(block.src);
  const pct = block.widthPct ?? 100;
  if (image && image.extension !== "webp") {
    const size = imageSize(image.bytes, image.extension) ?? { width: 4, height: 3 };
    const width = Math.max(1, Math.round((CONTENT_WIDTH_PX * pct) / 100));
    const height = Math.max(1, Math.round((width * size.height) / Math.max(1, size.width)));
    out.push(
      new Paragraph({
        style: STYLE.figure,
        children: anchorComments(
          [
            new ImageRun({
              type: image.extension === "jpeg" ? "jpg" : image.extension,
              data: image.bytes,
              transformation: { width, height },
              altText: { name: block.alt.slice(0, 120), description: block.alt, title: block.alt.slice(0, 120) },
            }),
          ],
          commentIds
        ),
      })
    );
  } else {
    // Never fetched: an https image is named and linked, a WebP one is named.
    const label = new TextRun({ text: `[Image: ${block.alt}]`, italics: true });
    const child = block.src.startsWith("https:") ? new ExternalHyperlink({ link: block.src, children: [label] }) : label;
    out.push(new Paragraph({ style: STYLE.figure, children: anchorComments([child], commentIds) }));
  }
  if (block.caption) out.push(new Paragraph({ style: STYLE.caption, children: inlineChildren(block.caption, ctx) }));
  return out;
}

function tableElements(block: Extract<Block, { type: "table" }>, commentIds: number[], ctx: ExportContext): (Paragraph | Table)[] {
  const cell = (text: string, header: boolean, anchor: number[]) =>
    new TableCell({
      children: [
        new Paragraph({
          ...(header ? { style: STYLE.tableHeader } : {}),
          children: anchorComments(inlineChildren(text, ctx), anchor),
        }),
      ],
      ...(header ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" } } : {}),
    });
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        // Repeats on every page the table spills onto.
        tableHeader: true,
        children: block.header.map((text, index) => cell(text, true, index === 0 ? commentIds : [])),
      }),
      ...block.rows.map((row) => new TableRow({ children: row.map((text) => cell(text, false, [])) })),
    ],
  });
  // Two adjacent tables merge in Word; the caption or a marked spacer keeps them apart.
  const after = block.caption
    ? new Paragraph({ style: STYLE.caption, children: inlineChildren(block.caption, ctx) })
    : new Paragraph({ style: STYLE.tableSpacer, children: [] });
  return [table, after];
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4] as const;

function blockElements(
  block: Block,
  commentIds: number[],
  rewrite: Revision | undefined,
  ctx: ExportContext
): (Paragraph | Table)[] {
  /** The block's text with its pending replacement or deletion as tracked runs. */
  const trackedText = (text: string): { children: ParagraphChild[]; markDeleted?: RevisionStamp } => {
    if (!rewrite) return { children: inlineChildren(text, ctx) };
    if (rewrite.kind === "replace") {
      return {
        children: [
          ...inlineChildren(text, ctx, { stamp: stampFor(rewrite, "del", ctx) }),
          ...inlineChildren(rewrite.text, ctx, { stamp: stampFor(rewrite, "ins", ctx) }),
        ],
      };
    }
    const stamp = stampFor(rewrite, "del", ctx);
    return { children: inlineChildren(text, ctx, { stamp }), markDeleted: stamp };
  };
  const markRun = (stamp: RevisionStamp | undefined) =>
    stamp ? { run: { deletion: { id: ctx.nextRevisionId(), author: stamp.author, date: stamp.date } } } : {};

  switch (block.type) {
    case "heading": {
      const { children, markDeleted } = trackedText(block.text);
      return [
        new Paragraph({ heading: HEADINGS[block.level - 1], children: anchorComments(children, commentIds), ...markRun(markDeleted) }),
      ];
    }
    case "paragraph": {
      const { children, markDeleted } = trackedText(block.text);
      const style = block.style === "lead" ? STYLE.lead : block.style === "quote" ? STYLE.quote : undefined;
      return [
        new Paragraph({ ...(style ? { style } : {}), children: anchorComments(children, commentIds), ...markRun(markDeleted) }),
      ];
    }
    case "callout": {
      const { children, markDeleted } = trackedText(block.text);
      const title = block.title
        ? [...inlineChildren(block.title, ctx, { style: STYLE.calloutTitle }), new TextRun({ break: 1 })]
        : [];
      return [
        new Paragraph({
          style: STYLE.callout[block.tone],
          children: anchorComments([...title, ...children], commentIds),
          ...markRun(markDeleted),
        }),
      ];
    }
    case "list": {
      // Each list its own numbering instance: Word restarts the count, and the
      // reader can tell two adjacent lists apart.
      const instance = ctx.listInstance();
      const reference = block.ordered ? NUMBERING.ordered : NUMBERING.bullet;
      return block.items.map(
        (item, index) =>
          new Paragraph({
            numbering: { reference, level: item.level, instance },
            children: anchorComments(inlineChildren(item.text, ctx), index === 0 ? commentIds : []),
          })
      );
    }
    case "table":
      return tableElements(block, commentIds, ctx);
    case "figure":
      return figureParagraphs(block, commentIds, ctx);
    case "pageBreak":
      return [new Paragraph({ children: anchorComments([new PageBreak()], commentIds) })];
  }
}

function hex(color: string | undefined): string | undefined {
  return color ? color.replace(/^#/, "").toUpperCase() : undefined;
}

function documentStyles(model: DocumentModel) {
  const { bodyFont, headingFont, baseSizePt, accent } = model.styles;
  const base = baseSizePt ?? 11;
  const accentHex = hex(accent);
  const heading = (sizePt: number) => ({
    run: {
      bold: true,
      size: Math.round(sizePt * 2),
      ...(headingFont ? { font: headingFont } : {}),
      ...(accentHex ? { color: accentHex } : {}),
    },
    paragraph: { spacing: { before: 240, after: 120 }, keepNext: true },
  });
  const calloutStyle = (id: string, name: string, fill: string, rule: string): IParagraphStyleOptions => ({
    id,
    name,
    basedOn: "Normal",
    quickFormat: true,
    paragraph: {
      shading: { type: ShadingType.CLEAR, color: "auto", fill },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: rule, space: 8 } },
      indent: { left: 240, right: 240 },
      spacing: { before: 160, after: 160 },
    },
  });
  const paragraphStyles: IParagraphStyleOptions[] = [
    { id: STYLE.lead, name: STYLE.lead, basedOn: "Normal", quickFormat: true, run: { size: Math.round(base * 2.5), color: "404040" } },
    {
      id: STYLE.quote,
      name: STYLE.quote,
      basedOn: "Normal",
      quickFormat: true,
      run: { italics: true, color: "404040" },
      paragraph: {
        indent: { left: 720, right: 720 },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: accentHex ?? "BFBFBF", space: 12 } },
      },
    },
    calloutStyle(STYLE.callout.note, STYLE.callout.note, "EEF3FA", "5B8DD6"),
    calloutStyle(STYLE.callout.tip, STYLE.callout.tip, "EDF7EF", "4CA15F"),
    calloutStyle(STYLE.callout.warning, STYLE.callout.warning, "FDF4E4", "D99A2B"),
    {
      id: STYLE.caption,
      name: STYLE.caption,
      basedOn: "Normal",
      quickFormat: true,
      run: { italics: true, size: Math.round(base * 1.8), color: "595959" },
      paragraph: { spacing: { before: 60, after: 200 } },
    },
    { id: STYLE.figure, name: STYLE.figure, basedOn: "Normal", paragraph: { alignment: AlignmentType.CENTER, keepNext: true } },
    { id: STYLE.tableHeader, name: STYLE.tableHeader, basedOn: "Normal", run: { bold: true } },
    { id: STYLE.tableSpacer, name: STYLE.tableSpacer, basedOn: "Normal", run: { size: 4 }, paragraph: { spacing: { before: 0, after: 0 } } },
    {
      id: STYLE.referencesHeading,
      name: STYLE.referencesHeading,
      basedOn: "Normal",
      next: STYLE.reference,
      run: { bold: true, size: Math.round(base * 2.6), ...(headingFont ? { font: headingFont } : {}), ...(accentHex ? { color: accentHex } : {}) },
      paragraph: { spacing: { before: 360, after: 120 }, keepNext: true },
    },
    { id: STYLE.reference, name: STYLE.reference, basedOn: "Normal", run: { size: Math.round(base * 1.8) } },
    { id: STYLE.commentQuote, name: STYLE.commentQuote, basedOn: "Normal", run: { italics: true, color: "595959" } },
  ];
  const characterStyles: ICharacterStyleOptions[] = [
    { id: STYLE.inlineCode, name: STYLE.inlineCode, run: { font: MONO, shading: { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" } } },
    { id: STYLE.citation, name: STYLE.citation, run: { superScript: true, ...(accentHex ? { color: accentHex } : {}) } },
    { id: STYLE.calloutTitle, name: STYLE.calloutTitle, run: { bold: true } },
    { id: STYLE.refTitle, name: STYLE.refTitle, run: { italics: true } },
    { id: STYLE.refPublisher, name: STYLE.refPublisher, run: {} },
    { id: STYLE.refUrl, name: STYLE.refUrl, run: { color: "0563C1", underline: {} } },
    { id: STYLE.refAccessed, name: STYLE.refAccessed, run: {} },
  ];
  return {
    default: {
      // Only what the model sets is written, so a reopen reads back exactly
      // the model's styles and Word's defaults fill the rest.
      document: {
        run: {
          ...(bodyFont ? { font: bodyFont } : {}),
          ...(baseSizePt ? { size: Math.round(baseSizePt * 2) } : {}),
          ...(model.metadata.language ? { language: { value: model.metadata.language } } : {}),
        },
      },
      title: {
        run: { size: Math.round(base * 4.4), ...(headingFont ? { font: headingFont } : {}) },
        paragraph: { spacing: { after: 240 } },
      },
      heading1: heading(base * 1.8),
      heading2: heading(base * 1.45),
      heading3: heading(base * 1.2),
      heading4: heading(base * 1.05),
    },
    paragraphStyles,
    characterStyles,
  };
}

function numberingConfig() {
  const indent = (level: number) => ({ paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } });
  return {
    config: [
      {
        reference: NUMBERING.bullet,
        levels: ["•", "◦", "▪"].map((text, level) => ({
          level,
          format: LevelFormat.BULLET,
          text,
          alignment: AlignmentType.LEFT,
          style: indent(level),
        })),
      },
      {
        reference: NUMBERING.ordered,
        levels: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN].map((format, level) => ({
          level,
          format,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: indent(level),
        })),
      },
      {
        reference: NUMBERING.refs,
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "[%1]", alignment: AlignmentType.START, style: indent(0) },
        ],
      },
    ],
  };
}

function referenceParagraph(source: Source): Paragraph {
  const children: ParagraphChild[] = [new TextRun({ text: source.title, style: STYLE.refTitle })];
  if (source.publisher) children.push(new TextRun(". "), new TextRun({ text: source.publisher, style: STYLE.refPublisher }));
  if (source.url) {
    children.push(
      new TextRun(". "),
      new ExternalHyperlink({ link: source.url, children: [new TextRun({ text: source.url, style: STYLE.refUrl })] })
    );
  }
  if (source.accessed) children.push(new TextRun(". Accessed "), new TextRun({ text: source.accessed, style: STYLE.refAccessed }));
  return new Paragraph({ style: STYLE.reference, numbering: { reference: NUMBERING.refs, level: 0 }, children });
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "A"
  );
}

/** Word's paraId for comment `id`: the same formula `docx` uses for threaded comments. */
function commentParaId(id: number): string {
  return (id + 1).toString(16).toUpperCase().padStart(8, "0");
}

export async function exportDocumentDocx(input: DocumentModel): Promise<Buffer> {
  const model = normalizeDocument(input);
  let revisionId = 0;
  let listInstance = 0;
  const ctx: ExportContext = {
    sourceNumber: new Map(model.sources.map((source, index) => [source.id, index + 1])),
    nextRevisionId: () => ++revisionId,
    listInstance: () => listInstance++,
  };

  const commentNumber = new Map<string, number>(model.comments.map((comment, index) => [comment.id, index]));
  const commentsByBlock = new Map<string, number[]>();
  for (const comment of model.comments) {
    const list = commentsByBlock.get(comment.blockId) ?? [];
    list.push(commentNumber.get(comment.id)!);
    commentsByBlock.set(comment.blockId, list);
  }
  const pending = model.revisions.filter((revision) => revision.status === "pending");

  const children: (Paragraph | Table)[] = [];
  const first = model.blocks[0];
  if (!(first?.type === "heading" && first.level === 1)) {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(model.title)] }));
  }

  for (const block of model.blocks) {
    const rewrite = pending.find((revision) => revision.blockId === block.id && revision.kind !== "insert");
    children.push(...blockElements(block, commentsByBlock.get(block.id) ?? [], rewrite, ctx));
    for (const insert of pending.filter((revision) => revision.blockId === block.id && revision.kind === "insert")) {
      const stamp = stampFor(insert, "ins", ctx);
      children.push(
        new Paragraph({
          children: inlineChildren(insert.text, ctx, { stamp }),
          run: { insertion: { id: ctx.nextRevisionId(), author: stamp.author, date: stamp.date } },
        })
      );
    }
  }

  if (model.sources.length > 0) {
    children.push(new Paragraph({ style: STYLE.referencesHeading, children: [new TextRun("References")] }));
    children.push(...model.sources.map(referenceParagraph));
  }
  if (children.length === 0) children.push(new Paragraph({ children: [] }));

  const doc = new Document({
    title: model.title,
    ...(model.metadata.subject ? { subject: model.metadata.subject } : {}),
    ...(model.metadata.author ? { creator: model.metadata.author, lastModifiedBy: model.metadata.author } : {}),
    ...(model.metadata.description ? { description: model.metadata.description } : {}),
    ...(model.metadata.keywords?.length ? { keywords: model.metadata.keywords.join(", ") } : {}),
    styles: documentStyles(model),
    numbering: numberingConfig(),
    comments: {
      children: model.comments.map((comment) => ({
        id: commentNumber.get(comment.id)!,
        author: comment.author,
        initials: initials(comment.author),
        date: new Date(comment.createdAt),
        children: [
          ...(comment.quote ? [new Paragraph({ style: STYLE.commentQuote, children: [new TextRun(comment.quote)] })] : []),
          ...comment.text.split("\n").map((line) => new Paragraph({ children: [new TextRun(line)] })),
        ],
      })),
    },
    sections: [{ children }],
  });

  let buffer: Buffer;
  try {
    buffer = await Packer.toBuffer(doc);
  } catch (err) {
    throw new Error(`Could not build the .docx: ${err instanceof Error ? err.message : String(err)}`);
  }
  return model.comments.some((comment) => comment.resolved) ? addResolvedState(buffer, model.comments) : buffer;
}

/**
 * Writes the resolved state Word keeps in `word/commentsExtended.xml`: each
 * comment's last paragraph gets a `w14:paraId`, and a `w15:commentEx` entry
 * with that id says `w15:done="1"` for a resolved one.
 */
async function addResolvedState(buffer: Buffer, comments: Comment[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  if (zip.file("word/commentsExtended.xml")) return buffer;
  const commentsPart = zip.file("word/comments.xml");
  if (!commentsPart) return buffer;
  let xml = await commentsPart.async("string");
  xml = xml.replace(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g, (whole, attrs: string, body: string) => {
    const id = /w:id="(\d+)"/.exec(attrs)?.[1];
    if (id === undefined) return whole;
    const lastP = body.lastIndexOf("<w:p>") >= body.lastIndexOf("<w:p ") ? body.lastIndexOf("<w:p>") : body.lastIndexOf("<w:p ");
    if (lastP === -1) return whole;
    const paraId = commentParaId(Number(id));
    const tagged = `${body.slice(0, lastP)}<w:p w14:paraId="${paraId}" w14:textId="${paraId}"${body.slice(lastP + 4)}`;
    return `<w:comment${attrs}>${tagged}</w:comment>`;
  });
  zip.file("word/comments.xml", xml);

  const entries = comments
    .map((comment, index) => `<w15:commentEx w15:paraId="${commentParaId(index)}" w15:done="${comment.resolved ? 1 : 0}"/>`)
    .join("");
  zip.file(
    "word/commentsExtended.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w15:commentsEx xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
      `xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" mc:Ignorable="w15">${entries}</w15:commentsEx>`
  );

  const typesPart = zip.file("[Content_Types].xml");
  if (typesPart) {
    const types = await typesPart.async("string");
    zip.file(
      "[Content_Types].xml",
      types.replace(
        "</Types>",
        `<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/></Types>`
      )
    );
  }
  const relsPart = zip.file("word/_rels/document.xml.rels");
  if (relsPart) {
    const rels = await relsPart.async("string");
    zip.file(
      "word/_rels/document.xml.rels",
      rels.replace(
        "</Relationships>",
        `<Relationship Id="rIdAlevrCommentsEx" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/></Relationships>`
      )
    );
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ---------------------------------------------------------------------------
// A small XML reader
// ---------------------------------------------------------------------------

/**
 * Enough XML for OOXML parts: elements, attributes, text, CDATA, comments and
 * processing instructions. A DOCTYPE is refused (no entity expansion, so no
 * billion-laughs), only the five predefined and numeric entities are decoded,
 * and depth and node counts are bounded.
 */
interface XmlElement {
  name: string;
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
type XmlNode = XmlElement | string;

const MAX_XML_DEPTH = 256;
const MAX_XML_NODES = 2_000_000;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
    }
  });
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function parseXml(xml: string, part: string): XmlElement {
  const unreadable = (why: string): never => {
    throw new SemanticError("unreadable", `${part} is not readable XML (${why}).`);
  };
  const root: XmlElement = { name: "#root", local: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let nodes = 0;
  let i = 0;
  const attrPattern = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      const tail = xml.slice(i);
      if (tail.trim()) stack[stack.length - 1].children.push(decodeEntities(tail));
      break;
    }
    if (lt > i) stack[stack.length - 1].children.push(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt);
      if (end === -1) unreadable("unterminated declaration");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt);
      if (end === -1) unreadable("unterminated comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      if (end === -1) unreadable("unterminated CDATA");
      stack[stack.length - 1].children.push(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt)) unreadable("document type declarations are not accepted");
    if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt);
      if (end === -1) unreadable("unterminated end tag");
      const name = xml.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open === root || open.name !== name) unreadable(`mismatched </${name}>`);
      i = end + 1;
      continue;
    }
    let j = lt + 1;
    while (j < xml.length && !/[\s/>]/.test(xml[j])) j++;
    const name = xml.slice(lt + 1, j);
    if (!name) unreadable("empty tag name");
    const attrs: Record<string, string> = {};
    attrPattern.lastIndex = j;
    let match: RegExpExecArray | null;
    while ((match = attrPattern.exec(xml)) !== null) {
      attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
      j = attrPattern.lastIndex;
    }
    while (j < xml.length && /\s/.test(xml[j])) j++;
    const selfClosing = xml[j] === "/";
    if (selfClosing) j++;
    if (xml[j] !== ">") unreadable(`malformed <${name}>`);
    const element: XmlElement = { name, local: localName(name), attrs, children: [] };
    if (++nodes > MAX_XML_NODES) throw new SemanticError("too_large", `${part} has too many XML elements.`);
    stack[stack.length - 1].children.push(element);
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > MAX_XML_DEPTH) unreadable("nested too deeply");
    }
    i = j + 1;
  }
  if (stack.length !== 1) unreadable("unclosed elements");
  const top = root.children.find((child): child is XmlElement => typeof child !== "string");
  if (!top) unreadable("no root element");
  return top as XmlElement;
}

function elements(node: XmlElement): XmlElement[] {
  return node.children.filter((child): child is XmlElement => typeof child !== "string");
}

function child(node: XmlElement | undefined, local: string): XmlElement | undefined {
  return node ? elements(node).find((entry) => entry.local === local) : undefined;
}

function childrenNamed(node: XmlElement | undefined, local: string): XmlElement[] {
  return node ? elements(node).filter((entry) => entry.local === local) : [];
}

function descendant(node: XmlElement, local: string): XmlElement | undefined {
  for (const entry of elements(node)) {
    if (entry.local === local) return entry;
    const found = descendant(entry, local);
    if (found) return found;
  }
  return undefined;
}

/** An attribute by local name (`w:val` -> `val`), or by its full name when one is given with a prefix. */
function attr(node: XmlElement | undefined, name: string): string | undefined {
  if (!node) return undefined;
  if (name.includes(":")) return node.attrs[name];
  for (const [key, value] of Object.entries(node.attrs)) if (localName(key) === name) return value;
  return undefined;
}

function textOf(node: XmlElement): string {
  return node.children.map((entry) => (typeof entry === "string" ? entry : textOf(entry))).join("");
}

/** `<w:b/>` and `<w:b w:val="true"/>` are on; `w:val="0"`/`false`/`off` is off. */
function isOn(node: XmlElement | undefined): boolean {
  if (!node) return false;
  const value = attr(node, "val");
  return value === undefined || !["0", "false", "off"].includes(value.toLowerCase());
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

const MAX_DOCX_BYTES = 50 * 1024 * 1024;
const MAX_PART_CHARS = 60 * 1024 * 1024;

interface RevMark {
  kind: "ins" | "del";
  author: string;
  date: string;
}

interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
  citeNumber?: number;
  rev?: RevMark;
  role?: string;
}

interface Drawing {
  alt: string;
  src: string | null;
  widthEmu?: number;
}

interface ParagraphInfo {
  styleKey: string;
  numId?: string;
  ilvl: number;
  segments: Segment[];
  pageBreak: boolean;
  drawings: Drawing[];
  commentIds: string[];
  markIns?: RevMark;
  markDel?: RevMark;
}

interface Relationship {
  target: string;
  external: boolean;
}

interface ReadContext {
  zip: JSZip;
  rels: Map<string, Relationship>;
  styleKeys: Map<string, string>;
  media: Map<string, string>;
}

function styleKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

async function readPart(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;
  const text = await file.async("string");
  if (text.length > MAX_PART_CHARS) throw new SemanticError("too_large", `${path} is too large to read.`);
  return text;
}

function revMark(node: XmlElement, kind: "ins" | "del"): RevMark {
  const date = attr(node, "date");
  return {
    kind,
    author: attr(node, "author")?.trim() || "Reviewer",
    date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : new Date(0).toISOString(),
  };
}

function readDrawing(node: XmlElement, ctx: ReadContext): Drawing {
  const docPr = descendant(node, "docPr");
  const extent = descendant(node, "extent");
  const blip = descendant(node, "blip");
  const embed = blip ? (attr(blip, "r:embed") ?? attr(blip, "embed")) : undefined;
  const cx = extent ? Number(attr(extent, "cx")) : NaN;
  return {
    alt: (attr(docPr, "descr") || attr(docPr, "title") || attr(docPr, "name") || "Image").trim(),
    src: embed ? (ctx.media.get(embed) ?? null) : null,
    ...(Number.isFinite(cx) ? { widthEmu: cx } : {}),
  };
}

function readParagraph(p: XmlElement, ctx: ReadContext): ParagraphInfo {
  const info: ParagraphInfo = { styleKey: "", ilvl: 0, segments: [], pageBreak: false, drawings: [], commentIds: [] };
  const pPr = child(p, "pPr");
  if (pPr) {
    const styleId = attr(child(pPr, "pStyle"), "val");
    if (styleId) info.styleKey = ctx.styleKeys.get(styleId) ?? styleKey(styleId);
    const numPr = child(pPr, "numPr");
    if (numPr) {
      info.numId = attr(child(numPr, "numId"), "val");
      info.ilvl = Number(attr(child(numPr, "ilvl"), "val") ?? 0) || 0;
    }
    const rPr = child(pPr, "rPr");
    const ins = child(rPr, "ins");
    const del = child(rPr, "del");
    if (ins) info.markIns = revMark(ins, "ins");
    if (del) info.markDel = revMark(del, "del");
  }

  const walk = (node: XmlElement, link: string | undefined, rev: RevMark | undefined): void => {
    for (const entry of elements(node)) {
      switch (entry.local) {
        case "pPr":
          break;
        case "r":
          readRun(entry, link, rev);
          break;
        case "hyperlink": {
          const id = attr(entry, "r:id") ?? attr(entry, "id");
          const rel = id ? ctx.rels.get(id) : undefined;
          walk(entry, rel?.external ? rel.target : link, rev);
          break;
        }
        case "ins":
        case "moveTo":
          walk(entry, link, revMark(entry, "ins"));
          break;
        case "del":
        case "moveFrom":
          walk(entry, link, revMark(entry, "del"));
          break;
        case "commentRangeStart": {
          const id = attr(entry, "id");
          if (id !== undefined) info.commentIds.push(id);
          break;
        }
        case "smartTag":
        case "customXml":
        case "fldSimple":
        case "sdtContent":
          walk(entry, link, rev);
          break;
        case "sdt":
          walk(child(entry, "sdtContent") ?? entry, link, rev);
          break;
        default:
          break;
      }
    }
  };

  const readRun = (run: XmlElement, link: string | undefined, rev: RevMark | undefined): void => {
    const rPr = child(run, "rPr");
    const styleId = attr(child(rPr, "rStyle"), "val");
    const rStyle = styleId ? (ctx.styleKeys.get(styleId) ?? styleKey(styleId)) : "";
    const font = attr(child(rPr, "rFonts"), "ascii")?.toLowerCase();
    const base: Segment = { text: "" };
    if (isOn(child(rPr, "b"))) base.bold = true;
    if (isOn(child(rPr, "i"))) base.italic = true;
    if (rStyle === styleKey(STYLE.inlineCode) || (font && MONO_FONTS.has(font))) base.code = true;
    if (link) base.link = link;
    if (rev) base.rev = rev;
    if (rStyle) base.role = rStyle;
    const firstSegment = info.segments.length;
    for (const entry of elements(run)) {
      switch (entry.local) {
        case "t":
        case "delText":
          info.segments.push({ ...base, text: textOf(entry) });
          break;
        case "br":
        case "cr":
          if (attr(entry, "type") === "page") info.pageBreak = true;
          else info.segments.push({ ...base, text: "\n" });
          break;
        case "tab":
          info.segments.push({ ...base, text: "\t" });
          break;
        case "noBreakHyphen":
          info.segments.push({ ...base, text: "-" });
          break;
        case "drawing":
          info.drawings.push(readDrawing(entry, ctx));
          break;
        default:
          break;
      }
    }
    if (rStyle === styleKey(STYLE.citation)) {
      for (const segment of info.segments.slice(firstSegment)) {
        const number = /^\[(\d{1,4})\]$/.exec(segment.text.trim());
        if (number) segment.citeNumber = Number(number[1]);
      }
    }
  };

  walk(p, undefined, undefined);
  return info;
}

function segmentsToMarkup(segments: Segment[], sourceIds: string[]): string {
  const runs: InlineRun[] = segments.map((segment) => {
    if (segment.citeNumber !== undefined && sourceIds[segment.citeNumber - 1]) {
      const id = sourceIds[segment.citeNumber - 1];
      return { text: id, cite: id };
    }
    const run: InlineRun = { text: segment.text };
    if (segment.bold) run.bold = true;
    if (segment.italic) run.italic = true;
    if (segment.code) run.code = true;
    if (segment.link) run.link = segment.link;
    return run;
  });
  return runsToMarkup(runs);
}

function plain(segments: Segment[]): string {
  return segments.map((segment) => segment.text).join("");
}

function mimeFor(path: string): string | null {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return null;
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/");
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

async function readRelationships(zip: JSZip): Promise<{ rels: Map<string, Relationship>; media: Map<string, string> }> {
  const rels = new Map<string, Relationship>();
  const media = new Map<string, string>();
  const xml = await readPart(zip, "word/_rels/document.xml.rels");
  if (!xml) return { rels, media };
  const root = parseXml(xml, "word/_rels/document.xml.rels");
  for (const rel of childrenNamed(root, "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) continue;
    const external = attr(rel, "TargetMode") === "External";
    rels.set(id, { target, external });
    if (!external && /\/image$/.test(attr(rel, "Type") ?? "")) {
      const path = resolveTarget("word", target);
      const mime = mimeFor(path);
      const file = zip.file(path);
      if (mime && file) {
        const bytes = await file.async("nodebuffer");
        media.set(id, `data:${mime};base64,${bytes.toString("base64")}`);
      }
    }
  }
  return { rels, media };
}

async function readStyleKeys(zip: JSZip): Promise<{ keys: Map<string, string>; styles: DocumentModel["styles"]; language?: string }> {
  const keys = new Map<string, string>();
  const styles: Record<string, unknown> = {};
  let language: string | undefined;
  const xml = await readPart(zip, "word/styles.xml");
  if (!xml) return { keys, styles };
  const root = parseXml(xml, "word/styles.xml");
  for (const style of childrenNamed(root, "style")) {
    const id = attr(style, "styleId");
    if (!id) continue;
    // Our own ids win; a localized Word ("Überschrift 1") is matched by its English built-in name.
    const name = attr(child(style, "name"), "val");
    const own = styleKey(id);
    const known = /^(heading[1-9]|title|caption|quote|intensequote|lead|callout(note|tip|warning)|figure|table(header|spacer)|referencesheading|reference|commentquote|inlinecode|citation|callouttitle|ref(title|publisher|url|accessed))$/;
    keys.set(id, known.test(own) || !name ? own : styleKey(name));
    if (id === "Heading1") {
      const rPr = child(style, "rPr");
      const font = attr(child(rPr, "rFonts"), "ascii");
      const color = attr(child(rPr, "color"), "val");
      if (font) styles.headingFont = font;
      if (color && /^[0-9a-fA-F]{6}$/.test(color)) styles.accent = `#${color.toLowerCase()}`;
    }
  }
  const rPr = child(child(child(root, "docDefaults"), "rPrDefault"), "rPr");
  const bodyFont = attr(child(rPr, "rFonts"), "ascii");
  const size = Number(attr(child(rPr, "sz"), "val"));
  const lang = attr(child(rPr, "lang"), "val");
  if (bodyFont) styles.bodyFont = bodyFont;
  if (Number.isFinite(size) && size / 2 >= 9 && size / 2 <= 16) styles.baseSizePt = size / 2;
  if (lang) language = lang;
  return { keys, styles: styles as DocumentModel["styles"], ...(language ? { language } : {}) };
}

async function readNumbering(zip: JSZip): Promise<Map<string, (level: number) => boolean>> {
  const ordered = new Map<string, (level: number) => boolean>();
  const xml = await readPart(zip, "word/numbering.xml");
  if (!xml) return ordered;
  const root = parseXml(xml, "word/numbering.xml");
  const abstract = new Map<string, Map<number, string>>();
  for (const entry of childrenNamed(root, "abstractNum")) {
    const formats = new Map<number, string>();
    for (const lvl of childrenNamed(entry, "lvl")) {
      formats.set(Number(attr(lvl, "ilvl") ?? 0), attr(child(lvl, "numFmt"), "val") ?? "decimal");
    }
    abstract.set(attr(entry, "abstractNumId") ?? "", formats);
  }
  for (const num of childrenNamed(root, "num")) {
    const formats = abstract.get(attr(child(num, "abstractNumId"), "val") ?? "");
    const id = attr(num, "numId");
    if (!id || !formats) continue;
    ordered.set(id, (level) => (formats.get(level) ?? formats.get(0) ?? "decimal") !== "bullet");
  }
  return ordered;
}

async function readCore(zip: JSZip): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const xml = await readPart(zip, "docProps/core.xml");
  if (!xml) return out;
  const root = parseXml(xml, "docProps/core.xml");
  for (const entry of elements(root)) {
    const value = textOf(entry).trim();
    if (value) out[entry.local] = value;
  }
  return out;
}

interface RawComment {
  id: string;
  author: string;
  date: string;
  text: string;
  quote?: string;
  resolved: boolean;
}

async function readComments(zip: JSZip): Promise<RawComment[]> {
  const xml = await readPart(zip, "word/comments.xml");
  if (!xml) return [];
  const done = new Set<string>();
  const extended = await readPart(zip, "word/commentsExtended.xml");
  if (extended) {
    for (const entry of childrenNamed(parseXml(extended, "word/commentsExtended.xml"), "commentEx")) {
      const paraId = attr(entry, "paraId");
      if (paraId && isOn({ ...entry, attrs: { val: attr(entry, "done") ?? "0" } })) done.add(paraId.toUpperCase());
    }
  }
  const out: RawComment[] = [];
  for (const comment of childrenNamed(parseXml(xml, "word/comments.xml"), "comment")) {
    const paragraphs = childrenNamed(comment, "p");
    let quote: string | undefined;
    const lines: string[] = [];
    for (const p of paragraphs) {
      const style = attr(child(child(p, "pPr"), "pStyle"), "val");
      const text = elements(p)
        .filter((entry) => entry.local === "r")
        .flatMap((run) => elements(run).filter((entry) => entry.local === "t").map(textOf))
        .join("");
      if (style && styleKey(style) === styleKey(STYLE.commentQuote)) quote = text;
      else lines.push(text);
    }
    const last = paragraphs[paragraphs.length - 1];
    const paraId = last ? attr(last, "w14:paraId") ?? attr(last, "paraId") : undefined;
    const date = attr(comment, "date");
    out.push({
      id: attr(comment, "id") ?? "",
      author: attr(comment, "author")?.trim() || "Reviewer",
      date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : new Date(0).toISOString(),
      text: lines.join("\n").trim(),
      ...(quote ? { quote } : {}),
      resolved: paraId ? done.has(paraId.toUpperCase()) : false,
    });
  }
  return out;
}

/** Body children in reading order, content controls opened up. */
function bodyElements(body: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const entry of elements(body)) {
    if (entry.local === "p" || entry.local === "tbl") out.push(entry);
    else if (entry.local === "sdt") out.push(...bodyElements(child(entry, "sdtContent") ?? entry));
    else if (entry.local === "customXml") out.push(...bodyElements(entry));
  }
  return out;
}

const BLOCK_LIMITS = { tableRows: 200, tableColumns: 20 };

/**
 * A .docx -> the semantic model. Reads files this module wrote exactly (see the
 * header for what ids and history it cannot restore) and reads Word files from
 * elsewhere as well as their styles allow: Heading 1–4 (5–6 fold into 4),
 * Quote, Caption, numbered and bulleted lists, tables (first row as header,
 * short rows padded because a merged cell is not a lost value), images,
 * comments and tracked changes.
 */
export async function readDocumentDocx(bytes: Buffer): Promise<DocumentModel> {
  if (bytes.length > MAX_DOCX_BYTES) throw new SemanticError("too_large", "The .docx is larger than 50 MB.");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new SemanticError("unreadable", "The file is not a .docx (it is not a zip package).");
  }
  const documentXml = await readPart(zip, "word/document.xml");
  if (!documentXml) throw new SemanticError("unreadable", "The file has no word/document.xml, so it is not a Word document.");

  const [{ rels, media }, styleInfo, numbering, core, rawComments] = await Promise.all([
    readRelationships(zip),
    readStyleKeys(zip),
    readNumbering(zip),
    readCore(zip),
    readComments(zip),
  ]);
  const ctx: ReadContext = { zip, rels, styleKeys: styleInfo.keys, media };

  const documentRoot = parseXml(documentXml, "word/document.xml");
  const body = child(documentRoot, "body");
  if (!body) throw new SemanticError("unreadable", "word/document.xml has no body.");
  const items = bodyElements(body).map((element) =>
    element.local === "p" ? { element, info: readParagraph(element, ctx) } : { element, info: null }
  );

  const KEY = {
    referencesHeading: styleKey(STYLE.referencesHeading),
    reference: styleKey(STYLE.reference),
    tableSpacer: styleKey(STYLE.tableSpacer),
    caption: styleKey(STYLE.caption),
    figure: styleKey(STYLE.figure),
    lead: styleKey(STYLE.lead),
    calloutTitle: styleKey(STYLE.calloutTitle),
  };

  // Pass 1: the References section this writer appends, so citations map back.
  const sources: Source[] = [];
  for (const item of items) {
    if (!item.info || item.info.styleKey !== KEY.reference) continue;
    const segments = item.info.segments;
    const byRole = (role: string) =>
      segments
        .filter((segment) => segment.role === styleKey(role))
        .map((segment) => segment.text)
        .join("")
        .trim();
    const title = byRole(STYLE.refTitle) || plain(segments).trim();
    if (!title) continue;
    const urlSegment = segments.find((segment) => segment.role === styleKey(STYLE.refUrl));
    const url = urlSegment?.link ?? (byRole(STYLE.refUrl) || undefined);
    const publisher = byRole(STYLE.refPublisher);
    const accessed = byRole(STYLE.refAccessed);
    sources.push({
      id: `src${sources.length + 1}`,
      title: title.slice(0, 500),
      ...(url && /^https?:\/\//i.test(url) ? { url } : {}),
      ...(publisher ? { publisher } : {}),
      ...(accessed ? { accessed } : {}),
    });
  }
  const sourceIds = sources.map((source) => source.id);
  const markup = (segments: Segment[]) => segmentsToMarkup(segments, sourceIds);

  // Pass 2: blocks, comment anchors and pending tracked changes.
  type DraftBlock = Record<string, unknown> & { id: string; type: Block["type"] };
  const blocks: DraftBlock[] = [];
  const revisions: Array<Omit<Revision, "id">> = [];
  const commentAnchor = new Map<string, string>();
  let titleText: string | undefined;

  const newBlock = (block: Omit<DraftBlock, "id">): DraftBlock => {
    const full = { ...block, id: `b${blocks.length + 1}` } as DraftBlock;
    blocks.push(full);
    return full;
  };
  const anchor = (ids: string[], blockId: string | undefined) => {
    if (!blockId) return;
    for (const id of ids) if (!commentAnchor.has(id)) commentAnchor.set(id, blockId);
  };
  const lastBlockId = () => blocks[blocks.length - 1]?.id;
  const captionAt = (index: number): string | undefined => {
    const next = items[index];
    return next?.info && next.info.styleKey === KEY.caption ? markup(next.info.segments).trim() || undefined : undefined;
  };

  /** Splits a text block's segments into its current text and a pending rewrite, Word-style. */
  const textWithRewrite = (segments: Segment[], blockId: string) => {
    const before = segments.filter((segment) => segment.rev?.kind !== "ins");
    const after = segments.filter((segment) => segment.rev?.kind !== "del");
    const marked = segments.find((segment) => segment.rev);
    if (marked?.rev) {
      const afterText = markup(after);
      revisions.push({
        blockId,
        kind: afterText.trim() === "" ? "delete" : "replace",
        text: afterText.trim() === "" ? "" : afterText,
        author: marked.rev.author,
        createdAt: marked.rev.date,
        status: "pending",
      });
    }
    return markup(before);
  };

  for (let index = 0; index < items.length; index++) {
    const { element, info } = items[index];

    if (!info) {
      const rows = childrenNamed(element, "tr");
      if (rows.length === 0) continue;
      const commentIds: string[] = [];
      const grid = rows.map((row) =>
        childrenNamed(row, "tc").flatMap((cell) => {
          const paragraphs = childrenNamed(cell, "p").map((p) => readParagraph(p, ctx));
          paragraphs.forEach((paragraph) => commentIds.push(...paragraph.commentIds));
          const text = paragraphs
            .map((paragraph) => markup(paragraph.segments.filter((segment) => segment.rev?.kind !== "ins")))
            .join("\n");
          const span = Number(attr(child(child(cell, "tcPr"), "gridSpan"), "val") ?? 1);
          return [text, ...Array.from({ length: Math.max(0, Math.min(span, 20) - 1) }, () => "")];
        })
      );
      const width = Math.max(...grid.map((row) => row.length));
      if (width > BLOCK_LIMITS.tableColumns || grid.length - 1 > BLOCK_LIMITS.tableRows) {
        throw new SemanticError(
          "too_large",
          `A table in this file has ${width} columns and ${grid.length - 1} rows; a document table holds at most ` +
            `${BLOCK_LIMITS.tableColumns} columns and ${BLOCK_LIMITS.tableRows} rows. Import it as a spreadsheet instead.`
        );
      }
      const pad = (row: string[]) => [...row, ...Array.from({ length: width - row.length }, () => "")];
      const caption = captionAt(index + 1);
      const block = newBlock({
        type: "table",
        header: pad(grid[0]),
        rows: grid.slice(1).map(pad),
        ...(caption ? { caption: caption.slice(0, 300) } : {}),
      });
      anchor(commentIds, block.id);
      const next = items[index + 1]?.info;
      if (caption || next?.styleKey === KEY.tableSpacer) index++;
      continue;
    }

    const key = info.styleKey;
    const text = plain(info.segments);
    if (key === KEY.referencesHeading || key === KEY.reference || key === KEY.tableSpacer) continue;
    if (key === "title" && blocks.length === 0) {
      titleText = text.trim() || titleText;
      continue;
    }

    // A whole paragraph suggested as an insertion is a pending insert after the block before it.
    const onlyInserted = text.trim() !== "" && info.segments.every((segment) => segment.rev?.kind === "ins");
    if (onlyInserted && lastBlockId()) {
      const first = info.segments[0].rev!;
      revisions.push({
        blockId: lastBlockId()!,
        kind: "insert",
        text: markup(info.segments),
        author: info.markIns?.author ?? first.author,
        createdAt: info.markIns?.date ?? first.date,
        status: "pending",
      });
      anchor(info.commentIds, lastBlockId());
      continue;
    }

    if (info.drawings.length > 0 || key === KEY.figure) {
      const drawing = info.drawings[0];
      const placeholder = IMAGE_PLACEHOLDER.exec(text.trim());
      const link = info.segments.find((segment) => segment.link)?.link;
      const src = drawing?.src ?? (placeholder && link?.startsWith("https:") ? link : null);
      if (src) {
        const caption = captionAt(index + 1);
        const pct = drawing?.widthEmu ? Math.round((drawing.widthEmu / (CONTENT_WIDTH_PX * EMU_PER_PX)) * 100) : 100;
        const block = newBlock({
          type: "figure",
          src,
          alt: (drawing?.alt ?? placeholder?.[1] ?? "Image").slice(0, 500) || "Image",
          ...(caption ? { caption: caption.slice(0, 300) } : {}),
          ...(pct < 100 ? { widthPct: Math.max(10, pct) } : {}),
        });
        anchor(info.commentIds, block.id);
        if (caption) index++;
        continue;
      }
    }

    if (info.pageBreak && text.trim() === "" && info.drawings.length === 0) {
      const block = newBlock({ type: "pageBreak" });
      anchor(info.commentIds, block.id);
      continue;
    }

    const heading = /^heading([1-9])$/.exec(key);
    if (heading) {
      if (text.trim() === "") continue;
      const id = `b${blocks.length + 1}`;
      newBlock({ type: "heading", level: Math.min(4, Number(heading[1])), text: textWithRewrite(info.segments, id) });
      anchor(info.commentIds, id);
    } else if (info.numId && info.numId !== "0" && numbering.has(info.numId)) {
      const isOrdered = numbering.get(info.numId)!;
      const listItems: Array<{ text: string; level: number }> = [];
      const commentIds: string[] = [];
      let cursor = index;
      while (cursor < items.length) {
        const entry = items[cursor].info;
        if (!entry || entry.numId !== info.numId || entry.styleKey === KEY.reference) break;
        const itemText = markup(entry.segments.filter((segment) => segment.rev?.kind !== "ins"));
        if (itemText.trim() !== "") listItems.push({ text: itemText, level: Math.min(2, Math.max(0, entry.ilvl)) });
        commentIds.push(...entry.commentIds);
        cursor++;
      }
      index = cursor - 1;
      if (listItems.length === 0) continue;
      const block = newBlock({ type: "list", ordered: isOrdered(listItems[0].level), items: listItems });
      anchor(commentIds, block.id);
    } else if (key.startsWith("callout")) {
      const tone = key === "callouttip" ? "tip" : key === "calloutwarning" ? "warning" : "note";
      const titleSegments = info.segments.filter((segment) => segment.role === KEY.calloutTitle);
      const bodySegments = info.segments.filter((segment) => segment.role !== KEY.calloutTitle);
      if (titleSegments.length > 0 && bodySegments[0]?.text === "\n") bodySegments.shift();
      const id = `b${blocks.length + 1}`;
      const title = markup(titleSegments).trim();
      const bodyText = textWithRewrite(bodySegments, id);
      if (bodyText.trim() === "" && !title) continue;
      newBlock({ type: "callout", tone, ...(title ? { title: title.slice(0, 300) } : {}), text: bodyText || title });
      anchor(info.commentIds, id);
    } else {
      if (text.trim() === "" && !info.segments.some((segment) => segment.rev)) {
        if (info.pageBreak) newBlock({ type: "pageBreak" });
        continue;
      }
      const id = `b${blocks.length + 1}`;
      const style = key === KEY.lead ? "lead" : key === "quote" || key === "intensequote" ? "quote" : undefined;
      const paragraphText = textWithRewrite(info.segments, id);
      if (paragraphText.trim() === "") {
        // Text that exists only as a suggestion with nothing before it: keep it as the paragraph.
        revisions.pop();
        const after = markup(info.segments.filter((segment) => segment.rev?.kind !== "del"));
        if (after.trim() === "") continue;
        newBlock({ type: "paragraph", text: after, ...(style ? { style } : {}) });
      } else {
        newBlock({ type: "paragraph", text: paragraphText, ...(style ? { style } : {}) });
      }
      anchor(info.commentIds, id);
    }
    if (info.pageBreak) newBlock({ type: "pageBreak" });
  }

  const comments = rawComments
    .filter((comment) => comment.text !== "")
    .map((comment) => {
      const blockId = commentAnchor.get(comment.id) ?? blocks[0]?.id;
      return blockId
        ? {
            blockId,
            author: comment.author.slice(0, 120),
            text: comment.text,
            createdAt: comment.date,
            ...(comment.resolved ? { resolved: true } : {}),
            ...(comment.quote ? { quote: comment.quote.slice(0, 2_000) } : {}),
          }
        : null;
    })
    .filter((comment) => comment !== null);

  const keywords = core.keywords
    ?.split(/[,;]/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 50);
  const author = core.creator && core.creator !== "Un-named" ? core.creator : undefined;
  const language = core.language ?? styleInfo.language;
  const firstHeading = blocks.find((block) => block.type === "heading")?.text as string | undefined;
  const title = (core.title || titleText || (firstHeading ? plainTitle(firstHeading) : "") || "Untitled document").slice(0, 300);

  return normalizeDocument({
    kind: "document",
    version: 1,
    title,
    metadata: {
      ...(author ? { author } : {}),
      ...(core.subject ? { subject: core.subject } : {}),
      ...(core.description ? { description: core.description } : {}),
      ...(keywords?.length ? { keywords } : {}),
      ...(language && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language) ? { language } : {}),
    },
    styles: styleInfo.styles,
    sources,
    blocks,
    comments: comments.map((comment, index) => ({ ...comment, id: `c${index + 1}` })),
    revisions: revisions.map((revision, index) => ({ ...revision, id: `r${index + 1}` })),
  });
}

function plainTitle(markup: string): string {
  return parseInline(markup)
    .map((run) => run.text)
    .join("")
    .trim();
}
