"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { ArrowUp, AudioLines, Check, ChevronDown, ChevronRight, Eye, Lock, Mic, Plus, RefreshCw, Square, X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { Face } from "./face";
import { CREW, MODELS, type CrewMember } from "./fixtures";
import { APP_NAME, AppMark, ChatMark, FileMark, Orbit, ProjectMark, type AppId, type FileKind } from "./glyphs";

/* ------------------------------------------------------------------ */
/* Tokens and drafts                                                   */
/* ------------------------------------------------------------------ */

export type Tok =
  | { kind: "file"; id: string; label: string; file: FileKind }
  | { kind: "app"; id: string; label: string; app: AppId; needs?: boolean }
  | { kind: "crew"; id: string; label: string; member: CrewMember }
  | { kind: "project"; id: string; label: string }
  | { kind: "chat"; id: string; label: string };

export type Seg = { t: "text"; v: string } | { t: "token"; tok: Tok };

const mira = CREW[0];
export const TOK: Record<string, Tok> = {
  forecast: { kind: "file", id: "forecast", label: "Q3 Forecast.xlsx", file: "xlsx" },
  notes: { kind: "file", id: "notes", label: "Renewal notes.md", file: "md" },
  stripe: { kind: "app", id: "stripe", label: "Stripe", app: "stripe" },
  slack: { kind: "app", id: "slack", label: "Slack", app: "slack" },
  hubspot: { kind: "app", id: "hubspot", label: "HubSpot", app: "hubspot", needs: true },
  mira: { kind: "crew", id: "mira", label: "Mira", member: mira },
  atlas: { kind: "project", id: "atlas", label: "Atlas launch" },
};

export const DRAFT: Seg[] = [
  { t: "text", v: "Compare " },
  { t: "token", tok: TOK.forecast },
  { t: "text", v: " with " },
  { t: "token", tok: TOK.stripe },
  { t: "text", v: " and ask " },
  { t: "token", tok: TOK.mira },
  { t: "text", v: " to flag renewal risk" },
];

export function TokMark({ tok, size = 16 }: { tok: Tok; size?: number }) {
  switch (tok.kind) {
    case "file":
      return <FileMark kind={tok.file} />;
    case "app":
      return <AppMark app={tok.app} />;
    case "crew":
      return <Face avatar={tok.member.avatar} presence={tok.member.presence} size={size} />;
    case "project":
      return <ProjectMark />;
    case "chat":
      return <ChatMark />;
  }
}

export function Token({
  tok,
  open,
  markLayoutId,
  onClick,
  tokenRef,
}: {
  tok: Tok;
  open?: boolean;
  /** Shared-element id so a palette row's mark can land in the chip. */
  markLayoutId?: string;
  onClick?: () => void;
  tokenRef?: React.Ref<HTMLSpanElement>;
}) {
  const needs = tok.kind === "app" && tok.needs;
  return (
    <span
      ref={tokenRef}
      className="pc-token"
      data-kind={tok.kind}
      data-open={open ? "" : undefined}
      data-needs={needs ? "" : undefined}
      contentEditable={false}
      role="button"
      tabIndex={-1}
      aria-label={`${tok.label}${needs ? ", needs connecting" : ""}`}
      onClick={onClick}
    >
      {markLayoutId ? (
        <motion.span layoutId={markLayoutId} className="inline-flex" transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}>
          <TokMark tok={tok} />
        </motion.span>
      ) : (
        <TokMark tok={tok} />
      )}
      {tok.label}
      {needs ? <span className="pc-token__note">Connect</span> : null}
    </span>
  );
}

