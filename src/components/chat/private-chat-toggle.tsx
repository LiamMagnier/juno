"use client";

import * as React from "react";
import { GHOST } from "@/components/ui/juno-glyph-paths";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The incognito switch in the chat root's header cluster.
 *
 * "Incognito", everywhere the mode is named: the toggle, its tooltip, the
 * banner and the transcript heading. The same mode used to be "private chat"
 * on this button and "incognito" on the page it turned on, which read as two
 * features.
 *
 * THE GHOST IS A BESPOKE JUNO MARK, not an interface glyph, and it is kept on
 * purpose. A stock eye-with-a-slash was tried in its place and rejected: it is
 * the set's general "hide" drawing, and at rest (private mode OFF) a slashed
 * eye reads as if privacy were already on. If it ever moves into the icon
 * set, it goes in as its own drawing on the 256 grid with a regular and a fill
 * cut, and the pointer-tracking eyes stay unless the owner signs off on
 * dropping them.
 *
 * Its geometry lives in `juno-glyph-paths.ts` (`GHOST`) because the native
 * apps do carry it in their icon set — `juno.ghost`, with still eyes, at the
 * set's line, plus a `fill` cut for the "on" state. One drawing, two readers.
 */
export function PrivateChatToggle({
  active,
  disabled,
  onToggle,
}: {
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  const onPointerMove = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    event.currentTarget.style.setProperty("--ghost-eye-x", `${Math.max(-1, Math.min(1, x)) * 2.5}px`);
    event.currentTarget.style.setProperty("--ghost-eye-y", `${Math.max(-1, Math.min(1, y)) * 2}px`);
  }, []);

  const onPointerLeave = React.useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    button.style.setProperty("--ghost-eye-x", "0px");
    button.style.setProperty("--ghost-eye-y", "0px");
  }, []);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={buttonRef}
          type="button"
          aria-label={active ? "Leave incognito" : "Turn on incognito"}
          aria-pressed={active}
          disabled={disabled}
          onClick={onToggle}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          className={cn(
            // Was `transition-all`, which swept the disabled opacity fade and the
            // hover lift into one unbounded property list with no reduced-motion
            // escape anywhere on the button or on the nested SVG transforms.
            //
            // Hover is the accent FILL, not a lift: this button is one of three
            // 36px peers in the chat root's cluster (Share, model params), and
            // both neighbours answer hover with bg-accent — a control that
            // levitated instead read as a different species. The levitation
            // wasn't lost; it belongs to the mascot, and the SVG below already
            // floats on group-hover. Press dips at .97 and at --dur-press, same
            // as `.pressable`: transform is in the transition list, so on the
            // base rung alone the dip took 220ms and was felt as lag.
            "group inline-flex size-9 items-center justify-center rounded-full text-foreground/75 transition-[color,background-color,transform] duration-base ease-out-soft hover:bg-accent hover:text-foreground active:scale-[0.97] active:duration-press disabled:pointer-events-none disabled:opacity-50 coarse:size-11",
            "motion-reduce:transition-none motion-reduce:active:scale-100",
            active && "text-primary"
          )}
        >
          <svg
            viewBox={`0 0 ${GHOST.viewBox} ${GHOST.viewBox}`}
            className="size-5 overflow-visible transition-transform duration-base ease-out-soft group-hover:-translate-y-0.5 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 motion-reduce:group-hover:scale-100"
            aria-hidden="true"
          >
            <path
              d={GHOST.body}
              className="fill-background stroke-current transition-colors duration-base"
              strokeWidth={GHOST.line}
              strokeLinejoin="round"
            />
            <g
              className="transition-transform duration-fast ease-out-soft"
              style={{ transform: "translate(var(--ghost-eye-x, 0px), var(--ghost-eye-y, 0px))" }}
            >
              {GHOST.eyes.map((eye) => (
                <circle key={eye.cx} cx={eye.cx} cy={eye.cy} r={eye.r} fill="currentColor" />
              ))}
            </g>
            <path
              d={GHOST.smile}
              className="stroke-current opacity-70 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 motion-reduce:transition-none"
              strokeWidth={GHOST.line}
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent>{active ? "Incognito is on. Nothing is saved." : "Turn on incognito"}</TooltipContent>
    </Tooltip>
  );
}
