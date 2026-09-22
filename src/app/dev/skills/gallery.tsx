"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import type { LibrarySkill, LibrarySource, SkillLibrary } from "@/lib/skills/library-contract";
import { ImportSkillsDialog, ImportSkillsFlow } from "@/components/skills/import-skills-dialog";
import { SkillDetailView, type SkillUsage } from "@/components/skills/skill-detail-view";
import { SkillsLibraryView, type SkillsLibraryActions } from "@/components/skills/skills-library-view";
import { RemoveSourceDialog } from "@/components/skills/skills-library-page";
import { UpdateSourceFlow } from "@/components/skills/update-source-dialog";
import type { ClientWorkSkill, ClientWorkSkillVersion } from "@/lib/work/skills";
import {
  FIXTURE_DETAIL_SKILL,
  FIXTURE_DETAIL_VERSION,
  FIXTURE_DETAIL_VERSIONS,
  FIXTURE_EMPTY_LIBRARY,
  FIXTURE_LIBRARY,
  FIXTURE_OWN_SKILL,
  FIXTURE_OWN_VERSION,
  FIXTURE_PREVIEW,
  FIXTURE_UPDATE_CHECK,
} from "./fixtures";
import { SKILLS_GALLERY_VIEWS as VIEWS, type SkillsGalleryView } from "./views";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mapLibrary(library: SkillLibrary, fn: (skill: LibrarySkill) => LibrarySkill): SkillLibrary {
  return {
    ...library,
    yours: library.yours.map(fn),
    sources: library.sources.map((source) => ({ ...source, skills: source.skills.map(fn) })),
  };
}

/**
 * The skills surfaces against fixtures, one view per `?view=` so each can be
 * screenshotted on its own. The switches, the menus and the dialogs work
 * locally; nothing here reaches the network except the GitHub avatars.
 */
export function SkillsGallery({ view }: { view: SkillsGalleryView }) {
  return (
    // The app shell declares the `page` container the gutters and fluid type
    // are measured against; outside it they would fall back to their narrowest.
    <div className="min-h-dvh bg-background" style={{ containerType: "inline-size", containerName: "page" }}>
      <nav className="flex flex-wrap gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-caption text-muted-foreground">
        {VIEWS.map((entry) => (
          <Link
            key={entry}
            href={`/dev/skills?view=${entry}`}
            className={entry === view ? "font-medium text-foreground" : "hover:text-foreground"}
          >
            {entry}
          </Link>
        ))}
      </nav>
      <View view={view} />
    </div>
  );
}

function View({ view }: { view: SkillsGalleryView }) {
  switch (view) {
    case "library":
      return <LibraryFixture initial={FIXTURE_LIBRARY} />;
    case "empty":
      return <LibraryFixture initial={FIXTURE_EMPTY_LIBRARY} />;
    case "loading":
      return <LibraryFixture initial={null} />;
    case "error":
      return (
        <LibraryFixture
          initial={null}
          error="Couldn’t load your skills. The request failed, so this is not an empty library."
        />
      );
    case "import":
      return (
        <DialogFrame>
          <ImportSkillsFlow onInstalled={() => undefined} handlers={fixtureImport} />
        </DialogFrame>
      );
    case "choose":
      return (
        <DialogFrame>
          <ImportSkillsFlow onInstalled={() => undefined} handlers={fixtureImport} initialPreview={FIXTURE_PREVIEW} />
        </DialogFrame>
      );
    case "dialog":
      return <DialogFixture />;
    case "update":
      return (
        <DialogFrame>
          <UpdateSourceFlow
            source={FIXTURE_LIBRARY.sources[0]}
            onDone={() => undefined}
            onCancel={() => undefined}
            initialCheck={FIXTURE_UPDATE_CHECK}
          />
        </DialogFrame>
      );
    case "detail":
      return (
        <DetailFixture skill={FIXTURE_DETAIL_SKILL} version={FIXTURE_DETAIL_VERSION} versions={FIXTURE_DETAIL_VERSIONS} />
      );
    case "detail-own":
      return (
        <DetailFixture
          skill={FIXTURE_OWN_SKILL}
          version={FIXTURE_OWN_VERSION}
          versions={null}
          resources={[
            { attachmentId: "att_1", fileName: "investor-update-template.docx" },
            { attachmentId: "att_2", fileName: "metrics-definitions.md" },
          ]}
          projectName="Fundraising"
          projectId="proj_1"
        />
      );
    case "detail-notices":
      return (
        <DetailFixture
          skill={{ ...FIXTURE_DETAIL_SKILL, name: "Mcp builder", slug: "mcp-builder", securityStatus: "warning" }}
          version={{
            ...FIXTURE_DETAIL_VERSION,
            securityStatus: "warning",
            requiresConsent: true,
            securityScan: {
              findings: [
                { code: "network", severity: "warning", message: "Asks to fetch pages from any domain." },
                { code: "shell", severity: "warning", message: "Mentions running shell commands." },
              ],
            },
          }}
          versions={FIXTURE_DETAIL_VERSIONS}
        />
      );
  }
}

