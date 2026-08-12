/**
 * Markdown, parsed here rather than by remark.
 *
 * No remark, no rehype, no `marked` — none of them is a dependency of this
 * package and the renderer has no network to fetch one from. That turns out to
 * be the right constraint anyway, because the thing a *streaming* transcript
 * needs is not a spec-complete CommonMark implementation. It needs a parser
 * that can be run on the last paragraph of a reply sixty times a second without
 * re-parsing the ten thousand characters in front of it.
 *
 * That requirement is met by `splitSegments`, and it is the reason this module
 * exists in the shape it does:
 *
 *   A blank line that is not inside an open code fence is a boundary no future
 *   token can move. Text before such a boundary is FINISHED — appending to the
 *   document cannot change how it parses. So the source is cut into segments at
 *   those boundaries; every committed segment is a stable string, memoised by
 *   the component that renders it, and only the trailing segment is re-parsed
 *   as tokens arrive.
 *
 * The result is O(1) amortised parse work per token instead of O(n), which is
 * the difference between a transcript that stays at 60fps through a 4,000-word
 * answer and one that visibly stalls near the end of it.
 *
 * Where this deliberately diverges from CommonMark, it is noted at the site.
 * The divergences are all in the direction of "an LLM does not emit this", and
 * none of them can produce unsafe output: there is no raw-HTML path at all —
 * angle brackets are text, always — and link hrefs are filtered to an explicit
 * scheme allowlist before they ever reach a component.
 */

export type Align = 'left' | 'center' | 'right';

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'strong'; readonly children: readonly Inline[] }
  | { readonly kind: 'em'; readonly children: readonly Inline[] }
  | { readonly kind: 'strike'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly Inline[] }
  | { readonly kind: 'image'; readonly src: string; readonly alt: string }
  | { readonly kind: 'math'; readonly tex: string }
  | { readonly kind: 'break' };

export interface ListItem {
  readonly blocks: readonly Block[];
  /** `null` when the item is not a task-list item. */
  readonly checked: boolean | null;
}

export type Block =
  | { readonly kind: 'paragraph'; readonly inline: readonly Inline[] }
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly inline: readonly Inline[] }
  | {
      readonly kind: 'code';
      readonly language: string | null;
      readonly code: string;
      /** False while the fence is still open — i.e. mid-stream. */
      readonly closed: boolean;
    }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly ListItem[];
    }
  | {
      readonly kind: 'table';
      readonly head: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
      readonly align: readonly (Align | null)[];
    }
  | { readonly kind: 'rule' }
  | { readonly kind: 'math'; readonly tex: string };

/* -------------------------------------------------------------------------- */
/* Streaming segmentation                                                      */
/* -------------------------------------------------------------------------- */

export interface Segments {
  /** Finished. Each string parses identically no matter what arrives later. */
  readonly committed: readonly string[];
  /** The part still being written. Re-parsed on every token; kept small. */
  readonly tail: string;
}

const FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})/;

/**
 * Cut source into stable segments plus a live tail.
 *
 * Two rules decide a boundary, and both exist because of a way real replies are
 * written:
 *
 *   · A blank line ends a segment — unless a code fence is open, where a blank
 *     line is just a blank line in the program.
 *   · Consecutive list blocks are NOT split apart, even though a blank line
 *     separates them. A "loose" list (blank lines between items) is extremely
 *     common in model output, and splitting it would restart the numbering at 1
 *     on every item — a visible, wrong, and very hard-to-miss bug.
 */
