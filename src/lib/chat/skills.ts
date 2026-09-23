/**
 * A skill applied to a chat turn.
 *
 * Skills were built for Work — a delegated run with a plan, a host and an
 * approval broker — and the whole apparatus served exactly one surface. A skill
 * is "instructions with a name", which is at least as useful in a chat turn as
 * in an errand, and this module is the adapter rather than a second
 * implementation: `selectSkillBySlug`, `resolveSkillPermissions` and
 * `skillSystemSuffix` are imported, not re-derived. A second copy of the
 * intersection is the precise mistake `work/skills.ts` opens by warning about.
 *
 * WHAT CHAT GRANTS. `chatSkillGrantLayer` is built from what THIS turn actually
 * has: the connectors attached to the conversation, whether web search is on
 * for this plan and model, whether canvas is available, whether the attachment
 * tools are attached. A skill asking for a shell — and every skill written for
 * Claude Code asks for a shell — is told it did not get one, rather than being
 * quietly run in an environment that cannot do what its instructions describe.
 *
 * ARMED, NEVER INFERRED. Nothing here reads a leading `/slug` out of a message.
 * The route takes an explicit slug, the composer puts one there when the reader
 * picks a skill out of the palette, and a message that merely begins with a
 * slash is a message that begins with a slash. The composer is where people
 * paste things, and a surface where pasted text can pick up a set of
 * instructions nobody chose is a surface worth not building.
 *
 * Pure. No `server-only`, no Prisma client, types only from `@prisma/client` —
 * the same discipline `work/skills.ts` keeps, so `tests/chat-skills.test.ts`
 * can drive every branch without a database.
 */

import {
  BROWSER_TOOL_ID,
  INSPECT_IMAGE_TOOL_ID,
  READ_DOCUMENT_TOOL_ID,
} from "@/lib/chat/tool-policy";
import {
  resolveSkillPermissions,
  selectSkillBySlug,
  skillRequestFrom,
  skillSystemSuffix,
  type ResolvedSkillPermissions,
  type SkillCandidate,
  type SkillSelectionRefusal,
  type WorkSkillContract,
  type WorkSkillGrantLayer,
} from "@/lib/work/skills";

/**
 * The tool names a chat turn can grant.
 *
 * Three of them are registry ids that `chatRuntimeToolAllowlist` already uses,
 * imported rather than re-spelled so a rename cannot leave a skill requesting a
 * tool by a name that no longer exists while the grant list uses the new one —
 * which would look exactly like a skill being correctly refused. The other two
 * are provider-side capabilities with no registry entry, named here because a
 * skill has to be able to ask for them by some name and there was none.
 */
export const CHAT_SKILL_TOOLS = {
  /** Provider-side search (Claude `web_search`, Gemini grounding, Grok Live). */
  webSearch: "web_search",
  /** The hosted page reader. Rides the same toggle as search. */
  browser: BROWSER_TOOL_ID,
  documents: READ_DOCUMENT_TOOL_ID,
  images: INSPECT_IMAGE_TOOL_ID,
  /** Writing an artifact into the side panel. */
  canvas: "canvas",
} as const;

/** What this turn is actually carrying, read off the route's own decisions. */
export interface ChatSkillCapabilities {
  /** `useWebSearch` — the toggle AND the plan AND the model AND the workspace. */
  webSearch: boolean;
  /** `canvasOn`. */
  canvas: boolean;
  /** `attachmentToolToggles.documents`. */
  documents: boolean;
  /** `attachmentToolToggles.images`. */
  images: boolean;
  /** Connector ids resolved for this turn — never the ones merely requested. */
  connectors: readonly string[];
}

/**
 * The single grant layer a chat turn contributes.
 *
 * ONE layer, not none. `narrowestGrant` refuses an empty list explicitly
 * because the intersection of no sets is everything, and a caller that had not
 * populated its layers yet would hand a skill the complete toolset. Passing
 * exactly one layer here is deliberate and is the whole grant: a chat turn has
 * no host and no project bundle beneath it, so what the user switched on IS the
 * ceiling.
 *
 * `apps` and `domains` are empty and stay empty. Chat has no app surface, and
 * web search is provider-side with no per-domain allowlist to intersect
 * against — so a skill asking to reach `example.com` is told it did not get it,
 * which is true, rather than being granted a domain Juno has no mechanism to
 * enforce.
 *
 * The policy is `conservative`, the narrowest in the vocabulary. A chat turn
 * grants no approval authority at all; there is nothing here for a skill
 * asking for `permissive` to be given.
 *
 * No `budget`: this layer sets no ceiling of its own, because a chat turn's
 * spending is governed by `checkBudget` and the reservation hold, neither of
 * which a skill can reach. Omitting it leaves the skill's own requested budget
 * standing, which nothing in chat reads — a number carried, not honoured.
 */
