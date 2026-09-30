"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, AudioLines, Check, ChevronDown, ChevronRight, Mic, Plus } from "@/components/ui/icons";
import {
  APP_PANEL,
  MODELS,
  PALETTE_GROUPS,
  POLICY_LABEL,
  TOKENS,
  type Segment,
  type TokenRef,
} from "./fixtures";
import { AppMark, ModelMark, TokenMark } from "./marks";
import { Point } from "./point";
import { T, useReduced } from "./motion-pref";

/*
 * The composer (PRODUCT_REFOUNDATION §5): one field and four objects on one
 * row. Context is named IN the sentence: typing "@" opens a palette anchored
 * to the caret; choosing a row inserts a token, an atomic object drawn with
 * the thing's own mark, and the row's mark travels into the chip. An app
 * token opens a panel that grows out of the token and says, in words, what
 * this message may do in that app.
 *
 * The field here is a small controlled model (text runs and tokens, caret at
 * the end) so every state can be rendered and scripted; production uses a
 * contenteditable with atomic token nodes and the same states.
 */

/* ———————————————————————————— Tokens ———————————————————————————— */

export function TokenChip({
  id,
  markLayoutId,
  selected,
  onPress,
  register,
}: {
  id: string;
  /** Set only on the token that was just chosen: its mark arrives from the palette row. */
  markLayoutId?: string;
  selected?: boolean;
  onPress?: (id: string) => void;
  register?: (id: string, el: HTMLSpanElement | null) => void;
}) {
  const token = TOKENS[id];
  const reduced = useReduced();
  const needs = token.kind === "app" && token.connected === false;
  const fresh = !!markLayoutId;
  return (
    <span
      ref={(el) => register?.(id, el)}
      role="button"
      tabIndex={-1}
      aria-label={needs ? `${token.label}, not connected` : token.label}
      className="cv-token"
      data-token={id}
      data-state={needs ? "needs" : undefined}
      data-selected={selected ? "" : undefined}
      data-fresh={fresh && !reduced ? "" : undefined}
      onMouseDown={(e) => {
        e.preventDefault();
        onPress?.(id);
      }}
    >
      <motion.span className="cv-token__mark" layoutId={reduced ? undefined : markLayoutId} transition={T.travel}>
        <TokenMark token={token} />
      </motion.span>
      <motion.span
        initial={fresh ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={reduced ? T.instant : { ...T.fade, delay: fresh ? 0.14 : 0 }}
      >
        {token.label}
      </motion.span>
    </span>
  );
}

/** A sentence of text runs and tokens. The same object in the composer and in the thread. */
export function Sentence({
  segments,
  layoutId,
  fresh,
  selected,
  onToken,
  register,
  children,
}: {
  segments: Segment[];
  layoutId?: string;
  fresh?: { id: string; key: string } | null;
  selected?: string | null;
  onToken?: (id: string) => void;
  register?: (id: string, el: HTMLSpanElement | null) => void;
  children?: React.ReactNode;
}) {
  const reduced = useReduced();
  let freshUsed = false;
  return (
    <motion.div className="cv-sentence" layoutId={layoutId} transition={reduced ? T.instant : T.travel}>
      {segments.map((s, i) => {
        if (s.t === "text") return <React.Fragment key={i}>{s.v}</React.Fragment>;
        const isFresh = !!fresh && fresh.id === s.id && !freshUsed && i === lastTokenIndex(segments);
        if (isFresh) freshUsed = true;
        return (
          <TokenChip
            key={`${s.id}-${i}`}
            id={s.id}
            markLayoutId={isFresh ? fresh?.key : undefined}
            selected={selected === s.id}
            onPress={onToken}
            register={register}
          />
        );
      })}
      {children}
    </motion.div>
  );
}

function lastTokenIndex(segs: Segment[]): number {
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i].t === "token") return i;
  return -1;
}

/* ———————————————————————————— Model ———————————————————————————— */

interface State {
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
  | { type: "focus"; on: boolean }
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
        // First press selects the token (so a token is never deleted by surprise), the second removes it.
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
      return { ...s, focus: a.on };
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
  focus: () => void;
  key: (k: string) => void;
  type: (text: string, perChar?: number) => Promise<void>;
  openPanel: (id: string | null) => void;
  openModel: (open: boolean) => void;
  send: () => void;
  reset: (segs: Segment[]) => void;
}

