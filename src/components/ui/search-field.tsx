"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { Loader2, Search, X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/** A search stays focused when cleared, so refining a query is one gesture. */
export function SearchField({
  value,
  onValueChange,
  label,
  placeholder = label,
  busy = false,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder?: string;
  busy?: boolean;
  className?: string;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <div className={cn("relative min-w-0", className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-muted-foreground" aria-hidden="true">
        {busy ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <Search className="size-4" />}
      </span>
      <Input
        ref={input}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onValueChange("");
          }
        }}
        aria-label={label}
        aria-busy={busy || undefined}
        placeholder={placeholder}
        className="pl-9 pr-11 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <Pressable
          kind="icon"
          size="sm"
          className="absolute right-1 top-1/2 -translate-y-1/2 coarse:right-0.5"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => {
            onValueChange("");
            input.current?.focus();
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
        </Pressable>
      )}
    </div>
  );
}
