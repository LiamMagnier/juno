/**
 * The small parts, in one place so the surface stays one surface.
 *
 * Three rules are enforced here rather than remembered at each call site:
 *
 * **A disabled control states why.** `Action` will not accept `disabled`
 * without a `disabledReason`, and it renders that reason — as the accessible
 * name suffix and, where the caller asks, as visible text. A greyed button with
 * no explanation is a feature the user can see and cannot reach.
 *
 * **An icon-only control states what it is.** `IconAction` requires `label`.
 *
 * **Elevation is lightness, not shadow.** `Panel` moves up the ladder
 * (background → card → muted/popover) rather than casting anything. In the dark
 * theme the background is true black, and a shadow on true black is invisible;
 * a surface that reads as raised there has to actually be lighter.
 */

import {
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn.js';
import { TONE_FILL, TONE_RULE, TONE_TEXT, type Tone } from '../lib/vocabulary.js';
import { IconChevron } from './icons.js';

/* -------------------------------------------------------------------------- */
/* Type                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The metadata voice: mono, uppercase, tracked. Used for eyebrows and column
 * headings, never for anything a user has to read as a sentence.
 */
export function Eyebrow({
  children,
  tone = 'quiet',
  className,
}: {
  readonly children: ReactNode;
  readonly tone?: Tone;
  readonly className?: string;
}): ReactNode {
  return (
    <span className={cn('font-mono text-label uppercase', TONE_TEXT[tone], className)}>
      {children}
    </span>
  );
}

/** A section heading with an optional right-hand slot. */
export function SectionHeader({
  title,
  count,
  trailing,
  description,
}: {
  readonly title: string;
  readonly count?: number;
  readonly trailing?: ReactNode;
  readonly description?: string;
}): ReactNode {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-heading text-foreground">
          {title}
          {count === undefined ? null : (
            <span className="ml-2 font-mono text-label text-muted-foreground">{count}</span>
          )}
        </h2>
        {description === undefined ? null : (
          <p className="mt-0.5 text-caption text-muted-foreground">{description}</p>
        )}
      </div>
      {trailing === undefined ? null : <div className="shrink-0">{trailing}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A panel.
 *
 * `level` is a position on the lightness ladder, not a shadow depth: `flat`
 * stays on the page, `raised` is `bg-card`, `inset` is `bg-muted` — recessed in
 * the paper theme and raised in the black one, which is what "muted" means in
 * each. Nothing here casts a shadow.
 */
export function Panel({
  children,
  level = 'raised',
  tone,
  className,
  as: Element = 'section',
  ...rest
}: {
  readonly children: ReactNode;
  readonly level?: 'flat' | 'raised' | 'inset';
  /** Adds a left rule in the tone's colour. Used for state, never decoration. */
  readonly tone?: Tone;
  readonly className?: string;
  readonly as?: 'section' | 'div' | 'article' | 'aside';
  readonly 'aria-labelledby'?: string;
  readonly 'aria-label'?: string;
  readonly role?: string;
}): ReactNode {
  const surface =
    level === 'raised' ? 'bg-card' : level === 'inset' ? 'bg-muted/60' : 'bg-transparent';
  return (
    <Element
      className={cn(
        'rounded-card border border-border',
        surface,
        tone === undefined ? null : cn('border-l-2', TONE_RULE[tone]),
        className,
      )}
      {...rest}
    >
      {children}
    </Element>
  );
}

/** A hairline between rows in a list. */
export function Divider({ className }: { readonly className?: string }): ReactNode {
  return <hr className={cn('border-0 border-t border-border', className)} />;
}

/* -------------------------------------------------------------------------- */
/* Status marks                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A small filled mark.
 *
 * `pulse` is offered and used in exactly one place: a step an executor is
 * actually moving right now. It is a claim, and this component will not make it
 * unless the caller passes the flag, so there is no path by which a settled row
 * quietly keeps breathing.
 */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  readonly tone: Tone;
  readonly pulse?: boolean;
  readonly className?: string;
}): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-1.5 rounded-full',
        TONE_FILL[tone],
        pulse ? 'animate-status-glow' : null,
        className,
      )}
    />
  );
}

/**
 * A status label with its mark. Never a pill — a bordered capsule for every
 * state turns a dense list into a bag of sweets.
 */
