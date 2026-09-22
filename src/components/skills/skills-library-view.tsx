"use client";

import * as React from "react";
import { Search } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { Pressable } from "@/components/ui/pressable";
import { Skeleton } from "@/components/ui/skeleton";
import { GitHubMark } from "@/components/connections/connector-logos";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { WorkLoadError } from "@/components/work/shell/work-states";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import type { LibrarySkill, LibrarySource, SkillLibrary } from "@/lib/skills/library-contract";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AddSkillMenu } from "@/components/skills/add-skill-menu";
import { SkillRow, skillLibraryRowClass } from "@/components/skills/skill-row";
import { SkillSourceGroup } from "@/components/skills/skill-source-group";
import { SkillSourceAvatar } from "@/components/skills/skill-source-avatar";
import {
  POPULAR_SKILL_SOURCES,
  filterLibrary,
  listedSkillCount,
} from "@/components/skills/skill-library-model";

export interface SkillsLibraryActions {
  onToggleSkill: (skill: LibrarySkill, enabled: boolean) => void;
  onToggleSource: (source: LibrarySource, enabled: boolean) => void;
  onCheckUpdates: (source: LibrarySource) => void;
  onRemoveSource: (source: LibrarySource) => void;
  /** Opens the importer, prefilled with a repository when one was picked. */
  onImport: (repository?: string) => void;
  onWrite: () => void;
  onCreateWithJuno: () => void;
}

const OPEN_KEY = "juno:skills:open-sources";

function readOpenSources(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Which folders are open, remembered per source in this browser.
 *
 * A convenience, not state anybody else needs, so it lives in localStorage and
 * a private window simply starts with everything closed. A source holding a
 * single skill starts open: a folder you have to open to find one thing in is
 * a folder in the way.
 */
function useOpenSources(initial?: Record<string, boolean>) {
  const [open, setOpen] = React.useState<Record<string, boolean>>(initial ?? {});
  React.useEffect(() => {
    if (initial) return;
    setOpen(readOpenSources());
  }, [initial]);
  const isOpen = React.useCallback(
    (source: LibrarySource) => open[source.id] ?? source.skills.length === 1,
    [open]
  );
  const setSourceOpen = React.useCallback((id: string, next: boolean) => {
    setOpen((current) => {
      const updated = { ...current, [id]: next };
      try {
        window.localStorage.setItem(OPEN_KEY, JSON.stringify(updated));
      } catch {
        // Storage refused (private window, quota): the folder still opens, it
        // just will not remember.
      }
      return updated;
    });
  }, []);
  return { isOpen, setSourceOpen };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * The skills library, drawn from data it is handed.
 *
 * No fetching here, on purpose: the route composes this with
 * `useSkillLibrary` and the dialogs, and the dev gallery renders the same
 * component against fixtures, so what the gallery shows is what ships.
 *
 * TWO SECTIONS, TWO LEVELS. "Your skills" is flat: the skills written here or
 * saved from a run. "Installed" is one folder per repository, each with its
 * skills inside. Nothing deeper: it is the shape Claude's plugins, Claude
 * Code's marketplaces and `npx skills` all settled on, and it is what makes
 * "remove this repository" a verb.
 *
 * SEARCH covers both sections, opens every folder with a match in it, and
 * shows only the matching skills inside. `/` focuses it from anywhere on the
 * page that is not already a text field, the way skills.sh and GitHub do.
 */
export function SkillsLibraryView({
  library,
  error,
  onRetry,
  actions,
  skillHref,
  highlightSourceId = null,
  initialOpenSources,
}: {
  /** Null while the first read is in flight. */
  library: SkillLibrary | null;
  /** The sentence for a failed read, or null. */
  error: string | null;
  onRetry: () => void;
  actions: SkillsLibraryActions;
  skillHref: (skill: LibrarySkill) => string;
  /** A source an install just landed in: opened, scrolled to and flashed once. */
  highlightSourceId?: string | null;
  /** Fixture override for which folders start open (the dev gallery). */
  initialOpenSources?: Record<string, boolean>;
}) {
  const [query, setQuery] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);
  const { isOpen, setSourceOpen } = useOpenSources(initialOpenSources);

  // The rows are dealt in once, when the library first lands. A search that
  // brings a row back, or a toggle that re-renders one, is not a reveal.
  const [dealt, setDealt] = React.useState(false);
  React.useEffect(() => {
    if (library === null || dealt) return;
    const id = window.setTimeout(() => setDealt(true), 700);
    return () => window.clearTimeout(id);
  }, [library, dealt]);
  const enter = (index: number) =>
    dealt
      ? {}
      : {
          className: "motion-safe:animate-rise-in [animation-fill-mode:backwards]",
          style: staggerDelay(index, "tight"),
        };

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    if (highlightSourceId) setSourceOpen(highlightSourceId, true);
  }, [highlightSourceId, setSourceOpen]);

  const filtered = library ? filterLibrary(library, query) : null;
  const hasAny = library !== null && (library.yours.length > 0 || library.sources.length > 0);

  return (
    <AppPage measure="reading">
      <AppPageHeader
        heading="Skills"
        lede="Instructions Juno follows for a specific job. Type / in chat to use one."
        actions={
          <AddSkillMenu
            onImport={() => actions.onImport()}
            onWrite={actions.onWrite}
            onCreateWithJuno={actions.onCreateWithJuno}
          />
        }
      />

      {error !== null && library === null ? (
        <WorkLoadError onRetry={onRetry}>{error}</WorkLoadError>
      ) : library === null ? (
        <SkillsLibrarySkeleton />
      ) : !hasAny ? (
        <SkillsEmptyState onImport={actions.onImport} onWrite={actions.onWrite} />
      ) : (
        <>
          <label className="relative mb-7 block">
            <span className="sr-only">Search skills</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              placeholder="Search skills"
              className="surface-inset h-10 w-full rounded-field border border-input pl-10 pr-12 text-ui outline-none transition-[border-color] duration-fast ease-out-soft placeholder:text-muted-foreground hover:border-foreground/60 focus-visible:border-foreground/70 coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
            />
            <Kbd
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 transition-opacity duration-fast ease-out-soft coarse:hidden",
                query && "opacity-0"
              )}
            >
              /
            </Kbd>
          </label>

          {filtered !== null && filtered.empty ? (
            <EmptyState
              size="panel"
              icon={Search}
              title={
                <>
                  No skills match <span className="text-foreground">“{query.trim()}”</span>
                </>
              }
              action={
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => actions.onImport()}>
                  <GitHubMark className="size-3.5" />
                  Import from GitHub
                </Button>
              }
            />
          ) : null}

          {filtered !== null && filtered.yours.length > 0 ? (
            <LibrarySection title="Your skills" count={filtered.yours.length}>
              {filtered.yours.map((skill, index) => {
                const motion = enter(index);
                return (
                  <SkillRow
                    key={skill.id}
                    skill={skill}
                    href={skillHref(skill)}
                    onToggle={(enabled) => actions.onToggleSkill(skill, enabled)}
                    className={motion.className}
                    style={motion.style}
                  />
                );
              })}
            </LibrarySection>
          ) : null}

          {filtered !== null && filtered.sources.length > 0 ? (
            <LibrarySection title="Installed" count={filtered.sources.length}>
              {filtered.sources.map(({ source, skills }, index) => {
                const motion = enter(filtered.yours.length + index);
                return (
                  <SkillSourceGroup
                    key={source.id}
                    source={source}
                    skills={skills}
                    // A search opens every folder it found something in, without
                    // remembering that as the reader's choice.
                    expanded={filtered.searching || isOpen(source)}
                    onExpandedChange={(open) => setSourceOpen(source.id, open)}
                    onToggleSource={(enabled) => actions.onToggleSource(source, enabled)}
                    onToggleSkill={actions.onToggleSkill}
                    onCheckUpdates={() => actions.onCheckUpdates(source)}
                    onRemove={() => actions.onRemoveSource(source)}
                    skillHref={skillHref}
                    highlight={highlightSourceId === source.id}
                    className={motion.className}
                    style={motion.style}
                  />
                );
              })}
            </LibrarySection>
          ) : null}

          {library.truncated ? (
            <p className="mt-4 text-caption text-muted-foreground">
              Showing <span className="tabular-nums">{listedSkillCount(library)}</span> of{" "}
              <span className="tabular-nums">{library.total}</span> skills. Search to find the rest.
            </p>
          ) : null}
        </>
      )}
    </AppPage>
  );
}

