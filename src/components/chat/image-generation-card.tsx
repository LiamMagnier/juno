"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { GenerationPlaceholder } from "@/components/chat/generation-placeholder";
import { GeneratedImage, GeneratedImageGrid, type GenerationHandoff } from "@/components/chat/generated-media";
import { outputCount, requestedRatio } from "@/components/chat/generation-frame";
import { useUiLocale } from "@/lib/i18n-format";
import { shellString, type ShellStringKey } from "@/lib/strings";
import { imageEditSupport, resolveModel } from "@/lib/models";
import { cn } from "@/lib/utils";
import type { ClientImageGeneration, ImageFailureCode, ImageGenerationFailure } from "@/lib/media/image-generation";
import type { ClientAttachment } from "@/types/chat";

/*
 * A PICTURE MADE IN CHAT (G04): the `imageGeneration` activity row of a
 * `generate_image` call, drawn where the answer's media goes.
 *
 *   generating  the generation placeholder at the shape the call asked for
 *               (generation-placeholder.tsx: the drifting field, the truthful
 *               stage word and real seconds; its motion is generation.css'
 *               tokens and stops under reduced motion)
 *   done        the pictures, landing in that same box and resolving
 *               (generated-media.tsx' reveal, skipped under reduced motion),
 *               each with Download · Copy · Vary · Open in Library, the
 *               on-image Edit, and one quiet line: which model, where it was
 *               saved, that it is AI-generated
 *   failed      a calm card that names the real cause (the shell string for
 *               the failure code), never "something went wrong"
 *
 * Every word is the shared string table's (contracts/product/juno-shell-v1.json),
 * so the web, the Mac and the iPhone say the same thing in English and French.
 */

const FAILURE_KEY: Record<ImageFailureCode, ShellStringKey> = {
  no_image_model: "image.failureNoModel",
  not_configured: "image.failureNotConfigured",
  provider_unavailable: "image.failureUnavailable",
  plan_required: "image.failurePlan",
  budget_exceeded: "image.failureBudget",
  rate_limited: "image.failureRateLimited",
  quota_exhausted: "image.failureQuota",
  policy_violation: "image.failurePolicy",
  workspace_disabled: "image.failureWorkspace",
  edit_unsupported: "image.failureEdit",
  reference_missing: "image.failureReference",
  library_full: "image.failureLibraryFull",
  too_many_calls: "image.failureTooMany",
  not_requested: "image.failureNotRequested",
  provider_error: "image.failureProvider",
};

/** The failure in the reader's language, with the model and plan it names. */
export function imageFailureSentence(
  failure: ImageGenerationFailure,
  modelName: string | null,
  locale: string,
): string {
  const key = FAILURE_KEY[failure.code];
  const model = failure.model ?? modelName;
  // A sentence that needs a model the row does not have falls back to the
  // server's own words rather than printing "{model}".
  if (!key || (!model && /\{model\}/.test(shellString(key, {}, "en")))) return failure.message;
  return shellString(key, { model: model ?? "", plan: planName(failure.plan) }, locale);
}

function planName(plan: string | null | undefined): string {
  if (!plan) return "";
  return plan.charAt(0) + plan.slice(1).toLowerCase();
}

/** The model a Vary or Edit runs on: the one that made the picture, when it can work from a reference. */
export function varyModelFor(generation: Pick<ClientImageGeneration, "modelId">): string | null {
  const model = generation.modelId ? resolveModel(generation.modelId) : null;
  if (!model || model.modality !== "image") return null;
  return imageEditSupport(model.provider) === "none" ? null : model.id;
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}

/** The clipboard takes PNG everywhere; anything else is redrawn as one first. */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("encode"))), "image/png"),
  );
}

async function downloadImage(attachment: ClientAttachment) {
  try {
    const blob = await fetchBlob(attachment.url);
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = attachment.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
  } catch {
    // A storage URL the page cannot read as a blob still opens: the browser
    // saves it from there.
    window.open(attachment.url, "_blank", "noopener,noreferrer");
  }
}

async function copyImage(attachment: ClientAttachment, locale: string) {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("unsupported");
    // The promise form keeps Safari's user-activation window open while the
    // bytes download.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": fetchBlob(attachment.url).then(asPng) })]);
    toast.success(shellString("image.copied", {}, locale));
  } catch {
    try {
      await navigator.clipboard.writeText(new URL(attachment.url, window.location.href).toString());
      toast.message(shellString("image.copyFailed", {}, locale));
    } catch {
      toast.error(shellString("image.copyFailed", {}, locale));
    }
  }
}

