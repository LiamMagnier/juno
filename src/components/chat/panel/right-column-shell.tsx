"use client";

import * as React from "react";

import { IconButton } from "@/components/ui/icon-button";
import { ChevronLeft, GripVertical, MoreHorizontal, X } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SplitPane } from "@/hooks/use-split-pane";
import { formatNumber, useUiLocale } from "@/lib/i18n-format";
import { Phrase, usePhrase } from "@/lib/i18n-phrase";
import { cn } from "@/lib/utils";

import { PANEL_COPY } from "./copy";
import { createExitWatcher, createShellFocus, exitFallbackMs, type FocusTarget } from "./shell-focus";

/*
 * The one right-column shell the Activity and Research panels share (SPEC
 * §8.2, DECISIONS U4): the chat header's height, fill and gutter; close, and
 * back in sheet mode; enter and exit that keep the content painted; no ad-hoc
 * `z-40`. Below the split it is a sheet that keeps the composer reachable.
 *
 * MOTION IS CSS. The `.right-shell` rules in globals.css (§7.9) enter from the
 * outer edge on `--dur-slow`/`--ease-drawer` and leave on `--dur-exit`/
 * `--ease-in`, with `transition-behavior: allow-discrete` keeping the content
 * painted while `display` flips. No `animate-in` utilities: they replay on
 * every re-mount and fought the resize drag (the old dock in chat-view), and
 * during a drag the shell sets `data-resizing`, which turns transitions off.
 *
 * ONE INSTANCE. chat-view renders one shell and swaps the panel inside it, so
 * switching Activity ↔ Research is a 120 ms cross-fade of the body rather than
 * an exit and an entrance. The panel inside owns what the header says and
 * which tabs exist, and hands them up with `useRightColumnChrome`; the props
 * are the defaults a panel can leave alone.
 *
 * Focus and the exit timer are decided in `shell-focus.ts`, which is tested
 * without a DOM; this file only wires them to elements.
 */

export interface RightColumnTab {
  id: string;
  /** A `*_COPY` phrase. */
  label: string;
  /** Shown after the label as a number node ("Sources 5"). */
  count?: number;
}

export interface RightColumnShellProps {
  /** Drives data-open; content stays mounted through the exit. */
  open: boolean;
  /** The stable panel name ("Activity", "Research"): the aside's accessible name AND the h2 text.
   *  It never changes with the phase. */
  label: string;
  /** Status row content beside the h2 (static phase word + clock, "Thought for 12s", run title).
   *  Rendered aria-hidden when it only repeats live state the announcer already speaks. */
  header: React.ReactNode;
  /** e.g. Research controls */
  headerActions?: React.ReactNode;
  /** Rendered with the Radix Tabs of src/components/ui/tabs.tsx. Never a row of plain buttons. */
  tabs?: RightColumnTab[];
  activeTab?: string;
  onTabChange?(id: string): void;
  onClose(): void;
  children: React.ReactNode;
  /** Width, resize handle and bounds: the existing thought pane's `useSplitPane` (THOUGHT_WIDTH_KEY). */
  pane: SplitPane;
  /** chat-view measures `splitEngaged(layoutRef.current)`; below the split the shell is a sheet. */
  mode: "column" | "sheet";
  /** Fires once when the exit finishes: on `transitionend` filtered to `propertyName === "opacity"`,
   *  or after `--dur-exit` + 50 ms when no transition runs. chat-view drops content then. */
  onExited?(): void;
}

// ── Chrome a panel hands up ───────────────────────────────────────────────────

/** What a panel inside the shell says in the shell's header and tab row. Unset keys keep the props. */
export interface RightColumnChrome {
  label?: string;
  header?: React.ReactNode;
  headerActions?: React.ReactNode;
  tabs?: RightColumnTab[];
  activeTab?: string;
  onTabChange?(id: string): void;
}

type RegisterChrome = (owner: symbol, chrome: RightColumnChrome | null) => void;

const ChromeContext = React.createContext<RegisterChrome | null>(null);

const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/**
 * A panel's header and tabs, handed to the shell it is rendered in. Registered
 * in a layout effect, so the first painted frame already shows them. Outside a
 * shell it does nothing.
 */
export function useRightColumnChrome(chrome: RightColumnChrome): void {
  const register = React.useContext(ChromeContext);
  const [owner] = React.useState(() => Symbol("right-column-chrome"));
  useIsomorphicLayoutEffect(() => {
    register?.(owner, chrome);
  });
  useIsomorphicLayoutEffect(() => () => register?.(owner, null), [register, owner]);
}

