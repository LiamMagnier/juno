"use client";

import * as React from "react";
import { Bug, Layers, Search, FileCode, Zap } from "lucide-react";
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
    title: "Scaffold Feature",
    prompt: "Implement a new feature with clean architecture, types, API endpoint, and unit tests.",
  },
  {
    id: "audit",
    icon: Search,
    title: "Codebase Audit",
    prompt: "Audit this codebase for architectural patterns, performance bottlenecks, and security vulnerabilities.",
  },
  {
    id: "refactor",
    icon: Zap,
    title: "Refactor & Clean",
    prompt: "Refactor and modernize this code to reduce technical debt, remove duplicates, and improve type safety.",
  },
  {
    id: "tests",
    icon: Layers,
    title: "Generate Tests",
    prompt: "Write comprehensive unit and integration tests covering core workflows and edge cases.",
  },
  {
    id: "debug",
    icon: Bug,
    title: "Fix Bug",
    prompt: "Diagnose and fix the root cause of this error. Propose the cleanest, most reliable regression patch.",
  },
];

interface CodePresetsGridProps {
  onSelectPreset: (preset: CodePreset) => void;
  className?: string;
}

export function CodePresetsGrid({ onSelectPreset, className }: CodePresetsGridProps) {
  return (
    <div className={cn("flex w-full max-w-[42rem] flex-wrap items-center justify-center gap-2 pt-1", className)}>
      {CODE_PRESETS.map((preset) => {
        const Icon = preset.icon;
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => onSelectPreset(preset)}
            className="group inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/40 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-all duration-150 hover:border-border hover:bg-secondary hover:text-foreground active:scale-[0.97] dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
          >
            <Icon className="size-3 text-muted-foreground/80 transition-colors group-hover:text-primary" />
            <span>{preset.title}</span>
          </button>
        );
      })}
    </div>
  );
}