export function splitSegments(source: string): Segments {
  const lines = source.split('\n');
  const committed: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const isListish = (text: string): boolean =>
    /^\s{0,3}(?:[-*+]\s|\d{1,9}[.)]\s)/.test(text) || /^\s{0,3}>/.test(text);

  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.join('\n');
    if (text.trim().length === 0) {
      current = [];
      return;
    }
    /* Merge into the previous segment when both are lists or both quotes, so a
       loose list stays one list. */
    const previous = committed[committed.length - 1];
    if (previous !== undefined && isListish(previous) && isListish(text)) {
      committed[committed.length - 1] = `${previous}\n\n${text}`;
    } else {
      committed.push(text);
    }
    current = [];
  };

  for (const line of lines) {
    if (fence !== null) {
      current.push(line);
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[0].trimStart();
      /* The opening run length is the closing requirement; a longer run closes
         it too, which is why only the first three characters are kept. */
      fence = marker.slice(0, 3);
      current.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    current.push(line);
  }

  /* Whatever is left is the tail — including an unclosed fence, which is the
     normal mid-stream state and must stay live so the closing ``` can land. */
  const tail = current.join('\n');
  return { committed, tail };
}

/* -------------------------------------------------------------------------- */
/* Block parsing                                                               */
/* -------------------------------------------------------------------------- */

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const OPEN_FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Parse one segment (or a whole document) into blocks. */
export function parseBlocks(source: string): readonly Block[] {
  return parseLines(source.split('\n'));
}

