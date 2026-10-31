"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Archive, FilePlus, Globe, History } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { MENU_W } from "@/components/ui/menu-recipe";
import { ShareDialog } from "@/components/share/share-dialog";
import { VersionLineDiff, VersionPosterCompare } from "@/components/artifacts/version-diff";
import { diffableSource } from "@/lib/line-diff";
import { Phrase, PhraseWithArgs, formatPhrase, phraseText, usePhrase } from "@/lib/i18n-phrase";
import { formatClock, formatDate, useUiLocale } from "@/lib/i18n-format";
import { requestJson, type JsonResult } from "@/lib/artifact-response";
import { VERSION_ORIGIN_COPY, versionOriginLabel } from "@/lib/artifact-version-labels";
import { announceArtifactChanged } from "@/lib/artifact-events";
import type { PhraseSpec } from "@/lib/run/types";

/*
 * What a person can do with an artifact from its own page (and its Library
 * row, and the design workspace): publish, rename, history and compare,
 * restore, make a copy, download, move to Recently deleted. Lifecycle belongs
 * to the artifact, so it works even when its chat is gone.
 *
 * Every request goes through `requestJson`, which checks the status before it
 * parses anything: a gateway's HTML error page reads as a sentence here, never
 * as "Unexpected token '<'". History says how each version came to be in
 * words ("Edited by you"), and Compare is a real line diff of the whole of
 * both versions (a design compares as two pictures).
 */

const LIFECYCLE_COPY = {
  actions: "Artifact actions",
  actionsFor: "Actions for",
  publish: "Publish…",
  rename: "Rename…",
  history: "Version history…",
  restoreVersion: "Restore version",
  copy: "Make a copy",
  download: "Download this version",
  downloadHistory: "Download with history",
  trash: "Move to Recently deleted…",
  trashTitle: "Move to Recently deleted?",
  trashBody: "Its public links stop working until you restore it. You can bring it back from the Library.",
  trashConfirm: "Move to Recently deleted",
  restoreTitle: "Restore this version?",
  restoreBody: "This makes a new version from the one you are viewing. The later versions stay in history.",
  restoreConfirm: "Restore",
  cancel: "Cancel",
  saving: "Saving…",
  renameTitle: "Rename",
  renameLabel: "Name",
  renameConfirm: "Save name",
  historyTitle: "Version history",
  historyBody: "Every saved version, newest first. Open one to read, restore or publish it.",
  version: "Version",
  current: "Current",
  compare: "Compare",
  compareWithCurrent: "Compare with current",
  older: "Older versions",
  loading: "Loading…",
  compareTitle: "Compare versions",
  compareBody: "What changed between the version you picked and the current one.",
  copyMissing: "The copy was made, but its address is missing. Find it in the Library.",
  failed: "The action couldn’t finish. Try again.",
  emptyName: "Give it a name.",
} as const;

interface VersionEntry {
  version: number;
  origin: string | null;
  createdAt: string;
}

interface CompareState {
  older: string;
  newer: string;
  olderVersion: number;
  newerVersion: number;
}

function versionSpec(n: number): PhraseSpec {
  return { parts: [{ phrase: LIFECYCLE_COPY.version }, { kind: "number", value: n }] };
}

class ActionError extends Error {}

/** The data of a successful answer, or an ActionError carrying the sentence to show. */
function must(result: JsonResult): Record<string, unknown> {
  if (!result.ok) throw new ActionError(result.error);
  return result.data;
}

