"use client";

/**
 * Small shared pieces for the Code workspace: the glyph wrapper (Alevr's web
 * icon set), instance marks, the anchored popover (a bottom sheet when
 * narrow), menus with submenu panes, the segmented control, keycaps.
 */
import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Icon } from "@/components/ui/juno-icons";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { instanceMark, modelLab } from "@/lib/code-v2/providers-view";
import type { ProviderInstance } from "@/lib/code-v2/contracts";
import { formatKey } from "@/lib/code-v2/keymap";
import { cn } from "@/lib/utils";

export function Glyph({ name, size = 16, className, spin, title }: { name: string; size?: number; className?: string; spin?: boolean; title?: string }) {
  return (
    <span className={cn("cv2-ic inline-grid place-items-center", spin && "cv2-spin", className)} style={{ width: size, height: size }} aria-hidden={title ? undefined : true} title={title}>
      <Icon name={name} size={size} />
    </span>
  );
}

/** Spinner glyph: the icon set's loader turning (static under reduced motion). */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Glyph name="loading" size={size} spin className={className} />;
}

export function InstanceMark({ instance, size = 16, className }: { instance: Pick<ProviderInstance, "id" | "kind" | "acpCommand">; size?: number; className?: string }) {
  const mark = instanceMark(instance);
  if (mark.type === "alevr") return <ContinuumMark size={size} className={className} />;
  if (mark.type === "lab") return <ProviderLogo provider={mark.provider} className={cn("shrink-0", className)} />;
  return <Glyph name={mark.name} size={size} className={className} />;
}

/** A model's lab mark (falls back to the instance's). */
export function ModelMark({ modelId, instance, className }: { modelId: string; instance?: Pick<ProviderInstance, "id" | "kind" | "acpCommand">; className?: string }) {
  const lab = modelLab(modelId, instance);
  if (lab) return <ProviderLogo provider={lab} className={cn("shrink-0", className)} />;
  if (instance) return <InstanceMark instance={instance} className={className} />;
  return <Glyph name="layers" size={16} className={className} />;
}

export function Kbd({ k, mac = true }: { k: string; mac?: boolean }) {
  return <kbd className="cv2-kbd">{formatKey(k, mac)}</kbd>;
}

export function useIsMac(): boolean {
  const [mac, setMac] = React.useState(true);
  React.useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);
  return mac;
}

/** Closes on outside pointerdown and Esc. Returns props for the popover root. */
export function useDismiss(open: boolean, onClose: () => void, ignore?: React.RefObject<HTMLElement | null>) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || ignore?.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, ignore]);
  return ref;
}

/**
 * A popover anchored to the composer (DESIGN §5.8–5.11): above it, aligned
 * left or right with an offset. Below 761 px it becomes a bottom sheet with a
 * grabber and a scrim (CSS), dismissed by a downward drag.
 */
export function ComposerPopover({
  open,
  onClose,
  width,
  align = "right",
  offset = 0,
  label,
  anchorRef,
  children,
  className,
  down,
  role = "dialog",
}: {
  open: boolean;
  onClose: () => void;
  width: number;
  align?: "left" | "right";
  offset?: number;
  label: string;
  anchorRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
  /** Open below the anchor (header menus) instead of above it (composer). */
  down?: boolean;
  role?: "dialog" | "menu";
}) {
  const ref = useDismiss(open, onClose, anchorRef);
  const drag = React.useRef<{ y: number; t: number } | null>(null);
  const [dy, setDy] = React.useState(0);
  if (!open) return null;
  const onPointerDown = (e: React.PointerEvent) => {
    if (window.innerWidth > 760) return;
    drag.current = { y: e.clientY, t: performance.now() };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const d = e.clientY - drag.current.y;
    setDy(d > 0 ? d : d * 0.3);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const d = e.clientY - drag.current.y;
    const v = d / Math.max(1, performance.now() - drag.current.t);
    drag.current = null;
    const h = ref.current?.offsetHeight ?? 400;
    if (v > 0.6 || d > h * 0.3) onClose();
    setDy(0);
  };
  return (
    <>
      <div className="cv2-pop-scrim" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role={role}
        aria-label={label}
        className={cn("cv2-pop", down && "down", className)}
        style={{
          width,
          ...(align === "right" ? { right: offset } : { left: offset }),
          ["--cv2-origin" as string]: align === "right" ? "bottom right" : "bottom left",
          ...(dy ? { transform: `translateY(${dy}px)`, transition: "none" } : {}),
        }}
      >
        <div className="cv2-pop-grab" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
        {children}
      </div>
    </>
  );
}

/** Segmented control with a sliding fill (framer layoutId, spring standard). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  className,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  id: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <div className={cn("cv2-seg", className)} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.value === value && (
            <motion.span
              layoutId={`seg-${id}`}
              className="cv2-seg-fill"
              transition={reduce ? { duration: 0 } : { duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
            />
          )}
          <span style={{ position: "relative" }}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A word that rolls when it changes (INTERACTION I-5). */
