"use client";

import * as React from "react";
import { AnimatePresence } from "framer-motion";
import { ArrowRight } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { StatusIcons } from "@/lib/app-icons";
import {
  sourceLabel,
  type LibrarySource,
  type SkillSourceChange,
  type SkillSourceUpdateCheck,
  type SkillSourceUpdateResult,
} from "@/lib/skills/library-contract";
import { cn } from "@/lib/utils";
import { SkillDialogContent, SkillDialogFixed, SkillDialogStep } from "@/components/skills/skill-dialog-shell";
import { SkillSourceAvatar } from "@/components/skills/skill-source-avatar";
import { shortCommit, updateCheckHasChoices } from "@/components/skills/skill-library-model";
import { checkSkillSource, skillsFailureMessage, updateSkillSource } from "@/components/skills/skills-transport";

export interface UpdateSourceHandlers {
  check?: typeof checkSkillSource;
  update?: typeof updateSkillSource;
}

/**
 * Bringing an installed repository up to date, skill by skill.
 *
 * NOTHING UPSTREAM LANDS UNREAD. The dialog asks the server what changed
 * since the installed commit, lists it in three kinds, and sends back the
 * commit it was shown along with the paths the reader kept ticked, so an
 * update can never apply something newer than the list on screen. Changed
 * skills start ticked (they are the ones already installed); new ones start
 * unticked (installing is a separate decision); skills removed upstream are
 * listed and never removed here, because the reader may still be using them.
 * A change that asks for more tools says so on its row: the new version will
 * wait for approval on the skill's page, exactly like any other version that
 * widens what it asks for.
 */
