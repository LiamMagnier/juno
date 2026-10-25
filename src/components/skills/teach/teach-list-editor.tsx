"use client";

import * as React from "react";
import { AnimatePresence, Reorder, motion, useDragControls } from "framer-motion";
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useReducedMotion } from "@/lib/motion-preference";
import { spring, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { applyListAction, type TeachItem, type TeachListAction } from "@/components/skills/teach/teach-model";

/*
 * An ordered list the person writes like an outline: the steps of a taught
 * skill (numbered), and its rules and notes (bulleted).
 *
 *   ⋮⋮  1  Open the Invoices label in Gmail.                 ↑ ↓ ×
 *   ⋮⋮  2  Download each PDF attached to an unread email.     ↑ ↓ ×
 *       +  Add a step
 *
 * The keyboard is the fast path, the way a walkthrough is typed: Enter starts
 * the next row, Backspace in an empty row removes it and returns to the one
 * above, Alt+↑/↓ moves a row. The grip drags (pointer), the arrows move
 * (everyone, including a screen reader and a phone), and every move animates
 * on the layout spring — or not at all under reduced motion.
 */

/** Grows a textarea with its text where `field-sizing: content` is unavailable. */
function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

interface RowProps {
  row: TeachItem;
  index: number;
  count: number;
  numbered: boolean;
  placeholder: string;
  label: string;
  disabled: boolean;
  invalid: boolean;
  reduce: boolean;
  registerField: (id: string, el: HTMLTextAreaElement | null) => void;
  onAction: (action: TeachListAction, focus?: { id: string; caret?: "end" }) => void;
  onNewRow: (after: number) => void;
}

function ListRow({ row, index, count, numbered, placeholder, label, disabled, invalid, reduce, registerField, onAction, onNewRow }: RowProps) {
  const controls = useDragControls();
  const fieldRef = React.useRef<HTMLTextAreaElement | null>(null);
  useAutoGrow(fieldRef, row.text);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      onNewRow(index);
      return;
    }
    if (event.key === "Backspace" && row.text === "" && count > 1) {
      event.preventDefault();
      onAction({ type: "remove", id: row.id }, { id: "__previous__" + index, caret: "end" });
      return;
    }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      onAction({ type: "move", id: row.id, by: event.key === "ArrowUp" ? -1 : 1 }, { id: row.id });
    }
  };

  return (
    <Reorder.Item
      value={row}
      dragListener={false}
      dragControls={controls}
      layout="position"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, transition: transition.exit }}
      // Reduced motion: rows still reorder, instantly; only the fade remains.
      transition={reduce ? { duration: 0 } : spring.layout}
      whileDrag={reduce ? undefined : { scale: 1.01, boxShadow: "0 8px 24px -12px hsl(var(--foreground) / 0.25)" }}
      className="group/row relative flex items-start gap-1.5 rounded-field bg-background py-1 pl-1 pr-1.5 focus-within:bg-muted/60 hover:bg-muted/40"
      data-teach-row={row.id}
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onPointerDown={(event) => {
          if (!disabled) controls.start(event);
        }}
        className="mt-1.5 flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-control text-ink-tertiary opacity-0 transition-opacity duration-fast ease-out-soft group-hover/row:opacity-100 group-focus-within/row:opacity-100 active:cursor-grabbing coarse:hidden motion-reduce:transition-none"
      >
        <GripVertical className="size-3.5" />
      </button>
      <span
        aria-hidden="true"
        className={cn(
          "mt-1.5 flex size-6 shrink-0 items-center justify-center text-caption tabular-nums",
          numbered ? "rounded-full bg-muted font-medium text-muted-on-fill" : "text-muted-foreground"
        )}
      >
        {numbered ? index + 1 : "•"}
      </span>
      <textarea
        ref={(el) => {
          fieldRef.current = el;
          registerField(row.id, el);
        }}
        rows={1}
        value={row.text}
        onChange={(event) => onAction({ type: "update", id: row.id, text: event.target.value.replace(/\n+/g, " ") })}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={`${label} ${index + 1}`}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className="min-h-9 flex-1 resize-none overflow-hidden rounded-control border border-transparent bg-transparent px-2 py-1.5 text-body leading-relaxed text-foreground [field-sizing:content] placeholder:text-muted-foreground focus-visible:outline-none disabled:opacity-60 aria-[invalid=true]:text-destructive"
      />
      <div className="mt-1 flex shrink-0 items-center opacity-0 transition-opacity duration-fast ease-out-soft group-hover/row:opacity-100 group-focus-within/row:opacity-100 coarse:opacity-100 motion-reduce:transition-none">
        <IconButton
          variant="ghost"
          size="sm"
          label={`Move ${label.toLowerCase()} ${index + 1} up`}
          disabled={disabled || index === 0}
          onClick={() => onAction({ type: "move", id: row.id, by: -1 }, { id: row.id })}
        >
          <ArrowUp className="size-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          variant="ghost"
          size="sm"
          label={`Move ${label.toLowerCase()} ${index + 1} down`}
          disabled={disabled || index === count - 1}
          onClick={() => onAction({ type: "move", id: row.id, by: 1 }, { id: row.id })}
        >
          <ArrowDown className="size-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          variant="ghost"
          size="sm"
          label={`Remove ${label.toLowerCase()} ${index + 1}`}
          disabled={disabled}
          onClick={() => onAction({ type: "remove", id: row.id })}
        >
          <X className="size-3.5" aria-hidden="true" />
        </IconButton>
      </div>
    </Reorder.Item>
  );
}