export function DraftText({ segs, openToken, onToken }: { segs: Seg[]; openToken?: string; onToken?: (id: string) => void }) {
  return (
    <>
      {segs.map((s, i) =>
        s.t === "text" ? (
          <React.Fragment key={i}>{s.v}</React.Fragment>
        ) : (
          <Token key={i} tok={s.tok} open={openToken === s.tok.id} onClick={onToken ? () => onToken(s.tok.id) : undefined} />
        ),
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The composer                                                        */
/* ------------------------------------------------------------------ */

export interface ComposerProps {
  variant?: "home" | "dock" | "code";
  children?: React.ReactNode;
  placeholder?: string;
  focused?: boolean;
  /** Top row inside the composer (Code: repository, environment, mode). */
  context?: React.ReactNode;
  model?: string;
  modelOpen?: boolean;
  /** Voice when the draft is empty, send when there is something to send. */
  action?: "send" | "voice" | "stop";
  overlay?: React.ReactNode;
  className?: string;
  fieldRef?: React.Ref<HTMLDivElement>;
  onSend?: () => void;
  onModel?: () => void;
  style?: React.CSSProperties;
}

export function Composer({
  variant = "home",
  children,
  placeholder = "Ask anything. Type @ to bring in files, apps and crew",
  focused,
  context,
  model = "Auto",
  modelOpen,
  action = "send",
  overlay,
  className,
  fieldRef,
  onSend,
  onModel,
  style,
}: ComposerProps) {
  const empty = children === undefined || children === null || children === false;
  return (
    <div
      className={cn("pc-composer", `pc-composer--${variant}`, className)}
      data-focus={focused ? "" : undefined}
      style={style}
    >
      {context ? <div className="pc-composer__ctx">{context}</div> : null}
      <div ref={fieldRef} className="pc-composer__field" role="textbox" aria-multiline="true" aria-label="Message" tabIndex={0}>
        {empty ? <span className="pc-composer__placeholder">{placeholder}</span> : children}
      </div>
      <div className="pc-composer__bar">
        <button type="button" className="pc-icon-btn" aria-label="Add files, photos and more">
          <Plus />
        </button>
        <span className="pc-spacer" />
        <button type="button" className="pc-model" data-open={modelOpen ? "" : undefined} aria-haspopup="menu" aria-expanded={!!modelOpen} onClick={onModel}>
          {model}
          <ChevronDown />
        </button>
        <button type="button" className="pc-icon-btn" aria-label="Dictate">
          <Mic />
        </button>
        {action === "send" ? (
          <button type="button" className="pc-send" aria-label="Send" onClick={onSend}>
            <ArrowUp />
          </button>
        ) : action === "stop" ? (
          <button type="button" className="pc-send" aria-label="Stop">
            <Square className="!size-3.5" />
          </button>
        ) : (
          <button type="button" className="pc-send" aria-label="Talk to Juno">
            <AudioLines />
          </button>
        )}
      </div>
      {overlay}
    </div>
  );
}

/** Keep a floating layer of `w` px inside a box `boxW` px wide. */
export function clampLeft(left: number, w: number, boxW: number) {
  return Math.max(8, Math.min(left, boxW - w - 8));
}

/** A caret that measures where it is, so a palette can anchor to it. */
export function useCaretAnchor(deps: React.DependencyList) {
  const caretRef = React.useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number; width: number } | null>(null);
  React.useLayoutEffect(() => {
    const c = caretRef.current;
    const box = c?.closest(".pc-composer") as HTMLElement | null;
    if (!c || !box) return;
    const a = c.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    setPos({ left: a.left - b.left, top: a.bottom - b.top, width: b.width });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { caretRef, pos };
}

export function Caret({ caretRef, blink = true }: { caretRef?: React.Ref<HTMLSpanElement>; blink?: boolean }) {
  return <span ref={caretRef} className="pc-caret" data-blink={blink ? "" : undefined} aria-hidden />;
}

/* ------------------------------------------------------------------ */
/* The @ palette                                                       */
/* ------------------------------------------------------------------ */

export interface PaletteItem {
  key: string;
  section: "Crew" | "Files" | "Projects" | "Apps" | "Chats";
  tok: Tok;
  meta: string;
}

export const PALETTE_ITEMS: PaletteItem[] = [
  { key: "mira", section: "Crew", tok: TOK.mira, meta: "Accounts" },
  { key: "scout", section: "Crew", tok: { kind: "crew", id: "scout", label: "Scout", member: CREW[1] }, meta: "Research" },
  { key: "forecast", section: "Files", tok: TOK.forecast, meta: "Edited today" },
  { key: "notes", section: "Files", tok: TOK.notes, meta: "In Renewals Q3" },
  { key: "atlas", section: "Projects", tok: TOK.atlas, meta: "12 chats" },
  { key: "stripe", section: "Apps", tok: TOK.stripe, meta: "Connected" },
  { key: "slack", section: "Apps", tok: TOK.slack, meta: "Connected" },
  { key: "hubspot", section: "Apps", tok: TOK.hubspot, meta: "Not connected" },
  { key: "chat", section: "Chats", tok: { kind: "chat", id: "chat", label: "Pricing page copy, second pass" }, meta: "Yesterday" },
];

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <span className="pc-q">
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </span>
  );
}

export function AtPalette({
  query = "",
  active = 0,
  style,
  items = PALETTE_ITEMS,
  markLayoutPrefix,
  className,
}: {
  query?: string;
  active?: number;
  style?: React.CSSProperties;
  items?: PaletteItem[];
  /** When set, each row's mark carries a layoutId so it can land in the sentence. */
  markLayoutPrefix?: string;
  className?: string;
}) {
  const shown = query ? items.filter((it) => it.tok.label.toLowerCase().includes(query.toLowerCase())) : items;
  const sections = Array.from(new Set(shown.map((s) => s.section)));
  let idx = -1;
  return (
    <div className={cn("pc-pop", className)} style={{ width: 340, ...style }} role="listbox" aria-label="Add context">
      {sections.map((sec) => (
        <div key={sec} role="group" aria-label={sec}>
          <div className="pc-pop__label">{sec}</div>
          {shown
            .filter((s) => s.section === sec)
            .map((it) => {
              idx += 1;
              const isActive = idx === active;
              return (
                <div key={it.key} className="pc-opt" role="option" aria-selected={isActive} data-active={isActive ? "" : undefined}>
                  {markLayoutPrefix ? (
                    <motion.span layoutId={`${markLayoutPrefix}-${it.key}`} className="inline-flex" transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}>
                      <TokMark tok={it.tok} size={18} />
                    </motion.span>
                  ) : (
                    <TokMark tok={it.tok} size={18} />
                  )}
                  <span className="pc-opt__name">
                    <Highlight text={it.tok.label} q={query} />
                  </span>
                  <span className="pc-opt__meta">{it.meta}</span>
                </div>
              );
            })}
        </div>
      ))}
      <div className="pc-pop__foot">
        <span>
          <span className="pc-kbd">↑↓</span>move
        </span>
        <span>
          <span className="pc-kbd">↵</span>add
        </span>
        <span>
          <span className="pc-kbd">esc</span>close
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The model popover                                                   */
/* ------------------------------------------------------------------ */

export function ModelMenu({
  selected = "auto",
  hover,
  effort = "Standard",
  style,
  className,
}: {
  selected?: string;
  /** The row under the pointer or keyboard; defaults to the selected one. */
  hover?: string;
  effort?: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  const active = hover ?? selected;
  return (
    <div className={cn("pc-pop", className)} style={{ width: 320, ...style }} role="menu" aria-label="Model">
      {MODELS.map((m) => (
        <div key={m.id} className="pc-opt pc-opt--two" role="menuitemradio" aria-checked={m.id === selected} data-active={m.id === active ? "" : undefined}>
          {m.provider === "juno" ? <Orbit size={18} /> : <ProviderLogo provider={m.provider} className="size-[18px] pc-provider" />}
          <span className="flex min-w-0 flex-col">
            <span className="pc-opt__name">{m.name}</span>
            <span className="pc-opt__line">{m.line}</span>
          </span>
          {m.id === selected ? <Check className="pc-opt__check" /> : null}
        </div>
      ))}
      <div className="pc-pop__sep" />
      <div className="flex items-center justify-between px-2.5 py-1.5">
        <span className="pc-small pc-muted">Effort</span>
        <div className="pc-seg" role="radiogroup" aria-label="Effort">
          {["Light", "Standard", "Deep"].map((e) => (
            <button key={e} type="button" aria-pressed={e === effort}>
              {e}
            </button>
          ))}
        </div>
      </div>
      <div className="pc-pop__sep" />
      <div className="pc-opt" role="menuitem">
        <span className="pc-opt__name pc-muted">All models</span>
        <ChevronRight className="pc-opt__check pc-quiet" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The token panel: an app's page, opened from the token itself         */
/* ------------------------------------------------------------------ */

export function TokenPanel({ app, style, className }: { app: AppId; style?: React.CSSProperties; className?: string }) {
  const needs = app === "hubspot";
  return (
    <div className={cn("pc-pop pc-panel", className)} style={style} role="dialog" aria-label={`${APP_NAME[app]} in this message`}>
      <div className="pc-panel__head">
        <AppMark app={app} />
        <div className="min-w-0">
          <div className="pc-ui-m">{APP_NAME[app]}</div>
          <div className="pc-small pc-quiet">{needs ? "Not connected" : "Connected as Northwind Finance"}</div>
        </div>
      </div>
      {needs ? (
        <>
          <p className="pc-small pc-muted mt-3">Connect HubSpot so Juno can read deals and renewal dates for this message.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="pc-btn pc-btn--primary">
              Connect HubSpot
            </button>
            <button type="button" className="pc-btn pc-btn--ghost">
              Remove
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="pc-panel__rows">
            <div className="pc-panel__row">
              <Eye />
              Reads subscriptions, invoices and customers
            </div>
            <div className="pc-panel__row">
              <Lock />
              Changes nothing without asking you
            </div>
          </div>
          <div className="pc-panel__actions">
            <button type="button" className="pc-btn pc-btn--ghost">
              <RefreshCw />
              Switch account
            </button>
            <button type="button" className="pc-btn pc-btn--ghost">
              <X />
              Remove
            </button>
          </div>
        </>
      )}
    </div>
  );
}
