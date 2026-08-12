/**
 * Buttons, and the rule that makes them honest.
 *
 * `disabledReason` — not `disabled` — is the primary way to switch a control
 * off. The two are not the same thing:
 *
 *   - `disabled` removes the element from the tab order entirely. A keyboard or
 *     screen-reader user cannot focus it, cannot read its tooltip, and
 *     therefore cannot find out *why* the thing they came to do is unavailable.
 *     They are left to guess, or to conclude the app is broken.
 *   - `aria-disabled` keeps the control focusable and announced as unavailable,
 *     which lets the reason travel with it.
 *
 * So a control with a reason renders as `aria-disabled`, keeps its tab stop,
 * refuses activation in both the pointer and the keyboard paths, and carries a
 * tooltip containing the reason. Native `disabled` is used only where there is
 * genuinely nothing to explain.
 *
 * `loading` is a third state, distinct from both: the control is temporarily
 * unavailable because of something the user just did. It gets `aria-busy`, a
 * spinner, and the same activation guard.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn.js';
import { Spinner } from './atoms.js';
import { Tooltip, type TooltipPlacement } from './Tooltip.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'relative inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control ' +
  'font-medium transition-colors duration-150 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-background';

const VARIANTS: Record<ButtonVariant, string> = {
  /* Coral. Emphasis, so exactly one of these should be visible in any view. */
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80',
  /* On dark, elevation is lightness: `bg-card` is already a step above the
     background, so this needs no shadow to read as raised. */
  secondary: 'border border-border bg-card text-foreground hover:bg-muted active:bg-muted/80',
  ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80',
  danger: 'border border-border bg-card text-destructive hover:bg-destructive/10 active:bg-destructive/15',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm',
};

interface CommonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Present ⇒ the control is unavailable, and this says why. */
  readonly disabledReason?: string | undefined;
  readonly loading?: boolean;
}

export interface ButtonProps extends CommonProps {
  readonly children: ReactNode;
  readonly icon?: ReactNode;
}

export function Button({
  children,
  icon,
  variant = 'secondary',
  size = 'md',
  disabledReason,
  loading = false,
  className,
  onClick,
  ...rest
}: ButtonProps): ReactNode {
  const inert = Boolean(disabledReason) || loading;

  const button = (
    <button
      type="button"
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      className={cn(
        BASE,
        VARIANTS[variant],
        SIZES[size],
        inert && 'cursor-default opacity-55 hover:bg-transparent',
        inert && variant === 'primary' && 'hover:bg-primary',
        inert && variant === 'secondary' && 'hover:bg-card',
        className,
      )}
      onClick={(event) => {
        if (inert) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {loading ? <Spinner className="h-3.5 w-3.5" /> : icon}
      <span className="truncate">{children}</span>
    </button>
  );

  return disabledReason ? (
    <Tooltip label="Unavailable" detail={disabledReason}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export interface IconButtonProps extends CommonProps {
  /**
   * The accessible name. Required — there is no path through this component
   * that produces an unlabelled icon button, which is the single most common
   * accessibility defect in applications shaped like this one.
   */
  readonly label: string;
  readonly icon: ReactNode;
  readonly tooltipPlacement?: TooltipPlacement;
  /** Toolbar-toggle semantics, announced as pressed/not pressed. */
  readonly pressed?: boolean | undefined;
}

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  disabledReason,
  loading = false,
  pressed,
  tooltipPlacement = 'bottom',
  className,
  onClick,
  ...rest
}: IconButtonProps): ReactNode {
  const inert = Boolean(disabledReason) || loading;

  return (
    <Tooltip label={label} detail={disabledReason} placement={tooltipPlacement}>
      <button
        type="button"
        aria-label={label}
        aria-disabled={inert || undefined}
        aria-busy={loading || undefined}
        aria-pressed={pressed}
        className={cn(
          BASE,
          VARIANTS[variant],
          size === 'sm' ? 'h-6 w-6' : 'h-7 w-7',
          'p-0',
          /* A toggle in the on state must not rely on colour alone: it also
             gains a filled surface, which survives greyscale and contrast
             modes. */
          pressed && 'bg-muted text-foreground',
          inert && 'cursor-default opacity-55',
          className,
        )}
        onClick={(event) => {
          if (inert) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
        {...rest}
      >
        {loading ? <Spinner className="h-3.5 w-3.5" /> : icon}
      </button>
    </Tooltip>
  );
}
