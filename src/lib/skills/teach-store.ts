/**
 * Writing taught skills: save a draft (switched off unless the person
 * confirmed what it may use), mint the next version when it is re-taught, and
 * revoke it.
 *
 * Everything that decides is in `teach.ts` and is tested without a database;
 * everything that writes a skill row goes through `skills/store.ts`, the one
 * place that derives trust, scans, clamps automatic selection and writes the
 * head row with its version in one transaction. This file is the glue between
 * the two plus the checks only a database can answer: whose project, whose
 * conversation, whose skill, and whether this draft was already saved.
 *
 * `server-only`: it writes to the database.
 */

import "server-only";
import type { WorkSkill, WorkSkillVersion } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { recordWorkAudit } from "@/lib/work/audit";
import {
  SKILL_CONTRACT_VERSION,
  emptySkillContract,
  parseRequestedTools,
  parseSkillContract,
  skillContractSchema,
  type WorkSkillContract,
} from "@/lib/work/skills";
import { consentReasonsOf } from "@/lib/skills/workflow";
import { createSkillWithFirstVersion, mintSkillVersion } from "@/lib/skills/store";
import {
  TEACH_ENABLE_MESSAGES,
  disallowedTaughtTools,
  formFromSave,
  parseTaughtInstructions,
  renderTaughtInstructions,
  scanTaughtSkill,
  taughtContractInputs,
  taughtDescription,
  taughtInstructionsFit,
  taughtOrigin,
  taughtPermissionFingerprint,
  taughtProvenance,
  taughtSlug,
  teachEnableDecision,
  type ClientTaughtSkill,
  type TaughtApp,
  type TaughtSkillForEdit,
  type TaughtSkillForm,
  type TaughtSkillSave,
  type TaughtSkillSaved,
} from "@/lib/skills/teach";

type Actor = "web" | "macos" | "ios";

export type SaveTaughtSkillResult =
  | ({ ok: true } & TaughtSkillSaved)
  | { ok: false; status: 400 | 404 | 409; error: string; message: string };

function clientSkill(skill: WorkSkill): ClientTaughtSkill {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    enabled: skill.enabled,
    currentVersion: skill.currentVersion,
    projectId: skill.projectId,
    securityStatus: skill.securityStatus,
  };
}

const refuse = (status: 400 | 404 | 409, error: string, message: string): SaveTaughtSkillResult => ({
  ok: false,
  status,
  error,
  message,
});

const digest = (fingerprint: string) => createHash("sha256").update(fingerprint).digest("hex");

/** The live skill a chat draft was already saved as, by its key. */
export async function findTaughtSkillByKey(userId: string, key: string): Promise<WorkSkill | null> {
  const version = await prisma.workSkillVersion.findFirst({
    where: {
      contract: { path: ["provenance", "taught.key"], equals: key },
      skill: { userId, deletedAt: null, kind: "skill" },
    },
    orderBy: { createdAt: "asc" },
    select: { skill: true },
  });
  return version?.skill ?? null;
}

async function ownsProject(userId: string, projectId: string | null): Promise<boolean> {
  if (!projectId) return true;
  const project = await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } });
  return project !== null;
}

/** A conversation id kept only when it is this account's, so provenance never links elsewhere. */
async function ownedConversationId(userId: string, conversationId: string | null): Promise<string | null> {
  if (!conversationId) return null;
  const row = await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } });
  return row?.id ?? null;
}

async function recordConsent(
  userId: string,
  actor: Actor,
  detail: { skillId: string; skillSlug: string; skillVersion: number; decision: "approved" | "revoked"; fingerprint?: string }
) {
  await recordWorkAudit({
    userId,
    kind: "skill_permission_consent",
    actor,
    detail: {
      skillId: detail.skillId,
      skillSlug: detail.skillSlug,
      skillVersion: detail.skillVersion,
      decision: detail.decision,
      enabled: detail.decision === "approved",
      // An approval settles any consent the version waited for; a revocation
      // says nothing about the version, only that the skill is off.
      ...(detail.decision === "approved" ? { requiresConsent: false } : {}),
      ...(detail.fingerprint ? { policyDigest: digest(detail.fingerprint) } : {}),
    },
  });
}

/**
 * Saves a taught skill: a new one (version 1), or the next version of the
 * skill named by `skillId`.
 *
 * Never switches anything on that the person did not confirm: `enable` is
 * honoured only when the fingerprint they acknowledged equals the fingerprint
 * being saved (`teachEnableDecision`). A chat draft saved twice (two tabs, a
 * double press, a press after reload) lands on the skill the first save made.
 */