export interface ComposerStill {
  focused?: boolean;
  palette?: { query: string; active?: number };
  model?: boolean;
  panel?: string;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export function Composer({
  initial = [],
  placeholder = "Ask Juno, or type @ to add a file, app or teammate",
  layoutId,
  sentenceLayoutId,
  still,
  approval,
  onSend,
  apiRef,
  className,
  lead,
  modelLabel = "Auto",
}: {
  lead?: React.ReactNode;
  modelLabel?: string;
  initial?: Segment[];
  placeholder?: string;
  layoutId?: string;
  sentenceLayoutId?: string;
  still?: ComposerStill;
  approval?: React.ReactNode;
  onSend?: (segs: Segment[]) => void;
  apiRef?: React.MutableRefObject<ComposerApi | null>;
  className?: string;
}) {
  const reduced = useReduced();
  const [s, dispatch] = React.useReducer(reducer, undefined, () => ({
    segs: still?.palette ? [...initial, ...([] as Segment[])] : initial,
    query: still?.palette ? still.palette.query : null,
    active: still?.palette?.active ?? 0,
    session: 1,
    fresh: null,
    panel: still?.panel ?? null,
    model: !!still?.model,
    focus: !!still?.focused || !!still?.palette,
    selected: still?.panel ?? null,
  }));

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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (paletteOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      dispatch({ type: "move", delta: e.key === "ArrowDown" ? 1 : -1, count: flat.length });
      return;
    }
    if (paletteOpen && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      const item = flat[Math.min(s.active, flat.length - 1)];
      if (item) choose(item.token.id);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dispatch({ type: "escape" });
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      dispatch({ type: "backspace" });
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      dispatch({ type: "char", c: e.key });
    }
  };

  // Scripted control (the motion page drives the real composer through this).
  React.useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      focus: () => {
        fieldRef.current?.focus();
        dispatch({ type: "focus", on: true });
      },
      key: (k) => fieldRef.current?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })),
      type: async (text, perChar = 55) => {
        for (const c of text) {
          dispatch({ type: "char", c });
          await sleep(perChar + (c === " " ? 25 : 0));
        }
      },
      openPanel: (id) => dispatch({ type: "panel", id }),
      openModel: (open) => dispatch({ type: "model", open }),
      send: () => send(),
      reset: (segs) => dispatch({ type: "reset", segs }),
    };
  }, [apiRef, send]);

  // Click outside closes floating layers.
  React.useEffect(() => {
    if (!s.panel && !s.model) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) dispatch({ type: "escape" });
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [s.panel, s.model]);

  /* Anchors: the palette at the caret, the panel at its token, the model list at its control. */
  const [anchor, setAnchor] = React.useState<{ palette?: React.CSSProperties; paletteOrigin?: string; panel?: React.CSSProperties; panelOrigin?: string; model?: React.CSSProperties; modelOrigin?: string }>({});
  React.useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = wrap.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const next: typeof anchor = {};
    if (paletteOpen && caretRef.current) {
      const c = caretRef.current.getBoundingClientRect();
      const width = Math.min(320, vw - 32);
      let left = c.left - w.left - 16;
      // Stay over the composer: never past its right edge, never off the viewport.
      left = Math.max(-4, Math.min(left, w.width - width + 8, vw - 16 - w.left - width));
      const below = vh - c.bottom > 460 || vh - c.bottom > c.top;
      next.palette = below ? { left, top: c.bottom - w.top + 10 } : { left, bottom: w.bottom - c.top + 10 };
      next.paletteOrigin = `${c.left - w.left - left}px ${below ? "0%" : "100%"}`;
    }
    if (s.panel) {
      const el = tokenEls.current.get(s.panel);
      if (el) {
        const t = el.getBoundingClientRect();
        const width = Math.min(352, vw - 32);
        let left = t.left - w.left - 6;
        left = Math.max(-4, Math.min(left, vw - 16 - w.left - width));
        const below = vh - t.bottom > 300 || vh - t.bottom > t.top;
        next.panel = below ? { left, top: t.bottom - w.top + 8 } : { left, bottom: w.bottom - t.top + 8 };
        next.panelOrigin = `${t.left + t.width / 2 - w.left - left}px ${below ? "0%" : "100%"}`;
      }
    }
    if (s.model && modelRef.current) {
      const m = modelRef.current.getBoundingClientRect();
      const below = vh - m.bottom > 420;
      const right = w.right - m.right - 40;
      next.model = below ? { right, top: m.bottom - w.top + 8 } : { right, bottom: w.bottom - m.top + 8 };
      next.modelOrigin = `calc(100% - 60px) ${below ? "0%" : "100%"}`;
    }
    setAnchor(next);
    // Recompute when anything that moves an anchor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, s.panel, s.model, s.segs, s.query]);

  const empty = s.segs.length === 0 && s.query === null;
  const showCaret = s.focus;

  return (
    <div ref={wrapRef} className={className ? `cv-composer-wrap ${className}` : "cv-composer-wrap"}>
      <motion.div
        className="cv-composer"
        layoutId={layoutId}
        transition={reduced ? T.instant : T.travel}
        data-focus={s.focus ? "" : undefined}
      >
        {approval}
        <div
          ref={fieldRef}
          className="cv-field"
          role="textbox"
          aria-multiline="true"
          aria-label="Message"
          aria-expanded={paletteOpen}
          aria-controls={paletteOpen ? "cv-palette" : undefined}
          tabIndex={0}
          onFocus={() => dispatch({ type: "focus", on: true })}
          onBlur={() => {
            if (!still?.focused && !still?.palette) dispatch({ type: "focus", on: false });
          }}
          onKeyDown={onKeyDown}
        >
          {empty ? (
            <div className="cv-field__placeholder" aria-hidden="true">
              {showCaret ? <span ref={caretRef} className="cv-caret" style={{ marginLeft: 0, marginRight: 1 }} /> : null}
              {placeholder}
            </div>
          ) : (
            <Sentence
              segments={s.segs}
              layoutId={sentenceLayoutId}
              fresh={s.fresh}
              selected={s.selected}
              register={register}
              onToken={(id) => {
                const t = TOKENS[id];
                if (t.kind === "app") dispatch({ type: "panel", id: s.panel === id ? null : id });
              }}
            >
              {s.query !== null ? <span className="cv-field__query">@{s.query}</span> : null}
              {showCaret ? <span ref={caretRef} className="cv-caret" /> : null}
            </Sentence>
          )}
        </div>
        <div className="cv-crow">
          <button type="button" className="cv-ibtn" aria-label="Add files and more">
            <Plus className="cv-i" />
          </button>
          {lead}
          <span className="cv-crow__spacer" />
          <button
            ref={modelRef}
            type="button"
            className="cv-model"
            aria-haspopup="dialog"
            aria-expanded={s.model}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => dispatch({ type: "model", open: !s.model })}
          >
            {modelLabel}
            <ChevronDown className="cv-i-sm" />
          </button>
          <button type="button" className="cv-ibtn" aria-label="Dictate">
            <Mic className="cv-i" />
          </button>
          {s.segs.length ? (
            <button type="button" className="cv-send" aria-label="Send" data-mode="send" onClick={send}>
              <ArrowUp className="cv-i" />
            </button>
          ) : (
            <button type="button" className="cv-send" aria-label="Talk to Juno" data-mode="voice">
              <AudioLines className="cv-i" />
            </button>
          )}
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
        {s.panel ? <AppPanel key={`panel-${s.panel}`} id={s.panel} style={anchor.panel} origin={anchor.panelOrigin} /> : null}
      </AnimatePresence>
      <AnimatePresence>
        {s.model ? <ModelPopover key="model" style={anchor.model} origin={anchor.modelOrigin} /> : null}
      </AnimatePresence>
    </div>
  );
}

