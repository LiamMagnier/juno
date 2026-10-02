"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, useReducedMotion } from "framer-motion";
import { MAX_CONTEXT_TOKENS, contextTokenKey, type ContextToken } from "@/lib/chat/context-tokens";
import {
  CONTEXT_CLIPBOARD_TYPE,
  parseClipboardDraft,
  serializeClipboardDraft,
  tokensForText,
  type ContextDraft,
} from "@/lib/chat/context-draft";
import { placeComposerLayer, type LayerPlacement, type LayerSide } from "@/lib/chat/composer-layer-placement";
import { mentionToToken, type MentionItem, type MentionSearchResult } from "@/lib/mentions/types";
import { TIMING } from "@/lib/interaction";
import { duration } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  draftHtml,
  editCommand,
  editorOffset,
  editorRange,
  makeTokenElement,
  readEditor,
  selectNode,
  setEditorSelection,
  tokenElements,
  tokenOf,
  tokenSpan,
} from "./context-editor-dom";
import { MentionPalette, TokenPopover, markSource, tokenAccessibleName, type PaletteStatus } from "./context-composer-layers";
import { ContextTokenMark } from "./context-token-mark";
import { uiPref } from "@/lib/ui-prefs";

/*
 * THE COMPOSER'S FIELD: a contenteditable sentence with context tokens in it
 * (INTERACTION_SPEC C7-C10, signature S1).
 *
 * The DOM owns typing, the caret, IME and undo; this component owns the @
 * palette, a token's popover and the bridge to the composer, which still talks
 * to it as if it were a textarea (`value`, `selectionStart`,
 * `setSelectionRange`, `onChange`) plus `setDraft` / `getDraft` for the
 * changes that carry tokens (a restored draft, a slash skill's remainder).
 *
 * Edits a person can undo go through the browser's editing commands, so ⌘Z
 * after choosing a token, removing one or pasting some gives them back with
 * their data (C9). A token's element carries its data as JSON and an empty
 * mark slot that React fills with the thing's own mark; the mark is drawn
 * from a session cache of what the lookup returned, refreshed by id for a
 * token that arrives without it (a restored draft, a paste from another chat).
 */

/** What the composer holds: a textarea's surface, plus the draft with its tokens. */
export type ContextFieldElement = HTMLTextAreaElement & {
  setDraft: (draft: ContextDraft, options?: { focus?: boolean }) => void;
  getDraft: () => ContextDraft;
  /** Type "@" at the caret and open the palette (the + menu's "Mention" row). */
  openMention: () => void;
};

type Props = Omit<React.ComponentPropsWithoutRef<"textarea">, "value"> & {
  value: string;
  conversationId: string | null;
  onTokensChange: (tokens: ContextToken[]) => void;
  privateMode?: boolean;
  /** No @ lookup at all (a live voice call, an image model). */
  mentionsDisabled?: boolean;
  /** The composer surface: every layer opens outside this box. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Which side of the composer the layers prefer (below on the home, above in the dock). */
  layerSide?: LayerSide;
  /** A layer opened (with its side) or closed, so the home can move its suggestions aside. */
  onLayerChange?: (side: LayerSide | null) => void;
  /** Dev galleries exercise the real field with labelled fixtures; production uses GET /api/mentions. */
  loadMentions?: (query: string, signal: AbortSignal) => Promise<MentionSearchResult>;
};

/* ———————————————————————————— Session caches ———————————————————————————— */

/** Every row a lookup returned, by token key: what a token's mark and popover are drawn from, across remounts. */
const itemCache = new Map<string, MentionItem>();
/** Token keys already asked for by id, so a token the server no longer knows is not asked for again. */
const refreshed = new Set<string>();
/** Recent lookups by conversation and query, so "@" opens with rows in the same frame. */
const lookupCache = new Map<string, { at: number; items: MentionItem[] }>();
const LOOKUP_TTL_MS = 60_000;
const LOOKUP_CACHE_MAX = 40;

