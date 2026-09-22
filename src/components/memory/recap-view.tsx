"use client";

import * as React from "react";
import { AnimatePresence } from "framer-motion";
import { ArrowRight, CalendarClock, EyeOff, MessagesSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { RollingNumber } from "@/components/ui/micro";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { EntryRow } from "@/components/memory/entry-row";
import type { Memory } from "@/components/memory/memory-model";
import { memoryCategoryLabel } from "@/lib/memory-categories";
import { buildMemoryRecap, recapIsEmpty, type RecapPeriod } from "@/lib/memory-recap";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/*
 * The recap: what changed in what Juno knows, over a period you choose.
 *
 * Built as a review, not a report — see src/lib/memory-recap.ts. The month's
 * new beliefs come first and each is a full row, correctable in place, because
 * the moment a person is most likely to notice "that's not true" is when the
 * thing is shown to them next to the week it was learned.
 *
 * MOTION. Changing the period keeps the stat tiles mounted, so their numbers
 * ROLL from the old count to the new one — the counts are the thing that
 * changed, and a number that travels says "more than last week" in a way a
 * number that is replaced does not. The lists below are keyed on the period
 * and re-enter, section by section at the base stagger, because they are
 * genuinely different content rather than the same content moving.
 */

const PERIOD_LABEL: Record<RecapPeriod, string> = { 7: "week", 30: "month", 90: "three months" };
const LEARNED_PREVIEW = 8;

interface RecapViewProps {
  memories: Memory[];
  busyIds: ReadonlySet<string>;
  paused: boolean;
  /** The page's search, applied to every list here too. */
  query: string;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onForget: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}

export function RecapView({ memories, busyIds, paused, query, onEdit, onForget, onDelete }: RecapViewProps) {
  const [days, setDays] = React.useState<RecapPeriod>(30);
  const [themes, setThemes] = React.useState<string[] | null>(null);
  const [conversations, setConversations] = React.useState<number>(0);
  const [showAllLearned, setShowAllLearned] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setThemes(null);
    setShowAllLearned(false);
    void (async () => {
      try {
        const res = await fetch(`/api/memory/recap?days=${days}`);
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { themes?: string[]; conversations?: number };
        if (cancelled) return;
        setThemes(data.themes ?? []);
        setConversations(data.conversations ?? 0);
      } catch {
        // Themes are the one part that needs the server; without them the
        // recap is still a recap, so an empty list rather than an error.
        if (!cancelled) setThemes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const recap = React.useMemo(() => buildMemoryRecap(memories, { days }), [memories, days]);

  const needle = query.trim().toLowerCase();
  const matches = React.useCallback(
    (...texts: (string | null | undefined)[]) => !needle || texts.some((t) => t?.toLowerCase().includes(needle)),
    [needle]
  );
  const learned = recap.learned.filter((row) => matches(row.content, memoryCategoryLabel(row.category)));
  const replaced = recap.replaced.filter(({ before, after }) => matches(before.content, after?.content));
  const conflicting = recap.conflicting.filter((row) => matches(row.content));
  const forgotten = recap.forgotten.filter((row) => matches(row.content));
  const expired = recap.expired.filter((row) => matches(row.content));
  const leanedOn = recap.leanedOn.filter((row) => matches(row.content));
  const shownThemes = (themes ?? []).filter((theme) => matches(theme));

  const byId = React.useMemo(() => new Map(memories.map((m) => [m.id, m])), [memories]);
  const learnedRows = learned.map((row) => byId.get(row.id)).filter((m): m is Memory => !!m);
  const visibleLearned = showAllLearned ? learnedRows : learnedRows.slice(0, LEARNED_PREVIEW);

  const empty =
    themes !== null &&
    recapIsEmpty(
      { ...recap, learned, replaced, conflicting, forgotten, expired, leanedOn },
      shownThemes
    );

  let section = 0;
  const nextDelay = () => staggerDelay(section++, "base");

  return (
    <section aria-labelledby="memory-recap-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="memory-recap-heading" className="font-sans text-heading">
          Your last {PERIOD_LABEL[days]}
        </h2>
        <SegmentedControl<`${RecapPeriod}`>
          value={`${days}`}
          onChange={(value) => setDays(Number(value) as RecapPeriod)}
          ariaLabel="Recap period"
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
        />
      </div>

      {/* Mounted across period changes on purpose — see the header. */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <RecapStat label="Learned" value={learned.length} tone="primary" />
        <RecapStat label="Changed" value={replaced.length + conflicting.length} />
        <RecapStat label="Let go" value={forgotten.length + expired.length} />
        <RecapStat label="Chats" value={conversations} />
      </div>

      <div key={days} className="space-y-4 motion-safe:animate-fade-in">
        {empty ? (
          <EmptyState
            size="panel"
            icon={CalendarClock}
            title={needle ? "Nothing in this period matches" : `A quiet ${PERIOD_LABEL[days]}`}
            description={
              needle
                ? "Clear the search, or try a longer period."
                : "Juno didn’t learn, change or use anything in this stretch. Try a longer period."
            }
          />
        ) : (
          <>
            {learnedRows.length > 0 && (
              <RecapSection title="What Juno learned" style={nextDelay()}>
                <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                  {recap.learnedByCategory.map(({ category, count }) => (
                    <Badge key={category ?? "none"} variant="soft" className="gap-1.5">
                      {memoryCategoryLabel(category)}
                      <span className="font-mono tabular-nums opacity-80">{count}</span>
                    </Badge>
                  ))}
                </div>
                <ul className="divide-y divide-border/50 border-t border-border/50">
                  <AnimatePresence initial={false}>
                    {visibleLearned.map((memory) => (
                      <EntryRow
                        key={memory.id}
                        memory={memory}
                        busy={busyIds.has(memory.id)}
                        paused={paused}
                        onEdit={onEdit}
                        onForget={onForget}
                        onDelete={onDelete}
                      />
                    ))}
                  </AnimatePresence>
                </ul>
                {learnedRows.length > LEARNED_PREVIEW && (
                  <div className="border-t border-border/50 px-4 py-2">
                    <Button variant="ghost" size="sm" onClick={() => setShowAllLearned((open) => !open)}>
                      {showAllLearned ? "Show fewer" : `Show all ${learnedRows.length}`}
                    </Button>
                  </div>
                )}
              </RecapSection>
            )}

            {(replaced.length > 0 || conflicting.length > 0) && (
              <RecapSection title="What changed" style={nextDelay()}>
                <ul className="divide-y divide-border/50 border-t border-border/50">
                  {replaced.map(({ before, after }) => (
                    <li key={before.id} className="px-4 py-3">
                      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-ui">
                        <span className="text-muted-foreground line-through decoration-muted-foreground/50">
                          {before.content}
                        </span>
                        <ArrowRight className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
                        <span className="sr-only">replaced by</span>
                        <span className="text-foreground/90">{after?.content}</span>
                      </p>
                      {before.reason && <p className="mt-1 text-caption italic text-muted-foreground/80">{before.reason}</p>}
                    </li>
                  ))}
                  {conflicting.map((row) => (
                    <li key={row.id} className="px-4 py-3">
                      <p className="text-ui text-muted-foreground">{row.content}</p>
                      <p className="mt-1 text-caption italic text-muted-foreground/80">
                        {row.reason ?? "It clashed with something you told Juno, so it isn’t used."}
                      </p>
                    </li>
                  ))}
                </ul>
              </RecapSection>
            )}

            {(forgotten.length > 0 || expired.length > 0) && (
              <RecapSection title="What Juno let go of" style={nextDelay()}>
                <ul className="divide-y divide-border/50 border-t border-border/50">
                  {forgotten.map((row) => (
                    <li key={row.id} className="flex items-start gap-2.5 px-4 py-3 text-ui">
                      <EyeOff className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground/90">{row.content}</span>
                        <span className="mt-0.5 block text-caption text-muted-foreground">
                          You asked Juno to forget this · {timeAgo(row.createdAt)}
                        </span>
                      </span>
                    </li>
                  ))}
                  {expired.map((row) => (
                    <li key={row.id} className="flex items-start gap-2.5 px-4 py-3 text-ui">
                      <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground/90">{row.content}</span>
                        <span className="mt-0.5 block text-caption text-muted-foreground">
                          Only true for a while, and that while has passed
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </RecapSection>
            )}

            {themes === null ? (
              <Skeleton className="h-28 w-full rounded-card" aria-hidden="true" />
            ) : (
              shownThemes.length > 0 && (
                <RecapSection title="What you talked about" style={nextDelay()}>
                  <ul className="space-y-1.5 border-t border-border/50 px-4 py-3">
                    {shownThemes.map((theme) => (
                      <li key={theme} className="flex items-start gap-2.5 text-ui text-foreground/90">
                        <MessagesSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0">{theme}</span>
                      </li>
                    ))}
                  </ul>
                </RecapSection>
              )
            )}

            {leanedOn.length > 0 && (
              <RecapSection title="What Juno leaned on" style={nextDelay()}>
                <ul className="divide-y divide-border/50 border-t border-border/50">
                  {leanedOn.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-2.5">
                      <span className="min-w-0 text-ui text-foreground/90">{row.content}</span>
                      <span className="shrink-0 font-mono text-caption text-muted-foreground">
                        used {timeAgo(row.lastUsedAt ?? row.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </RecapSection>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function RecapStat({ label, value, tone = "muted" }: { label: string; value: number; tone?: "primary" | "muted" }) {
  return (
    <div className="rounded-card border border-border/60 bg-card px-4 py-3 surface-raised">
      <p
        className={cn(
          "font-mono text-title tabular-nums leading-none",
          tone === "primary" ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <RollingNumber value={value} />
      </p>
      <p className="mt-1.5 font-mono text-micro uppercase tracking-wide text-muted-foreground/70">{label}</p>
    </div>
  );
}

function RecapSection({
  title,
  style,
  children,
}: {
  title: string;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <section
      style={style}
      className="overflow-hidden rounded-panel border border-border/60 bg-card motion-safe:animate-rise-in [animation-fill-mode:backwards]"
    >
      <h3 className="px-4 pb-2 pt-4 font-sans text-ui font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}
