"use client";

import * as React from "react";
import { ArrowRight, CalendarClock, EyeOff, type IconComponent } from "@/components/ui/icons";
import { Collapse } from "@/components/ui/collapse";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { memoryCategoryLabel } from "@/lib/memory-categories";
import { buildMemoryRecap, recapIsEmpty, type RecapPeriod } from "@/lib/memory-recap";
import { cn } from "@/lib/utils";
import type { Memory } from "@/components/memory/memory-model";
import { relativeTime } from "@/components/memory/memory-time";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The recap: what changed in what Juno knows, over a period you choose.
 *
 * It was a peer of the list (a third tab beside Topics and All facts), with
 * four stat tiles in large mono numerals and every section in its own card.
 * It is a report, not a way of browsing, so it lives in the activity sheet
 * now: one line of counts in words, then the sections as headings over
 * hairline rows. Correcting a fact happens in the list, where the fact lives;
 * this says what happened to it.
 *
 * Changing the period re-renders the sections as one piece (a fade, keyed on
 * the period), because they are different content rather than the same
 * content moving.
 */

export interface RecapExtras {
  themes: string[];
  conversations: number;
}

/** The server half of the recap: chat themes and the chat count, which need the transcripts. */
export async function fetchRecapExtras(days: RecapPeriod): Promise<RecapExtras> {
  const res = await fetch(`/api/memory/recap?days=${days}`);
  if (!res.ok) throw new Error();
  const data = (await res.json()) as { themes?: string[]; conversations?: number };
  return { themes: data.themes ?? [], conversations: data.conversations ?? 0 };
}

const LEARNED_PREVIEW = 6;