export function chatSkillGrantLayer(capabilities: ChatSkillCapabilities): WorkSkillGrantLayer {
  const tools: string[] = [];
  if (capabilities.webSearch) {
    tools.push(CHAT_SKILL_TOOLS.webSearch, CHAT_SKILL_TOOLS.browser);
  }
  if (capabilities.documents) tools.push(CHAT_SKILL_TOOLS.documents);
  if (capabilities.images) tools.push(CHAT_SKILL_TOOLS.images);
  if (capabilities.canvas) tools.push(CHAT_SKILL_TOOLS.canvas);
  return {
    tools,
    connectors: [...capabilities.connectors],
    apps: [],
    domains: [],
    policy: "conservative",
  };
}

/**
 * Why a chat turn did not apply the skill it was asked for.
 *
 * The Work refusals, plus three that only chat can produce. `blocked` is a skill
 * whose current version the scanner refused: Work reaches that state by
 * clamping `enabled` on write, which a later PATCH can undo, so chat checks the
 * version it is about to read rather than trusting a column written earlier.
 * `consent_required` is a version whose permission surface changed and has not
 * been re-approved — chat has no consent press, so it sends the reader to the
 * skill's page instead of silently running the older surface. `unscanned` is a
 * version with no verdict this build recognises: the loader scans a legacy
 * `pending` row before it gets here (as the Work runner does), so this is a
 * status written by something newer, and an unknown verdict is not a clear one.
 */
export type ChatSkillRefusal = SkillSelectionRefusal | "blocked" | "consent_required" | "unscanned";

export const CHAT_SKILL_REFUSAL_MESSAGES: Record<ChatSkillRefusal, string> = {
  unknown_slug: "That skill does not exist on this account.",
  // `disabled` is also a skill whose source is switched off: the candidate's
  // `enabled` is the pair, so the sentence names both switches.
  disabled: "That skill is switched off, or the source it came from is. Turn it back on in Skills to use it.",
  auto_select_disabled: "That skill is not set to be chosen automatically.",
  untrusted: "That skill has not been vouched for, so Juno will not reach for it on its own.",
  other_project: "That skill is filed in a different project.",
  low_confidence: "Juno was not confident enough that this skill fits.",
  ambiguous: "Two skills fit equally well, so Juno did not guess.",
  no_candidate: "There was no skill to apply.",
  blocked:
    "Juno's scanner refused this skill's current version, so it will not be applied to a message. Open the skill to see what it found.",
  consent_required:
    "This skill's current version asks for more than the one you approved. Open the skill and review what changed before using it.",
  unscanned: "Juno could not confirm this skill's current version is safe to use, so it was not applied. Open the skill to check it.",
};

/** The version a chat turn pinned, with the two columns that can refuse it. */
export interface ChatSkillVersionRow {
  version: number;
  instructions: string;
  contract: WorkSkillContract;
  requestedTools: readonly string[];
  securityStatus: string;
  requiresConsent: boolean;
}

export interface ChatSkillApplication {
  candidate: SkillCandidate;
  version: number;
  /** Appended to the system prompt for this generation only. */
  systemSuffix: string;
  /**
   * The instructions went inside the untrusted-content envelope.
   *
   * The caller MUST fold this into its own `untrustedContent` decision. Without
   * it the markers reach the model with no rule that reads them, which is
   * worse than not enveloping at all — it looks like a boundary and is not one
   * — and the turn would also stay eligible to write durable memory from text
   * Juno did not author.
   */
  untrusted: boolean;
  resolved: ResolvedSkillPermissions;
}

export type ChatSkillOutcome =
  | { applied: true; application: ChatSkillApplication }
  | { applied: false; reason: ChatSkillRefusal };

/** How many withheld names the model is shown before the list is summarised. */
const WITHHELD_NAMES_SHOWN = 6;

/**
 * How much of what the skill asked for it did not get.
 *
 * A number, for the audit log. The names are on the version row, which is
 * durable and joinable; copying them into a log with a multi-year retention
 * would store the same list twice and answer nothing the row does not.
 */
export function withheldCapabilityCount(resolved: ResolvedSkillPermissions): number {
  const { tools, connectors, apps, domains } = resolved.withheld;
  return tools.length + connectors.length + apps.length + domains.length;
}

