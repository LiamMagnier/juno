"use client";

import * as React from "react";
import Link from "next/link";
import { AnimatePresence } from "framer-motion";
import { ChevronDown, FileText, FileUp, Globe, Search, TextQuote } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapse } from "@/components/ui/collapse";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";
import { SkillDialogContent, SkillDialogStep } from "@/components/skills/skill-dialog-shell";
import { SkillSourceAvatar } from "@/components/skills/skill-source-avatar";
import {
  looksLikeSkillMarkdown,
  POPULAR_SKILL_SOURCES,
  renameProblems,
  shortCommit,
  type RenameProblem,
} from "@/components/skills/skill-library-model";
import {
  importSkillPackage,
  importSkills,
  previewSkillImport,
  previewSkillPackage,
  skillsFailureMessage,
  type SkillImportCandidate,
  type SkillImportOutcome,
  type SkillImportPreview,
  type SkillPackagePayload,
} from "@/components/skills/skills-transport";

/** Past this many skills the choose step grows a filter. */
const FILTER_THRESHOLD = 8;

export interface ImportSkillsHandlers {
  /** Walks a repository. The real transport unless the gallery hands in a fixture. */
  preview?: typeof previewSkillImport;
  install?: typeof importSkills;
  /** Reads a file, a link or a paste. */
  previewPackage?: typeof previewSkillPackage;
  installPackage?: typeof importSkillPackage;
}

/** Accepted by the file picker and the drop zone. */
const PACKAGE_ACCEPT = ".md,.markdown,.zip,.skill,text/markdown,application/zip";

/** `owner/repo`, or any github.com link: the repository importer's to walk. */
function isGithubSource(text: string): boolean {
  const value = text.trim();
  if (/^[\w.-]+\/[\w.-]+\/?$/.test(value)) return true;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname === "github.com" || url.hostname === "www.github.com";
  } catch {
    return false;
  }
}

/**
 * Importing skills, as a dialog over the library: from a GitHub repository,
 * or from a FILE (a SKILL.md or a .zip / .skill package, dropped or chosen),
 * a link to one on any host, or a SKILL.md pasted straight into the field.
 * One field decides which: `owner/repo` and github.com links walk the
 * repository, other links are downloaded, and a paste that starts with a
 * `---` fence is read as the skill itself. Files and links share the choose
 * step with repositories; only the header changes (see the package route).
 *
 * TWO STEPS AND A LANDING. Paste a repository, choose what to install, and the
 * dialog closes onto the library with the new folder open and flashed once;
 * the page says what happened in a toast. The repository is the unit here
 * because it is the unit of distribution: somebody pasting `anthropics/skills`
 * usually wants most of it, so every skill starts ticked except the ones Juno's
 * scan blocked, and "Select all" is one press either way. Ticking everything
 * grants nothing on its own: an imported skill only runs when the reader calls
 * it, which the footer says before the button.
 *
 * WHAT A ROW SAYS, and only when it matters: that the skill is already
 * installed (shown, not offered), that its slash name is taken (an editable
 * name, prefilled with the server's suggestion and sent as a rename), that the
 * scan blocked it, and that tool rules written for another host are left out.
 * The path, the licence, what it asks for and the files beside it are one
 * press away under each row, not stacked on every one.
 *
 * `/skills/import` renders the library with this open, because a shipped
 * macOS build and older pages link there.
 */
export function ImportSkillsDialog({
  open,
  onOpenChange,
  initialSource,
  onInstalled,
  handlers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A repository to look at straight away (a popular chip, or a link). */
  initialSource?: string;
  onInstalled: (outcome: SkillImportOutcome, preview: SkillImportPreview) => void;
  handlers?: ImportSkillsHandlers;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SkillDialogContent>
        <ImportSkillsFlow
          initialSource={initialSource}
          onInstalled={(outcome, preview) => {
            onInstalled(outcome, preview);
            onOpenChange(false);
          }}
          handlers={handlers}
        />
      </SkillDialogContent>
    </Dialog>
  );
}

