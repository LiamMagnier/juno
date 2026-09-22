/**
 * Loading the skill a chat turn asked for.
 *
 * The database half of `@/lib/chat/skills`, kept apart from it so that module
 * stays pure and testable: every rule about what a skill may do lives there,
 * and this file only fetches the two rows those rules are applied to.
 *
 * TWO ROWS, PINNED. The head row says which version is current; the version row
 * carries the instructions, the declarations and the two columns that can
 * refuse it. They are read in one query and the version number travels with the
 * result, so "which skill ran on this message" has an answer that survives the
 * skill being edited afterwards — the same property a Work run gets from
 * recording its version, and the reason a chat turn should not simply follow
 * `currentVersion` at read time.
 *
 * FAILS CLOSED AND QUIETLY. Every refusal is a reason, never an exception: a
 * chat turn whose skill could not be applied still has a message to answer, and
 * throwing here would turn "that skill is switched off" into a failed
 * generation the user has already been charged for.
 */

import "server-only";
import { prisma } from "@/lib/prisma";
import { wrapUntrusted } from "@/lib/untrusted-content";
import { applyChatSkill, type ChatSkillCapabilities, type ChatSkillOutcome } from "@/lib/chat/skills";
import { skillIsAvailable } from "@/lib/skills/library-contract";
import { scanSkillVersion } from "@/lib/work/skill-security";
import { parseRequestedTools, parseSkillContract, type SkillCandidate } from "@/lib/work/skills";

/**
 * Resolves a slug against this user's library and applies it to the turn.
 *
 * A single-row lookup rather than the whole library, then a one-element
 * candidate list handed to `selectSkillBySlug`. The indirection is deliberate:
 * the refusal vocabulary — `unknown_slug` versus `disabled` — is decided by
 * that function for every surface, and a route that mapped "no row" to its own
 * sentence would be a second place where the two came apart.
 *
 * `deletedAt: null` is part of the lookup and not a filter afterwards. A
 * soft-deleted skill's rows survive because a run from last month references
 * one of its versions; invoking it by name should say it does not exist,
 * because to the user it does not. `kind: "skill"` likewise: an assistant
 * shares the table and its slug, and is not something a slash invokes.
 *
 * A skill whose source is switched off reaches `selectSkillBySlug` as
 * disabled, so it is refused with the same reason as its own switch.
 */
export async function loadChatSkill(input: {
  userId: string;
  slug: string;
  /** The conversation this turn belongs to, or null — decides nothing here. */
  projectId?: string | null;
  capabilities: ChatSkillCapabilities;
}): Promise<ChatSkillOutcome> {
  const row = await prisma.workSkill.findFirst({
    where: { userId: input.userId, slug: input.slug, deletedAt: null, kind: "skill" },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      enabled: true,
      trust: true,
      autoSelect: true,
      currentVersion: true,
      projectId: true,
      sourceId: true,
      source: { select: { enabled: true } },
    },
  });
  if (!row) {
    return applyChatSkill({
      slug: input.slug,
      candidates: [],
      version: null,
      capabilities: input.capabilities,
      wrapUntrusted,
    });
  }

  const candidate: SkillCandidate = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    enabled: skillIsAvailable(row, row.source),
    trust: row.trust,
    autoSelect: row.autoSelect,
    currentVersion: row.currentVersion,
    projectId: row.projectId,
  };

  // The version is read only once the head row exists, so a disabled skill
  // costs one query rather than two. `selectSkillBySlug` will refuse it below
  // either way; this just does not pay for the refusal twice.
  const version = candidate.enabled
    ? await prisma.workSkillVersion.findUnique({
        where: { skillId_version: { skillId: row.id, version: row.currentVersion } },
        select: {
          version: true,
          instructions: true,
          contract: true,
          requestedTools: true,
          securityStatus: true,
          requiresConsent: true,
        },
      })
    : null;

  const contract = version ? parseSkillContract(version.contract) : null;
  const requestedTools = version ? parseRequestedTools(version.requestedTools) : [];

  // A version from before the scanner existed still reads `pending`. It is
  // scanned here, as the Work runner scans it at its own boundary, rather than
  // either refused (every such skill would stop working in chat) or let
  // through unread (which is what used to happen). The verdict is not written
  // back: this runs in private mode too, which leaves no trace, and the runner
  // or the next edit persists it.
  const securityStatus =
    version && contract && version.securityStatus === "pending"
      ? scanSkillVersion({
          name: row.name,
          description: row.description,
          instructions: version.instructions,
          requestedTools,
          contract,
        }).status
      : version?.securityStatus;

  return applyChatSkill({
    slug: input.slug,
    candidates: [candidate],
    version:
      version && contract && securityStatus
        ? {
            version: version.version,
            instructions: version.instructions,
            contract,
            requestedTools,
            securityStatus,
            requiresConsent: version.requiresConsent,
          }
        : null,
    capabilities: input.capabilities,
    wrapUntrusted,
  });
}
