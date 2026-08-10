"use client";

import Link from "next/link";
import { ChevronRight, Sparkles } from "lucide-react";
import { trustPermitsAutoSelection, type ClientWorkSkill } from "@/lib/work/skills";
import { workTimeAgo } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

/*
 * One skill in a list.
 *
 * The two facts worth putting on a row are the two that decide whether it can
 * run at all: whether it is switched on, and whether Juno may reach for it
 * without being asked. They are stored in separate columns and only the pair is
 * the answer — `autoSelect: true` on an untrusted skill is a contradiction the
 * server clamps on write, and `trustPermitsAutoSelection` is the same reader
 * every other surface uses to resolve it, imported rather than re-implemented.
 */

const TRUST_LABEL: Record<string, string> = {
  untrusted: "Not trusted",
  user_authored: "Yours",
  verified: "Reviewed by Juno",
};

export function trustLabel(trust: string): string {
  return TRUST_LABEL[trust] ?? trust;
}

export function WorkSkillRow({ skill, index = 0 }: { skill: ClientWorkSkill; index?: number }) {
  const auto = skill.autoSelect && trustPermitsAutoSelection(skill.trust);
  return (
    <Link
      href={`/work/skills/${skill.id}`}
      className={cn(
        "group flex items-start gap-3 rounded-field border border-border/60 bg-card/60 px-3.5 py-3 transition-[background-color,border-color] duration-base ease-out-soft hover:border-border hover:bg-card motion-safe:animate-rise-in",
        "[animation-fill-mode:backwards]",
        !skill.enabled && "opacity-75"
      )}
      style={staggerDelay(index, "tight")}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{skill.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">/{skill.slug}</span>
          {!skill.enabled && (
            <span className="shrink-0 rounded-full border border-border/70 bg-background/50 px-2 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
              Off
            </span>
          )}
          {auto && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background/50 px-2 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
              <Sparkles className="h-2.5 w-2.5" aria-hidden="true" /> Chosen for you
            </span>
          )}
        </span>
        {skill.description.length > 0 && (
          <span className="mt-1 block truncate text-[13px] leading-relaxed text-muted-foreground">
            {skill.description}
          </span>
        )}
        <span className="mt-1.5 block font-mono text-[10px] text-muted-foreground/70">
          v{skill.currentVersion} · {trustLabel(skill.trust)} · {workTimeAgo(skill.updatedAt)}
        </span>
      </span>
      <ChevronRight
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform duration-base ease-out-soft group-hover:translate-x-0.5 group-hover:text-foreground"
        aria-hidden="true"
      />
    </Link>
  );
}