function cacheLookup(key: string, items: MentionItem[]) {
  lookupCache.delete(key);
  lookupCache.set(key, { at: Date.now(), items });
  while (lookupCache.size > LOOKUP_CACHE_MAX) lookupCache.delete(lookupCache.keys().next().value!);
  for (const item of items) itemCache.set(contextTokenKey(item), item);
}

function cachedLookup(key: string): MentionItem[] | null {
  const hit = lookupCache.get(key);
  return hit && Date.now() - hit.at < LOOKUP_TTL_MS ? hit.items : null;
}

/** Teach the field a row it did not look up itself (a home suggestion), so its token is drawn with its mark. */
export function rememberContextItem(item: MentionItem) {
  itemCache.set(contextTokenKey(item), item);
}

/** The row a token was drawn from, when this session has seen it. */
export function contextItemFor(token: Pick<ContextToken, "kind" | "id">): MentionItem | undefined {
  return itemCache.get(contextTokenKey(token));
}

const PALETTE_WIDTH = 372;
const PALETTE_NEED = 320;
const POPOVER_WIDTH = 344;
const POPOVER_NEED = 200;
/** Rows a PageUp / PageDown jumps (C7). */
const PAGE_ROWS = 8;

async function fetchMentions(params: URLSearchParams, signal: AbortSignal): Promise<MentionSearchResult> {
  const response = await fetch(`/api/mentions?${params}`, { signal });
  if (response.status === 401) throw new Error("Sign in to add your files, apps and agents.");
  if (response.status === 429) throw new Error("Too many lookups. Try again in a moment.");
  if (!response.ok) throw new Error("Couldn’t search your files, apps and agents.");
  return (await response.json()) as MentionSearchResult;
}