type Step = "source" | "choose";

/**
 * The dialog's body, which the dev gallery also renders inline inside a bare
 * `<Dialog open>` (the titles need the dialog's context, nothing else does).
 */
export function ImportSkillsFlow({
  initialSource,
  onInstalled,
  handlers,
  initialPreview,
}: {
  initialSource?: string;
  onInstalled: (outcome: SkillImportOutcome, preview: SkillImportPreview) => void;
  handlers?: ImportSkillsHandlers;
  /** Fixture: start on the choose step with this preview (the dev gallery). */
  initialPreview?: SkillImportPreview;
}) {
  const preview = handlers?.preview ?? previewSkillImport;
  const install = handlers?.install ?? importSkills;
  const previewPackage = handlers?.previewPackage ?? previewSkillPackage;
  const installPackage = handlers?.installPackage ?? importSkillPackage;
  /** What a file, link or paste preview read, sent again to import (no server copy). */
  const [payload, setPayload] = React.useState<SkillPackagePayload | null>(null);

  const [step, setStep] = React.useState<Step>(initialPreview ? "choose" : "source");
  const [source, setSource] = React.useState(initialSource ?? "");
  const [looking, setLooking] = React.useState(false);
  const [installing, setInstalling] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [discovery, setDiscovery] = React.useState<SkillImportPreview | null>(initialPreview ?? null);
  const [chosen, setChosen] = React.useState<Set<string>>(() => defaultChoice(initialPreview));
  const [renames, setRenames] = React.useState<Record<string, string>>(() => defaultRenames(initialPreview));

  const settle = React.useCallback(
    (result: Awaited<ReturnType<typeof preview>>, fallback: string) => {
      setLooking(false);
      if (result.kind === "ok") {
        setDiscovery(result.value);
        setChosen(defaultChoice(result.value));
        setRenames(defaultRenames(result.value));
        setStep("choose");
        return;
      }
      setRefusal(skillsFailureMessage(result, fallback));
    },
    []
  );

  const lookPackage = React.useCallback(
    async (next: SkillPackagePayload) => {
      setPayload(next);
      setLooking(true);
      setRefusal(null);
      settle(await previewPackage(next), "Couldn’t read that. Nothing was installed.");
    },
    [previewPackage, settle]
  );

  const look = React.useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      if (looksLikeSkillMarkdown(trimmed)) {
        setSource("");
        return lookPackage({ kind: "paste", markdown: trimmed });
      }
      setSource(trimmed);
      if (!isGithubSource(trimmed) && /^https?:\/\//i.test(trimmed)) {
        return lookPackage({ kind: "url", url: trimmed });
      }
      setPayload(null);
      setLooking(true);
      setRefusal(null);
      settle(await preview(trimmed), "Couldn’t look inside that repository. Nothing was installed.");
    },
    [lookPackage, preview, settle]
  );

  // A repository handed in from outside (a popular chip on the empty state)
  // is looked at straight away: the reader already said which one.
  const autoLooked = React.useRef(false);
  React.useEffect(() => {
    if (autoLooked.current || initialPreview || !initialSource) return;
    autoLooked.current = true;
    void look(initialSource);
  }, [initialSource, initialPreview, look]);

  const confirm = async () => {
    if (!discovery || installing) return;
    const paths = discovery.skills.filter((skill) => chosen.has(skill.path)).map((skill) => skill.path);
    if (paths.length === 0) return;
    setInstalling(true);
    setRefusal(null);
    const chosenRenames = Object.fromEntries(
      Object.entries(renames).filter(([path]) => chosen.has(path) && discovery.skills.some((s) => s.path === path && s.slugTaken))
    );
    const outcome =
      discovery.repository === null
        ? payload
          ? await installPackage(payload, { paths, renames: chosenRenames })
          : ({ kind: "failed", cause: "offline", message: "Choose the file again." } as const)
        : await install({ source, commit: discovery.repository.commit, paths, renames: chosenRenames });
    setInstalling(false);
    if (outcome.kind === "ok") {
      onInstalled(outcome.value, discovery);
      return;
    }
    setRefusal(skillsFailureMessage(outcome, "Couldn’t install those skills. Nothing was saved."));
  };

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {step === "source" || discovery === null ? (
        <SkillDialogStep key="source" className="p-5 sm:p-6">
          <SourceStep
            source={source}
            onSourceChange={setSource}
            looking={looking}
            refusal={refusal}
            onLook={(value) => void look(value)}
            onFile={(file) => void lookPackage({ kind: "file", file })}
          />
        </SkillDialogStep>
      ) : (
        <SkillDialogStep key="choose" className="min-h-0 flex-1">
          <ChooseStep
            discovery={discovery}
            chosen={chosen}
            onChosenChange={setChosen}
            renames={renames}
            onRenamesChange={setRenames}
            installing={installing}
            refusal={refusal}
            onBack={() => {
              setRefusal(null);
              setStep("source");
            }}
            onInstall={() => void confirm()}
          />
        </SkillDialogStep>
      )}
    </AnimatePresence>
  );
}

