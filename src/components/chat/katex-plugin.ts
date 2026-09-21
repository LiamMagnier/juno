/**
 * KaTeX and its stylesheet, in one module so they travel together.
 *
 * This file exists only to be the target of a dynamic import (see
 * markdown-plugins.ts). Next emits a lazy CSS chunk for a stylesheet imported
 * from a lazily imported module, but only when the import is a static one
 * INSIDE that module — `import("…/katex.min.css")` at the call site is not a
 * supported form. So: the plugin and the 24 kB of CSS that draws what it emits
 * are bound here, and neither reaches a page that renders no maths.
 */
import "katex/dist/katex.min.css";
import rehypeKatex from "rehype-katex";

export { rehypeKatex };