function pick<T>(fromPanel: T | undefined, fromProps: T): T {
  return fromPanel === undefined ? fromProps : fromPanel;
}

// ── The shell ─────────────────────────────────────────────────────────────────

export function RightColumnShell(props: RightColumnShellProps) {
  const { open, onClose, children, pane, mode, onExited } = props;

  const [registered, setRegistered] = React.useState<{ owner: symbol; chrome: RightColumnChrome } | null>(null);
  const register = React.useCallback<RegisterChrome>((owner, chrome) => {
    setRegistered((current) => (chrome ? { owner, chrome } : current?.owner === owner ? null : current));
  }, []);
  const chrome = registered?.chrome;
  const label = pick(chrome?.label, props.label);
  const header = pick(chrome?.header, props.header);
  const headerActions = pick(chrome?.headerActions, props.headerActions);
  const tabs = pick(chrome?.tabs, props.tabs);
  const activeTab = pick(chrome?.activeTab, props.activeTab);
  const onTabChange = pick(chrome?.onTabChange, props.onTabChange);

  const shownLabel = usePhrase(label);
  const closeText = usePhrase(PANEL_COPY.shell.closePanel);
  const backText = usePhrase(PANEL_COPY.shell.backToChat);
  const resizeText = usePhrase(PANEL_COPY.shell.resizePanel);
  const resizeHint = usePhrase(PANEL_COPY.shell.resizeHint);
  const moreText = usePhrase(PANEL_COPY.shell.moreActions);
  const locale = useUiLocale();

  // Switching Activity ↔ Research inside the open shell cross-fades the body
  // (§8.5). The first content does not fade: the shell's own entrance carries it.
  const [lastKind, setLastKind] = React.useState(props.label);
  const [crossFade, setCrossFade] = React.useState(false);
  if (lastKind !== props.label) {
    setLastKind(props.label);
    setCrossFade(true);
  }

  // ── Focus and exit ──────────────────────────────────────────────────────
  const rootRef = React.useRef<HTMLElement | null>(null);
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);
  const onExitedRef = React.useRef(onExited);
  React.useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);
  const [focus] = React.useState(createShellFocus);
  const [exit] = React.useState(() => createExitWatcher(() => onExitedRef.current?.()));
  const shownOpen = React.useRef(false);

  useIsomorphicLayoutEffect(() => {
    if (open === shownOpen.current) return;
    shownOpen.current = open;
    if (open) {
      exit.cancel();
      focus.open(document.activeElement as FocusTarget | null, headingRef.current);
      return;
    }
    // Hand focus back BEFORE the content goes inert, or it falls to <body>.
    focus.close(document.activeElement, rootRef.current, document.body);
    const root = rootRef.current;
    exit.start(exitFallbackMs(root ? getComputedStyle(root).getPropertyValue("--dur-exit") : null));
  }, [open, exit, focus]);
  React.useEffect(() => () => exit.cancel(), [exit]);

  const sheet = mode === "sheet";
  const tabList = tabs && tabs.length > 0 ? tabs : null;
  const tabValue = tabList ? (activeTab ?? tabList[0].id) : undefined;

  const body = (
    <div
      key={props.label}
      className={cn("min-h-full", crossFade && "animate-fade-in [animation-duration:var(--dur-fast)] motion-reduce:animate-none")}
    >
      {children}
    </div>
  );

  return (
    <ChromeContext.Provider value={register}>
      <aside
        ref={rootRef}
        aria-label={shownLabel}
        data-open={open ? "" : undefined}
        data-mode={mode}
        data-resizing={pane.resizing ? "" : undefined}
        inert={!open}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          // A popover or menu portalled out of the panel closes itself first;
          // its Escape bubbles here through React but is not the panel's.
          if (!event.currentTarget.contains(event.target as Node)) return;
          // Handled here, so chat-view's window listener does not close twice.
          event.preventDefault();
          onClose();
        }}
        onTransitionEnd={(event) =>
          exit.transitionEnd({ propertyName: event.propertyName, target: event.target, currentTarget: event.currentTarget })
        }
        style={
          !sheet && pane.width != null ? ({ "--juno-thought-width": `${pane.width}px` } as React.CSSProperties) : undefined
        }
        className={cn(
          "right-shell @container/shell flex flex-col overflow-hidden",
          sheet
            ? // Below the split: a sheet floating over the transcript, from the
              // chat header band's bottom edge to the composer's top edge, so the
              // composer stays visible and typeable. chat-view measures both
              // edges into these properties (0 and 7rem until it has).
              "surface-float absolute inset-x-0 bottom-[var(--juno-composer-h,7rem)] top-[var(--juno-header-h,0px)] z-[var(--z-panel)] rounded-t-panel border-b-0 shadow-float"
            : // Beside the split: a column in flow, the thought pane's width —
              // the CSS default until dragged, then the dragged width.
              cn(
                "relative h-full w-full shrink-0 border-border/70 @[50rem]/split:border-s @[50rem]/split:hover:border-border",
                pane.width == null ? "@[50rem]/split:w-[30rem]" : "@[50rem]/split:w-[var(--juno-thought-width)]",
                pane.resizing && "select-none"
              )
        )}
      >
        {!sheet && (
          <button
            type="button"
            {...pane.separatorProps}
            aria-label={resizeText}
            title={resizeHint}
            className="group absolute inset-y-0 start-0 z-popper hidden w-3 cursor-col-resize touch-none items-center justify-center before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors before:duration-fast before:ease-out-soft motion-reduce:before:transition-none ltr:-translate-x-1/2 rtl:translate-x-1/2 @[50rem]/split:flex @[50rem]/split:hover:bg-primary/10 @[50rem]/split:hover:before:bg-primary/40"
          >
            <span className="flex h-12 w-1.5 items-center justify-center rounded-full border border-border/70 bg-popover text-muted-foreground opacity-0 shadow-soft transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
              <GripVertical className="size-3.5" />
            </span>
          </button>
        )}

        {/* The header matches the chat header band: its measured height, or
            3.5rem where the band is absent (below md, private chats) and
            chat-view writes 0. The min-height term is 3.5rem only while the
            measured height is 0 and resolves to nothing otherwise. */}
        <div className="flex h-[var(--juno-header-h,3.5rem)] min-h-[calc(3.5rem-var(--juno-header-h,0px)*1000)] shrink-0 items-center gap-2 border-b border-border/70 bg-background px-4">
          {sheet && (
            <IconButton variant="ghost" size="sm" label={backText} onClick={onClose} className="-ms-2">
              <ChevronLeft className="size-4 rtl:-scale-x-100" />
            </IconButton>
          )}
          <h2 ref={headingRef} tabIndex={-1} className="shrink-0 text-ui font-semibold text-foreground outline-none">
            <Phrase text={label} />
          </h2>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-ui text-muted-foreground">{header}</div>
          {headerActions != null && headerActions !== false && (
            <>
              <div className="hidden shrink-0 items-center gap-1 @[28rem]/shell:flex">{headerActions}</div>
              {/* Below a 28rem panel the secondary actions fold into one
                  overflow control (§8.3 "Mobile header"). */}
              <Popover>
                <PopoverTrigger asChild>
                  <IconButton variant="ghost" size="sm" label={moreText} className="@[28rem]/shell:hidden">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                </PopoverTrigger>
                <PopoverContent align="end" className="flex w-auto flex-col items-stretch gap-1 p-1">
                  {headerActions}
                </PopoverContent>
              </Popover>
            </>
          )}
          {!sheet && (
            <IconButton variant="ghost" size="sm" label={closeText} onClick={onClose} className="-me-2">
              <X className="size-4" />
            </IconButton>
          )}
        </div>

        {tabList ? (
          <Tabs value={tabValue} onValueChange={(id) => onTabChange?.(id)} className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border/70 bg-background px-4 py-2">
              <TabsList>
                {tabList.map((tab) => (
                  <TabsTrigger key={tab.id} value={tab.id}>
                    <Phrase text={tab.label} />
                    {tab.count != null && tab.count > 0 && (
                      <span className="tabular-nums text-muted-foreground" data-no-auto-translate>
                        {formatNumber(tab.count, locale)}
                      </span>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent
              value={tabValue ?? tabList[0].id}
              forceMount
              // The panel swaps its own tab body; Radix's fade on every switch
              // would replay the whole list the reader has already seen.
              className="right-shell__scroller min-h-0 flex-1 overflow-y-auto bg-card data-[state=active]:animate-none"
            >
              {body}
            </TabsContent>
          </Tabs>
        ) : (
          <div className="right-shell__scroller min-h-0 flex-1 overflow-y-auto bg-card">{body}</div>
        )}
      </aside>
    </ChromeContext.Provider>
  );
}
