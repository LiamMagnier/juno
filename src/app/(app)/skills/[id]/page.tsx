"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { History, Loader2 } from "lucide-react";
import { ActionIcons, CodeIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_SKILL_RESOURCES,
  trustPermitsAutoSelection,
  type ClientWorkSkill,
  type ClientWorkSkillVersion,
  type SkillResource,
} from "@/lib/work/skills";
import { useUploads } from "@/hooks/use-uploads";
import { DOC_MIME } from "@/lib/uploads";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkList } from "@/components/work/shell/work-section";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
import { trustLabel } from "@/components/work/work-skill-row";
import {
  deleteWorkSkill,
  consentWorkSkillVersion,
  fetchWorkSkill,
  fetchWorkSkillVersions,
  mintWorkSkillVersion,
  patchWorkSkill,
  type PatchWorkSkillInput,
} from "@/components/work/work-transport";
import { WorkStateNote, workTimeAgo } from "@/components/work/work-vocabulary";

interface SkillSecurityFindingView {
  code: string;
  severity: string;
  message: string;
}

function securityFindingsOf(raw: unknown): SkillSecurityFindingView[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const findings = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  return findings.flatMap((finding) => {
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) return [];
    const value = finding as Record<string, unknown>;
    return typeof value.code === "string" &&
      typeof value.severity === "string" &&
      typeof value.message === "string"
      ? [{ code: value.code, severity: value.severity, message: value.message }]
      : [];
  });
}

/**
 * What the picker offers — documents only, and for the reason the two Work
 * composers give beside their own copies of this list: `attachedSources` in
 * scripts/work-runner.ts reads `Attachment.extractedText`, which is null for a
 * photo. Offering images here would promise a skill a look at a picture it can
 * never get, and the promise would be kept for every future run of it rather
 * than for one message.
 *
 * The third copy of this list in the product, and the duplication stays
 * deliberate for the same reason the second one did: each sits beside its own
 * statement of what the exclusion protects, so anybody widening one is told.
 */
const SKILL_RESOURCE_ACCEPT = [
  ...DOC_MIME,
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".py",
].join(",");

/**
 * The picker's value for "not filed in any project".
 *
 * A sentinel rather than an empty string: an `<option value="">` inside a
 * select whose state is driven by a nullable id reads back as the falsy value
 * for both "the account" and "nothing chosen", and the two want different
 * writes — one is `projectId: null`, which is a decision, and the other is no
 * request at all.
 */
const ACCOUNT_LEVEL = "__account__";

function securityLabel(status: string): string {
  if (status === "clear") return "Clear";
  if (status === "warning") return "Review recommended";
  if (status === "blocked") return "Blocked";
  return "Pending review";
}

/**
 * The three states drawn from the three token ramps, not from two palettes.
 *
 * `clear` and the pending/warning branch were raw emerald and amber while
 * `blocked` beside them was already `destructive` — so one pill's three states
 * came from two unrelated colour systems, and the greens and ambers here were a
 * second set of them on a page that renders the tokens elsewhere.
 * `success-ink` / `warning-foreground` rather than the fills, because these are
 * small text and the fills do not clear AA at this size.
 */
function securityClassName(status: string): string {
  if (status === "clear") return "border-success/30 bg-success/10 text-success-ink";
  if (status === "blocked") return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-warning/35 bg-warning/10 text-warning-foreground";
}

/**
 * One skill: what it says, what it is allowed to be, and everything it used to
 * say.
 *
 * Editing the instructions mints a version rather than overwriting one, because
 * the history is append-only on purpose: a run from last month recorded the
 * version it followed, and "what was this skill doing on the 3rd" has to keep
 * its answer after somebody rewrites it on the 4th. A restore is a new version
 * carrying the old content for exactly the same reason — moving the pointer
 * backwards would make the restore itself invisible.
 *
 * Trust and automatic selection are edited as a pair because the server stores
 * them as one: withdrawing trust switches off the automatic selection that trust
 * was what permitted, in the same write, and a form that let them drift would
 * show a state the row can never hold.
 */
