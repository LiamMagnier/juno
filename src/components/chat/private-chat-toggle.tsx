"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
          aria-label={active ? "Leave private chat" : "Start private chat"}
          aria-pressed={active}
          disabled={disabled}
          onClick={onToggle}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          className={cn(
            "group inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground/75 transition-all duration-base ease-out-soft hover:-translate-y-0.5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
            active && "text-primary"
          )}
        >
          <svg
            viewBox="0 0 48 48"
            className="h-5 w-5 overflow-visible transition-transform duration-base ease-out-soft group-hover:-translate-y-0.5 group-hover:scale-105"
            aria-hidden="true"
          >
            <path
              d="M9.5 39V21C9.5 12 16 6.5 24 6.5S38.5 12 38.5 21v18c0 1.7-1.9 2.6-3.2 1.6l-3.4-2.6-3.4 2.6a2.5 2.5 0 0 1-3.1 0L22 38l-3.4 2.6a2.5 2.5 0 0 1-3.1 0l-3.4-2.6-3.4 2.6C11.4 41.6 9.5 40.7 9.5 39Z"
              className="fill-background stroke-current transition-colors duration-base"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <g
              className="transition-transform duration-fast ease-out-soft"
              style={{ transform: "translate(var(--ghost-eye-x, 0px), var(--ghost-eye-y, 0px))" }}
            >
              <circle cx="19" cy="22" r="2.4" fill="currentColor" />
              <circle cx="29" cy="22" r="2.4" fill="currentColor" />
            </g>
            <path
              d="M20.5 30c1.7 1.4 5.3 1.4 7 0"
              className="stroke-current opacity-70 transition-opacity group-hover:opacity-100"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent>{active ? "Private chat is on. Nothing is saved." : "Start private chat"}</TooltipContent>
    </Tooltip>
  );
}
