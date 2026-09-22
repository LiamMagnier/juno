/**
 * Creating a skill and its first version — once, for every route that does it.
 *
 * `POST /api/work/skills` had this inline, and the GitHub importer needs the
 * same thing for each skill it brings in. Copying it would have meant two
 * implementations of the rules that matter most and are easiest to get subtly
 * wrong: that trust is DERIVED from origin and never read from the request,
 * that `autoSelect` is clamped against trust rather than stored as asked, that
 * a scanner verdict of `blocked` lands the skill switched off, and that the
 * head row and version 1 are written in one transaction so a skill can never
 * exist pointing at a version that does not.
 *
 * The drift those copies produce is not hypothetical and is not loud: an
 * importer that forgot the `autoSelect` clamp writes a row saying
 * `autoSelect: true, trust: "untrusted"`, which every reader then has to
 * resolve for itself — and the one that resolves it the other way is the one
 * that matters.
 *
 * `server-only`: this writes to the database. The pure parts a test needs live
 * in `work/skills.ts` and `skills/skill-md.ts`.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { recordWorkAudit } from "@/lib/work/audit";
import { scanSkillVersion } from "@/lib/work/skill-security";
import {
  SKILL_CONTRACT_VERSION,
  emptySkillContract,
  skillContractToJson,
  trustForOrigin,
  trustPermitsAutoSelection,
  type WorkSkillContract,
  type WorkSkillOrigin,
} from "@/lib/work/skills";

export interface CreateSkillInput {
  userId: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  projectId?: string | null;
  contract?: WorkSkillContract;
  requestedTools?: string[];
  /** Decides the starting trust. Never taken from a request body. */
  origin: WorkSkillOrigin;
  autoSelect?: boolean;
  /** Which surface asked, for the audit log. */
  actor?: "web" | "macos" | "ios";
}

export type CreateSkillResult =
  | {
      ok: true;
      skill: Prisma.WorkSkillGetPayload<Record<string, never>>;
      version: Prisma.WorkSkillVersionGetPayload<Record<string, never>>;
      /** The skill was created switched off because the scanner refused it. */
      blocked: boolean;
    }
  | { ok: false; reason: "slug_taken"; slug: string };

/**
 * Writes one skill and its version 1.
 *
 * Returns a refusal rather than throwing on the one failure a caller is
 * expected to handle: `(userId, slug)` is unique and a slug is frequently
 * derived from a name, so two skills called "Tidy Downloads" — or two
 * repositories both shipping `pdf` — collide without anybody having typed a
 * slug. An importer bringing twelve skills needs that per skill, not as a
 * failed request.
 */
export async function createSkillWithFirstVersion(
  input: CreateSkillInput
): Promise<CreateSkillResult> {
  const contract = input.contract ?? emptySkillContract();
  const requestedTools = input.requestedTools ?? [];
  const trust = trustForOrigin(input.origin);

  const securityScan = scanSkillVersion({
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    requestedTools,
    contract,
  });
  const permissionDigest = createHash("sha256").update(securityScan.permissionFingerprint).digest("hex");

  try {
    const created = await prisma.$transaction(async (tx) => {
      const skill = await tx.workSkill.create({
        data: {
          userId: input.userId,
          projectId: input.projectId ?? null,
          slug: input.slug,
          name: input.name,
          description: input.description,
          currentVersion: 1,
          enabled: securityScan.status !== "blocked",
          trust,
          securityStatus: securityScan.status,
          securityUpdatedAt: new Date(),
          autoSelect: (input.autoSelect ?? false) && trustPermitsAutoSelection(trust),
        },
      });
      const version = await tx.workSkillVersion.create({
        data: {
          skillId: skill.id,
          version: 1,
          instructions: input.instructions,
          contract: skillContractToJson(contract),
          contractVersion: SKILL_CONTRACT_VERSION,
          requestedTools,
          securityStatus: securityScan.status,
          securityScan: securityScan as unknown as Prisma.InputJsonValue,
          permissionDigest,
          requiresConsent: false,
        },
      });
      return { skill, version };
    });

    await recordWorkAudit({
      userId: input.userId,
      kind: "skill_security_scanned",
      actor: input.actor ?? "web",
      severity:
        securityScan.status === "blocked" ? "refusal" : securityScan.status === "warning" ? "warning" : "info",
      detail: {
        skillId: created.skill.id,
        skillSlug: created.skill.slug,
        skillVersion: created.version.version,
        scanStatus: securityScan.status,
        findingCount: securityScan.findings.length,
      },
    });

    return {
      ok: true,
      skill: created.skill,
      version: created.version,
      blocked: securityScan.status === "blocked",
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, reason: "slug_taken", slug: input.slug };
    }
    throw err;
  }
}