export default function SkillPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [skill, setSkill] = React.useState<ClientWorkSkill | null>(null);
  const [version, setVersion] = React.useState<ClientWorkSkillVersion | null>(null);
  const [versions, setVersions] = React.useState<ClientWorkSkillVersion[] | null>(null);
  const [missing, setMissing] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  /**
   * The files this version brings, as the reader is editing them.
   *
   * Held beside `version` rather than derived from it because a skill's files
   * are edited the way its instructions are: in the box, and saved as a new
   * version. `saved` is what the server last said, and the difference between
   * the two is what the save button is enabled by.
   */
  const [saved, setSaved] = React.useState<SkillResource[]>([]);
  const [resources, setResources] = React.useState<SkillResource[]>([]);
  const [projectName, setProjectName] = React.useState<string | null>(null);
  /**
   * The projects this skill could be filed in.
   *
   * `null` while the list is in flight, and the control below is disabled until
   * it arrives rather than drawn empty: a picker showing only "Everything" for
   * a moment is a picker that says this account has no projects, and a reader
   * who looks at the wrong moment concludes filing is not available.
   */
  const [projects, setProjects] = React.useState<{ id: string; name: string }[] | null>(null);
  // `null`: these files belong to a skill, not to a chat.
  const { uploads, addFiles, remove: dropUpload, isUploading } = useUploads(null);
  const resourceInput = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    setFailed(false);
    const result = await fetchWorkSkill(id);
    if (result.kind === "ok") {
      setSkill(result.value.skill);
      setVersion(result.value.version);
      setName(result.value.skill.name);
      setDescription(result.value.skill.description);
      setSaved(result.value.resources);
      setResources(result.value.resources);
      setProjectName(result.value.projectName);
      // Empty rather than a substitute when `currentVersion` names a row that is
      // not there. Seeding the box with the newest version instead would put
      // instructions the user did not choose under the heading of the one they
      // did, and the next save would mint them as the current text.
      setInstructions(result.value.version?.instructions ?? "");
      return;
    }
    if (result.kind === "failed" && result.cause === "not_found") {
      setMissing(true);
      return;
    }
    setFailed(true);
  }, [id]);

  const loadVersions = React.useCallback(async () => {
    const result = await fetchWorkSkillVersions(id);
    if (result.kind === "ok") setVersions(result.value);
  }, [id]);

  React.useEffect(() => {
    void load();
    void loadVersions();
  }, [load, loadVersions]);

  React.useEffect(() => {
    let live = true;
    // The projects surface's own endpoint rather than a skills-shaped copy of
    // it: a second list of projects is a second answer to "which projects do I
    // have", and the two disagree the first time one is renamed elsewhere.
    fetch("/api/projects")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { projects?: { id: string; name: string }[] } | null) => {
        if (live && data && Array.isArray(data.projects)) {
          setProjects(data.projects.map((project) => ({ id: project.id, name: project.name })));
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  /*
   * A finished upload becomes a pending file on the version, and leaves the
   * upload list.
   *
   * One list rather than two, which is the difference between this and the task
   * composer's hand-over: a task's files are handed to a running thing and the
   * second press is what makes that deliberate, while these are rows in a form
   * that is not saved until the reader presses Save. Showing a finished upload
   * in one strip and the version's files in another would be two lists of the
   * same thing, and the reader would have to work out which of them the save is
   * going to read.
   *
   * Only the finished rows are taken off the upload list, one by one, rather
   * than clearing it: a batch where one file succeeded and one failed would
   * otherwise lose the failure before anybody saw it, and the reader would be
   * left with a file they picked, no error, and no row.
   */
  React.useEffect(() => {
    const done = uploads.filter((upload) => upload.status === "done" && upload.attachment);
    if (done.length === 0) return;
    const held = new Set(resources.map((resource) => resource.attachmentId));
    const added = done
      .filter((upload) => !held.has(upload.attachment!.id))
      .map((upload) => ({
        attachmentId: upload.attachment!.id,
        fileName: upload.attachment!.fileName,
      }));
    if (added.length > 0) {
      const next = [...resources, ...added];
      if (next.length > MAX_SKILL_RESOURCES) {
        // Said rather than done silently. A file that vanished between the
        // upload finishing and the list redrawing reads as a bug in the page.
        toast.error(`A skill can bring up to ${MAX_SKILL_RESOURCES} files.`);
      }
      setResources(next.slice(0, MAX_SKILL_RESOURCES));
    }
    for (const upload of done) dropUpload(upload.localId);
  }, [uploads, resources, dropUpload]);

  const applyPatch = async (patch: PatchWorkSkillInput, failure: string) => {
    setBusy(true);
    const result = await patchWorkSkill(id, patch);
    setBusy(false);
    if (result.kind === "ok") {
      setSkill(result.value);
      setName(result.value.name);
      setDescription(result.value.description);
      return;
    }
    toast.error(result.kind === "blocked" ? result.explanation : failure);
  };

  /**
   * Moves the skill into a project, or back to the account.
   *
   * Its own function rather than another `applyPatch` call because the page
   * holds the project's NAME, which the patch does not return — the skill row
   * carries an id and the name lives on the project. Re-reading is the honest
   * way to keep the caption underneath the automatic-selection switch saying
   * which project it means.
   */
  const refile = async (projectId: string | null) => {
    setBusy(true);
    const result = await patchWorkSkill(id, { projectId });
    setBusy(false);
    if (result.kind === "ok") {
      setSkill(result.value);
      void load();
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? result.explanation
        : "Couldn’t move this skill. It is filed exactly where it was."
    );
  };

  /*
   * Saves the instructions AND the rest of the version's declaration.
   *
   * The whole contract and the whole tool request are sent, not the edited
   * field alone, and that is a correction rather than a flourish: a version is
   * a complete snapshot and the route fills anything a client omits with the
   * EMPTY value on purpose — "a client that omits a field gets a version that
   * asks for less, never more". This form used to send `{ instructions }`, so
   * every edit made from this page silently emptied the contract and the tool
   * request of whatever the skill had declared. Nothing showed it, because
   * nothing on this page drew either of them. Now that the page draws the
   * files, the same bug would delete them on the next typo fix.
   */
  const saveVersion = async () => {
    const text = instructions.trim();
    if (text.length === 0 || skill === null || version === null) return;
    setBusy(true);
    const result = await mintWorkSkillVersion(id, {
      instructions: text,
      contract: {
        ...version.contract,
        resourceAttachmentIds: resources.map((resource) => resource.attachmentId),
      },
      requestedTools: version.requestedTools,
    });
    setBusy(false);
    if (result.kind === "ok") {
      setVersion(result.value);
      setSaved(resources);
      setSkill({
        ...skill,
        currentVersion: result.value.version,
        securityStatus: result.value.securityStatus,
        securityUpdatedAt: new Date().toISOString(),
      });
      void loadVersions();
      toast.success(`Saved as v${result.value.version}. The previous version is still readable.`);
      return;
    }
    // The route's own sentence when it wrote one, because the case that
    // produces it is reachable from this very form: delete one of the skill's
    // files from the Library in another tab, press Save here, and the route
    // answers 404 with "One of the files this version brings is not in your
    // library". The generic line would send the reader looking for a fault in
    // their instructions instead of at the file they just deleted.
    toast.error(
      result.kind === "blocked"
        ? "Someone else saved this skill at the same moment. Reload and try again."
        : (result.message ??
          "Couldn’t save this version. The version that was current still is.")
    );
  };

  const restore = async (restoreVersion: number) => {
    if (skill === null) return;
    setBusy(true);
    const result = await mintWorkSkillVersion(id, { restoreVersion });
    setBusy(false);
    if (result.kind === "ok") {
      setVersion(result.value);
      setInstructions(result.value.instructions);
      setSkill({
        ...skill,
        currentVersion: result.value.version,
        securityStatus: result.value.securityStatus,
        securityUpdatedAt: new Date().toISOString(),
      });
      void loadVersions();
      // Re-read rather than patched in place. A restored version brings the old
      // version's file list with it, and this page only holds ids — the names
      // beside them come from the server, so the honest way to show what was
      // restored is to ask for it.
      void load();
      toast.success(`v${restoreVersion} is back, saved as v${result.value.version}.`);
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? "Someone else saved this skill at the same moment. Reload and try again."
        : "Couldn’t restore that version. Nothing changed."
    );
  };

  const consent = async () => {
    if (skill === null || version === null || !version.requiresConsent) return;
    setBusy(true);
    const result = await consentWorkSkillVersion(id, version.version);
    setBusy(false);
    if (result.kind === "ok") {
      setVersion(result.value);
      setSkill({
        ...skill,
        securityStatus: result.value.securityStatus,
        securityUpdatedAt: new Date().toISOString(),
      });
      void loadVersions();
      toast.success(`Permissions approved for v${result.value.version}.`);
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? result.explanation
        : "Couldn’t approve these permissions. Nothing about the skill has changed."
    );
  };

  const destroy = async () => {
    setBusy(true);
    const result = await deleteWorkSkill(id);
    setBusy(false);
    setConfirmingDelete(false);
    if (result.kind === "ok") {
      router.push("/skills");
      return;
    }
    toast.error("Couldn’t delete this skill. It is exactly as it was.");
  };

  if (missing) {
    return (
      <SkillFrame heading="Skill not found">
        <WorkStateNote tone="error">
          This skill no longer exists. It may have been deleted from another device.
        </WorkStateNote>
      </SkillFrame>
    );
  }

  if (failed) {
    return (
      <SkillFrame heading="Skill">
        <WorkLoadError onRetry={() => void load()}>
          Couldn’t load this skill. Nothing has been changed by the attempt.
        </WorkLoadError>
      </SkillFrame>
    );
  }

  if (skill === null) {
    return (
      <SkillFrame heading={<Skeleton className="h-8 w-56 max-w-full" />}>
        <WorkRowSkeletons count={3} height={80} className="space-y-3" />
      </SkillFrame>
    );
  }

  const trusted = trustPermitsAutoSelection(skill.trust);
  // `verified` means Juno reviewed the skill, and no client may set it. A
  // control offering it would turn the strongest claim in the vocabulary into
  // the cheapest one, so a verified skill gets a sentence here instead of a
  // switch that would silently downgrade it. Held as the narrowed value rather
  // than as a boolean, so the control below cannot be handed a trust level the
  // route would refuse.
  const settableTrust =
    skill.trust === "untrusted" || skill.trust === "user_authored" ? skill.trust : null;
  const instructionsChanged = version !== null && instructions.trim() !== version.instructions.trim();
  // Compared as an ordered list, because the order is what the run reads them
  // in: moving the template above the style guide is a real edit even though
  // the set is unchanged.
  const resourcesChanged =
    resources.length !== saved.length ||
    resources.some((resource, index) => resource.attachmentId !== saved[index]?.attachmentId);
  // One save for the whole version, because a version is one snapshot. Two
  // buttons would offer to save half of it, and the half not saved would be
  // emptied by the half that was.
  const versionChanged = instructionsChanged || resourcesChanged;
  // The contract names files this account no longer has. The count is the whole
  // sentence: the page cannot show a name it was not given, and the reader's
  // question is whether the skill still brings what it says it does. Counted
  // over the distinct ids, because the server resolves them as a set and a
  // contract that happened to name one file twice is not a contract that lost
  // one.
  const lostResources =
    new Set(version?.contract.resourceAttachmentIds ?? []).size - saved.length;
  const securityStatus = version?.securityStatus ?? skill.securityStatus;
  const securityFindings = securityFindingsOf(version?.securityScan);

  return (
    <SkillFrame
      heading={skill.name}
      lede={`Typed as /${skill.slug} · v${skill.currentVersion} · ${trustLabel(skill.trust)}`}
      actions={
        <Button
          variant="destructive-outline"
          size="sm"
          disabled={busy}
          onClick={() => setConfirmingDelete(true)}
          className="gap-1.5"
        >
          <ActionIcons.delete className="size-3.5" aria-hidden="true" /> Delete
        </Button>
      }
    >
      <div className="space-y-7">
        <section className="space-y-3">
          <div>
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                const next = name.trim();
                if (next.length === 0 || next === skill.name) {
                  setName(skill.name);
                  return;
                }
                void applyPatch({ name: next }, "Couldn’t rename this skill.");
              }}
              disabled={busy}
              className="mt-1"
            />
            <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
              The slash name stays /{skill.slug}. It is what older tasks already refer to, so it is
              chosen once and never rewritten.
            </p>
          </div>
          <div>
            <Label htmlFor="skill-description">What it is for</Label>
            <Input
              id="skill-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onBlur={() => {
                const next = description.trim();
                if (next === skill.description) return;
                void applyPatch({ description: next }, "Couldn’t save that description.");
              }}
              disabled={busy}
              className="mt-1"
            />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-heading">How Juno may use it</h2>
          <Card className="divide-y divide-border/60 p-0">
          <label className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0">
              <span className="block text-ui font-medium text-foreground">Available</span>
              <span className="mt-0.5 block text-caption leading-relaxed text-muted-foreground">
                Switched off, it cannot be used at all — not by name, not by Juno.
              </span>
            </span>
            <Switch
              checked={skill.enabled}
              disabled={busy}
              onCheckedChange={(enabled) =>
                void applyPatch({ enabled }, "Couldn’t change that. The skill is as it was.")
              }
              aria-label="Skill available"
            />
          </label>

          <label className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0">
              <span className="block text-ui font-medium text-foreground">
                Juno may reach for it unasked
              </span>
              <span className="mt-0.5 block text-caption leading-relaxed text-muted-foreground">
                {!trusted
                  ? "Only a trusted skill can be chosen for you. Trust it below first."
                  : skill.projectId === null
                    ? "The planner may pick this up when a task looks like it fits, without you naming it."
                    : // A filed skill is offered to its own project's tasks and
                      // to no others, so the caption says so rather than
                      // describing a wider behaviour than the runtime has.
                      `The planner may pick this up for a task filed in ${projectName ?? "its project"}, when the task looks like it fits. Typing /${skill.slug} still works anywhere.`}
              </span>
            </span>
            <Switch
              checked={skill.autoSelect && trusted}
              disabled={busy || !trusted}
              onCheckedChange={(autoSelect) =>
                void applyPatch({ autoSelect }, "Couldn’t change that. The skill is as it was.")
              }
              aria-label="Juno may choose this skill"
            />
          </label>

          <div className="px-4 py-3">
            <p className="text-ui font-medium text-foreground">Filed in</p>
            <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
              A skill filed in a project is offered to tasks in that project and to no others.
              Filed in Everything, it is on offer wherever Juno looks. Typing /{skill.slug} reaches
              it either way.
            </p>
            {/* The same `field-well` recipe the schedule editor's selects carry,
                rather than a second select idiom on a page that already draws
                one control per row. */}
            <select
              value={skill.projectId ?? ACCOUNT_LEVEL}
              disabled={busy || projects === null}
              onChange={(event) =>
                void refile(event.target.value === ACCOUNT_LEVEL ? null : event.target.value)
              }
              aria-label="The project this skill is filed in"
              className="field-well mt-2 h-9 w-full max-w-sm rounded-field border border-input px-3.5 text-ui transition-[color,border-color,box-shadow] duration-base ease-out-soft coarse:h-11 hover:border-input/80 focus-visible:border-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value={ACCOUNT_LEVEL}>Everything</option>
              {/* The skill's own project is listed even when the projects
                  request has not landed, failed, or came back without it — a
                  project the account can no longer see still holds the skill,
                  and a select whose value matches no option renders blank,
                  which reads as a skill filed nowhere. */}
              {skill.projectId !== null &&
              !(projects ?? []).some((project) => project.id === skill.projectId) ? (
                <option value={skill.projectId}>{projectName ?? "Its project"}</option>
              ) : null}
              {(projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <div className="px-4 py-3">
            <p className="text-ui font-medium text-foreground">Trust</p>
            {settableTrust !== null ? (
              <>
                <SegmentedControl
                  value={settableTrust}
                  onChange={(trust) =>
                    void applyPatch({ trust }, "Couldn’t change that. The skill is as it was.")
                  }
                  options={[
                    { value: "untrusted", label: "Not trusted" },
                    { value: "user_authored", label: "I trust this" },
                  ]}
                  ariaLabel="How far this skill is trusted"
                  optionClassName="px-3 py-1 text-label"
                  className="mt-2 max-w-sm"
                />
                <p className="mt-1.5 text-caption leading-relaxed text-muted-foreground">
                  Withdrawing trust also switches off automatic selection, in the same change — the
                  two are one decision, and a skill that was trusted enough to be chosen for you is
                  not trusted enough afterwards.
                </p>
              </>
            ) : (
              <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
                Juno reviewed this skill. That is a claim only Juno can make, so it is not something
                this page can set or take away.
              </p>
            )}
          </div>
          </Card>
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-heading">Security review</h2>
            {/* `inline-flex … leading-none`, which is what `WorkStatusPill` and
                `RiskPill` carry. Without it this chip inherited the section's
                line-height and stood ~4px taller than every other pill in Work,
                on a page that shows two of them a scroll apart. */}
            <span
              className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-micro leading-none ${securityClassName(securityStatus)}`}
            >
              {securityLabel(securityStatus)}
            </span>
          </div>
          <p className="text-caption leading-relaxed text-muted-foreground">
            Every version is scanned when it is saved. Blocked versions cannot run; a version that
            asks for more permissions waits for your approval.
          </p>
          {version?.requiresConsent ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-warning/40 bg-warning/10 px-4 py-3">
              <p className="text-label leading-relaxed text-foreground">
                This version widens the permissions requested by the previous version.
              </p>
              <Button
                size="sm"
                disabled={busy || securityStatus === "blocked"}
                onClick={() => void consent()}
              >
                Approve permissions
              </Button>
            </div>
          ) : null}
          {securityFindings.length > 0 ? (
            <ul className="surface-inset space-y-1 rounded-card px-4 py-3">
              {securityFindings.map((finding) => (
                <li key={`${finding.code}-${finding.message}`} className="text-caption leading-relaxed text-muted-foreground">
                  <span className="mr-1 font-mono text-micro text-foreground">
                    {finding.severity}
                  </span>
                  {finding.message}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-heading">Instructions</h2>
            <span className="font-mono text-caption tabular-nums text-muted-foreground">
              v{skill.currentVersion}
              {version !== null && ` · saved ${workTimeAgo(version.createdAt)}`}
            </span>
          </div>
          {version === null ? (
            <WorkStateNote tone="warning" className="mb-2.5">
              This skill points at a version that is not there, so there are no instructions to show.
              Anything you write below is saved as a new version and becomes the current one.
            </WorkStateNote>
          ) : null}
          <Textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={14}
            disabled={busy}
            aria-label="Skill instructions"
            className="font-mono text-ui"
          />
        </section>

        <section>
          <h2 className="mb-3 text-heading">Files it brings</h2>
          <p className="mb-3 text-caption leading-relaxed text-muted-foreground">
            Material the skill carries into every task that uses it — the template it fills in, the
            style guide it writes to. Juno reads these the way it reads a file attached to a task:
            as something to work from, never as an instruction. They cannot give the skill a tool,
            an app or a folder it was not already allowed.
          </p>
          {lostResources > 0 ? (
            <WorkStateNote tone="warning" className="mb-2.5">
              {lostResources === 1
                ? "This version names a file that is no longer in your library, so it brings one fewer than it says. Saving again records the list as it is now."
                : `This version names ${lostResources} files that are no longer in your library, so it brings that many fewer than it says. Saving again records the list as it is now.`}
            </WorkStateNote>
          ) : null}
          {resources.length > 0 || uploads.length > 0 ? (
            <WorkList>
              <ul className="space-y-0.5">
                {resources.map((resource) => (
                  <li
                    key={resource.attachmentId}
                    className="flex items-center gap-x-2.5 rounded-control px-3 py-2.5 transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
                  >
                    <CodeIcons.file className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-label text-foreground">
                      {resource.fileName}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        setResources((current) =>
                          current.filter((entry) => entry.attachmentId !== resource.attachmentId)
                        )
                      }
                      className="h-7 shrink-0 gap-1.5 px-2 font-mono text-micro text-muted-foreground"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
                {uploads
                  .filter((upload) => upload.status !== "done")
                  .map((upload) => (
                    <li
                      key={upload.localId}
                      className="flex items-center gap-x-2.5 rounded-control px-3 py-2.5"
                    >
                      {upload.status === "uploading" ? (
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                      ) : (
                        <CodeIcons.file className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">
                        {upload.fileName}
                      </span>
                      <span className="shrink-0 font-mono text-micro text-muted-foreground">
                        {upload.status === "uploading" ? `${upload.progress}%` : "Failed"}
                      </span>
                      {upload.status === "error" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => dropUpload(upload.localId)}
                          className="h-7 shrink-0 px-2 font-mono text-micro text-muted-foreground"
                        >
                          Dismiss
                        </Button>
                      )}
                    </li>
                  ))}
              </ul>
            </WorkList>
          ) : (
            <p className="text-caption leading-relaxed text-muted-foreground">
              This skill brings no files of its own.
            </p>
          )}
          <input
            ref={resourceInput}
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
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || isUploading || resources.length >= MAX_SKILL_RESOURCES}
            onClick={() => resourceInput.current?.click()}
            className="mt-2.5 gap-1.5"
          >
            <CodeIcons.file className="size-3.5" aria-hidden="true" /> Add files
          </Button>
        </section>

        {/* One save for the instructions and the files together, because they
            are one version. A `div` rather than a third `section`: it has no
            heading of its own and it belongs to both of the sections above. */}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || isUploading || instructions.trim().length === 0 || !versionChanged}
              onClick={() => void saveVersion()}
              className="gap-1.5"
            >
              {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              Save as a new version
            </Button>
            {versionChanged && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setInstructions(version?.instructions ?? "");
                  setResources(saved);
                }}
              >
                Discard changes
              </Button>
            )}
            <p className="text-caption leading-relaxed text-muted-foreground">
              Saving mints a version. Tasks already running keep the one they started with.
            </p>
          </div>
        </div>

        <section>
          <h2 className="mb-3 text-heading">History</h2>
          {versions === null ? (
            // A failed read wears the error tone rather than the dashed
            // placeholder it was drawn as: "no history" and "the request
            // failed" are different facts and looked identical here.
            <EmptyState
              size="panel"
              tone="error"
              title="Couldn’t read the history"
              description="This skill’s history couldn’t be read just now. Nothing about it has changed."
            />
          ) : (
            <WorkList>
              <ul className="space-y-0.5">
              {versions.map((entry) => (
                <li
                  key={entry.id}
                  className="group flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control border border-transparent px-3 py-2.5 transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft hover:border-transparent hover:bg-accent motion-reduce:transition-none"
                >
                  <History className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="shrink-0 font-mono text-micro text-foreground">
                    v{entry.version}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">
                    {entry.instructions.slice(0, 120)}
                  </span>
                  <span className="shrink-0 font-mono text-micro text-muted-foreground">
                    {workTimeAgo(entry.createdAt)}
                  </span>
                  {entry.version !== skill.currentVersion && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void restore(entry.version)}
                      className="h-7 shrink-0 gap-1.5 px-2 font-mono text-micro text-muted-foreground"
                    >
                      <ActionIcons.restore className="size-3" aria-hidden="true" /> Restore
                    </Button>
                  )}
                </li>
              ))}
              </ul>
            </WorkList>
          )}
        </section>
      </div>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{skill.name}”?</DialogTitle>
            <DialogDescription>
              It disappears from your list and can no longer run. The versions themselves are kept,
              because runs from before today recorded which one they followed and that has to stay
              answerable.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void destroy()} disabled={busy}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SkillFrame>
  );
}

/**
 * The page frame every state of this route shares, so the header sits in the
 * same place whether the skill loaded, is loading, is gone or failed to load.
 */
function SkillFrame({
  heading,
  lede,
  actions,
  children,
}: {
  heading: React.ReactNode;
  lede?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <AppPage measure="reading">
      <AppPageHeader
        eyebrow="Skills"
        heading={heading}
        lede={lede}
        actions={actions}
        backHref="/skills"
        backLabel="Back to skills"
      />
      {children}
    </AppPage>
  );
}
