"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { History, Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  trustPermitsAutoSelection,
  type ClientWorkSkill,
  type ClientWorkSkillVersion,
} from "@/lib/work/skills";
import { WorkPageFrame } from "@/components/work/work-nav";
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
import { staggerDelay } from "@/lib/motion";

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
export default function WorkSkillPage() {
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

  const load = React.useCallback(async () => {
    setFailed(false);
    const result = await fetchWorkSkill(id);
    if (result.kind === "ok") {
      setSkill(result.value.skill);
      setVersion(result.value.version);
      setName(result.value.skill.name);
      setDescription(result.value.skill.description);
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

  const saveInstructions = async () => {
    const text = instructions.trim();
    if (text.length === 0 || skill === null) return;
    setBusy(true);
    const result = await mintWorkSkillVersion(id, { instructions: text });
    setBusy(false);
    if (result.kind === "ok") {
      setVersion(result.value);
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
    toast.error(
      result.kind === "blocked"
        ? "Someone else saved this skill at the same moment. Reload and try again."
        : "Couldn’t save these instructions. The version that was current still is."
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
      router.push("/work/skills");
      return;
    }
    toast.error("Couldn’t delete this skill. It is exactly as it was.");
  };

  if (missing) {
    return (
      <WorkPageFrame title="Skill not found" back={{ href: "/work/skills", label: "Back to skills" }}>
        <WorkStateNote tone="error">
          This skill no longer exists. It may have been deleted from another device.
        </WorkStateNote>
      </WorkPageFrame>
    );
  }

  if (failed) {
    return (
      <WorkPageFrame title="Skill" back={{ href: "/work/skills", label: "Back to skills" }}>
        <WorkStateNote
          tone="error"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
            </Button>
          }
        >
          Couldn’t load this skill. Nothing has been changed by the attempt.
        </WorkStateNote>
      </WorkPageFrame>
    );
  }

  if (skill === null) {
    return (
      <WorkPageFrame title="Skill" back={{ href: "/work/skills", label: "Back to skills" }}>
        <div className="space-y-3">
          {[...Array(3)].map((_, index) => (
            <Skeleton
              key={index}
              className="h-20 w-full rounded-field"
              style={staggerDelay(index, "tight")}
            />
          ))}
        </div>
      </WorkPageFrame>
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
  const securityStatus = version?.securityStatus ?? skill.securityStatus;
  const securityFindings = securityFindingsOf(version?.securityScan);

  return (
    <WorkPageFrame
      title={skill.name}
      description={`Typed as /${skill.slug} · v${skill.currentVersion} · ${trustLabel(skill.trust)}`}
      back={{ href: "/work/skills", label: "Back to skills" }}
      action={
        <Button
          variant="destructive-outline"
          size="sm"
          disabled={busy}
          onClick={() => setConfirmingDelete(true)}
          className="gap-1.5"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
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

        <section className="space-y-2.5">
          <h2 className="font-mono text-label text-muted-foreground">How Juno may use it</h2>
          <label className="flex items-center justify-between gap-3 rounded-field border border-border/50 px-3.5 py-2.5">
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

          <label className="flex items-center justify-between gap-3 rounded-field border border-border/50 px-3.5 py-2.5">
            <span className="min-w-0">
              <span className="block text-ui font-medium text-foreground">
                Juno may reach for it unasked
              </span>
              <span className="mt-0.5 block text-caption leading-relaxed text-muted-foreground">
                {trusted
                  ? "The planner may pick this up when a task looks like it fits, without you naming it."
                  : "Only a trusted skill can be chosen for you. Trust it below first."}
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

          <div className="rounded-field border border-border/50 px-3.5 py-2.5">
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
        </section>

        <section className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-label text-muted-foreground">Security review</h2>
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
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-field border border-warning/40 bg-warning/10 px-3.5 py-3">
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
            <ul className="space-y-1 rounded-field border border-border/60 px-3.5 py-2.5">
              {securityFindings.map((finding) => (
                <li key={`${finding.code}-${finding.message}`} className="text-caption leading-relaxed text-muted-foreground">
                  <span className="mr-1 font-mono text-micro uppercase text-foreground">
                    {finding.severity}
                  </span>
                  {finding.message}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section>
          <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
            <h2 className="font-mono text-label text-muted-foreground">Instructions</h2>
            <span className="font-mono text-micro text-muted-foreground">
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
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || instructions.trim().length === 0 || !instructionsChanged}
              onClick={() => void saveInstructions()}
              className="gap-1.5"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Save as a new version
            </Button>
            {instructionsChanged && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setInstructions(version?.instructions ?? "")}
              >
                Discard changes
              </Button>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-2.5 font-mono text-label text-muted-foreground">History</h2>
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
            <ul className="space-y-1.5">
              {versions.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-field border border-border/60 bg-card px-3.5 py-2.5"
                >
                  <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
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
                      <RotateCcw className="h-3 w-3" aria-hidden="true" /> Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
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
    </WorkPageFrame>
  );
}
