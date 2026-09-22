"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useUploads } from "@/hooks/use-uploads";
import { DOC_MIME } from "@/lib/uploads";
import { CodeIcons } from "@/lib/app-icons";
import { MAX_SKILL_RESOURCES, type SkillResource } from "@/lib/work/skills";

/**
 * What the file picker offers: documents only.
 *
 * `attachedSources` in scripts/work-runner.ts reads `Attachment.extractedText`,
 * which is null for a photo, so offering images here would promise the skill a
 * look at a picture it can never get, and the promise would be kept for every
 * run of it. The two Work composers carry their own copies of this list beside
 * the same statement; anybody widening one is told.
 */
const SKILL_RESOURCE_ACCEPT = [...DOC_MIME, ".txt", ".md", ".csv", ".json", ".ts", ".tsx", ".js", ".py"].join(",");

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  resources: SkillResource[];
}

/**
 * Editing a skill you wrote: its name, its one line, its instructions and the
 * files it brings, saved together.
 *
 * ONE SAVE, BECAUSE A VERSION IS ONE SNAPSHOT. The instructions and the files
 * are minted into a new version together, and the name and description are
 * patched on the skill in the same press, so there is never a half-saved
 * state to explain. Earlier versions stay readable in History, which is what
 * lets a run from last month keep saying which instructions it followed.
 *
 * A finished upload moves straight into the file list (and leaves the upload
 * list) so there is one list of what the skill will bring, not two; a failed
 * one stays where it is until dismissed, so the failure is seen.
 */
export function SkillEditor({
  initial,
  slug,
  missingVersion,
  onSave,
  onCancel,
}: {
  initial: SkillDraft;
  slug: string;
  /** The skill points at a version that is not there: the box starts empty and says why. */
  missingVersion: boolean;
  /** Resolves true when everything saved. */
  onSave: (draft: SkillDraft) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState<SkillDraft>(initial);
  const [saving, setSaving] = React.useState(false);
  const { uploads, addFiles, remove: dropUpload, isUploading } = useUploads(null);
  const picker = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const done = uploads.filter((upload) => upload.status === "done" && upload.attachment);
    if (done.length === 0) return;
    setDraft((current) => {
      const held = new Set(current.resources.map((resource) => resource.attachmentId));
      const added = done
        .filter((upload) => !held.has(upload.attachment!.id))
        .map((upload) => ({ attachmentId: upload.attachment!.id, fileName: upload.attachment!.fileName }));
      const next = [...current.resources, ...added];
      if (next.length > MAX_SKILL_RESOURCES) toast.error("A skill can bring up to 32 files.");
      return { ...current, resources: next.slice(0, MAX_SKILL_RESOURCES) };
    });
    for (const upload of done) dropUpload(upload.localId);
  }, [uploads, dropUpload]);

  const changed =
    draft.name.trim() !== initial.name ||
    draft.description.trim() !== initial.description ||
    draft.instructions.trim() !== initial.instructions.trim() ||
    draft.resources.length !== initial.resources.length ||
    draft.resources.some((resource, index) => resource.attachmentId !== initial.resources[index]?.attachmentId);
  const valid = draft.name.trim().length > 0 && draft.instructions.trim().length > 0;

  const save = async () => {
    if (!valid || !changed || saving) return;
    setSaving(true);
    const ok = await onSave({
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
      instructions: draft.instructions.trim(),
    });
    setSaving(false);
    if (ok) onCancel();
  };

  const pending = uploads.filter((upload) => upload.status !== "done");

  return (
    <form
      className="space-y-6 motion-safe:animate-fade-in"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="skill-edit-name">Name</Label>
          <Input
            id="skill-edit-name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            disabled={saving}
            className="mt-1.5"
          />
          <p className="mt-1.5 text-caption text-muted-foreground">
            Still typed as{" "}
            <span className="font-mono text-foreground" translate="no">
              /{slug}
            </span>
          </p>
        </div>
        <div>
          <Label htmlFor="skill-edit-description">Description</Label>
          <Input
            id="skill-edit-description"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            disabled={saving}
            className="mt-1.5"
          />
          <p className="mt-1.5 text-caption text-muted-foreground">One line. Juno matches requests against it.</p>
        </div>
      </div>

      <div>
        <Label htmlFor="skill-edit-instructions">Instructions</Label>
        {missingVersion ? (
          <p className="mt-1 text-caption text-warning-foreground">
            The saved instructions are missing. What you write here becomes the current version.
          </p>
        ) : null}
        <Textarea
          id="skill-edit-instructions"
          value={draft.instructions}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          rows={16}
          disabled={saving}
          spellCheck
          className="mt-1.5 font-mono text-ui leading-relaxed"
        />
        <p className="mt-1.5 text-caption text-muted-foreground">Markdown. Write it the way you would brief a person.</p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-ui font-medium text-foreground">Files</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-mr-2 gap-1.5"
            disabled={saving || isUploading || draft.resources.length >= MAX_SKILL_RESOURCES}
            onClick={() => picker.current?.click()}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add files
          </Button>
        </div>
        <p className="mt-0.5 text-caption text-muted-foreground">
          Templates and references the skill works from. Juno reads them, never runs them.
        </p>
        <input
          ref={picker}
          type="file"
          multiple
          accept={SKILL_RESOURCE_ACCEPT}
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) addFiles(event.target.files);
            // Cleared so picking the same file twice still fires a change.
            event.target.value = "";
          }}
        />
        {draft.resources.length > 0 || pending.length > 0 ? (
          <ul className="mt-2.5 divide-y divide-border/70 overflow-hidden rounded-field border border-border">
            {draft.resources.map((resource) => (
              <li key={resource.attachmentId} className="group flex items-center gap-2.5 px-3 py-2">
                <CodeIcons.file className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-ui text-foreground">{resource.fileName}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  className="h-7 px-2 text-muted-foreground"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      resources: draft.resources.filter((entry) => entry.attachmentId !== resource.attachmentId),
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
            {pending.map((upload) => (
              <li key={upload.localId} className="flex items-center gap-2.5 px-3 py-2">
                {upload.status === "uploading" ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                ) : (
                  <CodeIcons.file className="size-4 shrink-0 text-destructive" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">{upload.fileName}</span>
                {upload.status === "uploading" ? (
                  <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
                    {upload.progress}%
                  </span>
                ) : (
                  <>
                    <span className="shrink-0 text-caption text-destructive">Upload failed</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-muted-foreground"
                      onClick={() => dropUpload(upload.localId)}
                    >
                      Dismiss
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Held at the bottom of the scroll while the instructions run long,
          so Save is never a scroll away from the text it saves. */}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-background py-3">
        <Button type="submit" disabled={!valid || !changed || isUploading} loading={saving}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <p className="ml-auto text-caption text-muted-foreground">
          Saving makes a new version. Earlier ones stay in History.
        </p>
      </div>
    </form>
  );
}
