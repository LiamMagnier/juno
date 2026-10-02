"use client";

import Link from "next/link";
import { ArrowRight, ChevronDown } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { Pressable } from "@/components/ui/pressable";
import { AppIcons } from "@/lib/app-icons";
import type { MemoryScopeOption } from "@/components/memory/memory-model";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * WHOSE MEMORY: the whole account, or one project.
 *
 * A chat filed in a project reads its memory in isolation: that project's
 * facts and its own summary, and nothing else Juno remembers. That is a real
 * boundary with real consequences for what the model is shown, so the page can
 * show each side of it. The control only exists once there is a project to
 * narrow to; an account with no project memory never sees it.
 *
 * Chips while there are few enough to read in one line, a menu once there are
 * not: a strip of eleven chips scrolling sideways is a list pretending to be a
 * filter. The caption under a selected project says what the boundary MEANS,
 * which is the one sentence a reader needs to trust that notes from their
 * thesis are not in their work chats.
 */

/** Everything plus four projects still reads as one row of chips. */
const MAX_CHIPS = 5;

export function ScopeBar({
  scopes,
  value,
  onChange,
}: {
  scopes: readonly MemoryScopeOption[];
  value: string | null;
  onChange: (scope: string | null) => void;
}) {
  if (scopes.length < 2) return null;
  const selected = scopes.find((scope) => scope.id === value) ?? scopes[0];

  return (
    <div className="space-y-2">
      {scopes.length <= MAX_CHIPS ? (
        <div
          role="group"
          aria-label="Show memory from"
          // overflow-x clips the block axis too, so the vertical padding is the
          // room a focused chip's outline needs.
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {scopes.map((scope) => {
            const active = scope.id === selected.id;
            return (
              <Pressable
                key={scope.id ?? "everything"}
                kind="chip"
                size="lg"
                selected={active}
                aria-pressed={active}
                onClick={() => onChange(scope.id)}
                className="shrink-0 gap-1.5 whitespace-nowrap"
              >
                {scope.id && <AppIcons.projects className="size-3.5" aria-hidden="true" />}
                <span translate={scope.id ? "no" : undefined}>{scope.label}</span>
                <span className="tabular-nums text-muted-foreground">{scope.count.toLocaleString()}</span>
              </Pressable>
            );
          })}
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" aria-label="Show memory from">
              {selected.id && <AppIcons.projects className="size-3.5" aria-hidden="true" />}
              <span translate={selected.id ? "no" : undefined}>{selected.label}</span>
              <span className="tabular-nums text-muted-foreground">{selected.count.toLocaleString()}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={MENU_W_WIDE}>
            <DropdownMenuRadioGroup value={selected.id ?? ""} onValueChange={(id) => onChange(id || null)}>
              {scopes.map((scope) => (
                <DropdownMenuRadioItem key={scope.id ?? "everything"} value={scope.id ?? ""}>
                  <span translate={scope.id ? "no" : undefined} className="min-w-0 flex-1 truncate">
                    {scope.label}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{scope.count.toLocaleString()}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {selected.id && (
        // Keyed on the project so the line re-enters with the subject it
        // describes, rather than swapping its words in place.
        <p key={selected.id} className="text-caption text-muted-foreground motion-safe:animate-fade-in">
          <span>{`Only chats in this project use these memories, and they use nothing else ${PRODUCT_NAME} remembers.`}</span>{" "}
          <Link
            href={`/projects/${encodeURIComponent(selected.id)}`}
            className="inline-flex items-center gap-1 rounded-xs font-medium text-foreground underline-offset-2 hover:underline"
          >
            Open project
            <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        </p>
      )}
    </div>
  );
}