export function TeachListEditor({
  items,
  onChange,
  numbered = false,
  label,
  addLabel,
  placeholderFor,
  max,
  disabled = false,
  invalidIds,
  autoFocusFirst = false,
  emptyHint,
}: {
  items: readonly TeachItem[];
  onChange: (items: TeachItem[]) => void;
  numbered?: boolean;
  /** The row noun, for accessible names: "Step", "Rule". */
  label: string;
  addLabel: string;
  placeholderFor: (index: number) => string;
  max: number;
  disabled?: boolean;
  invalidIds?: ReadonlySet<string>;
  autoFocusFirst?: boolean;
  /** Shown instead of the list when it has no rows. */
  emptyHint?: React.ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  const fields = React.useRef(new Map<string, HTMLTextAreaElement>());
  const [focusNext, setFocusNext] = React.useState<{ id: string; caret?: "end" } | null>(null);
  const latest = React.useRef(items);
  latest.current = items;

  React.useEffect(() => {
    if (autoFocusFirst && items[0]) setFocusNext({ id: items[0].id, caret: "end" });
    // Once, on mount: a walkthrough starts with the caret in the first step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (!focusNext) return;
    const el = fields.current.get(focusNext.id);
    if (el) {
      el.focus({ preventScroll: false });
      if (focusNext.caret === "end") el.setSelectionRange(el.value.length, el.value.length);
    }
    setFocusNext(null);
  }, [focusNext, items]);

  const registerField = React.useCallback((id: string, el: HTMLTextAreaElement | null) => {
    if (el) fields.current.set(id, el);
    else fields.current.delete(id);
  }, []);

  const onAction = (action: TeachListAction, focus?: { id: string; caret?: "end" }) => {
    const before = latest.current;
    const next = applyListAction(before, action, max);
    onChange(next);
    if (!focus) return;
    if (focus.id.startsWith("__previous__")) {
      const index = Number(focus.id.slice("__previous__".length));
      const target = next[Math.max(0, index - 1)];
      if (target) setFocusNext({ id: target.id, caret: "end" });
      return;
    }
    setFocusNext(focus);
  };

  const onNewRow = (after: number) => {
    if (latest.current.length >= max) return;
    const id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    onAction({ type: "insert", after, id }, { id });
  };

  return (
    <div>
      {items.length === 0 && emptyHint ? <div className="mb-1">{emptyHint}</div> : null}
      <Reorder.Group
        as="ol"
        axis="y"
        values={items as TeachItem[]}
        onReorder={(next) => onAction({ type: "reorder", ids: next.map((row) => row.id) })}
        className="space-y-0.5"
      >
        <AnimatePresence initial={false}>
          {items.map((row, index) => (
            <ListRow
              key={row.id}
              row={row}
              index={index}
              count={items.length}
              numbered={numbered}
              placeholder={placeholderFor(index)}
              label={label}
              disabled={disabled}
              invalid={invalidIds?.has(row.id) ?? false}
              reduce={reduce}
              registerField={registerField}
              onAction={onAction}
              onNewRow={onNewRow}
            />
          ))}
        </AnimatePresence>
      </Reorder.Group>
      <motion.div layout={reduce ? false : "position"} transition={spring.layout} className="mt-1 pl-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || items.length >= max}
          onClick={() => onNewRow(items.length - 1)}
          className="gap-1.5 font-normal text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {items.length >= max ? `${max} is the most a skill can have` : addLabel}
        </Button>
      </motion.div>
    </div>
  );
}
