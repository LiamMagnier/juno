"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ShieldAlert } from "@/components/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { EmptyState } from "@/components/ui/empty-state";
import { RollingNumber } from "@/components/ui/micro";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { MemoryIcons } from "@/components/memory/memory-icons";
import { spring, stagger, transition, variants, flatten } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { EntryRow } from "@/components/memory/entry-row";
import type { Memory, MemoryTopic } from "@/components/memory/memory-model";

/*
 * Topics — what Juno knows about you, by subject.
 *
 * The page used to offer exactly two readings of memory: a paragraph of prose
 * that cannot be corrected, and (once the rows were reconnected) a flat list of
 * every sentence ever extracted. Neither answers the question people actually
 * open this page with, which is not "what is fact #34" but "what does this
 * think I'm like". A subject heading with a count and a two-line preview
 * answers it at a glance, and opening one puts the edit controls on the same
 * card as the thing being edited.
 *
 * ONE CARD OPEN AT A TIME. An accordion, not a set of independent disclosures:
 * the cards are large, the content inside them is long, and two open at once
 * pushes the third off-screen while the reader is still deciding. It also
 * gives the layout animation something honest to do — the card that closes
 * hands its height to the one that opens, in one continuous move.
 */

interface TopicsViewProps {
  topics: MemoryTopic[];
  busyIds: ReadonlySet<string>;
  paused: boolean;
  /** No facts at all vs. none matching the current search — different empties. */
  filtered: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onForget: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
  /** Offered on the empty state — the moment a newcomer most needs it. */
  onImport?: () => void;
}

