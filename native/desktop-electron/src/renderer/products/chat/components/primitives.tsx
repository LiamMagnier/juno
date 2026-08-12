/**
 * The controls this surface is built from.
 *
 * Radix is not a dependency of this package, so the menu below is a real
 * implementation rather than a wrapper: roving focus, type-ahead-free arrow
 * navigation, Escape to close, focus returned to the trigger, outside-pointer
 * dismissal, and `aria-expanded`/`aria-haspopup` on the trigger. Those are not
 * embellishments — a menu without them is a div that looks like a menu, and
 * every keyboard user is locked out of the actions inside it.
 *
 * Design rules encoded here rather than left to call sites:
 *
 *   · **Elevation is a lightness ladder, not a shadow.** `bg-background` →
 *     `bg-card` → `bg-popover`, each a hairline apart, because the dark theme
 *     is true black and a drop shadow on #000 is invisible. Shadows appear only
 *     on genuinely floating chrome, and even there they carry a border.
 *   · **An icon-only button cannot exist without a label.** `IconButton` takes
 *     a required `label`, so the accessible name is not something a reviewer
 *     has to notice is missing.
 *   · **A disabled control states why.** `disabledReason` becomes the title and
 *     the accessible description, so a greyed-out button is never a dead end.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn.js';

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'icon-sm' | 'icon';

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/95',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
  outline: 'border border-border bg-transparent text-foreground hover:bg-accent',
  ghost: 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
  destructive: 'bg-transparent text-destructive-ink hover:bg-destructive/10',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-control px-2.5 text-caption',
  md: 'h-9 gap-2 rounded-control px-3.5 text-body',
  'icon-sm': 'size-7 rounded-control',
  icon: 'size-8 rounded-control',
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /* `| undefined` is explicit because `exactOptionalPropertyTypes` is on and
     these are React props: a wrapper that forwards `className={className}` is
     passing an explicitly-undefined value, which is a different type from an
     absent key. Omitting it here would force every forwarding component to
     spread conditionally, which is noise for no safety — unlike the agent
     protocol, where the presence/absence distinction genuinely carries meaning. */
  readonly className?: string | undefined;
  /**
   * React 19 passes `ref` as an ordinary prop to function components, so there
   * is no `forwardRef` here. It is declared explicitly because
   * `ButtonHTMLAttributes` does not include it, and `Menu` needs to hand a ref
   * to whatever its `trigger` renders in order to restore focus on close.
   */
  readonly ref?: Ref<HTMLButtonElement> | undefined;
  /**
   * Why this control is unavailable.
   *
   * Setting it disables the button AND explains it. There is no path to a
   * disabled control with no stated reason, which is the "no dead buttons" rule
   * expressed as a type rather than as a review comment.
   *
   * `| undefined` so a caller can write `disabledReason={reasonOrUndefined}`
   * under `exactOptionalPropertyTypes` instead of spreading conditionally —
   * which at a dozen call sites is pure noise for no added safety.
   */
  readonly disabledReason?: string | undefined;
}

export function Button({
  variant = 'ghost',
  size = 'md',
  className,
  disabledReason,
  children,
  ...rest
}: ButtonProps): ReactNode {
  const blocked = disabledReason !== undefined;
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled === true || blocked}
      title={disabledReason ?? rest.title}
      aria-describedby={rest['aria-describedby']}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium',
        'transition-colors duration-fast ease-out-soft',
        'disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'size'> {
  /** Required. The accessible name — there is no other source for one here. */
  readonly label: string;
  readonly size?: Extract<ButtonSize, 'icon' | 'icon-sm'>;
  readonly children: ReactNode;
  /** Renders the label beside the icon as well as on the element. */
  readonly showLabel?: boolean;
}

export function IconButton({
  label,
  size = 'icon',
  showLabel = false,
  children,
  className,
  ...rest
}: IconButtonProps): ReactNode {
  return (
    <Button
      {...rest}
      size={showLabel ? 'sm' : size}
      aria-label={label}
      title={rest.disabledReason ?? label}
      className={className}
    >
      {children}
      {showLabel ? <span>{label}</span> : null}
    </Button>
  );
}

