"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { MoreHorizontal } from "@/components/ui/icons";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GitHubMark } from "@/components/connections/connector-logos";
import { WorkStateNote, workTimeAgo } from "@/components/work/work-vocabulary";
import { ActionIcons, AppIcons, CodeIcons } from "@/lib/app-icons";
import {
  trustPermitsAutoSelection,
  type ClientWorkSkill,
  type ClientWorkSkillVersion,
  type SkillResource,
} from "@/lib/work/skills";
import { sourceLabel, type ClientSkillSource } from "@/lib/skills/library-contract";
import { cn } from "@/lib/utils";
import { SkillEditor, type SkillDraft } from "@/components/skills/skill-editor";
import { SkillSourceAvatar } from "@/components/skills/skill-source-avatar";
import {
  githubRepoUrl,
  provenanceSource,
  securityFindingsOf,
  shortCommit,
  type ProvenanceSource,
} from "@/components/skills/skill-library-model";

// The chat's renderer, loaded with the page that shows it rather than with
// every page that imports this module: it brings the syntax highlighter.
const Markdown = nextDynamic(() => import("@/components/chat/markdown").then((m) => m.Markdown), {
  ssr: false,
  loading: () => (
    <div className="space-y-2.5" aria-hidden="true">
      <Skeleton className="h-5 w-48 rounded-sm" />
      <Skeleton className="h-4 w-full rounded-sm" />
      <Skeleton className="h-4 w-11/12 rounded-sm" />
      <Skeleton className="h-4 w-2/3 rounded-sm" />
    </div>
  ),
});

export type SkillUsage = "manual" | "auto";

export interface SkillDetailActions {
  onToggle: (enabled: boolean) => void;
  /** Switches on the repository the skill came from, offered only while it is off. */
  onEnableSource?: () => void;
  onUsageChange: (usage: SkillUsage) => void;
  onConsent: () => void;
  onRestore: (version: number) => void;
  onRetryVersions: () => void;
  /** Opens the confirmation; the page owns the dialog. */
  onDelete: () => void;
  /** Opens the project picker; the page owns the dialog. */
  onMove: () => void;
  /** Saves an edit of a skill you wrote. Resolves true when all of it saved. */
  onSave: (draft: SkillDraft) => Promise<boolean>;
}

/** Which usage the stored pair describes. Only a trusted skill can be chosen automatically, so only that pair is "auto". */
export function skillUsage(skill: Pick<ClientWorkSkill, "autoSelect" | "trust">): SkillUsage {
  return skill.autoSelect && trustPermitsAutoSelection(skill.trust) ? "auto" : "manual";
}

/**
 * One skill: what it says, how Juno may use it, and what it used to say.
 *
 * READ FIRST, EDIT SECOND. The instructions render as the document they are
 * (the chat's Markdown renderer) instead of sitting in a raw text box, and an
 * installed skill is read-only: its text belongs to its repository, and
 * editing it in place would make the next update a merge nobody asked for.
 * A skill you wrote gets Edit, which swaps the reading view for the editor
 * and saves a new version.
 *
 * ONE DECISION WHERE THERE WERE THREE CONTROLS. "Juno may choose this",
 * "Trust" and the caption explaining how they interact were one question:
 * may Juno use this without being asked. It is asked once now, as Usage.
 * Choosing "Automatically" trusts the skill and lets Juno pick it in the same
 * write, because the server would clamp one without the other; choosing "Only
 * when I call it" on an installed skill takes that trust back (`skillUsagePatch`).
 *
 * SAID ONLY WHEN IT MATTERS. The security note appears when the scan has
 * something to say, the consent note only when this version is waiting for
 * approval, and the repository note only while the source it came from is
 * switched off. A clear skill shows none of them.
 */
