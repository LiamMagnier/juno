"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Code2, GraduationCap, Image as ImageGlyph, ListChecks, SquarePen, Telescope } from "@/components/ui/icons";
import { useApp } from "@/components/app/app-provider";
import { formatPhrase, prefetchPhrases } from "@/lib/i18n-phrase";
import { getModel } from "@/lib/models";
import { isModelLocked } from "@/lib/model-picker";
import { PLANS } from "@/lib/plans";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  HOME_STARTER_COPY,
  STARTER_ACTION,
  STARTER_PICKS_KEY,
  codeHandoffHref,
  parsePicks,
  promptText,
  promptsFor,
  rankStarters,
  recentUse,
  recordPick,
  type StarterId,
  type StarterPrompt,
} from "@/lib/home-starters";
import { rowOverflow } from "@/components/chat/row-overflow";
import "./home-starters.css";

/*
 * THE HOME'S STARTERS (G34), under the composer on a desktop and above it on a
 * phone (composer.css, `.chat-home__suggest`). The rules are in
 * lib/home-starters.ts; this file draws them and wires the pick to the
 * composer through its existing `juno:composer-seed` door, so a starter is
 * exactly what a person could have typed: it fills the field and waits.
 *
 * Motion, on the house ladder: the chips deal in on the rise-in a beat after
 * the composer's tray, a chip's prompts rise in on the tight stagger, and the
 * whole row fades out (opacity only, layout held) the moment the person
 * starts typing, so nothing jumps under their caret. Reduced motion keeps the
 * fades and drops the travel (globals.css Tier B).
 */

const CHIP_GLYPH: Record<StarterId, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  write: SquarePen,
  research: Telescope,
  image: ImageGlyph,
  code: Code2,
  plan: ListChecks,
  learn: GraduationCap,
};

/** After the tray's own arrival (composer.css `chat-home-tray`, 260 ms in). */
const CHIPS_ENTER_AFTER_MS = 420;

/** Only the control that requested a new chat may yield its focus on arrival. */
const NEW_CHAT_TRIGGER = "[data-new-chat-trigger]";

