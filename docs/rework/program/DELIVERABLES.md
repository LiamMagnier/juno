# Deliverables: semantic documents, spreadsheets and decks (BRIEF §29–30, §55 items 13–15)

Branch `rework/deliverables` · 2026-10-04 · registry entry `semantic_artifacts` in `src/lib/capabilities.ts`

## Decision

Professional deliverables stop being Markdown that an exporter guesses a structure from. Each one is a semantic model stored as JSON in an ordinary `ArtifactVersion` body. There are three new `ArtifactType` values: `SPREADSHEET`, `DOCUMENT` and `PRESENTATION`. They were added the same way `DESIGN` was: appended to the enum, with no ordinal moved. Versions, restore, proposals, the Library, publication and trash keep working with no second persistence system.

The model edits an existing artifact by sending operations, never a regenerated body. A deterministic engine in trusted code applies them to the artifact's current version. The engine output is rewritten into the existing artifact tag, so verification, the re-emit guard (proposals), version append and undo are the paths that already existed.

The existing typed builders in `src/lib/work/deliverables/{document,report,site,spreadsheet,presentation}.ts` and the Work pipeline are unchanged. The semantic layer sits beside them in `src/lib/work/deliverables/semantic/`.

## Implemented

### Spreadsheet (`semantic/workbook/`)

**Model (`model.ts`).** Sheets hold typed cells: text, number, boolean, dates as serials. Formulas are stored canonically. A sheet can also have:
- number formats (Excel codes and aliases)
- bold
- column widths
- frozen rows and columns
- tables with filters
- charts bound to ranges (bar, column, line, pie, area)

Defined names (for example `conversion`) are supported.

**Injection rule.** A cell is a formula only when it is written as `{ "f": "=…" }`. A plain string beginning with `=` is text everywhere: authoring, imports and exports.

**Formula language (`formula.ts`).** A closed language:
- tokenizer, parser to an AST, and a canonical printer
- Excel operator precedence
- references, absolute references, sheet-qualified references, ranges and names
- 40 functions: SUM, AVERAGE, MIN, MAX, MEDIAN, PRODUCT, COUNT, COUNTA, COUNTBLANK, SUMIF, COUNTIF, AVERAGEIF, SUMPRODUCT, IF, IFERROR, AND, OR, NOT, ROUND, ROUNDUP, ROUNDDOWN, INT, ABS, SQRT, POWER, MOD, PMT, NPV, CONCAT, CONCATENATE, LEN, UPPER, LOWER, TRIM, LEFT, RIGHT, MID, INDEX, MATCH, VLOOKUP
- Excel error values

There is no INDIRECT, WEBSERVICE, HYPERLINK or volatile clock function. An unknown function is refused when the formula is written.

**Engine (`engine.ts`).**
- The dependency graph covers exact references, ranges and names.
- Ordering uses Tarjan strongly connected components. Cells on a cycle evaluate to `#CYCLE!`, and cells downstream of a cycle still evaluate.
- Incremental recalculation re-evaluates only the transitive dependents of the edited cells. It exposes `evaluated` so tests can prove this.

**Operations (`ops.ts`).** Validated by zod and all-or-nothing, with the 1-based index of the failing operation:
- setCell (also accepts a defined name), setFormula, setCells, clearRange
- setFormat, setBold
- insertRows, deleteRows, insertColumns, deleteColumns. These rewrite references in every formula, chart, table and name. A reference into deleted cells becomes `#REF!`; deleting a named cell or a chart's data is refused.
- sortRange: each row carries its formulas, with relative references moved.
- setFreeze, setColumnWidth
- addSheet, renameSheet (rewrites references), deleteSheet (refused while other sheets read from it)
- defineName, addTable, setFilter
- addChart, updateChart, removeChart, setTitle

A formula edit that would create a cycle is refused before anything is stored.

**XLSX (`xlsx.ts`).**
- Export writes real formulas with cached values, formats, defined names, panes and widths. A table becomes an AutoFilter, with rows hidden by its filters.
- `fullCalcOnLoad` is set, so Excel recalculates when the file is opened.
- Charts are real DrawingML chart parts injected after exceljs, which does not write charts. Their `c:f` references point at the sheet ranges and carry a cache of the computed values.
- Import reads all of the above back, including charts from the drawing and chart parts. A formula the engine does not support is kept verbatim with its cached value as an opaque cell, so nothing is lost and nothing pretends to compute.