const fixtureImport = {
  preview: async () => {
    await wait(500);
    return { kind: "ok" as const, value: FIXTURE_PREVIEW };
  },
  install: async () => {
    await wait(700);
    return {
      kind: "ok" as const,
      value: { imported: [], skipped: [], problems: [], blocked: 0, source: null, repository: null },
    };
  },
};

function LibraryFixture({ initial, error = null }: { initial: SkillLibrary | null; error?: string | null }) {
  const [library, setLibrary] = React.useState(initial);
  const [removing, setRemoving] = React.useState<LibrarySource | null>(null);
  const actions: SkillsLibraryActions = {
    onToggleSkill: (skill, enabled) =>
      setLibrary((current) =>
        current ? mapLibrary(current, (entry) => (entry.id === skill.id ? { ...entry, enabled } : entry)) : current
      ),
    onToggleSource: (source, enabled) =>
      setLibrary((current) =>
        current
          ? {
              ...current,
              sources: current.sources.map((entry) => (entry.id === source.id ? { ...entry, enabled } : entry)),
            }
          : current
      ),
    onCheckUpdates: (source) => toast.message(`Would check ${source.owner}/${source.repo}`),
    onRemoveSource: setRemoving,
    onImport: (repository) => toast.message(repository ? `Would import ${repository}` : "Would open the importer"),
    onWrite: () => toast.message("Would open /skills/new"),
    onCreateWithJuno: () => toast.message("Would open a seeded chat"),
  };
  return (
    <>
      <SkillsLibraryView
        library={library}
        error={error}
        onRetry={() => toast.message("Would retry")}
        actions={actions}
        skillHref={() => "/dev/skills?view=detail"}
        initialOpenSources={{ src_anthropics: true }}
      />
      <RemoveSourceDialog
        source={removing}
        busy={false}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          setLibrary((current) =>
            current ? { ...current, sources: current.sources.filter((entry) => entry.id !== removing?.id) } : current
          );
          setRemoving(null);
        }}
      />
    </>
  );
}

/** A dialog's panel drawn in place, so a screenshot shows the step without a scrim. */
function DialogFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-10">
      <Dialog open>
        <div className="surface-float relative mx-auto flex max-h-[calc(100dvh-5rem)] w-full max-w-xl flex-col overflow-hidden rounded-panel">
          {children}
        </div>
      </Dialog>
    </div>
  );
}

function DialogFixture() {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <LibraryFixture initial={FIXTURE_LIBRARY} />
      <ImportSkillsDialog
        open={open}
        onOpenChange={setOpen}
        initialSource="anthropics/skills"
        onInstalled={() => toast.success("Installed 9 skills from anthropics/skills")}
        handlers={fixtureImport}
      />
    </>
  );
}

function DetailFixture({
  skill: initialSkill,
  version,
  versions,
  resources = [],
  projectName = null,
  projectId = null,
}: {
  skill: ClientWorkSkill;
  version: ClientWorkSkillVersion;
  versions: ClientWorkSkillVersion[] | null;
  resources?: { attachmentId: string; fileName: string }[];
  projectName?: string | null;
  projectId?: string | null;
}) {
  const [skill, setSkill] = React.useState<ClientWorkSkill>({ ...initialSkill, projectId });
  return (
    <SkillDetailView
      skill={skill}
      version={version}
      versions={versions}
      versionsFailed={false}
      resources={resources}
      projectName={projectName}
      busy={false}
      actions={{
        onToggle: (enabled) => setSkill({ ...skill, enabled }),
        onUsageChange: (usage: SkillUsage) =>
          setSkill({
            ...skill,
            autoSelect: usage === "auto",
            trust: usage === "auto" ? "user_authored" : skill.trust,
          }),
        onConsent: () => toast.success("Approved. The skill can run again."),
        onRestore: (n) => toast.message(`Would restore version ${n}`),
        onRetryVersions: () => undefined,
        onDelete: () => toast.message("Would confirm delete"),
        onMove: () => toast.message("Would open the project picker"),
        onSave: async () => {
          await wait(400);
          toast.success("Saved as version 5.");
          return true;
        },
      }}
    />
  );
}