/** A desktop with a mouse or trackpad: the one place the caret may wait unasked (no phone keyboard pops up). */
function finePointer(): boolean {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function focusComposer() {
  window.dispatchEvent(new CustomEvent("juno:composer-focus"));
}

function readPicks(): string | null {
  try {
    return window.localStorage.getItem(STARTER_PICKS_KEY);
  } catch {
    return null;
  }
}

function writePick(id: StarterId) {
  try {
    window.localStorage.setItem(STARTER_PICKS_KEY, recordPick(readPicks(), id));
  } catch {
    // Private window or blocked storage: the order simply does not learn.
  }
}

/** The composer's draft as text, read from its field (a contenteditable or a textarea). */
function draftOf(root: HTMLElement | null): string {
  const field = root?.querySelector<HTMLElement>("[contenteditable='true'], textarea");
  if (!field) return "";
  return (field instanceof HTMLTextAreaElement ? field.value : field.textContent ?? "").trim();
}

export function HomeStarters({
  composerRef,
  hidden = false,
  onShownChange,
}: {
  /** The home composer's wrapper: typing in it hides the starters. */
  composerRef: React.RefObject<HTMLElement | null>;
  /** Incognito, a clarification card or the send handoff: the row steps back. */
  hidden?: boolean;
  /** Whether the row is on screen, so the field behind it can calm down. */
  onShownChange?: (shown: boolean) => void;
}) {
  const router = useRouter();
  const { conversations, models, quota, features } = useApp();
  const [open, setOpen] = React.useState<StarterId | null>(null);
  const [typed, setTyped] = React.useState(false);
  const [picks, setPicks] = React.useState<Partial<Record<StarterId, number>>>({});
  const listId = React.useId();
  const chipRefs = React.useRef(new Map<StarterId, HTMLButtonElement>());
  const listRef = React.useRef<HTMLUListElement>(null);
  const rowRef = React.useRef<HTMLDivElement>(null);

  // ARRIVAL. A new chat on a desktop puts the caret in the composer, so typing
  // works at once and a keyboard user is not sent through the whole sidebar to
  // reach it. Only when focus is nowhere (a fresh load) or still on the control
  // that brought the person here (New chat in the sidebar or header); never on
  // a coarse pointer, where focus would raise the keyboard uninvited. The
  // starters stay: they hide on input, not on focus. "New chat" pressed while
  // already home does the same, since nothing remounts then. The caret comes
  // without the keyboard ring: the composer rings only when the keyboard moved
  // focus (lib/input-modality.ts), so a load or a click on New chat gets the
  // soft focus edge and a Tab or Enter arrival gets the ring. This effect
  // depends on that gate (tests/home-starters.test.ts pins both halves).
  React.useEffect(() => {
    if (!finePointer()) return;
    let frame = 0;
    const scheduleFocus = () => {
      cancelAnimationFrame(frame);
      const from = document.activeElement;
      frame = requestAnimationFrame(() => {
        // A later interaction owns focus, even if it is another sidebar row.
        // In particular, Search may be waiting for its lazy dialog to load.
        const current = document.activeElement;
        if (!current || current === document.body || current === from) focusComposer();
      });
    };
    const active = document.activeElement;
    if (!hidden && (!active || active === document.body || active.closest(NEW_CHAT_TRIGGER))) scheduleFocus();
    const again = (event: Event) => {
      cancelAnimationFrame(frame);
      // Leaving incognito also resets the thread, but its focus belongs to
      // the privacy toggle. Only a New chat action asks for the caret.
      if (event instanceof CustomEvent && event.detail?.focusComposer === false) return;
      scheduleFocus();
    };
    window.addEventListener("juno:new-chat", again);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("juno:new-chat", again);
    };
    // Arrival only: a later change (incognito off, a card answered) follows the person's own move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Device picks live in this browser; read after mount so the server render matches.
  React.useEffect(() => {
    setPicks(parsePicks(readPicks()));
  }, []);

  const use = React.useMemo(
    () => recentUse(conversations, (id) => getModel(id)?.modality),
    [conversations],
  );

  const imageModel = React.useMemo(() => {
    const usable = (id: string | null) => {
      const model = id ? models.find((m) => m.id === id) : undefined;
      return model && model.modality === "image" && !model.comingSoon && !isModelLocked(model, quota.plan) ? model.id : null;
    };
    return usable(use.lastImageModel) ?? models.find((m) => usable(m.id))?.id ?? null;
  }, [models, quota.plan, use.lastImageModel]);

  const chips = React.useMemo(
    () =>
      rankStarters(
        {
          research: PLANS[quota.plan].research && features.deepResearch,
          image: imageModel !== null,
          code: PLANS[quota.plan].code || !!features.codeOpen,
        },
        { recent: use.recent, picks },
      ),
    [features.codeOpen, features.deepResearch, imageModel, picks, quota.plan, use.recent],
  );

  // Typing hides the row; clearing the field brings it back. A draft restored
  // into the field before this mounted counts as typing.
  React.useEffect(() => {
    const root = composerRef.current;
    if (!root) return;
    const sync = () => setTyped(draftOf(root) !== "");
    const frame = requestAnimationFrame(sync);
    root.addEventListener("input", sync);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("input", sync);
    };
  }, [composerRef]);

  const shown = !hidden && !typed && chips.length > 0;
  React.useEffect(() => {
    onShownChange?.(shown);
  }, [onShownChange, shown]);
  React.useEffect(() => {
    if (!shown) setOpen(null);
  }, [shown]);

  // THE PHONE ROW'S EDGES. Below 760px the chips are one sideways row that
  // runs off the screen; an edge with more past it fades wide (home-starters.css),
  // so the chip cut by the screen dissolves instead of showing "Pla" at full
  // ink. The marks are written straight onto the row: a scroll never renders.
  React.useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const mark = () => {
      const { more, past } = rowOverflow(row);
      row.toggleAttribute("data-more-start", past);
      row.toggleAttribute("data-more-end", more);
    };
    mark();
    row.addEventListener("scroll", mark, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mark);
    observer?.observe(row);
    return () => {
      row.removeEventListener("scroll", mark);
      observer?.disconnect();
    };
  }, [chips.length]);

  // A reader in another language gets the prompts translated before they open.
  React.useEffect(() => {
    prefetchPhrases(chips.flatMap((id) => promptsFor(id, use).map((p) => p.phrase)));
  }, [chips, use]);

  const pick = (id: StarterId, prompt: StarterPrompt) => {
    const text = promptText(prompt, formatPhrase(prompt.phrase));
    writePick(id);
    setOpen(null);
    const action = STARTER_ACTION[id];
    if (action === "code") {
      router.push(codeHandoffHref(text));
      return;
    }
    setTyped(true);
    window.dispatchEvent(
      new CustomEvent("juno:composer-seed", {
        detail: {
          text,
          ...(action === "research" ? { research: true } : {}),
          // An image model for "Create image"; a model that writes for the rest.
          ...(action === "image" && imageModel ? { model: imageModel } : { modality: "chat" }),
        },
      }),
    );
  };

  const closeList = (focusChip: StarterId | null) => {
    setOpen(null);
    if (focusChip) requestAnimationFrame(() => chipRefs.current.get(focusChip)?.focus());
  };

  // A chip opened from the keyboard hands focus to its first prompt, so Tab
  // and the arrows walk what just opened rather than the chips after it (and,
  // on a phone, the list drawn above the row). A pointer keeps focus where it
  // clicked. Escape hands it back (closeList).
  const toggle = (id: StarterId, keyboard: boolean) => {
    const next = open === id ? null : id;
    setOpen(next);
    if (next && keyboard) requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
  };

  // The arrows walk the prompts and, off the edge nearest the chips, step back
  // to the chip that opened them (the same place Escape lands), so the list
  // never dead-ends. That edge is the top on a desktop, where the list hangs
  // under the row, and the bottom on a phone, where it is drawn above it
  // (home-starters.css, the composer's 760px breakpoint). The far edge holds.
  const stepPrompt = (delta: 1 | -1) => {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const towardChips = window.matchMedia("(max-width: 760px)").matches ? 1 : -1;
    const leaving = delta === -1 ? at === 0 : at === buttons.length - 1;
    if (open && at >= 0 && leaving && delta === towardChips) {
      chipRefs.current.get(open)?.focus();
      return;
    }
    const to = at < 0 ? 0 : Math.max(0, Math.min(buttons.length - 1, at + delta));
    buttons[to]?.focus();
  };

  const edgePrompt = (which: "first" | "last") => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!buttons?.length) return;
    buttons[which === "first" ? 0 : buttons.length - 1].focus();
  };

  if (chips.length === 0) return null;

  return (
    <div
      className="home-starters"
      data-shown={shown ? "" : undefined}
      // A chip's prompts are showing: the home field steps out (home-starters.css).
      data-open={open ? "" : undefined}
      aria-hidden={!shown || undefined}
      inert={!shown}
    >
      <div
        ref={rowRef}
        className="home-starters__chips no-scrollbar"
        role="group"
        aria-label={HOME_STARTER_COPY.groupLabel}
        // Escape closes the prompts from the chips too. A pointer leaves focus
        // on the chip it pressed, and with the handler on the list alone
        // Escape did nothing there: the list stayed open and the home field
        // stayed faded out until the chip was pressed again.
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            closeList(open);
          }
        }}
      >
        {chips.map((id, i) => {
          const Glyph = CHIP_GLYPH[id];
          const selected = open === id;
          return (
            <button
              key={id}
              ref={(el) => {
                if (el) chipRefs.current.set(id, el);
                else chipRefs.current.delete(id);
              }}
              type="button"
              aria-expanded={selected}
              aria-controls={selected ? listId : undefined}
              data-selected={selected ? "" : undefined}
              // `detail` counts clicks; 0 is Enter or Space on the focused chip.
              onClick={(event) => toggle(id, event.detail === 0)}
              style={staggerDelay(i, "base", CHIPS_ENTER_AFTER_MS)}
              className={cn(
                "home-starters__chip control-neu",
                "inline-flex shrink-0 items-center gap-1.5 rounded-full py-1.5 pl-2.5 pr-3 font-sans text-ui font-normal leading-5 text-muted-foreground hover:text-foreground",
                // The fill mode rides in the same variant as the shorthand so it
                // lands after it: before its delay a chip waits unseen instead of
                // showing, blinking out and rising back in.
                "motion-safe:animate-rise-in motion-safe:[animation-fill-mode:backwards]",
                selected && "text-foreground",
              )}
            >
              <Glyph className="size-4 shrink-0" aria-hidden />
              {HOME_STARTER_COPY.chips[id].label}
            </button>
          );
        })}
      </div>

      {open ? (
        <ul
          key={open}
          ref={listRef}
          id={listId}
          aria-label={HOME_STARTER_COPY.promptsLabel}
          className="home-starters__prompts"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeList(open);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              stepPrompt(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              edgePrompt(event.key === "Home" ? "first" : "last");
            }
          }}
        >
          {promptsFor(open, use).map((prompt, i) => (
            <li key={`${prompt.phrase}${prompt.argument ?? ""}`} style={staggerDelay(i, "tight")} className="motion-safe:animate-rise-in motion-safe:[animation-fill-mode:backwards]">
              <button type="button" className="home-starters__prompt" onClick={() => pick(open, prompt)}>
                <span>{prompt.phrase}</span>
                {prompt.argument ? (
                  <>
                    {" "}
                    <bdi translate="no" className="text-foreground">
                      {prompt.argument}
                    </bdi>
                  </>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