export async function saveTaughtSkill(
  userId: string,
  save: TaughtSkillSave,
  opts: { actor?: Actor; now?: Date } = {}
): Promise<SaveTaughtSkillResult> {
  const actor = opts.actor ?? "web";
  const now = opts.now ?? new Date();
  const form = formFromSave(save);
  const instructions = renderTaughtInstructions(form);
  if (!taughtInstructionsFit(instructions)) {
    return refuse(400, "instructions_too_long", "These steps are too long for one skill. Shorten them and try again.");
  }
  if (!(await ownsProject(userId, save.projectId))) {
    return refuse(404, "project_not_found", "That project isn’t in your account, so nothing was saved.");
  }
  const conversationId = await ownedConversationId(userId, save.source.conversationId);
  const source = { via: save.source.via, conversationId };

  if (save.skillId) return reteach(userId, save, form, instructions, { actor, now, source });

  if (save.key) {
    const existing = await findTaughtSkillByKey(userId, save.key);
    if (existing) {
      return {
        ok: true,
        outcome: "replayed",
        skill: clientSkill(existing),
        version: existing.currentVersion,
        reason: null,
        message: null,
        requiresConsent: false,
      };
    }
  }

  const unknown = disallowedTaughtTools(form.tools);
  if (unknown.length > 0) {
    return refuse(400, "unknown_tool", `A skill can’t ask for ${unknown.join(", ")}. Remove it and save again.`);
  }
  if (form.domains.length > 0) {
    return refuse(400, "domains_not_supported", "A new taught skill can’t declare websites yet. Remove them and save again.");
  }
  const slug = taughtSlug(save);
  if (!slug) return refuse(400, "invalid_slug", "Give it a name with at least one letter or number.");

  const parsedContract = skillContractSchema.safeParse({
    ...emptySkillContract(),
    inputs: taughtContractInputs(form.inputs),
    requestedConnectors: form.connectors,
    requestedDomains: [],
    provenance: taughtProvenance({ source, key: save.key ?? null, now }),
  });
  if (!parsedContract.success) return refuse(400, "invalid_contract", "Something in what it may use isn’t valid. Nothing was saved.");
  const contract = parsedContract.data;

  const fingerprint = taughtPermissionFingerprint(form, contract);
  const scan = scanTaughtSkill(form, contract);
  const decision = teachEnableDecision({
    wantsEnable: save.enable,
    acknowledged: save.acknowledged,
    fingerprint,
    scanStatus: scan.status,
  });

  const created = await createSkillWithFirstVersion({
    userId,
    slug,
    name: form.name,
    description: taughtDescription(form),
    instructions,
    projectId: save.projectId,
    contract,
    requestedTools: form.tools,
    origin: "authored",
    autoSelect: false,
    enabled: decision.enabled,
    actor,
  });
  if (!created.ok) {
    // Two presses of one draft at once: the other one made it. That is the
    // replay this key exists for, not a name clash to report.
    const raced = save.key ? await findTaughtSkillByKey(userId, save.key) : null;
    if (raced) {
      return {
        ok: true,
        outcome: "replayed",
        skill: clientSkill(raced),
        version: raced.currentVersion,
        reason: null,
        message: null,
        requiresConsent: false,
      };
    }
    return refuse(409, "slug_taken", `You already have a skill called /${created.slug}. Give this one a different name.`);
  }
  if (created.skill.enabled) {
    await recordConsent(userId, actor, {
      skillId: created.skill.id,
      skillSlug: created.skill.slug,
      skillVersion: created.version.version,
      decision: "approved",
      fingerprint,
    });
  }
  const reason = created.blocked ? "blocked" : decision.reason;
  return {
    ok: true,
    outcome: "created",
    skill: clientSkill(created.skill),
    version: created.version.version,
    reason,
    message: reason ? TEACH_ENABLE_MESSAGES[reason] : null,
    requiresConsent: created.version.requiresConsent,
  };
}