export function Roll({ children, k }: { children: React.ReactNode; k: string | number }) {
  return (
    <span key={k} className="cv2-roll">
      {children}
    </span>
  );
}

/** The selected mark in menus and pickers (the icon set's check). */
export function DrawCheck() {
  return <Glyph name="check" size={16} />;
}

// ── Menus with submenus (one pane at a time, a back row to return) ─────────

export type MenuEntry =
  | { kind: "sep"; id: string }
  | { kind: "section"; id: string; label: string }
  | {
      kind?: "item";
      id: string;
      label: React.ReactNode;
      /** Second line, 12 muted (only inside menus: descriptions live here, never in chrome). */
      l2?: React.ReactNode;
      icon?: React.ReactNode;
      trail?: React.ReactNode;
      checked?: boolean;
      disabled?: boolean;
      /** A submenu: pushes a pane with a back row. */
      sub?: { title: string; entries: MenuEntry[] };
      onSelect?: () => void;
      /** Keep the menu open after selecting (toggles). */
      keepOpen?: boolean;
    };

type MenuItemEntry = Exclude<MenuEntry, { kind: "sep" } | { kind: "section" }>;

export function MenuList({ entries, onClose, label, initialPath = [] }: { entries: MenuEntry[]; onClose: () => void; label: string; initialPath?: string[] }) {
  const [path, setPath] = React.useState<string[]>(initialPath);
  const [hi, setHi] = React.useState(-1);
  // Resolve the pane the path points at.
  let pane = entries;
  let title: string | null = null;
  for (const id of path) {
    const e = pane.find((x) => x.id === id) as MenuItemEntry | undefined;
    if (!e?.sub) break;
    title = e.sub.title;
    pane = e.sub.entries;
  }
  const items = pane.filter((e): e is MenuItemEntry => (e.kind ?? "item") === "item");
  const run = (e: MenuItemEntry) => {
    if (e.disabled) return;
    if (e.sub) {
      setPath((p) => [...p, e.id]);
      setHi(0);
      return;
    }
    e.onSelect?.();
    if (!e.keepOpen) onClose();
  };
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      setHi((h) => (h + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length));
    } else if ((ev.key === "Enter" || ev.key === "ArrowRight") && items[hi]) {
      if (ev.key === "ArrowRight" && !items[hi].sub) return;
      ev.preventDefault();
      run(items[hi]);
    } else if ((ev.key === "ArrowLeft" || ev.key === "Backspace") && path.length) {
      ev.preventDefault();
      setPath((p) => p.slice(0, -1));
      setHi(0);
    }
  };
  return (
    <div className="cv2-pop-body" role="menu" aria-label={title ?? label} tabIndex={-1} onKeyDown={onKey} key={path.join("/")} style={{ animation: path.length ? "cv2-fade 120ms both" : undefined }}>
      {title && (
        <>
          <button type="button" className="cv2-mi" onClick={() => setPath((p) => p.slice(0, -1))}>
            <Glyph name="chevron-left" size={16} />
            <span className="cv2-m">{title}</span>
          </button>
          <div className="cv2-msep" />
        </>
      )}
      {pane.map((e) => {
        if (e.kind === "sep") return <div key={e.id} className="cv2-msep" role="separator" />;
        if (e.kind === "section") return <div key={e.id} className="cv2-msect">{e.label}</div>;
        const i = items.indexOf(e);
        return (
          <button
            key={e.id}
            type="button"
            role={e.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
            aria-checked={e.checked}
            aria-disabled={e.disabled || undefined}
            aria-haspopup={e.sub ? "menu" : undefined}
            className={cn("cv2-mi", e.l2 && "two")}
            data-active={i === hi}
            onMouseEnter={() => setHi(i)}
            onClick={() => run(e)}
          >
            {e.icon}
            <span className="cv2-grow">
              <span className="block cv2-trunc">{e.label}</span>
              {e.l2 && <span className="l2">{e.l2}</span>}
            </span>
            {(e.trail || e.sub) && (
              <span className="trail">
                {e.trail}
                {e.sub && <Glyph name="chevron-right" size={14} />}
              </span>
            )}
            {e.checked !== undefined && <span className="ck">{e.checked ? <DrawCheck /> : null}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Live clock for running rows; ticks once a second while mounted and visible. */
export function useNow(active: boolean, interval = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!t) t = setInterval(() => setNow(Date.now()), interval);
    };
    const stop = () => {
      if (t) clearInterval(t);
      t = null;
    };
    const onVis = () => (document.visibilityState === "hidden" ? stop() : (setNow(Date.now()), start()));
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [active, interval]);
  return now;
}
