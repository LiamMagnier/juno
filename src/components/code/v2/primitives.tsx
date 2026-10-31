"use client";

/**
 * Small shared pieces for the Code workspace: the glyph wrapper (Alevr's web
 * icon set), instance marks, the anchored popover (a bottom sheet when
 * narrow), menus with submenu panes, the segmented control, keycaps.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Icon } from "@/components/ui/juno-icons";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { instanceMark, modelLab } from "@/lib/code-v2/providers-view";
import type { ProviderInstance } from "@/lib/code-v2/contracts";
import { formatKey } from "@/lib/code-v2/keymap";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/lib/motion-preference";
import { usePresence } from "@/lib/use-presence";
import { useMergedRef, useSwipeDismiss } from "@/components/ui/sheet-gesture";

export function Glyph({ name, size = 16, className, spin, title }: { name: string; size?: number; className?: string; spin?: boolean; title?: string }) {
  return (
    <span className={cn("cv2-ic inline-grid place-items-center", spin && "cv2-spin", className)} style={{ width: size, height: size }} aria-hidden={title ? undefined : true} title={title}>
      <Icon name={name} size={size} />
    </span>
  );
}

/**
 * Spinner glyph: the icon set's loader turning (static under reduced motion).
 * Only inside the button that was just pressed; work that is running anywhere
 * else shows the galaxy (LiveMark).
 */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Glyph name="loading" size={size} spin className={className} />;
}

/**
 * The working mark beside a live row: the galaxy (docs/design/GALAXY_SPEC.md),
 * the same one Chat and Work draw, turning only while the work is real. It
 * replaced the T3-style shine that swept the live verb: the verb now sits
 * still in the first ink and the galaxy is the one moving thing.
 */
