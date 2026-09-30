"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  APPS,
  EFFORT,
  EFFORT_LINE,
  MODELS,
  PALETTE_GROUPS,
  POLICY_SENTENCE,
  TOKENS,
  type Effort,
  type Segment,
  type TokenRef,
} from "./fixtures";
import { Icon } from "./icons";
import { AppMark, ModelMark, TokenMark } from "./marks";
import { R, SPRING, T, useReduced } from "./motion";

/*
 * The composer (PRODUCT_REFOUNDATION §5): one field and four objects on one
 * row: add, the model, dictate, and the one ink disc (voice when empty, send
 * with words, stop while Juno works). It has NO drop shadow. It is defined by
 * its surface (the brightest plane in light, one step lighter in dark) and a
 * crisp hairline; focus darkens the hairline and adds a restrained ring in the
 * presence colour, because focus is where Juno starts listening.
 *
 * Context is named IN the sentence. Typing "@" opens a palette at the caret;
 * choosing a row inserts a token, an atomic object drawn with the thing's own
 * mark, and the row's mark travels into the chip. An app token opens a panel
 * that grows out of the token and says in words what this message may do.
 *
 * The field is a small controlled model (text runs and tokens, caret at the
 * end) so every state can be rendered and scripted; production uses a
 * contenteditable with atomic token nodes and the same states.
 */

/* ———————————————————————————— Tokens ———————————————————————————— */

export function TokenChip({
  id,
  settle,
  selected,
  onPress,
  register,
  still,
}: {
  id: string;
  /** Set only on the token that was just chosen: its fill relaxes from the palette's highlight tone (C8). */
  settle?: boolean;
  selected?: boolean;
  onPress?: (id: string) => void;
  register?: (id: string, el: HTMLSpanElement | null) => void;
  still?: boolean;
}) {
  const token = TOKENS[id];
  const needs = token.kind === "app" && token.connected === false;
  const kindWord = token.kind === "crew" ? "crew member" : token.kind === "app" ? "app" : token.kind;
  return (
    <span
      ref={(el) => register?.(id, el)}
      role={still ? undefined : "button"}
      tabIndex={still ? undefined : -1}
      aria-label={needs ? `${token.label}, ${kindWord}, not connected` : `${token.label}, ${kindWord}`}
      className="jn-token"
      data-kind={token.kind}
      data-token={id}
      data-state={needs ? "needs" : undefined}
      data-selected={selected ? "" : undefined}
      data-settle={settle ? "" : undefined}
      contentEditable={false}
      onMouseDown={(e) => {
        if (!onPress) return;
        e.preventDefault();
        onPress(id);
      }}
    >
      <span className="jn-token__mark">
        <TokenMark token={token} size={16} />
      </span>
      <span className="jn-token__label">{token.label}</span>
    </span>
  );
}

/** A sentence of text runs and tokens. The same object in the composer and in the thread. */
export function Sentence({
  segments,
  fresh,
  selected,
  onToken,
  register,
  children,
  still,
}: {
  segments: Segment[];
  fresh?: { id: string; key: string } | null;
  selected?: string | null;
  onToken?: (id: string) => void;
  register?: (id: string, el: HTMLSpanElement | null) => void;
  children?: React.ReactNode;
  still?: boolean;
}) {
  const lastToken = lastTokenIndex(segments);
  // The sentence never flies (C12, C18): a sent turn is drawn in its final place in the same frame.
  return (
    <div className="jn-sentence">
      {segments.map((s, i) => {
        if (s.t === "text") return <React.Fragment key={i}>{s.v}</React.Fragment>;
        const isFresh = !!fresh && fresh.id === s.id && i === lastToken;
        return (
          <TokenChip
            key={isFresh ? `${s.id}-${i}-${fresh?.key}` : `${s.id}-${i}`}
            id={s.id}
            settle={isFresh}
            selected={selected === s.id}
            onPress={onToken}
            register={register}
            still={still}
          />
        );
      })}
      {children}
    </div>
  );
}

function lastTokenIndex(segs: Segment[]): number {
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i].t === "token") return i;
  return -1;
}

/* ———————————————————————————— Model ———————————————————————————— */