export const ContextComposerField = React.forwardRef<HTMLTextAreaElement, Props>(function ContextComposerField(
  {
    value,
    conversationId,
    onTokensChange,
    privateMode,
    mentionsDisabled,
    anchorRef,
    layerSide = "above",
    onLayerChange,
    loadMentions,
    onChange,
    onKeyDown,
    onPaste,
    onSelect,
    onScroll,
    onFocus,
    onBlur,
    className,
    disabled,
    placeholder,
    style,
    id,
    "aria-label": label,
    ...aria
  },
  forwardedRef,
) {
  const reduce = useReducedMotion() ?? false;
  const rootRef = React.useRef<HTMLDivElement>(null);
  const composing = React.useRef(false);
  const lastReported = React.useRef<string | null>(null);
  const tokensRef = React.useRef<ContextToken[]>([]);
  const selectedToken = React.useRef<HTMLElement | null>(null);
  const paletteId = React.useId().replace(/:/g, "");
  const lookupEnabled = !privateMode && !mentionsDisabled;

  /* ——— The @ query at the caret ——— */
  const [query, setQuery] = React.useState<{ text: string; start: number; end: number } | null>(null);
  /** Esc leaves "@query" as text: the palette stays shut for that "@" until the caret leaves it. */
  const dismissedAt = React.useRef<number | null>(null);
  const [items, setItems] = React.useState<MentionItem[]>([]);
  const [active, setActive] = React.useState(0);
  const activeRef = React.useRef(0);
  activeRef.current = active;
  const [pending, setPending] = React.useState(false);
  const [pendingShown, setPendingShown] = React.useState(false);
  const [failure, setFailure] = React.useState<{ message: string; retry?: () => void } | null>(null);
  const [limitHit, setLimitHit] = React.useState(false);
  const [answered, setAnswered] = React.useState<string | null>(null);
  const [retryCount, setRetryCount] = React.useState(0);

  /* ——— Marks: the React-drawn mark inside each token element ——— */
  const [markTargets, setMarkTargets] = React.useState<HTMLElement[]>([]);
  const owned = React.useRef(new WeakSet<HTMLElement>());
  const [tokenKeys, setTokenKeys] = React.useState("");
  const [, setMetaVersion] = React.useState(0);

  /* ——— A token's popover ——— */
  const [popover, setPopover] = React.useState<{ node: HTMLElement; token: ContextToken; openedBy: "keyboard" | "pointer" } | null>(null);
  const [placement, setPlacement] = React.useState<{ palette: LayerPlacement | null; popover: LayerPlacement | null }>({
    palette: null,
    popover: null,
  });

  const selectToken = React.useCallback((node: HTMLElement | null) => {
    selectedToken.current?.removeAttribute("data-selected");
    selectedToken.current = node;
    node?.setAttribute("data-selected", "");
  }, []);

  const syncTokenNodes = React.useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const targets: HTMLElement[] = [];
    const keys: string[] = [];
    for (const node of tokenElements(root)) {
      const token = tokenOf(node);
      if (!token) continue;
      keys.push(contextTokenKey(token));
      const item = itemCache.get(contextTokenKey(token));
      const name = tokenAccessibleName(token, item);
      if (node.getAttribute("aria-label") !== name) node.setAttribute("aria-label", name);
      node.toggleAttribute("data-needs", !!item?.needsConnection);
      const mark = node.querySelector<HTMLElement>(".context-token-mark");
      if (!mark) continue;
      // A mark slot the browser restored (undo, a native drag) holds a static
      // copy of what React drew there before; clear it so React draws it once.
      if (!owned.current.has(mark)) {
        mark.replaceChildren();
        owned.current.add(mark);
      }
      targets.push(mark);
    }
    setMarkTargets((prev) => (prev.length === targets.length && prev.every((el, i) => el === targets[i]) ? prev : targets));
    setTokenKeys(keys.join(","));
  }, []);

  const inspectSelection = React.useCallback(() => {
    const root = rootRef.current;
    if (!root || composing.current) return;
    const selection = window.getSelection();
    if (!selection?.isCollapsed || !selection.anchorNode || !root.contains(selection.anchorNode)) {
      setQuery(null);
      return;
    }
    const at = editorOffset(root, selection.anchorNode, selection.anchorOffset);
    const before = readEditor(root).text.slice(0, at);
    // "@" starts a word: after the start, whitespace or an opening bracket, never after a letter (C7).
    const fragment = /(?:^|[\s([{])@([^\s@]{0,100})$/.exec(before);
    if (!fragment || !lookupEnabled) {
      dismissedAt.current = null;
      setQuery(null);
      return;
    }
    const start = at - fragment[1].length - 1;
    if (dismissedAt.current === start) {
      setQuery(null);
      return;
    }
    dismissedAt.current = null;
    setLimitHit(false);
    setQuery((prev) => (prev && prev.start === start && prev.end === at && prev.text === fragment[1] ? prev : { text: fragment[1], start, end: at }));
  }, [lookupEnabled]);

  const publish = React.useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    let result = readEditor(root);
    // An emptied contenteditable keeps a stray <br>; clear it so the placeholder returns.
    if (!result.text && root.childNodes.length) {
      root.replaceChildren();
      result = { text: "", tokens: [] };
    }
    tokensRef.current = result.tokens;
    syncTokenNodes();
    lastReported.current = result.text;
    onTokensChange(result.tokens);
    const selection = window.getSelection();
    onChange?.({
      target: { value: result.text, selectionStart: editorOffset(root, selection?.anchorNode ?? null, selection?.anchorOffset ?? 0) },
      currentTarget: root,
    } as unknown as React.ChangeEvent<HTMLTextAreaElement>);
    inspectSelection();
  }, [inspectSelection, onChange, onTokensChange, syncTokenNodes]);

  /** Replace the whole field with a draft (not an undoable edit: a restore, a send, a slash skill's remainder). */
  const writeDraft = React.useCallback((draft: ContextDraft) => {
    const root = rootRef.current;
    if (!root) return [] as ContextToken[];
    const tokens = tokensForText(draft.text, draft.tokens);
    root.replaceChildren();
    if (draft.text) {
      const template = document.createElement("template");
      template.innerHTML = draftHtml(document, { text: draft.text, tokens }, (token) => tokenAccessibleName(token, itemCache.get(contextTokenKey(token))));
      root.append(template.content);
    }
    tokensRef.current = tokens;
    return tokens;
  }, []);

  const caretToEnd = React.useCallback(() => {
    const root = rootRef.current;
    if (root && document.activeElement === root) setEditorSelection(root, readEditor(root).text.length);
  }, []);

  React.useImperativeHandle(forwardedRef, () => {
    const root = rootRef.current!;
    // Uploads, slash commands, dictation and the draft hand-offs use these
    // textarea operations; the editor keeps their contract.
    Object.defineProperties(root, {
      value: {
        configurable: true,
        get: () => readEditor(root).text,
        set: (text: string) => {
          writeDraft({ text, tokens: tokensRef.current });
          publish();
        },
      },
      selectionStart: {
        configurable: true,
        get: () => editorOffset(root, window.getSelection()?.anchorNode ?? null, window.getSelection()?.anchorOffset ?? 0),
      },
      selectionEnd: {
        configurable: true,
        get: () => editorOffset(root, window.getSelection()?.focusNode ?? null, window.getSelection()?.focusOffset ?? 0),
      },
      disabled: { configurable: true, get: () => root.getAttribute("aria-disabled") === "true" },
    });
    Object.assign(root, {
      setSelectionRange: (start: number, end: number) => setEditorSelection(root, start, end),
      setDraft: (draft: ContextDraft, options?: { focus?: boolean }) => {
        writeDraft(draft);
        if (options?.focus) root.focus({ preventScroll: true });
        caretToEnd();
        publish();
      },
      getDraft: (): ContextDraft => readEditor(root),
      openMention: () => {
        root.focus({ preventScroll: true });
        const selection = window.getSelection();
        if (!selection?.anchorNode || !root.contains(selection.anchorNode)) setEditorSelection(root, readEditor(root).text.length);
        const text = readEditor(root).text;
        const at = editorOffset(root, window.getSelection()?.anchorNode ?? null, window.getSelection()?.anchorOffset ?? 0);
        const insert = at > 0 && !/\s$/.test(text.slice(0, at)) ? " @" : "@";
        if (!editCommand(document, "insertText", insert)) return;
        publish();
      },
    });
    return root as unknown as HTMLTextAreaElement;
  }, [caretToEnd, publish, writeDraft]);

  /* ——— A value replaced from outside (a send clearing it, dictation, a seed) ——— */
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || composing.current || value === lastReported.current) return;
    // Tokens survive only where their range still frames exactly their label;
    // none is re-attached by searching for its name.
    const tokens = writeDraft({ text: value, tokens: tokensRef.current });
    lastReported.current = value;
    onTokensChange(tokens);
    syncTokenNodes();
    caretToEnd();
    setPopover(null);
  }, [value, onTokensChange, writeDraft, syncTokenNodes, caretToEnd]);

  /* ——— Tokens that arrived without their row (a restored draft, a paste) get it by id ——— */
  React.useEffect(() => {
    if (!lookupEnabled || !tokenKeys) return;
    const missing = tokenKeys.split(",").filter((key) => !itemCache.has(key) && !refreshed.has(key));
    if (!missing.length) return;
    missing.forEach((key) => refreshed.add(key));
    const abort = new AbortController();
    const run = async () => {
      try {
        const result = loadMentions
          ? await loadMentions("", abort.signal)
          : await fetchMentions(new URLSearchParams({ ids: missing.join(",") }), abort.signal);
        for (const item of result.items) itemCache.set(contextTokenKey(item), item);
        if (!abort.signal.aborted) {
          syncTokenNodes();
          setMetaVersion((n) => n + 1);
        }
      } catch {
        // The token keeps the mark its own meta names; nothing else depends on this.
        missing.forEach((key) => refreshed.delete(key));
      }
    };
    void run();
    return () => abort.abort();
  }, [tokenKeys, lookupEnabled, loadMentions, syncTokenNodes]);

  /* ——— The lookup ——— */
  const cacheKey = React.useCallback((text: string) => `${conversationId ?? ""}|${text.toLowerCase()}`, [conversationId]);
  const queryText = query?.text ?? null;

  const lookup = React.useCallback(
    async (text: string, signal: AbortSignal) => {
      if (loadMentions) return loadMentions(text, signal);
      const params = new URLSearchParams({ q: text, limit: "5" });
      if (conversationId) params.set("conversationId", conversationId);
      return fetchMentions(params, signal);
    },
    [conversationId, loadMentions],
  );

  // Warm "@" with an empty query the first time the field is focused, so the
  // palette opens with rows in the same frame (C7).
  const warmed = React.useRef(false);
  const warm = React.useCallback(() => {
    if (warmed.current || !lookupEnabled || cachedLookup(cacheKey(""))) return;
    warmed.current = true;
    lookup("", new AbortController().signal)
      .then((result) => cacheLookup(cacheKey(""), result.items))
      .catch(() => {
        warmed.current = false;
      });
  }, [cacheKey, lookup, lookupEnabled]);

  React.useEffect(() => {
    if (queryText === null) {
      setPending(false);
      setFailure(null);
      setAnswered(null);
      return;
    }
    const cached = cachedLookup(cacheKey(queryText));
    if (cached) {
      setItems(cached);
      setActive(0);
      setPending(false);
      setFailure(null);
      setAnswered(queryText);
      return;
    }
    // While the server answers, the rows already showing narrow to the new
    // text in place; they are never cleared to an empty box first.
    const needle = queryText.toLowerCase();
    setItems((prev) => prev.filter((item) => item.label.toLowerCase().includes(needle)));
    setPending(true);
    setFailure(null);
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const result = await lookup(queryText, abort.signal);
        if (abort.signal.aborted) return;
        cacheLookup(cacheKey(queryText), result.items);
        setItems((prev) => {
          // Keep the highlighted row highlighted when it is still there.
          const current = prev[activeRef.current];
          const kept = current ? result.items.findIndex((item) => contextTokenKey(item) === contextTokenKey(current)) : -1;
          setActive(kept >= 0 ? kept : 0);
          return result.items;
        });
        setAnswered(queryText);
      } catch (error) {
        if (abort.signal.aborted) return;
        setItems([]);
        setFailure({
          message: error instanceof Error ? error.message : "Couldn’t search your files, apps and agents.",
          retry: () => setRetryCount((n) => n + 1),
        });
      } finally {
        if (!abort.signal.aborted) setPending(false);
      }
    }, 90);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [queryText, cacheKey, lookup, retryCount]);

  // A pending line appears only after showDelay and then stays minVisible, so a
  // fast answer never flashes "Searching…" (INTERACTION_SPEC §1.2).
  React.useEffect(() => {
    if (!pending) {
      if (!pendingShown) return;
      const hold = window.setTimeout(() => setPendingShown(false), TIMING.minVisible);
      return () => window.clearTimeout(hold);
    }
    const show = window.setTimeout(() => setPendingShown(true), TIMING.showDelay);
    return () => window.clearTimeout(show);
  }, [pending, pendingShown]);

  const status: PaletteStatus = limitHit
    ? { kind: "limit", message: `A message can name up to ${MAX_CONTEXT_TOKENS} things.` }
    : failure
      ? { kind: "failed", message: failure.message, retry: failure.retry }
      : items.length === 0 && pending && pendingShown
        ? { kind: "searching" }
        : items.length === 0 && !pending && answered === queryText && queryText !== null
          ? { kind: "empty", query: queryText }
          : { kind: "none" };
  const paletteOpen = query !== null && (items.length > 0 || status.kind !== "none");

  /* ——— Placement: outside the composer, at the caret or the token ——— */
  const measure = React.useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const box = (anchorRef?.current ?? root).getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    let palette: LayerPlacement | null = null;
    let pop: LayerPlacement | null = null;
    if (paletteOpen && query) {
      const at = editorRange(root, query.start, Math.min(query.start + 1, query.end)).getBoundingClientRect();
      const anchorX = at.width || at.left ? at.left : box.left + 20;
      palette = placeComposerLayer({ composer: box, viewport, anchorX, inset: 20, width: PALETTE_WIDTH, need: PALETTE_NEED, prefer: layerSide });
    }
    if (popover && popover.node.isConnected) {
      const rect = popover.node.getBoundingClientRect();
      pop = placeComposerLayer({ composer: box, viewport, anchorX: rect.left, inset: 8, width: POPOVER_WIDTH, need: POPOVER_NEED, prefer: layerSide });
    }
    setPlacement((prev) =>
      JSON.stringify(prev.palette) === JSON.stringify(palette) && JSON.stringify(prev.popover) === JSON.stringify(pop)
        ? prev
        : { palette, popover: pop },
    );
  }, [anchorRef, layerSide, paletteOpen, popover, query]);

  React.useLayoutEffect(() => {
    if (!paletteOpen && !popover) return;
    measure();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const observer = new ResizeObserver(schedule);
    if (anchorRef?.current) observer.observe(anchorRef.current);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      observer.disconnect();
    };
  }, [measure, paletteOpen, popover, anchorRef, items.length]);

  const openSide = paletteOpen ? (placement.palette?.side ?? null) : popover ? (placement.popover?.side ?? null) : null;
  React.useEffect(() => {
    onLayerChange?.(openSide);
  }, [onLayerChange, openSide]);

  /* ——— Choosing a row: the "@query" becomes the token, then a space ——— */
  function choose(item: MentionItem) {
    const root = rootRef.current;
    if (!root || !query) return;
    if (tokensRef.current.length >= MAX_CONTEXT_TOKENS) {
      setLimitHit(true);
      return;
    }
    itemCache.set(contextTokenKey(item), item);
    root.focus({ preventScroll: true });
    setEditorSelection(root, query.start, query.end);
    const before = new Set(tokenElements(root));
    const token = mentionToToken(item);
    const html = makeTokenElement(document, token, tokenAccessibleName(token, item)).outerHTML + " ";
    // One editing command, so ⌘Z takes back the token and its space together.
    if (!editCommand(document, "insertHTML", html)) {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!selection || !range) return;
      range.deleteContents();
      const node = makeTokenElement(document, token, tokenAccessibleName(token, item));
      const gap = document.createTextNode(" ");
      range.insertNode(gap);
      range.insertNode(node);
      range.setStartAfter(gap);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    // The token settles in place: its fill relaxes from the palette's highlight
    // tone to the token tone (C8). Nothing moves.
    const fresh = tokenElements(root).find((node) => !before.has(node));
    if (fresh && !reduce) {
      fresh.setAttribute("data-settle", "");
      window.setTimeout(() => fresh.removeAttribute("data-settle"), duration.base * 1000 + 40);
    }
    dismissedAt.current = null;
    setQuery(null);
    selectToken(null);
    publish();
  }

  /** Remove a token as one undoable edit. By pointer it yields in place first (exit timing); by keyboard at once. */
  const removeToken = React.useCallback(
    (node: HTMLElement, by: "keyboard" | "pointer") => {
      const root = rootRef.current;
      if (!root) return;
      const finish = () => {
        if (!node.isConnected) return;
        node.removeAttribute("data-leaving");
        const span = tokenSpan(root, node);
        root.focus({ preventScroll: true });
        selectNode(node);
        if (!editCommand(document, "delete")) node.remove();
        // Two spaces meeting where the token was become one.
        const text = readEditor(root).text;
        if (span.start > 0 && text.slice(span.start - 1, span.start + 1) === "  ") {
          setEditorSelection(root, span.start, span.start + 1);
          editCommand(document, "delete");
        }
        selectToken(null);
        publish();
      };
      if (by === "pointer" && !reduce) {
        node.setAttribute("data-leaving", "");
        window.setTimeout(finish, duration.exit * 1000);
      } else finish();
    },
    [publish, reduce, selectToken],
  );

  const openPopover = React.useCallback(
    (node: HTMLElement, openedBy: "keyboard" | "pointer") => {
      const token = tokenOf(node);
      if (!token) return;
      selectToken(node);
      setQuery(null);
      setPopover({ node, token, openedBy });
    },
    [selectToken],
  );

  const closePopover = React.useCallback(
    (restoreFocus: boolean) => {
      setPopover((current) => {
        if (current && restoreFocus) {
          rootRef.current?.focus({ preventScroll: true });
          if (current.node.isConnected) selectToken(current.node);
        }
        return null;
      });
    },
    [selectToken],
  );

  /** The token touching the caret on one side: Backspace looks behind, Delete ahead. */
  function tokenAtCaret(side: "before" | "after"): HTMLElement | null {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection?.isCollapsed) return null;
    const at = editorOffset(root, selection.anchorNode, selection.anchorOffset);
    return (
      tokenElements(root).find((node) => {
        const span = tokenSpan(root, node);
        return side === "before" ? span.end === at : span.start === at;
      }) ?? null
    );
  }

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (paletteOpen && query) {
      const count = items.length;
      const move = (to: number) => {
        event.preventDefault();
        if (count) setActive(((to % count) + count) % count);
      };
      const ctrl = event.ctrlKey && !event.metaKey && !event.altKey;
      if (event.key === "ArrowDown" || (ctrl && event.key === "n")) return move(active + 1);
      if (event.key === "ArrowUp" || (ctrl && event.key === "p")) return move(active - 1);
      if (event.key === "PageDown") return move(Math.min(count - 1, active + PAGE_ROWS));
      if (event.key === "PageUp") return move(Math.max(0, active - PAGE_ROWS));
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && count) {
        event.preventDefault();
        event.stopPropagation();
        choose(items[Math.min(active, count - 1)]);
        return;
      }
      if (event.key === "Escape") {
        // Closes the palette and leaves "@query" as the text it is.
        event.preventDefault();
        event.stopPropagation();
        dismissedAt.current = query.start;
        setQuery(null);
        return;
      }
    }

    // A selected token: Enter or Space opens its popover (C10), Esc lets it go.
    if (selectedToken.current?.isConnected) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPopover(selectedToken.current, "keyboard");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        selectToken(null);
        return;
      }
    }

    // Two-step delete on a hardware keyboard (C9): the first press selects the
    // token, the second removes it. Delete is symmetric.
    if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.altKey) {
      const node = tokenAtCaret(event.key === "Backspace" ? "before" : "after");
      if (node) {
        event.preventDefault();
        if (selectedToken.current === node) removeToken(node, "keyboard");
        else selectToken(node);
        return;
      }
    }
    if (selectedToken.current && event.key !== "Shift") selectToken(null);

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      if (!editCommand(document, "insertText", "\n")) editCommand(document, "insertHTML", "<br>");
      publish();
      return;
    }
    // Settings › Keyboard: "Send with ⌘ Enter". A plain Enter is offered to
    // the composer first (an open command palette still claims it), and if
    // nothing took it, it is a new line.
    if (
      event.key === "Enter" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.nativeEvent.isComposing &&
      uiPref("sendKey") === "mod-enter"
    ) {
      onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (!editCommand(document, "insertText", "\n")) editCommand(document, "insertHTML", "<br>");
      publish();
      return;
    }
    onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
  }

  function copySelection(event: React.ClipboardEvent<HTMLDivElement>): boolean {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return false;
    const draft = readEditor(selection.getRangeAt(0).cloneContents());
    event.clipboardData.setData("text/plain", draft.text);
    if (draft.tokens.length) event.clipboardData.setData(CONTEXT_CLIPBOARD_TYPE, serializeClipboardDraft(draft));
    event.preventDefault();
    return true;
  }

  const nameFor = (token: ContextToken) => tokenAccessibleName(token, itemCache.get(contextTokenKey(token)));

  return (
    <>
      {markTargets.map((target, index) => {
        const token = target.parentElement ? tokenOf(target.parentElement) : null;
        if (!token) return null;
        return createPortal(
          <ContextTokenMark source={markSource(token, itemCache.get(contextTokenKey(token)))} size={16} />,
          target,
          `mark-${index}`,
        );
      })}
      <div
        {...Object.fromEntries(Object.entries(aria).filter(([key]) => key.startsWith("aria-")))}
        ref={rootRef}
        id={id}
        contentEditable={!disabled}
        suppressContentEditableWarning
        // A combobox, as the textarea it replaces was: the field drives the
        // palette and names the row the arrows are on. No aria-multiline (a
        // combobox does not take it); Shift+Enter breaks a line, Enter sends.
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={paletteOpen || aria["aria-expanded"] === true}
        aria-controls={paletteOpen ? paletteId : aria["aria-controls"]}
        aria-activedescendant={
          paletteOpen && items.length ? `${paletteId}-opt-${Math.min(active, items.length - 1)}` : aria["aria-activedescendant"]
        }
        aria-disabled={disabled || undefined}
        data-placeholder={placeholder}
        className={cn(className, "context-composer-field whitespace-pre-wrap break-words")}
        style={style}
        tabIndex={disabled ? -1 : 0}
        spellCheck
        onInput={publish}
        onKeyDown={keyDown}
        onFocus={(event) => {
          warm();
          onFocus?.(event as unknown as React.FocusEvent<HTMLTextAreaElement>);
        }}
        onBlur={(event) => {
          // Focus leaving the field closes the palette (its rows never take focus).
          setQuery(null);
          if (!popover) selectToken(null);
          onBlur?.(event as unknown as React.FocusEvent<HTMLTextAreaElement>);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          publish();
        }}
        onMouseDown={(event) => {
          const node = (event.target as HTMLElement).closest<HTMLElement>("[data-context-token]");
          if (!node || !rootRef.current?.contains(node)) return;
          // A press on a token opens what it stands for; it never drops the caret inside it.
          event.preventDefault();
          if (popover?.node === node) closePopover(true);
          else openPopover(node, "pointer");
        }}
        onClick={inspectSelection}
        onKeyUp={inspectSelection}
        onSelect={(event) => {
          inspectSelection();
          onSelect?.(event as unknown as React.SyntheticEvent<HTMLTextAreaElement>);
        }}
        onScroll={(event) => onScroll?.(event as unknown as React.UIEvent<HTMLTextAreaElement>)}
        onCopy={copySelection}
        onCut={(event) => {
          if (!copySelection(event)) return;
          editCommand(document, "delete");
          publish();
        }}
        onPaste={(event) => {
          onPaste?.(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
          if (event.defaultPrevented) return;
          event.preventDefault();
          // Tokens copied inside Alevr come back as tokens; anything else is its plain text.
          const draft = parseClipboardDraft(event.clipboardData.getData(CONTEXT_CLIPBOARD_TYPE));
          const plain = event.clipboardData.getData("text/plain");
          const fits = tokensRef.current.length + (draft?.tokens.length ?? 0) <= MAX_CONTEXT_TOKENS;
          if (draft && draft.tokens.length && draft.text === plain && fits) {
            editCommand(document, "insertHTML", draftHtml(document, draft, nameFor));
          } else {
            editCommand(document, "insertText", plain);
          }
          publish();
        }}
      />
      {paletteOpen ? (
        <MentionPalette
          id={paletteId}
          items={items}
          active={Math.min(active, Math.max(0, items.length - 1))}
          status={status}
          placement={placement.palette}
          onChoose={choose}
          onHover={setActive}
        />
      ) : null}
      <AnimatePresence>
        {popover ? (
          <TokenPopover
            key={contextTokenKey(popover.token)}
            token={popover.token}
            item={itemCache.get(contextTokenKey(popover.token))}
            placement={placement.popover}
            openedBy={popover.openedBy}
            onClose={closePopover}
            onRemove={() => {
              const node = popover.node;
              setPopover(null);
              removeToken(node, popover.openedBy);
            }}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
});
