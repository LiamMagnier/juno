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

  if (chips.length === 0) return null;

  return (
    <div
      className="home-starters"
      data-shown={shown ? "" : undefined}
      aria-hidden={!shown || undefined}
      inert={!shown}
    >
      <div className="home-starters__chips no-scrollbar" role="group" aria-label={HOME_STARTER_COPY.groupLabel}>
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
              onClick={() => setOpen(selected ? null : id)}
              style={staggerDelay(i, "base", CHIPS_ENTER_AFTER_MS)}
              className={cn(
                "home-starters__chip control-neu",
                "inline-flex shrink-0 items-center gap-1.5 rounded-full py-1.5 pl-2.5 pr-3 font-sans text-ui font-normal leading-5 text-muted-foreground hover:text-foreground",
                "[animation-fill-mode:backwards] motion-safe:animate-rise-in",
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
          id={listId}
          aria-label={HOME_STARTER_COPY.promptsLabel}
          className="home-starters__prompts"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeList(open);
            }
          }}
        >
          {promptsFor(open, use).map((prompt, i) => (
            <li key={`${prompt.phrase}${prompt.argument ?? ""}`} style={staggerDelay(i, "tight")} className="[animation-fill-mode:backwards] motion-safe:animate-rise-in">
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
