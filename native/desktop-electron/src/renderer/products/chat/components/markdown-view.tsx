/**
 * The markdown renderer.
 *
 * The performance contract of this component is the reason the parser in
 * `lib/markdown.ts` is shaped the way it is, and it is worth stating plainly
 * because it is the difference between a smooth stream and a janky one:
 *
 *     Source is split into COMMITTED segments and a live TAIL. Each committed
 *     segment is rendered by a memoised child whose only prop is its own
 *     string. As tokens arrive, those strings do not change, so React bails out
 *     of every committed segment at the memo boundary and re-renders only the
 *     tail — which is one paragraph, or one code fence.
 *
 * So the cost of a token is proportional to the size of the paragraph being
 * written, not to the size of the reply. A 4,000-word answer costs the same per
 * token at the end as it did at the start.
 *
 * There is no `dangerouslySetInnerHTML` anywhere in this file, and no path that
 * could introduce one: the parser emits an AST of known node kinds and this
 * module maps each kind to an element. Raw HTML in the source is text, because
 * the parser has no rule that produces anything else from it.
 */

import { memo, useCallback, useMemo, type ReactNode } from 'react';
import { openExternal } from '../lib/bridge.js';
import { cn } from '../lib/cn.js';
import {
  parseBlocks,
  splitSegments,
  type Align,
  type Block,
  type Inline,
} from '../lib/markdown.js';
import { CodeBlock } from './code-block.js';
import { ExternalLinkIcon } from './icons.js';
import { Math } from './math.js';

/* -------------------------------------------------------------------------- */
/* Links                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A link that never navigates.
 *
 * `href` is set for the sake of hover status, keyboard semantics and
 * copy-link-address, but the click is always prevented: a top-level navigation
 * in the app window would replace Juno with a web page, in a window that has no
 * address bar and no back button to return from. Main opens it in the user's
 * real browser instead.
 */
function ExternalLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  const onActivate = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      void openExternal(href);
    },
    [href],
  );

  return (
    <a
      href={href}
      onClick={onActivate}
      className={cn(
        'break-words font-medium text-primary-ink underline decoration-primary/35 underline-offset-[3px]',
        'transition-colors duration-fast hover:decoration-primary',
      )}
    >
      {children}
      {/*
        Appended to the accessible name rather than set as an `aria-label`.
        A label would REPLACE the link text, which is the actual destination
        description and the thing a screen-reader user navigates links by —
        turning every link in the transcript into "Link, opens in your browser".
      */}
      <span className="sr-only"> (opens in your browser)</span>
      <ExternalLinkIcon className="ml-0.5 inline size-3 align-baseline opacity-60" />
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/* Inline                                                                      */
/* -------------------------------------------------------------------------- */

function renderInline(nodes: readonly Inline[], keyPrefix = ''): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;
    switch (node.kind) {
      case 'text':
        return <span key={key}>{node.text}</span>;

      case 'code':
        return (
          <code
            key={key}
            className="rounded-xs border border-border bg-muted px-[0.35em] py-[0.1em] font-mono text-[0.86em]"
          >
            {node.code}
          </code>
        );

      case 'strong':
        return (
          <strong key={key} className="font-semibold text-foreground">
            {renderInline(node.children, `${key}-`)}
          </strong>
        );

      case 'em':
        return <em key={key}>{renderInline(node.children, `${key}-`)}</em>;

      case 'strike':
        return (
          <s key={key} className="text-muted-foreground">
            {renderInline(node.children, `${key}-`)}
          </s>
        );

      case 'link':
        return (
          <ExternalLink key={key} href={node.href}>
            {renderInline(node.children, `${key}-`)}
          </ExternalLink>
        );

      case 'image':
        return (
          <img
            key={key}
            src={node.src}
            alt={node.alt}
            /* No lazy loading: inside a virtualized transcript the row is
               already unmounted when off-screen, so `loading="lazy"` would
               only delay images the user is looking at. */
            className="my-3 max-w-full rounded-card border border-border"
          />
        );

      case 'math':
        return <Math key={key} tex={node.tex} />;

      case 'break':
        return <br key={key} />;
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

const ALIGN_CLASS: Record<Align, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p key={key} className="my-3 first:mt-0 last:mb-0">
          {renderInline(block.inline, `${key}-`)}
        </p>
      );

    case 'heading': {
      const content = renderInline(block.inline, `${key}-`);
      /* Serif for the two loudest levels — the expressive face earns its place
         at display sizes and nowhere else. Below that, the grotesque, because a
         serif h4 inside body copy reads as an accident. */
      const shared = 'mb-2 mt-6 first:mt-0 text-foreground';
      switch (block.level) {
        case 1:
          return <h1 key={key} className={cn(shared, 'font-serif text-title')}>{content}</h1>;
        case 2:
          return <h2 key={key} className={cn(shared, 'font-serif text-heading')}>{content}</h2>;
        case 3:
          return <h3 key={key} className={cn(shared, 'text-body-lg font-semibold')}>{content}</h3>;
        default:
          return (
            <h4 key={key} className={cn(shared, 'font-mono text-caption uppercase tracking-[0.1em] text-muted-foreground')}>
              {content}
            </h4>
          );
      }
    }

    case 'code':
      return <CodeBlock key={key} code={block.code} language={block.language} closed={block.closed} />;

    case 'quote':
      return (
        <blockquote
          key={key}
          /* A rule and a colour shift, not a tinted card. A filled box around
             every quotation is the visual tic that makes an interface look
             machine-generated. */
          className="my-4 border-l-2 border-border pl-4 text-muted-foreground"
        >
          {block.blocks.map((child, index) => renderBlock(child, `${key}-${index}`))}
        </blockquote>
      );

    case 'list': {
      const items = block.items.map((item, index) => (
        // eslint-disable-next-line react/no-array-index-key -- list items have no id
        <li key={`${key}-${index}`} className={cn('my-1', item.checked !== null && 'list-none')}>
          {item.checked !== null ? (
            <span className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={item.checked}
                readOnly
                /* Read-only and labelled as such: this is a rendering of what
                   the model wrote, not a control the user can drive. Leaving it
                   clickable would imply state that goes nowhere. */
                aria-label={item.checked ? 'Completed item' : 'Incomplete item'}
                className="mt-1.5 size-3.5 shrink-0 accent-primary"
              />
              <span className="min-w-0 flex-1">
                {item.blocks.map((child, at) => renderBlock(child, `${key}-${index}-${at}`))}
              </span>
            </span>
          ) : (
            item.blocks.map((child, at) => renderBlock(child, `${key}-${index}-${at}`))
          )}
        </li>
      ));

      return block.ordered ? (
        <ol key={key} start={block.start} className="my-3 list-decimal space-y-1 pl-5 marker:text-muted-foreground">
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-3 list-disc space-y-1 pl-5 marker:text-muted-foreground">
          {items}
        </ul>
      );
    }

    case 'table':
      return (
        /* The scroll container is the wrapper, never the page. A wide table
           must not give the transcript a horizontal scrollbar. */
        <div key={key} className="my-4 overflow-x-auto rounded-card border border-border">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-border bg-secondary/60">
                {block.head.map((cell, index) => (
                  <th
                    // eslint-disable-next-line react/no-array-index-key -- columns are positional
                    key={`${key}-h-${index}`}
                    scope="col"
                    className={cn(
                      'px-3 py-2 text-left font-medium text-foreground',
                      ALIGN_CLASS[block.align[index] ?? 'left'],
                    )}
                  >
                    {renderInline(cell, `${key}-h-${index}-`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                // eslint-disable-next-line react/no-array-index-key -- rows are positional
                <tr key={`${key}-r-${rowIndex}`} className="border-b border-border last:border-b-0">
                  {row.map((cell, cellIndex) => (
                    <td
                      // eslint-disable-next-line react/no-array-index-key -- cells are positional
                      key={`${key}-r-${rowIndex}-${cellIndex}`}
                      className={cn('px-3 py-2 align-top', ALIGN_CLASS[block.align[cellIndex] ?? 'left'])}
                    >
                      {renderInline(cell, `${key}-r-${rowIndex}-${cellIndex}-`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'rule':
      return <hr key={key} className="my-6 border-0 border-t border-border" />;

    case 'math':
      return <Math key={key} tex={block.tex} display />;
  }
}

/* -------------------------------------------------------------------------- */
/* Segments                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One stable slice of the document.
 *
 * `memo` with the default shallow comparison is exactly right here: the only
 * prop is a string, and a committed segment's string is identical on every
 * subsequent render. This is the boundary the whole streaming design rests on.
 */
const Segment = memo(function Segment({ source }: { source: string }): ReactNode {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return <>{blocks.map((block, index) => renderBlock(block, `b${index}`))}</>;
});

export interface MarkdownProps {
  readonly source: string;
  /** Adds the caret on the trailing block. */
  readonly streaming?: boolean;
  readonly className?: string | undefined;
}

export const Markdown = memo(function Markdown({
  source,
  streaming = false,
  className,
}: MarkdownProps): ReactNode {
  /* Segmenting is a line scan — cheap, and re-run per frame while streaming.
     The expensive half is parsing and element creation, and that is what the
     memo boundary below actually saves. */
  const { committed, tail } = useMemo(() => splitSegments(source), [source]);

  return (
    <div
      className={cn(
        'text-pretty [word-break:break-word]',
        /* A reading surface: opaque, quiet, no tint. Everything expressive
           happens in the type, not in the container. */
        className,
      )}
    >
      {committed.map((segment, index) => (
        // eslint-disable-next-line react/no-array-index-key -- segments only ever append
        <Segment key={index} source={segment} />
      ))}
      {tail.length > 0 ? (
        <span className={streaming ? 'stream-tail' : undefined}>
          <Segment source={tail} />
        </span>
      ) : null}
    </div>
  );
});
