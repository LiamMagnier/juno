# Files, Vision and Deliverables: depth audit (Alevr vs ChatGPT and Claude)

Date: 31 Oct 2026. Repo: `/home/user/juno` (read-only). Scope: what you can upload and how big, how well vision works (scans, OCR, image detail, many images), how good the generated docx/xlsx/pptx are (styles, charts, tables, speaker notes, templates), image generation and editing, and how faithfully artifacts get edited.

Not re-specified here because other workstreams are building them: share with specific people, per-chat memory off, AI-powered artifacts and storage, PDF/Google Docs/Slides export, locked chats, Drive/OneDrive attach, connectors in voice, tone sliders, MCP Apps widgets, plugins, and the UI/motion redesign. This audit mentions UI only where a feature cannot exist without it.

**Research caveat.** `help.openai.com` (and its mirror `help-lb.openai.com`) cannot be reached from this session: DNS fails, so the host must be allowed in the session's network settings. The OpenAI facts below come from search-engine copies of those help pages and from press coverage, and each one is marked. The Claude facts come from pages fetched directly from `support.claude.com`, `claude.com` and `platform.claude.com`.

---

## 1. Competitor baseline (late Oct 2026)

**ChatGPT**
- **Uploads:** 512 MB per file and 2M tokens per text or document file. Spreadsheets are capped at about 50 MB and images at 20 MB. There is a 25 GB per-user storage cap and a rolling limit of about 80 files every 3 hours [O1, search copy].
- **Images inside PDFs:** "Visual Retrieval" (reading the images and charts in a PDF) is **Enterprise-only**. Other plans extract text only [O2, search copy].
- **Audio:** audio uploads are on paid plans, up to 512 MB, in WAV, MP3, OGG, FLAC, AAC, M4A, audio-only MP4 and audio-only WebM. **Video files are rejected** [O3, search copy].
- **Documents:** ChatGPT Work (9 Jul 2026) creates and edits documents, spreadsheets and presentations; you select a part and describe the change [O4]. ChatGPT Slides (16 Oct 2026) offers templates, co-editing and export to PowerPoint, PDF and Google Slides. It is limited to Pro, Business and Enterprise, and one source mentions speaker notes [O5]. ChatGPT for Excel edits formulas, formatting and charts inside Excel [O6].
- **Images:** Images 2.5 (8–9 Sep 2026) adds an Edit toolbar with **Remove BG, Resize (to aspect presets), Erase, Markup, Comment**. It produces transparent PNGs and supports aspect ratios from 3:1 to 1:3 [O7].
- **Vision API:** `detail: "original"` exists on GPT-5.4 and later. On GPT-5.5 and GPT-5.6, `auto` means original. On GPT-5.6 the image is not resized, up to a 30k-patch limit [O8].

**Claude**
- **Chat uploads:** 500 MB per file, **20 files per chat**, images up to 8000×8000, PDFs up to 1000 pages. PDFs of 100 pages or fewer get full visual analysis; pages 101 to 1000 are read as text only. Accepted types are PDF, DOCX, CSV, TXT, **HTML**, ODT, RTF, **EPUB**, JSON and XLSX. Non-PDF documents are text-only [C1, fetched, dated 23 Jul 2026].
- **File creation:** Claude creates xlsx (formulas, multiple sheets, charts), docx, pptx and pdf in a sandbox. Files up to 30 MB can be uploaded or downloaded, and PDFs over 30 MB are processed in the sandbox [C2, fetched]. Since 9 Sep 2025 it can also "create and edit" files and convert between formats, for example PDF to slides [C3, fetched].
- **Docs, Slides and Designs** (all plans, 16 Sep 2026): you can type directly, "Edit any slide directly", highlight text and use "Edit with Claude", comment on decks, "present without leaving Claude", and apply design systems (colours, fonts, components). Export goes to Word, PDF, Markdown, Google Docs, PowerPoint and Google Slides [C4, fetched]. Claude Slides writes speaker notes [C5, third-party].
- **Vision API:** 10 MB per image on the Claude API (5 MB on Bedrock). Up to 600 images per request. **Above 20 images, any image larger than 3000 px is rejected.** Opus 4.7 and later read high-resolution images up to 2576 px [C6, fetched]. PDFs are limited to 600 pages per request (100 below a 1M-token context), and each page is charged as text plus an image [C7, fetched].
- **No native image generation** (as already noted in parity-gap.md, [P7]).

---

## 2. Capability-by-capability table

Gap key: **missing** (Alevr lacks it), **weaker**, **equal**, **ahead**. Evidence is `file:line` in `/home/user/juno`.

### A. Upload breadth and limits

| Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|
| Per-file size cap | 512 MB on all plans; sheets about 50 MB; images 20 MB [O1] | 500 MB in chat, 30 MB for project files [C1] | Free 5 MB, Lite 10, Pro 20, Plus/Max/Max20 50, Ultra 200, Owner 1000 (`src/lib/plans.ts:70,93,116,141,168,198,223,248`). Proxy ceiling is 120 MB (`deploy/nginx.conf.template:63`, `next.config.mjs:108`), so the Ultra and Owner caps cannot be reached and anything over 120 MB gets nginx's HTML 413. The whole file is buffered in memory (`src/app/api/upload/route.ts:68`) and the route has `maxDuration 30` (`:17`). Nothing uploads straight to the bucket and nothing resumes | **weaker** (10–100× smaller caps; large files break) |
| Files per message | about 80 per 3 h rolling [O1]; per-message cap not confirmed | 20 per chat; 20 images per turn [C1][C6] | 10 per message (`src/lib/uploads.ts:4`) | **weaker** |
| PDF with images and charts (visual) | Enterprise only; other plans text-only [O2] | ≤100 pages visual, 101–1000 text [C1] | Raw PDF inlined for Anthropic, Gemini and OpenAI Responses when ≤12 MB (`src/lib/attachment-bytes.ts:36`, `src/lib/anthropic.ts:174`, `src/lib/gemini-core.ts:113`, `src/lib/openai-responses.ts:144-168`). For compat models, the first 4 pages are rasterised when there is no text layer (`src/lib/openai-compat.ts:128-160`). Over 12 MB it falls back to text. No page-count guard before inlining | **ahead on all plans** for ≤12 MB; weaker above that |
| Scanned-PDF OCR (for indexing, projects, compat models) | not documented (the model's vision does it) | same | OCR is only `JUNO_OCR_ENDPOINT` or `pdftoppm`+`tesseract` (`src/lib/knowledge/ocr.ts:20,97-102`). The deploy scripts install neither (`deploy/` has no apt step for them). Result: project scans index as nothing, and Grok/DeepSeek-class models see only 4 pages | **weaker** |
| Spreadsheets, many sheets | about 50 MB; Python analysis [O1] | XLSX needs code execution [C1] | Extractor walks every sheet but only **5,000 rows per sheet** (`src/lib/knowledge/extract/xlsx.ts:29`). It keeps A1 locators and formula text (`:97-110`). Analysis is `run_code`, which only works where a sandbox is configured (parity-gap row "Hosted code execution") | **equal** with a sandbox, **weaker** without |
| Images embedded in DOCX/PPTX | not confirmed | text-only for non-PDF [C1] | Text-only (`extract/docx.ts`, `extract/pptx.ts`) | **equal** (a chance to get ahead) |
| Audio files | paid, 512 MB [O3] | no | Refused: no audio type is accepted (`src/lib/uploads.ts:6,49-61,88-99`), and `selectExtractor` returns null for audio/video (`src/lib/knowledge/extract/index.ts:94`). The sniffers already exist (`uploads.ts:280,319`) | **missing** vs ChatGPT |
| Video files | rejected [O3] | no | Refused (same lines) | **equal** (a chance to get ahead: Gemini reads video natively) |
| ZIP archives | not confirmed | not listed [C1] | Refused (not in `READABLE_EXTENSIONS`, `uploads.ts:88-99`) | **equal**, opportunity |
| HTML / EPUB | not confirmed | both accepted [C1] | HTML/SVG refused by type and name (`uploads.ts:64,74`). EPUB is absent | **weaker** vs Claude |
| HEIC photos | not confirmed | not confirmed | Refused on the server (`uploads.ts:264-270`). Safari converts in the composer; the native apps transcode | **weaker** on Chrome/Firefox |
| Paging through long documents | not documented | not documented | `read_document` offers list, outline, read by page range or offset, and search (`src/lib/tools/specs/read-document.ts:55-75`). A cut-off document says so (`src/lib/attachment-context.ts:53-56`) | **ahead** |

### B. Vision quality

| Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|
| Image size and resolution handling | images up to 20 MB [O1]; GPT-5.5/5.6 default to original resolution [O8] | 10 MB per image via the API (5 MB on Bedrock); >20 images → 3000 px cap; 2576 px high-res [C6] | **Raw bytes go to every provider, with no EXIF rotation, downscale or re-encode**: Anthropic (`src/lib/anthropic.ts:149-160`), Gemini (`src/lib/gemini-core.ts:96-101`), Responses with `detail: "auto"` (`src/lib/openai-responses.ts:137-141`). Image caps follow the plan (up to 50–1000 MB). The lookback re-embeds images from the last 8 messages × 10 attachments (`anthropic.ts:65`, `uploads.ts:4`). So a 12 MB PNG, or 21+ phone photos, fails the **whole turn** on Claude, and every GPT-5.6 photo is billed at full resolution | **weaker** (reliability and cost) |
| Zoom and crop "thinking with images" | yes (o-series; not re-verified) | not documented | `inspect_image` crops, magnifies, converts to grayscale, raises contrast and rotates images and PDF pages (`src/lib/tools/specs/inspect-image.ts:54`) | **equal/ahead** |
| Many images in one turn | not confirmed | 20 per turn | 10 per message (`uploads.ts:4`). Tool images are capped at 4 per round (`src/lib/tool-result-images.ts:30`) | **weaker** |
| Detail control | not user-facing | not user-facing | Fixed: `auto` for attachments, `high` for tool images (`openai-responses.ts:140,766`). No Gemini `media_resolution` | **equal** for users; internal gap |

### C. Document creation and editing

| Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|
| DOCX quality | Work docs [O4] | python skills; Docs template exports to Word [C2][C4] | Semantic document model: headings ≤4, paragraph styles normal/lead/quote, lists, tables (200 rows), callouts, figures, interactive blocks, page breaks, citations rendered as References, Word comments and **tracked revisions** (`src/lib/work/deliverables/semantic/document/model.ts:40-51,91-145`; `document/docx-export.ts:6,141-143,195-201,596`). **No TOC, header, footer or page numbers** (grep finds none in `docx-export.ts`). **No chart block.** A figure must be a data URI or an https link (`model.ts:126-134`), so in practice the model cannot place an image | **weaker** on polish; **ahead** on tracked changes and comments |
| XLSX quality | Work and Excel add-in: formulas, formatting, charts [O4][O6] | formulas, many sheets, charts [C2][C3] | Real formula engine with live recalculation. It knows **38 functions** (`workbook/formula.ts:797-1127`): no XLOOKUP, SUMIFS, COUNTIFS, IFS, DATE/EOMONTH or IRR/XIRR. It has number formats, frozen panes, tables with filters, **native DrawingML charts** (`workbook/xlsx.ts:7-10,141-190`) and 64 sheets. **Styling is bold only** (`workbook/model.ts:86-97`): no fills, borders, colours, alignment, merges, conditional formatting or validation. On import, merges and notes are dropped (`semantic/export.ts:63-65`) | **weaker** on formatting and function breadth; **ahead** on live recalculation |
| PPTX quality | Slides: templates, co-edit, present [O5] | Slides: direct edit, present, design systems, notes [C4][C5] | Deck model has **6 layouts** (`deck/model.ts:37-44`), theme, master, speaker notes (`pptx-export.ts:483`), charts, tables, shapes and shrink-to-fit (`deck/fit.ts`). **https images are never fetched and become placeholder rectangles** (`pptx-export.ts:16,297-318`). The model cannot place an uploaded or generated image. The legacy Markdown path turns tables into pipe-joined bullet lines (`src/lib/office-export.ts:809-811`) | **weaker** visually |
| Edit a user's uploaded Office file | Work edits files [O4] | "create and edit" [C3] | `importSemanticFile` (xlsx/docx → editable artifact) **is built but has no caller** (`src/lib/work/deliverables/semantic/export.ts:51`; repo grep finds callers only in tests). There is no pptx import | **missing** (built but unwired) |
| Templates, brand, design system | built-in templates [O5] | design systems [C4] | Theme colours and fonts per artifact only (`deck/model.ts:112-127`, `document/model.ts:264-274`). No template or brand import | **missing** |
| Chat-driven edits | select part + describe [O4] | highlight → "Edit with Claude" [C4] | Semantic artifacts are edited with ops (`src/lib/artifact-ops.ts:1-21`; ops listed at `src/lib/chat/system-prompt.ts:376`). **Code, HTML, React and Markdown artifacts are re-emitted complete on every revision** (`system-prompt.ts:316,508-509`; `src/lib/chat/prompt-sections.ts:85`). Search/replace patches exist only in the canvas "Modify" flow (`src/lib/artifact-edit.ts:1-8,40-41`) | **ahead** for sheets/docs/decks; **weaker** for code/HTML (slow, expensive, risk of drift) |
| Direct editing and presenting | Slides co-edit, present [O5] | type in docs, edit slides, present [C4] | Spreadsheet cells can be edited (`src/components/semantic/spreadsheet-view.tsx:39-46,183`). The document view only accepts or rejects revisions and resolves comments (`document-view.tsx`). The deck view only moves or duplicates slides; notes are read-only and there is no present mode (`deck-view.tsx:241,290`). There are no native semantic views (`src/lib/capabilities.ts:620-621`) | **weaker** |
| Export verification | not documented | not documented | Every export is reopened and checked before it is served (`src/app/api/artifacts/[id]/export/route.ts:131-140`, `src/lib/office-export-verify.ts`) | **ahead** |

### D. Image generation and editing

| Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|
| Generation controls | Images 2.5: aspect 3:1–1:3, transparent [O7] | none [P7] | GPT Image 2.5/2/1, Gemini, MiniMax, Grok. Aspect, resolution, quality up to `max`, up to 10 outputs, transparent background (`src/lib/media-params.ts:240-311`). Chat can call `generate_image` (`src/lib/tools/specs/generate-image.prompt.ts`) | **equal** vs ChatGPT, **ahead** vs Claude |
| Edit toolbar | Remove BG, Resize, Erase, Markup, Comment [O7] | none | Eraser mask and region select (`src/components/chat/image-edit-overlay.tsx:7-14`), variations (`image-generation-card.tsx:174`), chat edits with `reference: "latest"` | **weaker** (no remove-BG, resize/expand, markup) |
| Several reference images (compose) | supported by the gpt-image API (not re-verified here) | none | Single source image (`src/lib/image-gen.ts:244-256`; `reference` is one id in `generate-image.prompt.ts`) | **weaker** |
| Images in deliverables | Slides templates with imagery (press) [O5] | Designs and Slides | Not possible: decks and docs cannot reference uploads or generated images (see row C) | **missing** |

---

## 3. Ranked improvements

The ranking weighs how much users will feel each change against its cost. FV-1 and FV-4 also cut API spend directly, which serves the owner's "cheaper API calls" goal.

### FV-1. Model-aware vision pipeline (prepare every image for the model that will read it)

- **What users notice.** Big photos, retina screenshots and 20-photo turns stop failing on Claude. Answers start sooner because there is less payload to send. Small text in screenshots and receipts still reads correctly. Image-heavy turns on GPT-5.x cost less.
- **Competitor evidence.** Claude rejects images over 10 MB (5 MB on Bedrock), and rejects anything over 3000 px once a request holds more than 20 images. High-resolution reading tops out at 2576 px [C6]. On GPT-5.6, `auto` means original resolution with no resize, up to 30k patches [O8]. Both providers recommend resizing first [C6].
- **Code today.** Raw bytes are sent everywhere: `anthropic.ts:149-160`, `gemini-core.ts:96-101`, `openai-responses.ts:137-141`, plus the compat image path. The lookback window is set in `anthropic.ts:65` and `openai-responses.ts:93`. The 10-per-message cap is `uploads.ts:4`. Tool images are handled in `tool-result-images.ts:30-40`. `sharp` is already a dependency (`package.json:199`).
- **Implementation sketch.**
  1. Create `src/lib/vision/prepare.ts` with `prepareImageForModel({ bytes, mime, model, purpose: "photo"|"document"|"screenshot"|"tool", imagesInRequest })`. It returns `{ bytes, mime, width, height, detail }`. It uses sharp to apply EXIF rotation, scale the long edge to the model's native maximum, and re-encode (JPEG q85 for photos; PNG/WebP when there is alpha or a lot of text). It also enforces a per-provider byte ceiling: about 7 MB raw for Anthropic, about 3.5 MB for Bedrock, 20 MB per request for Gemini inline.
  2. Add a `visionProfile` to each model def in `src/lib/models.ts`, read through `model-capability.ts`. Fields: `{ maxLongEdge, maxB64Bytes, manyImageThreshold: 20, manyImageMaxEdge: 2000, openaiDetail, geminiMediaResolution }`.
  3. Store derivatives under `derived/<attachmentId>/<version>/<profileKey>.jpg`, optionally recorded in an `AttachmentDerivative` table (attachmentId, version, profileKey, storageKey, width, height, size). Deterministic bytes keep the provider's prompt cache warm from turn to turn.
  4. Budget across the request: count every image block in the lookback. Over the threshold, shrink to `manyImageMaxEdge`, and turn the oldest images into text placeholders first.
  5. Detail policy: send `high` for ordinary photos. Send `original` / Gemini `high` when the image looks like a document or screenshot (an edge-density heuristic) or when the user asks to read, transcribe or check small print. `inspect_image` keeps working on the originals, so zooming loses nothing.
  6. Raise `MAX_ATTACHMENTS` to 20 once the budget exists.
- **Acceptance tests.**
  - Unit (`tests/vision-prepare.test.ts`): an 18 MB, 6000×4000 PNG becomes an Anthropic block under 10 MB base64 with long edge ≤2576. A 25-image lookback sends every image at ≤2000 px. An EXIF-rotated JPEG arrives upright. Preparing the same attachment twice gives identical bytes (cache hit). A photo gets `detail: "high"`; a document-like screenshot gets `original`.
  - Integration: a Claude Sonnet 5.5 turn with 20 iPhone photos succeeds; today it fails.
  - Eval: a 30-item vision set (receipts, charts, dense UI screenshots, handwriting) shows no accuracy loss, and GPT-5.6 input tokens on photo turns fall by at least 40%.
- **Size** M. **Impact** H.
- **Risks.** Over-downscaling can hurt OCR (mitigated by the `original` policy and `inspect_image`). Animated GIFs: keep the first frame and say so. CPU load (sharp is fast and the cache absorbs repeats).

### FV-4. Patch-based edits for every text artifact in chat (code, HTML, React, Markdown, SVG, Mermaid)

- **What users notice.** "Make the header sticky" on an 800-line app updates in seconds instead of re-streaming the whole file. Untouched code stays byte-identical, so no surprise regressions. Edits use roughly 10× fewer output tokens.
- **Competitor evidence.** Claude edits artifacts in place: "Claude makes the edit where you marked it" [C4]. ChatGPT Work edits the selected part [O4].
- **Code today.** The prompt requires a complete re-emit (`src/lib/chat/system-prompt.ts:316,508-509`; `src/lib/chat/prompt-sections.ts:85`). A validated search/replace protocol already exists, but only for the canvas "Modify" route (`src/lib/artifact-edit.ts:1-8,40-41`, `MAX_EDITS=12`). Ops for semantic artifacts are resolved in the turn (`src/lib/chat/turn/run-turn.ts:1014`). `src/lib/line-diff.ts` exists.
- **Implementation sketch.**
  1. Add a chat-level tag, `<juno:artifact-patch identifier="…">{"summary":"…","edits":[{"search":"…","replace":"…"}]}</juno:artifact-patch>`.
  2. Resolve it in `run-turn.ts` next to `resolveArtifactOps`, reusing `parseArtifactPatch` and the apply logic from `artifact-edit.ts`. Then rewrite it into the ordinary artifact tag, so verification, the re-emit guard, version append and Library all keep working unchanged.
  3. When an anchor misses (it is not unique, or not found), run one automatic repair round that gives the model the failing anchors and the current source around them. If that also fails, fall back to a full re-emit.
  4. Prompt rule: use a patch when the change touches less than about 30% of the artifact; re-emit only for rewrites.
  5. Streaming: show the patch as a diff in canvas while it streams (reuse `line-diff.ts`), and add a "Changes" view in version history.
  6. Metrics: output tokens per revision and time to the updated preview (`src/lib/metering`).
- **Acceptance tests.**
  - Unit: a patch on a fixture applies only to the matched ranges, and `lineDiff(vN, vN+1)` touches only those lines. An ambiguous anchor is refused with a clear message. The repair round succeeds on a whitespace-drift fixture.
  - Integration (`tests/artifact-patch-chat.integration.test.ts`): a 3-turn React artifact edit stores three versions; restore works; a person's newer canvas edit turns the patch into a suggestion.
  - Eval: across 50 real edit prompts, at least 95% apply with no change outside intent, and median output tokens are at most 15% of a full re-emit.
- **Size** M. **Impact** H (speed, fidelity, cost).
- **Risks.** Models over-using patches for large rewrites (the threshold rule plus the fallback handle it). Anchors drifting when the user edited the artifact between turns (apply against the current version, as ops already do).

### FV-3. Open and edit the user's own Office files (xlsx, docx, then pptx), keeping their formatting

- **What users notice.** "Here's our budget.xlsx, raise prices 5% and add a margin column" gives back **their workbook**, with formulas recalculated and the other sheets untouched. "Fix the typos in contract.docx" gives back their document with its header, footer and styles intact, and the fixes as tracked changes.
- **Competitor evidence.** ChatGPT Work creates or edits documents and spreadsheets, and the Excel add-in edits formulas, formatting and charts [O4][O6]. Claude "can create and edit Excel spreadsheets, documents, PowerPoint…" [C3].
- **Code today.** `importSemanticFile` is built, tested only in tests, and never called (`src/lib/work/deliverables/semantic/export.ts:51-76`). The xlsx and docx readers exist (`workbook/xlsx.ts`, `document/docx-export.ts`). There is no pptx import ("readback recovers text and chart data", `export.ts:46-49`). Ops editing is in `artifact-ops.ts`.
- **Implementation sketch.**
  1. Add `POST /api/attachments/[id]/open-as-artifact`. It checks ownership, calls `importSemanticFile`, creates an `Artifact` (type SPREADSHEET/DOCUMENT/PRESENTATION) with version 1, and stores the import notes. Add `sourceAttachmentId` to the `Artifact` model in `prisma/schema.prisma`.
  2. Add a model tool `open_file_for_editing` in `src/lib/tools/specs/` so the model opens the file whenever the user asks to change an uploaded Office file, then edits with `<juno:artifact-ops>`. Add an "Open as editable" action on the attachment chip.
  3. **Preserve mode for docx** (the real quality win). At import, record for each block its ordinal `w:p` path in the source. On export, if every change since import is text-level (`updateText`, `replaceBlock` on text blocks, revisions), patch only those paragraphs inside the original package with jszip and write them as `w:ins`/`w:del`. Otherwise regenerate the file and say that formatting may change.
  4. Write `deck/pptx-import.ts` (pptx/potx → DeckModel). It maps slide layouts to the nearest `DeckLayout`, reads placeholders, `a:tbl` tables, `c:chart` parts (series plus cached values), `ppt/media` images (size-capped data URIs), `notesSlides` and `theme1.xml` colours and fonts. Unmapped shapes are reported in the notes, the same way xlsx reports dropped merges.
  5. Fix the import losses: carry merges and cell notes into the workbook model (ties into FV-8).
- **Acceptance tests.**
  - A 3-sheet xlsx with formulas, opened and edited with "raise Inputs!B4 by 5%", produces exactly one `setCell` op. The download reopens in LibreOffice (`scripts/workflow-bench.ts` office reopen) with the dependent cells recalculated and other sheets' values identical.
  - A docx with a custom header, footer and heading styles, after "fix typos", comes back with a diff of `word/document.xml` limited to the touched `w:p`, and the header and footer parts byte-identical.
  - A pptx round trip keeps the slide count, notes and chart series values.
  - The import report lists dropped items.
- **Size** L (xlsx/docx wiring S, preserve-mode docx M, pptx import M-L). **Impact** H.
- **Risks.** Complex docx (content controls, fields, nested tables): detect these and use regenerate mode with a warning. Large workbooks over the 200k-cell limit (`workbook/model.ts:51`): offer `run_code` instead.

### FV-5. Visually rich decks and documents (real images, charts in docs, polish, design QA)

- **What users notice.** "Make a 10-slide pitch deck with visuals" produces slides with real photos or generated art, more varied layouts (KPI, quote, timeline, image-left/right, full-bleed) and no overflow. Word reports get a table of contents, page numbers, headers and footers, and native charts.
- **Competitor evidence.** ChatGPT Slides has built-in templates and editable PPTX export [O5]. Claude Slides and Designs apply design systems [C4][C5]. Claude's xlsx output has charts [C2].
- **Code today.** https images become placeholders and are never fetched (`deck/pptx-export.ts:16,297-318`). Image sources must be a data URI or an https URL (`semantic/shared.ts:98-106`). There are 6 layouts (`deck/model.ts:37-44`). Document blocks include no chart (`document/model.ts:91-145`). The docx has no TOC, header, footer or page numbers (`document/docx-export.ts`). Legacy Markdown decks flatten tables (`office-export.ts:809-811`). `fit.ts` already computes overflow. The `generate_image` pipeline exists (`src/lib/media/generation-pipeline.ts`).
- **Implementation sketch.**
  1. **Asset references.** Accept `src: "asset:<attachmentId>"` and `"gen:<generationId>"` in deck image elements and document figures (`isAllowedImageSource`). Resolve them with an ownership check for preview (`/api/files/...`) and embed the bytes at export. Fetch https images server-side through the SSRF-safe fetch (`src/lib/mcp-safe-fetch.ts`) with size and type caps, instead of drawing placeholders.
  2. **Imagery inside decks.** Add a deck op `generateImage {slideId, elementId?, prompt, aspect}` that runs the image pipeline, saves the result to the Library and sets `gen:` on the element. Update the system prompt to suggest imagery on title, section and image layouts.
  3. **Chart block for documents.** Add `{type:"chart", chartType, categories, series, caption}`, reusing `deck/model.ts` `chartSchema`. Preview it with `SemanticChart`. In DOCX, write a native chart part injected after packing (the same technique as `workbook/xlsx.ts` `injectCharts`), with a PNG fallback rendered through `@napi-rs/canvas`.
  4. **DOCX polish.** Add a TOC field when there are 3 or more H1/H2, header and footer with title and page numbers (`docx` Header/Footer/PageNumber), and `styles` for page size (A4/Letter), margins and heading colour.
  5. **Layouts and themes.** Add 8 layouts (agenda, big-number, quote, image-left, image-right, full-bleed, comparison, timeline) to `DECK_LAYOUTS`, plus 6 curated theme presets.
  6. **Design QA.** Add `deck/lint.ts`, a deterministic check for overflow (from `fit.ts`), font size under the minimum, text/background contrast below WCAG AA, more than 6 bullets, empty regions and distorted image aspect. Feed the warnings back into the same turn for one automatic ops fix, and show the user a "Checked" badge.
  7. Convert Markdown to a semantic deck before the legacy pptx export.
- **Acceptance tests.**
  - The pitch-deck prompt yields at least 5 slides with embedded `ppt/media/*`, 0 placeholders and 0 lint errors.
  - A doc with a chart block exports a docx whose chart opens as a native chart in LibreOffice.
  - A TOC and footer page numbers are present.
  - A blind human preference test on 10 prompts against ChatGPT Slides and Claude Slides reaches at least parity.
- **Size** L. **Impact** H.
- **Risks.** Image generation spend inside decks: meter it and count it toward the plan's media quota. Copyright of fetched https images: keep the source URL in alt text and notes.

### FV-2. Large uploads that work: direct-to-bucket, resumable, competitor-class caps

- **What users notice.** A 300 MB PDF, a long recording or a big dataset uploads with a progress bar and survives a flaky connection or a tab reload. Free users can attach a normal report: 5 MB today is smaller than a single phone photo.
- **Competitor evidence.** ChatGPT allows 512 MB per file [O1]; Claude allows 500 MB in chat [C1].
- **Code today.** The caps are in `plans.ts:70-248`. The 120 MB proxy ceiling (`nginx.conf.template:63`, `next.config.mjs:108`) is below the Ultra and Owner caps. The route buffers in memory (`upload/route.ts:32-68`). Storage is S3-compatible (`src/lib/storage.ts:5-11`), `@aws-sdk/s3-request-presigner` is already installed (`package.json:141`), and `headObject(key, prefixBytes)` exists for sniffing (`storage.ts:123`).
- **Implementation sketch.**
  1. Add an `UploadSession` model (id, userId, storageKey, fileName, declaredMime, size, partSize, conversationId, projectId, status, expiresAt).
  2. `POST /api/uploads/sessions` starts an S3 multipart upload and returns presigned part URLs. The key is forced under the user's prefix, and the content type is forced to `application/octet-stream` with disposition attachment.
  3. `POST /api/uploads/sessions/[id]/complete` completes the upload, `headObject`s the first 4 KB, runs the existing sniff and plan logic (refactor `planAttachmentUpload` to take a prefix plus a size), checks the real size against the cap and deletes the object if it is over, takes the quota lock (`lockedLibraryCapacity`), and creates `Attachment` + `AttachmentVersion`. Verified images are copied to their sniffed type.
  4. The client uploads parts in parallel with retries and resumes from a session id kept in IndexedDB. iOS and macOS use background `URLSession` upload tasks against the same API.
  5. Add a bucket lifecycle rule (AbortIncompleteMultipartUpload after 1 day) and CORS.
  6. New caps, for example Free 50 MB, Lite 100, Pro 200, Plus and above 512 MB, Ultra 2 GB. Govern cost with the existing storage quota (`libraryCapacity`) and a daily file count instead of tiny per-file caps.
  7. On the legacy route, clamp to the proxy ceiling and always answer 413 as JSON.
  8. Keep local-disk dev on `/api/upload`.
- **Acceptance tests.**
  - A 400 MB file on a throttled link resumes after a page reload.
  - A 150 MB Ultra upload succeeds (today nginx returns an HTML 413).
  - An `.exe` renamed to `.pdf` is refused after completion and its object deleted.
  - Two parallel uploads at the quota edge: exactly one succeeds.
  - An upload abandoned mid-way leaves no orphan after the lifecycle rule runs.
- **Size** M. **Impact** H.
- **Risks.** Differences in CORS and multipart support across R2, S3 and Supabase (test each). Presigned URLs leaking (short TTL, key bound to the session). Larger files raise extraction cost (already bounded by `EXTRACT_LIMITS`, `extract/types.ts:100-111`).

### FV-6. Vision-model OCR and visual indexing (scans, photos, images inside Office files)

- **What users notice.** A scanned contract in a project becomes searchable on every page. Grok, DeepSeek and Mistral-class models can answer about page 37 of a scan, not just the first 4 pages. "Find the whiteboard photo with the Q3 targets" works. A chart inside a pptx can be questioned.
- **Competitor evidence.** ChatGPT reads PDF visuals only on Enterprise [O2]. Claude reads visuals only for PDFs of 100 pages or fewer and is text-only for other documents [C1]. Doing this on all plans and all formats would put Alevr ahead.
- **Code today.** OCR is an endpoint or tesseract only (`knowledge/ocr.ts:19-40,97-140`), and neither is installed by deploy. Images are never indexed (`extract/index.ts:94`). Compat models get 4 raster pages (`openai-compat.ts:147-148`). Page rendering already exists (`src/lib/media/raster.ts:162-200`).
- **Implementation sketch.**
  1. Add a provider `visionModelOcr` in `ocr.ts`. It renders pages at about 1600 px wide (`renderDocumentPage`) and sends batches to a cheap vision model (Gemini 3.5 Flash-Lite or Claude Haiku 5.5 from `models.ts`) with a "transcribe to Markdown, keep tables, mark illegible" prompt. It returns `OcrPage[]` tagged `provider: "vision-model"`. Concurrency is 4 and the page limit is `OCR_MAX_PAGES` (100).
  2. Meter the cost through `src/lib/metering` and bill it to the user. Bump `OCR_VERSION` so stale indexes refresh.
  3. Image captions plus OCR for project and Library images and for `word/media/*` / `ppt/media/*` larger than 30 KB, stored as `KnowledgeBlock`s with heading path and confidence.
  4. In chat, non-native-bytes models get `read_document` over the OCR blocks for scans longer than 4 pages.
- **Acceptance tests.**
  - On a host with no tesseract: a 20-page scanned PDF in a project, then a search for a phrase on page 14, returns page 14.
  - A Grok model answers a question about page 9 of a scan.
  - A pptx with a chart picture: asked for the Q2 value, it answers within ±1%.
  - The per-page cost is logged and stays under the target (for example $0.002 per page).
- **Size** M. **Impact** H.
- **Risks.** Hallucinated OCR: label the text "reconstructed", keep confidence below 1, and cite the page. Privacy: the same provider-policy routing as chat (`src/lib/background-provider-policy.ts`).

### FV-8. Spreadsheet depth: functions, formatting, big tables without a sandbox

- **What users notice.** Financial models use XLOOKUP, SUMIFS and EOMONTH and look professional (fills, borders, colours, conditional formats). The question "average revenue by region" over a 200k-row CSV gets an exact answer even where no code sandbox is configured.
- **Competitor evidence.** The ChatGPT Excel add-in edits formulas, formatting and charts [O6]. Claude makes "working formulas… charts" [C2][C3].
- **Code today.** 38 functions (`workbook/formula.ts:797-1127`, also listed in the prompt at `system-prompt.ts:516`). Only bold styling (`workbook/model.ts:86-97`). Five chart types (`:100`). Extraction stops at 5,000 rows per sheet (`extract/xlsx.ts:29`). The sandbox depends on configuration (`src/lib/exec/config.ts`).
- **Implementation sketch.**
  1. **Formula engine.** Add SUMIFS, COUNTIFS, AVERAGEIFS, MAXIFS, MINIFS, IFS, SWITCH, XLOOKUP, HLOOKUP, CHOOSE, DATE, YEAR, MONTH, DAY, EOMONTH, EDATE, TODAY (pinned at recalculation), NETWORKDAYS, TEXT, VALUE, IRR, XIRR, XNPV, FV, PV, RATE, NPER, STDEV.S, VAR.S, CORREL, RANK.EQ and PERCENTILE.INC, each with LibreOffice-checked fixtures.
  2. **Styles.** Extend `storedCellSchema` with `fill`, `color`, `italic`, `align`, `wrap`, `border` (preset) and `indent`. Add sheet-level `merges`, `conditional` (cellIs, colorScale, dataBar) and `validation` (list, number). Export and import them with exceljs, and add the ops `setStyle`, `merge`, `addConditionalFormat` and `setValidation`.
  3. **Charts.** Add scatter, stacked, combo and doughnut.
  4. **Big tables.** Add a per-sheet "profile" block (row count, columns, inferred types, min/max/mean/null %, distinct counts, 20 sample rows) to extraction. Add a bounded `query_table` tool (group-by, filter, aggregate over parsed rows, server-side, capped at 1M cells) so answers are exact without a sandbox.
- **Acceptance tests.**
  - A 3-statement model prompt uses SUMIFS, XLOOKUP and EOMONTH, and the canvas values equal LibreOffice's recalculation on the exported file.
  - Styles and conditional formats survive export, reopen and import.
  - A 200k-row CSV group-by answered through `query_table` matches pandas exactly.
- **Size** M-L. **Impact** H (finance and ops users).
- **Risks.** Formula edge-case parity with Excel (date systems, error propagation): build a differential test corpus.

### FV-7. Audio and video understanding

- **What users notice.** A user drops in a 60-minute meeting recording and asks "action items with owners and timestamps", or a screen recording with "when does the error appear and what does it say". Citations like [12:34] jump the player to that moment.
- **Competitor evidence.** ChatGPT takes audio only, on paid plans, and rejects video files [O3]. Claude takes neither [C1]. Doing both would put Alevr ahead of both.
- **Code today.** Audio and video uploads are refused (`uploads.ts:6,49-61,88-99`; `extract/index.ts:94`). The sniffers and playback MIME already exist (`uploads.ts:280,319,343`). Range serving exists (`src/lib/http-range.ts`). STT is configured with `sttModel` (`src/lib/env.ts:191`, `/api/voice/stt`). There are Gemini adapters (`gemini-core.ts`).
- **Implementation sketch.**
  1. Accept audio (mp3, m4a, wav, flac, ogg) and video (mp4, mov, webm) by sniffed type, stored octet-stream.
  2. Add an asynchronous "media digest" job in `src/lib/knowledge/media-digest.ts`, scheduled like ingest. It uploads to the Gemini Files API, then asks Gemini 3.5 Flash-Lite for a transcript with timestamps and speaker labels, chapters and, for video, keyframe descriptions and on-screen text every N seconds. The output is stored as blocks with `timeStartMs`/`timeEndMs`; extend `ExtractedBlock` in `extract/types.ts` with these fields.
  3. If Gemini is unavailable, fall back to `gpt-4o-transcribe` for audio. Chunking needs ffmpeg in deploy.
  4. In chat, Gemini models get the native `fileData`; other models get the digest through `attachedFileText` plus `read_document` (search by time).
  5. Meter minutes per plan.
- **Acceptance tests.**
  - A 60-minute m4a fixture yields action items that match a gold list (F1 ≥ 0.8).
  - A 3-minute mp4 fixture gives the error's timestamp within ±3 s.
  - A non-Gemini model answers from the digest.
  - A plan without media minutes gets a clear upgrade message.
- **Size** L. **Impact** M-H.
- **Risks.** Cost of long video: cap the minutes and sample frames. Speaker-label accuracy: say that labels are best-effort, as OpenAI does [O3].

### FV-10. Image editing on par with Images 2.5: remove background, expand, markup, several references

- **What users notice.** One-click background removal, expanding a 1:1 image to 16:9, drawing an arrow with "put a lamp here", and "put the logo from image A on the mug in image B".
- **Competitor evidence.** The Images 2.5 toolbar has Remove BG, Resize, Erase, Markup and Comment [O7].
- **Code today.** A single source image (`image-gen.ts:244-256`). One `reference` (`generate-image.prompt.ts`). The overlay has eraser and region select only (`image-edit-overlay.tsx:7-14`). Transparent output is already supported (`media-params.ts:274-296`). The sketch engine exists (`src/lib/sketch/sketch-core.ts`).
- **Implementation sketch.**
  1. Turn `reference` into `references: string[]` (up to the model's limit, kept in `media-params.ts` capabilities), and let `editImage` take `SourceImage[]` (OpenAI images edit with several images; Gemini with several parts).
  2. Toolbar actions in `image-generation-card.tsx` and the overlay:
     - **Remove background:** an edit with `background: "transparent"`, or a dedicated matting model when one is configured.
     - **Expand:** pad the canvas to the target aspect with sharp, mask the padding, then edit.
     - **Markup:** draw over the image with the sketch tools, send the composite plus the instruction, then strip the marks.
     - **Upscale:** regenerate at 2K/4K with the image as reference, or use a provider upscaler.
- **Acceptance tests.**
  - Remove BG output has an alpha channel (`sharp().metadata().hasAlpha`) and transparent corners.
  - Expanding 1:1 to 16:9 keeps the centre region (SSIM ≥ 0.95).
  - A two-reference composition run on the fixture contains both subjects (vision-judge check).
- **Size** M. **Impact** M.
- **Risks.** Providers differ on multi-image support; advertise it per model.

### FV-11. Direct editing of documents and slides, plus present mode

- **What users notice.** Users type into the document and slides directly. Changes are saved as versions and the model sees them. They can present full-screen with a presenter view that shows notes.
- **Competitor evidence.** Claude: "In a doc, you type directly… Edit any slide directly… present without leaving Claude" [C4]. ChatGPT Slides: co-edit and present [O5].
- **Code today.** Only accept, reject and resolve buttons in `document-view.tsx`; move and duplicate in `deck-view.tsx`; notes are read-only (`deck-view.tsx:290`). There are no native views (`capabilities.ts:620-621`).
- **Implementation sketch.**
  1. Make each text block contentEditable (heading, paragraph, callout, list item), with inline-format shortcuts. Emit `updateText`/`replaceBlock` ops, debounced and coalesced into one version per editing session, through `postSemanticOps` (`semantic-artifact-view.tsx:60-70`).
  2. Slash-insert blocks, and drag to `moveBlock`.
  3. In decks: click a placeholder to edit its text, and drag or resize an element box to `setElement`.
  4. Present mode: full-screen, keyboard navigation, and a presenter window over BroadcastChannel with notes and a timer.
  5. Native parity follows the native redesign track.
- **Acceptance tests.**
  - A typing session creates exactly one new version.
  - Restore undoes it.
  - Arrow keys move between slides; the presenter view shows the current notes.
  - Screen-reader labels are present.
- **Size** M-L. **Impact** M.
- **Risks.** Conflicts with simultaneous model edits (ops rebase; reuse the re-emit guard).

### FV-9. Brand kits and templates (import a .potx/.dotx and apply it everywhere)

- **What users notice.** A user uploads the company template once. Every new deck, document and workbook header uses its fonts, colours, logo and footer. A project can set a default brand.
- **Competitor evidence.** Claude applies design systems ("new work picks up your colors, fonts, and components") [C4]. ChatGPT Slides has templates [O5].
- **Code today.** Theme and styles exist only per artifact (`deck/model.ts:112-127`, `document/model.ts:264-274`). No import.
- **Implementation sketch.**
  1. Add a `BrandKit` model: id, ownerId or projectId, name, colors {primary, accent, text, background, muted}, fonts {heading, body}, logoAttachmentId, footer, sourceAttachmentId. Add `Project.defaultBrandKitId`.
  2. Importers read `ppt/theme/theme1.xml` (clrScheme, fontScheme), the slide-master logo picture, `word/theme` and `styles.xml`.
  3. Inject the active kit into the system-prompt deliverables section and into normalisation defaults.
  4. Ship a gallery of 6 deck templates and 4 doc templates (memo, report, proposal, one-pager).
- **Acceptance tests.**
  - Upload a corporate .potx, ask for a new deck, and the exported `theme1.xml` and fonts match the kit, with the logo on the master.
  - The project default applies with no prompt mention.
- **Size** M. **Impact** M.
- **Risks.** Licensed fonts that are not embeddable: fall back to the nearest system font and warn.

### FV-12. Upload breadth: ZIP, HTML/SVG as text, EPUB, legacy Office, HEIC everywhere

- **What users notice.** "Here's my repo.zip" lets the model list and read files. Saved web pages and EPUBs are accepted. A `.doc` from 2003 opens. An iPhone photo dropped into Chrome just works.
- **Competitor evidence.** Claude accepts HTML and EPUB [C1].
- **Code today.** The blocklist is `uploads.ts:64,74`. Readable extensions are `:88-99`. Legacy Office is refused (`extract/index.ts:92`). HEIC is refused (`uploads.ts:264-270`). Zip-bomb limits already exist (`extract/types.ts:109-110`).
- **Implementation sketch.**
  1. **ZIP.** Expand server-side with jszip: at most 500 entries, 200 MB uncompressed, 64 MB per part, sanitised paths, skip `__MACOSX`. Create child `Attachment`s (new `parentId`) for readable entries. `run_code` mounts the whole archive, and `read_document` lists the entries.
  2. **HTML/SVG/XHTML.** Accept them as **text-only**. They are still stored octet-stream with an attachment disposition, so they are never served inline and the XSS rule holds. Extract the text with tags stripped.
  3. **EPUB extractor** (a zip of XHTML).
  4. **Legacy .doc/.xls/.ppt.** Convert with headless LibreOffice when `soffice` is present (`scripts/workflow-bench.ts:154` already finds it); otherwise keep today's clear message.
  5. **HEIC in every browser.** Decode client-side with a wasm decoder before upload.
- **Acceptance tests.**
  - A 300-file zip: the model reads `src/app.ts`.
  - A zip-bomb fixture is refused.
  - An `.html` upload is downloadable only, never rendered.
  - An EPUB chapter question is answered.
  - HEIC in Chrome uploads as JPEG.
- **Size** S-M. **Impact** M.
- **Risks.** ZIPs with secrets (`.env`): flag them and exclude them from model context by default.

---

## 4. Where Alevr is already ahead (protect these)

- Raw-PDF vision on **all plans** for ≤12 MB files (ChatGPT has it on Enterprise only [O2]).
- `inspect_image` crop and zoom, and `read_document` paging and search.
- Tracked revisions and Word comments in docx.
- Live formula recalculation and native charts in xlsx.
- Reopen-verification before any Office download.
- Native image generation with transparent backgrounds and up to 10 outputs (Claude has none).

---

## 5. Things to check in a browser (cannot be confirmed statically)

1. Upload a 15 MB PNG and send it to Claude Sonnet 5.5. Expected today: the provider rejects the turn (an FV-1 regression baseline).
2. As Ultra, upload a 150 MB file. Expected today: nginx 413 HTML (FV-2).
3. Ask for edits to a 600-line HTML artifact. Measure output tokens and time against an equivalent patch (FV-4 baseline).
4. Ask for a deck "with photos". Confirm placeholder rectangles in the downloaded pptx (FV-5 baseline).
5. In a project, add a scanned PDF on the production host. Check the parser state and reason (FV-6 baseline: OCR unavailable).

---

## Sources

OpenAI. help.openai.com could not be reached from this session; these were read through search copies and press:
- [O1] File uploads FAQ: https://help.openai.com/en/articles/8555545-file-uploads-faq
- [O2] Visual retrieval with PDFs FAQ: https://help.openai.com/en/articles/10416312-visual-retrieval-with-pdfs-faq
- [O3] Uploading files and audio: https://help.openai.com/en/articles/8555545-uploading-files-and-audio-to-chatgpt ; community: https://community.openai.com/t/new-chatgpt-mp3-and-mp4-file-support/1386629
- [O4] Creating and editing documents, spreadsheets and presentations with ChatGPT Work: https://help.openai.com/en/articles/20001278-creating-and-editing-documents-spreadsheets-and-presentations-with-chatgpt-work ; launch coverage: https://gvwire.com/2026/07/09/openai-launches-chatgpt-work/
- [O5] Creating and collaborating on slides in ChatGPT: https://help.openai.com/en/articles/20001605-creating-and-collaborating-on-slides-in-chatgpt ; https://www.techrepublic.com/article/news-how-to-use-chatgpt-slides-powerpoint/ ; https://origami.sa/en/blog/chatgpt-slides-ai-powerpoint-presentation/
- [O6] ChatGPT for Excel and Google Sheets: https://help.openai.com/sr-rs/articles/20001063-chatgpt-for-excel-and-google-sheets
- [O7] Images 2.5: https://www.androidheadlines.com/2026/09/openai-launches-chatgpt-images-2-5-sketch-editing-tools.html ; https://techradar.com/ai-platforms-assistants/chatgpt/chatgpt-images-2-5-is-out-ive-been-testing-it-for-24-hours-and-these-are-the-3-new-features-youll-actually-use ; https://www.digitalapplied.com/blog/chatgpt-images-2-0-features-use-cases-impact
- [O8] Images and vision guide: https://developers.openai.com/api/docs/guides/images-vision ; cost calculator: https://developers.openai.com/api/docs/guides/image-cost-calculator.md

Anthropic (fetched directly):
- [C1] Uploading files to Claude: https://support.claude.com/en/articles/8241126-uploading-files-to-claude
- [C2] Create and edit files with Claude: https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude
- [C3] Claude file creation announcement: https://claude.com/blog/create-files
- [C4] What are artifacts: https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
- [C5] Claude Slides speaker notes (third-party): https://go9x.com/blog/how-to-use-claude-slides ; https://felloai.com/claude-slides/
- [C6] Vision: https://platform.claude.com/docs/en/build-with-claude/vision
- [C7] PDF support: https://platform.claude.com/docs/en/build-with-claude/pdf-support
- [P7] No native Claude image generation, as already noted in `scratchpad/parity-gap.md`.
