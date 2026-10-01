"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AppIcons } from "@/lib/app-icons";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { AgentFace } from "@/components/agents/agent-face";
import { MAX_CONTEXT_TOKENS, type ContextToken } from "@/lib/chat/context-tokens";
import { mentionToToken, type MentionItem, type MentionSearchResult } from "@/lib/mentions/types";
import { readEditor, editorOffset, setEditorSelection } from "./context-editor-dom";
import { cn } from "@/lib/utils";
import { AGENT_NOUN, FEATURE_NAMES } from "@/lib/brand/names";

type Props = Omit<React.ComponentPropsWithoutRef<"textarea">, "value"> & {
  value: string;
  conversationId: string | null;
  onTokensChange: (tokens: ContextToken[]) => void;
  privateMode?: boolean;
  /** Dev galleries can exercise the real editor with explicitly labelled fixtures. */
  loadMentions?: (query: string, signal: AbortSignal) => Promise<MentionSearchResult>;
};

const GROUPS: Record<string, string> = { crew: AGENT_NOUN.pluralLabel, file: "Files", project: "Projects", app: "Apps", skill: "Skills", chat: "Chats", artifact: FEATURE_NAMES.artifacts.label };

function MentionMark({ item }: { item: MentionItem }) {
  if (item.kind === "app") return <ConnectorMark id={item.connectorId ?? item.id} className="size-4" />;
  if (item.kind === "crew" && item.avatar) return <AgentFace avatar={item.avatar} size="xs" state="idle" />;
  const Mark = item.kind === "project" ? AppIcons.projects : item.kind === "skill" ? AppIcons.skills : item.kind === "chat" ? AppIcons.conversation : AppIcons.library;
  return <Mark className="size-4" motion="none" />;
}