**View (`view.ts`).** Hidden-row computation for filters, and the addressable outline the model reads before it edits.

### Document (`semantic/document/`)

**Block model.**
- Blocks: headings 1–4, paragraphs (normal, lead or quote style), ordered and bulleted lists with levels, tables with captions, callouts (note, tip or warning), figures (data URIs or https URLs, which are never fetched), page breaks.
- Inline markup: bold, italic, code, links and `[@source]` citations.
- Also: sources, metadata, styles, comments (with a resolved flag) and tracked revisions (replace, insert or delete; pending, accepted or rejected).

**Operations.** insertBlock, replaceBlock, updateText, moveBlock, deleteBlock, comment, resolveComment, suggestRevision, acceptRevision, rejectRevision, setMetadata, setStyles, addSource.

**DOCX.**
- Real styles and real numbering.
- Real Word comments. Resolved state is written to `commentsExtended.xml`, which the exporter adds itself.
- Real tracked changes (`w:ins` and `w:del`), with author and date.
- A References section for citations.
- A reader, with its own safe XML parser (no DOCTYPE, bounded), reopens the file into the block model. The round trip is proven by test.

### Presentation (`semantic/deck/`)

**Model.**
- Theme (fonts and colours) and master (footer, slide numbers, logo text).
- A closed set of layouts with placeholder geometry: title, section, title-content, two-column, title-only, blank. The canvas and the exporter share this geometry.
- Elements: editable text, images, shapes, charts with data, tables. Plus speaker notes and transitions.

**Operations.** updateSlide, insertSlide, deleteSlide, moveSlide, duplicateSlide, setElement, removeElement, updateText, updateChart, updateTable, setTheme, setMaster. Editing one slide leaves every other slide deep-equal.

**Fit validation (`fit.ts`).** Detects:
- text overflow, measured from font size and box
- elements past the slide edge or into the footer band
- overlap
- dense charts
- empty slides

`fitTextSize` lets the exporter shrink text to a floor and then report rather than truncate.

**PPTX.**
- Built with pptxgenjs. Text lands in real layout placeholders.
- Charts are real chart parts with embedded data, and tables are real tables.
- Transitions are injected after writing.
- A readback reopens the file and recovers the text, notes, chart caches and object counts.

### Chat, artifacts and Library (§30)

**`src/lib/artifact-ops.ts`.** The `<juno:artifact-ops identifier="…">{"summary","ops"}</juno:artifact-ops>` protocol.
- `resolveArtifactOps` applies each block to the artifact's current version and rewrites it into `summary + <juno:artifact …>result</juno:artifact>`.
- A failure becomes a one-line notice, and nothing is stored.
- Several blocks for one artifact produce one version.
- An unclosed block, from Stop or the output limit, is dropped.

**`src/app/api/chat/route.ts`.**
- Ordinary turns resolve ops blocks before verification.
- For canvas targeted edits on a semantic type, the model is asked for operations against the outline instead of byte patches.
- When the canvas is on, the system prompt carries the current outlines of the conversation's semantic artifacts. The budget is 24k characters across the four most recently updated.

**`src/lib/chat/system-prompt.ts`.** Documents, spreadsheets and decks are no longer "MARKDOWN artifacts". The contract gives:
- the compact JSON authoring forms
- the function list
- the operation vocabulary
- the rule that an edit is operations: "raise conversion to 7.5%" is one `setCell`.

**Storage and verification.**
- Verification (`chat-artifact-verification.ts`) refuses bodies that do not validate, with the code `semantic_invalid`.
- Storage (`artifacts-store.ts`) stores the canonical model.
- Whole-body saves (`artifact-content.ts`) validate and canonicalise, and return `invalid_body` (422) on failure.

**`POST /api/artifacts/:id/ops`.** A person's semantic edit: typing a cell, accepting a suggestion, duplicating a slide.
- `baseVersion` is required; a moved head returns 409 with the current artifact.
- The edit is saved as one `edit` version.
- The response includes `recalculated`, `chartsChanged` and `fit`.

Because the head is now a person's edit, the re-emit guard holds the model's next edit as a suggestion, and Apply turns it into a version.

**`GET /api/artifacts/:id/export?format=`.** Serves xlsx, docx or pptx from the model, after the existing re-open verification.

