/**
 * What turns a project into a *custom assistant*, and the one distinction the
 * whole shape exists to protect.
 *
 * A project already has a name, instructions, files and conversations, and all
 * of those sync. This is the part that did not: the persona name shown instead
 * of the project's, which tools the assistant may reach for, which of the
 * project's files are knowledge rather than chat debris, and which model it
 * prefers. It lived only in the native client's local store, so a whitelist set
 * on the Mac never reached the phone.
 *
 * ABSENT IS NOT EMPTY. That is the rule this module exists to enforce, and it
 * is three-valued in three places:
 *
 *   - `allowedTools` absent  → inherit whatever the account allows
 *   - `allowedTools: []`     → this assistant may reach for NOTHING
 *   - `allowedTools: [a, b]` → exactly these
 *
 * The same for `allowedConnectorIds`, and for `instructionsOverride` where an
 * absent value means "use the project's own instructions" and `""` means "this
 * assistant deliberately has none". Collapse absent into empty and an assistant
 * that was inheriting the account's tools silently loses all of them; collapse
 * empty into absent and a deliberately locked-down assistant silently regains
 * them. Both directions are security-relevant and neither is visible in a UI.
 *
 * So: every field is optional, `undefined` means "no opinion", and the parser
 * NEVER substitutes a default for a missing key. `writeWorkspaceConfig` omits
 * keys rather than writing nulls, so the stored JSON says only what was
 * actually decided.
 *
 * Deliberately free of `server-only` and Prisma — it is a codec, and it is
 * tested as one.
 */

import { z } from "zod";

/** The current shape of `ProjectWorkspace.config`. */
export const WORKSPACE_CONFIG_VERSION = 1;

/**
 * A capability a workspace may or may not be allowed to reach for.
 *
 * Mirrors `ProjectWorkspaceTool` in the native client
 * (JunoChatKit/ProjectWorkspaceStore.swift). The list is closed on purpose: a
 * name with no client field behind it is a checkbox that does nothing, which is
 * worse than an absent one. Unknown names arriving from a NEWER client are
 * dropped on read rather than rejected — see `parseWorkspaceConfig`.
 */
export const WORKSPACE_TOOLS = [
  "webSearch",
  "deepResearch",
  "canvas",
  "mediaGeneration",
  "connectors",
  "memoryRecall",
] as const;

export type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number];

const TOOLS = new Set<string>(WORKSPACE_TOOLS);

/** Matches the native client's own ceilings so a round trip cannot truncate. */
export const MAX_PERSONA_NAME_CHARACTERS = 160;
export const MAX_INSTRUCTIONS_CHARACTERS = 200_000;
export const MAX_KNOWLEDGE_FILES = 64;
export const MAX_CONNECTOR_IDS = 200;

export interface WorkspaceConfig {
  /** Shown instead of the project's name. Absent → show the project's name. */
  personaName?: string;
  /**
   * Replaces the project's `instructions` for this assistant.
   *
   * Absent → use the project's own. `""` → this assistant has none, which is a
   * real instruction and not the same as "not configured".
   */
  instructionsOverride?: string;
  /**
   * Absent → inherit the account's tools. `[]` → reach for nothing.
   * Order is not meaningful; stored sorted so an unchanged config serialises
   * byte-identically twice and does not churn the entity's revision.
   */
  allowedTools?: WorkspaceTool[];
  /** Absent → the account's connectors. `[]` → reach none. Sorted, as above. */
  allowedConnectorIds?: string[];
  /**
   * Which of the project's files are knowledge for the model. ORDER IS
   * MEANINGFUL here (it is the order they are laid into context), so this one
   * is not sorted. Absent and `[]` both mean "no knowledge files", and unlike
   * the lists above that is not a distinction anything acts on — but absent is
   * still written as absent rather than normalised to `[]`, because writing a
   * value nobody set is how a config starts asserting things.
   */
  knowledgeFileIds?: string[];
  /** Canonical "provider:model". Absent → the account default. */
  preferredModelId?: string;
}

/**
 * The write shape, validated at the mutation boundary.
 *
 * `.strict()` for the same reason the rest of the mutation union is strict: a
 * field name the server does not know is a client bug or a version skew, and
 * accepting it silently stores something no reader will ever look at while the
 * user believes it took effect.
 *
 * Note what is NOT here: `.default()` on anything. A Zod default would
 * manufacture exactly the "empty means configured" state this module exists to
 * prevent.
 */
