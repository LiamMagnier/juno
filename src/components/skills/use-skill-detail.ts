"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ClientWorkSkill, ClientWorkSkillVersion, SkillResource } from "@/lib/work/skills";
import type { ClientSkillSource } from "@/lib/skills/library-contract";
import type { SkillDraft } from "@/components/skills/skill-editor";
import type { SkillUsage } from "@/components/skills/skill-detail-view";
import { skillUsagePatch } from "@/components/skills/skill-library-model";
import {
  consentSkillVersion,
  deleteSkill,
  fetchSkill,
  fetchSkillVersions,
  mintSkillVersion,
  patchSkill,
  patchSkillSource,
  skillsFailureMessage,
  type PatchSkillInput,
} from "@/components/skills/skills-transport";
import { PRODUCT_NAME } from "@/lib/brand/names";

type LoadState = "loading" | "ready" | "missing" | "failed";

/**
 * One skill, its current version, its history, and every write the page can
 * make to it.
 *
 * THE HISTORY HAS THREE STATES, NOT TWO. `versions` is null while the request
 * is in flight and `versionsFailed` says whether it failed; the page used to
 * read null as failure and showed "Couldn't read the history" on every load.
 *
 * A VERSION IS A COMPLETE SNAPSHOT. Saving sends the whole contract and the
 * whole tool request back with the new instructions, because the route fills
 * anything omitted with the EMPTY value: a save that sent only the text would
 * quietly strip the skill of its files and of every tool it declared.
 */