interface State {
  /** Focus arrived from the keyboard (type-to-focus, Tab): draw the ring. */
  kbd: boolean;
  segs: Segment[];
  query: string | null;
  active: number;
  session: number;
  fresh: { id: string; key: string } | null;
  panel: string | null;
  model: boolean;
  focus: boolean;
  selected: string | null;
}

type Action =
  | { type: "char"; c: string }
  | { type: "backspace" }
  | { type: "choose"; id: string }
  | { type: "move"; delta: number; count: number }
  | { type: "hover"; index: number }
  | { type: "escape" }
  | { type: "panel"; id: string | null }
  | { type: "model"; open: boolean }
  | { type: "focus"; on: boolean; kbd?: boolean }
  | { type: "reset"; segs: Segment[] };

function appendText(segs: Segment[], c: string): Segment[] {
  const last = segs[segs.length - 1];
  if (last && last.t === "text") return [...segs.slice(0, -1), { t: "text", v: last.v + c }];
  return [...segs, { t: "text", v: c }];
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "char":
      if (s.query !== null) return { ...s, query: s.query + a.c, active: 0 };
      if (a.c === "@") return { ...s, query: "", active: 0, session: s.session + 1, panel: null, model: false, selected: null };
      return { ...s, segs: appendText(s.segs, a.c), selected: null };
    case "backspace": {
      if (s.query !== null) return s.query.length ? { ...s, query: s.query.slice(0, -1), active: 0 } : { ...s, query: null };
      const last = s.segs[s.segs.length - 1];
      if (!last) return s;
      if (last.t === "token") {
        // The first press selects the token (a token is never deleted by surprise); the second removes it whole.
        if (s.selected === last.id) return { ...s, segs: s.segs.slice(0, -1), selected: null, panel: null };
        return { ...s, selected: last.id };
      }
      const v = last.v.slice(0, -1);
      return { ...s, segs: v ? [...s.segs.slice(0, -1), { t: "text", v }] : s.segs.slice(0, -1), selected: null };
    }
    case "choose": {
      const segs: Segment[] = [...s.segs, { t: "token", id: a.id }, { t: "text", v: " " }];
      return { ...s, segs, query: null, fresh: { id: a.id, key: `pick-${a.id}-${s.session}` } };
    }
    case "move":
      return { ...s, active: a.count ? (s.active + a.delta + a.count) % a.count : 0 };
    case "hover":
      return { ...s, active: a.index };
    case "escape":
      if (s.query !== null) return { ...s, query: null, segs: appendText(s.segs, `@${s.query}`) };
      return { ...s, panel: null, model: false, selected: null };
    case "panel":
      return { ...s, panel: a.id, selected: a.id, model: false };
    case "model":
      return { ...s, model: a.open, panel: null };
    case "focus":
      return { ...s, focus: a.on, kbd: a.on ? (a.kbd ?? s.kbd) : false };
    case "reset":
      return { ...s, segs: a.segs, query: null, panel: null, model: false, selected: null, fresh: null };
  }
}

interface PaletteItem {
  token: TokenRef;
  group: string;
}

function paletteItems(query: string): { label: string; items: PaletteItem[] }[] {
  const q = query.trim().toLowerCase();
  return PALETTE_GROUPS.map((g) => {
    const ids = q ? g.ids : g.ids.slice(0, g.kind === "crew" || g.kind === "file" || g.kind === "app" ? 2 : 1);
    const items = ids
      .map((id) => TOKENS[id])
      .filter((t) => !q || t.label.toLowerCase().split(/[\s.,]+/).some((w) => w.startsWith(q)) || t.label.toLowerCase().startsWith(q))
      .map((token) => ({ token, group: g.label }));
    return { label: g.label, items };
  }).filter((g) => g.items.length > 0);
}

/* ———————————————————————————— Composer ———————————————————————————— */

export interface ComposerApi {
  /** Focus the field; `kbd` false draws pointer focus (hairline only). */
  focus: (kbd?: boolean) => void;
  blur: () => void;
  type: (text: string, perChar?: number) => Promise<void>;
  key: (k: "ArrowDown" | "ArrowUp" | "Enter" | "Escape" | "Backspace") => void;
  openPanel: (id: string | null) => void;
  openModel: (open: boolean) => void;
  send: () => void;
  reset: (segs: Segment[]) => void;
}