export function ArtifactLifecycleActions({
  id,
  title,
  version,
  latest,
  type,
  renamable = true,
}: {
  id: string;
  title: string;
  version: number;
  latest: number;
  /** The artifact's type, when the caller knows it: a design compares as pictures. */
  type?: string;
  /** False where the surface has its own name field (the design workspace). */
  renamable?: boolean;
}) {
  const router = useRouter();
  const locale = useUiLocale();
  const [publishing, setPublishing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [name, setName] = React.useState(title);
  const [shownTitle, setShownTitle] = React.useState(title);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [history, setHistory] = React.useState<VersionEntry[]>([]);
  const [nextBefore, setNextBefore] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [compare, setCompare] = React.useState<CompareState | null>(null);
  const actionsLabel = usePhrase(LIFECYCLE_COPY.actions);
  React.useEffect(() => setShownTitle(title), [title]);

  const base = `/api/artifacts/${encodeURIComponent(id)}`;
  const isDesign = type === "DESIGN";

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ActionError ? caught.message : formatPhrase(LIFECYCLE_COPY.failed));
    } finally {
      setBusy(false);
    }
  };

  const loadHistory = async (before?: number) => {
    const data = must(await requestJson(`${base}/versions?limit=50${before ? `&before=${before}` : ""}`));
    const rows = Array.isArray(data.versions) ? (data.versions as VersionEntry[]) : [];
    setHistory((current) => (before ? [...current, ...rows] : rows));
    setNextBefore(typeof data.nextBefore === "number" ? data.nextBefore : null);
  };

  const duplicate = () =>
    run(async () => {
      const data = must(
        await requestJson(`${base}/duplicate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version }),
        })
      );
      if (typeof data.url !== "string") throw new ActionError(formatPhrase(LIFECYCLE_COPY.copyMissing));
      announceArtifactChanged({ id, kind: "created" });
      router.push(data.url);
    });

  const restore = () =>
    run(async () => {
      const data = must(await requestJson(`${base}/versions/${version}`));
      const body = data.version as { content?: unknown } | undefined;
      if (typeof body?.content !== "string") throw new ActionError(formatPhrase(LIFECYCLE_COPY.failed));
      must(
        await requestJson(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: body.content, baseVersion: latest, origin: "restore" }),
        })
      );
      setRestoring(false);
      announceArtifactChanged({ id, kind: "updated" });
      router.push(`/a/${encodeURIComponent(id)}`);
      router.refresh();
    });

  const remove = () =>
    run(async () => {
      must(await requestJson(base, { method: "DELETE" }));
      setDeleting(false);
      announceArtifactChanged({ id, kind: "deleted" });
      router.push("/library");
      router.refresh();
    });

  const rename = () =>
    run(async () => {
      const next = name.trim();
      if (!next) throw new ActionError(formatPhrase(LIFECYCLE_COPY.emptyName));
      if (next === shownTitle) {
        setRenaming(false);
        return;
      }
      must(
        await requestJson(base, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: next }),
        })
      );
      setShownTitle(next);
      setRenaming(false);
      announceArtifactChanged({ id, kind: "updated", title: next });
      router.refresh();
    });

  const compareVersion = (olderVersion: number) =>
    run(async () => {
      if (isDesign) {
        setCompare({ older: "", newer: "", olderVersion, newerVersion: latest });
        return;
      }
      const [old, current] = await Promise.all([requestJson(`${base}/versions/${olderVersion}`), requestJson(`${base}/versions/${latest}`)]);
      const olderBody = (must(old).version as { content?: unknown } | undefined)?.content;
      const newerBody = (must(current).version as { content?: unknown } | undefined)?.content;
      if (typeof olderBody !== "string" || typeof newerBody !== "string") throw new ActionError(formatPhrase(LIFECYCLE_COPY.failed));
      setCompare({ older: diffableSource(type, olderBody), newer: diffableSource(type, newerBody), olderVersion, newerVersion: latest });
    });

  const when = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : `${formatDate(date, "medium", locale)}, ${formatClock(date, locale)}`;
  };

  const actionsFor = phraseText({ parts: [{ phrase: LIFECYCLE_COPY.actionsFor }, { kind: "quote", value: shownTitle }] });
  const anyDialog = deleting || restoring || historyOpen || renaming || compare !== null;

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <DropdownMenuTrigger asChild>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={actionsFor} disabled={busy}>
                <ActionIcons.more className="size-4" />
              </Button>
            </TooltipTrigger>
          </DropdownMenuTrigger>
          <TooltipContent>{actionsLabel}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className={MENU_W}>
          <DropdownMenuItem
            onSelect={() => {
              setError(null);
              setPublishing(true);
            }}
          >
            <Globe className="size-4" aria-hidden />
            <Phrase text={LIFECYCLE_COPY.publish} />
          </DropdownMenuItem>
          {renamable && (
            <DropdownMenuItem
              onSelect={() => {
                setError(null);
                setName(shownTitle);
                setRenaming(true);
              }}
            >
              <ActionIcons.edit className="size-4" aria-hidden />
              <Phrase text={LIFECYCLE_COPY.rename} />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              setHistoryOpen(true);
              void run(() => loadHistory());
            }}
          >
            <History className="size-4" aria-hidden />
            <Phrase text={LIFECYCLE_COPY.history} />
          </DropdownMenuItem>
          {version < latest ? (
            <DropdownMenuItem
              onSelect={() => {
                setError(null);
                setRestoring(true);
              }}
            >
              <ActionIcons.restore className="size-4" aria-hidden />
              <PhraseWithArgs spec={{ parts: [{ phrase: LIFECYCLE_COPY.restoreVersion }, { kind: "number", value: version }] }} />
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => void duplicate()}>
            <FilePlus className="size-4" aria-hidden />
            <Phrase text={LIFECYCLE_COPY.copy} />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <a href={`${base}/download?version=${version}`} download>
              <ActionIcons.download className="size-4" aria-hidden />
              <Phrase text={LIFECYCLE_COPY.download} />
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`${base}/download?version=${version}&format=zip&history=1`} download>
              <Archive className="size-4" aria-hidden />
              <Phrase text={LIFECYCLE_COPY.downloadHistory} />
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              setError(null);
              setDeleting(true);
            }}
          >
            <ActionIcons.delete className="size-4" aria-hidden />
            <Phrase text={LIFECYCLE_COPY.trash} />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {!anyDialog && error ? (
        <span role="alert" className="text-caption text-destructive">
          {error}
        </span>
      ) : null}

      {/* Opened from "Publish…", so it opens on the public side of the choice. */}
      <ShareDialog kind="ARTIFACT" artifactId={id} open={publishing} onOpenChange={setPublishing} initialAudience="link" />

      <ConfirmDialog
        open={deleting || restoring}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(false);
            setRestoring(false);
          }
        }}
        busy={busy}
        tone={deleting ? "destructive" : "default"}
        title={deleting ? <Phrase text={LIFECYCLE_COPY.trashTitle} /> : <Phrase text={LIFECYCLE_COPY.restoreTitle} />}
        description={
          <>
            {deleting ? (
              <bdi className="block truncate font-medium text-foreground">{shownTitle}</bdi>
            ) : (
              <PhraseWithArgs spec={versionSpec(version)} className="block font-medium text-foreground" />
            )}
            <Phrase text={deleting ? LIFECYCLE_COPY.trashBody : LIFECYCLE_COPY.restoreBody} />
          </>
        }
        cancelLabel={<Phrase text={LIFECYCLE_COPY.cancel} />}
        confirmLabel={deleting ? <Phrase text={LIFECYCLE_COPY.trashConfirm} /> : <Phrase text={LIFECYCLE_COPY.restoreConfirm} />}
        onConfirm={() => void (deleting ? remove() : restore())}
      >
        {error ? (
          <p role="alert" className="text-ui text-destructive">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>

      <Dialog open={renaming} onOpenChange={(open) => !busy && setRenaming(open)}>
        <DialogContent className="max-w-sm">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>
                <Phrase text={LIFECYCLE_COPY.renameTitle} />
              </DialogTitle>
            </DialogHeader>
            <label className="grid gap-1.5 text-ui">
              <span className="text-muted-foreground">
                <Phrase text={LIFECYCLE_COPY.renameLabel} />
              </span>
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} autoFocus onFocus={(event) => event.currentTarget.select()} />
            </label>
            {error ? (
              <p role="alert" className="text-ui text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setRenaming(false)}>
                <Phrase text={LIFECYCLE_COPY.cancel} />
              </Button>
              <Button type="submit" loading={busy} disabled={!name.trim()}>
                <Phrase text={LIFECYCLE_COPY.renameConfirm} />
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <Phrase text={LIFECYCLE_COPY.historyTitle} />
            </DialogTitle>
            <DialogDescription>
              <Phrase text={LIFECYCLE_COPY.historyBody} />
            </DialogDescription>
          </DialogHeader>
          {error && !compare ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}
          <ul className="max-h-96 overflow-y-auto" aria-busy={busy || undefined}>
            {history.map((item) => {
              const origin = versionOriginLabel(item.origin)?.long ?? VERSION_ORIGIN_COPY.saved;
              return (
                <li key={item.version} className="flex items-center justify-between gap-3 border-b border-border/60 py-3 last:border-b-0">
                  <Link href={`/a/${encodeURIComponent(id)}?v=${item.version}`} onClick={() => setHistoryOpen(false)} className="min-w-0 rounded-xs text-ui hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <PhraseWithArgs spec={item.version === latest ? [versionSpec(item.version), { parts: [{ phrase: LIFECYCLE_COPY.current }] }] : versionSpec(item.version)} />
                    <span className="mt-1 block text-caption text-muted-foreground">
                      <Phrase text={origin} /> · {when(item.createdAt)}
                    </span>
                  </Link>
                  {item.version < latest ? (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void compareVersion(item.version)} aria-label={phraseText([versionSpec(item.version), { parts: [{ phrase: LIFECYCLE_COPY.compareWithCurrent }] }])}>
                      <Phrase text={LIFECYCLE_COPY.compare} />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {busy ? (
            <p role="status" className="text-caption text-muted-foreground">
              <Phrase text={LIFECYCLE_COPY.loading} />
            </p>
          ) : null}
          {nextBefore ? (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => loadHistory(nextBefore))}>
              <Phrase text={LIFECYCLE_COPY.older} />
            </Button>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={compare !== null} onOpenChange={(open) => !open && setCompare(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              <Phrase text={LIFECYCLE_COPY.compareTitle} />
            </DialogTitle>
            <DialogDescription>
              <Phrase text={LIFECYCLE_COPY.compareBody} />
            </DialogDescription>
          </DialogHeader>
          {compare ? (
            isDesign ? (
              <VersionPosterCompare artifactId={id} olderVersion={compare.olderVersion} newerVersion={compare.newerVersion} title={shownTitle} />
            ) : (
              <VersionLineDiff older={compare.older} newer={compare.newer} olderLabel={`v${compare.olderVersion}`} newerLabel={`v${compare.newerVersion}`} />
            )
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
