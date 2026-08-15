"use client";

import * as React from "react";
import { Bug, Database, GitPullRequest, Layers, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CodePreset {
  id: string;
  icon: React.ElementType;
  title: string;
  category: string;
  prompt: string;
  description: string;
}

export const CODE_PRESETS: CodePreset[] = [
  {
    id: "feature",
    icon: Layers,
    category: "Feature",
    title: "Full-Stack Feature",
    description: "Build an end-to-end endpoint, database model, and interactive UI component.",
    prompt: "Implement a full-stack feature: define the API endpoint with validation, create the database query/migration, and build the responsive UI component with proper loading and error states.",
  },
  {
    id: "debug",
    icon: Bug,
    category: "Debug",
    title: "Fix Failing Tests",
    description: "Analyze test failures, locate root cause, and apply regression fixes.",
    prompt: "Run the test suite, diagnose any failing assertions or stack traces, identify the root cause, and implement a clean fix with regression test coverage.",
  },
  {
    id: "refactor",
    icon: Zap,
    category: "Optimize",
    title: "Refactor & Performance",
    description: "Optimize runtime bottlenecks, clean up types, and eliminate dead code.",
    prompt: "Refactor this module for improved performance and clarity: clean up strict TypeScript types, remove duplicate logic, and optimize render/compute bottlenecks.",
  },
  {
    id: "review",
    icon: GitPullRequest,
    category: "Review",
    title: "PR & Code Review",
    description: "Review git changes for breaking diffs, edge cases, and best practices.",
    prompt: "Review the recent git changes and diffs: check for edge cases, potential memory leaks, security issues, and recommend concrete improvements.",
  },
  {
    id: "database",
    icon: Database,
    category: "Database",
    title: "Schema & Migrations",
    description: "Design relational models, create migrations, and write query helpers.",
    prompt: "Design the database schema updates: write the migration file with indexes and relations, and provide typed query helper functions.",
  },
  {
    id: "security",
    icon: ShieldCheck,
    category: "Security",
    title: "Security & Auth Audit",
    description: "Audit endpoints for authentication flaws, CSRF, and input validation.",
    prompt: "Perform a security audit across the codebase: verify authentication middleware, validate and sanitize inputs, check rate limiting, and identify potential OWASP vulnerabilities.",
  },
];

interface CodePresetsGridProps {
  onSelectPreset: (preset: CodePreset) => void;
  className?: string;
}

export function CodePresetsGrid({ onSelectPreset, className }: CodePresetsGridProps) {
  return (
    <div className={cn("w-full max-w-[44rem]", className)}>
      <div className="mb-2.5 flex items-center justify-between px-1">
        <span className="font-mono text-caption uppercase tracking-wider text-muted-foreground/70">
          Suggested Workflows
        </span>
        <span className="flex items-center gap-1 font-mono text-caption text-muted-foreground/60">
          <Sparkles className="size-3 text-primary/70" />
          <span>One-click start</span>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {CODE_PRESETS.map((preset) => {
          const Icon = preset.icon;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelectPreset(preset)}
              className="group relative flex flex-col items-start gap-1.5 rounded-2xl border border-border/50 bg-card/60 p-3 text-left shadow-sm backdrop-blur-sm transition-all duration-fast hover:border-primary/40 hover:bg-card hover:shadow-md active:scale-[0.98] dark:bg-[#151517]/60 dark:hover:bg-[#1a1a1d]"
            >
              <div className="flex w-full items-center justify-between">
                <div className="flex size-7 items-center justify-center rounded-lg border border-border/60 bg-muted/30 text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:bg-primary/10 group-hover:text-primary">
                  <Icon className="size-3.5" />
                </div>
                <span className="font-mono text-micro text-muted-foreground/70 group-hover:text-primary/90 transition-colors">
                  {preset.category}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-xs font-semibold text-foreground group-hover:text-primary transition-colors">
                  {preset.title}
                </span>
                <p className="line-clamp-2 text-caption leading-snug text-muted-foreground mt-0.5">
                  {preset.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