function defaultChoice(preview: SkillImportPreview | null | undefined): Set<string> {
  if (!preview) return new Set();
  // Everything that can be installed, minus what the scan blocked: a blocked
  // skill lands switched off anyway, so ticking it for somebody would install a
  // row they then have to find out about.
  return new Set(
    preview.skills.filter((skill) => !skill.installed && skill.securityStatus !== "blocked").map((skill) => skill.path)
  );
}

function defaultRenames(preview: SkillImportPreview | null | undefined): Record<string, string> {
  if (!preview) return {};
  return Object.fromEntries(
    preview.skills
      .filter((skill) => skill.slugTaken && !skill.installed)
      .map((skill) => [skill.path, skill.suggestedSlug ?? `${preview.repository?.repo ?? "imported"}-${skill.slug}`.toLowerCase()])
  );
}

// ---------------------------------------------------------------------------
// Step 1: which repository
// ---------------------------------------------------------------------------

function SourceStep({
  source,
  onSourceChange,
  looking,
  refusal,
  onLook,
  onFile,
}: {
  source: string;
  onSourceChange: (value: string) => void;
  looking: boolean;
  refusal: string | null;
  onLook: (value: string) => void;
  onFile: (file: File) => void;
}) {
  return (
    <>
      <div className="pr-10">
        <DialogTitle>Import skills</DialogTitle>
        <DialogDescription className="mt-1 text-ui">
          Paste a GitHub repository, a link, or a SKILL.md itself. You’ll choose which skills to install.
        </DialogDescription>
      </div>

      <form
        className="mt-5 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          onLook(source);
        }}
      >
        <Input
          value={source}
          onChange={(event) => onSourceChange(event.target.value)}
          // A SKILL.md pasted here would lose its line breaks in a one-line
          // field, so a paste that is one is read straight away instead.
          onPaste={(event) => {
            const text = event.clipboardData.getData("text/plain");
            if (looksLikeSkillMarkdown(text)) {
              event.preventDefault();
              onLook(text);
            }
          }}
          placeholder="owner/repo, a link, or paste a SKILL.md"
          aria-label="Repository, link or SKILL.md"
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={looking}
          className="h-10 flex-1"
        />
        <Button type="submit" className="h-10 sm:w-28" disabled={!source.trim()} loading={looking}>
          Continue
        </Button>
      </form>

      {refusal !== null ? (
        <WorkStateNote tone="error" className="mt-3 motion-safe:animate-rise-in">
          {refusal}
        </WorkStateNote>
      ) : null}

      <PackageDropZone disabled={looking} onFile={onFile} />

      <div className="mt-5 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-caption text-muted-foreground">Popular</span>
        {POPULAR_SKILL_SOURCES.map(({ owner, repo }) => (
          <Pressable
            key={`${owner}/${repo}`}
            kind="chip"
            disabled={looking}
            onClick={() => onLook(`${owner}/${repo}`)}
            className="gap-1.5 pl-1.5"
          >
            <SkillSourceAvatar owner={owner} size="xs" />
            <span translate="no">
              {owner}/{repo}
            </span>
          </Pressable>
        ))}
      </div>

      <p className="mt-5 text-caption text-muted-foreground">
        Private repositories need GitHub connected in{" "}
        <Link href="/connections" className="font-medium text-foreground underline-offset-2 hover:underline">
          Connections
        </Link>
        .
      </p>
    </>
  );
}

