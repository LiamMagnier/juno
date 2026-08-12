/**
 * A fenced code block.
 *
 * Three things this does that a `<pre>` does not:
 *
 *   · **Copies the source, not the DOM.** The clipboard gets the exact string
 *     the parser produced. Reading `element.innerText` instead — which is what
 *     most implementations do — silently rewrites tabs, collapses the gutter
 *     into the code, and inserts line breaks at the soft-wrap points, so what
 *     the user pastes is not what they saw.
 *   · **Scrolls itself.** A wide line scrolls inside the block. If it were
 *     allowed to widen the block, it would widen the message, which would
 *     widen the transcript, and the whole conversation would develop a
 *     horizontal scrollbar because one reply contained a long import path.
 *   · **Caps its own height.** A 900-line file pasted into a reply must not
 *     push the rest of the conversation off the screen; past a threshold the
 *     block scrolls internally and says how many lines are in it.
 *
 * Tokenizing happens in `useMemo` keyed on the code and language, and the whole
 * component is memoised, because a streaming fence re-renders on every frame
 * and re-lexing a settled block on each of those is exactly the kind of waste
 * this surface is built to avoid.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../lib/bridge.js';
import { cn } from '../lib/cn.js';
import { languageLabel, tokenColor, tokenize, type Token } from '../lib/highlight.js';
import { CheckIcon, CopyIcon } from './icons.js';
import { IconButton } from './primitives.js';

/** Above this many lines the block scrolls internally instead of growing. */
const MAX_VISIBLE_LINES = 28;
/** Below this, the gutter is noise rather than navigation. */
const MIN_LINES_FOR_GUTTER = 3;

function toLines(tokens: readonly Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split('\n');
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) lines.push([]);
      const text = parts[index];
      if (text === undefined || text.length === 0) continue;
      lines[lines.length - 1]?.push({ kind: token.kind, text });
    }
  }
  /* A trailing newline produces a final empty line that is real in the source
     but noise in the display. */
  if (lines.length > 1 && lines[lines.length - 1]?.length === 0) lines.pop();
  return lines;
}

export interface CodeBlockProps {
  readonly code: string;
  readonly language: string | null;
  /** False while the fence is still open — the closing ``` has not arrived. */
  readonly closed?: boolean;
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  closed = true,
}: CodeBlockProps): ReactNode {
  const lines = useMemo(() => toLines(tokenize(code, language)), [code, language]);
  const showGutter = lines.length >= MIN_LINES_FOR_GUTTER;
  const scrolls = lines.length > MAX_VISIBLE_LINES;

  return (
    <figure
      className={cn(
        /* `bg-card` rather than `bg-muted`: the card step is the next rung of
           the lightness ladder above the transcript's background, which is how
           this reads as inset on warm paper AND on true black. */
        'group/code my-4 overflow-hidden rounded-card border border-border bg-card',
      )}
    >
      <figcaption className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="font-mono text-caption lowercase tracking-[0.02em] text-muted-foreground">
          {languageLabel(language)}
          {scrolls ? <span className="ml-2 opacity-70">{lines.length} lines</span> : null}
        </span>
        <CopyButton text={code} />
      </figcaption>

      <div
        className="overflow-x-auto overflow-y-auto"
        style={scrolls ? { maxHeight: `${MAX_VISIBLE_LINES * 1.6}em` } : undefined}
        /* Focusable so a keyboard user can scroll a long block; without this a
           block taller than its cap is unreachable without a mouse. */
        tabIndex={scrolls ? 0 : -1}
        role={scrolls ? 'region' : undefined}
        aria-label={scrolls ? `${languageLabel(language)} code, ${lines.length} lines` : undefined}
      >
        <pre className="w-fit min-w-full px-3 py-2.5 font-mono text-caption leading-[1.6]">
          <code>
            {lines.map((tokens, index) => (
              // eslint-disable-next-line react/no-array-index-key -- lines have no identity but their position
              <span key={index} className="flex">
                {showGutter ? (
                  <span
                    aria-hidden="true"
                    className="mr-3 inline-block w-[2.5ch] shrink-0 select-none text-right text-muted-foreground/55"
                  >
                    {index + 1}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 whitespace-pre">
                  {tokens.length === 0 ? ' ' : tokens.map((token, at) => {
                    const color = tokenColor(token.kind);
                    if (color === null) return token.text;
                    return (
                      // eslint-disable-next-line react/no-array-index-key -- tokens are positional
                      <span key={at} style={{ color }} className={token.kind === 'comment' ? 'italic' : undefined}>
                        {token.text}
                      </span>
                    );
                  })}
                </span>
              </span>
            ))}
            {/* The stream tail. A caret on the last line makes it obvious the
                block is still arriving rather than truncated. */}
            {!closed ? (
              <span aria-hidden="true" className="ml-0.5 inline-block h-[1em] w-[0.5ch] animate-blink bg-current align-text-bottom" />
            ) : null}
          </code>
        </pre>
      </div>
    </figure>
  );
});

/**
 * Copy, with the confirmation on the control itself.
 *
 * A toast for a copy is the wrong shape of feedback: it appears away from where
 * the user is looking, for an action whose success they need to know about for
 * about a second. The icon swapping to a check, in place, is both faster to
 * read and impossible to miss.
 */
export function CopyButton({ text, label = 'Copy code' }: { text: string; label?: string }): ReactNode {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = useCallback(() => {
    void (async () => {
      const copied = await copyText(text);
      setState(copied ? 'copied' : 'failed');
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState('idle'), 1600);
    })();
  }, [text]);

  return (
    <IconButton
      size="icon-sm"
      label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      onClick={onCopy}
      className={cn(
        'opacity-0 transition-opacity duration-fast',
        'group-hover/code:opacity-100 focus-visible:opacity-100',
        state !== 'idle' && 'opacity-100',
      )}
    >
      {state === 'copied' ? (
        <CheckIcon className="size-3.5 text-success-ink" />
      ) : (
        <CopyIcon className={cn('size-3.5', state === 'failed' && 'text-destructive-ink')} />
      )}
    </IconButton>
  );
}
