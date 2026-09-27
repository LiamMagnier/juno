/**
 * Hiring by conversation: what a free-text description becomes, and how it
 * amends.
 *
 * Muse's hire path is a talk, not a form. The person says what they want in
 * ordinary words; the draft fills in behind a face that is already arriving.
 * Two layers do that work:
 *
 *   1. A deterministic parser (`parseHireDraft`) that catches the phrases
 *      people actually use ("call her Quill", "just do it", "keep my inbox
 *      clear"). It runs instantly, works offline, and is the floor when the
 *      model is unreachable.
 *   2. An LLM turn (`hireDraftSystemPrompt` / `parseHireDraftReply`) on the
 *      account's background provider, which fills the rest of the brief and
 *      answers in one short sentence.
 *
 * Merge policy is amend-only: a turn only writes fields it actually named.
 * "call her Quill" must not throw away a role the last turn set. The living
 * draft is the accumulation; transcript cards are snapshots of it.
 *
 * Pure and client-safe: no React, no Prisma. The route, the conversation UI
 * and tests all read the same shapes.
 */

import {
  AGENT_SHAPES,
  AGENT_TONES,
  AGENT_EYES,
  AGENT_MARKS,
  type AgentAvatar,
  type AgentEyes,
  type AgentMark,
  type AgentShape,
  type AgentTone,
} from "@/lib/agents/avatar";
import {
  AGENT_STYLES,
  MAX_AGENT_INSTRUCTIONS_CHARS,
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_ROLE_CHARS,
  MAX_GOAL_TITLE_CHARS,
  type AgentStyle,
} from "@/lib/agents/domain";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agents/templates";
import {
  WORK_PERMISSION_POLICIES,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** What the conversation has settled so far. Null means "not said yet". */
export interface HireDraftFields {
  name: string | null;
  role: string | null;
  style: AgentStyle | null;
  avatar: AgentAvatar | null;
  instructions: string | null;
  approvalMode: WorkPermissionPolicy | null;
  connectorIds: string[] | null;
  firstGoal: string | null;
  template: string | null;
}

export const EMPTY_HIRE_DRAFT: HireDraftFields = {
  name: null,
  role: null,
  style: null,
  avatar: null,
  instructions: null,
  approvalMode: null,
  connectorIds: null,
  firstGoal: null,
  template: null,
};

export type HireDraftPatch = Partial<HireDraftFields>;

export interface HireDraftTurn {
  role: "user" | "juno";
  content: string;
}

/** What one hire-draft exchange returns to the conversation. */
export interface HireDraftResult {
  draft: HireDraftFields;
  reply: string;
  /** Fields this turn wrote, so the card can highlight what just moved. */
  changed: (keyof HireDraftFields)[];
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function cleanName(value: string): string | null {
  const text = value.replace(/\s+/g, " ").trim().replace(/^[“"'`«»]+|[”"'`«».!?]+$/g, "");
  if (!text) return null;
  return text.length <= MAX_AGENT_NAME_CHARS ? text : text.slice(0, MAX_AGENT_NAME_CHARS).trimEnd();
}

function cleanShort(value: string, max: number): string | null {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Amend-only merge. A patch writes a field only when it carries a real value;
 * `null` in a patch is "leave alone", not "clear". The one exception is
 * `connectorIds`, where an empty array is a real choice (no apps).
 */
export function mergeHireDraft(base: HireDraftFields, patch: HireDraftPatch): {
  draft: HireDraftFields;
  changed: (keyof HireDraftFields)[];
} {
  const draft: HireDraftFields = { ...base };
  const changed: (keyof HireDraftFields)[] = [];
  const set = <K extends keyof HireDraftFields>(key: K, value: HireDraftFields[K] | null | undefined) => {
    if (value === null || value === undefined) return;
    const before = draft[key];
    const same =
      key === "connectorIds" || key === "avatar"
        ? JSON.stringify(before) === JSON.stringify(value)
        : before === value;
    if (same) return;
    draft[key] = value;
    changed.push(key);
  };
  if (patch.name !== undefined) set("name", patch.name === null ? null : cleanName(patch.name));
  if (patch.role !== undefined) set("role", patch.role === null ? null : cleanShort(patch.role, MAX_AGENT_ROLE_CHARS));
  if (patch.style !== undefined) set("style", patch.style);
  if (patch.avatar !== undefined) set("avatar", patch.avatar);
  if (patch.instructions !== undefined) {
    const text = patch.instructions === null ? "" : patch.instructions.trim().slice(0, MAX_AGENT_INSTRUCTIONS_CHARS);
    set("instructions", text ? text : null);
  }
  if (patch.approvalMode !== undefined) set("approvalMode", patch.approvalMode);
  if (patch.connectorIds !== undefined && patch.connectorIds !== null) {
    set("connectorIds", [...new Set(patch.connectorIds)]);
  }
  if (patch.firstGoal !== undefined) {
    set("firstGoal", patch.firstGoal === null ? null : cleanShort(patch.firstGoal, MAX_GOAL_TITLE_CHARS));
  }
  if (patch.template !== undefined) set("template", patch.template);
  return { draft, changed };
}

// ---------------------------------------------------------------------------
// Vocabulary the parser hears
// ---------------------------------------------------------------------------

const NAME_PATTERNS: RegExp[] = [
  /\bcall\s+(?:it|him|her|them)\s+([A-Za-z][A-Za-z0-9'’_-]{0,39})\b/i,
  /\b(?:name\s+(?:it|him|her|them)|let'?s call (?:it|him|her|them))\s+([A-Za-z][A-Za-z0-9'’_-]{0,39})\b/i,
  /\b(?:its|his|her|their)\s+name\s+(?:is|should be|could be)\s+([A-Za-z][A-Za-z0-9'’_-]{0,39})\b/i,
  /\bname\s*[:=]\s*["']?([A-Za-z][A-Za-z0-9'’_-]{0,39})/i,
];

const STYLE_WORDS: Record<AgentStyle, RegExp> = {
  warm: /\b(warm|friendly|kind|encourag\w*|chatty|personable)\b/i,
  direct: /\b(direct|blunt|concise|brief|to the point|no nonsense|short answers?)\b/i,
  playful: /\b(playful|fun|witty|light|breezy|quirky|personality)\b/i,
  formal: /\b(formal|professional|precise|measured|corporate|client-ready)\b/i,
};

const APPROVAL_WORDS: { mode: WorkPermissionPolicy; re: RegExp }[] = [
  {
    mode: "permissive",
    re: /\b(just do it|hands[- ]?off|don'?t ask|do not ask|without asking|full auto|on its own|autonomous|run with it)\b/i,
  },
  {
    mode: "conservative",
    re: /\b(ask (?:me |first |before )|check with me|always ask|manual|careful|confirm everything|ask a lot)\b/i,
  },
  {
    mode: "balanced",
    re: /\b(ask before risky|balanced|ask about the important|only when it matters)\b/i,
  },
];

const GOAL_PATTERNS: RegExp[] = [
  /\b(?:first\s+)?goal\s*(?:is|:|should be|could be)\s+(.+)$/is,
  /\bstart\s+(?:with|by|on)\s+(.+)$/is,
  /\b(?:its|their)\s+first\s+(?:job|task|goal)\s+(?:is|:)\s+(.+)$/is,
];

/** Role-ish nouns that map onto a starting point, strongest first. */
const TEMPLATE_HINTS: { id: string; re: RegExp }[] = [
  { id: "chief-of-staff", re: /\b(inbox|e-?mail|calendar|schedule|follow[- ]?ups?|chief of staff|assistant|triage)\b/i },
  { id: "researcher", re: /\b(research|citations?|sources?|briefings?|literature|papers?|report back)\b/i },
  { id: "deal-finder", re: /\b(prices?|deals?|shop(?:ping)?|wishlist|discounts?|buy(?:ing)?|compare prices)\b/i },
  { id: "trip-planner", re: /\b(trips?|travel|flights?|hotels?|itinerar\w*|vacation|booking travel)\b/i },
  { id: "writer", re: /\b(writ(?:e|ing|er)|draft(?:s|ing)?|blog|posts?|newsletter|copywriting|essays?|announcements?)\b/i },
  { id: "monitor", re: /\b(monitor|watch(?:es|ing)?|alerts?|track(?:ing)?|feeds?|when .{0,40}changes)\b/i },
];

const TONE_WORDS: { tone: AgentTone; re: RegExp }[] = [
  { tone: "coral", re: /\b(coral|orange|warm red|peach)\b/i },
  { tone: "juniper", re: /\b(juniper|green|forest)\b/i },
  { tone: "teal", re: /\b(teal|turquoise|aqua|cyan)\b/i },
  { tone: "violet", re: /\b(violet|purple|lavender|lilac)\b/i },
  { tone: "amber", re: /\b(amber|gold|yellow|honey)\b/i },
  { tone: "sage", re: /\b(sage|mint|pistachio|soft green)\b/i },
];

const SHAPE_WORDS: { shape: AgentShape; re: RegExp }[] = [
  { shape: "orb", re: /\b(orb|circle|round body|ball)\b/i },
  { shape: "pebble", re: /\b(pebble|soft square|superellipse)\b/i },
  { shape: "capsule", re: /\b(capsule|pill|stadium|tall)\b/i },
  { shape: "petal", re: /\b(petal|teardrop|drop)\b/i },
  { shape: "bloom", re: /\b(bloom|flower|four[- ]?lobed)\b/i },
  { shape: "spark", re: /\b(spark|star|juno spark)\b/i },
];

const EYES_WORDS: { eyes: AgentEyes; re: RegExp }[] = [
  { eyes: "soft", re: /\b(soft eyes|rounded square eyes|gentle eyes)\b/i },
  { eyes: "round", re: /\b(round eyes|dot eyes|dots?)\b/i },
  { eyes: "tall", re: /\b(tall eyes|upright eyes|pill eyes)\b/i },
  { eyes: "wide", re: /\b(wide eyes|landscape eyes|sleepy eyes)\b/i },
];

const MARK_WORDS: { mark: AgentMark; re: RegExp }[] = [
  { mark: "ring", re: /\b(ring|halo)\b/i },
  { mark: "spark", re: /\b(spark mark|crown spark|sparkle)\b/i },
  { mark: "leaf", re: /\b(leaf)\b/i },
  { mark: "antenna", re: /\b(antenna|aerial)\b/i },
  { mark: "visor", re: /\b(visor)\b/i },
  { mark: "none", re: /\b(no mark|bare|without a mark|plain face)\b/i },
];

function pickTemplate(text: string): AgentTemplate | null {
  for (const hint of TEMPLATE_HINTS) {
    if (hint.re.test(text)) return AGENT_TEMPLATES.find((t) => t.id === hint.id) ?? null;
  }
  return null;
}

function pickEnum<T extends string>(words: readonly { value: T; re: RegExp }[], text: string): T | null {
  for (const entry of words) {
    if (entry.re.test(text)) return entry.value;
  }
  return null;
}

function styleFrom(text: string): AgentStyle | null {
  for (const style of AGENT_STYLES) {
    if (STYLE_WORDS[style].test(text)) return style;
  }
  return null;
}

function approvalFrom(text: string): WorkPermissionPolicy | null {
  for (const entry of APPROVAL_WORDS) {
    if (entry.re.test(text)) return entry.mode;
  }
  return null;
}

function goalFrom(text: string): string | null {
  for (const re of GOAL_PATTERNS) {
    const match = text.match(re);
    const captured = match?.[1]?.replace(/\s+/g, " ").trim();
    if (captured) return cleanShort(captured.replace(/[.!?]+$/, ""), MAX_GOAL_TITLE_CHARS);
  }
  return null;
}

function nameFrom(text: string): string | null {
  for (const re of NAME_PATTERNS) {
    const match = text.match(re);
    const captured = match?.[1];
    if (captured) return cleanName(captured);
  }
  return null;
}

function avatarFrom(text: string, fallback: AgentAvatar | null): AgentAvatar | null {
  const shape = pickEnum(SHAPE_WORDS.map((e) => ({ value: e.shape, re: e.re })), text);
  const tone = pickEnum(TONE_WORDS.map((e) => ({ value: e.tone, re: e.re })), text);
  const eyes = pickEnum(EYES_WORDS.map((e) => ({ value: e.eyes, re: e.re })), text);
  const mark = pickEnum(MARK_WORDS.map((e) => ({ value: e.mark, re: e.re })), text);
  if (!shape && !tone && !eyes && !mark) return null;
  const base = fallback ?? { shape: "orb" as AgentShape, tone: "coral" as AgentTone, eyes: "soft" as AgentEyes, mark: "none" as AgentMark };
  return {
    shape: shape ?? base.shape,
    tone: tone ?? base.tone,
    eyes: eyes ?? base.eyes,
    mark: mark ?? base.mark,
  };
}

function roleFrom(text: string): string | null {
  // Prefer an explicit "role is X" / "looks after X".
  const explicit =
    text.match(/\b(?:role|job|for)\s*(?:is|:)\s+(.+)$/is)?.[1] ??
    text.match(/\blooks? after\s+(.+)$/is)?.[1] ??
    text.match(/\bdoes\s+(.+)$/is)?.[1];
  const candidate = (explicit ?? text.split(/[.!?\n]/)[0] ?? "").replace(/\s+/g, " ").trim();
  if (!candidate || candidate.length < 3) return null;
  // Drop leading "I need someone to" / "Looking for" scaffolding.
  const stripped = candidate.replace(
    /^(?:i\s+(?:need|want|would like)\s+(?:someone|somebody|a teammate|an agent|it|them)?\s*(?:to|who|that)?\s*|looking for\s+(?:someone|a|an)?\s*|help me\s+|please\s+)/i,
    ""
  );
  const role = (stripped || candidate).replace(/[.!?]+$/, "");
  return cleanShort(role.length > 2 ? role : candidate, MAX_AGENT_ROLE_CHARS);
}

function instructionsFrom(text: string, draft: HireDraftFields): string | null {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length < 24) return null;
  // The person's own words are the brief. Keep them whole; the model layer may
  // rewrite later, but the floor is never invented copy.
  if (draft.instructions && draft.instructions.includes(trimmed.slice(0, 40))) return null;
  return trimmed.slice(0, MAX_AGENT_INSTRUCTIONS_CHARS);
}

/**
 * What a free-text turn says on its own, without a model.
 *
 * Intentionally literal: "call her Quill" is a name, not a request to
 * re-theme the agent. Broad job language seeds a starting point so the face
 * and defaults arrive with the words rather than after a second round trip.
 */
export function parseHireDraft(text: string, base: HireDraftFields = EMPTY_HIRE_DRAFT): {
  patch: HireDraftPatch;
  changed: (keyof HireDraftFields)[];
  draft: HireDraftFields;
} {
  const patch: HireDraftPatch = {};
  const name = nameFrom(text);
  if (name) patch.name = name;

  const style = styleFrom(text);
  if (style) patch.style = style;

  const approvalMode = approvalFrom(text);
  if (approvalMode) patch.approvalMode = approvalMode;

  const firstGoal = goalFrom(text);
  if (firstGoal) patch.firstGoal = firstGoal;

  const avatar = avatarFrom(text, base.avatar);
  if (avatar) patch.avatar = avatar;

  const template = pickTemplate(text);
  if (template) {
    patch.template = template.id;
    // Seed only what this turn has not named, and only while the living draft
    // is still empty on those fields: a later job description must not
    // overwrite a name the person already chose.
    if (!base.role && !patch.role) patch.role = template.role || roleFrom(text);
    if (!base.style && !patch.style) patch.style = template.style;
    if (!base.approvalMode && !patch.approvalMode) patch.approvalMode = template.approvalMode;
    if (!base.avatar && !patch.avatar) patch.avatar = template.avatar;
    if (!base.instructions && !patch.instructions) patch.instructions = template.instructions || instructionsFrom(text, base);
    if (!base.firstGoal && !patch.firstGoal) patch.firstGoal = template.firstGoal;
    if (!base.name && !patch.name) patch.name = template.names[0];
  } else if (!name || text.length > 40) {
    const role = roleFrom(text);
    if (role && !base.role) patch.role = role;
    const instructions = instructionsFrom(text, base);
    if (instructions) patch.instructions = instructions;
  }

  // Face words alone, with no job yet, still need a base avatar.
  if (patch.avatar && !base.avatar && !patch.template) {
    patch.avatar = {
      shape: patch.avatar.shape,
      tone: patch.avatar.tone,
      eyes: patch.avatar.eyes,
      mark: patch.avatar.mark,
    };
  }

  const merged = mergeHireDraft(base, patch);
  return { patch, changed: merged.changed, draft: merged.draft };
}

/** Starting points offered as chips under the first question. */
export function hireTemplateChips(): { id: string; label: string; promise: string }[] {
  return AGENT_TEMPLATES.map((t) => ({ id: t.id, label: t.label, promise: t.promise }));
}

/** A template applied as if the person had picked the chip. */
export function hireDraftFromTemplate(template: AgentTemplate, base: HireDraftFields = EMPTY_HIRE_DRAFT): {
  draft: HireDraftFields;
  changed: (keyof HireDraftFields)[];
} {
  return mergeHireDraft(base, {
    template: template.id,
    name: base.name ?? template.names[0] ?? null,
    role: base.role ?? (template.role.trim() || null),
    style: base.style ?? template.style,
    avatar: base.avatar ?? template.avatar,
    instructions: base.instructions ?? (template.instructions.trim() || null),
    approvalMode: base.approvalMode ?? template.approvalMode,
    firstGoal: base.firstGoal ?? (template.firstGoal.trim() || null),
  });
}

// ---------------------------------------------------------------------------
// The model turn
// ---------------------------------------------------------------------------

export function hireDraftSystemPrompt(): string {
  return [
    "You help someone hire a personal AI teammate on Juno. They describe the job in ordinary words; you fill in the hire draft and answer in one short sentence.",
    "",
    "Return ONLY a JSON object with this shape:",
    '{"name":"…","role":"…","style":"warm|direct|playful|formal","avatar":{"shape":"orb|pebble|capsule|petal|bloom|spark","tone":"coral|juniper|teal|violet|amber|sage","eyes":"soft|round|tall|wide","mark":"none|ring|spark|leaf|antenna|visor"},"instructions":"…","approvalMode":"conservative|balanced|permissive","connectorIds":[],"firstGoal":"…","template":"chief-of-staff|researcher|deal-finder|trip-planner|writer|monitor|custom|null","reply":"…"}',
    "",
    "Rules:",
    "- Omit (do not invent) any field the person did not speak to. Keep values already in Current draft unless this message clearly amends them. \"call her Quill\" only sets name.",
    "- name: short, human. If they did not name one, pick one that fits the job from the starting point's voice, never a generic \"Assistant\".",
    "- role: one short line, sentence case, no trailing period.",
    "- instructions: 2 to 4 short paragraphs in second person (\"You look after…\"). Stated boundaries must be kept: never send, publish, pay, buy, delete for good, or change accounts without approval.",
    "- firstGoal: one concrete sentence the agent could start on today.",
    "- approvalMode: conservative if they want to be asked a lot, permissive only if they clearly said hands-off / just do it, otherwise balanced.",
    "- connectorIds: leave empty unless they named an app. Never grant an app because the job implies it.",
    "- template: the closest starting point id, or custom.",
    "- reply: one warm sentence. Confirm what changed and ask for the one most useful missing detail if something important is still open. No lists. No markdown.",
    "- Write name, role, instructions, firstGoal and reply in the same language as the person's message.",
  ].join("\n");
}

export function hireDraftUserMessage(input: {
  message: string;
  draft: HireDraftFields;
  turns: readonly HireDraftTurn[];
}): string {
  const lines: string[] = [];
  lines.push(`Current draft:\n${JSON.stringify(input.draft)}`);
  const history = input.turns.slice(-8);
  if (history.length > 0) {
    lines.push(
      `Conversation so far:\n${history
        .map((turn) => `${turn.role === "user" ? "Person" : "Juno"}: ${turn.content.slice(0, 600)}`)
        .join("\n")}`
    );
  }
  lines.push(`Person just said:\n${input.message}`);
  lines.push("JSON:");
  return lines.join("\n\n");
}

function firstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function asStyle(value: unknown): AgentStyle | null {
  return typeof value === "string" && (AGENT_STYLES as readonly string[]).includes(value)
    ? (value as AgentStyle)
    : null;
}

function asApproval(value: unknown): WorkPermissionPolicy | null {
  return typeof value === "string" && (WORK_PERMISSION_POLICIES as readonly string[]).includes(value)
    ? (value as WorkPermissionPolicy)
    : null;
}

function asAvatar(value: unknown, fallback: AgentAvatar | null): AgentAvatar | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const shape = typeof record.shape === "string" && (AGENT_SHAPES as readonly string[]).includes(record.shape)
    ? (record.shape as AgentShape)
    : null;
  const tone = typeof record.tone === "string" && (AGENT_TONES as readonly string[]).includes(record.tone)
    ? (record.tone as AgentTone)
    : null;
  const eyes = typeof record.eyes === "string" && (AGENT_EYES as readonly string[]).includes(record.eyes)
    ? (record.eyes as AgentEyes)
    : null;
  const mark = typeof record.mark === "string" && (AGENT_MARKS as readonly string[]).includes(record.mark)
    ? (record.mark as AgentMark)
    : null;
  if (!shape && !tone && !eyes && !mark) return null;
  const base =
    fallback ?? ({ shape: "orb", tone: "coral", eyes: "soft", mark: "none" } satisfies AgentAvatar);
  return {
    shape: shape ?? base.shape,
    tone: tone ?? base.tone,
    eyes: eyes ?? base.eyes,
    mark: mark ?? base.mark,
  };
}

/**
 * The model's answer, reduced to a patch on the living draft and one sentence
 * of reply. Falls through to the deterministic parser's sentence when the
 * model wrote no reply of its own.
 */
export function parseHireDraftReply(
  text: string,
  input: { message: string; draft: HireDraftFields }
): HireDraftResult | null {
  const raw = firstObject(text);
  if (!raw) {
    // A prose-only answer still amends what it can hear, so the talk is never
    // a dead end when the model ignores the JSON rule.
    const local = parseHireDraft(input.message, input.draft);
    return {
      draft: local.draft,
      changed: local.changed,
      reply: hireDraftReply(local.draft, local.changed),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;

  const connectors = Array.isArray(root.connectorIds)
    ? root.connectorIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
    : undefined;
  const templateId =
    typeof root.template === "string" && root.template !== "custom" && root.template !== "null"
      ? root.template
      : typeof root.template === "string" && root.template === "custom"
        ? "custom"
        : undefined;

  const patch: HireDraftPatch = {
    name: typeof root.name === "string" ? cleanName(root.name) : undefined,
    role: typeof root.role === "string" ? cleanShort(root.role, MAX_AGENT_ROLE_CHARS) : undefined,
    style: asStyle(root.style) ?? undefined,
    avatar: asAvatar(root.avatar, input.draft.avatar) ?? undefined,
    instructions:
      typeof root.instructions === "string"
        ? root.instructions.trim().slice(0, MAX_AGENT_INSTRUCTIONS_CHARS) || undefined
        : undefined,
    approvalMode: asApproval(root.approvalMode) ?? undefined,
    connectorIds: connectors,
    firstGoal: typeof root.firstGoal === "string" ? cleanShort(root.firstGoal, MAX_GOAL_TITLE_CHARS) : undefined,
    template: templateId ?? undefined,
  };

  const merged = mergeHireDraft(input.draft, patch);
  const reply =
    (typeof root.reply === "string" && root.reply.trim().slice(0, 400)) ||
    hireDraftReply(merged.draft, merged.changed);
  return { draft: merged.draft, changed: merged.changed, reply };
}

/** The floor reply, when the model did not write one. Still conversational. */
export function hireDraftReply(draft: HireDraftFields, changed: readonly (keyof HireDraftFields)[]): string {
  const name = draft.name?.trim();
  if (changed.includes("name") && name) return `Got it. I'll call them ${name}.`;
  if (changed.includes("firstGoal") && draft.firstGoal) return `Noted. Their first goal is ${draft.firstGoal.toLowerCase()}.`;
  if (changed.includes("style")) return "Noted. I'll set how they talk.";
  if (changed.includes("approvalMode")) return "Noted. I'll set how much they check in with you.";
  if (changed.includes("role") && draft.role) return `Sounds good. They'll look after ${draft.role.toLowerCase()}.`;
  if (changed.length > 0) return "Updated the draft.";
  return "Tell me a bit more about what they should take on.";
}

/** What is still open before Hire feels ready. Empty means ready. */
export function hireDraftGaps(draft: HireDraftFields): string[] {
  const gaps: string[] = [];
  if (!draft.name?.trim()) gaps.push("name");
  if (!draft.role?.trim() && !draft.instructions?.trim()) gaps.push("job");
  return gaps;
}

/**
 * Builds the hire payload from a draft plus whatever the form is holding.
 * The form is the power-user path and always wins on fields it shows.
 */
export function hireDraftToInput(draft: HireDraftFields): {
  name: string;
  role: string;
  avatar: AgentAvatar | null;
  style: AgentStyle | null;
  instructions: string;
  approvalMode: WorkPermissionPolicy | null;
  connectorIds: string[];
  template: string | null;
  firstGoal: string;
} {
  return {
    name: (draft.name ?? "").trim(),
    role: (draft.role ?? "").trim(),
    avatar: draft.avatar,
    style: draft.style,
    instructions: (draft.instructions ?? "").trim(),
    approvalMode: draft.approvalMode,
    connectorIds: draft.connectorIds ?? [],
    template: draft.template,
    firstGoal: (draft.firstGoal ?? "").trim(),
  };
}