export interface ComposerStill {
  /** Focused from the keyboard: the darker hairline and the ring. */
  focused?: boolean;
  /** Focused by pointer: the darker hairline only. */
  pointerFocused?: boolean;
  palette?: { query: string; active?: number };
  model?: boolean;
  panel?: string;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export function Composer({
  initial = [],
  placeholder = "Ask anything. @ adds files, apps or crew; / runs skills",
  label = "Message Juno",
  layoutId,
  still,
  context,
  dockRow,
  onSend,
  apiRef,
  className,
  variant = "home",
  busy = false,
  modelLabel = "Auto",
  effortLabel,
}: {
  initial?: Segment[];
  placeholder?: string;
  /** The field's accessible name (C1). */
  label?: string;
  layoutId?: string;
  still?: ComposerStill;
  /** A quiet row above the field (Code: repository, environment, mode). */
  context?: React.ReactNode;
  /** The dock (§2.1): one row attached to the composer's top edge (needs you, a queued message, a goal). */
  dockRow?: React.ReactNode;
  onSend?: (segs: Segment[]) => void;
  apiRef?: React.MutableRefObject<ComposerApi | null>;
  className?: string;
  variant?: "home" | "dock" | "code";
  /** Juno is working: the disc is Stop. */
  busy?: boolean;
  modelLabel?: string;
  effortLabel?: string;
}) {
  const reduced = useReduced();
  const [s, dispatch] = React.useReducer(reducer, undefined, () => ({
    segs: initial,
    query: still?.palette ? still.palette.query : null,
    active: still?.palette?.active ?? 0,
    session: 1,
    fresh: null,
    panel: still?.panel ?? null,
    model: !!still?.model,
    focus: !!still?.focused || !!still?.pointerFocused || !!still?.palette || !!still?.panel,
    kbd: !!still?.focused || !!still?.palette,
    selected: still?.panel ?? null,
  }));
  // Pointer or keyboard: the last input decides whether focus draws the ring (C1).
  const pointerDown = React.useRef(false);

  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const fieldRef = React.useRef<HTMLDivElement | null>(null);
  const caretRef = React.useRef<HTMLSpanElement | null>(null);
  const modelRef = React.useRef<HTMLButtonElement | null>(null);
  const tokenEls = React.useRef(new Map<string, HTMLSpanElement>());
  const register = React.useCallback((id: string, el: HTMLSpanElement | null) => {
    if (el) tokenEls.current.set(id, el);
    else tokenEls.current.delete(id);
  }, []);

  const groups = s.query !== null ? paletteItems(s.query) : [];
  const flat = groups.flatMap((g) => g.items);
  const paletteOpen = s.query !== null && flat.length > 0;

  const choose = React.useCallback((id: string) => dispatch({ type: "choose", id }), []);
  const send = React.useCallback(() => {
    if (!s.segs.length) return;
    onSend?.(s.segs);
  }, [s.segs, onSend]);

  const handleKey = React.useCallback(
    (key: string, prevent?: () => void) => {
      if (paletteOpen && (key === "ArrowDown" || key === "ArrowUp")) {
        prevent?.();
        dispatch({ type: "move", delta: key === "ArrowDown" ? 1 : -1, count: flat.length });
        return;
      }
      if (paletteOpen && (key === "Enter" || key === "Tab")) {
        prevent?.();
        const item = flat[Math.min(s.active, flat.length - 1)];
        if (item) choose(item.token.id);
        return;
      }
      if (key === "Enter") {
        prevent?.();
        send();
        return;
      }
      if (key === "Escape") {
        prevent?.();
        dispatch({ type: "escape" });
        return;
      }
      if (key === "Backspace") {
        prevent?.();
        dispatch({ type: "backspace" });
        return;
      }
      if (key.length === 1) {
        prevent?.();
        dispatch({ type: "char", c: key });
      }
    },
    [paletteOpen, flat, s.active, choose, send],
  );

  // Scripted control: the motion page drives the real composer through this.
  React.useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      focus: (kbd = true) => {
        pointerDown.current = !kbd;
        fieldRef.current?.focus({ preventScroll: true });
        dispatch({ type: "focus", on: true, kbd });
      },
      blur: () => {
        fieldRef.current?.blur();
        dispatch({ type: "focus", on: false });
      },
      type: async (text, perChar = 55) => {
        for (const c of text) {
          dispatch({ type: "char", c });
          await sleep(perChar + (c === " " ? 25 : 0));
        }
      },
      key: (k) => handleKey(k),
      openPanel: (id) => dispatch({ type: "panel", id }),
      openModel: (open) => dispatch({ type: "model", open }),
      send: () => send(),
      reset: (segs) => dispatch({ type: "reset", segs }),
    };
  }, [apiRef, send, handleKey]);

  // A click outside closes the floating layers.
  React.useEffect(() => {
    if (!s.panel && !s.model) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) dispatch({ type: "escape" });
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [s.panel, s.model]);

  /* Anchors: the palette at the caret, the panel at its token, the model list at its control. */
  const [anchor, setAnchor] = React.useState<{
    palette?: React.CSSProperties;
    paletteOrigin?: string;
    panel?: React.CSSProperties;
    panelOrigin?: string;
    panelBelow?: boolean;
    model?: React.CSSProperties;
    modelOrigin?: string;
    modelBelow?: boolean;
  }>({});
  React.useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = wrap.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const next: typeof anchor = {};
    if (paletteOpen && caretRef.current) {
      const c = caretRef.current.getBoundingClientRect();
      const width = Math.min(372, vw - 24);
      let left = c.left - w.left - 20;
      left = Math.max(-4, Math.min(left, w.width - width + 8, vw - 12 - w.left - width));
      const below = vh - c.bottom > 420 || vh - c.bottom > c.top;
      next.palette = below ? { left, top: c.bottom - w.top + 10, width } : { left, bottom: w.bottom - c.top + 10, width };
      next.paletteOrigin = `${c.left - w.left - left}px ${below ? "0%" : "100%"}`;
    }
    if (s.panel) {
      const el = tokenEls.current.get(s.panel);
      if (el) {
        const t = el.getBoundingClientRect();
        const width = Math.min(344, vw - 24);
        let left = t.left - w.left - 8;
        left = Math.max(-4, Math.min(left, vw - 12 - w.left - width));
        const below = vh - t.bottom > 320 || vh - t.bottom > t.top;
        next.panel = below ? { left, top: t.bottom - w.top + 8, width } : { left, bottom: w.bottom - t.top + 8, width };
        next.panelOrigin = `${t.left + 14 - w.left - left}px ${below ? "0%" : "100%"}`;
        next.panelBelow = below;
      }
    }
    if (s.model && modelRef.current) {
      const m = modelRef.current.getBoundingClientRect();
      const below = vh - m.bottom > 440;
      const right = Math.max(-4, w.right - m.right - 60);
      next.model = below ? { right, top: m.bottom - w.top + 8 } : { right, bottom: w.bottom - m.top + 8 };
      next.modelOrigin = `calc(100% - ${m.width / 2 + 60 - (w.right - m.right - right)}px) ${below ? "0%" : "100%"}`;
      next.modelBelow = below;
    }
    setAnchor(next);
    // Recompute whenever something that moves an anchor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, s.panel, s.model, s.segs, s.query]);

  const empty = s.segs.length === 0 && s.query === null;
  const mode: "voice" | "send" | "stop" = busy ? "stop" : s.segs.length ? "send" : "voice";

  return (
    <div ref={wrapRef} className={["jn-composer-wrap", className].filter(Boolean).join(" ")} data-variant={variant}>
      <motion.div
        className="jn-composer"
        layoutId={reduced ? undefined : layoutId}
        transition={T.travel}
        data-focus={s.focus ? "" : undefined}
        data-kbd={s.focus && s.kbd ? "" : undefined}
        data-variant={variant}
        data-dock={dockRow ? "" : undefined}
        onPointerDown={() => {
          pointerDown.current = true;
        }}
        onMouseDown={(e) => {
          // Clicking the composer's body (not a control) puts the caret in the field.
          if ((e.target as HTMLElement).closest("button, a, [role=button]")) return;
          e.preventDefault();
          fieldRef.current?.focus({ preventScroll: true });
        }}
      >
        {dockRow}
        {context ? <div className="jn-composer__context">{context}</div> : null}
        <div
          ref={fieldRef}
          className="jn-field"
          role="textbox"
          aria-multiline="true"
          aria-label={label}
          aria-expanded={paletteOpen}
          aria-controls={paletteOpen ? "jn-palette" : undefined}
          aria-autocomplete="list"
          aria-activedescendant={paletteOpen ? `jn-opt-${flat[Math.min(s.active, flat.length - 1)]?.token.id}` : undefined}
          tabIndex={0}
          onFocus={() => {
            dispatch({ type: "focus", on: true, kbd: !pointerDown.current });
            pointerDown.current = false;
          }}
          onBlur={() => {
            if (!still?.focused && !still?.pointerFocused && !still?.palette && !still?.panel) dispatch({ type: "focus", on: false });
          }}
          onKeyDown={(e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            handleKey(e.key, () => e.preventDefault());
          }}
        >
          {empty ? (
            <div className="jn-field__placeholder">
              {s.focus ? <span ref={caretRef} className="jn-caret" data-at-start="" /> : null}
              <span aria-hidden="true">{placeholder}</span>
            </div>
          ) : (
            <Sentence
              segments={s.segs}
              fresh={s.fresh}
              selected={s.selected}
              register={register}
              onToken={(id) => {
                const t = TOKENS[id];
                if (t.kind === "app") dispatch({ type: "panel", id: s.panel === id ? null : id });
              }}
            >
              {s.query !== null ? <span className="jn-field__query">@{s.query}</span> : null}
              {s.focus ? <span ref={caretRef} className="jn-caret" /> : null}
            </Sentence>
          )}
        </div>
        <div className="jn-crow">
          <button type="button" className="jib jicon-trigger jn-crow__add" aria-label="Add files, photos and more">
            <Icon name="plus" size={20} />
          </button>
          <span className="jn-crow__spacer" />
          <button
            ref={modelRef}
            type="button"
            className="jn-model jicon-trigger"
            aria-haspopup="dialog"
            aria-expanded={s.model}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => dispatch({ type: "model", open: !s.model })}
          >
            <span className="jn-model__name">{modelLabel}</span>
            {effortLabel ? <span className="jn-model__effort">{effortLabel}</span> : null}
            <Icon name="chevron-down" size={16} state={s.model ? "active" : "rest"} />
          </button>
          <button type="button" className="jib jicon-trigger" aria-label="Dictate">
            <Icon name="mic" size={20} />
          </button>
          <button
            type="button"
            className="jn-disc jicon-trigger"
            data-mode={mode}
            aria-label={mode === "stop" ? "Stop response" : mode === "send" ? "Send message" : "Start a voice conversation"}
            onClick={mode === "send" ? send : undefined}
          >
            {/* One disc, three faces (C12, C13, C16). The glyphs overlap and swap in place: opacity with scale 0.8 to 1 on fast. */}
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={mode}
                className="jn-disc__glyph"
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                transition={reduced ? R : T.fast}
              >
                <Icon name={mode === "stop" ? "stop" : mode === "send" ? "send" : "voice"} size={mode === "stop" ? 16 : 20} />
              </motion.span>
            </AnimatePresence>
          </button>
        </div>
      </motion.div>

      <AnimatePresence>
        {paletteOpen ? (
          <Palette
            key={`palette-${s.session}`}
            groups={groups}
            active={s.active}
            session={s.session}
            style={anchor.palette}
            origin={anchor.paletteOrigin}
            onChoose={choose}
            onHover={(index) => dispatch({ type: "hover", index })}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {s.panel ? <AppPanel key={`panel-${s.panel}`} id={s.panel} style={anchor.panel} origin={anchor.panelOrigin} below={anchor.panelBelow} /> : null}
      </AnimatePresence>
      <AnimatePresence>{s.model ? <ModelPopover key="model" style={anchor.model} origin={anchor.modelOrigin} below={anchor.modelBelow} /> : null}</AnimatePresence>
    </div>
  );
}