export function StatusLabel({
  tone,
  label,
  pulse = false,
  className,
}: {
  readonly tone: Tone;
  readonly label: string;
  readonly pulse?: boolean;
  readonly className?: string;
}): ReactNode {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <StatusDot tone={tone} pulse={pulse} />
      <span className={cn('font-mono text-label uppercase', TONE_TEXT[tone])}>{label}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

type ActionVariant = 'primary' | 'default' | 'quiet' | 'danger-outline';

const VARIANT_CLASS: Record<ActionVariant, string> = {
  /* Coral, and only here: the affirmative on a decision the user must make. */
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90 border-transparent',
  default: 'bg-card text-foreground hover:bg-accent border-border',
  quiet: 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-accent border-transparent',
  'danger-outline': 'bg-transparent text-destructive hover:bg-destructive/10 border-destructive/50',
};

type ActionOwnProps = {
  readonly children: ReactNode;
  readonly variant?: ActionVariant;
  readonly size?: 'sm' | 'md';
  /** Present and non-null exactly when the control is unavailable. */
  readonly disabledReason?: string | null;
  /** Renders the reason under the control, not only to assistive tech. */
  readonly showReason?: boolean;
  readonly busy?: boolean;
  readonly icon?: ReactNode;
};

type ActionProps = ActionOwnProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ActionOwnProps | 'disabled'>;

/**
 * A button that cannot be dead.
 *
 * Availability is expressed as `disabledReason`, not as `disabled`: there is no
 * way to switch this control off without saying why, and the reason reaches
 * assistive technology through `aria-describedby` whether or not it is drawn.
 */
export function Action({
  children,
  variant = 'default',
  size = 'md',
  disabledReason = null,
  showReason = false,
  busy = false,
  icon,
  className,
  type = 'button',
  ...rest
}: ActionProps): ReactNode {
  const reasonId = useId();
  const unavailable = disabledReason !== null;

  return (
    <span className={cn('inline-flex flex-col gap-1', showReason ? 'w-full' : null)}>
      <button
        type={type}
        disabled={unavailable || busy}
        aria-describedby={unavailable ? reasonId : undefined}
        aria-busy={busy || undefined}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-control border font-sans transition-colors duration-fast',
          size === 'sm' ? 'h-7 px-2.5 text-caption' : 'h-9 px-3.5 text-body',
          VARIANT_CLASS[variant],
          'disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
          unavailable && variant === 'primary' ? 'disabled:hover:bg-primary' : null,
          className,
        )}
        {...rest}
      >
        {icon}
        {children}
      </button>
      {unavailable ? (
        <span
          id={reasonId}
          className={cn('text-caption text-muted-foreground', showReason ? null : 'sr-only')}
        >
          {disabledReason}
        </span>
      ) : null}
    </span>
  );
}

type IconActionOwnProps = {
  readonly label: string;
  readonly children: ReactNode;
  readonly variant?: ActionVariant;
  readonly disabledReason?: string | null;
  readonly busy?: boolean;
};

type IconActionProps = IconActionOwnProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof IconActionOwnProps | 'disabled'>;

/** An icon-only control. `label` is required and becomes the accessible name. */
export function IconAction({
  label,
  children,
  variant = 'quiet',
  disabledReason = null,
  busy = false,
  className,
  type = 'button',
  ...rest
}: IconActionProps): ReactNode {
  const reasonId = useId();
  const unavailable = disabledReason !== null;
  return (
    <>
      <button
        type={type}
        aria-label={label}
        title={unavailable ? `${label} — ${disabledReason}` : label}
        disabled={unavailable || busy}
        aria-describedby={unavailable ? reasonId : undefined}
        aria-busy={busy || undefined}
        className={cn(
          'inline-flex size-7 items-center justify-center rounded-control border transition-colors duration-fast',
          VARIANT_CLASS[variant],
          'disabled:cursor-not-allowed disabled:opacity-45',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
      {unavailable ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Disclosure                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A native disclosure, styled.
 *
 * Deliberately `<details>` rather than a hand-rolled toggle: it is focusable,
 * announces its state, responds to Enter and Space, and survives find-in-page —
 * four behaviours that a `useState` and a `div` would each have to reimplement
 * and would each get slightly wrong.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  onOpen,
  className,
}: {
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  /** Fired the first time it opens — for panels that fetch on demand. */
  readonly onOpen?: () => void;
  readonly className?: string;
}): ReactNode {
  const [opened, setOpened] = useState(defaultOpen);
  return (
    <details
      open={defaultOpen}
      className={cn('group', className)}
      onToggle={(event) => {
        if (event.currentTarget.open && !opened) {
          setOpened(true);
          onOpen?.();
        }
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-control py-1 text-caption text-muted-foreground outline-none transition-colors duration-fast hover:text-foreground focus-visible:outline-2">
        <IconChevron className="size-3.5 transition-transform duration-fast group-open:rotate-90" />
        {summary}
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/* Data display                                                                */
/* -------------------------------------------------------------------------- */

/** A key/value row. Used for approval detail, run settings and audit rows. */
export function Fact({
  label,
  children,
  mono = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
}): ReactNode {
  return (
    <div className="grid grid-cols-[minmax(6rem,9rem)_1fr] gap-x-3 gap-y-0.5 py-1">
      <dt className="font-mono text-label uppercase text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words text-caption text-foreground', mono ? 'font-mono' : null)}>
        {children}
      </dd>
    </div>
  );
}

/**
 * A determinate bar.
 *
 * There is no indeterminate variant, and that is the point. A complex task gets
 * a real fraction — steps concluded, budget consumed — or it gets a sentence.
 * It never gets a bar that sweeps forever while saying nothing.
 */
export function Meter({
  label,
  valueLabel,
  fraction,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly valueLabel: string;
  /** 0–1. Values above 0.8 take the warning tone automatically. */
  readonly fraction: number;
  readonly tone?: Tone;
}): ReactNode {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const effective: Tone = clamped >= 0.8 && tone === 'neutral' ? 'notice' : tone;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        <span className={cn('font-mono text-label', TONE_TEXT[effective])}>{valueLabel}</span>
      </div>
      <div
        className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueLabel}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-base ease-out-soft', TONE_FILL[effective])}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A note the surface makes about itself: a degradation, a caveat, a refusal.
 * Bordered on the left in its tone, never a filled block — a page of tinted
 * boxes reads as decoration and stops being read at all.
 */
export function Note({
  tone,
  children,
  icon,
  className,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly icon?: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <p
      className={cn(
        'flex gap-2 border-l-2 py-1 pl-2.5 text-caption',
        TONE_RULE[tone],
        tone === 'danger' ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
    >
      {icon === undefined ? null : <span className="mt-0.5 shrink-0">{icon}</span>}
      <span className="min-w-0">{children}</span>
    </p>
  );
}
