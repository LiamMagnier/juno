"use client";

import * as React from "react";
import { Bug, Layers, Search, FileCode, Zap } from "lucide-react";

import { Pressable } from "@/components/ui/pressable";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface CodePreset {
  id: string;
  icon: React.ElementType;
  title: string;
  prompt: string;
}

export const CODE_PRESETS: CodePreset[] = [
  {
    id: "feature",
    icon: FileCode,
    title: "Scaffold a feature",
    prompt: "Implement a new feature with clean architecture, types, API endpoint, and unit tests.",
  },
  {
    id: "audit",
    icon: Search,
    title: "Audit the codebase",
    prompt: "Audit this codebase for architectural patterns, performance bottlenecks, and security vulnerabilities.",
  },
  {
    id: "refactor",
    icon: Zap,
    title: "Refactor and clean",
    prompt: "Refactor and modernize this code to reduce technical debt, remove duplicates, and improve type safety.",
  },
  {
    id: "tests",
    icon: Layers,
    title: "Generate tests",
    prompt: "Write comprehensive unit and integration tests covering core workflows and edge cases.",
  },
  {
    id: "debug",
    icon: Bug,
    title: "Fix a bug",
    prompt: "Diagnose and fix the root cause of this error. Propose the cleanest, most reliable regression patch.",
  },
];

interface CodePresetsGridProps {
  onSelectPreset: (preset: CodePreset) => void;
  className?: string;
}

/**
 * Starting points under the composer: small raised tiles, the same
 * `control-neu` material as every other pressable tile in the product, dealt
 * out on the shared stagger.
 */
export function CodePresetsGrid({ onSelectPreset, className }: CodePresetsGridProps) {
  return (
    <ul
      role="list"
      aria-label="Starting points"
      className={cn("flex w-full max-w-[42rem] flex-wrap items-center justify-center gap-2", className)}
    >
      {CODE_PRESETS.map((preset, i) => {
        const Icon = preset.icon;
        return (
          <li
            key={preset.id}
            style={staggerDelay(i, "tight")}
            className="[animation-fill-mode:backwards] motion-safe:animate-rise-in"
          >
            <Pressable
              kind="tile"
              size="sm"
              onClick={() => onSelectPreset(preset)}
              className="group h-9 flex-row items-center gap-2 px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <Icon
                className="size-3.5 text-muted-foreground transition-colors duration-fast ease-out-soft group-hover:text-primary motion-reduce:transition-none"
                aria-hidden="true"
              />
              <span>{preset.title}</span>
            </Pressable>
          </li>
        );
      })}
    </ul>
  );
}