/** The DOM owns typing/IME/undo; React owns the palette and the external draft. */
export const ContextComposerField = React.forwardRef<HTMLTextAreaElement, Props>(function ContextComposerField(
  { value, conversationId, onTokensChange, privateMode, loadMentions, onChange, onKeyDown, onPaste, onSelect, onScroll, className, disabled, placeholder, style, id, "aria-label": label, ...aria }, forwardedRef,
) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const composing = React.useRef(false);
  const lastReported = React.useRef<string | null>(null);
  const tokensRef = React.useRef<ContextToken[]>([]);
  const [query, setQuery] = React.useState<{ text: string; start: number; end: number } | null>(null);
  const [items, setItems] = React.useState<MentionItem[]>([]);
  const [active, setActive] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const selectedToken = React.useRef<HTMLElement | null>(null);
  const paletteId = React.useId().replace(/:/g, "");
  const markItems = React.useRef(new Map<string, MentionItem>());
  const [markTargets, setMarkTargets] = React.useState<HTMLElement[]>([]);
  function refreshMarks() { setMarkTargets(Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".context-token-mark") ?? [])); }

  const inspectSelection = React.useCallback(() => {
    const root = rootRef.current; if (!root || composing.current) return;
    const selection = window.getSelection();
    const at = editorOffset(root, selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
    const before = readEditor(root).text.slice(0, at);
    const fragment = /(?:^|\s)@([^\s@]{0,100})$/.exec(before);
    setQuery(fragment && !privateMode ? { text: fragment[1], start: at - fragment[1].length - 1, end: at } : null);
  }, [privateMode]);

  function publish() {
    const root = rootRef.current; if (!root) return;
    const result = readEditor(root);
    tokensRef.current = result.tokens;
    refreshMarks();
    lastReported.current = result.text;
    onTokensChange(result.tokens);
    onChange?.({ target: { value: result.text, selectionStart: editorOffset(root, window.getSelection()?.anchorNode ?? null, window.getSelection()?.anchorOffset ?? 0) }, currentTarget: root } as unknown as React.ChangeEvent<HTMLTextAreaElement>);
    inspectSelection();
  }

  React.useImperativeHandle(forwardedRef, () => {
    const root = rootRef.current!;
    // Existing uploads, slash commands, dictation and draft handoffs use these
    // native textarea operations. The editor keeps their public contract.
    Object.defineProperties(root, {
      value: { configurable: true, get: () => readEditor(root).text, set: (text: string) => { root.textContent = text; } },
      selectionStart: { configurable: true, get: () => editorOffset(root, window.getSelection()?.anchorNode ?? null, window.getSelection()?.anchorOffset ?? 0) },
      selectionEnd: { configurable: true, get: () => editorOffset(root, window.getSelection()?.focusNode ?? null, window.getSelection()?.focusOffset ?? 0) },
    });
    Object.assign(root, { setSelectionRange: (start: number, end: number) => setEditorSelection(root, start, end) });
    return root as unknown as HTMLTextAreaElement;
  }, []);

  React.useLayoutEffect(() => {
    const root = rootRef.current; if (!root || composing.current || value === lastReported.current) return;
    // External replacement (send, restore, dictate, slash): preserve tokens only
    // at ranges that still frame exactly their label, never guess by name.
    const tokens = tokensRef.current.filter(t => t.range && value.slice(t.range.start, t.range.end) === t.label);
    root.replaceChildren(); let cursor = 0;
    for (const token of tokens) {
      root.append(document.createTextNode(value.slice(cursor, token.range!.start)));
      root.append(makeToken(token)); cursor = token.range!.end;
    }
    root.append(document.createTextNode(value.slice(cursor)));
    lastReported.current = value;
    tokensRef.current = tokens; onTokensChange(tokens); refreshMarks();
    if (document.activeElement === root) setEditorSelection(root, value.length);
  }, [value, onTokensChange]);

  // The lookup reruns when the typed text changes, not when the caret moves
  // inside the same @query (its start/end change, its text does not).
  const queryText = query?.text ?? null;
  React.useEffect(() => {
    if (queryText === null) { setItems([]); setLoading(false); setFailure(null); return; }
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setFailure(null);
      try {
        const params = new URLSearchParams({ q: queryText, limit: "5" });
        if (conversationId) params.set("conversationId", conversationId);
        let result: MentionSearchResult;
        if (loadMentions) result = await loadMentions(queryText, abort.signal);
        else {
          const response = await fetch(`/api/mentions?${params}`, { signal: abort.signal });
          if (!response.ok) throw new Error(response.status === 401 ? "Sign in to find your files, apps and agents." : "Could not find your context. Type @ to try again.");
          result = await response.json() as MentionSearchResult;
        }
        if (!abort.signal.aborted) { setItems(result.items); setActive(0); }
      } catch (error) { if (!abort.signal.aborted) { setItems([]); setFailure(error instanceof Error ? error.message : "Could not find your context."); } }
      finally { if (!abort.signal.aborted) setLoading(false); }
    }, 120);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [queryText, conversationId, loadMentions]);

  function makeToken(token: ContextToken) {
    const node = document.createElement("span");
    node.contentEditable = "false"; node.className = "context-token";
    node.dataset.contextToken = JSON.stringify(token);
    node.setAttribute("aria-label", `${GROUPS[token.kind] ?? token.kind}: ${token.label}`);
    // Only text nodes are used, so account labels cannot become markup.
    const mark = document.createElement("span"); mark.className = "context-token-mark"; mark.setAttribute("aria-hidden", "true");
    mark.dataset.tokenMark = JSON.stringify(token);
    node.append(mark, document.createTextNode(token.label));
    return node;
  }

  function choose(item: MentionItem) {
    const root = rootRef.current; if (!root || !query) return;
    if (tokensRef.current.length >= MAX_CONTEXT_TOKENS) { setFailure(`Use at most ${MAX_CONTEXT_TOKENS} context items per message.`); return; }
    root.focus(); setEditorSelection(root, query.start, query.end);
    const selection = window.getSelection(); if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0); range.deleteContents();
    markItems.current.set(`${item.kind}:${item.id}`, item);
    const token = makeToken(mentionToToken(item));
    range.insertNode(token);
    const gap = document.createTextNode(" "); token.after(gap);
    range.setStart(gap, 1); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    setQuery(null); setItems([]); selectedToken.current = null; publish();
  }

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (query) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setQuery(null); return; }
      if (items.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setActive(i => (i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length); return; }
      if (items.length && (event.key === "Enter" || event.key === "Tab")) { event.preventDefault(); event.stopPropagation(); choose(items[active]); return; }
    }
    const root = rootRef.current!;
    const selection = window.getSelection();
    if (event.key === "Backspace" && selection?.isCollapsed) {
      const at = editorOffset(root, selection.anchorNode, selection.anchorOffset);
      const token = Array.from(root.querySelectorAll<HTMLElement>("[data-context-token]")).find(n => {
        const index = Array.from(n.parentNode!.childNodes).indexOf(n);
        const start = editorOffset(root, n.parentNode, index);
        return start + readEditor(n).text.length === at;
      });
      if (token) {
        event.preventDefault();
        if (selectedToken.current === token) { token.remove(); selectedToken.current = null; publish(); }
        else { selectedToken.current?.removeAttribute("data-selected"); token.dataset.selected = ""; selectedToken.current = token; }
        return;
      }
    }
    selectedToken.current?.removeAttribute("data-selected"); selectedToken.current = null;
    if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); document.execCommand("insertText", false, "\n"); publish(); return; }
    onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
  }

  return (
    <>
      {markTargets.map((target, index) => {
        const token = JSON.parse(target.dataset.tokenMark!) as ContextToken;
        const item = markItems.current.get(`${token.kind}:${token.id}`) ?? { kind: token.kind, id: token.id, label: token.label, icon: token.meta?.icon ?? token.kind, score: 0 };
        return createPortal(<MentionMark item={item} />, target, `${token.kind}:${token.id}:${index}`);
      })}
      <div {...Object.fromEntries(Object.entries(aria).filter(([key]) => key.startsWith("aria-")))} ref={rootRef} id={id}
        contentEditable={!disabled} suppressContentEditableWarning role="combobox" aria-label={label}
        // No aria-multiline: combobox does not support it, and Enter sends here
        // (Shift+Enter breaks the line), as the textarea combobox this replaced.
        aria-autocomplete="list" aria-expanded={Boolean(query) || aria["aria-expanded"]}
        aria-controls={query ? paletteId : aria["aria-controls"]} aria-activedescendant={query && items.length ? `${paletteId}-${active}` : aria["aria-activedescendant"]}
        aria-disabled={disabled} data-placeholder={placeholder} className={cn(className, "context-composer-field whitespace-pre-wrap break-words")}
        style={style} tabIndex={disabled ? -1 : 0} onInput={publish} onKeyDown={keyDown}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; publish(); }}
        onClick={inspectSelection} onKeyUp={inspectSelection} onSelect={event => { inspectSelection(); onSelect?.(event as unknown as React.SyntheticEvent<HTMLTextAreaElement>); }}
        onScroll={event => onScroll?.(event as unknown as React.UIEvent<HTMLTextAreaElement>)}
        onCopy={event => { const selection = window.getSelection(); if (selection?.rangeCount) { event.clipboardData.setData("text/plain", readEditor(selection.getRangeAt(0).cloneContents()).text); event.preventDefault(); } }}
        onPaste={event => {
          onPaste?.(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>); if (event.defaultPrevented) return;
          event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); publish();
        }} />
      {query && <div className="surface-float absolute bottom-full left-0 z-popper mb-2 max-h-80 w-full overflow-y-auto rounded-menu p-1" id={paletteId} role="listbox" aria-label="Context">
        {items.map((item, index) => <React.Fragment key={`${item.kind}:${item.id}`}>
          {(index === 0 || items[index - 1].kind !== item.kind) && <div className="px-3 pb-1 pt-2 text-label text-muted-foreground">{GROUPS[item.kind]}</div>}
          <button type="button" role="option" aria-selected={index === active} id={`${paletteId}-${index}`} tabIndex={-1}
            className={cn("flex w-full items-center gap-3 rounded-control px-3 py-2 text-left text-ui", index === active && "bg-accent")}
            onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>
            <MentionMark item={item} /><span className="min-w-0 flex-1"><span className="block truncate">{item.label}</span>{(item.approval?.summary || item.subtitle || item.needsConnection) && <span className="block text-caption text-muted-foreground">{item.needsConnection ? "Connect this app before using it" : item.approval?.summary ?? item.subtitle}</span>}</span>
          </button>
        </React.Fragment>)}
        {!items.length && <p role="status" className="px-3 py-3 text-ui text-muted-foreground">{loading ? "Finding your context…" : failure ?? "No matching files, apps or agents."}</p>}
      </div>}
    </>
  );
});
