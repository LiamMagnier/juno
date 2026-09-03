"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { composerIconButtonClass } from "@/components/ui/composer-shell";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The composer's `+` menu (docs/design/SOFT_UI.md §3).
 *
 * One `.surface-float` popover at `rounded-popover` with p-1.5, so its 36px
 * rows sit concentric at `rounded-control`. Sections are separated by a
 * hairline and nothing else — no eyebrows naming them, because "Attach files"
 * and a row with a switch on it already say what kind of row they are. Tool
 * toggles are rows with a trailing Switch; Project and Connectors open as
 * sub-panels drawn IN the same box (a back row at the top, the same rows
 * below) rather than as a second float beside it.
 *
 * The bar shows nothing about tool state: what is on is visible only in here
 * (and in the trigger's accessible name, for a screen reader).
 *
 * Keyboard: ↑/↓ move between rows, Enter/Space activate or toggle, → opens a
 * sub-panel, ← or Backspace goes back, Esc closes.
 */

export type PlusMenuItem =
  | {
      kind: "action";
      id: string;
      label: string;
      icon: LucideIcon;
      onSelect: () => void;
      disabled?: boolean;
      /** Trailing note in the muted mono, e.g. why a row can't be used. */
      note?: string;
    }
  | {
      kind: "toggle";
      id: string;
      label: string;
      icon: LucideIcon;
      checked: boolean;
      onToggle: () => void;
      disabled?: boolean;
      note?: string;
    }
  | {
      kind: "sub";
      id: string;
      label: string;
      icon: LucideIcon;
      /** What is currently chosen inside, shown before the chevron. */
      detail?: string;
      /** The sub-panel's body; `back` returns to the root. */
      render: (api: { back: () => void; close: () => void }) => React.ReactNode;
    };

export type PlusMenuSection = PlusMenuItem[];

/** Shared row recipe: 36px, `rounded-control`, accent fill on hover/focus. */
export const plusMenuRowClass =
  "group/row flex h-9 w-full shrink-0 cursor-pointer select-none items-center gap-2.5 rounded-control px-2.5 text-left text-ui font-medium text-foreground outline-none transition-[background-color] duration-fast ease-out-soft hover:bg-accent focus-visible:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 motion-reduce:transition-none coarse:h-11";

/** The 16px glyph slot at the head of a row. */
export function PlusMenuGlyph({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** One hairline between sections. */
export function PlusMenuSeparator() {
  return <div role="separator" aria-hidden="true" className="my-1 h-px shrink-0 bg-border/70" />;
}

/**
 * A row. A `div` with a menu role rather than a `<button>`: toggle rows hold
 * a Switch, which is itself a button, and a button may not contain one.
 * Enter and Space activate it by hand; `data-menu-row` is what the arrow
 * keys walk. Toggle rows are `menuitemcheckbox` and carry their state on
 * `aria-checked` — the Switch that draws it is decorative.
 */
export const PlusMenuRow = React.forwardRef<
  HTMLDivElement,
  Omit<React.HTMLAttributes<HTMLDivElement>, "onClick"> & {
    icon?: LucideIcon;
    checked?: boolean;
    disabled?: boolean;
    note?: string;
    detail?: string;
    chevron?: boolean;
    /** A brand mark or any element in place of the Lucide glyph. */
    leading?: React.ReactNode;
    onClick?: () => void;
  }
>(function PlusMenuRow(
  { icon, checked, disabled, note, detail, chevron, leading, className, children, role, onClick, onKeyDown, ...props },
  ref,
) {
  const toggle = checked !== undefined;
  const activate = () => {
    if (disabled) return;
    onClick?.();
  };
  return (
    <div
      ref={ref}
      role={role ?? (toggle ? "menuitemcheckbox" : "menuitem")}
      aria-checked={toggle ? checked : undefined}
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? "" : undefined}
      data-menu-row=""
      tabIndex={-1}
      onClick={activate}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
      className={cn(plusMenuRowClass, className)}
      {...props}
    >
      {leading ?? (icon ? <PlusMenuGlyph icon={icon} /> : null)}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {detail && (
        <span className="max-w-[7rem] shrink-0 truncate font-mono text-caption text-muted-foreground">
          {detail}
        </span>
      )}
      {note ? (
        <span className="shrink-0 font-mono text-caption text-muted-foreground">{note}</span>
      ) : toggle ? (
        <Switch checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none shrink-0" />
      ) : null}
      {chevron && (
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/60" />
      )}
    </div>
  );
});

function rowsIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-menu-row]")).filter(
    (el) => el.getAttribute("aria-disabled") !== "true",
  );
}