export function LiveMark({ size = 14, className }: { size?: number; className?: string }) {
  return <GalaxyMark phase="working" size={size} className={cn("cv2-mark", className)} />;
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

/** The gaps the CSS used to draw: above the anchor, below it (`.down`), and to the window's edge. */
const POP_GAP_UP = 8;
const POP_GAP_DOWN = 6;
const POP_MARGIN = 8;
const POP_MAX = 480;
/** Below this width the popover is a bottom sheet (code-v2.css), placed by CSS alone. */
const POP_SHEET_MAX = 760;

/**
 * Where the panel goes, from the box it used to be positioned against: above
 * it (or below for `down`), aligned to its left or right edge plus `offset`,
 * flipped to the other side when the preferred one cannot hold it and the
 * other has more room, held inside the window, and given the height the
 * chosen side has. Pure, so the placement is tested.
 */
export function placeComposerPopover({
  anchor,
  viewport,
  natural,
  width,
  align,
  offset,
  down,
}: {
  anchor: { top: number; bottom: number; left: number; right: number };
  viewport: { width: number; height: number };
  natural: number;
  width: number;
  align: "left" | "right";
  offset: number;
  down: boolean;
}): { down: boolean; style: React.CSSProperties } {
  const above = anchor.top - POP_GAP_UP - POP_MARGIN;
  const below = viewport.height - anchor.bottom - POP_GAP_DOWN - POP_MARGIN;
  const want = Math.min(natural, POP_MAX);
  let flip = down;
  if (!down && want > above && below > above) flip = true;
  if (down && want > below && above > below) flip = false;
  const room = Math.max(0, flip ? below : above);
  const style: React.CSSProperties = { position: "fixed", width, maxHeight: Math.min(POP_MAX, room) };
  if (flip) style.top = anchor.bottom + POP_GAP_DOWN;
  else style.bottom = viewport.height - anchor.top + POP_GAP_UP;
  const maxStart = Math.max(POP_MARGIN, viewport.width - POP_MARGIN - width);
  if (align === "right") {
    style.right = Math.min(maxStart, Math.max(POP_MARGIN, viewport.width - anchor.right + offset));
  } else {
    style.left = Math.min(maxStart, Math.max(POP_MARGIN, anchor.left + offset));
  }
  return { down: flip, style };
}

/**
 * A popover anchored to the composer (DESIGN §5.8–5.11): above it, aligned
 * left or right with an offset. Below 761 px it becomes a bottom sheet with a
 * grabber and a scrim (CSS), dismissed by a downward drag.
 *
 * PORTALLED. It used to be an absolutely positioned child of whatever it was
 * anchored to, so it was clipped by any scrolling ancestor and stacked inside
 * the composer's own stacking context, where the dock or the transcript could
 * cover it. It now renders into the workspace root (`.cv2`, so its scoped
 * styles and tokens still apply) at the `--z-popper` rung, placed against the
 * same box the CSS used (a hidden marker left in place), flipped to the other
 * side when there is no room, and kept inside the window. Focus moves into it
 * when it opens from the keyboard's trigger (a portalled menu is otherwise
 * past the end of the tab order) and goes back to the trigger when it closes.
 */
/**
 * Draws an open ComposerPopover where it stands instead of portalling it.
 * Only for a render that has no DOM to portal into (renderToStaticMarkup in
 * tests/code-v2-web-workspace.test.ts, which reads what an open popover says);
 * the app never provides it, so every real popover is portalled as above.
 */
export const ComposerPopoverInPlace = React.createContext(false);

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
  // It stays mounted for its exit (0.65 x the entrance, accelerating), so a
  // menu leaves the way it arrived instead of vanishing.
  const presence = usePresence(open, 240);
  // Below 761 px a downward throw dismisses it: the shared sheet gesture
  // (ui/sheet-gesture.ts) that every web dialog uses on a phone. A throw marks
  // the panel data-gesture="gone", which turns the exit animation off (the
  // finger already moved it away); presence's fallback then unmounts it.
  const scrimRef = React.useRef<HTMLDivElement>(null);
  const swipeRef = useSwipeDismiss({ axis: "y", sign: 1, enabled: () => window.innerWidth <= POP_SHEET_MAX, scrimRef, onDismiss: onClose });
  const panelEl = React.useRef<HTMLDivElement | null>(null);
  const panelRef = useMergedRef<HTMLDivElement>(ref, swipeRef, panelEl);
  // Left in place: the box the panel used to be positioned against.
  const markerRef = React.useRef<HTMLSpanElement>(null);
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  const [place, setPlace] = React.useState<{ down: boolean; style: React.CSSProperties } | null>(null);
  const mounted = presence.mounted;
  const inPlace = React.useContext(ComposerPopoverInPlace);

  const measure = React.useCallback(() => {
    const marker = markerRef.current;
    const panel = panelEl.current;
    if (!marker || !panel) return;
    if (window.innerWidth <= POP_SHEET_MAX) {
      // A bottom sheet: code-v2.css places it.
      setPlace({ down: !!down, style: {} });
      return;
    }
    const box = marker.getBoundingClientRect();
    setPlace(
      placeComposerPopover({
        anchor: box,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        natural: panel.scrollHeight,
        width,
        align,
        offset,
        down: !!down,
      }),
    );
  }, [align, down, offset, width]);

  React.useLayoutEffect(() => {
    if (!mounted) {
      setPlace(null);
      return;
    }
    setHost(markerRef.current?.closest<HTMLElement>(".cv2") ?? document.body);
  }, [mounted]);

  React.useLayoutEffect(() => {
    if (!mounted || !host) return;
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [host, measure, mounted]);

  // Into the panel on open (unless something inside already took focus, e.g.
  // a search field), back to the opener on close.
  React.useEffect(() => {
    if (!open || !host) return;
    const panel = panelEl.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (panel && !panel.contains(document.activeElement)) {
      // The menu itself (its arrow keys are on it), or the panel: never a
      // field, which would raise the phone's keyboard over the sheet.
      (panel.querySelector<HTMLElement>("[role=menu]") ?? panel).focus({ preventScroll: true });
    }
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || (panel?.contains(now) ?? false);
      if (lost && opener && opener.isConnected && !panel?.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [host, open]);

  const state = presence.closing ? "closed" : "open";
  const flipped = place ? place.down : !!down;
  const body = (
    <>
      <div ref={scrimRef} data-swipe-scrim="" className="cv2-pop-scrim" data-state={state} onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        data-swipe-panel=""
        role={role}
        aria-label={label}
        tabIndex={-1}
        data-state={state}
        inert={presence.closing}
        onAnimationEnd={presence.onAnimationEnd}
        className={cn("cv2-pop", flipped && "down", className)}
        style={{
          width,
          ...place?.style,
          // Hidden for the one layout pass before it is measured.
          ...(place ? null : { visibility: "hidden" as const }),
          ["--cv2-origin" as string]: align === "right" ? "bottom right" : "bottom left",
        }}
      >
        <div className="cv2-pop-grab" data-sheet-handle="" />
        {children}
      </div>
    </>
  );
  return (
    <>
      <span ref={markerRef} aria-hidden className="cv2-pop-marker" />
      {mounted ? (inPlace ? body : host ? createPortal(body, host) : null) : null}
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
      /** Destructive (Delete): drawn in the destructive ink. */
      danger?: boolean;
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
            className={cn("cv2-mi", e.l2 && "two", e.danger && "danger")}
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
