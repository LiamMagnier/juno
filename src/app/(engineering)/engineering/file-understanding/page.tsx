import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { env } from "@/lib/env";
import {
  DataTable,
  Evidence,
  EvidenceKey,
  Keystone,
  Lede,
  Listing,
  Note,
  Quote,
  Section,
  Source,
  Stage,
  Subhead,
  type StageSpec,
} from "@/components/engineering/article";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * How Juno reads your files — the public version of docs/file-understanding.md.
 *
 * WHY THIS PAGE EXISTS. Juno rebuilt its file pipeline after it started telling
 * people “couldn’t read this file” about documents that read perfectly. The
 * rebuild was preceded by an audit of what Anthropic, OpenAI, Google and
 * Microsoft actually publish about their own pipelines, and the audit turned
 * out to be the more useful artefact: almost everything written about this
 * subject online is confident and wrong, because it repeats `PDF → text → LLM`,
 * which is not what any frontier assistant does.
 *
 * So this is published rather than filed. The house rule it follows is the one
 * `<Evidence>` enforces: a claim about somebody else’s system is either tagged
 * `published` and carries a link to the sentence it came from, or it is tagged
 * `inferred` or `not public` and says so. The self-critique in §8 and §16 is
 * first-person on purpose — an architecture note that only lists other people’s
 * mistakes is marketing.
 *
 * The long-form engineering version, with the migration plan and the internal
 * file paths, stays in docs/file-understanding.md.
 */

const PUBLISHED = "22 September 2026";

export const metadata: Metadata = {
  title: `How ${PRODUCT_NAME} reads your files`,
  description:
    `An engineering audit of how ChatGPT, Claude, Gemini and Copilot actually process uploaded documents and images — dual-channel PDF handling, vision pipelines, retrieval, citation validation — and how ${PRODUCT_NAME} is built against it. Every external claim is tagged and sourced.`,
  alternates: { canonical: "/engineering/file-understanding" },
  openGraph: {
    type: "article",
    title: `How ${PRODUCT_NAME} reads your files`,
    description:
      "What actually happens between an upload and an answer — audited against Anthropic, OpenAI, Google and Microsoft’s published documentation.",
    url: "/engineering/file-understanding",
  },
};

/** The table of contents, and the section order. One list, used twice. */
const CONTENTS: { id: string; index: string; title: string }[] = [
  { id: "model", index: "01", title: "The one-paragraph version" },
  { id: "pdf", index: "02", title: "What happens when you upload a PDF" },
  { id: "images", index: "03", title: "What happens when you upload an image" },
  { id: "formats", index: "04", title: "Formats, and what flattening destroys" },
  { id: "seeing", index: "05", title: "Reading a page versus looking at it" },
  { id: "scale", index: "06", title: "When the document is too big to send" },
  { id: "context", index: "07", title: "What “context” actually means" },
  { id: "defects", index: "08", title: "What we found wrong in our own pipeline" },
  { id: "architecture", index: "09", title: "The pipeline, stage by stage" },
  { id: "representation", index: "10", title: "A document representation worth having" },
  { id: "retrieval", index: "11", title: "Retrieval, and why vectors alone lose" },
  { id: "citations", index: "12", title: "Citations you can actually check" },
  { id: "comparison", index: "13", title: "Naïve versus strong, concretely" },
  { id: "models", index: "14", title: "Where a model earns its cost" },
  { id: "stack", index: "15", title: "The stack, with reasons" },
  { id: "juno", index: "16", title: `Where ${PRODUCT_NAME} stands today` },
  { id: "principles", index: "17", title: "Fifteen things worth remembering" },
  { id: "sources", index: "18", title: "Sources" },
];

/** The nine stages of §9, as data. */
const STAGES: StageSpec[] = [
  {
    n: 1,
    title: "Upload and validate",
    what: "Accept the bytes, enforce size and type policy, store them. Nothing is read.",
    why: "The only stage that must be synchronous, because a person is watching it.",
    timing: "Synchronous",
    fails: "Quota, oversize, a type the policy refuses.",
    recovers:
      "Rejecting with the actual type and the actual limit, not “upload failed”.",
  },
  {
    n: 2,
    title: "Type detection",
    what: "Magic bytes first, extension second, the browser’s declared type last.",
    why: "All three disagree in practice, and the declared one is the least reliable of them.",
    timing: "Synchronous",
    fails:
      "Container formats. A ZIP is a .docx, an .xlsx, an .odt, an .epub, and a folder of holiday photos.",
    recovers: "Disambiguating on the archive’s inner manifest.",
  },
  {
    n: 3,
    title: "Parse and extract structure",
    what: "A format-specific parser producing typed blocks that each know where they came from.",
    why: "This is the stage where structure is preserved or lost permanently.",
    timing: "Asynchronous",
    fails: "Encrypted files, corrupt files, exotic font encodings, XFA forms.",
    recovers:
      "The ladder — native parser, then a second parser, then OCR, then vision. No rung’s failure ends the file’s life.",
  },
  {
    n: 4,
    title: "Page rendering",
    what: "Each page to an image at roughly 150 DPI. This is the visual channel, and the thumbnail, and the OCR front end.",
    why: "Everything a text extractor throws away is still in the pixels.",
    timing: "Conditional, async",
    fails: "No rasteriser available on the platform.",
    recovers: "Degrading to text only — and saying so, rather than quietly answering anyway.",
  },
  {
    n: 5,
    title: "OCR",
    what: "Text for pages that have no text layer, with per-word confidence and boxes.",
    why: "Scans. Only scans. OCR is strictly worse than embedded text wherever embedded text exists.",
    timing: "Conditional, async",
    fails: "No OCR engine installed; genuinely bad scans.",
    recovers:
      "Falling through to the visual channel. A model that can see the page does not need OCR to answer about it.",
  },
  {
    n: 6,
    title: "Indexing",
    what: "Chunk, embed, write to the lexical and vector indexes.",
    why: "Only for documents too large to show whole, or for searching across a corpus. Never for a ten-page attachment.",
    timing: "Conditional, async",
    fails: "The embedding provider is down; the text contains bytes the datastore cannot hold.",
    recovers:
      "Retry with backoff, and degrade to lexical search rather than to nothing — BM25 works without embeddings.",
  },
  {
    n: 7,
    title: "Retrieval and rerank",
    what: "Locator filters, then BM25 and vectors in parallel, fused, then a cross-encoder over the top of the list.",
    why: "It sits in the request path, so it has a latency budget of a few hundred milliseconds.",
    timing: "Synchronous",
    fails: "Nothing relevant is found.",
    recovers:
      "Saying so explicitly. “No passage matched” has to reach the model, or it will fill the silence.",
  },
  {
    n: 8,
    title: "Context assembly",
    what: "Fit the budget: instructions, question, selected blocks with their locators, selected page images, history.",
    why: "The token budget is finite and shared. No model is involved in spending it.",
    timing: "Synchronous",
    fails: "Budget overrun.",
    recovers:
      "Dropping the lowest-ranked material first — and telling the model what was dropped. Silent truncation manufactures confident wrong answers.",
  },
  {
    n: 9,
    title: "Generation and citation validation",
    what: "Call the model, then check that every locator it cited resolves to something that was actually retrieved.",
    why: "This is the step that makes a hallucinated page number impossible to display.",
    timing: "Synchronous",
    fails: "The answer cites a page that was never in the context.",
    recovers: "Stripping or flagging the unresolvable citation before anyone reads it.",
  },
];

