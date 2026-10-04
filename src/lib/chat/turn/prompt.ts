import "server-only";
import { legacyChatClientForOrigin } from "@/lib/chat-origin";
import { buildSemanticEditPrompt } from "@/lib/artifact-ops";
import { isSemanticArtifactType } from "@/lib/work/deliverables/semantic";
import { safeOutline } from "./semantic";
import { backgroundWorkHint, detectBackgroundWork } from "@/lib/chat/work-intent";
import { buildSystemPromptSections } from "@/lib/anthropic";
import { DEFAULT_PERSONALITY } from "@/lib/personalities";
import { buildArtifactEditPrompt, type ArtifactSourceForEdit } from "@/lib/artifact-edit";
import { appendSkillBlock, composeSystemPrompt } from "@/lib/chat/prompt-sections";
import { appendAgentBlock } from "@/lib/agents/prompt";
import type { RoomTurnSetup } from "@/lib/agents/room-store";
import type { ChatRequestBody } from "@/lib/chat/request";
import type { TurnSettings } from "./account";
import type { TurnMemory } from "./memory";
import type { TurnApprovals } from "./approvals";
import type { TurnSkill } from "./skills";
import { roomPromptBlock } from "./identity";
import type { TurnUser } from "./types";

/*
 * Pipeline — the saved turn's system prompt, composed from what the earlier
 * stages decided. Composition only: every section's content is owned by
 * src/lib/chat/system-prompt.ts and prompt-sections.ts.
 */

/**
 * A regenerate's one-shot steering ("more concise", "add details"), appended
 * to the system prompt for this generation only. Only honoured on a
 * regenerate so a stray field on a normal send cannot shape the answer; the
 * instruction is user-authored UI copy, not free text, but it is still fenced
 * as an instruction block so it cannot pose as content.
 */
export function withRegenerateInstruction(system: string, input: { regenerate?: boolean; regenerateInstruction?: string }): string {
  if (!input.regenerate || !input.regenerateInstruction) return system;
  return `${system}\n\n# Regeneration request\nThe user asked for this answer to be regenerated with the following adjustment: ${input.regenerateInstruction}`;
}

export function composeTurnSystem({
  user,
  input,
  settings,
  memory: { memoryEnabled, memoryProfile },
  canvasOn,
  promptContext,
  untrustedContentInTurn,
  taskToolOn,
  useWebSearch,
  useAlevrSearch,
  attachmentToolToggles,
  executionSections,
  artifactEditTarget,
  semanticArtifactSection,
  appliedSkill,
  agentContext,
  roomSetup,
  roomMessageId,
}: {
  user: TurnUser;
  input: ChatRequestBody;
  settings: TurnSettings;
  memory: TurnMemory;
  canvasOn: boolean;
  promptContext: string;
  untrustedContentInTurn: boolean;
  taskToolOn: boolean;
  useWebSearch: boolean;
  useAlevrSearch: boolean;
  attachmentToolToggles: { documents: boolean; code: boolean; images: boolean };
  executionSections: string[];
  artifactEditTarget: (ArtifactSourceForEdit & { id: string }) | null;
  /** This chat's workbooks, documents and decks as addressable outlines (semantic.ts). */
  semanticArtifactSection: string | null;
  appliedSkill: TurnSkill["appliedSkill"];
  agentContext: TurnApprovals["agentContext"];
  roomSetup: RoomTurnSetup | null;
  roomMessageId: string | null;
}) {
  const baseSystemSections = buildSystemPromptSections({
    userName: user.name,
    customInstructions: settings?.customInstructions ?? "",
    personality: settings?.personality ?? DEFAULT_PERSONALITY,
    responseLanguage: settings?.responseLanguage ?? "auto",
    // The ranked notes are per-question and ride the tail (route.ts turnTail);
    // the consolidated summary is stable and stays in the cached system tier.
    memories: [],
    memorySummary: memoryProfile.summary ?? undefined,
    memoryScope: memoryProfile.summaryScope,
    memoryEnabled,
    canvas: canvasOn,
    // Installed macOS/iOS builds cannot show semantic artifacts yet.
    semanticArtifacts: legacyChatClientForOrigin(input) === "web",
    voiceMode: input.voiceMode,
    projectContext: promptContext,
    untrustedContent: untrustedContentInTurn,
    taskHandoff: taskToolOn,
  });
  const baseSystem = baseSystemSections.variable
    ? `${baseSystemSections.stable}\n\n${baseSystemSections.variable}`
    : baseSystemSections.stable;
  const targetedArtifactEditPrompt =
    artifactEditTarget && input.artifactEdit
      ? isSemanticArtifactType(artifactEditTarget.type)
        ? buildSemanticEditPrompt(
            artifactEditTarget,
            input.artifactEdit,
            safeOutline(artifactEditTarget.type, artifactEditTarget.content, 16_000)
          )
        : buildArtifactEditPrompt(artifactEditTarget, input.artifactEdit)
      : null;
  // Work as an internal runtime (src/lib/chat/work-intent.ts): a message that
  // reads as a long multi-deliverable job gets one line telling the model so,
  // only when it can actually start a task this turn.
  const backgroundHint =
    taskToolOn && !input.regenerate ? backgroundWorkHint(detectBackgroundWork(input.message)) : null;
  const systemBase = withRegenerateInstruction(
    appendAgentBlock(
      appendSkillBlock(
        composeSystemPrompt({
          base: semanticArtifactSection ? `${baseSystem}\n\n${semanticArtifactSection}` : baseSystem,
          webSearch: useWebSearch && !useAlevrSearch,
          alevrSearch: useAlevrSearch,
          documentTool: attachmentToolToggles.documents,
          imageTool: attachmentToolToggles.images,
          codeTool: attachmentToolToggles.code,
          executionSections,
          targetedArtifactEditPrompt,
          canvasOn,
        }),
        appliedSkill
      ),
      agentContext?.block
        ? roomSetup
          ? `${agentContext.block}\n\n${roomPromptBlock(roomSetup, user.name, roomMessageId)}`
          : agentContext.block
        : null
    ),
    input
  );
  const system = backgroundHint ? `${systemBase}\n\n${backgroundHint}` : systemBase;
  return { baseSystemSections, system };
}
