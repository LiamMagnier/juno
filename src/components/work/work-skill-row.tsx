"use client";

import Link from "next/link";
import { ChevronRight, Wrench } from "lucide-react";
import { trustPermitsAutoSelection, type ClientWorkSkill } from "@/lib/work/skills";
import { WorkTag, workTimeAgo } from "@/components/work/work-vocabulary";
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
        // The same rest/hover/press/focus set WorkSessionRow carries. These
        // three sibling rows are the same object in three lists and had neither a
        // focus ring — a keyboard reader could not see which row they were on —
        // nor any press feedback.
        "group flex items-start gap-3 rounded-field border border-border/60 bg-card px-3.5 py-3 transition-[background-color,border-color,transform] duration-base ease-out-soft hover:border-border hover:bg-secondary motion-safe:animate-rise-in",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.997]",
        "[animation-fill-mode:backwards]",
        !skill.enabled && "opacity-75"
      )}
      style={staggerDelay(index, "tight")}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* `text-body`, matching the task row's title — see the note there. */}
          <span className="min-w-0 truncate text-body font-medium leading-snug text-foreground">
            {skill.name}
          </span>
          <span className="shrink-0 font-mono text-micro text-muted-foreground">/{skill.slug}</span>
          {!skill.enabled && <WorkTag>Off</WorkTag>}
          {auto && <WorkTag icon={Wrench}>Chosen for you</WorkTag>}
        </span>
        {skill.description.length > 0 && (
          <span className="mt-1 block truncate text-ui leading-relaxed text-muted-foreground">
            {skill.description}
          </span>
        )}
        <span className="mt-1.5 block font-mono text-micro tabular-nums text-muted-foreground">
          v{skill.currentVersion} · {trustLabel(skill.trust)} · {workTimeAgo(skill.updatedAt)}
        </span>
      </span>
      <ChevronRight
        className="mt-0.5 size-4 shrink-0 text-muted-foreground/70 transition-[transform,color] duration-base ease-out-soft group-hover:translate-x-0.5 group-hover:text-foreground"
        aria-hidden="true"
      />
    </Link>
  );
}
