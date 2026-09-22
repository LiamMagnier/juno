"use client";

import * as React from "react";
import { FileText, Loader2, NotebookPen, Plus } from "lucide-react";

import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";
import { Pressable } from "@/components/ui/pressable";
import { formatBytes, cn } from "@/lib/utils";

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
 * The card's top edge lines up with the top of the chat column beside it (one
 * grid row, one rule across the page); its eyebrow sits the card's own 16px
 * inset below that, as every card in the product insets its content. The
 * alignment that matters is between BLOCKS, and every block on this page now
 * starts on the same line.
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
  memories,
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
  memories: RailMemoryItem[];
  onManageMemory: () => void;
  className?: string;
}) {
  const instructionLines = instructions ? instructions.split("\n").length : 0;

  return (
    <Card className={cn("overflow-hidden", className)}>
      {coverUrl && (
        <div className="group/cover relative aspect-[16/7] w-full overflow-hidden border-b border-border/60 bg-muted">
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

      <div className="divide-y divide-border/60">
        <RailSection
          title="Instructions"
          action={
            <Pressable
              kind="icon"
              size="sm"
              className="-mr-2"
              onClick={onEditInstructions}
              aria-label="Edit project instructions"
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
              <p className="line-clamp-4 whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-muted-foreground">
                {instructions}
              </p>
              <p className="mt-2 font-mono text-caption tabular-nums text-muted-foreground/70">
                {instructions.length.toLocaleString()} chars · {plural(instructionLines, "line")}
              </p>
            </button>
          ) : (
            <RailEmpty
              description="A prompt Juno follows in every chat, task and code session filed here."
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
            >
              {uploading ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-4" aria-hidden="true" />
              )}
            </Pressable>
          }
        >
          {fileCount === 0 ? (
            <RailEmpty
              description="PDFs, documents and data Juno reads before answering here."
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
                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <a
                      href={file.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 flex-1 rounded-xs"
                    >
                      <span className="block truncate text-ui font-medium text-foreground">
                        {file.fileName}
                      </span>
                      <span className="block font-mono text-caption tabular-nums text-muted-foreground">
                        {formatBytes(file.size)}
                      </span>
                    </a>
                    <Pressable
                      kind="icon"
                      size="sm"
                      onClick={() => onDeleteFile(file.id)}
                      aria-label={`Remove ${file.fileName}`}
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
          icon={NotebookPen}
          action={
            <div className="-mr-2 flex items-center gap-1">
              <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-caption text-muted-foreground">
                Only you
              </span>
              <Pressable
                kind="icon"
                size="sm"
                onClick={onManageMemory}
                aria-label="Manage memories"
              >
                <ActionIcons.edit className="size-3.5" aria-hidden="true" />
              </Pressable>
            </div>
          }
        >
          {memories.length === 0 ? (
            // No action. Nothing the reader does here resolves it — memories
            // arrive from chats, which is what the sentence says.
            <RailEmpty description="Durable facts Juno picks up from your chats land here, across every project." />
          ) : (
            <>
              <ul className="space-y-1.5">
                {memories.slice(0, MEMORY_PREVIEW).map((memory) => (
                  <li
                    key={memory.id}
                    className="flex gap-2 text-caption leading-relaxed text-muted-foreground"
                  >
                    <span aria-hidden="true" className="select-none text-muted-foreground/50">
                      ·
                    </span>
                    <span className="min-w-0 flex-1 truncate">{memory.content}</span>
                  </li>
                ))}
              </ul>
              {/* Only when the list is actually cut. Below the cut this said
                  "Manage memory", which is the pencil 20px above it wearing a
                  word — a second door to one room. */}
              {memories.length > MEMORY_PREVIEW && (
                <RailMore onClick={onManageMemory}>
                  View all {memories.length.toLocaleString()} memories
                </RailMore>
              )}
            </>
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
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="p-4">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {Icon && <Icon className="size-3.5 text-muted-foreground" aria-hidden={true} />}
          <CardEyebrow className="truncate">{title}</CardEyebrow>
          {count !== undefined && count > 0 && (
            <span className="font-mono text-caption tabular-nums text-muted-foreground/70">
              {count.toLocaleString()}
            </span>
          )}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
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

/** The link out of a truncated rail list into the tab that holds all of it. */
function RailMore({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-2 mt-1.5 block w-full rounded-control px-2 py-1.5 text-left font-mono text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-reduce:transition-none"
    >
      {children} →
    </button>
  );
}

function plural(n: number, noun: string) {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}
