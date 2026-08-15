import { z } from "zod";
import { workspaceConfigSchema } from "@/lib/projects/workspace-config";

/*
 * The native mutation union — request shapes only, no server imports, so the
 * hermetic test suite can exercise the contract without a database. Execution
 * semantics live in src/app/api/v1/mutations/route.ts; the operation type
 * list is mirrored in contracts/openapi/juno-native-v1.yaml.
 */

export const mutationOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("conversation.create"),
    clientEntityId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    // Which surface owns the conversation ("chat" default) — the app creates
    // kind:"code" sessions for Juno Code transcripts.
    kind: z.enum(["chat", "code"]).optional(),
    model: z.string().min(1).max(200).optional(),
    projectId: z.string().min(1).max(200).optional(),
  }).strict(),
  z.object({ type: z.literal("conversation.rename"), entityId: z.string().min(1).max(200), title: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal("conversation.update"), entityId: z.string().min(1).max(200), patch: z.object({
    title: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    projectId: z.string().min(1).max(200).nullable().optional(), folderId: z.string().min(1).max(200).nullable().optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal("conversation.archive"), entityId: z.string().min(1).max(200), archived: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal("conversation.delete"), entityId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("folder.create"), clientEntityId: z.string().uuid().optional(), name: z.string().trim().min(1).max(60) }).strict(),
  z.object({ type: z.literal("folder.rename"), entityId: z.string().min(1).max(200), name: z.string().trim().min(1).max(60) }).strict(),
  z.object({ type: z.literal("folder.delete"), entityId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("project.create"), clientEntityId: z.string().uuid().optional(), name: z.string().trim().min(1).max(160), instructions: z.string().default("") }).strict(),
  z.object({
    type: z.literal("project.update"),
    entityId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(160).optional(),
    instructions: z.string().optional(),
    starred: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("project.delete"), entityId: z.string().min(1).max(200) }).strict(),
  // Custom-assistant config for one project. UPSERT rather than create/update,
  // for the reason `settings.update` is an upsert: the client keys this by
  // PROJECT, not by the workspace row's id, and the row may not exist yet on
  // the first save. Making the client create-then-update would mean it had to
  // learn a server-assigned id before it could ever write, and a device that
  // configured a workspace offline would have nothing to send.
  //
  // `config` REPLACES the stored object wholesale — it is not a patch. A patch
  // would need a way to say "remove the allowedTools key", and JSON's only
  // spelling for that is null, which is already taken by a different meaning in
  // half the fields. Whole-object replacement keeps "absent" expressible.
  z.object({
    type: z.literal("project_workspace.upsert"),
    projectId: z.string().min(1).max(200),
    config: workspaceConfigSchema,
  }).strict(),
  z.object({ type: z.literal("project_workspace.delete"), entityId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("memory.create"), clientEntityId: z.string().uuid().optional(), content: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal("memory.update"), entityId: z.string().min(1).max(200), content: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal("memory.delete"), entityId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("settings.update"), patch: z.object({
    theme: z.enum(["LIGHT", "DARK", "SYSTEM"]).optional(), accent: z.string().min(1).max(40).optional(),
    defaultModel: z.string().min(1).max(200).optional(), customInstructions: z.string().optional(),
    responseLanguage: z.string().min(1).max(80).optional(), uiLocale: z.string().min(1).max(40).optional(),
    personality: z.string().min(1).max(80).optional(), memoryEnabled: z.boolean().optional(),
    voiceId: z.string().max(200).nullable().optional(), favoriteModels: z.array(z.string().max(200)).max(100).optional(),
    emailBudgetAlerts: z.boolean().optional(), emailWeeklyDigest: z.boolean().optional(),
  }).strict() }).strict(),
]);

export const mutationRequestSchema = z.object({
  clientMutationId: z.string().uuid(),
  baseRevision: z.number().int().min(0),
  operation: mutationOperationSchema,
}).strict();

export type MutationOperation = z.infer<typeof mutationOperationSchema>;
