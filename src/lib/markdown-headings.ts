import type { Components } from "react-markdown";

/**
 * The assistant's headings, demoted two levels before they reach the DOM.
 *
 * The transcript already has an outline: the conversation title is the page's
 * <h1> (chat-view.tsx from `md` up, message-list.tsx below it) and every turn
 * carries a visually hidden <h2> marker ("You said", "Juno replied") so a
 * screen-reader user can walk the conversation turn by turn. react-markdown
 * emitted the model's `#` as a real <h1> and its `##` as an <h2>, so a reply
 * that opened with a title put a second h1 on the page, and its sections were
 * indistinguishable from turn markers in the heading list — the one navigation
 * that outline exists to serve.
 *
 * Tag names rather than components: react-markdown renders the named element
 * with the heading's own props, so the source-offset attributes the citation
 * audit stamps on h1–h6 (rehypeSourceOffsets in markdown.tsx) survive with
 * nothing to forward and no `node` prop to strip. `#####` and `######` both
 * land on h6 — there is nothing below it, and the model's fifth and sixth
 * levels were never distinct in the transcript's styling either.
 *
 * The visual sizes did not move: `.prose-juno h3 / h4 / h5` in globals.css
 * carry what h1 / h2 / h3 used to.
 */
export const DEMOTED_HEADINGS = {
  h1: "h3",
  h2: "h4",
  h3: "h5",
  h4: "h6",
  h5: "h6",
  h6: "h6",
} satisfies Components;

/**
 * The tags the writer's `#`, `##` and `###` actually render as, for anything
 * that walks the rendered DOM by tag name rather than through the components
 * map. The research report reader builds its table of contents from a
 * `querySelectorAll` on the article and pins `scroll-mt` to the same set;
 * when the demotion landed it was still asking for `h1, h2, h3`, matched only
 * the title, and the ToC — gated on two or more entries — silently vanished
 * from every report, scrollspy and all. Derived from the map rather than
 * typed a second time so the two cannot drift again; tests/markdown-headings
 * pins it. Three levels, not four, because that is the outline the reader
 * has always offered: the writer prompt stops at `###`, and everything from
 * `####` down shares the h6 floor and could not be indented meaningfully.
 */
export const OUTLINE_HEADING_TAGS = [
  DEMOTED_HEADINGS.h1,
  DEMOTED_HEADINGS.h2,
  DEMOTED_HEADINGS.h3,
] as const;

/** `OUTLINE_HEADING_TAGS` as a selector list, for `querySelectorAll`. */
export const OUTLINE_HEADING_SELECTOR: string = OUTLINE_HEADING_TAGS.join(", ");