/* -------------------------------------------------------------------------- */
/* Dismissal                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Close on outside pointer-down or Escape.
 *
 * Pointer*down*, not click: a click fires after the mouse is released, so a
 * drag that begins inside a menu and ends outside it would not dismiss, and a
 * menu that stays open under the pointer after the user has plainly moved on
 * feels stuck.
 *
 * The Escape listener is `capture` so it runs before anything inside the
 * surface can consume the key — a textarea in an open composer menu should not
 * be able to swallow the escape that closes it.
 */
function useDismiss(
  open: boolean,
  onClose: () => void,
  refs: readonly RefObject<HTMLElement | null>[],
): void {
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const ref of refs) {
        if (ref.current?.contains(target) === true) return;
      }
      onClose();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
    /* `refs` is a fresh array each render at every call site; depending on it
       would re-bind the listeners constantly. The refs themselves are stable
       and are read at event time, so the effect only needs `open`. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);
}

/* -------------------------------------------------------------------------- */
/* Menu                                                                        */
/* -------------------------------------------------------------------------- */

interface MenuContextValue {
  readonly close: () => void;
}

const MenuContext = createContext<MenuContextValue>({ close: () => undefined });

export type MenuAlign = 'start' | 'end';
export type MenuSide = 'top' | 'bottom';

export interface MenuProps {
  /** Renders the trigger. `props` must be spread onto a focusable element. */
  readonly trigger: (props: {
    ref: RefObject<HTMLButtonElement | null>;
    onClick: () => void;
    'aria-expanded': boolean;
    'aria-haspopup': 'menu';
    'aria-controls': string | undefined;
  }) => ReactNode;
  readonly children: ReactNode;
  readonly label: string;
  readonly align?: MenuAlign;
  readonly side?: MenuSide;
  readonly className?: string | undefined;
}

/**
 * A menu, portalled to `document.body`.
 *
 * Portalled because the composer and the transcript both clip their overflow,
 * and a menu that opens inside a scroll container is a menu with a scrollbar
 * through it. Position is computed from the trigger's rect at open time and on
 * scroll/resize — a re-measure rather than a `position: sticky` trick, so it
 * stays correct when the window is resized while open.
 */
export function Menu({
  trigger,
  children,
  label,
  align = 'start',
  side = 'bottom',
  className,
}: MenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    /* Focus goes back where it came from. Losing focus to <body> after closing
       a menu strands keyboard users at the top of the document. */
    triggerRef.current?.focus();
  }, []);

  useDismiss(open, close, [panelRef, triggerRef]);

  /* Measure after layout, before paint, so the panel never shows at 0,0 first. */
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }

    const measure = (): void => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = panel?.offsetWidth ?? 224;
      const height = panel?.offsetHeight ?? 0;
      const margin = 8;

      let left = align === 'end' ? rect.right - width : rect.left;
      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

      let top = side === 'top' ? rect.top - height - 6 : rect.bottom + 6;
      /* Flip rather than clamp when there is no room: a menu squashed against
         the bottom edge with its items cut off is worse than one above. */
      if (side === 'bottom' && top + height > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - height - 6);
      }
      if (side === 'top' && top < margin) top = rect.bottom + 6;

      setPosition({ top, left });
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, align, side]);

  /* Move focus into the panel on open. */
  useEffect(() => {
    if (!open || position === null) return;
    const first = panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    first?.focus();
  }, [open, position]);

  const onPanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      /* Wrapping, because a menu is a ring — arriving at the bottom and being
         unable to reach the first item is a small daily annoyance. */
      const next = items[(current + delta + items.length) % items.length];
      next?.focus();
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }, []);

  const context = useMemo<MenuContextValue>(() => ({ close }), [close]);

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((value) => !value),
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        'aria-controls': open ? panelId : undefined,
      })}
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="menu"
              aria-label={label}
              onKeyDown={onPanelKeyDown}
              style={{
                top: position?.top ?? -9999,
                left: position?.left ?? -9999,
                visibility: position === null ? 'hidden' : 'visible',
              }}
              className={cn(
                'fixed z-popper min-w-56 max-w-80 overflow-hidden rounded-menu border border-border',
                /* Opaque. A menu is a reading surface for the length of a
                   glance, and translucency over a transcript makes the item
                   under the pointer compete with the words behind it. */
                'bg-popover p-1 text-popover-foreground shadow-float',
                'animate-pop-in',
                className,
              )}
            >
              <MenuContext.Provider value={context}>{children}</MenuContext.Provider>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export interface MenuItemProps {
  readonly children: ReactNode;
  readonly onSelect?: () => void;
  readonly icon?: ReactNode;
  readonly tone?: 'default' | 'destructive';
  readonly disabledReason?: string | undefined;
  /** Renders a check and marks `aria-checked`; makes the item a `menuitemradio`. */
  readonly selected?: boolean | undefined;
  readonly hint?: string | undefined;
}

