/**
 * The system-prompt sections the chat route appends to the base prompt, and the
 * one rule for how they are joined.
 *
 * Both of the route's streaming paths composed this by hand and disagreed:
 * private mode wrote `useWebSearch ? base + "\n\n" + NUDGE : base` while the
 * saved path filtered an array. The results happened to match, which is the
 * kind of coincidence that stops being one the first time a third section is
 * added to only one of them.
 */

export const WEB_SEARCH_NUDGE =
  "Web search is ENABLED for this message. You have a live web search tool that returns current, real-world results with citations — use it to answer with up-to-date information and cite your sources. Do NOT claim you lack internet access, real-time data, or the ability to browse; you can search right now.";

/**
 * Told, not left to be discovered from a tool list.
 *
 * A tool description is read once, among a dozen others, and what it competes
 * with is the model's strong prior that it has already been given everything
 * the file contains. That prior is usually right and, on the two cases below,
 * reliably wrong — a long document arrives truncated and a large image arrives
 * downscaled, and in both cases the model's evidence for "I have it all" looks
 * exactly the same as when it does. So the turns that carry an attachment say
 * so in the system prompt, where it outranks the habit.
 *
 * The last sentence of each is the one that matters: the failure being
 * prevented is not "forgot to use a tool", it is "answered confidently from
 * the part it was shown".
 */
export const ATTACHED_DOCUMENT_NUDGE =
  "Attached documents: you have a read_document tool for the files attached to this conversation. Use it with action 'list' to see how long each file is, 'search' to find where a term appears, 'outline' to see a long file's headings, and 'read' to read a page range. What you were shown inline may be only the beginning of a file — if the text you were given says it was cut short, or if you are about to state that a document does NOT contain something, read or search it first rather than answering from the excerpt.";

export const ATTACHED_IMAGE_NUDGE =
  "Attached images: you have an inspect_image tool that crops and magnifies part of an attached image, or renders a page of an attached PDF as an image. Give it a region in percent (x, y, width, height from the top-left). The copies of images you are shown are downscaled, so small text, serial numbers, axis labels, handwriting and dense table cells are genuinely not legible in them. Use the tool before reading such detail out, and never guess a character you could not actually see.";

/**
 * Said because the model's habit is to assume the file was pre-digested.
 *
 * Nothing reads an upload before the question arrives any more, so "the file
 * was attached" no longer implies "its contents are in your context". A model
 * that assumes otherwise describes a document it was never given.
 */
export const CODE_INTERPRETER_NUDGE =
  "Running code: you have a run_code tool that runs Python in a sandbox with the attached files in the working directory, under their own names. It is the general way to examine a file — open a PDF with pypdf and read the pages you need, crop or magnify part of an image with Pillow, load a spreadsheet with pandas and compute over it, or parse a format nothing else handles. Anything you print comes back to you, and any image you save is shown to you so you can read it yourself. Nothing has analysed these files in advance: if you need to know what is in one, open it.";

export const SELECTION_ANCHOR_NUDGE =
  'Selection anchors: when a user message contains a [Selection from artifact "…"] block, treat the quoted text or element as a precise anchor into that artifact. For a modify request, change ONLY that region, keep the rest of the artifact byte-identical where possible, and re-emit the COMPLETE artifact under the same identifier. For a question about the selection, answer directly and do not re-emit the artifact unless asked.';

export interface SystemPromptSections {
  base: string;
  /** Provider-side search is on for this turn. */
  webSearch: boolean;
  /** `read_document` is attached this turn (an indexed file is in history). */
  documentTool?: boolean;
  /** `inspect_image` is attached this turn (a picture, and a model that sees). */
  imageTool?: boolean;
  /** `run_code` is attached this turn (a file, and a sandbox to run in). */
  codeTool?: boolean;
  /**
   * A canvas edit's exact-patch instructions. When present it REPLACES the
   * selection-anchor nudge rather than joining it: the two describe different
   * output protocols, and a model given both emits a mix of the two.
   */
  targetedArtifactEditPrompt?: string | null;
  /** Canvas is available this turn, so selections may be anchored. */
  canvasOn: boolean;
}

/**
 * A skill's block, appended after everything else.
 *
 * LAST, and that position is the argument. The block already carries its own
 * authority sentence — it shapes HOW the task is done, it does not change what
 * the task is, and it cannot reach a tool the turn did not already have — and
 * putting it after the feature contracts means the rules it is bounded by are
 * stated before it rather than after. For an imported skill the text is inside
 * the untrusted-content markers, whose rule sits at the very top of the prompt
 * beside the identity line, so the distance is deliberate in the other
 * direction too: the reader of the envelope meets the rule first.
 *
 * A separate function rather than another field on `SystemPromptSections`
 * because the two streaming paths compose sections at different moments — the
 * private branch has no project, no attachments and no canvas — and a field
 * only one of them could populate is a field that drifts.
 */
export function appendSkillBlock(
  prompt: string,
  skill: { systemSuffix: string } | null
): string {
  if (!skill || !skill.systemSuffix.trim()) return prompt;
  return `${prompt}\n\n${skill.systemSuffix}`;
}

export function composeSystemPrompt(sections: SystemPromptSections): string {
  return [
    sections.base,
    sections.webSearch ? WEB_SEARCH_NUDGE : null,
    // Only when the tool is actually attached. A nudge naming a tool the turn
    // does not carry is an instruction to call something that is not there,
    // and the model spends a round finding that out.
    sections.documentTool ? ATTACHED_DOCUMENT_NUDGE : null,
    sections.imageTool ? ATTACHED_IMAGE_NUDGE : null,
    sections.codeTool ? CODE_INTERPRETER_NUDGE : null,
    sections.targetedArtifactEditPrompt ?? (sections.canvasOn ? SELECTION_ANCHOR_NUDGE : null),
  ]
    .filter(Boolean)
    .join("\n\n");
}