function parseLines(lines: readonly string[]): readonly Block[] {
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    /* --- fenced code ---------------------------------------------------- */
    const fence = OPEN_FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2] ?? '```';
      const language = (fence[3] ?? '').trim();
      const body: string[] = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        const inner = lines[index];
        if (inner === undefined) break;
        if (inner.trimStart().startsWith(marker.slice(0, 3)) && inner.trim().replace(/[`~]/g, '') === '') {
          closed = true;
          index += 1;
          break;
        }
        body.push(inner);
        index += 1;
      }
      blocks.push({
        kind: 'code',
        language: language.length > 0 ? language : null,
        code: body.join('\n'),
        closed,
      });
      continue;
    }

    /* --- display math ---------------------------------------------------- */
    if (line.trim().startsWith('$$')) {
      const opening = line.trim();
      /* `$$x$$` on one line is complete; otherwise scan for the closer. */
      if (opening.length > 4 && opening.endsWith('$$')) {
        blocks.push({ kind: 'math', tex: opening.slice(2, -2).trim() });
        index += 1;
        continue;
      }
      const body: string[] = [opening.slice(2)];
      index += 1;
      while (index < lines.length) {
        const inner = lines[index];
        if (inner === undefined) break;
        index += 1;
        if (inner.trim().endsWith('$$')) {
          body.push(inner.trim().slice(0, -2));
          break;
        }
        body.push(inner);
      }
      blocks.push({ kind: 'math', tex: body.join('\n').trim() });
      continue;
    }

    /* --- thematic break --------------------------------------------------- */
    if (RULE_RE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    /* --- ATX heading ------------------------------------------------------ */
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const hashes = heading[1] ?? '#';
      const level = Math.min(6, Math.max(1, hashes.length)) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, inline: parseInline(heading[2] ?? '') });
      index += 1;
      continue;
    }

    /* --- blockquote ------------------------------------------------------- */
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (index < lines.length) {
        const quoted = lines[index];
        if (quoted === undefined) break;
        const match = QUOTE_RE.exec(quoted);
        if (match) {
          inner.push(match[1] ?? '');
          index += 1;
          continue;
        }
        /* Lazy continuation: a plain line directly under a quote belongs to it. */
        if (quoted.trim().length > 0 && !RULE_RE.test(quoted) && !OPEN_FENCE_RE.test(quoted)) {
          inner.push(quoted);
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: 'quote', blocks: parseLines(inner) });
      continue;
    }

    /* --- table ------------------------------------------------------------ */
    const next = lines[index + 1];
    if (line.includes('|') && next !== undefined && TABLE_DIVIDER_RE.test(next) && next.includes('-')) {
      const align = splitRow(next).map(toAlign);
      const head = splitRow(line).map(parseInline);
      index += 2;
      const rows: (readonly Inline[])[][] = [];
      while (index < lines.length) {
        const rowLine = lines[index];
        if (rowLine === undefined || rowLine.trim().length === 0 || !rowLine.includes('|')) break;
        rows.push(splitRow(rowLine).map(parseInline));
        index += 1;
      }
      blocks.push({ kind: 'table', head, rows, align });
      continue;
    }

    /* --- list -------------------------------------------------------------- */
    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      const [list, consumed] = parseList(lines, index);
      blocks.push(list);
      index = consumed;
      continue;
    }

    /* --- paragraph ---------------------------------------------------------- */
    const paragraph: string[] = [];
    while (index < lines.length) {
      const inner = lines[index];
      if (inner === undefined || inner.trim().length === 0) break;
      if (
        HEADING_RE.test(inner) ||
        RULE_RE.test(inner) ||
        OPEN_FENCE_RE.test(inner) ||
        QUOTE_RE.test(inner) ||
        BULLET_RE.test(inner) ||
        ORDERED_RE.test(inner)
      ) {
        break;
      }
      paragraph.push(inner);
      index += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join('\n')) });
    } else {
      /* Defensive: never allow the outer loop to fail to advance. */
      index += 1;
    }
  }

  return blocks;
}

function parseList(lines: readonly string[], start: number): [Block, number] {
  const first = lines[start] ?? '';
  const ordered = ORDERED_RE.test(first);
  const opener = ordered ? ORDERED_RE.exec(first) : BULLET_RE.exec(first);
  const baseIndent = (opener?.[1] ?? '').length;
  const startNumber = ordered ? Number.parseInt(opener?.[2] ?? '1', 10) : 1;

  const items: ListItem[] = [];
  let index = start;
  let buffer: string[] = [];
  let checked: boolean | null = null;

  const commit = (): void => {
    if (buffer.length === 0) return;
    items.push({ blocks: parseLines(buffer), checked });
    buffer = [];
    checked = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;

    const bullet = BULLET_RE.exec(line);
    const number = ORDERED_RE.exec(line);
    const marker = ordered ? number : bullet;

    if (marker && (marker[1] ?? '').length <= baseIndent) {
      commit();
      let content = marker[3] ?? '';
      const task = TASK_RE.exec(content);
      if (task) {
        checked = (task[1] ?? ' ').toLowerCase() === 'x';
        content = task[2] ?? '';
      }
      buffer.push(content);
      index += 1;
      continue;
    }

    /* A blank line inside a list is only a separator if the next non-blank line
       is another item or an indented continuation; otherwise the list is over. */
    if (line.trim().length === 0) {
      const following = lines[index + 1];
      if (following === undefined) break;
      const continues =
        BULLET_RE.test(following) || ORDERED_RE.test(following) || /^\s{2,}\S/.test(following);
      if (!continues) break;
      buffer.push('');
      index += 1;
      continue;
    }

    /* Indented continuation — a nested list, or a second paragraph in the item. */
    if (/^\s{2,}\S/.test(line)) {
      buffer.push(line.slice(Math.min(baseIndent + 2, line.length - line.trimStart().length)));
      index += 1;
      continue;
    }

    /* A different marker type at the same level starts a new list, not an item. */
    if (bullet || number) break;

    /* Lazy continuation of the current item's paragraph. */
    if (buffer.length > 0) {
      buffer.push(line);
      index += 1;
      continue;
    }

    break;
  }

  commit();
  return [{ kind: 'list', ordered, start: Number.isFinite(startNumber) ? startNumber : 1, items }, index];
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  let inCode = false;
  for (const character of trimmed) {
    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      cell += character;
      continue;
    }
    /* A pipe inside `code` is a pipe, not a column break — this is the single
       most common way a hand-written table breaks. */
    if (character === '`') inCode = !inCode;
    if (character === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function toAlign(spec: string): Align | null {
  const text = spec.trim();
  const left = text.startsWith(':');
  const right = text.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Inline parsing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Schemes a link may carry.
 *
 * The renderer never navigates — an href is handed to main to open in the
 * user's browser — but that is exactly why this list is short. `javascript:`
 * and `data:` are the obvious ones; `file:` is on the list too, because asking
 * the OS to open an arbitrary local path is a capability a chat reply must not
 * have just by containing a link.
 */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) return false;
  /* Relative links have no meaning in a desktop transcript; there is no
     document to be relative to. Treated as unsafe, i.e. rendered as text. */
  try {
    const url = new URL(trimmed);
    return (SAFE_SCHEMES as readonly string[]).includes(url.protocol);
  } catch {
    return false;
  }
}

/** U+0060. See the `code` alternative below for why this is not written inline. */
const BACKTICK = String.fromCharCode(96);

/**
 * The inline grammar, as a SOURCE STRING rather than a compiled RegExp.
 *
 * Compilation is deferred to `parseInline`, which builds its own instance per
 * call — see the comment there. Keeping the source at module scope is what
 * makes that cheap: V8 caches the compiled program by source text, so the
 * per-call construction is an object allocation and not a re-parse.
 */
const INLINE_SOURCE = [
  /* Order is precedence. Code first: nothing inside a code span is markup.
     Built by interpolating BACKTICK rather than written inline: a backtick
     cannot be escaped inside String.raw, so a literal one there silently
     terminates the template and corrupts the rest of the pattern. */
  `(?<code>${BACKTICK}+[^${BACKTICK}]*${BACKTICK}+)`,
  String.raw`(?<image>!\[(?<alt>[^\]]*)\]\((?<src>[^)\s]+)(?:\s+"[^"]*")?\))`,
  String.raw`(?<link>\[(?<label>[^\]]*)\]\((?<href>[^)\s]+)(?:\s+"[^"]*")?\))`,
  String.raw`(?<autolink><(?<auto>(?:https?|mailto):[^>\s]+)>)`,
  String.raw`(?<bare>\bhttps?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?])`,
  String.raw`(?<strong>\*\*(?=\S)(?:[^*]|\*(?!\*))+?\*\*|__(?=\S)[\s\S]+?__)`,
  String.raw`(?<strike>~~(?=\S)[\s\S]+?~~)`,
  String.raw`(?<em>\*(?=\S)(?:[^*\n]|\\\*)+?\*|_(?=\S)[^_\n]+?_)`,
  String.raw`(?<math>\$(?!\s)(?:[^$\n\\]|\\.)+?\$)`,
  String.raw`(?<hardbreak>(?:  |\\)\n)`,
].join('|');

export function parseInline(source: string): readonly Inline[] {
  /*
   * A FRESH regex per call, and this is not a missed optimisation.
   *
   * `parseInline` is recursive — the contents of `**bold**` are parsed by
   * calling it again — and a `g`-flagged RegExp carries `lastIndex` on the
   * object itself. Sharing one module-level instance means the inner call
   * consumes and then resets that cursor, the outer loop resumes scanning from
   * position 0 of a string it has already consumed, re-matches the same
   * emphasis run, recurses again, and never terminates. It does not throw or
   * stall visibly: it allocates nodes until the renderer runs out of memory.
   *
   * The alternative — saving and restoring `lastIndex` around each of the six
   * recursive call sites — works but is one forgotten line away from the same
   * silent hang. A regex is a small object and V8 caches the compiled program
   * by source, so the honest fix is also the cheap one.
   */
  const pattern = new RegExp(INLINE_SOURCE, 'g');
  const nodes: Inline[] = [];
  let cursor = 0;

  const pushText = (text: string): void => {
    if (text.length === 0) return;
    const previous = nodes[nodes.length - 1];
    if (previous?.kind === 'text') {
      nodes[nodes.length - 1] = { kind: 'text', text: previous.text + text };
      return;
    }
    nodes.push({ kind: 'text', text });
  };

  let match: RegExpExecArray | null = pattern.exec(source);

  while (match !== null) {
    if (match.index > cursor) pushText(unescape(source.slice(cursor, match.index)));
    const groups = match.groups ?? {};

    if (groups['code'] !== undefined) {
      /* CommonMark: strip one leading and trailing space when both are present,
         which is how you write a code span whose content begins with a tick. */
      const raw = groups['code'].replace(/^`+|`+$/g, '');
      const code = raw.startsWith(' ') && raw.endsWith(' ') && raw.trim().length > 0 ? raw.slice(1, -1) : raw;
      nodes.push({ kind: 'code', code });
    } else if (groups['image'] !== undefined) {
      nodes.push({ kind: 'image', src: groups['src'] ?? '', alt: groups['alt'] ?? '' });
    } else if (groups['link'] !== undefined) {
      const href = groups['href'] ?? '';
      const label = groups['label'] ?? '';
      if (isSafeHref(href)) {
        nodes.push({ kind: 'link', href, children: parseInline(label) });
      } else {
        /* Not dropped and not linkified — shown as the text the author wrote,
           so a reader can see what was there and decide for themselves. */
        pushText(`[${label}](${href})`);
      }
    } else if (groups['autolink'] !== undefined) {
      const href = groups['auto'] ?? '';
      nodes.push({ kind: 'link', href, children: [{ kind: 'text', text: href }] });
    } else if (groups['bare'] !== undefined) {
      const href = groups['bare'];
      nodes.push({ kind: 'link', href, children: [{ kind: 'text', text: href }] });
    } else if (groups['strong'] !== undefined) {
      nodes.push({ kind: 'strong', children: parseInline(groups['strong'].slice(2, -2)) });
    } else if (groups['strike'] !== undefined) {
      nodes.push({ kind: 'strike', children: parseInline(groups['strike'].slice(2, -2)) });
    } else if (groups['em'] !== undefined) {
      nodes.push({ kind: 'em', children: parseInline(groups['em'].slice(1, -1)) });
    } else if (groups['math'] !== undefined) {
      nodes.push({ kind: 'math', tex: groups['math'].slice(1, -1) });
    } else if (groups['hardbreak'] !== undefined) {
      nodes.push({ kind: 'break' });
    }

    cursor = match.index + match[0].length;
    if (match[0].length === 0) pattern.lastIndex += 1;
    match = pattern.exec(source);
  }

  if (cursor < source.length) pushText(unescape(source.slice(cursor)));
  return nodes;
}

/** Backslash escapes, applied only to the punctuation markdown gives meaning to. */
function unescape(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!~|$>])/g, '$1');
}

