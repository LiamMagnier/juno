# File understanding: how the frontier assistants do it, and how Juno should

**Status:** engineering reference. Written after an audit of Anthropic, OpenAI,
Google and Microsoft's *published* documentation, cross-checked against Juno's
own source. Every external claim below carries a link. Where something is not
public, this document says so rather than guessing.

**Epistemic labels used throughout.** Mixing these up is how architecture
documents become folklore, so they are marked inline:

| Label | Means |
| --- | --- |
| **[DOC]** | Stated in vendor documentation. Link given. |
| **[INFER]** | A reasonable architectural inference from observable behaviour, limits or pricing. Not confirmed. |
| **[UNKNOWN]** | Proprietary. Nobody outside the vendor can answer it, and this document will not pretend to. |
| **[JUNO]** | A fact about this repository, with a file path. |

---

## 0. The mental model, in one paragraph

A modern assistant does **not** do `PDF → text → LLM`. It does
`PDF → (text layer ∥ page images) → model`, in parallel, and the model sees
both. The text carries exact strings and reading order; the pixels carry
layout, diagrams, handwriting, stamps, and everything a text extractor throws
away. Retrieval is a *scaling* strategy applied on top when the document is too
big to show whole — not the primary way a file is read. And the heavy lifting
that *is* deterministic (parsing, decoding, rendering) stays in ordinary
software, because a parser is cheaper, faster and more reliable than a model
for work that has a correct answer.

---

## 1. What actually happens when a user uploads a PDF

### 1.1 The confirmed shape

Anthropic documents its PDF pipeline in three sentences that are worth quoting
exactly, because they settle the central question:

> "The system converts each page of the document into an image. The text from
> each page is extracted and provided alongside each page's image."
> "Documents are provided as a combination of text and images for analysis."

— **[DOC]** [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support), *How PDF support works*