/* ———————————————————————————— Palette ———————————————————————————— */

export function Palette({
  groups,
  active,
  session,
  style,
  origin,
  onChoose,
  onHover,
}: {
  groups: { label: string; items: PaletteItem[] }[];
  active: number;
  session: number;
  style?: React.CSSProperties;
  origin?: string;
  onChoose: (id: string) => void;
  onHover: (i: number) => void;
}) {
  const reduced = useReduced();
  let index = -1;
  return (
    <motion.div
      id="cv-palette"
      className="cv-pop cv-palette"
      role="listbox"
      aria-label="Add context"
      style={{ ...style, transformOrigin: origin, visibility: style ? "visible" : "hidden" }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, transition: reduced ? T.instant : T.menuOut }}
      transition={reduced ? T.instant : T.menuIn}
    >
      {groups.map((g) => (
        <div key={g.label} role="group" aria-label={g.label}>
          <div className="cv-pop__label">{g.label}</div>
          {g.items.map((item) => {
            index += 1;
            const i = index;
            return (
              <button
                key={item.token.id}
                type="button"
                role="option"
                aria-selected={i === active}
                data-active={i === active ? "" : undefined}
                className="cv-pop__row"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChoose(item.token.id);
                }}
                onMouseEnter={() => onHover(i)}
              >
                <motion.span className="cv-pop__markwrap" layoutId={reduced ? undefined : `pick-${item.token.id}-${session}`} transition={T.travel}>
                  <TokenMark token={item.token} size={18} />
                </motion.span>
                <span className="cv-pop__text">{item.token.label}</span>
                <span className="cv-pop__detail">{item.token.detail}</span>
              </button>
            );
          })}
        </div>
      ))}
      <div className="cv-pop__foot">
        <span>
          <span className="cv-kbd">↑↓</span>Move
        </span>
        <span>
          <span className="cv-kbd">↵</span>Add
        </span>
        <span>
          <span className="cv-kbd">esc</span>Close
        </span>
      </div>
    </motion.div>
  );
}