export function useSkillDetail(id: string) {
  const [state, setState] = React.useState<LoadState>("loading");
  const [skill, setSkill] = React.useState<ClientWorkSkill | null>(null);
  const [version, setVersion] = React.useState<ClientWorkSkillVersion | null>(null);
  const [resources, setResources] = React.useState<SkillResource[]>([]);
  const [projectName, setProjectName] = React.useState<string | null>(null);
  const [source, setSource] = React.useState<ClientSkillSource | null>(null);
  const [versions, setVersions] = React.useState<ClientWorkSkillVersion[] | null>(null);
  const [versionsFailed, setVersionsFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const result = await fetchSkill(id);
    if (result.kind === "ok") {
      setSkill(result.value.skill);
      setVersion(result.value.version);
      setResources(result.value.resources);
      setProjectName(result.value.projectName);
      setSource(result.value.source);
      setState("ready");
      return;
    }
    setState(result.kind === "failed" && result.cause === "not_found" ? "missing" : "failed");
  }, [id]);

  const loadVersions = React.useCallback(async () => {
    setVersionsFailed(false);
    const result = await fetchSkillVersions(id);
    if (result.kind === "ok") {
      setVersions(result.value);
      return;
    }
    setVersions(null);
    setVersionsFailed(true);
  }, [id]);

  React.useEffect(() => {
    void load();
    void loadVersions();
  }, [load, loadVersions]);

  const patch = async (input: PatchSkillInput, failure: string): Promise<boolean> => {
    setBusy(true);
    const result = await patchSkill(id, input);
    setBusy(false);
    if (result.kind === "ok") {
      setSkill(result.value);
      return true;
    }
    toast.error(skillsFailureMessage(result, failure));
    return false;
  };

  const setEnabled = (enabled: boolean) => {
    // Answers at once and puts it back if the server refuses.
    setSkill((current) => (current ? { ...current, enabled } : current));
    void patch({ enabled }, "Couldn’t change that. The skill is as it was.").then((ok) => {
      if (!ok) setSkill((current) => (current ? { ...current, enabled: !enabled } : current));
    });
  };

  /**
   * The switch of the repository this skill came from, which the page offers
   * when it is off: the skill's own switch reads On then, and without this the
   * reader would have to find the folder on the library to learn why it does
   * not run.
   */
  const setSourceEnabled = async (enabled: boolean) => {
    if (!source) return;
    setBusy(true);
    const result = await patchSkillSource(source.id, { enabled });
    setBusy(false);
    if (result.kind === "ok") {
      setSource(result.value ?? { ...source, enabled });
      return;
    }
    toast.error(skillsFailureMessage(result, "Couldn’t change that. The repository is as it was."));
  };

  const setUsage = (usage: SkillUsage) =>
    void patch(
      // Trust and automatic selection together; see `skillUsagePatch`.
      skillUsagePatch(usage, { trust: skill?.trust ?? "untrusted" }, version?.contract.provenance),
      `Couldn’t change how ${PRODUCT_NAME} uses this skill. It is as it was.`
    );

  const move = (projectId: string | null) =>
    patch({ projectId }, "Couldn’t move this skill. It is filed where it was.").then((ok) => {
      // The name of the project lives on the project, so read it back.
      if (ok) void load();
      return ok;
    });

  const save = async (draft: SkillDraft): Promise<boolean> => {
    if (!skill) return false;
    const renamed = draft.name !== skill.name || draft.description !== skill.description;
    const rewritten =
      version === null ||
      draft.instructions !== version.instructions.trim() ||
      draft.resources.length !== resources.length ||
      draft.resources.some((resource, index) => resource.attachmentId !== resources[index]?.attachmentId);

    if (renamed) {
      const ok = await patch(
        { name: draft.name, description: draft.description },
        "Couldn’t save the name and description. Nothing was saved."
      );
      if (!ok) return false;
    }
    if (!rewritten) {
      toast.success("Saved.");
      return true;
    }

    setBusy(true);
    const result = await mintSkillVersion(id, {
      instructions: draft.instructions,
      contract: version
        ? { ...version.contract, resourceAttachmentIds: draft.resources.map((resource) => resource.attachmentId) }
        : undefined,
      requestedTools: version?.requestedTools,
    });
    setBusy(false);
    if (result.kind === "ok") {
      setVersion(result.value);
      setResources(draft.resources);
      setSkill((current) =>
        current
          ? {
              ...current,
              currentVersion: result.value.version,
              securityStatus: result.value.securityStatus,
              securityUpdatedAt: new Date().toISOString(),
            }
          : current
      );
      void loadVersions();
      toast.success(`Saved as version ${result.value.version}.`);
      return true;
    }
    toast.error(
      result.kind === "blocked"
        ? "Someone else saved this skill at the same moment. Reload and try again."
        : skillsFailureMessage(result, "Couldn’t save this version. The current one is unchanged.")
    );
    return false;
  };

  const restore = async (restoreVersion: number) => {
    setBusy(true);
    const result = await mintSkillVersion(id, { restoreVersion });
    setBusy(false);
    if (result.kind === "ok") {
      void load();
      void loadVersions();
      toast.success(`Version ${restoreVersion} is back, saved as version ${result.value.version}.`);
      return;
    }
    toast.error(skillsFailureMessage(result, "Couldn’t restore that version. Nothing changed."));
  };

  const consent = async () => {
    if (!version?.requiresConsent) return;
    setBusy(true);
    const result = await consentSkillVersion(id, version.version);
    setBusy(false);
    if (result.kind === "ok") {
      setVersion(result.value);
      void loadVersions();
      toast.success("Approved. The skill can run again.");
      return;
    }
    toast.error(skillsFailureMessage(result, "Couldn’t approve it. Nothing about the skill has changed."));
  };

  const remove = async (): Promise<boolean> => {
    setBusy(true);
    const result = await deleteSkill(id);
    setBusy(false);
    if (result.kind === "ok") return true;
    toast.error(skillsFailureMessage(result, "Couldn’t delete this skill. It is exactly as it was."));
    return false;
  };

  return {
    state,
    skill,
    version,
    resources,
    projectName,
    source,
    versions,
    versionsFailed,
    busy,
    reload: load,
    reloadVersions: loadVersions,
    setEnabled,
    setSourceEnabled,
    setUsage,
    move,
    save,
    restore,
    consent,
    remove,
  };
}

/**
 * The account's projects, read when the move dialog first opens.
 *
 * The projects surface's own endpoint rather than a skills-shaped copy of it,
 * so the two can never disagree about which projects exist. A failed read is
 * carried: a picker offering only "No project" would say the account has none.
 */
export function useProjects(wanted: boolean) {
  const [projects, setProjects] = React.useState<{ id: string; name: string }[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (!wanted || projects !== null) return;
    let live = true;
    setFailed(false);
    fetch("/api/projects")
      .then((response) => {
        if (!response.ok) throw new Error("projects");
        return response.json() as Promise<{ projects?: { id: string; name: string }[] }>;
      })
      .then((data) => {
        if (!live) return;
        setProjects(
          Array.isArray(data.projects) ? data.projects.map((project) => ({ id: project.id, name: project.name })) : []
        );
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [wanted, projects]);
  return { projects, failed };
}