async function reteach(
  userId: string,
  save: TaughtSkillSave,
  form: TaughtSkillForm,
  instructions: string,
  ctx: { actor: Actor; now: Date; source: { via: "conversation" | "walkthrough"; conversationId: string | null } }
): Promise<SaveTaughtSkillResult> {
  const skill = await prisma.workSkill.findFirst({
    where: { id: save.skillId, userId, deletedAt: null, kind: "skill" },
  });
  if (!skill) return refuse(404, "not_found", "That skill isn’t in your library any more.");
  if (skill.sourceId) {
    return refuse(409, "installed_skill", "This skill was installed from a repository; update it from its source instead.");
  }
  const current = await prisma.workSkillVersion.findFirst({
    where: { skillId: skill.id, version: skill.currentVersion },
    select: { contract: true, requestedTools: true },
  });
  const base = parseSkillContract(current?.contract);
  const previousTools = parseRequestedTools(current?.requestedTools);

  const unknown = disallowedTaughtTools(form.tools, previousTools);
  if (unknown.length > 0) {
    return refuse(400, "unknown_tool", `A skill can’t ask for ${unknown.join(", ")}. Remove it and save again.`);
  }
  const newDomains = form.domains.filter((domain) => !base.requestedDomains.includes(domain));
  if (newDomains.length > 0) {
    return refuse(400, "domains_not_supported", "Websites can only be removed here, not added. Nothing was saved.");
  }

  const parsedContract = skillContractSchema.safeParse({
    ...base,
    inputs: taughtContractInputs(form.inputs),
    requestedConnectors: form.connectors,
    requestedDomains: form.domains,
    provenance: taughtProvenance({ source: ctx.source, now: ctx.now, previous: base.provenance }),
  });
  if (!parsedContract.success) return refuse(400, "invalid_contract", "Something in what it may use isn’t valid. Nothing was saved.");
  const contract: WorkSkillContract = parsedContract.data;

  const minted = await mintSkillVersion({
    userId,
    skill: { id: skill.id, name: form.name, description: skill.description },
    content: { instructions, contract, contractVersion: SKILL_CONTRACT_VERSION, requestedTools: form.tools },
    head: { description: taughtDescription(form) },
    actor: ctx.actor,
  });
  if (!minted.ok) {
    return refuse(409, "version_conflict", "Someone else saved this skill at the same moment. Reload and try again.");
  }

  const fingerprint = taughtPermissionFingerprint(form, contract);
  const consentFor = consentReasonsOf(minted.version.securityScan);
  const decision = teachEnableDecision({
    wantsEnable: save.enable,
    acknowledged: save.acknowledged,
    fingerprint,
    scanStatus: minted.version.securityStatus,
    consentFor: minted.requiresConsent ? consentFor : [],
  });

  let requiresConsent = minted.requiresConsent;
  if (decision.settleConsent) {
    const settled = await prisma.workSkillVersion.updateMany({
      where: { id: minted.version.id, skillId: skill.id, skill: { userId }, requiresConsent: true },
      data: { requiresConsent: false },
    });
    if (settled.count > 0) requiresConsent = false;
  }

  const updated = await prisma.workSkill.update({
    where: { id: skill.id, userId },
    data: {
      name: form.name,
      projectId: save.projectId,
      enabled: decision.enabled,
      // Off is off: a revoked or kept-off skill is not picked unasked either.
      ...(decision.enabled ? {} : { autoSelect: false }),
    },
  });
  if (decision.enabled) {
    await recordConsent(userId, ctx.actor, {
      skillId: updated.id,
      skillSlug: updated.slug,
      skillVersion: minted.version.version,
      decision: "approved",
      fingerprint,
    });
  }
  return {
    ok: true,
    outcome: "versioned",
    skill: clientSkill(updated),
    version: minted.version.version,
    reason: decision.reason,
    message: decision.reason ? TEACH_ENABLE_MESSAGES[decision.reason] : null,
    requiresConsent,
  };
}

/**
 * Revokes a skill: switched off and out of automatic selection in one write,
 * recorded as a withdrawn consent. Its versions stay, so the runs that used it
 * still resolve and switching it back on is the person's choice to make again.
 */
export async function revokeTaughtSkill(
  userId: string,
  skillId: string,
  actor: Actor = "web"
): Promise<ClientTaughtSkill | null> {
  const skill = await prisma.workSkill.findFirst({
    where: { id: skillId, userId, deletedAt: null, kind: "skill" },
    select: { id: true },
  });
  if (!skill) return null;
  const updated = await prisma.workSkill.update({
    where: { id: skill.id, userId },
    data: { enabled: false, autoSelect: false },
  });
  await recordConsent(userId, actor, {
    skillId: updated.id,
    skillSlug: updated.slug,
    skillVersion: updated.currentVersion,
    decision: "revoked",
  });
  return clientSkill(updated);
}

export async function loadTaughtSkillForEdit(userId: string, skillId: string): Promise<TaughtSkillForEdit | null> {
  const skill = await prisma.workSkill.findFirst({ where: { id: skillId, userId, deletedAt: null, kind: "skill" } });
  if (!skill) return null;
  const version: WorkSkillVersion | null = await prisma.workSkillVersion.findFirst({
    where: { skillId: skill.id, version: skill.currentVersion },
  });
  const contract = parseSkillContract(version?.contract);
  const requestedTools = parseRequestedTools(version?.requestedTools);
  const parsed = version ? parseTaughtInstructions(version.instructions) : null;
  return {
    skill: {
      ...clientSkill(skill),
      description: skill.description,
      trust: skill.trust,
      sourceId: skill.sourceId,
    },
    version: version
      ? {
          version: version.version,
          instructions: version.instructions,
          requestedTools,
          contract,
          requiresConsent: version.requiresConsent,
          consentFor: consentReasonsOf(version.securityScan),
        }
      : null,
    form: parsed
      ? {
          ...parsed,
          name: skill.name,
          tools: requestedTools,
          connectors: contract.requestedConnectors,
          domains: contract.requestedDomains,
        }
      : null,
    origin: taughtOrigin(contract.provenance),
  };
}

/** What the Teach page offers: where a skill can apply, and which apps it can name. */
export async function loadTeachContext(userId: string): Promise<{ projects: { id: string; name: string }[]; apps: TaughtApp[] }> {
  const [projects, apps] = await Promise.all([
    prisma.project.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true },
      take: 200,
    }),
    import("@/lib/chat/routine-tool").then(({ connectedAppsFor }) => connectedAppsFor(userId, [])).catch(() => []),
  ]);
  return { projects, apps };
}