export function RecapView({
  memories,
  loadExtras = fetchRecapExtras,
}: {
  /** Every row in scope, suppressions included: "let go of" is dated by the block-list. */
  memories: Memory[];
  /** Injectable for the dev gallery; the page uses the real route. */
  loadExtras?: (days: RecapPeriod) => Promise<RecapExtras>;
}) {
  const [days, setDays] = React.useState<RecapPeriod>(30);
  const [extras, setExtras] = React.useState<RecapExtras | null>(null);
  const [showAllLearned, setShowAllLearned] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setExtras(null);
    setShowAllLearned(false);
    loadExtras(days).then(
      (next) => {
        if (!cancelled) setExtras(next);
      },
      () => {
        // Themes are the one part that needs the server; without them the
        // recap is still a recap.
        if (!cancelled) setExtras({ themes: [], conversations: 0 });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [days, loadExtras]);

  const recap = React.useMemo(() => buildMemoryRecap(memories, { days }), [memories, days]);
  const themes = extras?.themes ?? [];
  const empty = extras !== null && recapIsEmpty(recap, themes);
  const learnedFirst = recap.learned.slice(0, LEARNED_PREVIEW);
  const learnedRest = recap.learned.slice(LEARNED_PREVIEW);
  const changed = recap.replaced.length + recap.conflicting.length;
  const letGo = recap.forgotten.length + recap.expired.length;

  return (
    <div className="space-y-5">
      <SegmentedControl<`${RecapPeriod}`>
        value={`${days}`}
        onChange={(value) => setDays(Number(value) as RecapPeriod)}
        ariaLabel="Recap period"
        className="w-full"
        options={[
          { value: "7", label: "7 days" },
          { value: "30", label: "30 days" },
          { value: "90", label: "90 days" },
        ]}
      />

      <div key={days} className="space-y-6 motion-safe:animate-fade-in">
        {/* The four counts as one line of words, not four tiles of numerals:
            they introduce the sections below, they are not the point. */}
        <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-ui">
          <Tally label="learned" value={recap.learned.length} />
          <Tally label="changed" value={changed} />
          <Tally label="let go" value={letGo} />
          {extras !== null && <Tally label="chats" value={extras.conversations} />}
        </dl>

        {empty ? (
          <p className="py-6 text-center text-ui text-muted-foreground">
            {`${PRODUCT_NAME} didn’t learn, change or use anything in this stretch. Try a longer period.`}
          </p>
        ) : (
          <>
            {recap.learned.length > 0 && (
              <RecapSection title={`What ${PRODUCT_NAME} learned`}>
                <ul className="divide-y divide-border/70">
                  {learnedFirst.map((row) => (
                    <RecapLine key={row.id} text={row.content} meta={memoryCategoryLabel(row.category)} when={row.createdAt} />
                  ))}
                </ul>
                {learnedRest.length > 0 && (
                  <>
                    <Collapse open={showAllLearned}>
                      <ul className="divide-y divide-border/70 border-t border-border/70">
                        {learnedRest.map((row) => (
                          <RecapLine key={row.id} text={row.content} meta={memoryCategoryLabel(row.category)} when={row.createdAt} />
                        ))}
                      </ul>
                    </Collapse>
                    <button
                      type="button"
                      onClick={() => setShowAllLearned((open) => !open)}
                      aria-expanded={showAllLearned}
                      className="mt-1 rounded-control py-1 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground"
                    >
                      {showAllLearned ? (
                        <span>Show fewer</span>
                      ) : (
                        <>
                          <span>Show all</span> <span className="tabular-nums">{recap.learned.length}</span>
                        </>
                      )}
                    </button>
                  </>
                )}
              </RecapSection>
            )}

            {changed > 0 && (
              <RecapSection title="What changed">
                <ul className="divide-y divide-border/70">
                  {recap.replaced.map(({ before, after }) => (
                    <li key={before.id} className="py-2.5 text-ui">
                      <span className="text-muted-foreground line-through decoration-muted-foreground/40">{before.content}</span>
                      <ArrowRight className="mx-1.5 inline size-3.5 align-[-2px] text-muted-foreground" aria-hidden="true" />
                      <span className="sr-only">replaced by</span>
                      <span className="text-foreground">{after?.content}</span>
                    </li>
                  ))}
                  {recap.conflicting.map((row) => (
                    <li key={row.id} className="py-2.5">
                      <p className="text-ui text-muted-foreground">{row.content}</p>
                      <p className="mt-0.5 text-caption text-muted-foreground">
                        {row.reason ?? `It clashed with something you told ${PRODUCT_NAME}, so it isn’t used.`}
                      </p>
                    </li>
                  ))}
                </ul>
              </RecapSection>
            )}

            {letGo > 0 && (
              <RecapSection title={`What ${PRODUCT_NAME} let go of`}>
                <ul className="divide-y divide-border/70">
                  {recap.forgotten.map((row) => (
                    <RecapLine key={row.id} icon={EyeOff} text={row.content} meta={`You asked ${PRODUCT_NAME} to forget this`} when={row.createdAt} />
                  ))}
                  {recap.expired.map((row) => (
                    <RecapLine key={row.id} icon={CalendarClock} text={row.content} meta="Only true for a while" />
                  ))}
                </ul>
              </RecapSection>
            )}

            {extras === null ? (
              <Skeleton className="h-24 w-full rounded-card" aria-hidden="true" />
            ) : (
              themes.length > 0 && (
                <RecapSection title="What you talked about">
                  <ul className="list-disc space-y-1 pl-5 text-ui text-foreground marker:text-muted-foreground">
                    {themes.map((theme) => (
                      <li key={theme}>{theme}</li>
                    ))}
                  </ul>
                </RecapSection>
              )
            )}

            {recap.leanedOn.length > 0 && (
              <RecapSection title={`What ${PRODUCT_NAME} leaned on`}>
                <ul className="divide-y divide-border/70">
                  {recap.leanedOn.map((row) => (
                    <RecapLine key={row.id} text={row.content} meta="Last used" when={row.lastUsedAt ?? row.createdAt} />
                  ))}
                </ul>
              </RecapSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Tally({ label, value }: { label: string; value: number }) {
  // The term comes first in the markup, as a definition list requires, and
  // second on screen, where the number leads: "12 learned".
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="order-last text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function RecapSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="pb-1 text-ui font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function RecapLine({
  text,
  meta,
  when,
  icon: Icon,
}: {
  text: string;
  meta: string;
  when?: string | null;
  icon?: IconComponent;
}) {
  return (
    <li className={cn("flex items-start gap-2.5 py-2.5", !Icon && "block")}>
      {Icon && <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <span className="block min-w-0">
        <span className="block text-ui text-foreground">{text}</span>
        <span className="mt-0.5 block text-caption text-muted-foreground">
          {meta}
          {when && (
            <>
              <span aria-hidden="true"> · </span>
              {relativeTime(when)}
            </>
          )}
        </span>
      </span>
    </li>
  );
}