/* ———————————————————————————— Palette ———————————————————————————— */

export function Palette({
  groups,
  active,
  style,
  onChoose,
  onHover,
  className,
}: {
  groups: { label: string; items: PaletteItem[] }[];
  active: number;
  session?: number;
  style?: React.CSSProperties;
  origin?: string;
  onChoose: (id: string) => void;
  onHover: (i: number) => void;
  className?: string;
}) {
  let index = -1;
  // Keyboard-born (typing "@"), so it opens and closes in the same frame (C7, F0). No fade, no travel.
  return (
    <div
      id="jn-palette"
      className={["jn-pop jn-palette", className].filter(Boolean).join(" ")}
      role="listbox"
      aria-label="Add to your message"
      style={{ ...style, visibility: style ? "visible" : "hidden" }}
    >
      <div className="jn-pop__scroll">
        {groups.map((g) => (
          <div key={g.label} role="group" aria-label={g.label} className="jn-pop__group">
            <div className="jn-pop__label" role="presentation">
              {g.label}
            </div>
            {g.items.map((item) => {
              index += 1;
              const i = index;
              const needs = item.token.kind === "app" && item.token.connected === false;
              return (
                <button
                  key={item.token.id}
                  id={`jn-opt-${item.token.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active ? "" : undefined}
                  className="jn-pop__row"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChoose(item.token.id);
                  }}
                  onMouseEnter={() => onHover(i)}
                >
                  <span className="jn-pop__mark" data-needs={needs ? "" : undefined}>
                    <TokenMark token={item.token} size={18} />
                  </span>
                  <span className="jn-pop__text">{item.token.label}</span>
                  <span className="jn-pop__detail" data-needs={needs ? "" : undefined}>
                    {item.token.detail}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="jn-pop__foot" aria-hidden="true">
        <span>
          <span className="jkbd">↑</span>
          <span className="jkbd">↓</span>
          to move
        </span>
        <span>
          <span className="jkbd">↵</span>
          to add
        </span>
        <span>
          <span className="jkbd">esc</span>
          to close
        </span>
      </div>
    </div>
  );
}

/* ———————————————————————————— Token popover (C10) ———————————————————————————— */

/*
 * A click on a token opens its popover, grown from the token (base, scale 0.96
 * to 1, origin at the token). For an app it resolves connection and approval
 * before send, in words: who it acts as, what it may read, what asks first.
 */
export function AppPanel({ id, style, origin, below = true }: { id: string; style?: React.CSSProperties; origin?: string; below?: boolean }) {
  const reduced = useReduced();
  const app = APPS[id];
  if (!app) return null;
  const reads = app.actions.filter((a) => a.kind === "read" && a.policy !== "off");
  const changes = app.actions.filter((a) => a.kind === "change");
  return (
    <motion.div
      className="jn-pop jn-apppanel"
      role="dialog"
      aria-label={`${app.name}, in this message`}
      style={{ ...style, transformOrigin: origin, visibility: style ? "visible" : "hidden" }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: below ? -4 : 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, transition: reduced ? R : T.exit }}
      transition={reduced ? R : T.base}
    >
      <div className="jn-appanel__head">
        <AppMark id={id} size={24} />
        <div className="jn-appanel__who">
          <span className="jn-appanel__name">{app.name}</span>
          <span className="jn-appanel__acct">{app.connected ? `Connected as ${app.account}` : "Not connected"}</span>
        </div>
      </div>
      {app.connected ? (
        <>
          <ul className="jn-appanel__list">
            {reads.slice(0, 1).map((a) => (
              <li key={a.label} className="jn-appanel__row">
                <span>{a.label}</span>
                <span className="jn-appanel__policy" data-policy={a.policy}>
                  {POLICY_SENTENCE[a.policy]}
                </span>
              </li>
            ))}
            {changes.slice(0, 2).map((a) => (
              <li key={a.label} className="jn-appanel__row">
                <span>{a.label}</span>
                <span className="jn-appanel__policy" data-policy={a.policy}>
                  {POLICY_SENTENCE[a.policy]}
                </span>
              </li>
            ))}
          </ul>
          <div className="jn-appanel__foot">
            <span className="jn-appanel__verbs">
              <button type="button" className="jb jb--ghost jb--sm">
                Open {app.name}
              </button>
              <button type="button" className="jb jb--ghost jb--sm">
                Remove
              </button>
            </span>
            <a className="jb jb--link" href="#customize">
              Change in Customize
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="jn-appanel__lede">Connect {app.name} so Juno can read issues. Creating one will ask you first.</p>
          <div className="jn-appanel__foot">
            <span>Opens {app.name} to sign in</span>
            <button type="button" className="jb jb--primary jb--sm">
              Connect {app.name}
            </button>
          </div>
        </>
      )}
    </motion.div>
  );
}

/* ———————————————————————————— Model popover (MP1–MP3) ———————————————————————————— */

export function ModelPopover({ style, origin, below = true, className }: { style?: React.CSSProperties; origin?: string; below?: boolean; className?: string }) {
  const reduced = useReduced();
  const [effort, setEffort] = React.useState<Effort>("Standard");
  const [chosen, setChosen] = React.useState("auto");
  return (
    <motion.div
      className={["jn-pop jn-modelpop", className].filter(Boolean).join(" ")}
      role="dialog"
      aria-label="Model"
      style={{ ...style, transformOrigin: origin, visibility: style ? "visible" : "hidden" }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: below ? -4 : 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, transition: reduced ? R : T.exit }}
      transition={reduced ? R : T.base}
    >
      <div role="radiogroup" aria-label="Model" className="jn-modelpop__list">
        <button type="button" role="radio" aria-checked={chosen === "auto"} className="jn-pop__row jn-pop__row--tall jicon-trigger" onClick={() => setChosen("auto")}>
          <span className="jn-pop__mark jn-pop__mark--ink">
            <Icon name="auto" size={18} />
          </span>
          <span className="jn-pop__stack">
            <span>Auto</span>
            <span className="jn-pop__line">Picks the right model for each message</span>
          </span>
          <span className="jn-pop__check" aria-hidden="true">
            {chosen === "auto" ? <Icon name="check" size={16} state="active" /> : null}
          </span>
        </button>
        {MODELS.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={chosen === m.id} className="jn-pop__row jn-pop__row--tall" onClick={() => setChosen(m.id)}>
            <span className="jn-pop__mark jn-pop__mark--ink">
              <ModelMark provider={m.provider} className="jn-modelmark" />
            </span>
            <span className="jn-pop__stack">
              <span>{m.name}</span>
              <span className="jn-pop__line">{m.line}</span>
            </span>
            <span className="jn-pop__check" aria-hidden="true">
              {chosen === m.id ? <Icon name="check" size={16} state="active" /> : null}
            </span>
          </button>
        ))}
      </div>
      <div className="jn-pop__sep" />
      <div className="jn-modelpop__effort">
        <div className="jn-modelpop__efforthead">
          <span>Effort</span>
          <span className="ink-3">{EFFORT_LINE[effort]}</span>
        </div>
        <Segmented options={EFFORT} value={effort} onChange={setEffort} label="Effort" className="jn-modelpop__seg" layoutKey="effort" />
      </div>
      <div className="jn-pop__sep" />
      <button type="button" className="jn-pop__row jicon-trigger">
        <span className="jn-pop__text">All models…</span>
        <Icon name="chevron-right" size={16} className="ink-3" />
      </button>
    </motion.div>
  );
}

/* ———————————————————————————— Segmented (MP3, K4) ———————————————————————————— */

/** A segmented control whose thumb moves on the standard spring (instant when reduced). */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
  className,
  layoutKey,
  size = "md",
  labels,
}: {
  options: readonly V[];
  value: V;
  onChange?: (v: V) => void;
  label: string;
  className?: string;
  layoutKey: string;
  size?: "md" | "sm";
  labels?: Partial<Record<V, string>>;
}) {
  const reduced = useReduced();
  const id = React.useId();
  return (
    <span className={["jseg", size === "sm" ? "jseg--sm" : "", className].filter(Boolean).join(" ")} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          className="jseg__opt"
          onClick={() => onChange?.(o)}
          onKeyDown={(e) => {
            const i = options.indexOf(value);
            if (e.key === "ArrowRight") onChange?.(options[Math.min(options.length - 1, i + 1)]);
            if (e.key === "ArrowLeft") onChange?.(options[Math.max(0, i - 1)]);
          }}
        >
          {value === o ? <motion.span className="jseg__thumb" layoutId={`${layoutKey}-${id}`} transition={reduced ? T.instant : SPRING.standard} aria-hidden="true" /> : null}
          <span className="jseg__label">{labels?.[o] ?? o}</span>
        </button>
      ))}
    </span>
  );
}