export function TopicsView({
  topics,
  busyIds,
  paused,
  filtered,
  onEdit,
  onForget,
  onDelete,
  onImport,
}: TopicsViewProps) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const reduceMotion = useReducedMotion() ?? false;

  // A topic that disappears under a search must not leave the accordion
  // pointing at a card that is no longer rendered — the panel would stay
  // measured-open with nothing in it.
  React.useEffect(() => {
    if (openId && !topics.some((topic) => topic.id === openId)) setOpenId(null);
  }, [openId, topics]);

  if (topics.length === 0) {
    return filtered ? (
      <EmptyState
        size="panel"
        icon={MemoryIcons.search}
        title="Nothing matches that"
        description="Try a shorter word, or clear the filters to see everything Juno remembers."
      />
    ) : (
      <EmptyState
        size="panel"
        icon={MemoryIcons.topic}
        title="No topics yet"
        description="Juno files what it learns by subject — identity, preferences, the way you work. Chat for a while, add something yourself, or bring what another assistant already knows."
        action={
          onImport && !paused ? (
            <Button variant="outline" size="sm" onClick={onImport}>
              Import from ChatGPT or Claude
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <motion.ul
      // `layout` on the list, not just the cards: opening a card changes the
      // height of everything below it, and without this they jump to their new
      // positions while the card itself animates — one move and one cut,
      // reading as a glitch rather than as one gesture.
      layout={!reduceMotion}
      variants={stagger(0.045)}
      initial="hidden"
      animate="visible"
      className="grid gap-2.5"
    >
      {topics.map((topic) => (
        <TopicCard
          key={topic.id}
          topic={topic}
          open={openId === topic.id}
          onToggle={() => setOpenId((prev) => (prev === topic.id ? null : topic.id))}
          busyIds={busyIds}
          paused={paused}
          reduceMotion={reduceMotion}
          onEdit={onEdit}
          onForget={onForget}
          onDelete={onDelete}
        />
      ))}
    </motion.ul>
  );
}

interface TopicCardProps {
  topic: MemoryTopic;
  open: boolean;
  onToggle: () => void;
  busyIds: ReadonlySet<string>;
  paused: boolean;
  reduceMotion: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onForget: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}

function TopicCard({
  topic,
  open,
  onToggle,
  busyIds,
  paused,
  reduceMotion,
  onEdit,
  onForget,
  onDelete,
}: TopicCardProps) {
  const panelId = `memory-topic-${topic.id}`;
  const Icon = MemoryIcons.forTopic(topic.id);
  const rise = reduceMotion ? flatten(variants.rise) : variants.rise;

  // The two facts the card shows while closed. Newest first is already the
  // server's order; taking the head of it means the preview changes when the
  // topic does, which is the only cue a closed card can give that something
  // was learned.
  const preview = topic.active.slice(0, 2);

  return (
    <motion.li
      layout={!reduceMotion}
      variants={rise}
      transition={reduceMotion ? transition.fast : spring.layout}
      className={cn(
        "overflow-hidden rounded-card border border-border/60 bg-card surface-raised",
        // An open card is the subject of the page — it earns the brighter
        // hairline. Closed cards stay quiet so the open one reads as chosen.
        open && "border-border"
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="group flex w-full items-start gap-3 p-4 text-left transition-colors duration-fast ease-out-soft hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
      >
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-field border border-border/60 bg-muted/50 text-muted-foreground transition-colors duration-base ease-out-soft group-hover:text-foreground motion-reduce:transition-none",
            open && "border-primary/30 bg-primary/12 text-primary group-hover:text-primary"
          )}
        >
          <Icon className="size-4" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-sans text-heading text-foreground">{topic.label}</span>
            <span className="font-mono text-caption tabular-nums text-muted-foreground">
              <RollingNumber value={topic.active.length} />
            </span>
            {topic.sensitive && (
              <Badge variant="outline" className="gap-1 border-warning/40 text-caption">
                <ShieldAlert className="size-3" aria-hidden="true" />
                Sensitive
              </Badge>
            )}
            {topic.retired.length > 0 && (
              <span className="font-mono text-caption tabular-nums text-muted-foreground/70">
                +{topic.retired.length} retired
              </span>
            )}
          </span>

          {/* The preview is the card's whole argument for existing, so it is
              the fact text itself and not the category description — a reader
              scanning six cards is reading their own sentences back. */}
          <span className="mt-1.5 block space-y-0.5">
            {preview.length > 0 ? (
              preview.map((memory) => (
                <span key={memory.id} className="block truncate text-ui text-muted-foreground">
                  {memory.content}
                </span>
              ))
            ) : (
              <span className="block text-ui text-muted-foreground">{topic.description}</span>
            )}
            {topic.active.length > preview.length && (
              <span className="block text-caption text-muted-foreground/70">
                and {topic.active.length - preview.length} more
              </span>
            )}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2 pt-0.5">
          {topic.lastUsedAt && !open && (
            <span className="hidden font-mono text-caption text-muted-foreground/70 sm:inline">
              used {timeAgo(topic.lastUsedAt)}
            </span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 text-muted-foreground transition-transform duration-base ease-in-out motion-reduce:transition-none",
              open && "rotate-180"
            )}
          />
        </span>
      </button>

      {/*
       * The shared continuous disclosure: the panel rides grid-template-rows
       * 0fr to 1fr on the symmetric curve, in step with the caret, and folds
       * back the same way before it unmounts (ICONS_AND_MOTION §2.2 rules 6
       * and 8 — no `height` tween). Nothing is mounted while the card is
       * closed, as before. The 1fr track follows its content, so a row that
       * closes its own track on delete shrinks the card in the same motion.
       */}
      <Collapse open={open}>
        <div id={panelId} className="border-t border-border/50">
          <p className="px-4 pb-1 pt-3 text-caption text-muted-foreground">{topic.description}</p>
          <TopicRows
            memories={topic.active}
            busyIds={busyIds}
            paused={paused}
            onEdit={onEdit}
            onForget={onForget}
            onDelete={onDelete}
          />
          {topic.retired.length > 0 && (
            <RetiredRows
              memories={topic.retired}
              busyIds={busyIds}
              paused={paused}
              onEdit={onEdit}
              onForget={onForget}
              onDelete={onDelete}
            />
          )}
        </div>
      </Collapse>
    </motion.li>
  );
}

interface RowsProps {
  memories: Memory[];
  busyIds: ReadonlySet<string>;
  paused: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onForget: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}

function TopicRows({ memories, busyIds, paused, onEdit, onForget, onDelete }: RowsProps) {
  if (memories.length === 0) {
    return (
      <p className="px-4 pb-4 pt-1 text-ui text-muted-foreground">
        Everything in this topic has been retired. The trail is below.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border/50 border-t border-border/50">
      <AnimatePresence initial={false}>
        {memories.map((memory) => (
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
  );
}

/** The trail, collapsed. Same disclosure idiom the entry list uses. */
function RetiredRows({ memories, busyIds, paused, onEdit, onForget, onDelete }: RowsProps) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  return (
    <div className="border-t border-border/50">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
        <span>What Juno stopped believing</span>
        <span className="font-mono text-caption tabular-nums">{memories.length}</span>
      </button>
      <div
        id={listId}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <ul className="divide-y divide-border/50 border-t border-border/50">
            {memories.map((memory) => (
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
          </ul>
        </div>
      </div>
    </div>
  );
}