/**
 * Drop a SKILL.md or a .zip / .skill package, or press to choose one. A quiet
 * dashed well at rest; while a file is held over it the hairline firms, the
 * well fills with the hover tone and the glyph lifts, so "let go here" is
 * said by the target itself. Keyboard: it is a button that opens the picker.
 */
function PackageDropZone({ disabled, onFile }: { disabled: boolean; onFile: (file: File) => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);
  const depth = React.useRef(0);
  const take = (files: FileList | null) => {
    const file = files?.[0];
    if (file && !disabled) onFile(file);
  };
  return (
    <div
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        take(event.dataTransfer.files);
      }}
      className="mt-3"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className={cn(
          "group flex w-full items-center gap-3 rounded-card border border-dashed px-3.5 py-3 text-left",
          "transition-[border-color,background-color] duration-fast ease-out-soft",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
          over ? "border-solid border-foreground/40 bg-accent/60" : "border-border hover:border-foreground/25 hover:bg-accent/40"
        )}
      >
        <span
          className={cn(
            "surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground",
            "transition-[transform,color] duration-base ease-out-soft motion-reduce:transform-none",
            over ? "-translate-y-0.5 text-foreground" : "group-hover:text-foreground"
          )}
        >
          <FileUp className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-ui font-medium text-foreground">
            {over ? "Drop to read it" : "Upload a SKILL.md or .zip"}
          </span>
          <span className="block text-caption text-muted-foreground">
            Drop it here or choose a file. A package can hold several skills.
          </span>
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept={PACKAGE_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          take(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: which skills
// ---------------------------------------------------------------------------

function ChooseStep({
  discovery,
  chosen,
  onChosenChange,
  renames,
  onRenamesChange,
  installing,
  refusal,
  onBack,
  onInstall,
}: {
  discovery: SkillImportPreview;
  chosen: Set<string>;
  onChosenChange: (next: Set<string>) => void;
  renames: Record<string, string>;
  onRenamesChange: (next: Record<string, string>) => void;
  installing: boolean;
  refusal: string | null;
  onBack: () => void;
  onInstall: () => void;
}) {
  const [filter, setFilter] = React.useState("");
  const [openDetails, setOpenDetails] = React.useState<string | null>(null);
  const { repository, origin, skills } = discovery;
  const OriginIcon = origin?.kind === "url" ? Globe : origin?.kind === "paste" ? TextQuote : FileText;

  const query = filter.trim().toLowerCase();
  const visible = query
    ? skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(query) ||
          skill.slug.includes(query) ||
          skill.description.toLowerCase().includes(query)
      )
    : skills;
  // "Select all" acts on what the reader can see: with a filter typed, that is
  // the matching rows, which is what a person pressing it after searching means.
  const selectable = visible.filter((skill) => !skill.installed);
  const selectedVisible = selectable.filter((skill) => chosen.has(skill.path)).length;
  const allState: boolean | "indeterminate" =
    selectable.length > 0 && selectedVisible === selectable.length
      ? true
      : selectedVisible > 0
        ? "indeterminate"
        : false;

  const problems = renameProblems(skills, chosen, renames);
  const invalidRename = problems.size > 0;
  const count = chosen.size;
  const installedCount = skills.filter((skill) => skill.installed).length;

  const toggle = (path: string, next: boolean) => {
    const updated = new Set(chosen);
    if (next) updated.add(path);
    else updated.delete(path);
    onChosenChange(updated);
  };

  return (
    <>
      <div className="shrink-0 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
        <div className="flex items-center gap-3 pr-10">
          {repository ? (
            <SkillSourceAvatar owner={repository.owner} size="md" />
          ) : (
            <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
              <OriginIcon className="size-4" />
            </span>
          )}
          <div className="min-w-0">
            <DialogTitle className="truncate text-heading" translate="no">
              {repository ? `${repository.owner}/${repository.repo}` : origin?.label ?? "Skills"}
            </DialogTitle>
            <DialogDescription className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-ui">
              {repository ? (
                <>
                  <span translate="no" className="font-mono text-caption">
                    {repository.ref}@{shortCommit(repository.commit)}
                  </span>
                  <span aria-hidden="true">·</span>
                </>
              ) : null}
              <span>
                <span className="tabular-nums">{skills.length}</span> {skills.length === 1 ? "skill" : "skills"}
              </span>
              {installedCount > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    <span className="tabular-nums">{installedCount}</span> already installed
                  </span>
                </>
              ) : null}
            </DialogDescription>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <label className="flex min-w-0 shrink-0 cursor-pointer items-center gap-2.5 py-1 text-ui font-medium text-foreground">
            <Checkbox
              checked={allState}
              disabled={selectable.length === 0 || installing}
              onCheckedChange={() => {
                const updated = new Set(chosen);
                if (allState === true) selectable.forEach((skill) => updated.delete(skill.path));
                else selectable.forEach((skill) => updated.add(skill.path));
                onChosenChange(updated);
              }}
            />
            Select all
          </label>
          {skills.length > FILTER_THRESHOLD ? (
            <label className="relative ml-auto block w-full max-w-56">
              <span className="sr-only">Filter skills</span>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter"
                className="surface-inset h-8 w-full rounded-control border border-input pl-8 pr-2 text-ui outline-none transition-[border-color] duration-fast ease-out-soft placeholder:text-muted-foreground focus-visible:border-foreground/70 coarse:h-10 [&::-webkit-search-cancel-button]:hidden"
              />
            </label>
          ) : null}
        </div>
      </div>

      <div
        role="list"
        aria-label={repository ? "Skills in this repository" : "Skills found"}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-y border-border/70 divide-y divide-border/70"
      >
        {visible.length === 0 ? (
          <p className="px-6 py-8 text-center text-ui text-muted-foreground">
            No skills match <span className="text-foreground">“{filter.trim()}”</span>
          </p>
        ) : (
          visible.map((skill) => (
            <CandidateRow
              key={skill.path}
              skill={skill}
              checked={chosen.has(skill.path)}
              onCheckedChange={(next) => toggle(skill.path, next)}
              rename={renames[skill.path] ?? ""}
              renameProblem={problems.get(skill.path) ?? null}
              onRenameChange={(value) => onRenamesChange({ ...renames, [skill.path]: value })}
              detailsOpen={openDetails === skill.path}
              onDetailsChange={(next) => setOpenDetails(next ? skill.path : null)}
              disabled={installing}
            />
          ))
        )}
        {discovery.problems.length > 0 ? <ProblemsRow problems={discovery.problems} /> : null}
        {discovery.more ? (
          // Counted as files read (the ones that failed to parse too), against
          // every SKILL.md the walk saw, so the cap is stated as the cap.
          <p className="px-5 py-3 text-caption text-muted-foreground sm:px-6">
            Juno read the first <span className="tabular-nums">{skills.length + discovery.problems.length}</span>
            {discovery.total !== null ? (
              <>
                {" "}
                of <span className="tabular-nums">{discovery.total}</span>
              </>
            ) : null}{" "}
            {repository
              ? "skills in this repository. To reach the rest, paste a link to a folder inside it."
              : "skills in this package. Split it into smaller packages to add the rest."}
          </p>
        ) : null}
      </div>

      <div className="shrink-0 px-5 py-4 sm:px-6">
        {refusal !== null ? (
          <WorkStateNote tone="error" className="mb-3 motion-safe:animate-rise-in">
            {refusal}
          </WorkStateNote>
        ) : null}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-caption text-muted-foreground">
            Imported skills only run when you call them.
          </p>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button variant="ghost" onClick={onBack} disabled={installing}>
              Back
            </Button>
            <Button onClick={onInstall} disabled={count === 0 || invalidRename} loading={installing} className="min-w-32">
              {count === 0 ? (
                "Choose a skill"
              ) : (
                // One span, so the button's gap does not open up between the
                // words and the number.
                <span>
                  Install <span className="tabular-nums">{count}</span> {count === 1 ? "skill" : "skills"}
                </span>
              )}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

const RENAME_PROBLEM_COPY: Record<RenameProblem, string> = {
  invalid: "Use lowercase letters, numbers and dashes.",
  taken: "That name is taken. Choose another.",
  duplicate: "Another skill in this list is using that name.",
};

function CandidateRow({
  skill,
  checked,
  onCheckedChange,
  rename,
  renameProblem,
  onRenameChange,
  detailsOpen,
  onDetailsChange,
  disabled,
}: {
  skill: SkillImportCandidate;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  rename: string;
  /** Why the new slash name cannot be sent as it is; see `renameProblems`. */
  renameProblem: RenameProblem | null;
  onRenameChange: (value: string) => void;
  detailsOpen: boolean;
  onDetailsChange: (open: boolean) => void;
  disabled: boolean;
}) {
  const id = React.useId();
  const blocked = skill.securityStatus === "blocked";
  const renameInvalid = renameProblem !== null;
  return (
    <div
      role="listitem"
      className={cn(
        "flex items-start gap-3 px-5 py-3 transition-colors duration-fast ease-out-soft sm:px-6",
        !skill.installed && !disabled && "hover:bg-accent/60"
      )}
    >
      <Checkbox
        id={id}
        checked={skill.installed ? false : checked}
        disabled={skill.installed || disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="mt-0.5"
      />
      <div className={cn("min-w-0 flex-1", skill.installed && "opacity-60")}>
        <div className="flex min-w-0 items-baseline gap-2">
          <label
            htmlFor={id}
            className={cn("truncate text-ui font-medium text-foreground", !skill.installed && "cursor-pointer")}
          >
            {skill.name}
          </label>
          {skill.installed ? <span className="shrink-0 text-caption text-muted-foreground">Installed</span> : null}
        </div>
        {skill.description ? (
          <p className="mt-0.5 line-clamp-2 text-ui text-muted-foreground">{skill.description}</p>
        ) : null}

        {blocked ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-caption text-warning-foreground">
            <StatusIcons.warning className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            Juno’s safety check blocked this skill. It would install switched off.
          </p>
        ) : null}

        {skill.slugTaken && !skill.installed && checked ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-caption text-muted-foreground">
            <StatusIcons.warning className="size-3.5 shrink-0 text-warning-foreground" aria-hidden="true" />
            <span>
              <span className="font-mono text-foreground" translate="no">
                /{skill.slug}
              </span>{" "}
              is taken. Install as
            </span>
            <span className="relative inline-flex items-center">
              <span aria-hidden="true" className="pointer-events-none absolute left-2 font-mono text-muted-foreground">
                /
              </span>
              <input
                value={rename}
                onChange={(event) => onRenameChange(event.target.value.toLowerCase().replace(/\s+/g, "-"))}
                aria-label={`New slash name for ${skill.name}`}
                aria-invalid={renameInvalid || undefined}
                spellCheck={false}
                autoCapitalize="off"
                disabled={disabled}
                className={cn(
                  "surface-inset h-7 w-48 rounded-control border pl-4 pr-2 font-mono text-caption text-foreground outline-none transition-[border-color] duration-fast ease-out-soft focus-visible:border-foreground/70",
                  renameInvalid ? "border-destructive/60" : "border-input"
                )}
              />
            </span>
            {renameProblem ? (
              <span className="basis-full text-destructive">{RENAME_PROBLEM_COPY[renameProblem]}</span>
            ) : null}
          </div>
        ) : null}

        {skill.droppedTools.length > 0 && !skill.installed ? (
          <p className="mt-1.5 text-caption text-muted-foreground">
            Leaves out tool rules Juno can’t apply:{" "}
            <span className="font-mono" translate="no">
              {skill.droppedTools.slice(0, 2).join(", ")}
            </span>
            {skill.droppedTools.length > 2 ? <span translate="no">, …</span> : null}
          </p>
        ) : null}

        <Collapse open={detailsOpen}>
          <CandidateDetails skill={skill} />
        </Collapse>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <IconButton
            variant="ghost"
            size="sm"
            label={detailsOpen ? "Hide details" : "Show details"}
            title=""
            aria-expanded={detailsOpen}
            onClick={() => onDetailsChange(!detailsOpen)}
            className="-my-1 -mr-1.5"
          >
            <ChevronDown
              motion="none"
              className={cn(
                "size-4 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                detailsOpen && "rotate-180"
              )}
              aria-hidden="true"
            />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent side="left">{detailsOpen ? "Hide details" : "Details"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function CandidateDetails({ skill }: { skill: SkillImportCandidate }) {
  return (
    <div className="pt-2.5">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-caption">
        <dt className="text-muted-foreground">Path</dt>
        <dd className="truncate font-mono text-foreground" translate="no">
          {skill.path}
        </dd>
        {skill.license ? (
          <>
            <dt className="text-muted-foreground">License</dt>
            <dd className="text-foreground" translate="no">
              {skill.license}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Asks for</dt>
        <dd className="text-foreground">
          {skill.requestedTools.length > 0 ? (
            <span className="font-mono" translate="no">
              {skill.requestedTools.join(", ")}
            </span>
          ) : (
            "No tools"
          )}
        </dd>
        {skill.companionFiles.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Other files</dt>
            <dd className="text-foreground">
              <span className="tabular-nums">{skill.companionFiles.length}</span> beside it, listed and not installed
            </dd>
          </>
        ) : null}
        {skill.compatibility ? (
          <>
            <dt className="text-muted-foreground">Works with</dt>
            <dd className="text-foreground">{skill.compatibility}</dd>
          </>
        ) : null}
      </dl>
      {skill.url ? (
        <a
          href={skill.url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-2 inline-flex items-center gap-1 text-caption font-medium text-foreground underline-offset-2 hover:underline"
        >
          Read the SKILL.md
          <ActionIcons.external className="size-3.5" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

function ProblemsRow({ problems }: { problems: SkillImportPreview["problems"] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="px-5 py-3 sm:px-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground"
      >
        <StatusIcons.warning className="size-3.5 text-warning-foreground" aria-hidden="true" />
        <span>
          <span className="tabular-nums">{problems.length}</span>{" "}
          {problems.length === 1 ? "SKILL.md couldn’t be read" : "SKILL.md files couldn’t be read"}
        </span>
        <ChevronDown
          motion="none"
          className={cn(
            "size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>
      <Collapse open={open}>
        <ul className="space-y-1 pt-2 text-caption text-muted-foreground">
          {problems.slice(0, 8).map((problem) => (
            <li key={problem.path}>
              <span className="font-mono text-foreground" translate="no">
                {problem.path}
              </span>
              : {problem.message}
            </li>
          ))}
          {/* The count above is the whole list, so the cut is said, not hidden. */}
          {problems.length > 8 ? (
            <li>
              And <span className="tabular-nums">{problems.length - 8}</span> more.
            </li>
          ) : null}
        </ul>
      </Collapse>
    </div>
  );
}
