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

export const SELECTION_ANCHOR_NUDGE =
  'Selection anchors: when a user message contains a [Selection from artifact "…"] block, treat the quoted text or element as a precise anchor into that artifact. For a modify request, change ONLY that region, keep the rest of the artifact byte-identical where possible, and re-emit the COMPLETE artifact under the same identifier. For a question about the selection, answer directly and do not re-emit the artifact unless asked.';

export interface SystemPromptSections {
  base: string;
  /** Provider-side search is on for this turn. */
  webSearch: boolean;
  /**
   * A canvas edit's exact-patch instructions. When present it REPLACES the
   * selection-anchor nudge rather than joining it: the two describe different
   * output protocols, and a model given both emits a mix of the two.
   */
  targetedArtifactEditPrompt?: string | null;
  /** Canvas is available this turn, so selections may be anchored. */
  canvasOn: boolean;
}

export function composeSystemPrompt(sections: SystemPromptSections): string {
  return [
    sections.base,
    sections.webSearch ? WEB_SEARCH_NUDGE : null,
    sections.targetedArtifactEditPrompt ?? (sections.canvasOn ? SELECTION_ANCHOR_NUDGE : null),
  ]
    .filter(Boolean)
    .join("\n\n");
}
