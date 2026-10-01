"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  githubSourceKey,
  sourceLabel,
  type LibrarySource,
  type SkillLibrary,
  type SkillSourceUpdateResult,
} from "@/lib/skills/library-contract";
import { openSkillDraftingChat } from "@/components/skills/add-skill-menu";
import { ImportSkillsDialog } from "@/components/skills/import-skills-dialog";
import { highlightClearMs, skillSourceAnchor } from "@/components/skills/skill-source-group";
import { SkillsLibraryView } from "@/components/skills/skills-library-view";
import { UpdateSourceDialog } from "@/components/skills/update-source-dialog";
import { useSkillLibrary } from "@/components/skills/use-skill-library";
import { PENDING_SKILL_MARKDOWN_KEY, updateOutcomeMessage } from "@/components/skills/skill-library-model";
import type { SkillImportOutcome, SkillImportPreview } from "@/components/skills/skills-transport";

/**
 * /skills, and /skills/import (the same page with the importer open).
 *
 * The composition is here and nothing is drawn here: the list is
 * `SkillsLibraryView`, the data is `useSkillLibrary`, and the three dialogs
 * (import, update, remove) are opened from the list's actions. Keeping the
 * page this thin is what lets the dev gallery render every piece against
 * fixtures without an account.
 */
export function SkillsLibraryPage({ importOnOpen = false }: { importOnOpen?: boolean }) {
  const router = useRouter();
  const reduce = useReducedMotion() ?? false;
  const { library, error, reload, setSkillEnabled, setSourceEnabled, removeSource } = useSkillLibrary();

  const [importing, setImporting] = React.useState(importOnOpen);
  // A new key per opening, so a chip pressed on the empty state starts the
  // importer on that repository even if it was opened with another before.
  const [importSeed, setImportSeed] = React.useState<{ key: number; source?: string }>({ key: 0 });
  const [updating, setUpdating] = React.useState<LibrarySource | null>(null);
  const [removing, setRemoving] = React.useState<LibrarySource | null>(null);
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const [highlight, setHighlight] = React.useState<string | null>(null);

  // A SKILL.md handed over from a chat answer ("Save as skill…"): the
  // importer opens on it, already read. Taken once, so a reload of
  // /skills/import doesn't bring it back.
  React.useEffect(() => {
    if (!importOnOpen) return;
    let pending: string | null = null;
    try {
      pending = window.sessionStorage.getItem(PENDING_SKILL_MARKDOWN_KEY);
      window.sessionStorage.removeItem(PENDING_SKILL_MARKDOWN_KEY);
    } catch {
      pending = null;
    }
    if (pending) setImportSeed((current) => ({ key: current.key + 1, source: pending ?? undefined }));
  }, [importOnOpen]);

  const openImporter = (source?: string) => {
    setImportSeed((current) => ({ key: current.key + 1, source }));
    setImporting(true);
  };

  const closeImporter = (open: boolean) => {
    setImporting(open);
    // The importer's own route closes back onto the library it sits over.
    if (!open && importOnOpen) router.replace("/skills");
  };

  /** Opens, scrolls to and flashes the group an install or update landed in. */
  const land = React.useCallback(
    (sourceId: string) => {
      setHighlight(sourceId);
      // Two frames: one for the folder to open, one for its rows to lay out.
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() =>
          document
            .getElementById(skillSourceAnchor(sourceId))
            ?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" })
        )
      );
      window.setTimeout(
        () => setHighlight((current) => (current === sourceId ? null : current)),
        highlightClearMs(reduce)
      );
    },
    [reduce]
  );

  const onInstalled = async (outcome: SkillImportOutcome, preview: SkillImportPreview) => {
    // A repository lands in its folder; a file, link or paste lands in Your
    // skills, which is already open at the top of the page.
    const repository = preview.repository
      ? `${preview.repository.owner}/${preview.repository.repo}`
      : preview.origin?.label ?? "your file";
    const next: SkillLibrary | null = await reload();
    const key = preview.repository ? githubSourceKey(preview.repository.owner, preview.repository.repo) : null;
    const landed =
      next?.sources.find((source) => source.id === outcome.source?.id) ??
      (key ? next?.sources.find((source) => source.key === key) : undefined);
    if (landed) land(landed.id);

    const count = outcome.imported.length;
    const notes = [
      outcome.blocked > 0
        ? outcome.blocked === 1
          ? "One came in switched off because Juno’s safety check blocked it."
          : `${outcome.blocked} came in switched off because Juno’s safety check blocked them.`
        : null,
      outcome.skipped.length > 0 ? outcome.skipped[0].message : null,
      // An import can join a repository the reader switched off, and then its
      // new skills are as off as the rest: said here, because the composer
      // will not offer them and nothing else would explain why.
      count > 0 && outcome.source?.enabled === false
        ? `${sourceLabel(outcome.source)} is switched off, so ${count === 1 ? "it won’t" : "they won’t"} show in chat until you turn it on.`
        : null,
    ].filter((note): note is string => note !== null);
    if (count === 0) {
      toast.error("Nothing was installed.", { description: notes.join(" ") || undefined });
      return;
    }
    toast.success(`Installed ${count} ${count === 1 ? "skill" : "skills"} from ${repository}`, {
      description: notes.join(" ") || undefined,
    });
  };

  const onUpdated = async (result: SkillSourceUpdateResult) => {
    await reload();
    const landed = result.source?.id ?? updating?.id;
    if (landed) land(landed);
    const from = result.source ? sourceLabel(result.source) : updating ? sourceLabel(updating) : "GitHub";
    const message = updateOutcomeMessage(result, from);
    (message.ok ? toast.success : toast.error)(message.title, { description: message.description });
  };

  const confirmRemove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    const count = removing.skills.length;
    const label = sourceLabel(removing);
    const removed = await removeSource(removing);
    setRemoveBusy(false);
    if (removed) {
      setRemoving(null);
      toast.success(`Removed ${label}`, {
        description: `${count} ${count === 1 ? "skill" : "skills"} removed.`,
      });
    }
  };

  return (
    <>
      <SkillsLibraryView
        library={library}
        error={error}
        onRetry={() => void reload()}
        skillHref={(skill) => `/skills/${skill.id}`}
        highlightSourceId={highlight}
        actions={{
          onToggleSkill: (skill, enabled) => void setSkillEnabled(skill, enabled),
          onToggleSource: (source, enabled) => void setSourceEnabled(source, enabled),
          onCheckUpdates: setUpdating,
          onRemoveSource: setRemoving,
          onImport: openImporter,
          onWrite: () => router.push("/skills/new"),
          onCreateWithJuno: () => openSkillDraftingChat((href) => router.push(href)),
        }}
      />

      <ImportSkillsDialog
        key={importSeed.key}
        open={importing}
        onOpenChange={closeImporter}
        initialSource={importSeed.source}
        onInstalled={(outcome, preview) => void onInstalled(outcome, preview)}
      />

      <UpdateSourceDialog
        source={updating}
        onOpenChange={(open) => {
          if (open) return;
          setUpdating(null);
          // A check writes what it saw to the source (`latestCommit`), so the
          // folder's "Update available" marker is re-read on the way out.
          void reload();
        }}
        onUpdated={(result) => void onUpdated(result)}
      />

      <RemoveSourceDialog
        source={removing}
        busy={removeBusy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
      />
    </>
  );
}

/** "Remove anthropics/skills?", with what goes and what stays. */
export function RemoveSourceDialog({
  source,
  busy,
  onCancel,
  onConfirm,
}: {
  source: LibrarySource | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Held so the copy does not blank out while the dialog animates closed.
  const [shown, setShown] = React.useState(source);
  React.useEffect(() => {
    if (source) setShown(source);
  }, [source]);
  const count = shown?.skills.length ?? 0;
  return (
    <Dialog open={source !== null} onOpenChange={(open) => (!open && !busy ? onCancel() : undefined)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            Remove <span translate="no">{shown ? sourceLabel(shown) : ""}</span>?
          </DialogTitle>
          <DialogDescription>
            {count === 1 ? (
              "Its skill is removed from Juno."
            ) : (
              <>
                Its <span className="tabular-nums">{count}</span> skills are removed from Juno.
              </>
            )}{" "}
            Chats that used them keep their history.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} loading={busy}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
