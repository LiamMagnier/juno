"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { ArrowUp, Loader2, Maximize2, Pencil, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "@/components/chat/markdown";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";
import { parseSummarySections, type SummaryData, type SummarySection } from "./memory-model";

// Shared-element morph between the pencil FAB and the composer bar. Both carry
// the same layoutId, so framer-motion animates one into the other on swap.
const MORPH_TRANSITION = { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const };

function SummarySections({ sections, className }: { sections: SummarySection[]; className?: string }) {
  return (
    <div className={className}>
      {sections.map((s) => (
        <section key={s.title}>
          <h3 className="font-serif text-heading">{s.title}</h3>
          <Markdown content={s.body} className="mt-1.5 text-sm text-foreground/90" />
        </section>
      ))}
    </div>
  );
}

interface SummaryCardProps {
  summary: SummaryData | null;
  paused: boolean;
  consolidating: boolean;
  onRegenerate: () => void;
  /** Resolve true once the instruction was drafted (or refused) — collapses the composer. */
  onInstruction: (instruction: string) => Promise<boolean>;
}

export function SummaryCard({ summary, paused, consolidating, onRegenerate, onInstruction }: SummaryCardProps) {
  const [composing, setComposing] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [drafting, setDrafting] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const fabRef = React.useRef<HTMLButtonElement>(null);
  const wasComposing = React.useRef(false);

  // Hand focus to the input when the composer opens, back to the pencil when it closes.
  React.useEffect(() => {
    if (composing) {
      wasComposing.current = true;
      const t = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
    if (wasComposing.current) fabRef.current?.focus();
    wasComposing.current = false;
  }, [composing]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const instruction = value.trim();
    if (!instruction || drafting) return;
    setDrafting(true);
    const done = await onInstruction(instruction);
    setDrafting(false);
    if (done) {
      setValue("");
      setComposing(false);
    } else {
      inputRef.current?.focus();
    }
  };

  const sections = summary ? parseSummarySections(summary.content) : [];

  return (
    <section
      aria-labelledby="memory-summary-heading"
      className="relative overflow-hidden rounded-panel border border-border/60 bg-card surface-raised"
    >
      <div
        className={cn(
          "p-5 transition-[opacity,filter] duration-slow ease-out-soft sm:p-6",
          paused && "opacity-55 saturate-50"
        )}
      >
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 id="memory-summary-heading"className="font-mono text-label text-muted-foreground">
            Memory summary
          </h2>
          {paused && (
            <Badge variant="muted"className="text-[10px]">
              Paused
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {summary && (
              <span className="text-caption text-muted-foreground/70">Updated {timeAgo(summary.updatedAt)}</span>
            )}
            {summary && sections.length > 0 && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setExpanded(true)}
                aria-label="Expand the memory summary"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRegenerate}
              disabled={consolidating}
              aria-label="Rebuild the summary from your chats and projects"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", consolidating && "animate-spin")} />
            </Button>
          </div>
        </div>

        {summary && sections.length > 0 ? (
          // Keyed on updatedAt so a regenerated summary re-enters as one piece.
          // CSS animation (not framer-motion) on purpose: an entrance that runs at
          // page load must finish even when rAF is throttled in a hidden tab.
          <div
            key={summary.updatedAt}
            className="scroll-fade-y max-h-[min(34vh,22rem)] space-y-5 overflow-y-auto pb-16 pr-1 motion-safe:animate-rise-in"
          >
            <SummarySections sections={sections} className="space-y-5" />
          </div>
        ) : consolidating ? (
          <div role="status" className="flex items-center gap-3 pb-14 pt-2 text-sm text-muted-foreground">
            <ThinkingDots />
            <span>Reading your chats and projects…</span>
          </div>
        ) : (
          <div className="pb-12 pt-1">
            <p className="font-serif text-heading">Nothing here yet</p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Juno builds this from your chats and projects as you go. You can also just tell it something with the
              pencil below — “remember that I prefer short answers”, for instance.
            </p>
          </div>
        )}
      </div>

      {/* Pencil ⇄ composer morph, floating over the bottom-left of the card. */}
      <div className="pointer-events-none absolute inset-x-4 bottom-4 sm:inset-x-5 sm:bottom-5">
        {composing ? (
          <motion.form
            layoutId="memory-composer"
            transition={MORPH_TRANSITION}
            style={{ borderRadius: 24 }}
            onSubmit={submit}
            className="pointer-events-auto flex w-full items-center gap-1.5 border border-border/70 bg-popover/95 py-1.5 pl-5 pr-1.5 glass-raised backdrop-blur-xl"
          >
            <motion.div
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { delay: 0.12 } }}
              className="flex min-w-0 flex-1 items-center"
            >
              {drafting ? (
                <span role="status" className="flex h-9 min-w-0 flex-1 items-center gap-2.5 text-sm text-muted-foreground">
                  <ThinkingDots />
                  <span className="truncate">Drafting the change…</span>
                </span>
              ) : (
                <input
                  ref={inputRef}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setComposing(false);
                    }
                  }}
                  maxLength={600}
                  placeholder="Tell Juno what to remember, update, or forget…"
                  aria-label="Memory instruction"
                  className="h-9 w-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
                />
              )}
            </motion.div>
            <motion.div
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { delay: 0.12 } }}
              className="flex shrink-0 items-center gap-1"
            >
              {!drafting && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full"
                  onClick={() => setComposing(false)}
                  aria-label="Cancel editing"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
              <Button
                type="submit"
                size="icon-sm"
                className="rounded-full"
                disabled={drafting || !value.trim()}
                aria-label="Send instruction"
              >
                {drafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </Button>
            </motion.div>
          </motion.form>
        ) : (
          <motion.button
            layoutId="memory-composer"
            transition={MORPH_TRANSITION}
            style={{ borderRadius: 24 }}
            ref={fabRef}
            type="button"
            onClick={() => {
              // Stays focusable while paused so the explanation is discoverable.
              if (paused) toast.info("Memory is paused — resume it below to make edits.");
              else setComposing(true);
            }}
            aria-disabled={paused}
            whileTap={paused ? undefined : { scale: 0.95 }}
            className={cn(
              "pointer-events-auto flex h-11 w-11 items-center justify-center bg-primary text-primary-foreground btn-glossy halo-primary hover:brightness-[1.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background coarse:h-12 coarse:w-12",
              paused && "opacity-50"
            )}
            aria-label={
              paused
                ? "Edit memory — unavailable while memory is paused"
                : "Edit memory — tell Juno what to remember, update, or forget"
            }
          >
            {/* initial={false}: the icon must be visible in server-rendered HTML,
                not fade in after hydration. */}
            <motion.span layout="position" initial={false}>
              <Pencil className="h-4 w-4" />
            </motion.span>
          </motion.button>
        )}
      </div>

      {/* Full-summary reading view. */}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[min(85dvh,52rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border/50 p-6 pb-4">
            <DialogTitle className="font-serif">Memory summary</DialogTitle>
            {summary && <DialogDescription>Updated {timeAgo(summary.updatedAt)}</DialogDescription>}
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <SummarySections sections={sections} className="space-y-6" />
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
