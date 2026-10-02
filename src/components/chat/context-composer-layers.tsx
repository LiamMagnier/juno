"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { AtSign, CornerDownLeft, ArrowDown, ArrowUp } from "@/components/ui/icons";
import { AGENT_NOUN, FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";
import type { ContextToken, ContextTokenKind } from "@/lib/chat/context-tokens";
import type { LayerPlacement } from "@/lib/chat/composer-layer-placement";
import type { MentionItem } from "@/lib/mentions/types";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { ContextTokenMark, contextKindWord, type ContextMarkSource } from "./context-token-mark";

/*
 * THE TWO LAYERS THE CONTEXT FIELD OPENS: the @ palette (INTERACTION_SPEC C7)
 * and a token's popover (C10). Presentational only: the field owns the
 * lookup, the keys and the DOM; these draw rows and verbs on the shared
 * floating material (`.surface-float`, D-033) in the composer's layer recipe
 * (composer.css). Both are portalled to the body at a fixed position that
 * `placeComposerLayer` computed outside the composer's box, so neither can
 * cover the words being written or the composer's own buttons.
 */

/** Group headings, in the order the search returns kinds (who, then what, then where). */
export const MENTION_GROUP_LABELS: Record<ContextTokenKind, string> = {
  crew: AGENT_NOUN.pluralLabel,
  file: "Files",
  project: "Projects",
  app: FEATURE_NAMES.apps.label,
  skill: FEATURE_NAMES.skills.label,
  chat: "Chats",
  artifact: FEATURE_NAMES.artifacts.label,
};

export function markSource(token: Pick<ContextToken, "kind" | "id" | "meta">, item?: MentionItem): ContextMarkSource {
  return {
    kind: token.kind,
    id: token.id,
    icon: item?.icon ?? token.meta?.icon,
    avatar: item?.avatar,
    connectorId: item?.connectorId,
  };
}

/** "Today", "Yesterday", "Monday", "12 Sep": how recent a file or chat is, in the palette's second ink. */
function when(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(at)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return at.toLocaleDateString(undefined, { weekday: "long" });
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The palette row's second line: what the thing is, in words. */
export function mentionDetail(item: MentionItem): string | undefined {
  if (item.kind === "app") return item.needsConnection ? "Not connected" : item.subtitle;
  if (item.kind === "crew") return [item.subtitle, item.paused ? "paused" : undefined].filter(Boolean).join(", ") || undefined;
  if (item.kind === "file" || item.kind === "chat") {
    const recent = when(item.updatedAt);
    return [item.subtitle, recent].filter(Boolean).join(", ") || undefined;
  }
  if (item.kind === "artifact") return contextKindWord("artifact", item.icon);
  return item.subtitle;
}

/** The name a screen reader hears for a token: "Mira, agent"; "GitHub, app, not connected". */
export function tokenAccessibleName(token: Pick<ContextToken, "kind" | "label" | "meta">, item?: MentionItem): string {
  const kind = contextKindWord(token.kind, item?.icon ?? token.meta?.icon);
  return item?.needsConnection ? `${token.label}, ${kind}, not connected` : `${token.label}, ${kind}`;
}

function placementStyle(placement: LayerPlacement | null): React.CSSProperties {
  if (!placement) return { visibility: "hidden", left: 0, top: 0 };
  return {
    left: placement.left,
    width: placement.width,
    maxHeight: placement.maxHeight,
    transformOrigin: placement.origin,
    ...(placement.side === "below" ? { top: placement.top } : { bottom: placement.bottom }),
  };
}

function useBody(): HTMLElement | null {
  const [body, setBody] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => setBody(document.body), []);
  return body;
}

/* ———————————————————————————— The @ palette (C7) ———————————————————————————— */

export type PaletteStatus =
  | { kind: "none" }
  | { kind: "searching" }
  | { kind: "empty"; query: string }
  | { kind: "failed"; message: string; retry?: () => void }
  | { kind: "limit"; message: string };

export function MentionPalette({
  id,
  items,
  active,
  status,
  placement,
  onChoose,
  onHover,
}: {
  id: string;
  items: MentionItem[];
  active: number;
  status: PaletteStatus;
  placement: LayerPlacement | null;
  onChoose: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  const body = useBody();
  const listRef = React.useRef<HTMLDivElement | null>(null);
  // Keyboard moves keep the highlighted row in view; a hovered row never scrolls the list.
  const lastActive = React.useRef(active);
  React.useEffect(() => {
    if (lastActive.current === active) return;
    lastActive.current = active;
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, id]);
  if (!body) return null;

  const groups: Array<{ kind: ContextTokenKind; rows: Array<{ item: MentionItem; index: number }> }> = [];
  items.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (last?.kind === item.kind) last.rows.push({ item, index });
    else groups.push({ kind: item.kind, rows: [{ item, index }] });
  });

  return createPortal(
    // Keyboard-born (typing "@"): it appears in the same frame and leaves in the
    // same frame (F0). No fade, no travel.
    <div
      className="composer-layer composer-layer--palette surface-float"
      data-side={placement?.side}
      data-composer-layer=""
      style={placementStyle(placement)}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div ref={listRef} id={id} role="listbox" aria-label="Add to your message" className="composer-layer__scroll">
        {groups.map((group) => (
          <div key={group.kind} role="group" aria-label={MENTION_GROUP_LABELS[group.kind]} className="composer-layer__group">
            <div className="composer-layer__label" role="presentation">
              {MENTION_GROUP_LABELS[group.kind]}
            </div>
            {group.rows.map(({ item, index }) => {
              const detail = mentionDetail(item);
              return (
                <div
                  key={`${item.kind}:${item.id}`}
                  id={`${id}-opt-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className="composer-layer__row"
                  onMouseMove={() => {
                    if (index !== active) onHover(index);
                  }}
                  onClick={() => onChoose(item)}
                >
                  <span className="composer-layer__mark" data-needs={item.needsConnection ? "" : undefined}>
                    <ContextTokenMark source={markSource({ kind: item.kind, id: item.id, meta: { icon: item.icon } }, item)} size={20} />
                  </span>
                  <span className="composer-layer__name">
                    {item.label}
                    {/* The kind, for a screen reader: the group heading is presentation only. */}
                    <span className="sr-only">{`, ${contextKindWord(item.kind, item.icon)}`}</span>
                  </span>
                  {detail ? <span className="composer-layer__detail">{detail}</span> : null}
                </div>
              );
            })}
          </div>
        ))}
        {status.kind !== "none" ? (
          <div className="composer-layer__status" role="status">
            {status.kind === "searching" ? (
              "Searching…"
            ) : status.kind === "empty" ? (
              status.query ? `Nothing called “${status.query}” yet` : "Nothing to add yet"
            ) : status.kind === "limit" ? (
              status.message
            ) : (
              <>
                {status.message}
                {status.retry ? (
                  <>
                    {" "}
                    <button type="button" className="composer-layer__retry" onClick={status.retry}>
                      Try again
                    </button>
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
      {items.length > 0 ? (
        <div className="composer-layer__foot" aria-hidden="true">
          <span>
            <span className="composer-layer__key composer-layer__key--glyph">
              <ArrowUp className="size-3.5" motion="none" />
            </span>
            <span className="composer-layer__key composer-layer__key--glyph">
              <ArrowDown className="size-3.5" motion="none" />
            </span>
            to move
          </span>
          <span>
            <span className="composer-layer__key composer-layer__key--glyph">
              <CornerDownLeft className="size-3.5" motion="none" />
            </span>
            to add
          </span>
          <span>
            <span className="composer-layer__key">esc</span>
            to close
          </span>
        </div>
      ) : null}
    </div>,
    body,
  );
}

/* ———————————————————————————— A token's popover (C10) ———————————————————————————— */

/** Where "Open" goes for a kind that has a page of its own. Files and made things have no per-item page yet, so they get no Open. */
export function tokenHref(token: Pick<ContextToken, "kind" | "id">, item?: MentionItem): string | null {
  switch (token.kind) {
    case "crew":
      return `/agents/${encodeURIComponent(token.id)}`;
    case "project":
      return `/projects/${encodeURIComponent(token.id)}`;
    case "chat":
      return `/chat/${encodeURIComponent(token.id)}`;
    case "app":
      return "/connections";
    case "skill":
      return item?.slug ? `/skills?skill=${encodeURIComponent(item.slug)}` : "/skills";
    default:
      return null;
  }
}

/**
 * What using the token does with this message, in one sentence, from what the
 * server's resolver actually does with each kind (src/lib/chat/context-resolution.ts).
 */
export function tokenLede(token: Pick<ContextToken, "kind" | "label">, item?: MentionItem): string {
  switch (token.kind) {
    case "app":
      if (item?.needsConnection) return `Connect ${token.label} so ${PRODUCT_NAME} can use it in this message.`;
      return item?.approval?.summary ?? `${PRODUCT_NAME} can use ${token.label} for this message.`;
    case "file":
      return "Attached to this message from your Library.";
    case "project":
      return "Its instructions and files inform this reply. This chat stays where it is.";
    case "crew":
      return `${token.label}’s role and instructions inform this reply.`;
    case "skill":
      return "This message runs under this skill.";
    case "chat":
      return "A short excerpt of that chat comes along as context.";
    case "artifact":
      return "Its current version comes along as context.";
  }
}

export function TokenPopover({
  token,
  item,
  placement,
  openedBy,
  onRemove,
  onClose,
}: {
  token: ContextToken;
  item?: MentionItem;
  placement: LayerPlacement | null;
  openedBy: "keyboard" | "pointer";
  onRemove: () => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const body = useBody();
  const reduce = useReducedMotion() ?? false;
  const ref = React.useRef<HTMLDivElement | null>(null);
  const nameId = React.useId();
  const href = tokenHref(token, item);
  const kind = contextKindWord(token.kind, item?.icon ?? token.meta?.icon);
  const line =
    token.kind === "app"
      ? item?.needsConnection
        ? "Not connected"
        : item?.subtitle ?? "App"
      : [kind.charAt(0).toUpperCase() + kind.slice(1), token.kind === "crew" || token.kind === "file" ? item?.subtitle : undefined]
          .filter(Boolean)
          .join(" · ");

  // Focus moves to the first verb (C10), so Esc and Tab work from the keyboard;
  // a pointer-opened popover takes focus too, which is what lets Esc close it.
  React.useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("[data-popover-verb]");
    first?.focus({ preventScroll: true });
  }, []);

  React.useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      // A press on a token reopens it from the field; anything else closes.
      onClose(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [onClose]);

  if (!body) return null;
  const pop = openedBy === "keyboard";
  return createPortal(
    <motion.div
      ref={ref}
      role="dialog"
      aria-labelledby={nameId}
      className="composer-layer composer-layer--popover surface-float"
      data-side={placement?.side}
      data-composer-layer=""
      data-opened-by={openedBy}
      style={placementStyle(placement)}
      initial={pop ? false : reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: placement?.side === "above" ? 4 : -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, transition: transition.exit }}
      transition={transition.base}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        }
      }}
    >
      <div className="composer-popover__head">
        <span className={cn("composer-popover__mark", item?.needsConnection && "opacity-40")}>
          <ContextTokenMark source={markSource(token, item)} size={24} />
        </span>
        <span className="composer-popover__who">
          <span id={nameId} className="composer-popover__name">
            {token.label}
          </span>
          {line ? <span className="composer-popover__line">{line}</span> : null}
        </span>
      </div>
      <p className="composer-popover__lede">{tokenLede(token, item)}</p>
      <div className="composer-popover__foot">
        {/* "Remove from message", never a bare "Remove": the file stays in the
            Library and the app stays connected; only this message lets go of it. */}
        <button
          type="button"
          data-popover-verb=""
          className="composer-popover__verb"
          aria-label={`Remove ${token.label} from this message`}
          onClick={onRemove}
        >
          Remove from message
        </button>
        {href && !(token.kind === "app" && item?.needsConnection) ? (
          <a data-popover-verb="" className="composer-popover__verb" href={href}>
            {token.kind === "app" ? `Manage ${token.label}` : `Open ${token.kind === "chat" ? "chat" : token.label}`}
          </a>
        ) : null}
        {token.kind === "app" && item?.needsConnection && item.connectHref ? (
          <a data-popover-verb="" className="composer-popover__verb composer-popover__verb--strong" href={item.connectHref}>
            {`Connect ${token.label}`}
          </a>
        ) : null}
      </div>
    </motion.div>,
    body,
  );
}

/** The + menu's "Mention" row glyph, re-exported so the composer draws the same @ the palette teaches. */
export const MentionGlyph = AtSign;
