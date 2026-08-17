/**
 * Juno Assistants Subsystem
 *
 * Productizes Work Skills into first-class user-facing AI Assistants (Gems/GPTs equivalent)
 * with dedicated system prompts, attached knowledge, configured toolsets, preferred models,
 * starter prompts, and permission constraints.
 */

import { prisma } from "@/lib/prisma";
import crypto from "node:crypto";
import type { ReasoningEffort } from "@/lib/model-metrics";

export interface JunoAssistantConfig {
  id: string;
  userId: string;
  slug: string;
  name: string;
  description: string;
  avatarIcon?: string;
  systemPrompt: string;
  starterPrompts: string[];
  attachedDocumentIds?: string[];
  attachedProjectIds?: string[];
  enabledConnectors?: string[];
  allowedTools?: string[];
  preferredModelId?: string;
  reasoningEffort?: ReasoningEffort;
  monthlyBudgetMicroUsd?: number;
  isPinned?: boolean;
  isPublic?: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssistantInput {
  name: string;
  description: string;
  avatarIcon?: string;
  systemPrompt: string;
  starterPrompts?: string[];
  attachedDocumentIds?: string[];
  attachedProjectIds?: string[];
  enabledConnectors?: string[];
  allowedTools?: string[];
  preferredModelId?: string;
  reasoningEffort?: ReasoningEffort;
}

/**
 * List all assistants owned by a user
 */
export async function listUserAssistants(userId: string): Promise<JunoAssistantConfig[]> {
  const skills = await prisma.workSkill.findMany({
    where: { userId, deletedAt: null },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
      },
    },
    orderBy: [{ updatedAt: "desc" }],
  });

  return skills.map((s) => {
    const latestVersion = s.versions[0];
    const contract = (latestVersion?.contract as Record<string, unknown>) || {};
    const requestedTools = Array.isArray(latestVersion?.requestedTools)
      ? (latestVersion.requestedTools as string[])
      : (Array.isArray(contract.allowedTools) ? (contract.allowedTools as string[]) : []);

    return {
      id: s.id,
      userId: s.userId,
      slug: s.slug,
      name: s.name,
      description: s.description || "",
      avatarIcon: (contract.icon as string) || "bot",
      systemPrompt: latestVersion?.instructions || "",
      starterPrompts: (contract.starterPrompts as string[]) || [],
      attachedDocumentIds: Array.isArray(contract.attachedDocumentIds) ? (contract.attachedDocumentIds as string[]) : [],
      attachedProjectIds: s.projectId ? [s.projectId] : (Array.isArray(contract.attachedProjectIds) ? (contract.attachedProjectIds as string[]) : []),
      enabledConnectors: Array.isArray(contract.enabledConnectors) ? (contract.enabledConnectors as string[]) : [],
      allowedTools: requestedTools,
      preferredModelId: (contract.preferredModelId as string) || undefined,
      reasoningEffort: (contract.reasoningEffort as ReasoningEffort) || undefined,
      isPinned: Boolean(contract.isPinned),
      isPublic: s.trust === "verified",
      version: s.currentVersion,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  });
}

/**
 * Get an assistant by ID with owner access verification
 */