/* -------------------------------------------------------------------------- */
/* Plain-text projection                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The text a "copy message" action should put on the clipboard.
 *
 * Which is the *source*, not a rendering of it — someone copying a reply
 * containing a table almost always wants the markdown, and reconstructing
 * markdown from the AST would be a second, subtly different serializer. This
 * exists for the narrower case of copying a quoted excerpt, and for the
 * accessible name of a conversation row.
 */
export function inlineToText(nodes: readonly Inline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.text;
        break;
      case 'code':
        out += node.code;
        break;
      case 'math':
        out += node.tex;
        break;
      case 'image':
        out += node.alt;
        break;
      case 'break':
        out += ' ';
        break;
      case 'strong':
      case 'em':
      case 'strike':
      case 'link':
        out += inlineToText(node.children);
        break;
    }
  }
  return out;
}

/**
 * A one-line preview of a message, for conversation rows and window titles.
 *
 * Runs the block parser rather than a regex, because the regex version of this
 * is where `#`, `*` and `|` leak into a sidebar and make every title look like
 * a syntax error.
 */
export function toPreview(source: string, limit = 140): string {
  const blocks = parseBlocks(source.slice(0, 2000));
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'paragraph' || block.kind === 'heading') parts.push(inlineToText(block.inline));
    else if (block.kind === 'code') parts.push(block.code.split('\n')[0] ?? '');
    else if (block.kind === 'list') {
      const first = block.items[0];
      if (first) parts.push(blocksToPreview(first.blocks));
    }
    if (parts.join(' ').trim().length >= limit) break;
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function blocksToPreview(blocks: readonly Block[]): string {
  const first = blocks[0];
  if (!first) return '';
  if (first.kind === 'paragraph' || first.kind === 'heading') return inlineToText(first.inline);
  if (first.kind === 'code') return first.code.split('\n')[0] ?? '';
  return '';
}
