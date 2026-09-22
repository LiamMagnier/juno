"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkLoadError } from "@/components/work/shell/work-states";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { SkillDetailView } from "@/components/skills/skill-detail-view";
import { DeleteSkillDialog, MoveSkillDialog } from "@/components/skills/skill-detail-dialogs";
import { useProjects, useSkillDetail } from "@/components/skills/use-skill-detail";

/**
 * One skill. The page is `SkillDetailView` over `useSkillDetail`, plus the two
 * dialogs its menu opens; everything it draws is in src/components/skills so
 * the dev gallery can render the same view against fixtures.
 *
 * The param is read as `id`, the name of this folder, which
 * tests/work-url-migration.test.ts pins: `/work/skills/<id>` redirects here.
 */
export default function SkillPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const detail = useSkillDetail(id);
  const [deleting, setDeleting] = React.useState(false);
  const [moving, setMoving] = React.useState(false);
  const { projects, failed: projectsFailed } = useProjects(moving);

  if (detail.state === "missing") {
    return (
      <SkillFrame heading="Skill not found">
        <WorkStateNote tone="error">This skill no longer exists. It may have been deleted on another device.</WorkStateNote>
      </SkillFrame>
    );
  }
  if (detail.state === "failed") {
    return (
      <SkillFrame heading="Skill">
        <WorkLoadError onRetry={() => void detail.reload()}>
          Couldn’t load this skill. Nothing has been changed by the attempt.
        </WorkLoadError>
      </SkillFrame>
    );
  }
  if (detail.skill === null) {
    return (
      <SkillFrame heading={<Skeleton className="h-9 w-56 max-w-full" />}>
        <div className="space-y-6" role="status" aria-label="Loading skill">
          <Skeleton className="h-28 w-full rounded-card" />
          <Skeleton className="h-9 w-64 rounded-menu" />
          <Skeleton className="h-72 w-full rounded-card" />
        </div>
      </SkillFrame>
    );
  }

  const skill = detail.skill;
  return (
    <>
      <SkillDetailView
        skill={skill}
        version={detail.version}
        versions={detail.versions}
        versionsFailed={detail.versionsFailed}
        resources={detail.resources}
        projectName={detail.projectName}
        busy={detail.busy}
        actions={{
          onToggle: detail.setEnabled,
          onUsageChange: detail.setUsage,
          onConsent: () => void detail.consent(),
          onRestore: (version) => void detail.restore(version),
          onRetryVersions: () => void detail.reloadVersions(),
          onDelete: () => setDeleting(true),
          onMove: () => setMoving(true),
          onSave: detail.save,
        }}
      />
      <DeleteSkillDialog
        open={deleting}
        name={skill.name}
        busy={detail.busy}
        onCancel={() => setDeleting(false)}
        onConfirm={() =>
          void detail.remove().then((ok) => {
            if (!ok) return;
            setDeleting(false);
            toast.success("Skill deleted.");
            router.push("/skills");
          })
        }
      />
      <MoveSkillDialog
        open={moving}
        slug={skill.slug}
        current={skill.projectId}
        projects={projects}
        failed={projectsFailed}
        busy={detail.busy}
        onCancel={() => setMoving(false)}
        onMove={(projectId) =>
          void detail.move(projectId).then((ok) => {
            if (ok) setMoving(false);
          })
        }
      />
    </>
  );
}

/** The frame every non-ready state shares, so the header sits where the loaded one will. */
function SkillFrame({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) {
  return (
    <AppPage measure="reading">
      <AppPageHeader heading={heading} backHref="/skills" backLabel="Back to skills" />
      {children}
    </AppPage>
  );
}