export async function getAssistantById(id: string, userId: string): Promise<JunoAssistantConfig | null> {
  const skill = await prisma.workSkill.findFirst({
    where: {
      id,
      userId,
      deletedAt: null,
    },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });

  if (!skill) return null;

  const latestVersion = skill.versions[0];
  const contract = (latestVersion?.contract as Record<string, unknown>) || {};
  const requestedTools = Array.isArray(latestVersion?.requestedTools)
    ? (latestVersion.requestedTools as string[])
    : (Array.isArray(contract.allowedTools) ? (contract.allowedTools as string[]) : []);

  return {
    id: skill.id,
    userId: skill.userId,
    slug: skill.slug,
    name: skill.name,
    description: skill.description || "",
    avatarIcon: (contract.icon as string) || "bot",
    systemPrompt: latestVersion?.instructions || "",
    starterPrompts: (contract.starterPrompts as string[]) || [],
    attachedDocumentIds: Array.isArray(contract.attachedDocumentIds) ? (contract.attachedDocumentIds as string[]) : [],
    attachedProjectIds: skill.projectId ? [skill.projectId] : (Array.isArray(contract.attachedProjectIds) ? (contract.attachedProjectIds as string[]) : []),
    enabledConnectors: Array.isArray(contract.enabledConnectors) ? (contract.enabledConnectors as string[]) : [],
    allowedTools: requestedTools,
    preferredModelId: (contract.preferredModelId as string) || undefined,
    reasoningEffort: (contract.reasoningEffort as ReasoningEffort) || undefined,
    isPinned: Boolean(contract.isPinned),
    isPublic: skill.trust === "verified",
    version: skill.currentVersion,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

/**
 * Create a new Juno Assistant
 */
export async function createAssistant(input: CreateAssistantInput, userId: string): Promise<JunoAssistantConfig> {
  const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}-${crypto.randomBytes(3).toString("hex")}`;
  const contract = {
    icon: input.avatarIcon || "bot",
    starterPrompts: input.starterPrompts || [],
    attachedDocumentIds: input.attachedDocumentIds || [],
    attachedProjectIds: input.attachedProjectIds || [],
    enabledConnectors: input.enabledConnectors || [],
    allowedTools: input.allowedTools || [],
    preferredModelId: input.preferredModelId,
    reasoningEffort: input.reasoningEffort,
    isPinned: false,
  };

  const skill = await prisma.workSkill.create({
    data: {
      userId,
      slug,
      name: input.name,
      description: input.description,
      currentVersion: 1,
      enabled: true,
      trust: "user_authored",
      versions: {
        create: {
          version: 1,
          instructions: input.systemPrompt,
          contract,
          requestedTools: input.allowedTools || [],
        },
      },
    },
    include: {
      versions: true,
    },
  });

  return {
    id: skill.id,
    userId: skill.userId,
    slug: skill.slug,
    name: skill.name,
    description: skill.description || "",
    avatarIcon: input.avatarIcon || "bot",
    systemPrompt: input.systemPrompt,
    starterPrompts: input.starterPrompts || [],
    attachedDocumentIds: input.attachedDocumentIds || [],
    attachedProjectIds: input.attachedProjectIds || [],
    enabledConnectors: input.enabledConnectors || [],
    allowedTools: input.allowedTools || [],
    preferredModelId: input.preferredModelId,
    reasoningEffort: input.reasoningEffort,
    isPinned: false,
    isPublic: false,
    version: 1,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

/**
 * Update an existing Juno Assistant
 */
export async function updateAssistant(
  id: string,
  input: Partial<CreateAssistantInput> & { isPinned?: boolean },
  userId: string
): Promise<JunoAssistantConfig | null> {
  const existing = await prisma.workSkill.findFirst({
    where: { id, userId, deletedAt: null },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });

  if (!existing) return null;

  const currentVersion = existing.versions[0];
  const currentContract = (currentVersion?.contract as Record<string, unknown>) || {};
  const newContract = {
    ...currentContract,
    icon: input.avatarIcon ?? currentContract.icon,
    starterPrompts: input.starterPrompts ?? currentContract.starterPrompts,
    attachedDocumentIds: input.attachedDocumentIds ?? currentContract.attachedDocumentIds ?? [],
    attachedProjectIds: input.attachedProjectIds ?? currentContract.attachedProjectIds ?? [],
    enabledConnectors: input.enabledConnectors ?? currentContract.enabledConnectors ?? [],
    allowedTools: input.allowedTools ?? currentContract.allowedTools ?? [],
    preferredModelId: input.preferredModelId ?? currentContract.preferredModelId,
    reasoningEffort: input.reasoningEffort ?? currentContract.reasoningEffort,
    isPinned: input.isPinned ?? currentContract.isPinned,
  };

  const nextVersionNum = existing.currentVersion + 1;

  await prisma.workSkill.update({
    where: { id },
    data: {
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      currentVersion: nextVersionNum,
      versions: {
        create: {
          version: nextVersionNum,
          instructions: input.systemPrompt ?? currentVersion?.instructions ?? "",
          contract: newContract,
          requestedTools: input.allowedTools ?? (Array.isArray(currentVersion?.requestedTools) ? currentVersion.requestedTools : []),
        },
      },
    },
  });

  return getAssistantById(id, userId);
}

/**
 * Delete an assistant (soft delete)
 */
export async function deleteAssistant(id: string, userId: string): Promise<boolean> {
  const updated = await prisma.workSkill.updateMany({
    where: { id, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return updated.count > 0;
}
