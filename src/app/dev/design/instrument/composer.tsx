"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, ChevronRight, Link2Off, Mic, Plus } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { ENTITIES, KIND_LABEL, KIND_ORDER, MODELS, entity, type Entity } from "./fixtures";
import { Key } from "./lens";
import { AppMark, EntityMark, ModelMark } from "./marks";
import { DUR, EASE_IN, EASE_OUT } from "./tokens";

/*
 * THE COMPOSER: one pattern everywhere (PRODUCT_REFOUNDATION §5).
 *
 * The field is a small document model, not a textarea: a list of text runs
 * and TOKENS. A token is an atomic object in the sentence drawn with the
 * thing's own mark (a face, a file-type glyph, an app's brand), on a neutral
 * chip, in ink. The request would carry `context: [{ kind, id }]`.
 *
 * Motion (every duration is a token in tokens.ts):
 *  - focus: tonal only; the hairline and the shadow deepen (180ms)
 *  - "@": the palette opens ANCHORED TO THE CARET (140ms, 4px drop, 0.98
 *    scale from the caret's corner); choosing a row flies that row's mark
 *    into the new token (FLIP, 220ms ease-out) while the chip resolves
 *    around it (160ms, 60ms later): the object you picked is the object in
 *    the sentence
 *  - an app token opens its panel FROM the token (160ms, origin at the chip)
 *  - the model popover rises from its control (140ms in, 100ms out)
 * Reduced motion: every one of these is a crossfade.
 */

export type Seg = { t: "text"; v: string } | { t: "token"; id: string; key: string };

export const DRAFT: Seg[] = [
  { t: "text", v: "Compare " },
  { t: "token", id: "q3-forecast", key: "d1" },
  { t: "text", v: " with " },
  { t: "token", id: "stripe", key: "d2" },
  { t: "text", v: " and ask " },
  { t: "token", id: "mira", key: "d3" },
  { t: "text", v: " to flag renewal risk" },
];

export function isEmpty(segs: Seg[]) {
  return segs.every((s) => s.t === "text" && s.v.trim() === "");
}

/* ---------------------------------------------------------------------------
 * Token
 * ------------------------------------------------------------------------- */

