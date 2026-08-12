/**
 * Diff review — unified and side-by-side.
 *
 * Bounding the render is the whole engineering problem here. A diff is the one
 * payload in this app with no upper size, and a 50,000-line file laid out at
 * once is several seconds of blocked main thread. Three bounds, in order:
 *
 *  1. Files are collapsed by default past the first few, so a 40-file changeset
 *     mounts headers, not bodies.
 *  2. Each file body is cut at a line budget during parsing (`DEFAULT_LINE_BUDGET`),
 *     with the remainder reachable through an explicit control that states how
 *     many lines it will add. Nothing is hidden silently.
 *  3. Unchanged context inside a hunk folds to a skip marker, expandable in
 *     place.
 *
 * Syntax highlighting runs per rendered line via the small tokenizer in
 * `lib/diff.ts` — visible lines only, so cost tracks the viewport rather than
 * the file. Colours are semantic tokens; the add/remove tint carries the
 * meaning and the code itself stays quiet.
 *
 * Per-hunk actions are honest about what is wired. Copy works. Revert and
 * "expand context" both need capabilities the IPC contract does not expose
 * (writing to the workspace, reading the surrounding file), so they render
 * disabled with that reason attached rather than as buttons that lie.
 */

import { useCallback, useMemo, useState, type JSX } from 'react';
import { cn } from '../lib/cn.js';
import {
  DEFAULT_LINE_BUDGET,
  expandSkip,
  foldContext,
  tokenize,
  totalsFor,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type HunkRow,
  type TokenKind,
} from '../lib/diff.js';
import { relativeTo } from '../lib/format.js';
import { splitPath } from '../lib/tools.js';
import { Badge, Button, EmptyState, FOCUS_RING, InertNote, Mono, Segmented } from './primitives.js';
import { AlertIcon, ChevronDown, ChevronRight, FileIcon } from './icons.js';

export type DiffView = 'unified' | 'split';

export interface DiffReviewProps {
  files: readonly DiffFile[];
  /** Paths known to have changed with no content available (shell-driven edits). */
  unavailablePaths: readonly string[];
  cwd: string;
  className?: string;
}

/* -------------------------------------------------------------------------- */

const TOKEN_CLASS: Record<TokenKind, string> = {
  /* Syntax colour comes from the `code.*` family, not from `success`/`warning`.
     Those two carry state meaning — a run passed, a run is degraded — and a
     string literal is neither; tying them together means a theme change to one
     silently repaints the other. `text-primary` resolves to the AA ink ramp for
     text, which is why a keyword at 11.5px stays readable.
     The add/remove tint on the line does the semantic work; this layer is
     quiet on purpose. */
  plain: '',
  keyword: 'text-primary',
  string: 'text-code-string',
  number: 'text-code-number',
  comment: 'text-muted-foreground italic',
};

function Code({ text, language }: { text: string; language: string }): JSX.Element {
  const tokens = useMemo(() => tokenize(text, language), [text, language]);
  if (tokens.length === 0) return <span> </span>;
  return (
    <>
      {/* Index keys are correct here: tokens are a positional decomposition of
          one immutable string. The list cannot reorder, and two identical
          tokens on a line are genuinely interchangeable. */}
      {/* eslint-disable react/no-array-index-key */}
      {tokens.map((token, index) =>
        token.kind === 'plain' ? (
          <span key={index}>{token.text}</span>
        ) : (
          <span key={index} className={TOKEN_CLASS[token.kind]}>
            {token.text}
          </span>
        ),
      )}
      {/* eslint-enable react/no-array-index-key */}
    </>
  );
}

function Gutter({ value }: { value: number | null }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="w-10 shrink-0 select-none pr-2 text-right font-mono text-[10.5px] leading-[1.55] text-muted-foreground/70"
    >
      {value === null ? '·' : value}
    </span>
  );
}

/* Add/remove IS a state — the line survived or it did not — so `success` and
   `destructive` are the right families here, unlike for syntax tokens above. */
