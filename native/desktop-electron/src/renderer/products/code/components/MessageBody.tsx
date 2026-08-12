/**
 * Assistant prose, and the live-streaming path.
 *
 * `StreamingText` is the only component in the surface that re-renders per
 * token. It subscribes to the store's `stream` channel — which the timeline
 * does not — so a token updates one text node and leaves every other entry's
 * props identical. That is the whole performance contract in one component.
 *
 * The renderer is a deliberately small subset of Markdown: fenced code blocks,
 * inline code, and paragraphs. An agent transcript is mostly prose and code;
 * pulling in a Markdown pipeline to also get tables would add a parser to the
 * hot path for a case that barely occurs. Everything is rendered as React
 * children, never as HTML, so model output cannot inject markup.
 */

import { memo, useCallback, useMemo, useSyncExternalStore, type JSX } from 'react';
import { cn } from '../lib/cn.js';
import type { CodeSessionStore } from '../state/timeline-store.js';

interface Block {
  kind: 'text' | 'code';
  content: string;
  language: string | null;
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let buffer: string[] = [];
  let inFence = false;
  let fenceLanguage: string | null = null;

  const flush = (kind: Block['kind']): void => {
    if (buffer.length === 0) return;
    blocks.push({ kind, content: buffer.join('\n'), language: fenceLanguage });
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inFence) {
        flush('code');
        inFence = false;
        fenceLanguage = null;
      } else {
        flush('text');
        inFence = true;
        fenceLanguage = line.slice(3).trim() || null;
      }
      continue;
    }
    buffer.push(line);
  }
  /* An unterminated fence is the normal state mid-stream: render it as code
     anyway so the block does not flip presentation when the fence closes. */
  flush(inFence ? 'code' : 'text');
  return blocks;
}

const INLINE_CODE = /`([^`\n]+)`/g;

function renderInline(text: string, keyPrefix: string): JSX.Element[] {
  const nodes: JSX.Element[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_CODE.lastIndex = 0;
  while ((match = INLINE_CODE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`${keyPrefix}-t${lastIndex}`}>{text.slice(lastIndex, match.index)}</span>);
    }
    nodes.push(
      <code
        key={`${keyPrefix}-c${match.index}`}
        className="rounded border border-border bg-muted px-1 py-px font-mono text-[11px] text-foreground"
      >
        {match[1]}
      </code>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(<span key={`${keyPrefix}-t${lastIndex}`}>{text.slice(lastIndex)}</span>);
  }
  return nodes;
}

export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}): JSX.Element {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className={cn('space-y-2 text-[13px] leading-[1.65] text-foreground', className)}>
      {/* Blocks are a positional split of one immutable message; they never
          reorder, so the index is a stable identity. */}
      {/* eslint-disable react/no-array-index-key */}
      {blocks.map((block, index) =>
        block.kind === 'code' ? (
          <pre
            key={`b${index}`}
            /* Opaque, never translucent: reading code through a blur is a
               readability regression dressed as a visual effect. */
            className="overflow-x-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-foreground"
          >
            {block.language ? (
              <span className="mb-1 block select-none text-[10px] uppercase tracking-wide text-muted-foreground">
                {block.language}
              </span>
            ) : null}
            <code>{block.content}</code>
          </pre>
        ) : (
          <p key={`b${index}`} className="whitespace-pre-wrap break-words">
            {renderInline(block.content, `b${index}`)}
          </p>
        ),
      )}
      {/* eslint-enable react/no-array-index-key */}
    </div>
  );
});

/**
 * Live text. Subscribes to `stream` only; `entryId` guards against a stale
 * entry rendering a newer message's buffer after a turn boundary.
 *
 * Streaming text is rendered as plain pre-wrapped text, not through
 * `MessageMarkdown`, and that is a performance decision rather than a
 * simplification. Block-splitting is O(length), so running it on every token
 * makes rendering one message O(length²) — 2,500 tokens of a 10k-character
 * answer is roughly 25M character operations spread across the frames the user
 * is watching. The Markdown pass runs exactly once, when the message completes
 * and the store commits it into the entry. As a bonus, blocks stop reflowing
 * as an unterminated code fence opens and closes mid-stream.
 */
export const StreamingText = memo(function StreamingText({
  store,
  entryId,
}: {
  store: CodeSessionStore;
  entryId: string;
}): JSX.Element {
  const subscribe = useMemo(() => store.subscribeTo('stream'), [store]);
  const getSnapshot = useCallback(() => store.getStreamText(), [store]);
  const text = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isCurrent = store.getStreamEntryId() === entryId;
  const body = isCurrent ? text : '';

  return (
    <div className="text-[13px] leading-[1.65] text-foreground">
      <span className="whitespace-pre-wrap break-words">{body}</span>
      <span
        aria-hidden="true"
        className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-primary align-baseline"
      />
      <span className="sr-only">Response in progress.</span>
    </div>
  );
});
