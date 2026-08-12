/**
 * The Code surface's own primitives.
 *
 * `src/renderer/components` belongs to the app shell, so these live here. They
 * are deliberately narrow: a dense developer tool needs a small number of
 * controls that get every state right, not a component library.
 *
 * State coverage is the point. Each control below has explicit hover, active,
 * focus-visible, disabled and (where relevant) selected treatments, and every
 * disabled control takes a `disabledReason` that is surfaced to both sighted
 * users (title) and assistive tech (`aria-describedby` on a rendered note, or
 * the label itself). A control that is inert with no explanation is a bug.
 *
 * Elevation comes from lightness, not shadow: `bg-background` is the floor,
 * `bg-card` a step up, `bg-muted` the interactive step. No glass, no gradients.
 */

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn.js';

/** Focus ring shared by every interactive element on this surface. */
export const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/* -------------------------------------------------------------------------- */

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control must carry its own accessible name. */
  label: string;
  icon: ReactNode;
  tone?: 'default' | 'primary' | 'danger' | undefined;
  size?: 'sm' | 'md' | undefined;
  /** Shown as the title and announced when the control is disabled. */
  disabledReason?: string | undefined;
  selected?: boolean | undefined;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, tone = 'default', size = 'md', disabledReason, selected, className, ...props },
  ref,
) {
  const disabled = props.disabled === true;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={disabled && disabledReason ? `${label} — ${disabledReason}` : label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md border border-transparent',
        'text-muted-foreground transition-colors duration-100',
        size === 'sm' ? 'h-6 w-6' : 'h-7 w-7',
        !disabled && 'hover:bg-muted hover:text-foreground active:bg-accent',
        selected === true && 'border-border bg-muted text-foreground',
        tone === 'primary' && !disabled && 'text-primary hover:bg-primary/10',
        tone === 'danger' && !disabled && 'text-destructive hover:bg-destructive/10',
        disabled && 'cursor-not-allowed opacity-40',
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
});

/* -------------------------------------------------------------------------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | undefined;
  size?: 'sm' | 'md' | undefined;
  disabledReason?: string | undefined;
  icon?: ReactNode | undefined;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', disabledReason, icon, className, children, ...props },
  ref,
) {
  const disabled = props.disabled === true;
  return (
    <button
      ref={ref}
      type="button"
      title={disabled && disabledReason ? disabledReason : undefined}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md border text-[12px] font-medium',
        'transition-colors duration-100',
        size === 'sm' ? 'h-6 px-2' : 'h-7 px-2.5',
        variant === 'primary' &&
          'border-primary bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80',
        variant === 'secondary' &&
          'border-border bg-card text-foreground hover:bg-muted active:bg-accent',
        variant === 'ghost' &&
          'border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
        variant === 'danger' &&
          'border-destructive/50 bg-transparent text-destructive hover:bg-destructive/10 active:bg-destructive/20',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
});

/* -------------------------------------------------------------------------- */

export type BadgeTone = 'neutral' | 'primary' | 'danger' | 'notice' | 'positive';

export function Badge({
  tone = 'neutral',
  mono = true,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; mono?: boolean }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] uppercase tracking-wide',
        mono && 'font-mono',
        tone === 'neutral' && 'border-border bg-muted text-muted-foreground',
        tone === 'primary' && 'border-primary/40 bg-primary/10 text-primary',
        tone === 'danger' && 'border-destructive/50 bg-destructive/10 text-destructive',
        tone === 'notice' && 'border-border bg-accent text-accent-foreground',
        tone === 'positive' && 'border-border bg-muted text-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Rendered under the label in the popover/description, not in the control. */
  description?: string | undefined;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  size?: 'sm' | 'md' | undefined;
  className?: string | undefined;
}

/**
 * A radiogroup, not a row of buttons — arrow keys move the selection, which is
 * what a keyboard user expects from a mode switch.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: SegmentedProps<T>): JSX.Element {
  const move = (delta: number): void => {
    const enabled = options.filter((option) => option.disabled !== true);
    const current = enabled.findIndex((option) => option.value === value);
    if (current < 0 || enabled.length === 0) return;
    const next = enabled[(current + delta + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-px rounded-md border border-border bg-background p-px',
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const disabled = option.disabled === true;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            title={disabled ? option.disabledReason : option.description}
            onClick={() => !disabled && onChange(option.value)}
            className={cn(
              'rounded-[5px] font-medium transition-colors duration-100',
              size === 'sm' ? 'h-5 px-2 text-[11px]' : 'h-6 px-2.5 text-[12px]',
              selected
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
              FOCUS_RING,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */

export function EmptyState({
  title,
  detail,
  action,
  icon,
}: {
  title: string;
  detail: string;
  action?: ReactNode | undefined;
  icon?: ReactNode | undefined;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      {icon ? <div className="text-muted-foreground/60">{icon}</div> : null}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">{detail}</p>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export type StatusTone = 'idle' | 'active' | 'waiting' | 'error' | 'done';

/**
 * A 6px status dot. Pulses only while genuinely active, and the pulse is a
 * pure opacity animation so it never moves layout or delays a click.
 */
export function StatusDot({ tone, className }: { tone: StatusTone; className?: string | undefined }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        tone === 'idle' && 'bg-muted-foreground/40',
        tone === 'active' && 'animate-pulse bg-primary',
        tone === 'waiting' && 'animate-pulse bg-primary/70',
        tone === 'error' && 'bg-destructive',
        tone === 'done' && 'bg-muted-foreground',
        className,
      )}
    />
  );
}

/* -------------------------------------------------------------------------- */

/** Monospace metadata: paths, ids, commands, token counts. */
export function Mono({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span className={cn('font-mono text-[11px] tabular-nums', className)} {...props}>
      {children}
    </span>
  );
}

/** A one-line explanation attached to a disabled control. */
export function InertNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      <span className="mr-1 font-mono text-[10px] uppercase tracking-wide">unavailable</span>
      {children}
    </p>
  );
}
