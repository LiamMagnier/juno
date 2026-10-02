/**
 * The skill lane's `ToolProvider` (`src/lib/tools/types.ts`): contributes
 * `use_skill` and `read_skill_file` to a chat (or voice-mode) turn.
 *
 * The entitlement rows decide WHETHER a turn may carry them (not private, not
 * lockdown, a model with verified tool calling); this provider says whether it
 * CAN (the person has a skill to offer, or armed one) and builds the specs over
 * one `SkillToolSession` per turn. `promptSection` is the short list of skills
 * on offer; `close()` drops the turn's sandbox mounts.
 *
 * `codeExecution(turn)` must say whether `run_code` is on this turn. The
 * provider cannot see the execution lane's grant, and the sentence the model is
 * given about a skill's scripts ("run them with run_code" or "they cannot run
 * here") has to be true. Mounting itself is harmless either way: a mount is
 * read only by a `run_code` call.
 */

import "server-only";

import { prisma } from "@/lib/prisma";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { WorkActor } from "@/lib/work/domain";
import { AVAILABLE_SKILL_WHERE } from "@/lib/skills/sources";
import { openSkillToolSession } from "@/lib/skills/session";
import { DEFAULT_SKILL_DISCOVERY_POLICY, type SkillDiscoveryPolicy } from "@/lib/skills/workflow";
import { createUseSkillSpec } from "@/lib/tools/specs/use-skill";
import { createReadSkillFileSpec } from "@/lib/tools/specs/read-skill-file";
import {
  READ_SKILL_FILE_TOOL_ID,
  USE_SKILL_TOOL_ID,
  type ToolProvider,
  type ToolSpec,
  type ToolTurn,
} from "@/lib/tools/types";

export const SKILL_TOOL_IDS: readonly string[] = Object.freeze([USE_SKILL_TOOL_ID, READ_SKILL_FILE_TOOL_ID]);

export interface SkillsToolProviderOptions {
  /** Whether `run_code` is on this turn. */
  codeExecution(turn: ToolTurn): boolean | Promise<boolean>;
  /** Who is acting, for the audit log. Defaults to `web` (chat and voice), `cloud_runner` (work). */
  actorFor?(turn: ToolTurn): WorkActor;
  /** Design §9.3. Off by default: only skills opted in to automatic use are offered. */
  policy?: SkillDiscoveryPolicy;
}

/**
 * Whether the person has anything for the model to load: an armed skill, or an
 * available skill discovery would offer. One indexed count, so the provider
 * stays cheap on the many turns that have none.
 */
async function hasSomethingToOffer(turn: ToolTurn, policy: SkillDiscoveryPolicy): Promise<boolean> {
  if (turn.skillSlug) return true;
  const count = await prisma.workSkill.count({
    where: {
      userId: turn.userId,
      deletedAt: null,
      kind: "skill",
      securityStatus: { in: ["clear", "warning"] },
      ...(policy.includeUserAuthored
        ? { trust: { in: ["user_authored", "verified"] } }
        : { autoSelect: true, trust: { in: ["user_authored", "verified"] } }),
      AND: [
        AVAILABLE_SKILL_WHERE,
        turn.projectId === null ? { projectId: null } : { OR: [{ projectId: null }, { projectId: turn.projectId }] },
      ],
    },
    take: 1,
  });
  return count > 0;
}

export function createSkillsToolProvider(options: SkillsToolProviderOptions): ToolProvider {
  const policy = options.policy ?? DEFAULT_SKILL_DISCOVERY_POLICY;
  return {
    id: "skills",
    tools: SKILL_TOOL_IDS,
    async availability(turn) {
      try {
        return (await hasSomethingToOffer(turn, policy))
          ? { available: true }
          : { available: false, reason: "nothing_to_offer" };
      } catch {
        return { available: false, reason: "unhealthy" };
      }
    },
    async open(turn, granted) {
      const wanted = new Set(granted);
      const code = await options.codeExecution(turn);
      const session = await openSkillToolSession({
        userId: turn.userId,
        surface: turn.surface,
        sessionId: turn.sessionId,
        projectId: turn.projectId,
        armedSlug: turn.skillSlug,
        code,
        skillFiles: wanted.has(READ_SKILL_FILE_TOOL_ID),
        policy,
        wrapUntrusted,
        actor: options.actorFor?.(turn) ?? (turn.surface === "work" ? "cloud_runner" : "web"),
        generationId: turn.sessionId,
      });
      const specs: ToolSpec[] = [];
      // use_skill only when there is something to load by name; an armed skill
      // alone needs read_skill_file and nothing else.
      if (wanted.has(USE_SKILL_TOOL_ID) && session.offered.length > 0) {
        specs.push(createUseSkillSpec(session));
      }
      if (wanted.has(READ_SKILL_FILE_TOOL_ID) && (session.offered.length > 0 || session.armed?.version.bundle)) {
        specs.push(createReadSkillFileSpec(session));
      }
      return {
        specs,
        promptSection: specs.length > 0 ? session.promptSection : undefined,
        close: () => session.close(),
      };
    },
  };
}