function structuredData(): string {
  const base = env.appUrl.replace(/\/+$/, "");
  const data = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: `How ${PRODUCT_NAME} reads your files`,
    description:
      `An engineering audit of how frontier assistants process uploaded documents and images, and how ${PRODUCT_NAME} is built against it.`,
    url: `${base}/engineering/file-understanding`,
    datePublished: "2026-09-22",
    inLanguage: "en",
    isAccessibleForFree: true,
    publisher: { "@type": "Organization", name: PRODUCT_NAME, url: base },
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function FileUnderstandingPage() {
  // The CSP is nonce-based (src/middleware.ts), so the one inline script on
  // this page has to carry the nonce or the policy drops it silently.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <>
      <script nonce={nonce} type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData() }} />

      {/* ── Masthead ──────────────────────────────────────────────────── */}
      <header className="max-w-3xl">
        <p className="font-mono text-label text-muted-foreground">
          {`${PRODUCT_NAME} engineering · `}{PUBLISHED}
        </p>
        <h1 className="mt-3 text-balance font-serif text-display font-medium tracking-tight text-foreground">
          {`How ${PRODUCT_NAME} reads your files`}
        </h1>
        <Lede>
          Almost everything written about this online repeats the same sentence: a PDF becomes text,
          the text goes to a language model. That is not what any frontier assistant does, and a
          product built that way has a ceiling it cannot engineer past. Here is what actually
          happens between an upload and an answer — audited against what Anthropic, OpenAI, Google
          and Microsoft publish, and then against our own source.
        </Lede>
        <p className="mt-4 text-body leading-relaxed text-muted-foreground">
          {`We wrote this because ${PRODUCT_NAME} got it wrong first. For a while the composer would tell people “couldn’t read this file” about documents that read perfectly well, and fixing that properly meant finding out what the systems people compare us to are really doing.`}{" "}
          <a
            href="#defects"
            className="rounded-xs underline decoration-border underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:decoration-primary focus-visible:text-primary"
          >
            Section 8
          </a>{" "}
          is the list of our own defects, with the symptom each one produced.
        </p>
        <EvidenceKey />
      </header>

      {/* ── Contents + article ────────────────────────────────────────── */}
      <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1fr)_14rem] lg:gap-12">
        <article className="min-w-0 max-w-3xl space-y-12">
          <Section {...CONTENTS[0]}>
            <Keystone>
              A modern assistant does not do PDF → text → model. It does PDF → (text layer ∥ page
              images) → model, in parallel, and the model sees both.
            </Keystone>
            <p className="text-body leading-relaxed text-muted-foreground">
              The text carries exact strings and reading order. The pixels carry layout, diagrams,
              handwriting, stamps, table rules, and everything else a text extractor throws away.
              Retrieval is a <em>scaling</em> strategy applied on top when a document is too large
              to show whole — it is not the primary way a file gets read. And the heavy lifting that
              is genuinely deterministic — parsing, decoding, rendering — stays in ordinary
              software, because a parser is cheaper, faster and more reliable than a model at work
              that has a correct answer.
            </p>
          </Section>

          {/* 02 ── PDFs */}
          <Section {...CONTENTS[1]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              Anthropic documents its PDF pipeline in two sentences that settle the central
              question, so they are worth quoting exactly rather than paraphrasing:
            </p>
            <Quote
              cite={
                <>
                  <Evidence kind="published" />
                  Anthropic,{" "}
                  <Source href="https://platform.claude.com/docs/en/build-with-claude/pdf-support">
                    PDF support — “How PDF support works”
                  </Source>
                </>
              }
            >
              “The system converts each page of the document into an image. The text from each page
              is extracted and provided alongside each page’s image.”
            </Quote>
            <p className="text-body leading-relaxed text-muted-foreground">
              Google documents the same design for Gemini — every page is rasterised to a screenshot{" "}
              <em>and</em> OCR’d, which is precisely why scanned PDFs work there without any
              preparation <Evidence kind="published" />
              <Source href="https://ai.google.dev/gemini-api/docs/document-processing">
                Gemini document processing
              </Source>
              . OpenAI’s Responses API accepts a PDF as a first-class <code>input_file</code> part
              carrying a render-quality <code>detail</code> knob, which only means something if
              pages are being rendered <Evidence kind="published" />
              <Source href="https://github.com/openai/openai-openapi">
                openai-openapi, <code>InputFileContentParam</code>
              </Source>
              .
            </p>
            <p className="mt-4 text-body leading-relaxed text-muted-foreground">
              Three vendors, three independent specifications, one shape: <strong>dual channel</strong>.
              Text and pixels, per page, together. If you remember one thing from this page, that is
              the thing.
            </p>
            <p className="mt-4 text-body leading-relaxed text-muted-foreground">
              The cost of the second channel is documented too. The visual path runs roughly{" "}
              <strong>seven times</strong> the token cost of text alone — on the order of 1,500–3,000
              text tokens per page <em>plus</em> a full image’s worth of tokens per page{" "}
              <Evidence kind="published" />
              <Source href="https://platform.claude.com/docs/en/build-with-claude/pdf-support">
                PDF support — “Estimate your costs”
              </Source>
              . Bedrock exposes both modes side by side so a caller can choose, which is the
              clearest public evidence that these are two genuinely different architectures rather
              than one pipeline with a flag.
            </p>

            <Subhead>The walkthrough</Subhead>
            <p className="text-body leading-relaxed text-muted-foreground">
              A 42-page PDF is uploaded, and the question is{" "}
              <em>“what does page 37 say about the database architecture?”</em>
            </p>
            <DataTable
              columns={["Stage", "What happens", "Who does it"]}
              rows={[
                [
                  "Upload and store",
                  "Bytes to object storage. An id, a name, a size, a checksum. Nothing is read.",
                  "Deterministic",
                ],
                [
                  "Type detection",
                  "Magic bytes — not the extension, and not the browser’s declared Content-Type.",
                  "Deterministic",
                ],
                [
                  "Parse",
                  "Object graph, page tree, content streams. Yields page count, geometry, embedded fonts, text-show operators.",
                  "Deterministic",
                ],
                [
                  "Text extraction",
                  "Text runs with x/y positions and font metrics. Reading order is reconstructed from geometry — it is not stored in the file.",
                  "Deterministic",
                ],
                [
                  "Layout analysis",
                  "Runs into lines by baseline, lines into paragraphs by gap; columns, tables, headers and footers detected.",
                  "Deterministic, sometimes ML",
                ],
                ["Page rendering", "Each page to an image at roughly 150 DPI. The second channel.", "Deterministic"],
                [
                  "OCR",
                  "Only for pages with no text layer. A fallback, never the default.",
                  "Specialised ML",
                ],
                [
                  "Structural extraction",
                  "Blocks — heading, paragraph, list item, table, code, caption, image — each with a page number and a bounding box.",
                  "Deterministic + ML",
                ],
                [
                  "Indexing",
                  "Only when the document is too large to show whole, or when searching across documents.",
                  "ML",
                ],
                [
                  "Context construction",
                  "For “page 37” this is a metadata filter, not a semantic search. Page 37’s blocks and page 37’s image go in the prompt.",
                  "Deterministic",
                ],
                ["Generation", "The model reads text and pixels together and answers, citing the page.", "Model"],
              ]}
              caption="Note where the intelligence sits: one row out of eleven is the model. The rest is engineering."
            />

            <Subhead>So is it PDF → text → model?</Subhead>
            <p className="text-body leading-relaxed text-muted-foreground">
              No — and the failure of a system built that way is not subtle. A scanned page yields
              the empty string. A diagram yields its labels with the arrows removed. A two-column
              paper yields two columns interleaved line by line. Microsoft Copilot is the public
              cautionary case: a text-extraction pipeline with a character ceiling that fails
              outright on image-only PDFs <Evidence kind="published" />
              <Source href="https://learn.microsoft.com/en-us/microsoft-copilot-studio/nlu-documents">
                Copilot Studio document handling
              </Source>
              .
            </p>

            <Note title="What is not public">
              <p>
                <Evidence kind="unknown" />
                The exact rasterisation DPI, the internal chunker, whether retrieval runs at all for
                consumer uploads and above what size, the reranker, and the prompt scaffolding.
                Vendors publish the interface and the limits, not the pipeline. Anyone who tells you
                Claude’s chunk size is quoting something they do not have.
              </p>
            </Note>
          </Section>

          {/* 03 ── Images */}
          <Section {...CONTENTS[2]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              An image takes a different route, and one step in it surprises almost everyone.
            </p>
            <ol className="mt-4 space-y-3 text-body leading-relaxed text-muted-foreground">
              {[
                ["Decode", "Bytes to a pixel array. The format is sniffed from magic bytes, not the file name."],
                [
                  "Resize",
                  "Providers downscale before inference. Anthropic documents a maximum of 8000×8000 px and roughly 1,590 tokens for a 1.15 megapixel image; Gemini documents 258 tokens per tile. This is why a 4 % crop of a 4000 px screenshot is useless: it is 160 px before the provider shrinks it again.",
                ],
                [
                  "Patchify",
                  "The image is cut into fixed-size patches — typically 14×14 or 16×16 pixels — each linearly projected into an embedding.",
                ],
                [
                  "Vision encoder",
                  "A ViT-family transformer processes the patch sequence. Self-attention across patches is what encodes spatial relationship: this patch is left of that one, this arrow starts here and ends there.",
                ],
                [
                  "Projection",
                  "Visual embeddings are mapped into the language model’s embedding space, becoming tokens it attends over alongside text tokens.",
                ],
                [
                  "Joint reasoning",
                  "From the model’s point of view there is one sequence. It does not call a vision module; the picture is already in its context as vectors.",
                ],
              ].map(([term, detail], i) => (
                <li key={term} className="flex gap-4">
                  <span className="mt-0.5 shrink-0 font-mono text-label text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong className="text-foreground">{term}</strong> — {detail}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-5 text-body leading-relaxed text-muted-foreground">
              <Evidence kind="published" />
              The token arithmetic is documented —{" "}
              <Source href="https://platform.claude.com/docs/en/build-with-claude/vision">Anthropic vision</Source>{" "}
              and <Source href="https://ai.google.dev/gemini-api/docs/document-processing">Gemini</Source>.{" "}
              <Evidence kind="inferred" />
              Steps 3 to 5 are the standard published vision-language architecture — CLIP, Flamingo,
              LLaVA, Qwen-VL — and the vendors’ token counts are consistent with fixed-size
              patching. <Evidence kind="unknown" />
              Whether the frontier models implement exactly this is not public.
            </p>

            <Subhead>Why “what button is in the top right?” works</Subhead>
            <p className="text-body leading-relaxed text-muted-foreground">
              Because position survives. Patches enter the sequence with positional encodings, so
              “top right” is recoverable from the representation. OCR would have returned the
              button’s label and thrown away where it was.
            </p>

            <Subhead>Four things that get conflated</Subhead>
            <DataTable
              columns={["", "What it does", "What it cannot do"]}
              rows={[
                ["OCR", "Image to characters, with boxes", "Say what anything means, or read a diagram’s arrows"],
                ["Classical CV", "Detect and segment known object classes", "Generalise past its label set, or explain"],
                ["Vision encoder", "Encode an image into a shared semantic space", "Reason at length on its own"],
                ["Multimodal LLM", "Reason jointly over pixels and text", "Be as cheap or as exact as a parser"],
              ]}
            />
            <p className="text-body leading-relaxed text-muted-foreground">
              Run OCR on an architecture diagram and you get <code>Database API Frontend</code>. The
              arrows — which <em>are</em> the architecture — are not characters, so they do not
              survive. That is the whole reason the dual-channel design exists.
            </p>
          </Section>

          {/* 04 ── Formats */}
          <Section {...CONTENTS[3]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              “Convert it to text” is not a neutral operation. Every format loses something specific,
              and knowing which thing is the difference between a pipeline that degrades and one
              that lies.
            </p>
            <DataTable
              columns={["Format", "Carries", "Destroyed by flattening"]}
              rows={[
                [
                  "PDF",
                  "Pages, geometry, fonts, embedded images, annotations",
                  "Page boundaries, reading order in columns, diagrams, tables, anything scanned",
                ],
                [
                  "DOCX",
                  "Heading levels, lists, tables, links, footnotes, headers, tracked changes",
                  "Hierarchy — “Introduction” and a body sentence become indistinguishable strings. Cell relationships. Which footnote belongs where.",
                ],
                [
                  "PPTX",
                  "Slide boundaries, titles, speaker notes, z-order, images",
                  "The slide as a unit; the speaker notes, which are often the actual argument; what was a title",
                ],
                [
                  "XLSX",
                  "Sheets, cells, formulas, types, ranges, charts",
                  "Formulas — you keep the values and lose the logic. Which sheet a number came from. The header a value belongs to.",
                ],
                ["CSV", "Rows, columns, header", "Types (01234 becomes 1234), and which column is which once rows wrap"],
                ["Markdown", "Explicit structure, already text", "Very little. Markdown is the happy case."],
                [
                  "HTML",
                  "DOM, semantics, tables",
                  "Navigation and boilerplate pollute the content unless stripped — and it is an XSS vector, so it must never be served back inline",
                ],
                [
                  "Source code",
                  "Line numbers, file path, symbols",
                  "Line numbers, without which a citation cannot be checked. In Python, indentation is syntax.",
                ],
              ]}
            />
            <p className="text-body leading-relaxed text-muted-foreground">
              Vendors are explicit about the limits here. Anthropic’s document block accepts only{" "}
              <code>application/pdf</code> and <code>text/plain</code>; <code>.docx</code> and{" "}
              <code>.xlsx</code> are rejected outright and must be converted first{" "}
              <Evidence kind="published" />
              <Source href="https://platform.claude.com/docs/en/build-with-claude/files">Files API</Source>. Their own
              recommendation for a Word document containing images is to convert it to PDF and use
              the PDF path — precisely so the images survive.
            </p>
            <p className="mt-4 text-body leading-relaxed text-muted-foreground">
              Spreadsheets get a different path entirely. <Evidence kind="published" />
              <code>.xlsx</code> and <code>.csv</code> go through{" "}
              <Source href="https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool">
                code execution
              </Source>{" "}
              rather than document blocks. That is a deliberate architectural choice, and the right
              one: a spreadsheet question is usually a <em>computation</em> — “what is the Q3
              total?” — and putting 40,000 cells into a context window to make a model add them up
              is both expensive and unreliable. Run pandas instead.
            </p>
          </Section>

          {/* 05 ── Seeing */}
          <Section {...CONTENTS[4]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              Take a page containing one diagram. What the parser gets and what the model needs are
              not the same object:
            </p>
            <div className="my-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-card border border-border bg-card p-4">
                <p className="font-mono text-label text-muted-foreground">On the page</p>
                <p className="mt-3 font-mono text-ui text-foreground">
                  [database] → [API server] → [frontend]
                </p>
              </div>
              <div className="rounded-card border border-border bg-card p-4">
                <p className="font-mono text-label text-muted-foreground">After text extraction</p>
                <p className="mt-3 font-mono text-ui text-foreground">Database API Frontend</p>
              </div>
            </div>
            <p className="text-body leading-relaxed text-muted-foreground">
              Three nouns. The arrows are gone, so the direction of data flow — the entire content of
              the diagram — is gone with them. A model given only that text cannot answer “does the
              frontend talk to the database directly?”, and, worse, will usually answer anyway.
            </p>
            <p className="mt-4 text-body leading-relaxed text-muted-foreground">
              A strong system keeps both as parallel representations of the same page, joined by
              page number. A <strong>semantic layer</strong> — blocks with types, text, heading path
              and bounding boxes — is what exact quotation, search and citation run on. A{" "}
              <strong>visual layer</strong> — the rendered page — is what layout, arrows, charts,
              handwriting and stamps survive in. At answer time you send both, for the pages that
              matter.
            </p>
            <p className="mt-4 text-body leading-relaxed text-muted-foreground">
              The bounding boxes are what let you go further than “send the page”. If block seven on
              page fifteen is an image at a known rectangle, you can crop just that region and send
              it magnified — far cheaper than the whole page and far more legible than a downsampled
              one. <Evidence kind="juno" />
              {`That is what ${PRODUCT_NAME}’s image inspection tool does: a region given in percentages, cropped and scaled up to at least 768 px on its short edge before the model ever sees it.`}
            </p>
          </Section>

          {/* 06 ── Scale */}
          <Section {...CONTENTS[5]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              A 500-page PDF cannot go in every prompt. At roughly 2,000 text tokens a page that is a
              million text tokens, and with the visual channel considerably more. There are five
              honest approaches and they are not interchangeable.
            </p>
            <DataTable
              columns={["", "Approach", "Advantage", "Disadvantage", "Use when"]}
              rows={[
                [
                  "A",
                  "Everything in context",
                  "No infrastructure, no retrieval bugs, perfect recall inside the window",
                  "Cost scales with the document rather than the question; hits the window; attention degrades over very long contexts",
                  "The document fits comfortably — which today means most documents",
                ],
                [
                  "B",
                  "Chunks, embeddings, vector store",
                  "Scales to any corpus; cheap per query",
                  "Misses exact strings; chunk boundaries sever context; a retrieval miss is indistinguishable from the document not containing the answer",
                  "Large corpus, semantic questions",
                ],
                [
                  "C",
                  "Hybrid: BM25 + vectors + rerank",
                  "Catches both “about X” and “contains literally X”; the reranker fixes most ordering errors",
                  "Two indexes to keep in step; more moving parts",
                  "The production default for a corpus",
                ],
                [
                  "D",
                  "Hierarchical summaries",
                  "Handles “summarise the whole thing”; navigable; cheap at the top level",
                  "Summarisation is lossy and must be recomputed on change",
                  "Very large single documents",
                ],
                [
                  "E",
                  "Page-level multimodal embeddings",
                  "Layout and diagrams become retrievable; no parsing loss",
                  "Expensive to index; immature tooling; coarse — a page, not a sentence",
                  "Visually dense documents: slides, reports, scans",
                ],
              ]}
              align={{ nowrap: [0] }}
            />
            <Keystone>
              The common mistake is jumping straight to B for a twelve-page PDF. That is
              infrastructure solving a problem you do not have — and it loses information relative to
              simply sending the document.
            </Keystone>
            <p className="text-body leading-relaxed text-muted-foreground">
              Threshold on size instead. If it fits the window, send it whole. If it does not, use
              hybrid retrieval over blocks with page and section filters, and rerank. If the question
              is “summarise this 500-page report”, retrieval cannot answer it at all — the answer{" "}
              <em>is</em> the whole document — so that is where hierarchical summaries earn their
              keep. Add page-image retrieval only when the documents are visually dense enough to
              need it.
            </p>
          </Section>

          {/* 07 ── Context */}
          <Section {...CONTENTS[6]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              “Context” sounds like one thing a model does. It is eleven things, and only four of
              them involve a model at all. Take{" "}
              <em>“compare the authentication architecture described in sections 3 and 7.”</em>
            </p>
            <DataTable
              columns={["Step", "Deterministic or model?"]}
              rows={[
                ["Parse the question for explicit locators (“sections 3 and 7”)", "Deterministic — regex and heuristics. Cheap and exact."],
                ["Query expansion (“authentication” → auth, login, OAuth, SSO)", "Model, or a lexical thesaurus"],
                ["Metadata filter — restrict to sections 3 and 7", "Deterministic — a WHERE clause"],
                ["Lexical retrieval (BM25)", "Deterministic"],
                ["Vector retrieval", "Model for the embedding, deterministic for the search"],
                ["Fuse the two result sets", "Deterministic (reciprocal rank fusion)"],
                ["Rerank", "Model — a cross-encoder"],
                ["Choose which pages’ images to include", "Deterministic policy over the reranked set"],
                ["Assemble the prompt and enforce the token budget", "Deterministic"],
                ["Reason and answer", "Model"],
                ["Verify every citation resolves to a real block", "Deterministic"],
              ]}
              align={{ nowrap: [] }}
            />
            <p className="text-body leading-relaxed text-muted-foreground">
              Two rows deserve emphasis. <strong>An explicit locator short-circuits everything</strong> —
              “page 37” is a filter, and running a semantic search for those words is strictly worse
              than applying it. And <strong>the last row is not optional</strong>: checking citations
              against what was actually retrieved, after generation, is how you stop hallucinated page
              numbers reaching a reader.
            </p>
          </Section>

          {/* 08 ── Defects */}
          <Section {...CONTENTS[7]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              {`Generic lists of mistakes are cheap, so this one is grounded: every item below was a real defect in ${PRODUCT_NAME}, found during the audit, with the symptom it produced in front of real people. All of them are fixed.`}
            </p>

            <Subhead>Architectural</Subhead>
            <ol className="mt-4 list-decimal space-y-3 pl-5 text-body leading-relaxed text-muted-foreground marker:font-mono marker:text-label marker:text-muted-foreground">
              <li>
                <strong className="text-foreground">Analysing the file at upload, before a question exists.</strong>{" "}
                An extractor ran on arrival and its verdict became permanent, so a misjudged PDF was
                “couldn’t read this file” forever. Read when asked, not when stored.
              </li>
              <li>
                <strong className="text-foreground">Treating extraction as a gate rather than an optimisation.</strong>{" "}
                If extraction fails the file should still be readable by other means — the bytes to
                the model, the pages as images, a code tool. It was the gate.
              </li>
              <li>
                <strong className="text-foreground">One reader, no ladder.</strong> The ladder existed
                but was unreachable: the code returned on <code>failed</code> before the rung that
                could have rescued the file.
              </li>
              <li>
                <strong className="text-foreground">Confusing retrieval with reading.</strong> Running
                retrieval over a single document the user is looking at is the wrong tool — there is
                no irrelevant part to filter out. Four retrieved passages stood in for a whole report.
              </li>
            </ol>

            <Subhead>Extraction</Subhead>
            <ol start={5} className="mt-4 list-decimal space-y-3 pl-5 text-body leading-relaxed text-muted-foreground marker:font-mono marker:text-label marker:text-muted-foreground">
              <li>
                <strong className="text-foreground">An OCR fallback that could never run.</strong> Worse
                than not having one: pdf.js <em>transfers</em> its input buffer — measured, 16,978
                bytes to 0 — so the OCR rung downstream received an empty file on every single
                document. Silent, and indistinguishable from “this scan has no text”.
              </li>
              <li>
                <strong className="text-foreground">Trusting the declared MIME type.</strong> Browsers
                send <code>application/octet-stream</code> constantly. A PDF labelled that way skipped
                the raw-bytes path entirely.
              </li>
              <li>
                <strong className="text-foreground">The gate and the reader disagreeing.</strong> The
                upload gate judged MIME type while the router judged file extension, so a{" "}
                <code>.sql</code> file was accepted from macOS and refused from Linux — the same
                bytes.
              </li>
              <li>
                <strong className="text-foreground">Refusing formats we could already read.</strong>{" "}
                <code>.docx</code>, <code>.xlsx</code> and <code>.pptx</code> were rejected at upload
                with working extractors sitting behind the wall.
              </li>
              <li>
                <strong className="text-foreground">Indexing markup as prose.</strong> RTF had no
                extractor, fell through the plain-text arm, and filled the index with{" "}
                <code>\fonttbl</code> and <code>\pard</code>.
              </li>
              <li>
                <strong className="text-foreground">Not sanitising for the datastore.</strong> A single
                NUL byte failed the insert for an entire 200-page document, because PostgreSQL’s{" "}
                <code>text</code> type cannot hold <code>0x00</code>. One bad byte, zero blocks
                stored.
              </li>
            </ol>

            <Subhead>Chunking and retrieval</Subhead>
            <ol start={11} className="mt-4 list-decimal space-y-3 pl-5 text-body leading-relaxed text-muted-foreground marker:font-mono marker:text-label marker:text-muted-foreground">
              <li>Chunks too large, so retrieval returns noise — or too small, so it returns a sentence with no context. Roughly 200–500 tokens with overlap is a sane default.</li>
              <li>Chunking across a table or a heading boundary, severing a row from its header.</li>
              <li><strong className="text-foreground">No metadata.</strong> No page, no section, no file. A chunk you cannot locate is a chunk you cannot cite.</li>
              <li><strong className="text-foreground">Confusing pages with chunks.</strong> A chunk is a retrieval unit; a page is a citation unit. They are not the same and you need both.</li>
              <li><strong className="text-foreground">Embeddings where exact search belongs.</strong> Identifiers, error codes, function names: that is BM25 territory. A stemmer will not find <code>NDA-4417</code>.</li>
              <li><strong className="text-foreground">No reranking.</strong> Vector top-k is a rough ordering, and a cross-encoder over the top fifty is the cheapest large quality win available.</li>
              <li><strong className="text-foreground">Sending everything retrieved.</strong> Irrelevant context measurably degrades answers, and costs money to do it.</li>
            </ol>

            <Subhead>Interface and honesty</Subhead>
            <ol start={18} className="mt-4 list-decimal space-y-3 pl-5 text-body leading-relaxed text-muted-foreground marker:font-mono marker:text-label marker:text-muted-foreground">
              <li>
                <strong className="text-foreground">Passing judgement on a file before anyone asked.</strong>{" "}
                The composer said “couldn’t read this file” on the basis of a <em>search index</em>,
                while the actual answer depends on the <em>model</em> — which receives the PDF and
                reads a scan fine. Wrong in both directions.
              </li>
              <li>
                <strong className="text-foreground">Telling the model a file is unreadable while handing it the file.</strong>{" "}
                The system prompt said “no readable text — do not invent contents” on turns where the
                adapter had inlined the PDF two blocks earlier. The best case reported as the worst.
              </li>
              <li>
                <strong className="text-foreground">No size guard before base64 inlining.</strong>{" "}
                Base64 adds a third, so an oversized PDF failed the whole <em>turn</em> — the person
                lost their answer, not just their attachment.
              </li>
              <li>
                <strong className="text-foreground">Expecting the model to reconstruct what you destroyed.</strong>{" "}
                If you flatten a table, no amount of prompting recovers the cell relationships.
              </li>
            </ol>
          </Section>

          {/* 09 ── Architecture */}
          <Section {...CONTENTS[8]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              What each stage is for, when it runs, how it fails, and what it does instead of failing.
              Note how many of them are conditional: a well-built pipeline does the minimum a
              question requires, not the maximum a file permits.
            </p>
            <ol className="mt-6 space-y-4">
              {STAGES.map((stage) => (
                <Stage key={stage.n} stage={stage} />
              ))}
            </ol>
            <Note title="One security rule, in the middle of an architecture note">
              <p>
                Non-image uploads should be stored as <code>application/octet-stream</code> with{" "}
                <code>Content-Disposition: attachment</code>, so that nothing a stranger uploads can
                ever be rendered inline by a browser. An HTML or SVG “document” served back on your
                own origin is a cross-site scripting vector with a file extension.
              </p>
            </Note>
          </Section>

          {/* 10 ── Representation */}
          <Section {...CONTENTS[9]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              The problem with reducing a document to a string is that every locator, every type and
              every relationship is destroyed in one step, and nothing downstream can recover them.
              This is roughly the minimum that keeps the options open.
            </p>
            <Listing label="document representation">{`{
  "documentId": "doc_01H…",
  "source": {
    "fileName": "architecture-review.pdf",
    "mimeType": "application/pdf",
    "sha256": "…",
    "sizeBytes": 4718592
  },
  "metadata": {
    "title": "Platform Architecture Review",
    "pageCount": 42,
    "language": "en",
    "hasTextLayer": true,
    "parser": "pdfjs",
    "status": "ok"                  // ok | degraded | failed
  },

  "sections": [
    { "id": "sec_3", "title": "Authentication", "level": 1,
      "path": ["Architecture", "Authentication"],
      "startPage": 12, "endPage": 19 }
  ],

  "pages": [
    { "number": 15, "width": 612, "height": 792, "rotation": 0,
      "render": { "uri": "s3://…/page-015.jpg", "dpi": 150 },
      "hasTextLayer": true,
      "blockIds": ["blk_15_1", "blk_15_7"] }
  ],

  "blocks": [
    { "id": "blk_15_1",
      "ordinal": 271,               // reading order across the document
      "page": 15,
      "type": "heading",            // heading | paragraph | list_item | table
                                    // | code | caption | image | speaker_notes
      "text": "3.2 Token exchange",
      "headingPath": ["Architecture", "Authentication", "Token exchange"],
      "bbox": [72, 648, 468, 24],   // x, y, w, h in page units
      "confidence": 1.0,            // 1.0 embedded; below that, OCR, as measured
      "source": "embedded" },       // embedded | pdfjs | ocr | vision

    { "id": "blk_22_3",
      "ordinal": 402,
      "page": 22,
      "type": "table",
      "text": "Region | Revenue\\nOntario | 4,200,000",   // for lexical search
      "table": {                                         // for computation
        "columns": ["Region", "Revenue"],
        "rows": [["Ontario", "4200000"], ["Quebec", "3100000"]]
      },
      "confidence": 1.0,
      "source": "embedded" }
  ],

  "chunks": [
    { "id": "chk_19",
      "blockIds": ["blk_15_1", "blk_15_2", "blk_15_3"],
      "text": "3.2 Token exchange\\n\\nThe service exchanges …",
      "pageStart": 15, "pageEnd": 15,
      "tokenCount": 380 }
  ]
}`}</Listing>
            <p className="text-body leading-relaxed text-muted-foreground">
              Every field earns its place. <code>ordinal</code> restores reading order after any
              query has scrambled it. <code>bbox</code> is what lets you crop a figure or highlight a
              citation in a viewer. <code>confidence</code> and <code>source</code> keep OCR guesses
              distinguishable from verified text — merging them silently is how a reconstruction
              turns into a quotation. <code>headingPath</code> gives a chunk its context without
              re-reading the document. <code>chunks.blockIds</code> is the join that makes citation
              possible at all: chunk, to blocks, to page. And <code>table.rows</code> beside{" "}
              <code>table.text</code> means the same table can be searched lexically{" "}
              <em>and</em> computed over.
            </p>
          </Section>

          {/* 11 ── Retrieval */}
          <Section {...CONTENTS[10]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              Ask “what database technology is used, and why?” of a document that says{" "}
              <em>“we chose PostgreSQL for its JSONB support”</em>. The first half of that question
              is a lexical match and the second half has no lexical overlap with the answer at all.
              That is the whole case for hybrid retrieval in one sentence.
            </p>
            <ul className="mt-4 space-y-3 text-body leading-relaxed text-muted-foreground">
              <li>
                <strong className="text-foreground">Lexical / BM25</strong> catches{" "}
                <code>PostgreSQL</code>, <code>pgvector</code>, <code>NDA-4417</code>. Exact tokens,
                no embedding call, no semantic drift. Essential for identifiers, error codes,
                function names and part numbers.
              </li>
              <li>
                <strong className="text-foreground">Embeddings</strong> catch the “why”, where the
                answer shares no words with the question.
              </li>
              <li>
                <strong className="text-foreground">Reciprocal rank fusion</strong> merges the two.
                Parameter-free and robust, and it needs no score normalisation between two
                incomparable scales.
              </li>
              <li>
                <strong className="text-foreground">Metadata filters run first.</strong> “In section
                3”, “on page 37”, “in the appendix” are <code>WHERE</code> clauses. Applying them
                before the search is both cheaper and more correct.
              </li>
              <li>
                <strong className="text-foreground">Rerank the top fifty down to the top eight</strong>{" "}
                with a cross-encoder. Bi-encoders embed the query and the document separately; a
                cross-encoder sees both together and is markedly better at relevance. This is usually
                the single biggest quality gain per unit of effort in the whole system.
              </li>
            </ul>
            <p className="mt-5 text-body leading-relaxed text-muted-foreground">
              Vector search alone is insufficient for a structural reason, not a tuning reason.
              Embeddings compress meaning into a few hundred dimensions, which is exactly the wrong
              operation for exact strings: <code>NDA-4417</code> and <code>NDA-4418</code> are
              near-identical vectors and completely different contracts. Cosine similarity also has
              no notion of <em>sufficiency</em> — the top five come back whether or not any of them
              answers the question, so a retrieval miss is indistinguishable from the document not
              containing the answer. The model cannot tell which happened unless you tell it.
            </p>

            <Subhead>Visual retrieval</Subhead>
            <p className="text-body leading-relaxed text-muted-foreground">
              “What does the diagram on page 24 show?” needs <em>no retrieval at all</em>. Page 24 is
              a locator: filter, take the render, send it. Running a semantic search there is a
              strictly worse way to answer an exact question, and it is the most common
              over-engineering mistake in document question-answering.
            </p>
            <p className="mt-4 text-body leading-relaxed text-muted-foreground">
              “Show me the diagram of the auth flow”, with no page given, is the case that needs real
              visual retrieval. Four strategies work, cheapest first: index the{" "}
              <strong>caption and the paragraph that references it</strong>, since most figures are
              captioned and captions are written to be descriptive; store the{" "}
              <strong>OCR text of the image region</strong> separately from real text, so a hit is
              traceable to a guess; generate <strong>descriptions at index time</strong> with a
              vision model, which is genuinely effective at a cost of one call per figure; and
              finally <strong>embed the rendered page</strong> in a multimodal space, which is the
              strongest option for visually dense documents and the heaviest to index.
            </p>
          </Section>

          {/* 12 ── Citations */}
          <Section {...CONTENTS[11]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              A citation is only worth printing if the chain behind it is unbroken:
            </p>
            <Listing>{`document → page 24 → block 7 → chunk 19 → retrieved result → model context → citation`}</Listing>
            <p className="text-body leading-relaxed text-muted-foreground">
              Three rules make that chain hold. <strong>One:</strong> every chunk carries its block
              ids and every block carries its page — locators are propagated, never re-derived, because
              the moment a component recomputes a page number it can be wrong. <strong>Two:</strong>{" "}
              the locator goes in the prompt, attached to the text, labelled inline; a model cannot
              cite what it was not told. <strong>Three:</strong> parse the citations back out of the
              answer and check each one against the set that was actually retrieved.
            </p>
            <Keystone>
              Rules one and two make correct citation possible. Rule three is what makes incorrect
              citation impossible to display — and it is the one people skip.
            </Keystone>
            <p className="text-body leading-relaxed text-muted-foreground">
              One extra guard is worth having: a citation whose page contains no retrieved block is a
              fabrication even when the page exists. Check the block, not just the number.
            </p>
          </Section>

          {/* 13 ── Comparison */}
          <Section {...CONTENTS[12]}>
            <DataTable
              columns={["The question", "Naïve pipeline", "Strong pipeline"]}
              rows={[
                [
                  "“What does page 37 say?”",
                  "Semantic search for “page 37”; returns whatever resembles those words",
                  "Filter page = 37; return its blocks and its image",
                ],
                ["A scanned contract", "Empty string → “I cannot read this file”", "No text layer → page images → the model reads it"],
                ["“What does this diagram show?”", "Database API Frontend", "The page image. Arrows and all."],
                ["“Find clause NDA-4417”", "Cosine similarity returns NDA-4418", "BM25 exact match"],
                [
                  "“Q3 total?” over a 50,000-row sheet",
                  "Truncated cells in context; the model does arithmetic badly",
                  "pandas in a sandbox; exact",
                ],
                ["A two-column paper", "Columns interleaved line by line", "Layout analysis keeps the column order"],
                ["A 500-page report", "Everything embedded; retrieval misses", "Hierarchical summaries, hybrid retrieval, page filters"],
                [
                  "“Does it mention X?” — it does not",
                  "Five chunks come back regardless; the model infers something",
                  "“No passage matched” reaches the model",
                ],
              ]}
            />
            <p className="text-body leading-relaxed text-muted-foreground">
              The second system wins not because it has more components, but because{" "}
              <strong>it loses less information and it knows what it does not know.</strong>
            </p>
          </Section>

          {/* 14 ── Models */}
          <Section {...CONTENTS[13]}>
            <DataTable
              columns={["Task", "Right tool", "Why not a language model"]}
              rows={[
                [
                  "Parse a PDF, DOCX or XLSX",
                  "A deterministic parser",
                  "There is a correct answer. A parser is orders of magnitude cheaper and does not invent a page number.",
                ],
                ["Decode, resize or crop an image", "An image library", "Same."],
                ["Detect a file type", "Magic bytes", "Same."],
                ["Chunk text", "Deterministic, structure-aware code", "Same."],
                ["OCR", "A specialised OCR model", "Purpose-built, cheap, and it returns per-word confidence."],
                ["Embeddings", "An embedding model", "Definitionally a model task."],
                ["Rerank", "A cross-encoder", "Around a hundred times cheaper than an LLM for the same ordering."],
                ["Describe a figure", "A vision model", "Requires understanding."],
                ["Reason, compare, synthesise", "A language model", "Requires understanding."],
              ]}
            />
            <p className="text-body leading-relaxed text-muted-foreground">
              “Use the LLM for everything” fails on four axes at once: cost, by orders of magnitude;
              latency, seconds against milliseconds; <em>non-determinism where determinism was
              available</em>, since parsing the same PDF twice ought to give the same answer; and
              debuggability. When a parser is wrong you get a stack trace. When a model is wrong you
              get a plausible paragraph.
            </p>
            <p className="mt-4 text-body leading-relaxed text-muted-foreground">
              {`The corollary is the direction ${PRODUCT_NAME} has taken: rather than pre-digesting every upload, give the model a sandbox and let it choose the right deterministic tool per question — pypdf here, pandas there, Pillow for a crop — instead of guessing at upload time which one it will eventually need.`}
            </p>
          </Section>

          {/* 15 ── Stack */}
          <Section {...CONTENTS[14]}>
            <DataTable
              columns={["Role", "Options", "Choose when"]}
              rows={[
                [
                  "PDF parsing",
                  "PyMuPDF (fast, layout-aware, AGPL), pdfplumber (tables, slow), pdf.js / unpdf (Node, no native dependency)",
                  "PyMuPDF if you are in Python and the licence permits; unpdf if you are Node-only",
                ],
                ["Page rendering", "pdftoppm, PyMuPDF, pdfium, pdf.js with a canvas binding", "Whatever avoids a system binary if you deploy serverless"],
                [
                  "DOCX / PPTX / XLSX",
                  "python-docx, python-pptx, openpyxl — or the raw OOXML",
                  "They are ZIP plus XML; direct parsing is very feasible and dependency-free",
                ],
                ["OCR", "Tesseract, PaddleOCR, a cloud document-AI service", "Tesseract until accuracy actually blocks you"],
                ["Image manipulation", "Pillow, sharp, @napi-rs/canvas", "Language fit"],
                ["Embeddings", "Hosted embedding APIs, or BGE / E5 self-hosted", "Hosted until volume or privacy says otherwise"],
                ["Vector store", "pgvector, Qdrant, Weaviate, LanceDB", "pgvector if you already run PostgreSQL — one datastore beats two"],
                ["Lexical search", "PostgreSQL full-text, OpenSearch, Typesense", "Postgres FTS is enough for far longer than people expect"],
                ["Reranking", "A hosted rerank API, or a cross-encoder you run", "Hosted first. Small cost, large gain."],
                ["Multimodal model", "Claude, GPT, Gemini — all take PDFs natively", "Use the native document part. Do not pre-flatten."],
                ["Object storage", "S3, R2, GCS", "Always. Never the database."],
                ["Code sandbox", "A remote isolated sandbox — E2B, Modal, Firecracker, gVisor", "Never a subprocess on the application host"],
              ]}
            />
            <Note title="The sandbox line is a security boundary, not a preference">
              <p>
                Code written by a model that has just read a document supplied by a stranger must not
                execute next to your provider keys, your database credentials and other tenants’
                files. A prompt injection inside a PDF then becomes arbitrary execution on your
                application server. Use a remote, isolated sandbox — or do not offer the capability.{" "}
                <Evidence kind="juno" />
                {`${PRODUCT_NAME}’s code tool is pinned to a remote microVM backend and is simply not offered when none is configured: a missing sandbox costs the model a capability, never a boundary.`}
              </p>
            </Note>
          </Section>

          {/* 16 ── Juno */}
          <Section {...CONTENTS[15]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              <strong className="text-foreground">What is good today.</strong> Dual-channel handling
              for every provider that supports a native document part, so the PDF itself reaches the
              model rather than our guess about it. Page rendering in-process, with no system binary
              to install. A block model with real locators — page, slide, sheet, cell range, line
              range, heading path, bounding box, confidence. Reading on demand rather than at upload.
              Tools that let the model navigate a file itself instead of being handed a summary. And
              a sandbox path that is correctly gated.
            </p>
            <p className="mt-4 text-body leading-relaxed text-muted-foreground">
              <strong className="text-foreground">What is not there yet</strong>, in the order we
              think it is worth doing:
            </p>
            <DataTable
              columns={["", "Gap", "Impact", "Effort"]}
              rows={[
                ["1", "No remote sandbox provisioned, so the code tool is inert", "High — no spreadsheet computation, no model-written parsing", "Low"],
                ["2", "No reranker between retrieval and context assembly", "High — retrieval quality across project corpora", "Low"],
                ["3", "Page renders computed on demand but not persisted per page", "Medium — blocks visual retrieval, and makes re-reads cost twice", "Medium"],
                ["4", "No structured table field on blocks", "Medium — tables are searchable but not computable", "Medium"],
                ["5", "OCR needs binaries that are not installed", "Medium — scans depend entirely on the visual channel", "Medium"],
                ["6", "Legacy .doc / .xls / .ppt, .epub, .heic and .tiff unsupported", "Low to medium", "Medium"],
                ["7", "No hierarchical summaries for very large documents", "Low, until people upload 500-page PDFs", "High"],
              ]}
              align={{ nowrap: [0, 3] }}
              caption="Publishing the gap list is deliberate. A roadmap that only contains finished work is a brochure."
            />
            <p className="text-body leading-relaxed text-muted-foreground">
              None of it is a rewrite. Each item is additive: provision a sandbox and set two
              environment variables; add one call between retrieval and assembly; add a page-asset
              row; add two columns that extractors fill when they can. The parts that work are not
              touched.
            </p>
          </Section>

          {/* 17 ── Principles */}
          <Section {...CONTENTS[16]}>
            <ol className="mt-2 grid gap-x-8 gap-y-4 sm:grid-cols-2">
              {[
                ["Dual channel.", "Text and pixels, per page, together. The single most important design fact on this page."],
                ["Never gate on text.length > 0.", "That check is what produces “couldn’t read this file” for documents that read perfectly."],
                ["Read when asked, not when stored.", "At upload there is no question, no model and no reason. Every verdict made then is a guess that becomes permanent."],
                ["Parsers for parsing, models for understanding.", "Using a model where a parser works costs a thousand times more and hallucinates."],
                ["A ladder, never a gate.", "Native parser, better parser, OCR, vision. No single rung’s failure may end a file’s life."],
                ["Locators are the product.", "Page, section, line. A chunk you cannot locate is a chunk you cannot cite."],
                ["Retrieval is a scaling strategy, not a reading strategy.", "If it fits, send it whole."],
                ["Hybrid beats vectors.", "Exact strings need BM25, meaning needs embeddings, and you need both, fused."],
                ["Rerank.", "The cheapest large quality win in the whole pipeline."],
                ["An explicit locator short-circuits retrieval.", "“Page 37” is a WHERE clause, not a search query."],
                ["Structure once destroyed is never recovered.", "No prompt rebuilds a flattened table."],
                ["Distinguish verified text from reconstructed text.", "OCR carries confidence; embedded text does not need it. Never merge them silently."],
                ["Say what you dropped.", "Silent truncation manufactures confident wrong answers."],
                ["Validate citations after generation.", "The only reliable defence against hallucinated page numbers."],
                ["Sandbox anything the model writes, remotely.", "A prompt injection in a PDF must not become code execution on your host."],
              ].map(([rule, detail], i) => (
                <li key={rule} className="flex gap-3">
                  <span className="mt-0.5 shrink-0 font-mono text-label text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-body leading-relaxed text-muted-foreground">
                    <strong className="text-foreground">{rule}</strong> {detail}
                  </span>
                </li>
              ))}
            </ol>
          </Section>

          {/* 18 ── Sources */}
          <Section {...CONTENTS[17]}>
            <p className="text-body leading-relaxed text-muted-foreground">
              Everything tagged <Evidence kind="published" className="mr-0" /> on this page comes
              from one of these. Where a vendor has not published something, the page says so rather
              than filling the gap.
            </p>
            <ul className="mt-4 space-y-2.5 text-body leading-relaxed text-muted-foreground">
              {[
                ["Anthropic — PDF support", "https://platform.claude.com/docs/en/build-with-claude/pdf-support"],
                ["Anthropic — Files API", "https://platform.claude.com/docs/en/build-with-claude/files"],
                ["Anthropic — Vision", "https://platform.claude.com/docs/en/build-with-claude/vision"],
                [
                  "Anthropic — Code execution tool",
                  "https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool",
                ],
                ["Google — Gemini document processing", "https://ai.google.dev/gemini-api/docs/document-processing"],
                ["OpenAI — OpenAPI specification", "https://github.com/openai/openai-openapi"],
                [
                  "Microsoft — Copilot Studio document handling",
                  "https://learn.microsoft.com/en-us/microsoft-copilot-studio/nlu-documents",
                ],
              ].map(([label, href]) => (
                <li key={href}>
                  <Source href={href}>{label}</Source>
                </li>
              ))}
            </ul>
            <Note title="A note on what this page is not">
              <p>
                {`It is not a claim to know how ChatGPT or Claude work internally. It is an audit of what their makers have published, plus the architecture those publications imply, plus a first-person account of the mistakes we made building against them. The longer engineering version, with the migration plan and the file paths, lives in ${PRODUCT_NAME}’s repository.`}
              </p>
            </Note>
          </Section>

          <p className="border-t border-border/60 pt-8 text-body leading-relaxed text-muted-foreground">
            {`${PRODUCT_NAME} puts every frontier model behind one subscription, metered by what answers actually cost.`}{" "}
            <Link
              href="/"
              className="rounded-xs font-medium text-foreground underline decoration-border underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:decoration-primary focus-visible:text-primary"
            >
              See how it works
            </Link>
            .
          </p>
        </article>

        {/* The contents column. `sticky` needs no JavaScript, and on a narrow
            screen the whole aside simply sits above the article instead. */}
        <aside className="order-first lg:order-none">
          <nav
            aria-label="Contents"
            className="rounded-card border border-border bg-card p-5 lg:sticky lg:top-20 lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0"
          >
            <p className="font-mono text-label text-muted-foreground">Contents</p>
            <ol className="mt-3 space-y-1.5">
              {CONTENTS.map((item) => (
                <li key={item.id} className="flex gap-2.5">
                  <span className="shrink-0 font-mono text-micro text-muted-foreground/70 tabular-nums">
                    {item.index}
                  </span>
                  <a
                    href={`#${item.id}`}
                    className="rounded-xs text-ui leading-snug text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
                  >
                    {item.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </aside>
      </div>
    </>
  );
}
