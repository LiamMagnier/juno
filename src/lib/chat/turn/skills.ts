import "server-only";
import { recordWorkAudit } from "@/lib/work/audit";
import { loadChatSkill } from "@/lib/chat/skill-runtime";
import { withheldCapabilityCount } from "@/lib/chat/skills";
import type { ChatRequestBody } from "@/lib/chat/request";
import type { TurnContext } from "@/lib/chat/context-resolution";
import { skillSettlement } from "./context";

/*
 * Pipeline stage — resolveSkills: the skill this message was sent under,
 * granted only what this turn actually has, and its audit row.
 */
export async function resolveSkills({
  userId,
  input,
  turnSkillSlug,
  projectId,
  grant,
  turnContext,
  durableGenerationId,
}: {
  userId: string;
  input: ChatRequestBody;
  turnSkillSlug: string | undefined;
  projectId: string | null;
  grant: { webSearch: boolean; canvas: boolean; documents: boolean; images: boolean; connectors: string[] };
  turnContext: TurnContext;
  durableGenerationId: string | null;
}) {
  /*
   * ── The skill this message was sent under ─────────────────────────────────
   *
   * Resolved before the system prompt is built, because whether it was
   * enveloped decides `untrustedContentInTurn` below, and that in turn decides
   * both whether the untrusted-content rule is in the prompt and whether this
   * turn may write durable memory. Neither is a special case for skills — an
   * imported skill is outside content like a fetched page or a connector
   * result, and it reaches the model through the same envelope.
   *
   * The grant handed to it is what this turn actually has, computed from the
   * decisions immediately above rather than from the request: a skill asking
   * for web search on a turn where the plan, the model or the workspace said no
   * is told it did not get it.
   *
   * A refusal is not an error. The message still has to be answered, so a skill
   * that is switched off, blocked by the scanner or awaiting consent simply
   * does not apply and the reason is recorded — the composer already showed the
   * reader which skill was armed, and failing the generation would charge them
   * for a sentence they never got.
   */
  const skillOutcome = turnSkillSlug
    ? await loadChatSkill({
        userId: userId,
        slug: turnSkillSlug,
        projectId,
        capabilities: grant,
      })
    : null;
  const appliedSkill = skillOutcome?.applied ? skillOutcome.application : null;
  turnContext.settleSkill(skillSettlement(skillOutcome));
  if (skillOutcome) {
    /*
     * Logged, not awaited.
     *
     * `recordWorkAudit` never throws and this is the security log rather than
     * the transcript, so nothing downstream depends on the write — awaiting it
     * would put a database round trip in front of the first token for a row
     * nobody reads until something has gone wrong.
     *
     * `untrusted` is the fact that cannot be recovered afterwards:
     * `WorkSkill.trust` is a column the user can change, so reading it back
     * later would rewrite the history of every turn that used the skill. Which
     * VERSION ran is recorded for the same reason — the instructions are
     * editable and the row is not.
     *
     * The private branch deliberately writes nothing here. A slug is not
     * content, but private mode's promise is that the turn leaves no trace, and
     * a row saying which skill ran and when is a trace.
     */
    void recordWorkAudit({
      userId: userId,
      kind: "skill_applied",
      // From the precise origin, never from the `client: web | app` billing
      // tag — that tag cannot tell a Mac from a phone, and an audit row is the
      // wrong place to guess. Windows has no value in `WORK_ACTORS` and is not
      // given one here: the vocabulary is mirrored to the native clients
      // through `contracts/work/juno-work-v1.json`, so inventing a member would
      // be a contract change smuggled in as a log line.
      actor:
        input.origin === "main_ios"
          ? "ios"
          : input.origin === "main_macos" || input.origin === "quick_macos"
            ? "macos"
            : "web",
      severity: skillOutcome.applied ? "info" : "warning",
      detail: skillOutcome.applied
        ? {
            skillId: skillOutcome.application.candidate.id,
            skillSlug: skillOutcome.application.candidate.slug,
            skillVersion: skillOutcome.application.version,
            untrusted: skillOutcome.application.untrusted,
            withheldCount: withheldCapabilityCount(skillOutcome.application.resolved),
            generationId: durableGenerationId ?? input.generationId ?? undefined,
          }
        : { skillSlug: turnSkillSlug, outcome: skillOutcome.reason },
    });
  }
  return { skillOutcome, appliedSkill };
}

export type TurnSkill = Awaited<ReturnType<typeof resolveSkills>>;