export function UpdateSourceDialog({
  source,
  onOpenChange,
  onUpdated,
  handlers,
}: {
  /** The source being updated; null closes the dialog. */
  source: LibrarySource | null;
  onOpenChange: (open: boolean) => void;
  onUpdated: (result: SkillSourceUpdateResult) => void;
  handlers?: UpdateSourceHandlers;
}) {
  // Held so the panel keeps its content while it animates closed.
  const [shown, setShown] = React.useState(source);
  React.useEffect(() => {
    if (source) setShown(source);
  }, [source]);
  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <SkillDialogContent>
        {shown ? (
          <UpdateSourceFlow
            key={shown.id}
            source={shown}
            onDone={(result) => {
              onUpdated(result);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
            handlers={handlers}
          />
        ) : null}
      </SkillDialogContent>
    </Dialog>
  );
}

type CheckState =
  | { kind: "checking" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; check: SkillSourceUpdateCheck };

export function UpdateSourceFlow({
  source,
  onDone,
  onCancel,
  handlers,
  initialCheck,
}: {
  source: LibrarySource;
  onDone: (result: SkillSourceUpdateResult) => void;
  onCancel: () => void;
  handlers?: UpdateSourceHandlers;
  /** Fixture: skip the request and show this answer (the dev gallery). */
  initialCheck?: SkillSourceUpdateCheck;
}) {
  const check = handlers?.check ?? checkSkillSource;
  const update = handlers?.update ?? updateSkillSource;
  const [state, setState] = React.useState<CheckState>(
    initialCheck ? { kind: "ready", check: initialCheck } : { kind: "checking" }
  );
  const [picked, setPicked] = React.useState<Set<string>>(() =>
    initialCheck ? new Set(initialCheck.changed.map((change) => change.path)) : new Set()
  );
  const [applying, setApplying] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);

  const run = React.useCallback(async () => {
    setState({ kind: "checking" });
    setRefusal(null);
    const result = await check(source.id);
    if (result.kind === "ok") {
      setState({ kind: "ready", check: result.value });
      setPicked(new Set(result.value.changed.map((change) => change.path)));
      return;
    }
    setState({
      kind: "failed",
      message: skillsFailureMessage(result, "Couldn’t check this repository for updates. Nothing has changed."),
    });
  }, [check, source.id]);

  const started = React.useRef(Boolean(initialCheck));
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  const apply = async () => {
    if (state.kind !== "ready" || applying) return;
    const { changed, added, latestCommit } = state.check;
    setApplying(true);
    setRefusal(null);
    const result = await update(source.id, {
      commit: latestCommit,
      update: changed.filter((change) => picked.has(change.path)).map((change) => change.path),
      install: added.filter((change) => picked.has(change.path)).map((change) => change.path),
    });
    setApplying(false);
    if (result.kind === "ok") {
      onDone(result.value);
      return;
    }
    if (result.kind === "blocked" && result.reason === "source_moved") {
      // The server refused because the repository moved past the commit this
      // list was checked at. Checking again is the only way forward, so it is
      // done here rather than left to the reader to find: close, reopen.
      await run();
      setRefusal("The repository changed while you were looking. This is what it holds now.");
      return;
    }
    setRefusal(skillsFailureMessage(result, "Couldn’t apply the update. Every skill is as it was."));
  };

  const label = sourceLabel(source);
  const toCommit = state.kind === "ready" ? state.check.latestCommit : source.latestCommit;
  const count = picked.size;
  // "Install" when every ticked row is a skill new upstream: nothing already
  // installed is being replaced, and "Update 1 skill" would say it was.
  const installsOnly =
    state.kind === "ready" && count > 0 && !state.check.changed.some((change) => picked.has(change.path));
  // New upstream skills count as something to do even when every installed
  // one matches (the server's `upToDate`); see `updateCheckHasChoices`.
  const nothingToDo = state.kind === "ready" && !updateCheckHasChoices(state.check);
  const removedCount = state.kind === "ready" ? state.check.removed.length : 0;

  return (
    <>
      <SkillDialogFixed className="shrink-0 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
        <div className="flex items-center gap-3 pr-10">
          <SkillSourceAvatar owner={source.owner} size="md" />
          <div className="min-w-0">
            <DialogTitle className="truncate text-heading">
              Update <span translate="no">{label}</span>
            </DialogTitle>
            <DialogDescription className="mt-0.5 flex items-center gap-1.5 font-mono text-caption" translate="no">
              {shortCommit(source.commit)}
              {toCommit && toCommit !== source.commit ? (
                <>
                  <ArrowRight className="size-3" aria-hidden="true" motion="none" />
                  {shortCommit(toCommit)}
                </>
              ) : null}
            </DialogDescription>
          </div>
        </div>
      </SkillDialogFixed>

      <AnimatePresence mode="popLayout" initial={false}>
        {state.kind === "checking" ? (
          <SkillDialogStep key="checking" className="border-t border-border/70">
            <div role="status" aria-label="Checking for updates" className="divide-y divide-border/70">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-3 px-5 py-3.5 sm:px-6">
                  <Skeleton className="size-[18px] shrink-0 rounded-xs" />
                  <Skeleton className="h-4 w-40 rounded-sm" />
                  <Skeleton className="ml-auto h-3.5 w-24 rounded-sm" />
                </div>
              ))}
            </div>
          </SkillDialogStep>
        ) : state.kind === "failed" ? (
          <SkillDialogStep key="failed" className="px-5 pb-5 sm:px-6 sm:pb-6">
            <WorkStateNote
              tone="error"
              action={
                <Button size="sm" variant="outline" onClick={() => void run()}>
                  Try again
                </Button>
              }
            >
              {state.message}
            </WorkStateNote>
          </SkillDialogStep>
        ) : nothingToDo ? (
          <SkillDialogStep key="current" className="px-5 pb-5 sm:px-6 sm:pb-6">
            <p className="flex items-center gap-2 text-ui text-muted-foreground">
              <StatusIcons.success className="size-4 text-success-ink" aria-hidden="true" />
              Up to date. Every installed skill matches the repository.
            </p>
            {removedCount > 0 ? (
              // Nothing to choose, but not nothing to say: these are still
              // installed here and still run, from files that no longer exist.
              <p className="mt-2 pl-6 text-caption text-muted-foreground">
                {removedCount === 1 ? (
                  "One installed skill is no longer in the repository. It stays installed here."
                ) : (
                  <>
                    <span className="tabular-nums">{removedCount}</span> installed skills are no longer in the
                    repository. They stay installed here.
                  </>
                )}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end">
              <Button variant="secondary" onClick={onCancel}>
                Done
              </Button>
            </div>
          </SkillDialogStep>
        ) : (
          <SkillDialogStep key="ready" className="min-h-0 flex-1">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-y border-border/70">
              <ChangeGroup
                title="Changed"
                changes={state.check.changed}
                picked={picked}
                onPickedChange={setPicked}
                disabled={applying}
                note={(change) =>
                  change.widensPermissions ? (
                    <span className="flex items-start gap-1.5 text-warning-foreground">
                      <StatusIcons.warning className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                      Asks for more tools. You’ll approve them on the skill’s page before it runs.
                    </span>
                  ) : (
                    "New instructions"
                  )
                }
              />
              <ChangeGroup
                title="New in this repository"
                changes={state.check.added}
                picked={picked}
                onPickedChange={setPicked}
                disabled={applying}
                note={() => "Not installed yet"}
              />
              {state.check.more ? (
                <p className="px-5 pb-3 text-caption text-muted-foreground sm:px-6">
                  This repository has more skills than Juno reads at once, so some new ones may not be listed.
                </p>
              ) : null}
              {state.check.removed.length > 0 ? (
                <section className="border-t border-border/70 first:border-t-0">
                  <h3 className="px-5 pb-1 pt-3 text-caption font-medium text-muted-foreground sm:px-6">
                    Removed upstream
                  </h3>
                  <ul className="pb-2">
                    {state.check.removed.map((change) => (
                      <li key={change.path} className="flex items-baseline gap-3 px-5 py-2 sm:px-6">
                        {/* The checkbox column the rows above have, left empty. */}
                        <span aria-hidden="true" className="w-[18px] shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-ui text-foreground">{change.name}</span>
                        <span className="shrink-0 text-caption text-muted-foreground">Kept here</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
            <div className="shrink-0 px-5 py-4 sm:px-6">
              {refusal !== null ? (
                <WorkStateNote tone="error" className="mb-3 motion-safe:animate-rise-in">
                  {refusal}
                </WorkStateNote>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={onCancel} disabled={applying}>
                  Later
                </Button>
                <Button onClick={() => void apply()} disabled={count === 0} loading={applying} className="min-w-32">
                  {count === 0 ? (
                    "Choose a skill"
                  ) : (
                    <span>
                      {installsOnly ? "Install" : "Update"} <span className="tabular-nums">{count}</span>{" "}
                      {count === 1 ? "skill" : "skills"}
                    </span>
                  )}
                </Button>
              </div>
            </div>
          </SkillDialogStep>
        )}
      </AnimatePresence>
    </>
  );
}

function ChangeGroup({
  title,
  changes,
  picked,
  onPickedChange,
  disabled,
  note,
}: {
  title: string;
  changes: SkillSourceChange[];
  picked: Set<string>;
  onPickedChange: (next: Set<string>) => void;
  disabled: boolean;
  note: (change: SkillSourceChange) => React.ReactNode;
}) {
  if (changes.length === 0) return null;
  return (
    <section className="border-t border-border/70 first:border-t-0">
      <h3 className="px-5 pb-1 pt-3 text-caption font-medium text-muted-foreground sm:px-6">{title}</h3>
      <ul className="pb-2">
        {changes.map((change) => {
          const checked = picked.has(change.path);
          return (
            <li key={change.path}>
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-3 px-5 py-2 transition-colors duration-fast ease-out-soft hover:bg-accent/60 sm:px-6",
                  disabled && "cursor-default"
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(next) => {
                    const updated = new Set(picked);
                    if (next === true) updated.add(change.path);
                    else updated.delete(change.path);
                    onPickedChange(updated);
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-foreground">{change.name}</span>
                  <span className="mt-0.5 block text-caption text-muted-foreground">{note(change)}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
