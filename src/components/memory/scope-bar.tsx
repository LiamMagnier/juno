"use client";

import Link from "next/link";
import { ArrowRight } from "@/components/ui/icons";
import { Pressable } from "@/components/ui/pressable";
import { AppIcons } from "@/lib/app-icons";
import type { MemoryScopeOption } from "@/components/memory/memory-model";

/*
 * WHOSE MEMORY — the whole account, or one project.
 *
 * A chat filed in a project reads its memory in isolation: that project's
 * facts and that project's own summary, and nothing else Juno remembers. That
 * is a real boundary with real consequences for what the model is shown, so
 * the page has to be able to show each side of it — not only one long list in
 * which a small "Only in Thesis" chip is the whole explanation.
 *
 * CHIPS, per the shell's third level ("which slice", SurfaceTabs' header):
 * this narrows what the page shows and changes nothing about where the reader
 * is. The row only exists once there is a project to narrow to; an account
 * with no project memory sees the page exactly as before.
 *
 * The caption under a selected project says what the boundary MEANS rather
 * than what the chip does — the one sentence a reader needs to trust that the
 * notes from their thesis are not in their work chats, and the reverse.
 */
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
    <div className="space-y-1.5">
      <div
        role="group"
        aria-label="Show memory from"
        // overflow-x clips the block axis too, so the vertical padding is the
        // room a focused chip's outline needs — the connector directory's
        // chip row makes the same trade for the same reason.
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
              className="shrink-0 whitespace-nowrap"
            >
              {scope.id && <AppIcons.projects className="size-3.5" aria-hidden="true" />}
              {scope.label}
              <span className="font-mono text-micro tabular-nums opacity-70">{scope.count.toLocaleString()}</span>
            </Pressable>
          );
        })}
      </div>

      {selected.id && (
        // Keyed on the project so the line re-enters with the subject it
        // describes, rather than swapping its words in place.
        <p
          key={selected.id}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground motion-safe:animate-fade-in"
        >
          <span>
            Only chats in {selected.label} read this, and they read nothing else Juno remembers about you.
          </span>
          <Link
            href={`/projects/${encodeURIComponent(selected.id)}`}
            className="inline-flex items-center gap-1 rounded-xs font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
          >
            Open project
            {/* Its own nudge-r articulation plays on the link's hover. */}
            <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        </p>
      )}
    </div>
  );
}