**UI (`src/components/semantic/`).**
- Workbook: a grid with formats, the formula bar, frozen panes, filtered rows hidden and keyboard editing. Charts are drawn from computed values, and recomputed values settle once in presence blue.
- Document: a Newsreader page at a reading measure. Comments and suggestions appear as mono margin notes, inline insertions and strikes, with Accept, Reject and Resolve.
- Deck: slides at their true proportions in the deck theme, a thumbnail strip, notes, and fit notes as annotations.

These views are wired into:
- the canvas (editing through the ops route; the Office export menu now offers the semantic formats)
- the inline chat card (JSON never shown; "Writing…" and "Editing…" while streaming)
- Library and Artifacts tiles (no JSON)
- the owner read page and the public share viewer (read-only)
- the Library type chips (Documents, Spreadsheets, Decks)

**Dev gallery: `/dev/deliverables?kind=spreadsheet|document|presentation`.** The real views run over fixtures with the real engine. "Send as a chat edit" applies the brief's own example request, and Undo restores the previous version as a new one.

## Changed

- `prisma/schema.prisma` and migration `20261004120000_semantic_artifact_types`: three enum labels appended.
- `src/lib/work/deliverables/validate.ts`: a relationship target with a leading `/` now resolves from the package root (OPC). Before, every pptxgenjs chart was reported as a missing asset, so a deck with a chart could never pass export verification. This also fixes the existing Work deck path.
- `src/lib/message-content.ts`:
  - The `ArtifactType` union includes the three new types.
  - Streaming ops blocks render as a reference to the artifact, never as raw JSON.
  - `cleanForSpeech` speaks an edit as "updated in the canvas".
- `src/lib/artifact-runtime.ts`: new run mode `semantic`.
- `src/lib/artifacts-home.ts`: the Library chip order includes the new types.

## Removed

- The system-prompt instruction to write documents, spreadsheets and decks as Markdown tables and `## ` slides. The Markdown → Office export path (`office-export.ts`) is kept for existing MARKDOWN artifacts.

## Tests

All commands are run from the worktree.

| Command | Result |
|---|---|
| `npx tsx --test tests/semantic-workbook.test.ts` | 21/21 |
| `npx tsx --test tests/semantic-document.test.ts` | 16/16 |
| `npx tsx --test tests/semantic-deck.test.ts` | 17/17 |
| `npx tsx --test tests/artifact-ops.test.ts` | 9/9 |
| `SEMANTIC_TEST_DATABASE_URL=…/juno_deliverables_test NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/semantic-artifact-chat.integration.test.ts` | 5/5, against Postgres through the real `POST /api/chat`, ops, artifact, proposal-apply and export routes |
| Existing suites of touched modules | 368 pass, 0 fail, rest skipped (DB-gated): work-deliverables, artifact-export-verification, chat-artifact-verification, artifact-edit, artifact-reemit-guard, artifact-routes, artifacts-home, system-prompt-sections, artifact-design-save and others |
| `npx tsx --test tests/capabilities-registry.test.ts` and `npm run capabilities:check` | pass |

Headline proofs:

**"Increase conversion assumption to 7.5% and update the charts"** (`tests/semantic-workbook.test.ts`, and again through the chat route in the integration test):
- It is one `setCell` on the defined name.
- Exactly one stored cell differs.
- Exactly the 26 dependent formula cells are recomputed (orders, revenue and the totals). Visitors and the unrelated sheet are not.
- The chart's drawn data changes.
- The incremental result equals a full recalculation.
- The exported `.xlsx` chart cache carries the new values.
- The file reopens with them.

**Round trips:**
- XLSX: cells, formulas, formats, names, panes, tables and charts deep-equal after export and import.
- DOCX: 17 block types, comments, revisions and metadata are structurally equal after export and reopen, and after edit, export and reopen.
- PPTX: titles, paragraphs, notes, chart data, tables, images and layouts survive export and readback.

**Undo and proposals (integration test).**
- v1 generated → v2 chat edit → v3 restore of v1.
- A person's ops edit becomes v4 (`edit`).
- The model's next edit is held as a PENDING proposal; Apply makes it v5. v5 keeps the person's edit and adds the model's.

**UI (headless Chrome against `/dev/deliverables`, light, dark and 390 px phone).**
- No page errors.
- No horizontal overflow at phone width.
- A chat edit followed by a cell edit gives D2 $288,000 → $432,000 → $468,000. Undo returns it to $432,000.