/* ———————————————————————————— App panel ———————————————————————————— */

export function AppPanel({ id, style, origin }: { id: string; style?: React.CSSProperties; origin?: string }) {
  const reduced = useReduced();
  const token = TOKENS[id];
  const panel = APP_PANEL[id] ?? { actions: [] };
  const connected = token.connected !== false;
  return (
    <motion.div
      className="cv-panel"
      role="dialog"
      aria-label={`${token.label} in this message`}
      style={{ ...style, transformOrigin: origin, visibility: style ? "visible" : "hidden" }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: reduced ? 1 : 0.97, transition: reduced ? T.instant : T.menuOut }}
      transition={reduced ? T.fade : T.panelIn}
    >
      <div className="cv-panel__head">
        <span className="cv-pop__markwrap">
          <AppMark id={id} className="cv-mark-fill" />
        </span>
        <span className="cv-panel__name">{token.label}</span>
        <span className="cv-panel__status">{connected ? "Connected" : "Not connected"}</span>
      </div>
      {connected ? (
        <>
          <div className="cv-panel__account">{panel.account}</div>
          {panel.actions.map((a) => (
            <div key={a.label} className="cv-panel__row">
              <span className="cv-panel__act">{a.label}</span>
              <span className="cv-panel__policy" data-policy={a.policy}>
                {POLICY_LABEL[a.policy]}
              </span>
            </div>
          ))}
          <div className="cv-panel__foot">
            <span>For this message only</span>
            <a className="cv-link" href="#customize-apps">
              Manage in Customize
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="cv-panel__note">Connect {token.label} so Juno can read issues and, when you allow it, create them.</p>
          <div className="cv-panel__foot">
            <span>Opens {token.label} to sign in</span>
            <button type="button" className="cv-btn cv-btn--primary cv-btn--sm">
              Connect
            </button>
          </div>
        </>
      )}
    </motion.div>
  );
}

/* ———————————————————————————— Model popover ———————————————————————————— */

export function ModelPopover({ style, origin }: { style?: React.CSSProperties; origin?: string }) {
  const reduced = useReduced();
  const [effort, setEffort] = React.useState("Standard");
  return (
    <motion.div
      className="cv-pop cv-model-pop"
      role="dialog"
      aria-label="Model"
      style={{ ...style, transformOrigin: origin, visibility: style ? "visible" : "hidden" }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, transition: reduced ? T.instant : T.menuOut }}
      transition={reduced ? T.instant : T.menuIn}
    >
      <button type="button" className="cv-pop__row cv-pop__row--tall" data-active="">
        <span className="cv-pop__markwrap">
          <Point size={16} />
        </span>
        <span className="cv-pop__stack">
          <span>Auto</span>
          <span className="cv-pop__line">Picks the model for each message</span>
        </span>
        <Check className="cv-i cv-pop__check" />
      </button>
      {MODELS.map((m) => (
        <button key={m.id} type="button" className="cv-pop__row cv-pop__row--tall">
          <span className="cv-pop__markwrap">
            <ModelMark provider={m.provider} />
          </span>
          <span className="cv-pop__stack">
            <span>{m.name}</span>
            <span className="cv-pop__line">{m.line}</span>
          </span>
        </button>
      ))}
      <div className="cv-pop__sep" />
      <div className="cv-pop__section">
        <div className="cv-pop__sectionhead">
          <span>Effort</span>
          <span>{effort === "Deep" ? "Slower, more thorough" : effort === "Light" ? "Fastest" : "Balanced"}</span>
        </div>
        <div className="cv-seg" role="radiogroup" aria-label="Effort">
          {["Light", "Standard", "Deep"].map((e) => (
            <button key={e} type="button" role="radio" aria-checked={effort === e} className="cv-seg__opt" onClick={() => setEffort(e)}>
              {e}
            </button>
          ))}
        </div>
      </div>
      <div className="cv-pop__sep" />
      <button type="button" className="cv-pop__row">
        <span className="cv-pop__text">All models</span>
        <ChevronRight className="cv-i-sm ink-3" />
      </button>
    </motion.div>
  );
}