export function PlusMenu({
  open,
  onOpenChange,
  disabled,
  label,
  tooltip,
  sections,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  /** The trigger's accessible name — names what is on, for a screen reader. */
  label: string;
  tooltip: string;
  sections: PlusMenuSection[];
  className?: string;
}) {
  const [subId, setSubId] = React.useState<string | null>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);

  // Always open on the root panel: a sub-panel left open would greet the next
  // press with a list the reader did not ask for.
  React.useEffect(() => {
    if (!open) setSubId(null);
  }, [open]);

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  const back = React.useCallback(() => setSubId(null), []);

  const sub = React.useMemo(() => {
    for (const section of sections)
      for (const item of section) if (item.kind === "sub" && item.id === subId) return item;
    return null;
  }, [sections, subId]);

  /** Focus the first row of whatever panel is showing — after it has painted. */
  const focusFirstRow = React.useCallback(() => {
    requestAnimationFrame(() => {
      const root = contentRef.current;
      if (!root) return;
      // A sub-panel with a search field lands the caret there instead.
      const field = root.querySelector<HTMLElement>("[data-menu-autofocus]");
      if (field) {
        field.focus();
        return;
      }
      rowsIn(root)[0]?.focus();
    });
  }, []);

  React.useEffect(() => {
    if (open) focusFirstRow();
  }, [open, subId, focusFirstRow]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const root = contentRef.current;
    const target = e.target as HTMLElement;
    const typing = target instanceof HTMLInputElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = rowsIn(root);
      if (rows.length === 0) return;
      e.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown"
          ? rows[at < 0 ? 0 : (at + 1) % rows.length]
          : rows[at < 0 ? rows.length - 1 : (at - 1 + rows.length) % rows.length];
      next.focus();
      next.scrollIntoView({ block: "nearest" });
      return;
    }
    if (typing) return;
    if (e.key === "ArrowRight" && target.dataset.menuSub !== undefined) {
      e.preventDefault();
      setSubId(target.dataset.menuSub || null);
      return;
    }
    if ((e.key === "ArrowLeft" || e.key === "Backspace") && sub) {
      e.preventDefault();
      back();
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      const rows = rowsIn(root);
      if (rows.length === 0) return;
      e.preventDefault();
      rows[e.key === "Home" ? 0 : rows.length - 1]?.focus();
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              aria-haspopup="menu"
              disabled={disabled}
              className={cn(composerIconButtonClass, "group", className)}
            >
              <Plus
                aria-hidden="true"
                className="size-4 transition-transform duration-base ease-out-strong group-data-[state=open]:rotate-45 motion-reduce:transition-none"
              />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>

      <PopoverContent
        ref={contentRef}
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        avoidCollisions
        role="menu"
        aria-label={sub ? sub.label : "Add"}
        onKeyDown={onKeyDown}
        // Radix would focus the content box itself; the first row is the thing
        // to be on, and `focusFirstRow` gets there once the rows exist.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          focusFirstRow();
        }}
        className="flex w-64 flex-col p-1.5"
        style={{ maxHeight: "min(28rem, var(--radix-popover-content-available-height))" }}
      >
        {sub ? (
          <div key={sub.id} className="flex min-h-0 flex-col motion-safe:animate-fade-in">
            <PlusMenuRow
              onClick={back}
              aria-label={`Back from ${sub.label}`}
              leading={<ChevronLeft aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
            >
              {sub.label}
            </PlusMenuRow>
            <PlusMenuSeparator />
            {sub.render({ back, close })}
          </div>
        ) : (
          <div key="root" className="flex min-h-0 flex-col overflow-y-auto overscroll-contain">
            {sections
              .filter((section) => section.length > 0)
              .map((section, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <PlusMenuSeparator />}
                  {section.map((item) =>
                    item.kind === "action" ? (
                      <PlusMenuRow
                        key={item.id}
                        icon={item.icon}
                        disabled={item.disabled}
                        note={item.note}
                        onClick={() => {
                          close();
                          item.onSelect();
                        }}
                      >
                        {item.label}
                      </PlusMenuRow>
                    ) : item.kind === "toggle" ? (
                      <PlusMenuRow
                        key={item.id}
                        icon={item.icon}
                        checked={item.checked}
                        disabled={item.disabled}
                        note={item.note}
                        onClick={item.onToggle}
                      >
                        {item.label}
                      </PlusMenuRow>
                    ) : (
                      <PlusMenuRow
                        key={item.id}
                        icon={item.icon}
                        detail={item.detail}
                        chevron
                        aria-haspopup="menu"
                        data-menu-sub={item.id}
                        onClick={() => setSubId(item.id)}
                      >
                        {item.label}
                      </PlusMenuRow>
                    ),
                  )}
                </React.Fragment>
              ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