export function SkillDetailView({
  skill,
  version,
  versions,
  versionsFailed,
  resources,
  projectName,
  busy,
  actions,
  installedFrom = null,
}: {
  skill: ClientWorkSkill;
  version: ClientWorkSkillVersion | null;
  /** Null while the history is loading, which is not the same as failing. */
  versions: ClientWorkSkillVersion[] | null;
  versionsFailed: boolean;
  resources: SkillResource[];
  projectName: string | null;
  busy: boolean;
  actions: SkillDetailActions;
  /**
   * The source it was installed from, as the library knows it: its page on
   * GitHub, and its own switch, which can keep a skill that reads On from
   * running. Null for a skill of your own.
   */
  installedFrom?: ClientSkillSource | null;
}) {
  const [editing, setEditing] = React.useState(false);
  const [tab, setTab] = React.useState("instructions");
  const source = provenanceSource(version?.contract.provenance);
  const yours = source === null;
  const status = version?.securityStatus ?? skill.securityStatus;
  const blocked = status === "blocked";
  const repoUrl = source ? (installedFrom?.url ?? githubRepoUrl(source.owner, source.repo)) : null;

  return (
    <AppPage measure="reading">
      <AppPageHeader
        backHref="/skills"
        backLabel="Back to skills"
        heading={skill.name}
        lede={skill.description || undefined}
        className="mb-0 border-b-0 pb-0"
        actions={
          <>
            <label className="flex cursor-pointer items-center gap-2.5 text-ui text-muted-foreground">
              <span aria-hidden="true">{skill.enabled && !blocked ? "On" : "Off"}</span>
              <Switch
                checked={skill.enabled && !blocked}
                disabled={busy || blocked}
                onCheckedChange={actions.onToggle}
                aria-label="Use this skill"
              />
            </label>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <IconButton variant="ghost" size="sm" label="More" title="">
                      <MoreHorizontal className="size-4" aria-hidden="true" />
                    </IconButton>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">More</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-52">
                {yours ? (
                  <DropdownMenuItem onSelect={() => setEditing(true)} disabled={editing}>
                    <ActionIcons.edit aria-hidden="true" />
                    Edit
                  </DropdownMenuItem>
                ) : null}
                {source && repoUrl ? (
                  <DropdownMenuItem asChild>
                    <a href={source.url ?? repoUrl} target="_blank" rel="noreferrer noopener">
                      <GitHubMark className="size-4 shrink-0" />
                      View on GitHub
                    </a>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={actions.onMove}>
                  <AppIcons.projects aria-hidden="true" />
                  Move to project…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={actions.onDelete}>
                  <ActionIcons.delete aria-hidden="true" />
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <SkillMeta skill={skill} source={source} repoUrl={repoUrl} />

      {editing ? (
        <SkillEditor
          initial={{
            name: skill.name,
            description: skill.description,
            instructions: version?.instructions ?? "",
            resources,
          }}
          slug={skill.slug}
          missingVersion={version === null}
          onSave={actions.onSave}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="space-y-8">
          <SkillNotices
            skill={skill}
            version={version}
            installedFrom={installedFrom}
            busy={busy}
            onConsent={actions.onConsent}
            onEnableSource={actions.onEnableSource}
          />

          <UsageChoice
            skill={skill}
            disabled={busy || blocked}
            projectName={projectName}
            onChange={actions.onUsageChange}
            onMove={actions.onMove}
          />

          <Tabs value={tab} onValueChange={setTab}>
            <div className="flex items-center justify-between gap-3">
              <TabsList aria-label="About this skill">
                <TabsTrigger value="instructions">Instructions</TabsTrigger>
                <TabsTrigger value="files">
                  Files
                  {resources.length > 0 ? (
                    <span className="tabular-nums text-muted-foreground">{resources.length}</span>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
              {yours ? (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditing(true)}>
                  <ActionIcons.edit className="size-3.5" aria-hidden="true" />
                  Edit
                </Button>
              ) : null}
            </div>

            <TabsContent value="instructions" className="mt-4">
              <InstructionsPanel version={version} source={source} />
            </TabsContent>
            <TabsContent value="files" className="mt-4">
              <FilesPanel resources={resources} expected={version?.contract.resourceAttachmentIds ?? []} />
            </TabsContent>
            <TabsContent value="history" className="mt-4">
              <HistoryPanel
                versions={versions}
                failed={versionsFailed}
                current={skill.currentVersion}
                busy={busy}
                onRestore={actions.onRestore}
                onRetry={actions.onRetryVersions}
              />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </AppPage>
  );
}

/**
 * The line under the title: where the skill came from, what you type to call
 * it, and which version this is. It closes the header, so the rule the
 * header usually draws is drawn here instead.
 */
function SkillMeta({
  skill,
  source,
  repoUrl,
}: {
  skill: ClientWorkSkill;
  source: ProvenanceSource | null;
  repoUrl: string | null;
}) {
  return (
    <div className="mb-7 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border pb-5 text-ui text-muted-foreground">
      {source && repoUrl ? (
        <a
          href={repoUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="group/chip inline-flex h-7 items-center gap-1.5 rounded-full border border-border pl-1 pr-2.5 text-caption text-foreground transition-colors duration-fast ease-out-soft hover:bg-accent"
        >
          <SkillSourceAvatar owner={source.owner} size="sm" className="rounded-full" />
          <span translate="no" className="font-medium">
            {source.owner}/{source.repo}
          </span>
          {source.commit ? (
            <span translate="no" className="font-mono text-muted-foreground">
              @{shortCommit(source.commit)}
            </span>
          ) : null}
          <ActionIcons.external className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">(opens GitHub)</span>
        </a>
      ) : (
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-caption text-foreground">
          <AppIcons.skills className="size-3.5 text-muted-foreground" aria-hidden="true" motion="none" />
          Yours
        </span>
      )}
      {/* One unit, so a narrow column wraps it whole instead of leaving the
          separator at the end of a line. */}
      <span className="inline-flex max-w-full items-center gap-x-2 whitespace-nowrap">
        <span className="min-w-0 truncate">
          Type{" "}
          <span className="font-mono text-foreground" translate="no">
            /{skill.slug}
          </span>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Version <span className="tabular-nums">{skill.currentVersion}</span>
        </span>
      </span>
    </div>
  );
}

function SkillNotices({
  skill,
  version,
  installedFrom,
  busy,
  onConsent,
  onEnableSource,
}: {
  skill: ClientWorkSkill;
  version: ClientWorkSkillVersion | null;
  installedFrom: ClientSkillSource | null;
  busy: boolean;
  onConsent: () => void;
  onEnableSource?: () => void;
}) {
  const status = version?.securityStatus ?? skill.securityStatus;
  const findings = securityFindingsOf(version?.securityScan);
  const findingList =
    findings.length > 0 ? (
      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-caption">
        {findings.slice(0, 6).map((finding) => (
          <li key={`${finding.code}-${finding.message}`}>{finding.message}</li>
        ))}
      </ul>
    ) : null;
  const notices: React.ReactNode[] = [];
  // First, because it outranks everything below it: while the repository is
  // off, nothing about this version runs, however its own switch reads.
  if (installedFrom && !installedFrom.enabled) {
    notices.push(
      <WorkStateNote
        key="source"
        tone="info"
        action={
          onEnableSource ? (
            <Button size="sm" variant="outline" onClick={onEnableSource} loading={busy}>
              Turn on
            </Button>
          ) : undefined
        }
      >
        <span className="block font-medium text-foreground">
          <span translate="no">{sourceLabel(installedFrom)}</span> is switched off
        </span>
        <span className="block">
          This skill won’t run, or show in chat, until the repository it came from is back on.
        </span>
      </WorkStateNote>
    );
  }
  if (version?.requiresConsent && status !== "blocked") {
    notices.push(
      <WorkStateNote
        key="consent"
        tone="warning"
        action={
          <Button size="sm" onClick={onConsent} loading={busy}>
            Approve
          </Button>
        }
      >
        <span className="block font-medium text-foreground">This version asks for more than the last one</span>
        <span className="block">It won’t run until you approve what it asks for.</span>
      </WorkStateNote>
    );
  }
  if (status === "blocked") {
    notices.push(
      <WorkStateNote key="security" tone="blocked">
        <span className="block font-medium">Blocked by Juno’s safety check</span>
        <span className="block">This version can’t run or be switched on.</span>
        {findingList}
      </WorkStateNote>
    );
  } else if (status === "warning") {
    notices.push(
      <WorkStateNote key="security" tone="warning">
        <span className="block font-medium text-foreground">Juno’s safety check flagged something</span>
        <span className="block">It can still run. Read the instructions before you rely on it.</span>
        {findingList}
      </WorkStateNote>
    );
  } else if (status === "pending") {
    notices.push(
      <WorkStateNote key="security" tone="info">
        Juno hasn’t checked this version yet. It’s checked before a task uses it.
      </WorkStateNote>
    );
  }
  return notices.length > 0 ? <div className="space-y-3">{notices}</div> : null;
}

function UsageChoice({
  skill,
  disabled,
  projectName,
  onChange,
  onMove,
}: {
  skill: ClientWorkSkill;
  disabled: boolean;
  projectName: string | null;
  onChange: (usage: SkillUsage) => void;
  onMove: () => void;
}) {
  const usage = skillUsage(skill);
  const options: { value: SkillUsage; label: string; description: React.ReactNode }[] = [
    {
      value: "manual",
      label: "Only when I call it",
      description: (
        <>
          Type{" "}
          <span className="font-mono" translate="no">
            /{skill.slug}
          </span>{" "}
          in chat, or pick it from the + menu.
        </>
      ),
    },
    {
      value: "auto",
      label: "Automatically when relevant",
      // Choosing this trusts the skill in the same write (see `setUsage`), and
      // for an installed skill that means instructions somebody else wrote no
      // longer reach the model marked as untrusted. Said before the press.
      description: trustPermitsAutoSelection(skill.trust)
        ? "Juno picks it when your request matches its description."
        : "Juno picks it when your request matches its description. Choosing this trusts its instructions.",
    },
  ];
  return (
    <section aria-labelledby="skill-usage">
      <h2 id="skill-usage" className="text-body font-semibold text-foreground">
        Usage
      </h2>
      <RadioGroup
        value={usage}
        onValueChange={(value) => onChange(value as SkillUsage)}
        disabled={disabled}
        aria-labelledby="skill-usage"
        className="mt-3 gap-0 divide-y divide-border/70 overflow-hidden rounded-card border border-border"
      >
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex items-start gap-3 px-4 py-3.5 transition-colors duration-fast ease-out-soft",
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent"
            )}
          >
            <RadioGroupItem value={option.value} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-ui font-medium text-foreground">{option.label}</span>
              <span className="mt-0.5 block text-ui text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {skill.projectId !== null ? (
        <p className="mt-2.5 text-caption text-muted-foreground">
          Filed in <span className="font-medium text-foreground">{projectName ?? "a project"}</span>, so Juno only
          picks it for that project’s tasks.{" "}
          <button
            type="button"
            onClick={onMove}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Change
          </button>
        </p>
      ) : null}
    </section>
  );
}

function InstructionsPanel({
  version,
  source,
}: {
  version: ClientWorkSkillVersion | null;
  source: ProvenanceSource | null;
}) {
  if (version === null) {
    return (
      <WorkStateNote tone="warning">
        This skill points at a version that isn’t there, so there are no instructions to show.
      </WorkStateNote>
    );
  }
  return (
    <div className="overflow-hidden rounded-card border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5 sm:px-5">
        <span className="font-mono text-caption text-muted-foreground" translate="no">
          SKILL.md
        </span>
        <span className="flex items-center gap-3 text-caption text-muted-foreground">
          <span>Saved {workTimeAgo(version.createdAt)}</span>
          {source?.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
            >
              Source
              <ActionIcons.external className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}
        </span>
      </div>
      <div className="px-5 py-5 sm:px-7 sm:py-6">
        {version.instructions.trim() ? (
          // The page's reading rung rather than the transcript's, and no
          // leading margin on the first heading: the strip above already opens
          // the document.
          <Markdown content={version.instructions} className="text-body [&>:first-child]:mt-0" />
        ) : (
          <p className="text-ui text-muted-foreground">No instructions yet.</p>
        )}
      </div>
    </div>
  );
}

function FilesPanel({ resources, expected }: { resources: SkillResource[]; expected: string[] }) {
  const lost = new Set(expected).size - resources.length;
  return (
    <div className="space-y-3">
      {lost > 0 ? (
        <WorkStateNote tone="warning">
          {lost === 1
            ? "One file this version names is no longer in your library."
            : "Some files this version names are no longer in your library."}
        </WorkStateNote>
      ) : null}
      {resources.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-4 py-6 text-center text-ui text-muted-foreground">
          This skill brings no files of its own.
        </p>
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-card border border-border">
          {resources.map((resource) => (
            <li key={resource.attachmentId} className="flex items-center gap-2.5 px-4 py-2.5">
              <CodeIcons.file className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-ui text-foreground">{resource.fileName}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryPanel({
  versions,
  failed,
  current,
  busy,
  onRestore,
  onRetry,
}: {
  versions: ClientWorkSkillVersion[] | null;
  failed: boolean;
  current: number;
  busy: boolean;
  onRestore: (version: number) => void;
  onRetry: () => void;
}) {
  if (failed && versions === null) {
    return (
      <WorkStateNote
        tone="error"
        action={
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        Couldn’t load the history. Nothing about the skill has changed.
      </WorkStateNote>
    );
  }
  if (versions === null) {
    // Loading is its own state. Drawing the error here while the request was
    // still in flight is what this page used to do.
    return (
      <div role="status" aria-label="Loading history" className="divide-y divide-border/70 rounded-card border border-border">
        {[0, 1].map((row) => (
          <div key={row} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-4 w-20 rounded-sm" />
            <Skeleton className="h-3.5 flex-1 rounded-sm" />
            <Skeleton className="h-3.5 w-14 rounded-sm" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border/70 overflow-hidden rounded-card border border-border">
      {versions.map((entry) => {
        const isCurrent = entry.version === current;
        const firstLine = entry.instructions.replace(/^#+\s*/gm, "").split("\n").find((line) => line.trim()) ?? "";
        return (
          <li key={entry.id} className="group flex items-center gap-3 px-4 py-3">
            <span className="w-20 shrink-0 text-ui font-medium text-foreground">
              Version <span className="tabular-nums">{entry.version}</span>
            </span>
            <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">{firstLine}</span>
            <span className="shrink-0 text-caption text-muted-foreground">{workTimeAgo(entry.createdAt)}</span>
            {isCurrent ? (
              <span className="w-[4.5rem] shrink-0 text-right text-caption font-medium text-foreground">Current</span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onRestore(entry.version)}
                className="h-7 w-[4.5rem] shrink-0 gap-1 px-2 text-muted-foreground"
              >
                <ActionIcons.restore className="size-3.5" aria-hidden="true" />
                Restore
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