export function Token({
  id,
  size = "md",
  connected,
  selected,
  onClick,
  markRef,
  tokenRef,
  expanded,
}: {
  id: string;
  size?: "md" | "sm";
  connected?: boolean;
  selected?: boolean;
  onClick?: (e: React.MouseEvent<HTMLSpanElement>) => void;
  markRef?: React.Ref<HTMLSpanElement>;
  tokenRef?: React.Ref<HTMLSpanElement>;
  expanded?: boolean;
}) {
  const e = entity(id);
  const needs = e.kind === "app" && (connected ?? e.connected) === false;
  return (
    <span
      ref={tokenRef}
      className="in-token"
      data-size={size === "sm" ? "sm" : undefined}
      data-selected={selected ? "" : undefined}
      data-state={needs ? "needs-connection" : undefined}
      aria-expanded={onClick ? !!expanded : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      contentEditable={false}
      onClick={onClick}
      data-token-id={id}
    >
      <span ref={markRef} className="in-token__mark" data-token-mark="">
        <EntityMark entity={e} size={size === "sm" ? 14 : 16} />
      </span>
      <span className="in-token__name">{e.name}</span>
      {needs ? (
        <span className="in-token__flag" aria-label="Needs connecting">
          <Link2Off size={12} motion="none" />
        </span>
      ) : null}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * The @ palette
 * ------------------------------------------------------------------------- */

function filterEntities(query: string): Entity[] {
  const q = query.trim().toLowerCase();
  const list = q ? ENTITIES.filter((e) => e.name.toLowerCase().split(/[\s.]+/).some((w) => w.startsWith(q)) || e.name.toLowerCase().startsWith(q)) : ENTITIES;
  return KIND_ORDER.flatMap((k) => list.filter((e) => e.kind === k));
}

export function Palette({
  query,
  active,
  onChoose,
  onHover,
  hiddenMark,
  rowMarkRef,
}: {
  query: string;
  active: number;
  onChoose: (e: Entity, markEl: HTMLElement | null) => void;
  onHover?: (i: number) => void;
  hiddenMark?: string;
  rowMarkRef?: (id: string, el: HTMLSpanElement | null) => void;
}) {
  const rows = filterEntities(query);
  let index = -1;
  return (
    <div className="in-float in-menu w-[340px]" role="listbox" aria-label="Add context">
      {rows.length === 0 ? (
        <p className="px-2 py-3 in-t-small in-ink-3">Nothing called “{query}”. Keep typing, or press esc.</p>
      ) : (
        KIND_ORDER.map((kind) => {
          const group = rows.filter((r) => r.kind === kind);
          if (!group.length) return null;
          return (
            <div key={kind} role="group" aria-label={KIND_LABEL[kind]}>
              <p className="in-menu__label in-t-label">{KIND_LABEL[kind]}</p>
              {group.map((e) => {
                index += 1;
                const i = index;
                const isActive = i === active;
                return (
                  <div
                    key={e.id}
                    role="option"
                    aria-selected={isActive}
                    className="in-mrow"
                    data-active={isActive ? "" : undefined}
                    onPointerEnter={() => onHover?.(i)}
                    onPointerDown={(ev) => {
                      ev.preventDefault();
                      const mark = (ev.currentTarget.querySelector("[data-row-mark]") as HTMLElement | null) ?? null;
                      onChoose(e, mark);
                    }}
                  >
                    <span
                      data-row-mark=""
                      ref={(el) => rowMarkRef?.(e.id, el)}
                      className="inline-grid size-5 place-items-center"
                      style={{ visibility: hiddenMark === e.id ? "hidden" : undefined }}
                    >
                      <EntityMark entity={e} size={16} />
                    </span>
                    <span className="in-mrow__main">
                      <span className="in-mrow__title">{e.name}</span>
                    </span>
                    <span className="max-w-[140px] truncate in-t-small in-ink-3">
                      {e.kind === "app" && e.connected === false ? "Not connected" : e.detail}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })
      )}
      <div className="in-menu__foot in-mono">
        <span className="inline-flex items-center gap-1.5"><span className="in-kbd">↑</span><span className="in-kbd">↓</span> move</span>
        <span className="inline-flex items-center gap-1.5"><span className="in-kbd">↵</span> add</span>
        <span className="inline-flex items-center gap-1.5"><span className="in-kbd">esc</span> close</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The model popover
 * ------------------------------------------------------------------------- */

export function ModelPopover({ selected = "auto", effort = "standard" }: { selected?: string; effort?: "light" | "standard" | "deep" }) {
  const [current, setCurrent] = React.useState(selected);
  const [level, setLevel] = React.useState(effort);
  return (
    <div className="in-float in-menu w-[352px]" role="dialog" aria-label="Model">
      <div role="listbox" aria-label="Models">
        {MODELS.map((m) => (
          <div key={m.id} role="option" aria-selected={current === m.id} className="in-mrow items-start" data-active={current === m.id ? "" : undefined} onClick={() => setCurrent(m.id)}>
            <span className="mt-0.5 inline-grid size-5 place-items-center in-ink-2">
              <ModelMark model={m} size={16} />
            </span>
            <span className="in-mrow__main">
              <span className="in-mrow__title">{m.name}</span>
              <span className="in-mrow__detail">{m.line}</span>
            </span>
            <span className="mt-0.5 flex w-9 items-center justify-end gap-1">
              {m.cost ? <span className="in-mono in-fs-115 in-ink-3">{m.cost}</span> : null}
              {current === m.id ? <Check size={14} motion="none" className="in-ink" /> : null}
            </span>
          </div>
        ))}
      </div>
      <div className="in-menu__sep" />
      <div className="flex items-center justify-between gap-3 px-2 py-1.5">
        <span className="in-t-small in-ink-2">Effort</span>
        <div className="in-seg w-[220px]" data-size="sm" role="radiogroup" aria-label="Effort">
          {(["light", "standard", "deep"] as const).map((l) => (
            <button key={l} type="button" role="radio" className="in-seg__item" aria-checked={level === l} onClick={() => setLevel(l)}>
              {l === "light" ? "Light" : l === "standard" ? "Standard" : "Deep"}
            </button>
          ))}
        </div>
      </div>
      <div className="in-menu__sep" />
      <button type="button" className="in-mrow">
        <span className="in-mrow__main in-ink-2">All models</span>
        <span className="in-mono in-fs-115 in-ink-3">42</span>
        <ChevronRight size={14} motion="none" className="in-ink-3" />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The app panel (reference 1): what this app can do here, emerging from its token
 * ------------------------------------------------------------------------- */

export function AppPanel({ id, connected, onConnect }: { id: string; connected: boolean; onConnect?: () => void }) {
  const e = entity(id);
  const reduce = useReducedMotion();
  const rows =
    id === "slack"
      ? [
          { verb: "Post a message", detail: "Asks you first, every time" },
          { verb: "Read channels you choose", detail: "#design, #renewals" },
        ]
      : id === "stripe"
        ? [
            { verb: "Read subscriptions and invoices", detail: "Allowed" },
            { verb: "Refunds and changes", detail: "Off for this chat" },
          ]
        : [{ verb: "Read issues and projects", detail: "Allowed" }];
  return (
    <div className="in-float w-[320px] overflow-hidden" role="dialog" aria-label={`${e.name} in this message`}>
      <div className="flex items-center gap-3 px-4 pt-4">
        <AppMark id={id} size={22} />
        <div className="min-w-0 flex-1">
          <p className="in-fs-14 font-medium leading-5">{e.name}</p>
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={connected ? "on" : "off"}
              className={cn("in-t-small", connected ? "in-ink-3" : "in-amber")}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : DUR.tonal }}
            >
              {connected ? (id === "slack" ? "Connected as Liam Magnier" : "Connected as Northwind Analytics") : "Not connected"}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
      <div className="mt-3 px-2 pb-2">
        {rows.map((r) => (
          <div key={r.verb} className="flex items-baseline justify-between gap-3 in-r-8 px-2 py-[7px]">
            <span className="in-t-ui">{r.verb}</span>
            <span className="shrink-0 in-t-small in-ink-3">{r.detail}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-4 py-3" style={{ borderColor: "var(--in-hairline)" }}>
        {connected ? (
          <>
            <span className="in-t-small in-ink-3">{id === "slack" ? "Posting to #design will ask you first" : "Used in 4 chats this week"}</span>
            <button type="button" className="in-btn" data-variant="ghost" data-size="sm">
              Settings
            </button>
          </>
        ) : (
          <>
            <span className="in-t-small in-ink-3">Connect here, without leaving</span>
            <button type="button" className="in-btn" data-variant="solid" data-size="sm" onClick={onConnect}>
              Connect {e.name}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The composer
 * ------------------------------------------------------------------------- */

export interface ComposerHandle {
  focus: () => void;
  blur: () => void;
  typeChar: (c: string) => void;
  press: (key: "Enter" | "Backspace" | "ArrowDown" | "ArrowUp" | "Escape") => void;
  openToken: (id: string) => void;
  closePanels: () => void;
  connect: (id: string) => void;
  openModel: (open: boolean) => void;
  setSegs: (segs: Seg[]) => void;
}

type Float = { kind: "palette" } | { kind: "app"; key: string; id: string } | { kind: "model" } | null;

export function Composer({
  initial = [],
  placeholder = "Ask Juno anything, @ to add context",
  size = "hero",
  context,
  modelLabel = "Auto",
  staticFocused,
  staticPalette,
  staticModel,
  staticApp,
  onSend,
  handleRef,
  className,
}: {
  initial?: Seg[];
  placeholder?: string;
  size?: "hero" | "docked";
  context?: React.ReactNode;
  modelLabel?: string;
  /** Pictures of a state for the stills: show focus / an open palette / popover without interaction. */
  staticFocused?: boolean;
  staticPalette?: { query: string; active?: number };
  staticModel?: boolean;
  staticApp?: { id: string };
  onSend?: (segs: Seg[]) => void;
  handleRef?: React.Ref<ComposerHandle>;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const [segs, setSegs] = React.useState<Seg[]>(initial);
  const [focused, setFocused] = React.useState(!!staticFocused);
  const [query, setQuery] = React.useState<string | null>(staticPalette ? staticPalette.query : null);
  const [active, setActive] = React.useState(staticPalette?.active ?? 0);
  const [float, setFloat] = React.useState<Float>(
    staticPalette ? { kind: "palette" } : staticModel ? { kind: "model" } : staticApp ? { kind: "app", key: "static", id: staticApp.id } : null,
  );
  const [connectedOverride, setConnectedOverride] = React.useState<Record<string, boolean>>({});
  const [hiddenMark, setHiddenMark] = React.useState<string | undefined>();
  const [anchor, setAnchor] = React.useState<{ x: number; y: number; w: number; h: number; rw: number; rh: number } | null>(null);

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const fieldRef = React.useRef<HTMLDivElement | null>(null);
  const caretRef = React.useRef<HTMLSpanElement | null>(null);
  const modelRef = React.useRef<HTMLButtonElement | null>(null);
  const tokenEls = React.useRef(new Map<string, HTMLSpanElement>());
  const markEls = React.useRef(new Map<string, HTMLSpanElement>());
  const rowMarks = React.useRef(new Map<string, HTMLSpanElement>());
  const flight = React.useRef<{ key: string; from: DOMRect } | null>(null);
  const counter = React.useRef(0);

  const paletteRows = React.useMemo(() => (query === null ? [] : filterEntities(query)), [query]);
  const empty = isEmpty(segs) && query === null;
  const showCaret = focused;

  const isConnected = (id: string) => connectedOverride[id] ?? entity(id).connected ?? true;

  // Anchor floating surfaces: to the caret (palette), a token (app panel) or the model control.
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !float) return;
    const rr = root.getBoundingClientRect();
    let target: DOMRect | null = null;
    if (float.kind === "palette") target = caretRef.current?.getBoundingClientRect() ?? null;
    if (float.kind === "app") {
      const el = float.key === "static" ? root.querySelector<HTMLElement>(`[data-token-id="${float.id}"]`) : tokenEls.current.get(float.key);
      target = el?.getBoundingClientRect() ?? null;
    }
    if (float.kind === "model") target = modelRef.current?.getBoundingClientRect() ?? null;
    if (!target) return;
    setAnchor({ x: target.left - rr.left, y: target.top - rr.top, w: target.width, h: target.height, rw: rr.width, rh: rr.height });
  }, [float, segs, query]);

  // FLIP: the chosen row's mark lands in the new token.
  React.useLayoutEffect(() => {
    const f = flight.current;
    if (!f) return;
    const mark = markEls.current.get(f.key);
    const chip = tokenEls.current.get(f.key);
    flight.current = null;
    if (!mark || !chip) return;
    if (reduce) {
      chip.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
      return;
    }
    const to = mark.getBoundingClientRect();
    const dx = f.from.left + f.from.width / 2 - (to.left + to.width / 2);
    const dy = f.from.top + f.from.height / 2 - (to.top + to.height / 2);
    mark.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
      duration: 220,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
    chip.animate(
      [
        { opacity: 0, transform: "scale(0.94)", boxShadow: "inset 0 0 0 1px transparent" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 160, delay: 60, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" },
    );
  });

  const choose = React.useCallback(
    (e: Entity, markEl: HTMLElement | null) => {
      counter.current += 1;
      const key = `t${counter.current}`;
      if (markEl) flight.current = { key, from: markEl.getBoundingClientRect() };
      setHiddenMark(e.id);
      setSegs((prev) => {
        const next = [...prev];
        next.push({ t: "token", id: e.id, key }, { t: "text", v: " " });
        return next;
      });
      setQuery(null);
      setActive(0);
      setFloat(e.kind === "app" && e.connected === false ? { kind: "app", key, id: e.id } : null);
      window.setTimeout(() => setHiddenMark(undefined), 200);
    },
    [],
  );

  const typeChar = React.useCallback(
    (c: string) => {
      if (query !== null) {
        if (c === " " && query === "") {
          setQuery(null);
          setFloat(null);
          setSegs((p) => appendText(p, "@ "));
          return;
        }
        setQuery(query + c);
        setActive(0);
        return;
      }
      if (c === "@") {
        setQuery("");
        setActive(0);
        setFloat({ kind: "palette" });
        return;
      }
      setFloat((f) => (f?.kind === "app" || f?.kind === "model" ? null : f));
      setSegs((p) => appendText(p, c));
    },
    [query],
  );

  const press = React.useCallback(
    (key: "Enter" | "Backspace" | "ArrowDown" | "ArrowUp" | "Escape") => {
      if (query !== null) {
        if (key === "ArrowDown") setActive((a) => Math.min(a + 1, Math.max(0, paletteRows.length - 1)));
        if (key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
        if (key === "Escape") {
          setQuery(null);
          setFloat(null);
        }
        if (key === "Backspace") {
          if (query === "") {
            setQuery(null);
            setFloat(null);
          } else setQuery(query.slice(0, -1));
        }
        if (key === "Enter") {
          const row = paletteRows[active];
          if (row) choose(row, rowMarks.current.get(row.id) ?? null);
        }
        return;
      }
      if (key === "Escape") setFloat(null);
      if (key === "Backspace") setSegs((p) => backspace(p));
      if (key === "Enter") {
        if (isEmpty(segs)) return;
        onSend?.(segs);
        setFloat(null);
      }
    },
    [query, paletteRows, active, choose, segs, onSend],
  );

  React.useImperativeHandle(
    handleRef,
    () => ({
      focus: () => {
        fieldRef.current?.focus({ preventScroll: true });
        setFocused(true);
      },
      blur: () => {
        fieldRef.current?.blur();
        setFocused(false);
      },
      typeChar,
      press,
      openToken: (id: string) => {
        const seg = segs.find((s) => s.t === "token" && s.id === id) as Extract<Seg, { t: "token" }> | undefined;
        if (seg) setFloat({ kind: "app", key: seg.key, id });
      },
      closePanels: () => {
        setFloat(null);
        setQuery(null);
      },
      connect: (id: string) => setConnectedOverride((c) => ({ ...c, [id]: true })),
      openModel: (open: boolean) => setFloat(open ? { kind: "model" } : null),
      setSegs: (s: Seg[]) => {
        setSegs(s);
        setQuery(null);
        setFloat(null);
      },
    }),
    [typeChar, press, segs],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length === 1) {
      e.preventDefault();
      typeChar(e.key);
    } else if (["Enter", "Backspace", "ArrowDown", "ArrowUp", "Escape"].includes(e.key)) {
      if (e.key === "Enter" && e.shiftKey) return;
      e.preventDefault();
      press(e.key as "Enter");
    }
  };

  const docked = size === "docked";
  const floatBelow = !docked;

  // Floating geometry, clamped inside the composer's width.
  const rootW = anchor?.rw ?? 680;
  const rootH = anchor?.rh ?? 140;
  let floatStyle: React.CSSProperties = {};
  let origin = "0% 0%";
  if (anchor && float) {
    const width = float.kind === "palette" ? 340 : float.kind === "model" ? 352 : 320;
    const desired = float.kind === "model" ? anchor.x + anchor.w - width : anchor.x - (float.kind === "palette" ? 12 : 6);
    const left = Math.max(-8, Math.min(desired, rootW - width + 8));
    const ox = anchor.x - left + (float.kind === "model" ? anchor.w / 2 : 8);
    if (float.kind === "model") {
      // The model control opens upward when docked, downward on the hero.
      if (docked) {
        floatStyle = { left, bottom: rootH - anchor.y + 8 };
        origin = `${ox}px 100%`;
      } else {
        floatStyle = { left, top: anchor.y + anchor.h + 8 };
        origin = `${ox}px 0%`;
      }
    } else if (floatBelow) {
      floatStyle = { left, top: anchor.y + anchor.h + 8 };
      origin = `${ox}px 0%`;
    } else {
      floatStyle = { left, bottom: rootH - anchor.y + 8 };
      origin = `${ox}px 100%`;
    }
  }

  const floatMotion = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.98, y: floatBelow || float?.kind === "model" && !docked ? -4 : 4 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.99, transition: { duration: 0.1, ease: EASE_IN } },
      };

  const fieldContent = (
    <>
      {empty && !focused ? <span className="in-composer__placeholder">{placeholder}</span> : null}
      {empty && focused ? <span className="in-composer__placeholder absolute left-[18px] top-[16px]">{placeholder}</span> : null}
      {segs.map((s, i) =>
        s.t === "text" ? (
          <span key={i} className="whitespace-pre-wrap">
            {s.v}
          </span>
        ) : (
          <Token
            key={s.key}
            id={s.id}
            connected={isConnected(s.id)}
            expanded={float?.kind === "app" && (float.key === s.key || (float.key === "static" && float.id === s.id))}
            tokenRef={(el) => {
              if (el) tokenEls.current.set(s.key, el);
              else tokenEls.current.delete(s.key);
            }}
            markRef={(el) => {
              if (el) markEls.current.set(s.key, el);
              else markEls.current.delete(s.key);
            }}
            onClick={entity(s.id).kind === "app" ? () => setFloat((f) => (f?.kind === "app" && f.key === s.key ? null : { kind: "app", key: s.key, id: s.id })) : undefined}
          />
        ),
      )}
      {query !== null ? <span className="in-typed-query">@{query}</span> : null}
      <span ref={caretRef} className={showCaret ? "in-caret" : "inline-block w-0"} aria-hidden="true" />
    </>
  );

  return (
    <div
      ref={rootRef}
      className={cn("in-composer", className)}
      data-focused={focused ? "" : undefined}
      data-size={size}
    >
      {context ? <div className="in-composer__context">{context}</div> : null}
      <div
        ref={fieldRef}
        className="in-composer__field"
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        aria-placeholder={placeholder}
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          if (!staticFocused) setFocused(false);
        }}
        onKeyDown={onKeyDown}
        onMouseDown={() => fieldRef.current?.focus()}
      >
        <span data-draft="">{fieldContent}</span>
      </div>
      <div className="in-composer__bar">
        <button type="button" className="in-iconbtn" aria-label="Add files, photos and more">
          <Plus size={18} motion="none" />
        </button>
        <span className="in-composer__spacer" />
        <button
          ref={modelRef}
          type="button"
          className="in-model"
          aria-haspopup="dialog"
          aria-expanded={float?.kind === "model"}
          onClick={() => setFloat((f) => (f?.kind === "model" ? null : { kind: "model" }))}
        >
          {modelLabel === "Auto" ? <ModelMark model={MODELS[0]} size={14} className="in-ink-3" /> : null}
          {modelLabel}
          <ChevronDown size={12} motion="none" className="in-ink-3" />
        </button>
        <button type="button" className="in-iconbtn" aria-label="Dictate">
          <Mic size={18} motion="none" />
        </button>
        <button
          type="button"
          className="in-keybtn"
          aria-label={empty ? "Talk to Juno" : "Send"}
          onClick={() => {
            if (!empty) press("Enter");
          }}
        >
          <Key armed={!empty} />
        </button>
      </div>

      <AnimatePresence>
        {float && anchor ? (
          <motion.div
            key={float.kind === "app" ? `app-${float.key}` : float.kind}
            className="absolute z-30"
            style={{ ...floatStyle, transformOrigin: origin }}
            {...floatMotion}
            transition={{ duration: float.kind === "app" ? DUR.panel : DUR.menu, ease: EASE_OUT }}
          >
            {float.kind === "palette" ? (
              <Palette
                query={query ?? ""}
                active={active}
                onHover={setActive}
                onChoose={choose}
                hiddenMark={hiddenMark}
                rowMarkRef={(id, el) => {
                  if (el) rowMarks.current.set(id, el);
                  else rowMarks.current.delete(id);
                }}
              />
            ) : float.kind === "model" ? (
              <ModelPopover />
            ) : (
              <AppPanel id={float.id} connected={isConnected(float.id)} onConnect={() => setConnectedOverride((c) => ({ ...c, [float.id]: true }))} />
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function appendText(segs: Seg[], text: string): Seg[] {
  const next = [...segs];
  const last = next[next.length - 1];
  if (last && last.t === "text") next[next.length - 1] = { t: "text", v: last.v + text };
  else next.push({ t: "text", v: text });
  return next;
}

function backspace(segs: Seg[]): Seg[] {
  const next = [...segs];
  const last = next[next.length - 1];
  if (!last) return next;
  if (last.t === "token") return next.slice(0, -1);
  if (last.v.length <= 1) return next.slice(0, -1);
  next[next.length - 1] = { t: "text", v: last.v.slice(0, -1) };
  return next;
}