function CardAction({
  label,
  onClick,
  href,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  children: React.ReactNode;
}) {
  const body = href ? (
    <Pressable kind="icon" size="md" asChild aria-label={label}>
      <Link href={href}>{children}</Link>
    </Pressable>
  ) : (
    <Pressable kind="icon" size="md" onClick={onClick} aria-label={label}>
      {children}
    </Pressable>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export interface ImageGenerationCardProps {
  generation: ClientImageGeneration;
  /** The files, from the answer's attachments when saved, else the live row's. */
  attachments: ClientAttachment[];
  /** The turn is still streaming here: a finished picture reveals from its placeholder. */
  live: boolean;
  /** Region or whole-picture edit (image-edit-overlay.tsx), with the model that made it. */
  onEdit?: (attachment: ClientAttachment, origin: DOMRect | undefined, sourceModelId: string | null) => void;
  /** A variation, made with the picture as its reference. */
  onVary?: (attachment: ClientAttachment, modelId: string) => void;
}

export function ImageGenerationCard({ generation, attachments, live, onEdit, onVary }: ImageGenerationCardProps) {
  const locale = useUiLocale();
  const say = (key: ShellStringKey, vars: Record<string, string | number> = {}) => shellString(key, vars, locale);
  // The shape the call asked for, so the result lands in the placeholder's box.
  const handoff = React.useMemo<GenerationHandoff | null>(
    () =>
      live
        ? { modality: "image", ratio: requestedRatio("image", generation.aspect ?? undefined), count: outputCount(generation.count) }
        : null,
    [live, generation.aspect, generation.count],
  );

  if (generation.status === "generating") {
    return (
      <figure className="mb-3 space-y-1.5" aria-label={say("image.create")} data-image-generation="generating">
        <GenerationPlaceholder
          progress={{ modality: "image", stage: "generating", aspect: generation.aspect ?? undefined, count: generation.count }}
        />
        {generation.modelName && (
          <figcaption className="font-mono text-label text-muted-foreground">{generation.modelName}</figcaption>
        )}
      </figure>
    );
  }

  if (generation.status === "failed") {
    const failure = generation.failure ?? { code: "provider_error" as const, message: "" };
    return (
      <div
        role="status"
        data-image-generation="failed"
        data-failure={failure.code}
        className="mb-3 flex max-w-[480px] items-start gap-2.5 rounded-field border border-border/70 bg-muted/40 px-3.5 py-3 text-ui"
      >
        <StatusIcons.error className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-foreground">{say("image.failedTitle")}</p>
          <p className="text-muted-foreground">{imageFailureSentence(failure, generation.modelName, locale)}</p>
        </div>
      </div>
    );
  }

  const varyModel = varyModelFor(generation);
  const caption = [
    generation.modelName
      ? generation.auto
        ? say("image.autoPicked", { model: generation.modelName })
        : say("image.madeWith", { model: generation.modelName })
      : null,
    say("image.savedToLibrary"),
    // AI Act art. 50: plain small words under what a model made (the files
    // carry the machine-readable marking too).
    say("image.aiGenerated"),
  ].filter((part): part is string => !!part);

  const actions = (attachment: ClientAttachment) => (
    <div className="flex items-center gap-0.5 text-muted-foreground" role="group" aria-label={attachment.fileName}>
      <CardAction label={say("image.download")} onClick={() => void downloadImage(attachment)}>
        <ActionIcons.download className="size-4" aria-hidden="true" />
      </CardAction>
      <CardAction label={say("image.copy")} onClick={() => void copyImage(attachment, locale)}>
        <ActionIcons.copy className="size-4" aria-hidden="true" />
      </CardAction>
      {onVary && varyModel && (
        <CardAction label={say("image.vary")} onClick={() => onVary(attachment, varyModel)}>
          <ActionIcons.refresh className="size-4" aria-hidden="true" />
        </CardAction>
      )}
      <CardAction label={say("image.openLibrary")} href="/library?view=files">
        <AppIcons.library className="size-4" aria-hidden="true" />
      </CardAction>
    </div>
  );

  const editFor = (attachment: ClientAttachment) =>
    onEdit ? (origin?: DOMRect) => onEdit(attachment, origin, generation.modelId) : undefined;

  return (
    <figure className="mb-3 space-y-1" data-image-generation="done" aria-label={generation.prompt || say("image.create")}>
      {attachments.length > 1 ? (
        <GeneratedImageGrid
          attachments={attachments}
          handoff={handoff}
          renderTile={(attachment, index) => (
            <div key={attachment.id} className="min-w-0 space-y-0.5">
              <GeneratedImage attachment={attachment} handoff={handoff} index={index} tile onEdit={editFor(attachment)} />
              {actions(attachment)}
            </div>
          )}
        />
      ) : (
        attachments.map((attachment) => (
          <div key={attachment.id} className="space-y-0.5">
            <GeneratedImage attachment={attachment} handoff={handoff} onEdit={editFor(attachment)} />
            {actions(attachment)}
          </div>
        ))
      )}
      <figcaption className={cn("flex flex-wrap gap-x-1.5 text-label text-muted-foreground")}>
        {caption.map((part, index) => (
          <React.Fragment key={part}>
            {index > 0 && <span aria-hidden="true">·</span>}
            <span>{part}</span>
          </React.Fragment>
        ))}
      </figcaption>
    </figure>
  );
}

/** The image calls on one answer's activity, in order, each once (the last state of a re-sent row wins). */
export function imageGenerationsOf(
  activity: ReadonlyArray<{ id: string; imageGeneration?: ClientImageGeneration }> | undefined,
): Array<{ id: string; generation: ClientImageGeneration }> {
  if (!activity?.length) return [];
  const byCall = new Map<string, { id: string; generation: ClientImageGeneration }>();
  for (const event of activity) {
    if (!event.imageGeneration) continue;
    byCall.set(event.imageGeneration.callId, { id: event.id, generation: event.imageGeneration });
  }
  return [...byCall.values()];
}

/** The files a card shows: the saved answer's attachments by id, else the live row's own. */
export function attachmentsForGeneration(
  generation: ClientImageGeneration,
  messageAttachments: readonly ClientAttachment[],
): ClientAttachment[] {
  const byId = new Map(messageAttachments.map((attachment) => [attachment.id, attachment]));
  const saved = generation.attachmentIds.map((id) => byId.get(id)).filter((a): a is ClientAttachment => !!a);
  if (saved.length === generation.attachmentIds.length && saved.length > 0) return saved;
  return generation.images?.length ? [...generation.images] : saved;
}
