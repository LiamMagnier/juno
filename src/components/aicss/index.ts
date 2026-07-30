/**
 * AIcss — the agent-state block set, ported from aicss.dev (Kevin, @kvnkld;
 * Beta V1.2, free tier) onto Juno's tokens.
 *
 * The library ships CSS modules whose colours are literals and whose dark mode
 * is a media query. Both were changed and nothing else was: literals became the
 * tokens that already mean that thing here, and `prefers-color-scheme` became
 * `.dark`, which is what next-themes actually toggles. Geometry, easing and
 * keyframe stops are AIcss's — see the `.aicss-*` section in globals.css.
 *
 * Every component that AIcss ships as a self-running demo (thinking + reasoning,
 * web search, to-dos, streaming text) is data-driven here. The demos are films
 * of components; these are handed what actually arrived and show that.
 */

export { ThinkingState } from "@/components/aicss/thinking-state";
export { ThinkingReasoning } from "@/components/aicss/thinking-reasoning";
export { ImageGenerationCanvas } from "@/components/aicss/image-generation";
export { WebSearchBlock } from "@/components/aicss/web-search";
export type { WebSearchSite, WebSearchSiteState } from "@/components/aicss/web-search";
export { AicssCodeBlock } from "@/components/aicss/code-block";
export { FileDiff, parseUnifiedDiff } from "@/components/aicss/file-diff";
export type { DiffRow, DiffRowType } from "@/components/aicss/file-diff";
export { CitationFooter } from "@/components/aicss/citation-footer";
export { TodoList } from "@/components/aicss/todo-list";
export type { TodoItem, TodoState } from "@/components/aicss/todo-list";
export { StreamingCaret } from "@/components/aicss/streaming-caret";