## Benchmarks

Not measured beyond test timings. The 21 workbook tests, including three XLSX round trips, run in about 0.4 s. A 50,000-cell chain is ordered iteratively, so the stack is never at risk; that scale has not been timed.

## Security considerations

- The formula language is closed and is parsed, never evaluated. It has no network, indirection or volatile functions, and range size is bounded at 250k cells per reference.
- The injection rule holds at every boundary: model output, imports, whole-body saves and exports. A test checks that the exported sheet XML has no `<f>` for an `=`-string.
- Images: only `data:image/png|jpeg|gif|webp` is embedded. An `https` image is shown in the canvas, but the server never fetches it; exports use a named placeholder. This avoids server-side request forgery.
- The DOCX reader refuses DOCTYPE (no entity expansion) and bounds depth, element count and part size.
- Operations are applied in trusted code. A person's ops route checks ownership (`ownedArtifactWhere`), is rate-limited (`artifactWriteLimited`) and uses an optimistic `baseVersion`. Model operations only reach artifacts in the same conversation and owned by the same user.
- A model edit over a person's edit is held for review by the existing re-emit guard. It never silently overwrites.

## Remaining blockers

1. **Native clients.** Installed Mac and iOS builds decode artifact kinds leniently, so they skip SPREADSHEET, DOCUMENT and PRESENTATION rows. They neither crash nor show them, and there is no native semantic view yet. A deliverable made in chat is therefore visible on the web only. Before, the same request produced a MARKDOWN artifact visible everywhere. This needs a native renderer, or a native fallback such as the export endpoint opened in Quick Look, before the prompt change ships to native users.
2. **Signed-in canvas acceptance with a real model.** Not done here: the pane has no signed-in session, per the program rules. The canvas wiring compiles and the views are verified in the gallery, but the canvas editing flow in the real chat has not been driven end to end in a browser.
3. **Office, Numbers and Keynote opening.** Not checked: no Office or LibreOffice is installed here. Files reopen with exceljs, JSZip and the package validator. The injected chart XML follows the schema element order, but Excel and PowerPoint have not opened it.
4. **Collaboration.** The CRDT transport for live multi-user editing (REALITY_AUDIT P2 item 10) is out of this vertical.
5. **PPTX import.** Not implemented, on purpose: the readback recovers content, not the full deck model. XLSX and DOCX import exist (`importSemanticFile` in `semantic/export.ts`) but have no upload UI yet.

## Next milestone

- A native semantic renderer (Mac first).
- A signed-in canvas run with a real model: create, edit, undo and export in all three kinds.
- Excel and PowerPoint open checks on the exported files.
- Upload → import for .xlsx and .docx through the composer.
- A per-cell provenance hint ("changed by Alevr in v5") in the formula bar.

## Competitor comparison

| | Alevr (this branch) | ChatGPT Work | Microsoft Copilot (Edit with Copilot / Agent Mode) | Claude file creation |
|---|---|---|---|---|
| Storage | Semantic model inside the chat artifact; versions and proposals | Editable docs, sheets and slides; native Google Workspace; Excel via add-in | Edits the Office file in place | Generates files by code execution |
| Incremental edit | Validated operations against the current version; dependents recompute; the rest is untouched by construction | Edits the document | Edits the workbook directly (formulas, tables, charts) | Usually regenerates the file |
| Review | Model edits over a person's edit wait as suggestions; tracked revisions in documents | — | Office version history | Download per version |

Sources:
- [OpenAI: creating and editing documents, spreadsheets and presentations with ChatGPT Work](https://help.openai.com/en/articles/20001278-creating-and-editing-documents-spreadsheets-and-presentations-with-chatgpt-work)
- [OpenAI: Introducing canvas](https://openai.com/index/introducing-canvas/)
- [Windows Central: Excel Agent Mode](https://www.windowscentral.com/microsoft/microsoft-office/excels-new-agent-mode-can-fix-your-broken-formulas-proving-ai-can-be-useful)
- [Office Watch: Copilot Agent Mode](https://office-watch.com/2026/copilot-agent-mode-word-excel-powerpoint/)
- [Claude support: create and edit files](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude)

This vertical makes no superiority claim. Alevr's distinct property is that the edit is a validated, reviewable operation on a stored model, which none of the cited documentation describes. Breadth of Office fidelity is still lower than native Office.