const LINE_BG: Record<DiffLine['kind'], string> = {
  add: 'bg-success/10',
  del: 'bg-destructive/10',
  context: '',
};

const LINE_MARK: Record<DiffLine['kind'], string> = {
  add: '+',
  del: '-',
  context: ' ',
};

function UnifiedLine({ line, language }: { line: DiffLine; language: string }): JSX.Element {
  return (
    <div className={cn('flex items-start', LINE_BG[line.kind])}>
      <Gutter value={line.oldNumber} />
      <Gutter value={line.newNumber} />
      <span
        aria-hidden="true"
        className={cn(
          'w-3 shrink-0 select-none text-center font-mono text-[11px] leading-[1.55]',
          line.kind === 'add' && 'text-success',
          line.kind === 'del' && 'text-destructive',
          line.kind === 'context' && 'text-muted-foreground/40',
        )}
      >
        {LINE_MARK[line.kind]}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 font-mono text-[11.5px] leading-[1.55] text-foreground">
        <Code text={line.text} language={language} />
      </span>
    </div>
  );
}

function SplitLine({
  left,
  right,
  language,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
  language: string;
}): JSX.Element {
  return (
    <div className="flex items-start">
      <div className={cn('flex min-w-0 flex-1 items-start', left ? LINE_BG[left.kind] : 'bg-muted/30')}>
        <Gutter value={left?.oldNumber ?? null} />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 font-mono text-[11.5px] leading-[1.55] text-foreground">
          {left ? <Code text={left.text} language={language} /> : null}
        </span>
      </div>
      <div className="w-px shrink-0 self-stretch bg-border" />
      <div className={cn('flex min-w-0 flex-1 items-start', right ? LINE_BG[right.kind] : 'bg-muted/30')}>
        <Gutter value={right?.newNumber ?? null} />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 font-mono text-[11.5px] leading-[1.55] text-foreground">
          {right ? <Code text={right.text} language={language} /> : null}
        </span>
      </div>
    </div>
  );
}

/** Pair del/add runs for side-by-side. Context lines sit on both sides. */
function pairRows(rows: readonly HunkRow[]): Array<{
  key: string;
  left: DiffLine | null;
  right: DiffLine | null;
  skip?: { count: number; from: number };
}> {
  const paired: Array<{
    key: string;
    left: DiffLine | null;
    right: DiffLine | null;
    skip?: { count: number; from: number };
  }> = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!row) break;
    if (row.kind === 'skip') {
      paired.push({ key: row.key, left: null, right: null, skip: { count: row.count, from: row.from } });
      index += 1;
      continue;
    }
    if (row.line.kind === 'context') {
      paired.push({ key: row.key, left: row.line, right: row.line });
      index += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (index < rows.length) {
      const candidate = rows[index];
      if (!candidate || candidate.kind !== 'line' || candidate.line.kind !== 'del') break;
      dels.push(candidate.line);
      index += 1;
    }
    while (index < rows.length) {
      const candidate = rows[index];
      if (!candidate || candidate.kind !== 'line' || candidate.line.kind !== 'add') break;
      adds.push(candidate.line);
      index += 1;
    }
    const height = Math.max(dels.length, adds.length);
    for (let offset = 0; offset < height; offset += 1) {
      paired.push({
        key: `${row.key}:p${offset}`,
        left: dels[offset] ?? null,
        right: adds[offset] ?? null,
      });
    }
    if (height === 0) index += 1;
  }
  return paired;
}

/* -------------------------------------------------------------------------- */

