"use client";

import * as React from "react";
import { ArrowRight, FileText, Loader2, Plus, type IconComponent } from "@/components/ui/icons";

import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";
import { Pressable } from "@/components/ui/pressable";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { summaryExcerpt, type SummaryData } from "@/components/memory/memory-model";
import { formatBytes, cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";

export interface RailFileItem {
  id: string;
  fileName: string;
  size: number;
  url: string;
}

export interface RailMemoryItem {
  id: string;
  content: string;
}

/**
 * This project's memory, as `GET /api/projects/[id]/memory` answers it: the
 * project's own summary, its newest facts, and how many it holds in all.
 */
export interface RailProjectMemory {
  summary: SummaryData | null;
  facts: RailMemoryItem[];
  activeCount: number;
}

/** How many rows a rail section shows before it defers to its full tab. */
const FILE_PREVIEW = 4;
const MEMORY_PREVIEW = 3;

/**
 * The Overview page's right-hand rail: what this project knows, in three
 * sections that agree with each other.
 *
 * They did not, before. The three sections were written inline in the page at
 * `pb-5` / `py-5` / `pt-5`, each with its own header arrangement, and the card
 * opened with a 96px dashed "Add project image" slab — the loudest object in
 * the quietest column of the page, for the one action here that changes
 * nothing about how the project answers. A cover is a picture: it is drawn
 * when there is one, and when there is not, the offer lives in the header's
 * actions menu with the project's other rare verbs.
 *
 * What is left is one shape repeated three times (`RailSection`): a 28px
 * header row with the eyebrow on the left and at most one control on the
 * right, a 12px gap, then the body. 28px is the height of the `size="sm"`
 * icon affordance that sits in that row, so a section with a control and a
 * section without one open on the same line — which is what the three
 * hand-written headers could not do.
 *
 * The card's top edge is level with the top of the composer beside it — one
 * grid row, `items-start`, so the rail does not stretch to the left column's
 * height — and its eyebrow sits the card's own 16px inset below that, as
 * every card in the product insets its content. Instructions and Sources are
 * therefore the first things the eye finds beside the field you type into,
 * which is where a reader who is about to ask the project a question wants to
 * see what the project already knows.
 *
 * Rows inside a section paint nothing at rest — no border, no fill, no radius
 * — and take a tonal fill on hover, which is the product's list vocabulary
 * (PREMIUM_AUDIT §1) and the reason the rail can hold three lists without
 * reading as nine boxes. It also sidesteps the concentric-radius arithmetic:
 * a 16px card padded by 16 has no radius left to spend on a nested well, and
 * the old bordered file tiles were spending 12 of it.
 */
export function ProjectOverviewRail({
  coverUrl,
  onPickCover,
  onRemoveCover,
  uploadingCover = false,
  instructions,
  onEditInstructions,
  files,
  fileCount,
  onAddFile,
  onDeleteFile,
  onViewAllSources,
  uploading = false,
  memory,
  onManageMemory,
  className,
}: {
  coverUrl: string | null;
  onPickCover: () => void;
  onRemoveCover: () => void;
  /** A cover write is in flight — distinct from `uploading`, which is sources. */
  uploadingCover?: boolean;
  instructions: string;
  onEditInstructions: () => void;
  files: RailFileItem[];
  /** Every source filed here — files plus artifacts — not just the ones shown. */
  fileCount: number;
  onAddFile: () => void;
  onDeleteFile: (fileId: string) => void;
  onViewAllSources: () => void;
  uploading?: boolean;
  /** null while it loads. */
  memory: RailProjectMemory | null;
  onManageMemory: () => void;
  className?: string;
}) {
  const instructionLines = instructions ? instructions.split("\n").length : 0;
  const memorySummary = memory?.summary ? summaryExcerpt(memory.summary.content) : "";
  const memoryFacts = memory?.facts ?? [];
  const memoryCount = memory?.activeCount ?? 0;

  return (
    // Arrives a beat after the column beside it (the homepage's long
    // decelerate), so the page settles left to right rather than all at once.
    <Card className={cn("overflow-hidden [animation-delay:80ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in", className)}>
      {/* A band, not a picture. At 16/7 the cover was 133px on a 304px rail,
          which put Instructions that far below the composer it is supposed to
          sit level with — the decoration outranking the thing the reader came
          for. 16/5 keeps the project's image present at ~95px and the section
          content near the top of the card. */}
      {coverUrl && (
        <div className="group/cover relative aspect-[16/5] w-full overflow-hidden border-b border-foreground/[.07] bg-muted">
          <img src={coverUrl} className="size-full object-cover" alt="" />
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-scrim opacity-0 transition-opacity duration-base ease-out-soft focus-within:opacity-100 group-hover/cover:opacity-100 motion-reduce:transition-none coarse:opacity-100">
            <Button variant="secondary" size="sm" onClick={onPickCover} disabled={uploadingCover}>
              Change
            </Button>
            <Button variant="destructive" size="sm" onClick={onRemoveCover} disabled={uploadingCover}>
              Remove
            </Button>
          </div>
        </div>
      )}

      <div className="divide-y divide-foreground/[.07]">
        <RailSection
          title="Instructions"
          action={
            <Pressable
              kind="icon"
              size="sm"
              className="-mr-2"
              onClick={onEditInstructions}
              aria-label="Edit project instructions"
              title="Edit instructions"
            >
              <ActionIcons.edit className="size-3.5" aria-hidden="true" />
            </Pressable>
          }
        >
          {instructions ? (
            <button
              type="button"
              onClick={onEditInstructions}
              className="-mx-2 block w-full rounded-control px-2 py-1.5 text-left transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
            >
              <p className="line-clamp-4 whitespace-pre-wrap break-words text-caption leading-relaxed text-muted-foreground">
                {instructions}
              </p>
              <p className="mt-2 text-caption tabular-nums text-muted-foreground">
                {instructions.length.toLocaleString()} chars · {plural(instructionLines, "line")}
              </p>
            </button>
          ) : (
            <RailEmpty
              description={`A prompt ${PRODUCT_NAME} follows in every chat, task and code session filed here.`}
              action={
                <Button variant="outline" size="sm" onClick={onEditInstructions}>
                  Add instructions
                </Button>
              }
            />
          )}
        </RailSection>

        <RailSection
          title="Sources"
          count={fileCount}
          action={
            <Pressable
              kind="icon"
              size="sm"
              className="-mr-2"
              onClick={onAddFile}
              disabled={uploading}
              aria-label="Add a file to this project"
              title="Add a file"
            >
              {uploading ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-3.5" aria-hidden="true" />
              )}
            </Pressable>
          }
        >
          {fileCount === 0 ? (
            <RailEmpty
              description={`PDFs, documents and data ${PRODUCT_NAME} reads before answering here.`}
              action={
                <Button variant="outline" size="sm" onClick={onAddFile} disabled={uploading}>
                  Add a file
                </Button>
              }
            />
          ) : (
            <>
              <ul className="-mx-2 space-y-0.5">
                {files.slice(0, FILE_PREVIEW).map((file) => (
                  <li
                    key={file.id}
                    className="group/file flex items-center gap-2 rounded-control px-2 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
                  >
                    <FileText
                      className="size-4 shrink-0 text-muted-foreground transition-colors duration-fast ease-out-soft group-hover/file:text-foreground motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                    <a
                      href={file.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 flex-1 rounded-xs"
                    >
                      <span className="block truncate text-ui font-medium text-foreground">
                        {file.fileName}
                      </span>
                      <span className="block text-caption tabular-nums text-muted-foreground">
                        {formatBytes(file.size)}
                      </span>
                    </a>
                    <Pressable
                      kind="icon"
                      size="sm"
                      onClick={() => onDeleteFile(file.id)}
                      aria-label={`Remove ${file.fileName}`}
                      title="Remove"
                      className="danger-hover size-6 shrink-0 opacity-0 transition-opacity duration-fast ease-out-soft group-hover/file:opacity-100 group-focus-within/file:opacity-100 coarse:opacity-100 motion-reduce:transition-none"
                    >
                      <ActionIcons.delete className="size-3.5" aria-hidden="true" />
                    </Pressable>
                  </li>
                ))}
              </ul>
              {/* `fileCount` counts artifacts as well as files, and the list
                  above draws files only — so a project whose sources are all
                  artifacts shows no rows here and needs this line more than
                  anything, not less. */}
              {fileCount > Math.min(files.length, FILE_PREVIEW) && (
                <RailMore onClick={onViewAllSources}>
                  View all {fileCount.toLocaleString()} sources
                </RailMore>
              )}
            </>
          )}
        </RailSection>

        <RailSection
          title="Memory"
          count={memoryCount}
          action={
            <div className="-mr-2 flex items-center gap-1">
              <span className="pr-1 text-caption text-muted-foreground">
                Only you
              </span>
              <Pressable
                kind="icon"
                size="sm"
                onClick={onManageMemory}
                aria-label="Manage memories"
                title="Manage memories"
              >
                <ActionIcons.edit className="size-3.5" aria-hidden="true" />
              </Pressable>
            </div>
          }
        >
          {memory === null ? (
            // Holds the section's place while it loads, so the card does not
            // grow under the reader's eye when the answer lands.
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          ) : !memorySummary && memoryFacts.length === 0 ? (
            // No action. Nothing the reader does here resolves it — memories
            // arrive from this project's chats, which is what the sentence
            // says, along with the boundary a reader most needs to trust.
            <RailEmpty description={`What ${PRODUCT_NAME} learns in this project’s chats stays here. Your other chats never see it.`} />
          ) : (
            // One piece, entering once, when the answer arrives.
            <div className="motion-safe:animate-fade-in">
              {memorySummary && memory?.summary && (
                // The project's own summary — what every chat here opens
                // with. A glimpse of its first section, clamped; the whole of
                // it is one click away on the memory page.
                <button
                  type="button"
                  onClick={onManageMemory}
                  className="-mx-2 mb-2 block w-full rounded-control px-2 py-1.5 text-left transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
                >
                  <p className="line-clamp-3 text-pretty text-caption leading-relaxed text-foreground/85">
                    {memorySummary}
                  </p>
                  <p className="mt-1.5 text-caption tabular-nums text-muted-foreground">
                    Summary · updated {timeAgo(memory.summary.updatedAt)}
                  </p>
                </button>
              )}
              {memoryFacts.length > 0 && (
                <ul className="space-y-1.5">
                  {memoryFacts.slice(0, MEMORY_PREVIEW).map((fact) => (
                    <li key={fact.id} className="flex gap-2 text-caption leading-relaxed text-muted-foreground">
                      <span aria-hidden="true" className="select-none text-muted-foreground/50">
                        ·
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={fact.content}>
                        {fact.content}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {/* Only when the list is actually cut. Below the cut this said
                  "Manage memory", which is the pencil 20px above it wearing a
                  word — a second door to one room. */}
              {memoryCount > Math.min(memoryFacts.length, MEMORY_PREVIEW) && (
                <RailMore onClick={onManageMemory}>
                  View all {memoryCount.toLocaleString()} memories
                </RailMore>
              )}
            </div>
          )}
        </RailSection>
      </div>
    </Card>
  );
}

/**
 * One block of the rail. The header is a fixed 28px row — the height of the
 * `size="sm"` icon affordance that sits in it — so a section with a control
 * and a section without one open on exactly the same line.
 */
function RailSection({
  title,
  count,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  /** Drawn beside the title when there are more of these than the rail shows. */
  count?: number;
  icon?: IconComponent;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="p-4">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {Icon && <Icon className="size-3.5 text-muted-foreground" aria-hidden={true} />}
          <CardEyebrow className="truncate font-sans text-caption font-medium tracking-[0.01em]">{title}</CardEyebrow>
          {count !== undefined && count > 0 && (
            <span className="text-caption tabular-nums text-muted-foreground">
              {count.toLocaleString()}
            </span>
          )}
        </div>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/**
 * "There is nothing here yet", inside a card.
 *
 * A sentence and, where something resolves it, one small button — NOT the
 * dashed inset well `EmptyState` draws. That component is right on the page,
 * where a recessed dashed box reads as a space waiting to be filled; three of
 * them stacked inside one card is three boxes inside a box, and it was the
 * heaviest thing in the rail on exactly the projects with the least in them.
 * It also has no honest radius available to it: a 16px card padded by 16 has
 * nothing left to spend on a nested surface (FLAT_UI.md §6), so the well was
 * drawing corners three times rounder than the geometry allows.
 *
 * No title either. "No instructions yet" over "Add a prompt Juno follows…"
 * says the same thing twice, and the eyebrow directly above already names the
 * section — so the one line kept is the one that says what would put
 * something here.
 */
function RailEmpty({
  description,
  action,
}: {
  description: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-pretty text-caption leading-relaxed text-muted-foreground">{description}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * The link out of a truncated rail list into the tab that holds all of it.
 *
 * The arrow is a glyph from the set, not a typed "→": a text arrow takes the
 * mono face's weight and baseline, and it cannot nudge when the row is
 * pointed at. This one goes where it points (`nudge-r`).
 */
function RailMore({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/more -mx-2 mt-1.5 flex w-full items-center gap-1.5 rounded-control px-2 py-1.5 text-left text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-reduce:transition-none"
    >
      {children}
      <ArrowRight className="size-3 shrink-0 transition-transform duration-base ease-out-expo group-hover/more:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
    </button>
  );
}

function plural(n: number, noun: string) {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}