function withheldSentence(resolved: ResolvedSkillPermissions): string | null {
  const groups: [string, string[]][] = [
    ["tools", resolved.withheld.tools],
    ["connectors", resolved.withheld.connectors],
    ["apps", resolved.withheld.apps],
    ["websites", resolved.withheld.domains],
  ];
  const parts = groups
    .filter(([, names]) => names.length > 0)
    .map(([label, names]) => {
      const shown = names.slice(0, WITHHELD_NAMES_SHOWN).join(", ");
      const rest = names.length - Math.min(names.length, WITHHELD_NAMES_SHOWN);
      return `${label}: ${shown}${rest > 0 ? ` and ${rest} more` : ""}`;
    });
  if (parts.length === 0) return null;
  return (
    `This skill asked for things this conversation does not have (${parts.join("; ")}). ` +
    `You do not have them and must not act as though you do. Many skills are written for an ` +
    `agent with a shell and a filesystem; this is a chat turn. Follow the parts of the method ` +
    `that apply here, do the rest yourself, and say plainly which steps you could not carry out.`
  );
}

/**
 * Applies a skill to a chat turn, or explains why it did not.
 *
 * Order matters and is not arbitrary. Selection comes first, because a slug
 * nobody has is not a security question. Then the version-level refusals,
 * because a blocked or unapproved version must not reach the prompt even though
 * the head row said `enabled`. Only then is the permission intersection run and
 * the block built — so nothing below the refusals can ever have produced text.
 *
 * `via` is always `"slash"`. Chat has no automatic selection (see
 * `docs/skills-audit.md` §4.3), and the provenance sentence
 * `skillSystemSuffix` writes turns on that distinction: telling the model the
 * user invoked a skill they never named is how a turn follows somebody else's
 * method and reports success.
 */
export function applyChatSkill(input: {
  slug: string;
  candidates: readonly SkillCandidate[];
  version: ChatSkillVersionRow | null;
  capabilities: ChatSkillCapabilities;
  wrapUntrusted: (label: string, content: string) => string;
}): ChatSkillOutcome {
  const selection = selectSkillBySlug(input.slug, input.candidates);
  if (!selection.selected) return { applied: false, reason: selection.reason };

  const row = input.version;
  // A head row pointing at a version that is not there is a skill that cannot
  // run. `unknown_slug` would be the wrong sentence — the skill exists — so it
  // is reported as the absence it is.
  if (!row) return { applied: false, reason: "no_candidate" };
  if (row.securityStatus === "blocked") return { applied: false, reason: "blocked" };
  if (row.securityStatus !== "clear" && row.securityStatus !== "warning") {
    return { applied: false, reason: "unscanned" };
  }
  if (row.requiresConsent) return { applied: false, reason: "consent_required" };

  const resolved = resolveSkillPermissions({
    request: skillRequestFrom({ contract: row.contract, requestedTools: [...row.requestedTools] }),
    granted: [chatSkillGrantLayer(input.capabilities)],
  });

  const block = skillSystemSuffix({
    slug: selection.candidate.slug,
    version: row.version,
    trust: selection.candidate.trust,
    via: "slash",
    instructions: row.instructions,
    wrapUntrusted: input.wrapUntrusted,
  });

  const note = withheldSentence(resolved);
  return {
    applied: true,
    application: {
      candidate: selection.candidate,
      version: row.version,
      // The note goes AFTER the envelope, never inside it. It is Juno speaking
      // about the skill, and text inside the markers is by construction not an
      // instruction — a caveat written there would be one the model is told to
      // disregard.
      systemSuffix: note ? `${block.systemSuffix}\n\n${note}` : block.systemSuffix,
      untrusted: block.untrusted,
      resolved,
    },
  };
}

/**
 * The runtime tools a turn may carry once a skill has narrowed them.
 *
 * NARROWED, and only ever narrowed: the result is `allowlist` filtered by what
 * the skill asked for, so a tool the turn did not already have cannot appear
 * here however the skill declares it. A skill that requests NO tools does not
 * narrow anything — an empty `requestedTools` is the overwhelmingly common
 * shape (the field is experimental in the spec and most authors omit it), and
 * reading it as "this skill wants nothing" would silently strip web search from
 * every turn that invoked one.
 *
 * That reading differs from `resolveSkillPermissions`, where an empty request
 * resolves to nothing, and the difference is deliberate: there the question is
 * "what may this skill use", and the safe default is nothing. Here the question
 * is "what may the TURN use", and the turn's own answer is already the user's.
 * A skill is not a way to take capabilities away from a conversation the reader
 * configured.
 */
export function narrowRuntimeToolsForSkill(
  allowlist: readonly string[],
  application: ChatSkillApplication | null
): string[] {
  if (!application) return [...allowlist];
  const requested = new Set([
    ...application.resolved.tools,
    ...application.resolved.withheld.tools,
  ]);
  if (requested.size === 0) return [...allowlist];
  return allowlist.filter((tool) => requested.has(tool));
}