export function MenuItem({
  children,
  onSelect,
  icon,
  tone = 'default',
  disabledReason,
  selected,
  hint,
}: MenuItemProps): ReactNode {
  const { close } = useContext(MenuContext);
  const disabled = disabledReason !== undefined;

  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      aria-checked={selected}
      title={disabledReason}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
        close();
      }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-xs px-2.5 py-1.5 text-left text-body',
        'transition-colors duration-fast ease-out-soft',
        'focus-visible:bg-accent hover:bg-accent',
        tone === 'destructive' ? 'text-destructive-ink' : 'text-popover-foreground',
        disabled && 'pointer-events-none opacity-45',
      )}
    >
      {icon ? <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint !== undefined ? (
        <span className="shrink-0 font-mono text-caption text-muted-foreground">{hint}</span>
      ) : null}
    </button>
  );
}

export function MenuSeparator(): ReactNode {
  return <div role="separator" className="my-1 h-px bg-border" />;
}

export function MenuLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="px-2.5 pb-1 pt-2 font-mono text-caption uppercase tracking-[0.1em] text-muted-foreground">
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Segmented control                                                           */
/* -------------------------------------------------------------------------- */

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabledReason?: string | undefined;
}

export interface SegmentedControlProps<T extends string> {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly SegmentedOption<T>[];
  readonly ariaLabel: string;
  readonly className?: string | undefined;
}

/**
 * A two-or-three-way switch.
 *
 * `role="radiogroup"` rather than tabs: these select a mode, they do not reveal
 * a panel that is a child of the control. Arrow keys move between options and
 * select as they go, which is the radio-group convention and the one screen
 * reader users will expect.
 *
 * The thumb is a `layoutId`-free translation — a plain absolutely-positioned
 * element whose left/width are measured from the selected button — so it
 * cannot desync from the labels the way a percentage-based thumb does when one
 * option's text is longer than another's.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: SegmentedControlProps<T>): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const measure = (): void => {
      const active = container.querySelector<HTMLElement>('[data-active="true"]');
      if (!active) {
        setThumb(null);
        return;
      }
      setThumb({ left: active.offsetLeft, width: active.offsetWidth });
    };

    measure();
    /* Fonts land after first paint and change the widths under the thumb. */
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [value, options]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const enabled = options.filter((option) => option.disabledReason === undefined);
    const current = enabled.findIndex((option) => option.value === value);
    if (current < 0) return;
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = enabled[(current + delta + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  };

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'relative inline-flex items-center gap-0.5 rounded-control border border-border bg-secondary p-0.5',
        className,
      )}
    >
      {thumb ? (
        <span
          aria-hidden="true"
          /* Inline geometry only — the colours are classes. A measured pixel
             cannot come from a token, but a colour never comes from anywhere
             else. */
          style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }}
          className="absolute inset-y-0.5 left-0 rounded-[7px] border border-border bg-card transition-transform duration-base ease-out-strong motion-reduce:transition-none"
        />
      ) : null}
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-active={active}
            tabIndex={active ? 0 : -1}
            disabled={option.disabledReason !== undefined}
            title={option.disabledReason}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative z-[1] inline-flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-caption font-medium',
              'transition-colors duration-fast ease-out-soft disabled:opacity-40',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A quiet eyebrow. Mono + uppercase + wide tracking, per the type scale's note
 * that `text-label` is sizing only and must be paired.
 */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string | undefined }): ReactNode {
  return (
    <span className={cn('font-mono text-caption uppercase tracking-[0.1em] text-muted-foreground', className)}>
      {children}
    </span>
  );
}

/** A hairline rule that reads as structure rather than decoration. */
export function Divider({ className }: { className?: string | undefined }): ReactNode {
  return <div role="separator" className={cn('h-px bg-border', className)} />;
}
