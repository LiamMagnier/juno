"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { ComposerAttachmentRow, composerIconButtonClass } from "@/components/ui/composer-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AppIcons, ComposerIcons } from "@/lib/app-icons";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import { cn } from "@/lib/utils";
import type { PendingUpload } from "@/hooks/use-uploads";

/*
 * THE PARTS BOTH CODE COMPOSERS ARE MADE OF.
 *
 * /code/new and the session view draw the same composer twice: the same
 * attachment tray, the same "+" menu, the same drop overlay, the same pair of
 * hidden file inputs. They were two copies, and the comments in each of them
 * had already started recording the drift they were correcting in the other —
 * "`p-3 pb-0`, the inset the session view's tray uses", "identical to the
 * session view's chip on purpose". A comment saying two things must stay the
 * same is the cheapest possible substitute for one thing.
 *
 * Nothing here holds state. Each part takes exactly what it draws, so the two
 * hosts keep their own upload hook, their own disabled logic and their own
 * gating — the only thing shared is the shape.
 */

/**
 * The staged-attachment tray, above the field and inside the surface: the
 * shared 56px thumbnail row, so a file attached to a Code session looks
 * exactly like one attached to a chat. Tiles pop in and out on the spring;
 * the row takes no space while it is empty.
 */
export function ComposerAttachmentTray({
  uploads,
  onRemove,
}: {
  uploads: PendingUpload[];
  onRemove: (localId: string) => void;
}) {
  return <ComposerAttachmentRow uploads={uploads} onRemove={onRemove} />;
}

/**
 * The "+" menu: photos, files, library.
 *
 * The shared 32px flat icon button; the plus turns into a × while the menu is
 * open, which is the only motion the trigger makes.
 */
export function ComposerAddMenu({
  open,
  onOpenChange,
  disabled,
  onPickPhotos,
  onPickFiles,
  onPickLibrary,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  onPickPhotos: () => void;
  onPickFiles: () => void;
  onPickLibrary: () => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Add an attachment"
          disabled={disabled}
          className={cn(composerIconButtonClass, "group")}
        >
          <AppIcons.new
            aria-hidden="true"
            strokeWidth={1.75}
            className="size-4 transition-transform duration-base ease-out-strong group-data-[state=open]:rotate-45 motion-reduce:transition-none"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
        <DropdownMenuLabel className="font-mono text-label">Add</DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ComposerIcons.attach className="text-muted-foreground" />
            <span className="flex-1">Attach</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuItem onSelect={onPickPhotos}>
              <ComposerIcons.photos className="text-muted-foreground" />
              <span className="flex-1">Photos</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onPickFiles}>
              <ComposerIcons.files className="text-muted-foreground" />
              <span className="flex-1">Files</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onPickLibrary}>
              <AppIcons.library className="text-muted-foreground" />
              <span className="flex-1">From your library</span>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The drag-and-drop scrim.
 *
 * `rounded-panel` — the composer shell's own rung — so the overlay traces the
 * shell exactly. The house drop-zone recipe (dashed `border-primary/60` over
 * a `bg-primary/5` wash) sits over an opaque card fill here, because a scrim
 * that lets the composer's controls show through reads as a broken layer
 * rather than as a target.
 */
export function ComposerDropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-primary/60 bg-card motion-safe:animate-fade-in">
      <div className="pointer-events-none absolute inset-0 rounded-panel bg-primary/5" aria-hidden="true" />
      <ComposerIcons.files className="relative size-6 text-primary" aria-hidden="true" />
      <span className="relative font-mono text-label text-primary-ink">Drop to attach</span>
    </div>
  );
}

/** The two hidden `<input type="file">`s the "+" menu drives. */
export function ComposerFileInputs({
  imageInputRef,
  fileInputRef,
  onFiles,
}: {
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList) => void;
}) {
  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) onFiles(e.target.files);
    // Cleared so re-picking the same file fires `change` again.
    e.target.value = "";
  };
  return (
    <>
      <input ref={imageInputRef} type="file" multiple accept="image/*" className="hidden" onChange={handle} />
      <input ref={fileInputRef} type="file" multiple accept={ACCEPT_ATTRIBUTE} className="hidden" onChange={handle} />
    </>
  );
}