export const workspaceConfigSchema = z
  .object({
    personaName: z.string().trim().min(1).max(MAX_PERSONA_NAME_CHARACTERS).optional(),
    instructionsOverride: z.string().max(MAX_INSTRUCTIONS_CHARACTERS).optional(),
    allowedTools: z.array(z.enum(WORKSPACE_TOOLS)).max(WORKSPACE_TOOLS.length).optional(),
    allowedConnectorIds: z.array(z.string().min(1).max(200)).max(MAX_CONNECTOR_IDS).optional(),
    knowledgeFileIds: z.array(z.string().min(1).max(200)).max(MAX_KNOWLEDGE_FILES).optional(),
    preferredModelId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * Reads a stored payload, discarding anything it does not recognise.
 *
 * Discarding rather than rejecting, exactly like `parseWorkDefaults`: a
 * workspace written by a newer build carries fields this one has never heard
 * of, and refusing the whole payload would drop a user's entire assistant
 * configuration because one key was unfamiliar. `configVersion` rides alongside
 * in the column so a reader can still tell "older shape" from "corrupt".
 *
 * An unknown TOOL NAME is dropped WITHOUT discarding the restriction it was
 * part of: `["webSearch", "timeTravel"]` reads back as `["webSearch"]`, not as
 * "inherits everything". Upgrading, configuring, then downgrading must not
 * quietly widen an assistant's access — dropping the whole key would do exactly
 * that, and it is the mistake the native store already has a test against.
 */
export function parseWorkspaceConfig(raw: unknown): WorkspaceConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: WorkspaceConfig = {};

  if (typeof source.personaName === "string" && source.personaName.trim()) {
    out.personaName = source.personaName.trim().slice(0, MAX_PERSONA_NAME_CHARACTERS);
  }
  // No emptiness check: "" is a real override meaning "no instructions".
  if (typeof source.instructionsOverride === "string") {
    out.instructionsOverride = source.instructionsOverride.slice(0, MAX_INSTRUCTIONS_CHARACTERS);
  }
  if (Array.isArray(source.allowedTools)) {
    // `[]` survives as `[]`. Only a non-array (or a missing key) reads as "no
    // opinion", which is the difference between "allowed nothing" and
    // "inherits the account's tools".
    out.allowedTools = sortedUnique(
      source.allowedTools.filter((tool): tool is WorkspaceTool => typeof tool === "string" && TOOLS.has(tool))
    ) as WorkspaceTool[];
  }
  if (Array.isArray(source.allowedConnectorIds)) {
    out.allowedConnectorIds = sortedUnique(stringIds(source.allowedConnectorIds)).slice(0, MAX_CONNECTOR_IDS);
  }
  if (Array.isArray(source.knowledgeFileIds)) {
    // Order preserved — this is the order they are laid into context. Deduped
    // in place so a file cannot be paid for twice.
    out.knowledgeFileIds = dedupeInOrder(stringIds(source.knowledgeFileIds)).slice(0, MAX_KNOWLEDGE_FILES);
  }
  if (typeof source.preferredModelId === "string" && source.preferredModelId.trim()) {
    out.preferredModelId = source.preferredModelId.trim().slice(0, 200);
  }
  return out;
}

/**
 * The payload as it should be stored: validated keys only, absent keys omitted.
 *
 * Round-trips through `parseWorkspaceConfig` so the normalisation (sorting,
 * deduping, trimming) is defined in exactly one place, and so what is written
 * is byte-identical to what a read of it will produce. Without that, an
 * unchanged save would still write different bytes, bump `EntityRevision`, and
 * hand every other device a change to fetch for nothing.
 */
export function writeWorkspaceConfig(config: WorkspaceConfig): Record<string, unknown> {
  const parsed = parseWorkspaceConfig(config);
  const out: Record<string, unknown> = {};
  // Explicit per key rather than a spread of `parsed`: a spread would also
  // carry any key whose value happened to be `undefined`, and `undefined`
  // serialises out of JSON in one place and into `null` in another depending on
  // the path it takes. Absent must be absent everywhere.
  if (parsed.personaName !== undefined) out.personaName = parsed.personaName;
  if (parsed.instructionsOverride !== undefined) out.instructionsOverride = parsed.instructionsOverride;
  if (parsed.allowedTools !== undefined) out.allowedTools = parsed.allowedTools;
  if (parsed.allowedConnectorIds !== undefined) out.allowedConnectorIds = parsed.allowedConnectorIds;
  if (parsed.knowledgeFileIds !== undefined) out.knowledgeFileIds = parsed.knowledgeFileIds;
  if (parsed.preferredModelId !== undefined) out.preferredModelId = parsed.preferredModelId;
  return out;
}

/**
 * Whether a tool is permitted, given the account's own list.
 *
 * The client is what actually enforces this — it stops sending the flag — but
 * the rule is written once, here, so the server and any future surface agree on
 * what an absent list means. A project NARROWS and never widens: a tool the
 * account does not allow stays disallowed however the workspace is configured.
 */
export function workspacePermits(
  config: WorkspaceConfig,
  tool: WorkspaceTool,
  accountAllows: (tool: WorkspaceTool) => boolean = () => true
): boolean {
  if (!accountAllows(tool)) return false;
  // Absent list ⇒ no opinion ⇒ whatever the account said. An empty list is an
  // opinion, and it is "no".
  if (config.allowedTools === undefined) return true;
  return config.allowedTools.includes(tool);
}

function stringIds(values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 200);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function dedupeInOrder(values: string[]): string[] {
  return [...new Set(values)];
}