Google documents the same design for Gemini: each page is rasterised to a
screenshot **and** OCR'd, which is why scanned PDFs work natively — **[DOC]**
[Gemini document processing](https://ai.google.dev/gemini-api/docs/document-processing).

OpenAI's Responses API accepts a PDF as a first-class `input_file` part with a
render-quality `detail` knob, which only makes sense if pages are being
rendered — **[DOC]**
[OpenAI OpenAPI spec, `InputFileContentParam`](https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml).

So the convergent industry pattern is **dual-channel**: text *and* pixels, per
page, together. This is the single most important fact in this document.

The cost of that channel is also documented: the visual path runs roughly
**7× the token cost** of text-only — about 1,500–3,000 text tokens per page
*plus* full image tokens per page — **[DOC]**
[PDF support, *Estimate your costs*](https://platform.claude.com/docs/en/build-with-claude/pdf-support).
Bedrock exposes both modes side by side so you can choose, which is the
clearest public evidence that they are genuinely two different architectures
and not one pipeline with a flag.

### 1.2 The walkthrough

`document.pdf` uploaded → *"What does page 37 say about the database
architecture?"*

| Stage | What happens | Who does it |
| --- | --- | --- |
| **Upload & store** | Bytes to object storage. An id, a name, a size, a checksum. Nothing is read. | Deterministic |
| **Type detection** | Magic bytes, **not** the extension and **not** the browser's `Content-Type`. `%PDF-` is the PDF signature. | Deterministic |
| **Parse** | Object graph → page tree → content streams. Produces page count, page geometry, embedded fonts, and the text-show operators. | Deterministic (pdf.js, PyMuPDF, pdfplumber) |
| **Text extraction** | Text runs with x/y positions and font metrics. Reading order is *reconstructed* from geometry — it is not stored in the file. | Deterministic |
| **Layout analysis** | Group runs into lines by baseline, lines into paragraphs by gap, detect columns, tables, headers/footers. | Deterministic, sometimes ML |
| **Page rendering** | Each page → an image, ~150 DPI. This is the second channel. | Deterministic |
| **OCR (conditional)** | Only for pages with no text layer. OCR is a *fallback*, never the default — it is slower and strictly worse than embedded text where embedded text exists. | Specialised ML |
| **Structural extraction** | Blocks: heading / paragraph / list item / table / code / caption / image, each with a page number and bounding box. | Deterministic + ML |
| **Indexing (conditional)** | Only when the document is too large to show whole, or when searching *across* documents. Chunk → embed → store. | ML |
| **Context construction** | For "page 37", this is a **metadata filter**, not a semantic search. Page 37's blocks and page 37's image go in the prompt. | Deterministic |
| **Generation** | The model reads text and pixels together and answers, citing the page. | Model |

Note where the intelligence actually sits: **one** row is the model. The rest
is engineering. Which is the point of §14.

### 1.3 Is it `PDF → text → LLM`?

No — and a system built that way has a hard ceiling it cannot engineer past.
The failure is not subtle: a scanned page yields the empty string, a diagram
yields its labels with the arrows removed, and a two-column paper yields two
columns interleaved line by line. Microsoft Copilot is the public cautionary
case: a text-extraction pipeline with a character ceiling that fails outright
on image-only PDFs — **[DOC]**
[Copilot Studio document handling](https://learn.microsoft.com/en-us/microsoft-copilot-studio/nlu-documents).

### 1.4 What is not public

**[UNKNOWN]** The exact rasterisation DPI, the internal chunker, whether
retrieval runs for consumer uploads and at what size threshold, the reranker,
and the prompt scaffolding. Vendors publish the *interface* and the *limits*,
not the pipeline. Anyone who tells you Claude's chunk size is proprietary
information they do not have.

---

## 2. Images

### 2.1 The pipeline

`architecture.png` → *"Explain the components shown in this diagram."*

1. **Decode** — bytes to a pixel array. Format sniffed from magic bytes.
2. **Resize** — this is the step that surprises people. Providers downscale
   before inference: Anthropic documents a maximum of 8000×8000 px and
   ~1,590 tokens for a 1.15 MP image — **[DOC]**
   [Vision](https://platform.claude.com/docs/en/build-with-claude/vision). Gemini
   documents 258 tokens per page/tile — **[DOC]**
   [Gemini docs](https://ai.google.dev/gemini-api/docs/document-processing).
3. **Patchify** — the image is cut into fixed-size patches (typically 14×14 or
   16×16 px), each linearly projected into an embedding.
4. **Vision encoder** — a ViT-family transformer processes the patch sequence.
   Self-attention across patches is what encodes *spatial relationship*: patch
   A is left of patch B, this arrow starts here and ends there.
5. **Projection** — the visual embeddings are mapped into the language model's
   embedding space, becoming tokens the LLM attends over alongside text tokens.
6. **Joint reasoning** — from the LLM's perspective there is one sequence. It
   does not "call" a vision module; the picture is already in its context as
   vectors.

**[INFER]** The patch/projection description is the standard published
VLM architecture (CLIP, Flamingo, LLaVA, Qwen-VL). Whether the frontier models
use exactly this is **[UNKNOWN]**, but the token-count arithmetic the vendors
publish is consistent with fixed-size patching.

### 2.2 Why "what button is in the top-right?" works

Because position is preserved. Patches enter the sequence with positional
encodings, so "top-right" is recoverable from the representation. OCR would
return the button's *label* and discard where it was.

### 2.3 The four things people conflate

| | What it does | What it cannot do |
| --- | --- | --- |
| **OCR** | Image → characters, with boxes | Say what anything *means*, or read a diagram's arrows |
| **Classical CV** | Detect/segment known object classes | Generalise past its label set; explain |
| **VLM** | Encode an image into a shared semantic space | Reason at length on its own |
| **Multimodal LLM** | Reason jointly over pixels and text | Be as cheap or as exact as a parser |

**Why OCR alone is insufficient:** run it on an architecture diagram and you
get `Database API Frontend`. The arrows — which *are* the architecture — are
not characters, so they do not survive. This is the same information loss as
§4, and it is the reason the dual-channel design exists at all.

---

## 3. Formats, and what naïve text conversion destroys

| Format | Carries | Lost by flattening to text |
| --- | --- | --- |
| **PDF** | Pages, geometry, fonts, embedded images, annotations | Page boundaries, reading order in columns, diagrams, tables, scans |
| **DOCX** | Heading levels, lists, tables, links, footnotes, headers/footers, tracked changes, images + captions | **Hierarchy** — "Introduction" and body text become indistinguishable strings. Table cell relationships. Which footnote belongs where. |
| **PPTX** | Slide boundaries, titles, speaker notes, z-order, images | The slide as a unit; speaker notes (often the actual argument); what was a title |
| **XLSX** | Sheets, cells, **formulas**, types, ranges, charts | Formulas (you get values and lose the logic), which sheet a number came from, the column header a value belongs to |
| **CSV** | Rows, columns, header | Types (`01234` → `1234`), which column is which once rows wrap |
| **Markdown** | Explicit structure, already text | Little — MD is the happy case |
| **HTML** | DOM, semantics, tables | Nav/boilerplate pollutes content unless stripped; **and it is an XSS vector, so it must never be served back inline** |
| **Source code** | Line numbers, file path, symbols | **Line numbers** — without them a citation cannot be checked. Indentation in Python *is* syntax. |

Anthropic's document block accepts **only** `application/pdf` and
`text/plain`; `.docx`/`.xlsx` are rejected outright and must be converted
first — **[DOC]**
[Files API](https://platform.claude.com/docs/en/build-with-claude/files). Their
own recommendation for a DOCX containing images is to convert it to PDF and use
the PDF path, precisely so the images survive.

Spreadsheets get a different path entirely: **[DOC]** xlsx/csv go through
**code execution** via `container_upload`, not document blocks —
[code execution tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool).
That is a deliberate architectural choice and the right one: a spreadsheet
question is usually a *computation* ("what is the Q3 total?"), and stuffing
40,000 cells into a context window to make a model add them up is both
expensive and unreliable. Run pandas instead.

---

## 4. Text understanding vs visual understanding

The user's example is exactly right. Page 15 contains:

```
[database icon] → [API server] → [frontend]
```

Text extraction yields:

```
Database API Frontend
```

Three nouns. The arrows are gone, so the *direction of data flow* — the entire
content of the diagram — is gone. A model given only that text cannot answer
"does the frontend talk to the database directly?" and, worse, will often
answer anyway.

**How a strong system preserves both.** Keep them as parallel representations
of the same page, joined by page number:

- **Semantic layer** — blocks with types, text, heading path, bounding boxes.
  Good for exact strings, citations, and search.
- **Visual layer** — the rendered page image. Good for layout, arrows, charts,
  handwriting, stamps, and anything a parser cannot name.

Then at answer time, send **both for the pages that matter**. The bounding
boxes are what let you go further: if block 7 on page 15 is an `image` block at
`[x, y, w, h]`, you can crop *just that region* and send a magnified version,
which is far cheaper than the full page and far more legible than a
downsampled one.

**[JUNO]** This is what `inspect_image` does (`src/lib/agent/image.ts`): a
region in percent, cropped and scaled up to at least 768 px on its short edge,
handed back to the model as an image. The magnification matters — a 4% crop of
a 4000 px screenshot is 160 px, which the provider then downsamples again to
nothing.

---

## 5. Large documents: five approaches

A 500-page PDF cannot go in every prompt. At ~2,000 text tokens/page that is
~1M text tokens, and with the visual channel far more.

| | Approach | Advantages | Disadvantages | Use when |
| --- | --- | --- | --- | --- |
| **A** | Everything in context | No infrastructure; no retrieval bugs; perfect recall within the window | Cost scales with document, not question; hits the window; attention degrades over very long contexts | Document fits comfortably — which today means most documents |
| **B** | Chunk + embeddings + vector DB | Scales to any corpus; cheap per query | Misses exact strings (IDs, error codes, names); chunk boundaries sever context; retrieval failures look like the document not containing something | Large corpus, semantic questions |
| **C** | Hybrid (BM25 + vectors + rerank) | Catches both "about X" and "contains literally X"; the reranker fixes most ordering errors | Two indexes to keep in sync; more moving parts | Production default for corpora |
| **D** | Hierarchical (summaries → sections → blocks) | Handles "summarise the whole thing"; navigable; cheap top-level | Summarisation is lossy and must be recomputed on change; more storage | Very large single documents; "what is this about" questions |
| **E** | Page-level multimodal (ColPali-style page embeddings) | Layout and diagrams are retrievable; no parsing loss | Expensive to index; immature tooling; coarse (a page, not a sentence) | Visually dense documents — slides, reports, scans |

**Recommendation for a production chatbot: A, then C, with D and E as
extensions.**

Concretely, threshold on size:

- **Fits the window** → send it whole (A). This is most documents, and it is
  strictly better than retrieval: no chunking bugs, no missed passages.
- **Too large** → hybrid retrieval (C) over blocks, with page/section metadata
  filters, plus a reranker.
- **"Summarise this 500-page report"** → hierarchical (D); retrieval cannot
  answer a question whose answer is the whole document.
- **Visually dense** → add page-image retrieval (E).

The common mistake is jumping straight to B for a 12-page PDF. That is
infrastructure solving a problem you do not have, and it *loses* information
relative to just sending the document.

---

## 6. What "context" actually means

*"Compare the authentication architecture described in sections 3 and 7."*

| Step | Deterministic or model? |
| --- | --- |
| Parse the question for explicit locators ("sections 3 and 7") | **Deterministic** — regex/heuristics. Cheap and exact. |
| Query expansion / intent ("authentication" → auth, login, OAuth, SSO) | **Model** (or a lexical thesaurus) |
| Metadata filter — restrict to sections 3 and 7 | **Deterministic** — a WHERE clause |
| Lexical retrieval (BM25) | **Deterministic** |
| Vector retrieval | **Model** (embeddings) + deterministic ANN search |
| Fuse the two result sets (RRF) | **Deterministic** |
| Rerank | **Model** (cross-encoder) |
| Select pages whose images to include | **Deterministic** policy over the reranked set |
| Assemble the prompt, enforce the token budget | **Deterministic** |
| Reason and answer | **Model** |
| Verify each citation resolves to a real block | **Deterministic** |

Two things deserve emphasis. **The explicit locator short-circuits
everything** — "page 37" is a filter, and running a semantic search for it is
strictly worse. And **the last row is not optional**: validating citations
against the retrieved set after generation is how you stop hallucinated page
numbers (§12).

---

## 7. Why a file pipeline feels horrible — the real defect list

Generic lists of mistakes are cheap. This one is grounded: every item marked
**[JUNO]** was an actual defect found in *this* repository during the audit,
with the symptom it produced.

**Architectural**

1. **Analysing the file at upload, before there is a question.** **[JUNO]** An
   extractor ran on arrival and its verdict became permanent, so a misjudged
   PDF was "couldn't read this file" forever. Read when asked, not when stored.
2. **Treating extraction as a gate rather than an optimisation.** If
   extraction fails, the file should still be readable by other means — bytes
   to the model, pages as images, a code tool. **[JUNO]** It was the gate.
3. **One reader, no ladder.** Native parser → better parser → OCR → vision.
   **[JUNO]** The ladder existed but was unreachable: the code returned on
   `failed` *before* the rung that could have rescued it.
4. **Confusing retrieval with reading.** RAG over a single attached document
   the user is looking at is the wrong tool — there is no irrelevant part to
   filter out. **[JUNO]** Four retrieved passages stood in for a whole report.

**Extraction**

5. **No OCR fallback** — or one that cannot run. **[JUNO]** Worse than absent:
   pdf.js *transfers* its input buffer (measured: `byteLength 16978 → 0`), so
   the OCR rung downstream received an empty file on every document. Silent,
   and indistinguishable from "this scan has no text".
6. **Trusting the declared MIME type.** Browsers send
   `application/octet-stream` constantly. **[JUNO]** A PDF so labelled skipped
   the raw-bytes path entirely.
7. **Gate and reader disagreeing.** **[JUNO]** The upload gate judged MIME
   while the router judged extension, so a `.sql` was accepted from macOS and
   415'd from Linux — *the same bytes*.
8. **Refusing formats you can already read.** **[JUNO]** `.docx`, `.xlsx`,
   `.pptx` were rejected at upload with working extractors sitting behind the
   wall.
9. **Indexing markup as prose.** **[JUNO]** RTF had no extractor, fell through
   the `text/*` arm, and filled the index with `\fonttbl` and `\pard`.
10. **Not sanitising for the datastore.** **[JUNO]** A single NUL byte failed
    `createMany` for an entire 200-page document — Postgres `text` cannot hold
    `0x00`. One bad byte, zero blocks stored.

**Chunking & retrieval**

11. Chunks too large (retrieval returns noise) or too small (a sentence with no
    context). ~200–500 tokens with overlap is a sane default.
12. Chunking across a table or a heading boundary, severing the row from its
    header.
13. **No metadata** — no page, no section, no file. A chunk you cannot locate
    is a chunk you cannot cite.
14. **Confusing pages with chunks.** A chunk is a retrieval unit; a page is a
    citation unit. They are not the same and both are needed.
15. **Embeddings where exact search belongs.** Identifiers, error codes,
    function names: BM25 or `LIKE`, not cosine similarity. A stemmer will not
    find `NDA-4417`.
16. **No reranking.** Vector top-k is a rough ordering; a cross-encoder over
    the top ~50 is the cheapest large quality win available.
17. **Sending everything retrieved.** Irrelevant context measurably degrades
    answers and costs money.

**Interface and honesty**

18. **Passing judgement on a file before the user asks.** **[JUNO]** The
    composer said "Couldn't read this file" based on a *search index*, while
    the actual answer depends on the *model* — Claude receives the PDF and
    reads a scan fine. Wrong in both directions.
19. **Telling the model a file is unreadable while handing it the file.**
    **[JUNO]** The system prompt said "no readable text — do not invent
    contents" on turns where the adapter had inlined the PDF two blocks
    earlier. The best case reported as the worst.
20. **No size guard before base64-inlining.** **[JUNO]** Base64 adds a third;
    an oversized PDF failed the whole *turn*, so the user lost the answer, not
    just the attachment.
21. **Expecting the model to reconstruct what you destroyed.** If you flatten a
    table, no amount of prompting recovers the cell relationships.

---

## 8. A production architecture

Every stage: what, why, output, storage, tech, sync/async, failure mode,
recovery.

### Stage 1 — Upload & validate
- **What:** accept bytes; enforce size and type policy; store.
- **Why:** the only step that must be synchronous — the user is waiting.
- **Output:** `attachment{id, name, mime, size, sha256, storage_key}`
- **Store:** object storage (S3/R2). Never the database.
- **Tech:** S3-compatible + presigned or server-side upload.
- **Sync.**
- **Fails:** quota, oversize, unsupported type.
- **Recover:** reject with a specific, actionable message — the type and the
  limit, not "upload failed".
- **Security:** store non-images as `application/octet-stream` with
  `Content-Disposition: attachment` so nothing can ever render inline.

### Stage 2 — Type detection
- **What:** magic bytes first, extension second, declared MIME last.
- **Why:** all three disagree in practice, and the declared type is the least
  reliable.
- **Output:** a canonical type.
- **Sync** (microseconds).
- **Fails:** ambiguous container formats — ZIP is `.docx`, `.xlsx`, `.odt`,
  `.epub` and a zip of holiday photos.
- **Recover:** disambiguate on the inner manifest.

### Stage 3 — Parse & extract structure
- **What:** format-specific parser → typed blocks with locators.
- **Why:** this is where structure is preserved or lost forever.
- **Output:** the document representation in §9.
- **Tech:** PDF — PyMuPDF/pdfplumber (Python) or pdf.js/unpdf (Node). DOCX/XLSX/PPTX
  — python-docx / openpyxl / python-pptx, or direct OOXML (they are ZIP + XML).
  ODT — same shape.
- **Async** for large files; sync for small ones.
- **Fails:** encrypted, corrupt, exotic fonts, XFA forms.
- **Recover:** **the ladder** — native parser → pdf.js → OCR → vision. Never
  let one rung's verdict end the file's life.

### Stage 4 — Page rendering
- **What:** each page → image, ~150 DPI.
- **Why:** the visual channel. Also the OCR front-end, and thumbnails.
- **Output:** one image per page, cached.
- **Store:** object storage, keyed off the source so it is derivable and
  needs no schema change.
- **Tech:** pdftoppm/pdfium/PyMuPDF, or pdf.js + a canvas binding.
- **Async**, lazily — render page *N* when page *N* is wanted. Rendering 500
  pages eagerly to answer one question about page 37 is waste.
- **Fails:** no rasteriser on the platform.
- **Recover:** degrade to text-only and *say so*.

### Stage 5 — OCR (conditional)
- **What:** text from pages with no text layer.
- **Why:** scans. Only scans.
- **Output:** text + per-word confidence + boxes.
- **Tech:** Tesseract (local), or a cloud OCR/document-AI service.
- **Async.**
- **Fails:** no binary; bad scans.
- **Recover:** fall through to the vision channel — a model that can *see* the
  page does not need OCR to answer about it. Mark OCR text with its
  confidence and never mix it with verified embedded text silently.

### Stage 6 — Indexing (conditional)
- **What:** chunk, embed, write to the search indexes.
- **Why:** **only** for documents too large to show whole, or for search across
  a corpus. Not for a 10-page attachment.
- **Output:** chunks with embeddings + full-text vectors + metadata.
- **Store:** Postgres + pgvector, or a dedicated vector DB at scale.
- **Async.**
- **Fails:** embedding provider down; unstorable characters (§7.10).
- **Recover:** retry with backoff; lexical search still works without vectors,
  so degrade to BM25 rather than to nothing.

### Stage 7 — Retrieval & rerank
- **What:** locator filters → BM25 ∥ vectors → RRF → cross-encoder rerank.
- **Output:** ranked blocks + the pages worth showing.
- **Sync** (it is in the request path; budget ~200–500 ms).
- **Fails:** nothing relevant found.
- **Recover:** say so explicitly. "No passage matched" must reach the model, or
  it will fill the silence.

### Stage 8 — Context assembly
- **What:** fit the budget: instructions, question, selected blocks with
  locators, selected page images, history.
- **Why:** the token budget is finite and shared.
- **Sync, deterministic.** No model in this step.
- **Fails:** budget overrun.
- **Recover:** drop lowest-ranked first, and **tell the model what was
  dropped** — silent truncation is how confident wrong answers are made.

### Stage 9 — Generation & citation validation
- **What:** call the model; then verify every citation resolves.
- **Output:** answer + checked citations.
- **Sync.**
- **Fails:** hallucinated locators.
- **Recover:** strip or flag unresolvable citations before display.

---

## 9. A document representation worth having

The problem with "reduce the document to a string" is that every locator,
every type and every relationship is destroyed in one step, and no downstream
component can recover them.

```jsonc
{
  "documentId": "doc_01H…",
  "source": {
    "attachmentId": "att_01H…",
    "fileName": "architecture-review.pdf",
    "mimeType": "application/pdf",
    "sha256": "…",
    "sizeBytes": 4718592
  },
  "metadata": {
    "title": "Platform Architecture Review",
    "author": "…",
    "pageCount": 42,
    "language": "en",
    "producer": "LaTeX with hyperref",
    "hasTextLayer": true,
    "parser": "pdfjs",
    "parserVersion": "3-ladder",
    "extractedAt": "2026-09-22T16:00:00Z",
    "status": "ok"          // ok | degraded | failed
  },

  "sections": [
    { "id": "sec_3", "title": "Authentication", "level": 1,
      "path": ["Architecture", "Authentication"],
      "startPage": 12, "endPage": 19 }
  ],

  "pages": [
    {
      "number": 15,
      "width": 612, "height": 792, "rotation": 0,
      "render": {
        "uri": "s3://…/doc_01H/page-015.jpg",
        "dpi": 150, "width": 1275, "height": 1650
      },
      "hasTextLayer": true,
      "blockIds": ["blk_15_1", "blk_15_7"]
    }
  ],

  "blocks": [
    {
      "id": "blk_15_1",
      "ordinal": 271,               // reading order across the document
      "page": 15,
      "type": "heading",            // heading|paragraph|list_item|table|
                                    // table_cell|code|caption|image|
                                    // slide_title|speaker_notes
      "text": "3.2 Token exchange",
      "headingPath": ["Architecture", "Authentication", "Token exchange"],
      "sectionId": "sec_3",
      "bbox": [72, 648, 468, 24],   // x, y, w, h in page units
      "confidence": 1.0,            // 1.0 embedded text; <1 OCR, as measured
      "source": "embedded"          // embedded | pdfjs | ocr | vision
    },
    {
      "id": "blk_15_7",
      "ordinal": 277,
      "page": 15,
      "type": "image",
      "text": "Figure 4: request path",      // the caption, if any
      "bbox": [72, 300, 468, 280],
      "asset": { "uri": "s3://…/doc_01H/p15-fig4.png", "width": 936, "height": 560 },
      "ocrText": "Database  API server  Frontend",
      "confidence": 0.82,
      "source": "ocr"
    },
    {
      "id": "blk_22_3",
      "ordinal": 402,
      "page": 22,
      "type": "table",
      "text": "Region | Revenue\nOntario | 4,200,000",   // for lexical search
      "table": {                                        // for computation
        "columns": ["Region", "Revenue"],
        "rows": [["Ontario", "4200000"], ["Quebec", "3100000"]]
      },
      "bbox": [72, 420, 468, 120],
      "confidence": 1.0,
      "source": "embedded"
    }
  ],

  "chunks": [
    {
      "id": "chk_19",
      "blockIds": ["blk_15_1", "blk_15_2", "blk_15_3"],
      "text": "3.2 Token exchange\n\nThe service exchanges …",
      "pageStart": 15, "pageEnd": 15,
      "sectionId": "sec_3",
      "tokenCount": 380,
      "embedding": null            // stored in the vector index, not here
    }
  ]
}
```

**Why each field earns its place.** `ordinal` restores reading order after any
query. `bbox` enables cropping a figure and highlighting a citation in a
viewer. `confidence` + `source` keep OCR guesses distinguishable from verified
text — mixing them silently is how a reconstruction becomes a quotation.
`headingPath` gives a chunk its context without re-reading the document.
`chunks.blockIds` is the join that makes citation possible: chunk → blocks →
page. `table.rows` beside `table.text` means the same table can be searched
lexically *and* computed over.

**[JUNO]** `KnowledgeBlock` (`prisma/schema.prisma`) already carries `ordinal`,
`type`, `text`, `page`, `slide`, `sheet`, `cellRange`, `path`, `lineStart`,
`lineEnd`, `heading[]`, `bbox[]` and `confidence` — most of this schema. What
it lacks is a **page render** (no per-page image), a **structured table**
field, and an explicit `source`.

---

## 10. Retrieval for documents

*"What database technology is used and why?"*

Use **hybrid**, and here is the reasoning rather than the recipe:

- **Lexical / BM25** — catches `PostgreSQL`, `pgvector`, `DynamoDB`. Exact
  tokens, no embedding call, no semantic drift. Essential for identifiers,
  error codes, function names, part numbers.
- **Embeddings** — catch "we chose it for its JSONB support" when the question
  said "why", with no lexical overlap at all.
- **Fuse with Reciprocal Rank Fusion** — parameter-free, robust, no score
  normalisation needed between two incomparable scales.
- **Metadata filters first** — "in section 3", "on page 37", "in the appendix"
  are `WHERE` clauses. Applying them before search is both cheaper and more
  correct.
- **Rerank the top ~50 to the top ~8** with a cross-encoder. Bi-encoders embed
  query and document *separately*; a cross-encoder sees both together and is
  markedly better at relevance. This is usually the single biggest quality win
  per unit of effort.

**Why vector search alone is not enough.** Embeddings are lossy by
construction — they compress meaning into a few hundred dimensions, which is
exactly the wrong operation for exact strings. `NDA-4417` and `NDA-4418` are
near-identical vectors and completely different contracts. Cosine similarity
also gives no notion of *sufficiency*: the top-5 are returned whether or not
any of them answers the question, so a retrieval miss is indistinguishable from
the document not containing the answer — and the model will not know which
happened unless you tell it.

---

## 11. Visual retrieval

*"What does the diagram on page 24 show?"*

This question needs **no retrieval at all**. "Page 24" is a locator: filter to
page 24, take its render, send it. Running a semantic search here is a strictly
worse way to answer an exact question — and this is the most common
over-engineering mistake in document QA.

For *"show me the diagram of the auth flow"* — no page given — you need real
visual retrieval. Four workable strategies, cheapest first:

1. **Caption + surrounding text** (cheap, effective). Index "Figure 4: request
   path" and the paragraph that references it. Most figures are captioned, and
   captions are written to be descriptive.
2. **OCR text of the image region.** Catches labels inside the diagram. Store
   it as `ocrText` on the image block, separate from real text so a search hit
   is traceable to a guess.
3. **Model-generated descriptions at index time.** Send each figure to a vision
   model once, store the description, index it. Genuinely effective; costs one
   model call per figure and must be regenerated when the document changes.
4. **Page/image embeddings** (ColPali and similar). Embed the *rendered page*
   in a multimodal space and retrieve by visual similarity. Strongest for
   visually dense documents; heaviest to index; the least mature tooling.

**What to store per page:** the render URI, dimensions, page number, whether it
has a text layer, and the block ids on it. That is enough to answer both "show
me page 24" and "find the page with the auth diagram".

**[JUNO]** Strategies 1 and 2 are available today via the block model;
per-page renders are computed on demand (`src/lib/media/raster.ts`) but not
persisted per page, so 3 and 4 are not yet possible without adding a page-asset
table.

---

## 12. Citations, and not hallucinating page numbers

The provenance chain must be unbroken:

```
document → page 24 → block 7 → chunk 19 → retrieved result → model context → citation
```

Three rules make this work:

1. **Every chunk carries its block ids, and every block carries its page.**
   Locators are propagated, never re-derived. The moment a component recomputes
   a page number, it can be wrong.
2. **The locator is in the prompt, attached to the text.** Label each passage
   `[page 24]` inline. A model cannot cite what it was not told.
3. **Validate after generation.** Parse the citations out of the answer and
   check each against the set actually retrieved. Anything that does not
   resolve is stripped or flagged **before the user sees it.**

Rule 3 is the one people skip, and it is the one that actually prevents
hallucinated page numbers. Rules 1 and 2 make correct citation *possible*;
rule 3 makes incorrect citation *impossible to display*.

A useful extra guard: a citation whose page has no retrieved block is a
fabrication even if the page exists. Check the block, not just the number.

---

## 13. Naïve vs strong, concretely

| Question | Naïve (`PDF → text → chunks → vectors → LLM`) | Strong (dual-channel + hybrid + rerank) |
| --- | --- | --- |
| "What does page 37 say?" | Semantic search for "page 37"; returns whatever is similar to those *words* | Filter `page = 37`; return its blocks and its image |
| Scanned contract | Empty string → "I cannot read this file" | No text layer → page images → model reads it |
| "What does this diagram show?" | `Database API Frontend` | The page image; arrows and all |
| "Find clause NDA-4417" | Cosine similarity returns NDA-4418 | BM25 exact match |
| "Q3 total?" (50k-row sheet) | Truncated cells in context; model does arithmetic badly | pandas in a sandbox; exact |
| Two-column paper | Columns interleaved line by line | Layout analysis keeps column order |
| 500-page report | Everything embedded; retrieval misses | Hierarchical + hybrid + page filter |
| "Does it mention X?" (it does not) | 5 chunks returned regardless; model infers something | "No passage matched" reaches the model |

The second system wins not because it has more components, but because **it
loses less information and it knows what it does not know.**

---

## 14. Where models actually matter

| Task | Right tool | Why not an LLM |
| --- | --- | --- |
| Parse PDF/DOCX/XLSX | Deterministic parser | There is a correct answer; a parser is ~1000× cheaper and does not hallucinate a page number |
| Decode/resize/crop an image | Image library | Same |
| Detect file type | Magic bytes | Same |
| Chunk text | Deterministic, structure-aware | Same |
| OCR | Specialised OCR model | Purpose-built, cheap, gives per-word confidence |
| Embeddings | Embedding model | Definitionally a model task |
| Rerank | Cross-encoder | 100× cheaper than an LLM for the same ordering |
| Describe a figure | VLM | Requires understanding |
| Reason, compare, synthesise | LLM | Requires understanding |

**Why "LLM for everything" is a bad architecture:** cost (orders of magnitude),
latency (seconds vs milliseconds), *non-determinism where determinism is
available* — parsing the same PDF twice should give the same answer — and
debuggability. When a parser is wrong you get a stack trace; when a model is
wrong you get a plausible paragraph.

The corollary, which is Juno's current direction: give the model a **sandbox**
rather than pre-digesting everything. It can then choose the right deterministic
tool per question — pypdf here, pandas there, Pillow for a crop — instead of
you guessing at upload time which one it will need.

---

## 15. A stack, with reasons

| Role | Options | Choose when |
| --- | --- | --- |
| **PDF parse** | PyMuPDF (fast, layout-aware, AGPL), pdfplumber (tables, slow), pdf.js/unpdf (Node, no native deps) | PyMuPDF if Python and licence permits; unpdf if you are Node-only |
| **Page render** | pdftoppm (poppler), PyMuPDF, pdfium, pdf.js + canvas | Whatever avoids a system binary if you deploy to serverless |
| **DOCX/PPTX/XLSX** | python-docx / python-pptx / openpyxl; or direct OOXML | They are ZIP + XML — direct parsing is very feasible and dependency-free |
| **OCR** | Tesseract (free, decent), PaddleOCR (better on tables), cloud document AI (best, costs) | Tesseract until accuracy actually blocks you |
| **Images** | Pillow, sharp, @napi-rs/canvas | Language fit |
| **Embeddings** | OpenAI `text-embedding-3`, Cohere, BGE/E5 self-hosted | Hosted until volume or privacy says otherwise |
| **Vector store** | pgvector, Qdrant, Weaviate, LanceDB | **pgvector if you already run Postgres** — one datastore beats two |
| **Lexical** | Postgres full-text, OpenSearch, Typesense | Postgres FTS is enough far longer than people expect |
| **Rerank** | Cohere Rerank, BGE-reranker, cross-encoder/ms-marco | Hosted first; it is a small cost for a large gain |
| **Multimodal LLM** | Claude, GPT, Gemini — all take PDFs natively | Use the native document part; do not pre-flatten |
| **Object storage** | S3/R2/GCS | Never the database |
| **Async** | Celery/RQ, BullMQ, Temporal, or the platform's own | Temporal when retries and long pipelines matter |
| **Code sandbox** | E2B, Modal, Firecracker, gVisor | **Never a subprocess on the app host** — see below |

**The sandbox point is a security point, not a preference.** Model-written code
executing documents supplied by strangers must not run next to your provider
keys, your database credentials and other tenants' files. A prompt injection in
a PDF becomes arbitrary execution on your application server. Use a remote,
isolated sandbox or do not offer the capability.

---

## 16. Reviewing Juno specifically

The audit ran against this repository, so this section is a review rather than
a request for code.

### What was wrong (all now fixed, on this branch)

| # | Defect | Symptom |
| --- | --- | --- |
| 1 | Extraction ran at upload and its verdict was permanent | "COULDN'T READ THIS FILE" for readable PDFs |
| 2 | pdf.js rescue rung unreachable from `failed` | Permissions-encrypted PDFs (most government forms) lost |
| 3 | pdf.js transfers its input buffer (`16978 → 0`) | OCR silently received an empty file, always |
| 4 | `.docx`/`.xlsx`/`.pptx` refused at upload | Working extractors behind a wall |
| 5 | Gate judged MIME, router judged extension | Same file accepted from macOS, 415'd from Linux |
| 6 | OpenAI never sent `input_file` | GPT models could not read any PDF |
| 7 | "Unreadable" note sent to models holding the PDF | Best case reported as worst |
| 8 | No size guard before base64 inlining | Oversized PDF failed the whole turn |
| 9 | NUL bytes reached Postgres | One byte failed `createMany` for a whole document |
| 10 | Readiness UI judged on the index, not the model | Wrong in both directions |

### Where Juno now sits against this document

**Good:** dual-channel for Anthropic/Gemini/OpenAI-Responses (native document
parts); page rendering available in-process with no system binary; a block
model with real locators; on-demand reading rather than upload-time; tools that
let the model navigate a file itself; a sandbox path that is correctly gated.

**Gaps, in priority order:**

| Priority | Gap | Impact | Complexity | Cost |
| --- | --- | --- | --- | --- |
| **1** | No remote sandbox configured — `code_interpreter` is inert | High: no spreadsheet computation, no model-written parsing | Low (provision + 2 env vars) | Sandbox hosting |
| **2** | No reranker | High: retrieval quality for project corpora | Low (one API call) | Small per query |
| **3** | Page renders not persisted per page | Medium: blocks visual retrieval and cheap re-reads | Medium (a page-asset table) | Storage |
| **4** | No structured table field on blocks | Medium: tables are searchable but not computable | Medium | — |
| **5** | OCR needs binaries that are absent | Medium: scans depend entirely on the vision channel | Medium | — |
| **6** | `.doc/.xls/.ppt`, `.epub`, `.heic`, `.tiff` unsupported | Low–medium | Medium (converters) | — |
| **7** | Hierarchical summaries for very large documents | Low until users upload 500-page PDFs | High | Model calls |

### Migration path — additive, not a rewrite

1. **Provision a sandbox.** Set `CODE_INTERPRETER_URL` + token. The tool is
   already written and gated; nothing else changes. Biggest capability gain per
   hour spent.
2. **Add a reranker** between retrieval and context assembly. One call, one
   function, no schema change.
3. **Persist page renders** — a `KnowledgePage` row with `{documentId, number,
   uri, width, height, hasTextLayer}`. Unblocks visual retrieval and makes
   re-reads free.
4. **Add `table` and `source` to blocks.** Additive columns; extractors fill
   them when they can.
5. **Then** consider hierarchical summaries and page embeddings — and only if
   real documents demand them.

Nothing here requires touching what already works.

---

## The mental model I should remember

1. **Dual channel.** Text *and* pixels, per page, together. **[DOC]** — this is
   the single most important design fact.
2. **Never gate on `text.length > 0`.** That check is what produces "couldn't
   read this file" for documents that read perfectly.
3. **Read when asked, not when stored.** At upload there is no question, no
   model and no reason — every verdict made then is a guess that becomes
   permanent.
4. **Parsers for parsing, models for understanding.** Using an LLM where a
   parser works costs 1000× and hallucinates.
5. **A ladder, never a gate.** Native parser → better parser → OCR → vision. No
   single rung's failure may end the file's life.
6. **Locators are the product.** Page, section, line. A chunk you cannot locate
   is a chunk you cannot cite.
7. **Retrieval is a scaling strategy, not a reading strategy.** If it fits,
   send it whole.
8. **Hybrid beats vectors.** Exact strings need BM25; meaning needs embeddings;
   you need both, fused.
9. **Rerank.** The cheapest large quality win in the whole pipeline.
10. **An explicit locator short-circuits retrieval.** "Page 37" is a `WHERE`
    clause, not a search query.
11. **Structure once destroyed is never recovered.** No prompt rebuilds a
    flattened table.
12. **Distinguish verified text from reconstructed text.** OCR carries
    confidence; embedded text does not need it. Never merge them silently.
13. **Say what you dropped.** Silent truncation manufactures confident wrong
    answers.
14. **Validate citations after generation.** The only reliable defence against
    hallucinated page numbers.
15. **Sandbox anything the model writes**, remotely. A prompt injection in a
    PDF must not become code execution on your host.

---

## What to send next, if you want a deeper review

The audit covered this repository, so the review above is based on the real
code rather than a description of it. To go further, the most useful things
would be:

1. **Three real files that failed** — ideally the original PDF that produced
   "COULDN'T READ THIS FILE". Every fix so far targets a defect *class*; a real
   failing file is worth more than the entire list.
2. **A production log line** from a failed extraction (parser, state, reason).
3. **Answers to two product questions:** what is the largest document a user
   should be able to upload, and do you want cross-document search within a
   project, or only per-file reading?
4. **Whether a sandbox budget exists.** It determines whether item 1 of the
   migration path is a two-hour task or a non-starter.