function HunkBody({
  hunk,
  file,
  view,
}: {
  hunk: DiffHunk;
  file: DiffFile;
  view: DiffView;
}): JSX.Element {
  const [expandedSkips, setExpandedSkips] = useState<ReadonlySet<number>>(() => new Set());

  const rows = useMemo(() => {
    const folded = foldContext(hunk);
    if (expandedSkips.size === 0) return folded;
    const output: HunkRow[] = [];
    for (const row of folded) {
      if (row.kind === 'skip' && expandedSkips.has(row.from)) {
        output.push(...expandSkip(hunk, row.from, row.count));
      } else {
        output.push(row);
      }
    }
    return output;
  }, [hunk, expandedSkips]);

  const expand = useCallback((from: number): void => {
    setExpandedSkips((previous) => {
      const next = new Set(previous);
      next.add(from);
      return next;
    });
  }, []);

  if (view === 'split') {
    const paired = pairRows(rows);
    return (
      <div className="overflow-x-auto">
        {paired.map((row) =>
          row.skip ? (
            <SkipRow key={row.key} count={row.skip.count} onExpand={() => expand(row.skip?.from ?? 0)} />
          ) : (
            <SplitLine key={row.key} left={row.left} right={row.right} language={file.language} />
          ),
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      {rows.map((row) =>
        row.kind === 'skip' ? (
          <SkipRow key={row.key} count={row.count} onExpand={() => expand(row.from)} />
        ) : (
          <UnifiedLine key={row.key} line={row.line} language={file.language} />
        ),
      )}
    </div>
  );
}

function SkipRow({ count, onExpand }: { count: number; onExpand: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onExpand}
      className={cn(
        'flex w-full items-center gap-2 border-y border-border bg-muted/40 px-3 py-0.5 text-left',
        'transition-colors duration-100 hover:bg-muted',
        FOCUS_RING,
      )}
    >
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      <Mono className="text-muted-foreground">
        {count} unchanged {count === 1 ? 'line' : 'lines'}
      </Mono>
    </button>
  );
}

/* -------------------------------------------------------------------------- */

function statusBadge(file: DiffFile): JSX.Element {
  switch (file.status) {
    case 'added':
      return <Badge tone="positive">added</Badge>;
    case 'deleted':
      return <Badge tone="danger">deleted</Badge>;
    case 'renamed':
      return <Badge tone="neutral">renamed</Badge>;
    case 'modified':
      return <Badge tone="neutral">modified</Badge>;
  }
}

function FileCard({
  file,
  cwd,
  view,
  defaultOpen,
}: {
  file: DiffFile;
  cwd: string;
  view: DiffView;
  defaultOpen: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [showAll, setShowAll] = useState(false);
  const relative = relativeTo(cwd, file.path);
  const { dir, base } = splitPath(relative);
  const hidden = Math.max(0, file.totalLines - file.hunks.reduce((sum, h) => sum + h.lines.length, 0));

  return (
    <section
      className={cn(
        'overflow-hidden rounded-md border bg-card',
        file.conflicted ? 'border-destructive' : 'border-border',
      )}
      aria-label={`Diff for ${relative}`}
    >
      <header
        className={cn(
          'flex items-center gap-2 border-b px-2 py-1.5',
          file.conflicted ? 'border-destructive/50 bg-destructive/10' : 'border-border bg-muted',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${relative}`}
          className={cn('shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground', FOCUS_RING)}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" title={file.path}>
          <Mono className="text-muted-foreground">{dir}</Mono>
          <Mono className="text-foreground">{base}</Mono>
        </span>
        {file.conflicted ? (
          <Badge tone="danger">
            <AlertIcon className="h-2.5 w-2.5" />
            conflict
          </Badge>
        ) : null}
        {file.origin === 'reconstructed' ? (
          <Badge tone="neutral" title="Rebuilt from the edit the agent made, not from a whole-file diff.">
            fragment
          </Badge>
        ) : null}
        {statusBadge(file)}
        <Mono className="shrink-0 text-success">+{file.added}</Mono>
        <Mono className="shrink-0 text-destructive">−{file.removed}</Mono>
      </header>

      {open ? (
        <div>
          {file.binary ? (
            <p className="px-3 py-2 text-[12px] text-muted-foreground">
              Binary file — no textual diff.
            </p>
          ) : file.origin === 'unavailable' ? (
            <div className="space-y-1 px-3 py-2">
              <p className="text-[12px] text-muted-foreground">
                This file changed, but its content is not available to review here.
              </p>
              <InertNote>
                Whole-file diffs come from the agent host’s <Mono>diff</Mono> command. No
                <Mono> code:diff </Mono> channel is declared in <Mono>src/shared/ipc.ts</Mono>, so the
                renderer cannot request it.
              </InertNote>
            </div>
          ) : (
            file.hunks.map((hunk) => (
              <div key={hunk.id} className="border-b border-border last:border-b-0">
                <div className="flex items-center gap-2 bg-background px-2 py-1">
                  <Mono className="min-w-0 flex-1 truncate text-muted-foreground">{hunk.header}</Mono>
                  {hunk.conflicted ? <Badge tone="danger">conflicted</Badge> : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const text = hunk.lines
                        .map((line) => `${LINE_MARK[line.kind]}${line.text}`)
                        .join('\n');
                      void navigator.clipboard?.writeText(text);
                    }}
                  >
                    Copy
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled
                    disabledReason="Reverting writes to the workspace. No IPC channel exposes that from the renderer."
                  >
                    Revert
                  </Button>
                </div>
                <HunkBody hunk={hunk} file={file} view={view} />
              </div>
            ))
          )}

          {file.truncated && !showAll ? (
            <div className="flex items-center gap-2 border-t border-border bg-muted px-3 py-1.5">
              <Mono className="flex-1 text-muted-foreground">
                {hidden > 0 ? `${hidden} more lines not rendered` : 'Output truncated'}
              </Mono>
              <Button
                size="sm"
                onClick={() => setShowAll(true)}
                disabled
                disabledReason={`This file exceeds the ${DEFAULT_LINE_BUDGET}-line render budget. Raising it requires re-reading the source, which needs a diff channel the IPC contract does not expose.`}
              >
                Show all
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

export function DiffReview({
  files,
  unavailablePaths,
  cwd,
  className,
}: DiffReviewProps): JSX.Element {
  const [view, setView] = useState<DiffView>('unified');
  const totals = useMemo(() => totalsFor(files), [files]);

  const all = useMemo(() => [...files], [files]);

  if (all.length === 0 && unavailablePaths.length === 0) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}>
        <EmptyState
          icon={<FileIcon className="h-5 w-5" />}
          title="No changes yet"
          detail="File edits made by the agent appear here as reviewable diffs, with conflicts and worktree state called out."
        />
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[12px] font-medium text-foreground">Changes</span>
        <Mono className="text-muted-foreground">
          {totals.files} {totals.files === 1 ? 'file' : 'files'}
        </Mono>
        <Mono className="text-success">+{totals.added}</Mono>
        <Mono className="text-destructive">−{totals.removed}</Mono>
        {totals.conflicted > 0 ? (
          <Badge tone="danger">{totals.conflicted} conflicted</Badge>
        ) : null}
        <span className="flex-1" />
        <Segmented
          label="Diff layout"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'unified', label: 'Unified' },
            { value: 'split', label: 'Side by side' },
          ]}
        />
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {all.map((file, index) => (
          <FileCard
            key={file.id}
            file={file}
            cwd={cwd}
            view={view}
            /* Only the first few open by default: a 40-file changeset must not
               mount 40 bodies to show its header list. */
            defaultOpen={index < 3 && file.totalLines < 400}
          />
        ))}

        {unavailablePaths.length > 0 ? (
          <section className="rounded-md border border-border bg-card" aria-label="Changed without a diff">
            <header className="border-b border-border bg-muted px-2 py-1.5">
              <span className="text-[12px] font-medium text-foreground">
                Changed with no diff available · {unavailablePaths.length}
              </span>
            </header>
            <div className="px-2 py-1.5">
              <ul className="space-y-px">
                {unavailablePaths.map((path) => (
                  <li key={path}>
                    <Mono className="block truncate text-foreground" title={path}>
                      {relativeTo(cwd, path)}
                    </Mono>
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 border-t border-border pt-1.5">
                <InertNote>
                  These paths came from a <Mono>files_changed</Mono> event, which carries paths only.
                  Shell-driven edits have no reviewable content until a diff channel exists.
                </InertNote>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
