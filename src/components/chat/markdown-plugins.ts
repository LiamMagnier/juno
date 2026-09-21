"use client";

import * as React from "react";
import type { Options } from "react-markdown";

type RehypePlugin = NonNullable<Options["rehypePlugins"]>[number];

/**
 * THE TWO HEAVIEST THINGS IN THE CHAT BUNDLE, FETCHED WHEN A MESSAGE NEEDS THEM.
 *
 * Measured on the production build before this module existed:
 *
 *   /chat        667 kB first-load JS
 *   /chat/[id]   797 kB
 *
 * KaTeX is 258 kB of that and highlight.js the bulk of another 328 kB chunk —
 * roughly half the JavaScript a person downloads, parses and compiles before
 * the composer is usable, for two renderers that most conversations never
 * invoke. They were static imports in markdown.tsx, so "open the app" meant
 * "download a maths typesetter and a syntax highlighter", every time, on every
 * device.
 *
 * So both are dynamic now, and the sniffs below decide. A block with no `$`
 * never asks for KaTeX; a block with no fence never asks for highlight.js.
 *
 * ── What a reader sees while a plugin is in flight ────────────────────────
 *
 * The block renders once WITHOUT the plugin and re-renders with it, which is
 * the whole cost and it is small and bounded:
 *
 *   · maths degrades to its own source (`$x^2$`), because remark-math still
 *     parses and mdast-util-math still emits the LaTeX as text — so the reader
 *     sees the formula's source, not an error and not a gap;
 *   · a fence degrades to unhighlighted code in the same mono face at the same
 *     metrics, so nothing moves when the colour arrives.
 *
 * Neither reflows the column. That is the reason this is a safe trade and it
 * is a property of these two plugins specifically — do not extend the pattern
 * to a plugin whose absence changes layout.
 *
 * ── Module-level cache, deliberately ──────────────────────────────────────
 *
 * A conversation renders one Markdown per block and can hold hundreds. The
 * resolved plugin and its in-flight promise are module state, not component
 * state, so the hundredth code block does not start a hundred-and-first import
 * and every block upgrades on the same tick.
 */

const cache: Record<"math" | "code", RehypePlugin | null> = { math: null, code: null };
const inflight: Record<"math" | "code", Promise<void> | null> = { math: null, code: null };

function load(kind: "math" | "code"): Promise<void> {
  if (cache[kind]) return Promise.resolve();
  inflight[kind] ??= (async () => {
    if (kind === "math") {
      // `katex-plugin` carries the stylesheet with it, rather than the app
      // shell carrying it. It was imported from the signed-in layout (see the
      // note that used to live in katex-styles.tsx), which put 24 kB of
      // render-blocking CSS in front of every page in the product — settings,
      // projects, the roadmap — to style formulas none of them can contain.
      const { rehypeKatex } = await import("@/components/chat/katex-plugin");
      // `throwOnError: false` keeps a malformed or half-streamed expression as
      // red source text instead of crashing the whole render.
      cache.math = [rehypeKatex, { throwOnError: false, output: "htmlAndMathml" }];
    } else {
      const { default: rehypeHighlight } = await import("rehype-highlight");
      /*
       * `detect: false`, and that is the whole point of this argument.
       *
       * With detection ON, highlight.js runs `highlightAuto` over any fence
       * whose author wrote no language, picks whichever grammar scored
       * highest, and rehype-highlight stamps `language-<guess>` onto the
       * element. The block header then prints that guess as a CONFIDENT LABEL,
       * because nothing downstream can tell a declared language from an
       * inferred one.
       *
       * On real code the guess is usually harmless. On anything else it is a
       * lie stated in the product's own voice: a two-line Gemini API error —
       * `400 INVALID_ARGUMENT / Thinking level MEDIUM is not supported` — came
       * out labelled **kotlin**, which is the kind of detail that costs a
       * reader's trust in everything around it. Auto-detection over two lines
       * of prose is a coin flip, and a coin flip does not belong in a label.
       *
       * The trade is that an unlabelled fence renders uncoloured. That is the
       * right side to err on, it is what ChatGPT and Claude both do, and the
       * fix is available to the author: write the language.
       */
      cache.code = [rehypeHighlight, { detect: false, ignoreMissing: true }];
    }
  })().catch(() => {
    // A failed chunk fetch (offline, a deploy mid-session) must not wedge the
    // renderer: clear the latch so the next block that needs it tries again,
    // and leave the degraded render in place meanwhile.
    inflight[kind] = null;
  });
  return inflight[kind]!;
}

/**
 * Does this text carry maths remark-math will lift out?
 *
 * Tight enough that the prices this product is full of ("€20 a month, $22")
 * do not drag in a typesetter: an inline run has to open on a non-space and
 * close on the same line. Over-matching costs one wasted fetch, never a wrong
 * render, so the regex errs toward the cheap side rather than re-implementing
 * micromark's rules.
 */
const MATH = /\$\$[\s\S]*?\$\$|\$[^\s$][^$\n]*\$|\\\(|\\\[/;

/** A fenced block with a language — the only thing `detect: false` colours. */
const FENCE = /^ {0,3}(?:```|~~~)[^\s`]/m;

export function needsMath(text: string): boolean {
  return text.includes("$") || text.includes("\\(") || text.includes("\\[") ? MATH.test(text) : false;
}

export function needsCode(text: string): boolean {
  return text.includes("```") || text.includes("~~~") ? FENCE.test(text) : false;
}

/**
 * The rehype plugins this block needs and has. Returns only what has already
 * resolved; anything still in flight arrives on the re-render this hook
 * schedules when it lands.
 */
export function useContentPlugins(text: string): RehypePlugin[] {
  const math = needsMath(text);
  const code = needsCode(text);
  // A counter rather than the plugins themselves: they live in module scope,
  // so this is the only thing that can tell React the render is now different.
  const [, bump] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    let live = true;
    const want = async (kind: "math" | "code") => {
      if (cache[kind]) return;
      await load(kind);
      if (live && cache[kind]) bump();
    };
    if (math) void want("math");
    if (code) void want("code");
    return () => {
      live = false;
    };
  }, [math, code]);

  return React.useMemo(() => {
    const out: RehypePlugin[] = [];
    if (code && cache.code) out.push(cache.code);
    if (math && cache.math) out.push(cache.math);
    return out;
    // `cache.*` is module state the effect above mutates; the bump counter in
    // the render that follows is what makes this memo recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [math, code, cache.math, cache.code]);
}
