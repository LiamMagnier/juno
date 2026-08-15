"use client";

import * as React from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { ActionIcons, AppIcons, CodeIcons, ComposerIcons } from "@/lib/app-icons";
import { requiresViewerCredentials } from "@/lib/image-source";
import { staggerDelay } from "@/lib/motion";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import { cn, formatBytes } from "@/lib/utils";
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

/** How long a chip's pop-out runs before the upload is actually dropped. */
const CHIP_EXIT_MS = 180;

/**
 * The staged-attachment tray, above the field and inside the shell.
 *
 * It collapses rather than unmounting so the composer's growth is eased rather
 * than jumped; `motion-reduce:transition-none` because this is real layout
 * movement on the commonest interaction the tray has.
 *
 * The exit is owned HERE rather than by the host. Both Code screens kept an
 * identical `removingIds` array plus an identical 180ms `setTimeout` in page
 * state, purely so a chip could finish its pop-out before the upload hook
 * dropped it — page state describing an animation this component runs. Neither
 * copy cleared its timer on unmount, so navigating away mid-removal called
 * `setState` on a dead tree.
 */
export function ComposerAttachmentTray({
  uploads,
  onRemove,
}: {
  uploads: PendingUpload[];
  onRemove: (localId: string) => void;
}) {
  const [removingIds, setRemovingIds] = React.useState<string[]>([]);
  const timers = React.useRef<number[]>([]);
  React.useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((id) => window.clearTimeout(id));
  }, []);

  const remove = (localId: string) => {
    setRemovingIds((prev) => (prev.includes(localId) ? prev : [...prev, localId]));
    timers.current.push(
      window.setTimeout(() => {
        onRemove(localId);
        setRemovingIds((prev) => prev.filter((id) => id !== localId));
      }, CHIP_EXIT_MS),
    );
  };

  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
        uploads.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="flex flex-wrap gap-2 p-3 pb-0">
          {uploads.map((u, i) => (
            <div
              key={u.localId}
              className={cn(
                // `bg-muted`, not `bg-background`: this chip sits INSIDE
                // ComposerShell's `bg-card`, and on true black a
                // background-filled chip punches a 0%-lightness hole into a
                // 6.5% panel. It also takes the shell's own seated-control
                // radius rather than a stray `rounded-md`. `shadow-soft` is
                // gone — it is black ink on black here.
                "group relative flex items-center gap-2 rounded-composer-control border border-border/60 bg-muted px-2.5 py-2 text-xs",
                removingIds.includes(u.localId)
                  ? "pointer-events-none motion-safe:animate-pop-out"
                  : "[animation-fill-mode:backwards] motion-safe:animate-rise-in",
              )}
              // Attaching six files at once dealt them out as one flat repaint.
              // `tight` is the rung for dense items; the shared cap keeps a
              // large drop from taking a second to finish arriving.
              style={removingIds.includes(u.localId) ? undefined : staggerDelay(i, "tight")}
            >
              {u.attachment?.kind === "IMAGE" ? (
                <Image
                  src={u.attachment.url}
                  unoptimized={requiresViewerCredentials(u.attachment.url)}
                  alt={u.fileName}
                  width={32}
                  height={32}
                  className="size-8 rounded-sm object-cover"
                />
              ) : (
                <CodeIcons.file className="size-5 text-muted-foreground" aria-hidden="true" />
              )}
              <div className="max-w-[140px]">
                <p className="truncate font-medium">{u.fileName}</p>
                <p className={cn("text-muted-foreground", u.status === "error" && "text-destructive")}>
                  {u.status === "uploading"
                    ? `${u.progress}%`
                    : u.status === "error"
                      ? "Failed"
                      : formatBytes(u.size)}
                </p>
              </div>
              {u.status === "uploading" && (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
              )}
              {/* `bg-secondary`, not `bg-foreground`. A 94%-lightness disc on a
                  0% ground made a 20px micro-control the single brightest
                  object on the screen; the hairline is what shapes it now, and
                  `shadow-soft` — black on black here — is gone. */}
              <button
                type="button"
                onClick={() => remove(u.localId)}
                className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-secondary p-0.5 text-foreground opacity-0 transition-[opacity,background-color,border-color,color] duration-fast ease-out-soft group-hover:opacity-100 hover:border-destructive hover:bg-destructive hover:text-destructive-foreground focus-visible:opacity-100 coarse:-right-2.5 coarse:-top-2.5 coarse:p-1.5 coarse:opacity-100"
                aria-label={`Remove ${u.fileName}`}
              >
                <ActionIcons.dismiss className="size-3 coarse:size-4" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The "+" menu: photos, files, library.
 *
 * A `<Button>` rather than a `<Pressable kind="icon">` because it is the
 * composer's own control family — same `composer-add-button` hook, same
 * quarter-turn on hover, same coarse growth as the mic and send beside it.
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
          className={cn(
            "composer-add-button group shrink-0 rounded-composer-control coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9",
            open && "bg-accent",
          )}
        >
          <AppIcons.new
            aria-hidden="true"
            strokeWidth={1.75}
            className="composer-add-icon size-4 transition-transform duration-base ease-out-strong group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
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
 * `rounded-composer` alone: the `sm:rounded-lg` override this used to carry
 * restated the shell's corner in a second file, so the overlay stopped tracing
 * the shell the moment the token moved — which it did, to 26px.
 *
 * `bg-primary/15`: over the true-black ground /10 tints to roughly 2%
 * lightness, so the scrim vanished and the dashed outline was left saying "drop
 * here" on its own.
 */
export function ComposerDropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-composer border-2 border-dashed border-primary/45 bg-primary/15 backdrop-blur-sm motion-safe:animate-fade-in">
      <ComposerIcons.files className="size-6 text-primary" aria-hidden="true" />
      <span className="font-mono text-label text-primary">Drop to attach</span>
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
