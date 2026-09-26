"use client";

import * as React from "react";
import Link from "next/link";

import { StartingTileBody, startingGridClass, startingTileClass } from "@/components/ui/starting-tile";
import { CODE_COMPOSER_SEED_EVENT } from "@/components/code/code-seed";
import { BookOpen, Wrench, type IconComponent } from "@/components/ui/icons";
import { AppIcons } from "@/lib/app-icons";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Four starting points under the Code composer, in the same tile Chat uses.
 *
 * Three SEED the field with a prompt worth editing (the repository and the
 * place it runs are the chips above the field, so a prompt never has to name
 * them), and never start a session: a run clones a repository and spends the
 * account's usage window, which is not a click's decision. The fourth is a
 * real destination, the pull requests Juno is waiting on you to review.
 *
 * `CODE_STARTER_COPY` ends in "Copy" so the i18n extractor collects it.
 */
const CODE_STARTER_COPY: ReadonlyArray<
  { label: string; hint: string; icon: IconComponent } & ({ prompt: string } | { href: string })
> = [
  {
    label: "Fix a bug",
    hint: "Find the real cause",
    icon: Wrench,
    prompt: "Find out why the failing test is failing, fix the cause, and run the tests to confirm.",
  },
  {
    label: "Build a feature",
    hint: "Small, with tests",
    icon: AppIcons.code,
    prompt: "Add a small feature: ",
  },
  {
    label: "Explain the code",
    hint: "Map the repository",
    icon: BookOpen,
    prompt: "Explain how this repository is organised, where the entry points are, and how a request flows through it.",
  },
  {
    label: "Review changes",
    hint: "Open pull requests",
    icon: AppIcons.pulls,
    href: "/code/pulls",
  },
];

export function CodeStartingPoints({ className }: { className?: string }) {
  return (
    <div className={cn(startingGridClass, "mt-3", className)}>
      {CODE_STARTER_COPY.map((item, i) => {
        const body = <StartingTileBody icon={item.icon} label={item.label} hint={item.hint} />;
        const style = staggerDelay(i, "tight", 120);
        if ("href" in item) {
          return (
            <Link key={item.label} href={item.href} className={startingTileClass} style={style}>
              {body}
            </Link>
          );
        }
        return (
          <button
            key={item.label}
            type="button"
            className={startingTileClass}
            style={style}
            onClick={() => window.dispatchEvent(new CustomEvent(CODE_COMPOSER_SEED_EVENT, { detail: item.prompt }))}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}
