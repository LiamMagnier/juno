/**
 * The small, shared pieces: spinner, keycap, status dot, section label, empty
 * state.
 *
 * They are collected in one file because each is a dozen lines and because
 * their consistency matters more than their independence — a product with two
 * spinners and three ways of writing a keyboard shortcut looks assembled rather
 * than designed.
 */

import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';
import { readReducedMotionFromDocument } from '../../lib/motion.js';

/**
 * Busy indicator.
 *
 * Under Reduce Motion a spinner does not stop — it stops *rotating*. Rotation
 * is the part that provokes symptoms; removing the indicator entirely would
 * leave a control that looks stuck, which is a worse outcome than the one the
 * preference is trying to avoid. The reduced form breathes on opacity instead.
 *
 * Always `aria-hidden`: the surrounding control carries `aria-busy`, and a
 * screen reader announcing "loading" twice is noise.
 */
export function Spinner({ className }: { className?: string | undefined }): ReactNode {
  const reduced = readReducedMotionFromDocument();
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('h-4 w-4', reduced ? 'animate-pulse' : 'animate-spin', className)}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.25" />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * A keyboard shortcut.
 *
 * Mono, because this is technical metadata and it is what the product's type
 * system reserves mono for. Wrapped in `<kbd>` so the semantics survive
 * copy-paste and screen readers announce it as a key rather than a word.
 */
export function Kbd({ keys, className }: { keys: readonly string[]; className?: string | undefined }): ReactNode {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.map((key) => (
        <kbd
          key={key}
          className="min-w-[1.25rem] rounded-xs border border-border bg-muted px-1 py-px text-center font-mono text-caption leading-4 text-muted-foreground"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

export type StatusTone = 'active' | 'idle' | 'pending' | 'critical';

const TONE_CLASS: Record<StatusTone, string> = {
  active: 'bg-primary',
  idle: 'bg-muted-foreground/60',
  pending: 'bg-muted-foreground',
  critical: 'bg-destructive',
};

/**
 * A state dot.
 *
 * `aria-hidden`, always, and never used alone: every call site pairs it with
 * the text it illustrates. Colour is not information here — it is a second
 * encoding of information the label already carries, which is the only way a
 * dot survives greyscale, low vision and the eight percent of users for whom
 * red and green are the same dot.
 */
export function StatusDot({ tone, className }: { tone: StatusTone; className?: string | undefined }): ReactNode {
  const reduced = readReducedMotionFromDocument();
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        TONE_CLASS[tone],
        tone === 'pending' && !reduced && 'animate-pulse',
        className,
      )}
    />
  );
}

/** Section eyebrow: mono, uppercase, tracked. Pair with a real heading level. */
export function SectionLabel({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string | undefined;
  id?: string | undefined;
}): ReactNode {
  return (
    <h2
      id={id}
      className={cn(
        'px-3 font-mono text-label uppercase text-muted-foreground',
        className,
      )}
    >
      {children}
    </h2>
  );
}

/**
 * An empty state.
 *
 * Quiet: no illustration, no card, no border. An empty list is a normal
 * condition, and dressing it up as an event is how a dense tool starts to feel
 * like a marketing page.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string | undefined;
  action?: ReactNode;
  className?: string | undefined;
}): ReactNode {
  return (
    <div className={cn('px-3 py-6 text-left', className)}>
      <p className="text-sm text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** Technical metadata: paths, ids, versions, counts. */
export function Meta({ children, className }: { children: ReactNode; className?: string | undefined }): ReactNode {
  return <span className={cn('font-mono text-caption text-muted-foreground', className)}>{children}</span>;
}