function LibrarySection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="mb-8 last:mb-0">
      <h2 id={id} className="mb-2.5 flex items-baseline gap-2 text-body font-semibold text-foreground">
        {title}
        <span className="text-ui font-normal tabular-nums text-muted-foreground">{count}</span>
      </h2>
      {/* The container draws the hairlines and clips the rows' hover fill to
          its corners; the rows themselves stay square and flat. */}
      <div role="list" className="overflow-hidden rounded-card border border-border divide-y divide-border/70">
        {children}
      </div>
    </section>
  );
}

/**
 * Three rows at the height the real ones settle at, under the search field's
 * footprint, so nothing moves when the library lands. `loading.tsx` draws the
 * same component under the header skeleton.
 */
export function SkillsLibrarySkeleton() {
  return (
    <div role="status" aria-label="Loading skills">
      <Skeleton className="mb-7 h-10 w-full rounded-field" />
      <Skeleton className="mb-2.5 h-5 w-28 rounded-sm" />
      <div className="overflow-hidden rounded-card border border-border divide-y divide-border/70">
        {[0, 1, 2].map((row) => (
          <div key={row} className={cn(skillLibraryRowClass, "hover:bg-transparent")}>
            <Skeleton className="size-7 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40 max-w-full rounded-sm" />
              <Skeleton className="h-3.5 w-72 max-w-full rounded-sm" />
            </div>
            <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
            <span className="size-4 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Nothing installed and nothing written.
 *
 * It teaches by offering: three repositories one press away, and a way to
 * write one. No paragraph about what a skill is; the lede above already said
 * it in one line.
 */
export function SkillsEmptyState({
  onImport,
  onWrite,
}: {
  onImport: (repository?: string) => void;
  onWrite: () => void;
}) {
  return (
    <EmptyState
      icon={AppIcons.skills}
      title="No skills yet"
      description="Install a set from GitHub, or write your own."
      action={
        <div className="flex flex-col items-center gap-5">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {/* Secondary, not the accent: the header's Add is the page's one
                primary action, and it offers these same doors. */}
            <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => onImport()}>
              <GitHubMark className="size-3.5" />
              Import from GitHub
            </Button>
            <Button size="sm" variant="secondary" className="gap-1.5" onClick={onWrite}>
              <ActionIcons.edit className="size-3.5" aria-hidden="true" />
              Write one
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            <span className="mr-1 text-caption text-muted-foreground">Popular</span>
            {POPULAR_SKILL_SOURCES.map(({ owner, repo }) => (
              <Pressable
                key={`${owner}/${repo}`}
                kind="chip"
                onClick={() => onImport(`${owner}/${repo}`)}
                className="gap-1.5 pl-1.5"
              >
                <SkillSourceAvatar owner={owner} size="xs" />
                <span translate="no">
                  {owner}/{repo}
                </span>
              </Pressable>
            ))}
          </div>
        </div>
      }
    />
  );
}
