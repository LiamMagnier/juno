import "server-only";
import { getMemoryProfile } from "@/lib/memory";
import { workspacePermits, type WorkspaceConfig } from "@/lib/projects/workspace-config";
import type { TurnSettings } from "./account";

/*
 * Pipeline stage — resolveMemory: whether this turn may recall memory (the
 * user's setting AND the project assistant's permission), and which entries.
 * The selection is ranked against what the user just asked, scoped to the
 * conversation's project and cut to a token budget; `used` names them, which
 * is what the memory receipt reports.
 */
export async function resolveMemory({
  userId,
  settings,
  workspaceConfig,
  projectId,
  latestUserMessage,
}: {
  userId: string;
  settings: TurnSettings;
  workspaceConfig: WorkspaceConfig;
  projectId: string | null;
  latestUserMessage: string | undefined;
}) {
  const memoryEnabled = (settings?.memoryEnabled ?? true)
    && workspacePermits(workspaceConfig, "memoryRecall");
  // The consolidated summary carries settled account-wide memory; `recent` is
  // the individually-selected entries on top of it — ranked against what the
  // user just asked, scoped to this conversation's project, and cut to a token
  // budget. `used` names them, which is what the memory receipt below reports.
  const memoryProfile = memoryEnabled
    ? await getMemoryProfile(userId, { projectId, query: latestUserMessage })
    : { summary: null, summaryScope: "account" as const, recent: [], used: [], usedTokens: 0, droppedForBudget: 0 };
  return { memoryEnabled, memoryProfile };
}

export type TurnMemory = Awaited<ReturnType<typeof resolveMemory>>;
