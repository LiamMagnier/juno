/**
 * Teach Juno: a method the person shows once, drafted as a skill they review.
 *
 * The person walks through a task (in a chat, or step by step on the Teach
 * page) and gets back a DRAFT: a name, when it applies, ordered steps they can
 * edit, what it may use, and where it applies. Nothing about a draft is live.
 * It becomes a skill only when the person saves it, and a save switches it on
 * only when it carries the permission fingerprint the page showed when the
 * person ticked "I've reviewed it", and that fingerprint equals the one the
 * server computes for what it is saving (`teachEnableDecision`).
 *
 * WHAT THAT CHECK IS, AND IS NOT. It catches a stale page: a tool or app added
 * or removed after the box was ticked (another tab, a late edit) saves the
 * skill switched off. It is not proof that a person read anything: any client
 * can compute the fingerprint of its own payload. Nor is it the only way on:
 * the skill library's switch (`PATCH /api/work/skills/[id]`) turns a skill
 * that was saved off on without this page.
 *
 * WHAT IT MAY USE, AT RUN TIME. When the person runs a taught skill in a chat
 * (picks it in the composer), the turn keeps to what it lists, and never more
 * than the chat already has on (`scopeTurnToSkill`, `narrowRuntimeToolsForSkill`,
 * `narrowConnectorsForSkill` and `skillKeepsUnlistedSurfaces` in
 * `chat/skills.ts`): tools not listed are not attached, apps not listed are not
 * connected, web search and deep research stay only when "Search the web" or
 * "Open web pages" is listed (research asked for without it answers with a
 * notice saying so), the canvas only when it is listed. What no skill can list
 * is not attached either: the folder on the person's Mac, the agent
 * configuration tools (`propose_setup_change`, `create_room` and the rest), a
 * room's `ask_room_member` and the cross-conversation tools. The one thing kept
 * is the skill's own pair, `use_skill` and `read_skill_file`, so it can read
 * its own files. A taught skill that lists NOTHING narrows nothing (the page
 * says so). A taught skill the model picks for itself (`use_skill`, possible
 * only after the person turns automatic use on, which Teach never does) is
 * loaded in the middle of a turn whose tools are already fixed, and narrows
 * nothing.
 *
 * WHAT THIS MODULE DECIDES, without a request or a database, so every rule has
 * a test:
 *
 *   - which tools a taught skill may ask for, in words a person can read
 *     (`TEACHABLE_TOOLS`), and how a model's loose names map onto them;
 *   - whether a model's draft may be put in front of the person at all
 *     (`admitSkillDraft`) — refused when it has no steps, invents a tool the
 *     product does not have, or would be refused by the skill scanner anyway;
 *   - the instructions a draft becomes (`renderTaughtInstructions`) and the
 *     editable steps those instructions read back as (`parseTaughtInstructions`),
 *     so the steps are never a hidden copy beside what the model reads: the
 *     markdown IS the skill, and the editor is a structured view of it;
 *   - what a save sends and what the server accepts (`taughtSkillSaveSchema`),
 *     and whether a save may switch the skill on (`teachEnableDecision`).
 *
 * WHAT IT NEVER DOES: record the screen, read anything the person did not type
 * or do in a conversation with Juno, or widen what a run may use. A taught
 * skill's tools and apps are requests that NARROW a turn, as above.
 *
 * Pure and client-safe. No `server-only`, no Prisma.
 */

import { z } from "zod";
import {
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_INSTRUCTIONS_CHARS,
  SKILL_CAPABILITY_NAME_PATTERN,
  SKILL_CONNECTOR_NAME_PATTERN,
  SKILL_FIELD_KINDS,
  canonicalSkillToolName,
  emptySkillContract,
  normalizeSkillSlug,
  skillSlugFromName,
  type WorkSkillContract,
  type WorkSkillField,
} from "@/lib/work/skills";
import {
  permissionFingerprint,
  permissionSurfaceOf,
  scanSkillVersion,
  type SkillSecurityFinding,
  type SkillSecurityStatus,
} from "@/lib/work/skill-security";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const DRAFT_SKILL_TOOL_ID = "draft_skill";
/** Drafts one reply may put on screen. More is a model looping. */
export const MAX_SKILL_DRAFTS_PER_TURN = 2;
export const MAX_TAUGHT_NAME_CHARS = 80;
export const MAX_TAUGHT_WHEN_CHARS = 400;
export const MAX_TAUGHT_STEPS = 20;
export const MAX_TAUGHT_STEP_CHARS = 600;
export const MAX_TAUGHT_INPUTS = 8;
export const MAX_TAUGHT_RULES = 8;
/** Notes the person types. */
export const MAX_TAUGHT_NOTES = 8;
export const MAX_TAUGHT_QUESTIONS = 5;
/**
 * Notes a save may carry: the ones typed, plus one per answered question (an
 * answer becomes a note, `answeredNote`). The editor checks the same total.
 */
export const MAX_TAUGHT_SAVED_NOTES = MAX_TAUGHT_NOTES + MAX_TAUGHT_QUESTIONS;
export const MAX_TAUGHT_DONE_CHARS = 400;
export const MAX_TAUGHT_TOOLS = 16;
export const MAX_TAUGHT_APPS = 12;
export const MAX_TAUGHT_DOMAINS = 8;
const MAX_INPUT_NAME_CHARS = 60;
const MAX_INPUT_DESCRIPTION_CHARS = 200;
const MAX_LIST_ITEM_CHARS = 300;
const MAX_APPS = MAX_TAUGHT_APPS;
const MAX_DOMAINS = MAX_TAUGHT_DOMAINS;
const MAX_KEY_CHARS = 200;
const MAX_ID_CHARS = 200;
/**
 * The longest permission fingerprint a save can acknowledge, with room to
 * spare: 16 tools and 32 base-contract apps of up to 80 characters, 12 apps of
 * up to 120, 8 websites of up to 253, the policy and the budget come to under
 * 8,000 characters of JSON. A bound only so a body cannot be arbitrarily
 * large; the value itself is compared for equality.
 */
const MAX_ACKNOWLEDGED_CHARS = 16_000;

// ---------------------------------------------------------------------------
// What a taught skill may ask for
// ---------------------------------------------------------------------------

/**
 * One capability a person can grant a taught skill, as they read it.
 *
 * The ids are the names a chat turn grants (`CHAT_SKILL_TOOLS`), so a taught
 * skill's request is matched against the same strings the chat resolver
 * intersects with. A name outside this list is dropped from a draft and said
 * out loud on the card, never stored: a skill asking for something no surface
 * grants is a skill that looks complete and silently loses a step.
 */
export interface TeachableTool {
  id: string;
  label: string;
  /** What granting it lets Juno do, in one line. */
  description: string;
  /** Reads outside content or executes something: the review says so. */
  sensitive: boolean;
}

export const TEACHABLE_TOOLS: readonly TeachableTool[] = Object.freeze([
  { id: "web_search", label: "Search the web", description: "Look things up and cite what it finds.", sensitive: false },
  { id: "web_fetch", label: "Open web pages", description: "Read a page at a link you give or it finds.", sensitive: true },
  { id: "read_document", label: "Read your files", description: "Read documents attached to the chat.", sensitive: false },
  { id: "inspect_image", label: "Look at images", description: "Examine pictures attached to the chat.", sensitive: false },
  { id: "canvas", label: "Write in a canvas", description: "Draft documents, code or tables beside the chat.", sensitive: false },
  { id: "run_code", label: "Run code", description: "Run code in a sandbox with no internet access.", sensitive: true },
  { id: "search_chats", label: "Search your chats", description: "Find things in your past conversations.", sensitive: false },
  { id: "current_time", label: "Check the date", description: "Know today’s date and time.", sensitive: false },
  { id: "calculate", label: "Calculate", description: "Do exact arithmetic instead of estimating.", sensitive: false },
]);

export const TEACHABLE_TOOL_IDS: readonly string[] = Object.freeze(TEACHABLE_TOOLS.map((tool) => tool.id));

const TOOL_BY_ID = new Map(TEACHABLE_TOOLS.map((tool) => [tool.id, tool]));

/**
 * Loose names a model (or a person) uses for the same tools. Matched after
 * lower-casing and squashing punctuation, so "Web Search", "web-search" and
 * "websearch" are one name.
 */
const TOOL_SYNONYMS: Readonly<Record<string, string>> = Object.freeze({
  websearch: "web_search",
  search: "web_search",
  searchtheweb: "web_search",
  google: "web_search",
  browse: "web_fetch",
  browsing: "web_fetch",
  webfetch: "web_fetch",
  fetch: "web_fetch",
  openwebpages: "web_fetch",
  openpage: "web_fetch",
  visit: "web_fetch",
  readdocument: "read_document",
  readdocuments: "read_document",
  documents: "read_document",
  files: "read_document",
  readfiles: "read_document",
  pdf: "read_document",
  inspectimage: "inspect_image",
  images: "inspect_image",
  vision: "inspect_image",
  canvas: "canvas",
  artifact: "canvas",
  runcode: "run_code",
  code: "run_code",
  python: "run_code",
  sandbox: "run_code",
  codeinterpreter: "run_code",
  searchchats: "search_chats",
  chathistory: "search_chats",
  pastchats: "search_chats",
  currenttime: "current_time",
  time: "current_time",
  date: "current_time",
  calculate: "calculate",
  calculator: "calculate",
  math: "calculate",
});

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The teachable tool a loose name means, or null when it is not one. */
export function teachableToolId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (TOOL_BY_ID.has(trimmed)) return trimmed;
  // `bash`, `shell`, `code_interpreter` and friends read as run_code, as they
  // do for every skill (`canonicalSkillToolName`).
  const canonical = canonicalSkillToolName(trimmed);
  if (TOOL_BY_ID.has(canonical)) return canonical;
  return TOOL_SYNONYMS[squash(trimmed)] ?? null;
}

export function teachableTool(id: string): TeachableTool | null {
  return TOOL_BY_ID.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

export interface TaughtInput {
  name: string;
  description: string;
  required: boolean;
}

export interface TaughtApp {
  id: string;
  label: string;
}

/** Where a draft came from. Display and provenance only; it grants nothing. */
export interface TaughtSource {
  via: "conversation" | "walkthrough";
  conversationId: string | null;
}

/** A skill draft as the transcript carries it, on a `kind: "tool"` activity row. */
export interface ClientSkillDraft {
  version: 1;
  /** Stable per draft; sent with Save so a second save lands on the first skill. */
  key: string;
  name: string;
  /** Derived from the name by the function the save uses; null when none can be. */
  slug: string | null;
  whenToUse: string;
  steps: string[];
  inputs: TaughtInput[];
  doneWhen: string;
  rules: string[];
  /** What the drafter could not tell from the conversation. */
  questions: string[];
  /** Teachable tool ids the method needs. */
  tools: string[];
  /** Connected apps it uses. */
  apps: TaughtApp[];
  /** Apps it named that are not connected. */
  missingApps: string[];
  /** Names asked for that a skill cannot ask for, so the card can say so. */
  dropped: string[];
  /** What this conversation actually used, as evidence beside the request. */
  observed: { tools: string[]; apps: string[] };
  source: TaughtSource;
  /** Drafted in a turn that read outside content: the card asks for a careful read. */
  fromOutsideContent: boolean;
  /** The scanner's verdict on the rendered draft (never `blocked`: those are refused). */
  scan: { status: Exclude<SkillSecurityStatus, "blocked">; findings: { code: string; message: string }[] };
  createdAt: string;
}

export interface SkillDraftContext {
  key: string;
  now: Date;
  conversationId: string | null;
  /** The apps connected for this account (and this message). */
  connectors: readonly TaughtApp[];
  /** Tool ids and app ids this conversation used before this turn. */
  observed?: { tools: readonly string[]; apps: readonly string[] };
  /** Outside content (a page, a file, a tool result) is in this turn. */
  untrusted: boolean;
  /** The turn's own reading says that content is hostile. */
  hostile?: boolean;
}

export const SKILL_DRAFT_REFUSALS = {
  invalid_arguments: "A skill draft needs a name and at least one step. Nothing was drafted.",
  too_many_steps: `A skill can have at most ${MAX_TAUGHT_STEPS} steps. Combine some and try again. Nothing was drafted.`,
  step_too_long: `Each step must be under ${MAX_TAUGHT_STEP_CHARS} characters. Split the long one and try again. Nothing was drafted.`,
  unsafe: "The draft contains an instruction the skill safety check refuses (such as skipping approval or hiding what it does). Nothing was drafted.",
  outside_content: "This turn read content that tried to set something up, so no skill was drafted.",
  too_many: "Two skills have already been drafted in this reply. Nothing more was drafted.",
} as const;

export type SkillDraftRefusal = keyof typeof SKILL_DRAFT_REFUSALS;

export type SkillDraftAdmission =
  | { ok: true; draft: ClientSkillDraft }
  | { ok: false; reason: SkillDraftRefusal; message: string };

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function clipWords(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "");
}

/** A list of one-line strings: blanks dropped, duplicates dropped, each clipped, at most `max`. */
function lines(raw: unknown, max: number, chars = MAX_LIST_ITEM_CHARS): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const text = clipWords(oneLine(entry), chars);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function readInputs(raw: unknown): TaughtInput[] {
  if (!Array.isArray(raw)) return [];
  const out: TaughtInput[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_TAUGHT_INPUTS) break;
    if (typeof entry === "string") {
      const name = clipWords(oneLine(entry), MAX_INPUT_NAME_CHARS);
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        out.push({ name, description: "", required: true });
      }
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = clipWords(oneLine(record.name), MAX_INPUT_NAME_CHARS);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      description: clipWords(oneLine(record.description), MAX_INPUT_DESCRIPTION_CHARS),
      required: record.required !== false,
    });
  }
  return out;
}

function matchApps(
  requested: unknown,
  connectors: readonly TaughtApp[]
): { apps: TaughtApp[]; missing: string[] } {
  if (!Array.isArray(requested)) return { apps: [], missing: [] };
  const apps = new Map<string, TaughtApp>();
  const missing = new Set<string>();
  for (const raw of requested.slice(0, MAX_APPS)) {
    const wanted = oneLine(raw);
    if (!wanted) continue;
    const key = squash(wanted);
    const found = connectors.find(
      (connector) =>
        connector.id.toLowerCase() === wanted.toLowerCase() ||
        connector.label.toLowerCase() === wanted.toLowerCase() ||
        squash(connector.id) === key ||
        squash(connector.label) === key
    );
    if (found) apps.set(found.id, { id: found.id, label: found.label });
    else missing.add(clipWords(wanted, 40));
  }
  return { apps: [...apps.values()], missing: [...missing] };
}

/**
 * Whether the model's draft may become a card, and the card if so.
 *
 * Refused: a draft with no name or no steps, too many or too long steps, a
 * draft the skill scanner would block (asking to skip approval, to hide what
 * it does), and any draft from a turn whose outside content was judged hostile.
 * A turn that merely read outside content still gets its card, marked, because
 * nothing is saved until the person reviews every step on the Teach page.
 *
 * Tools are mapped to the teachable list; anything else is dropped and named.
 * Apps are matched to what the account has connected. Neither list is a grant.
 */
export function admitSkillDraft(args: Record<string, unknown>, ctx: SkillDraftContext): SkillDraftAdmission {
  if (ctx.hostile) return { ok: false, reason: "outside_content", message: SKILL_DRAFT_REFUSALS.outside_content };

  const name = clipWords(oneLine(args.name), MAX_TAUGHT_NAME_CHARS);
  const rawSteps = Array.isArray(args.steps) ? args.steps.map(oneLine).filter(Boolean) : [];
  if (!name || rawSteps.length === 0) {
    return { ok: false, reason: "invalid_arguments", message: SKILL_DRAFT_REFUSALS.invalid_arguments };
  }
  if (rawSteps.length > MAX_TAUGHT_STEPS) {
    return { ok: false, reason: "too_many_steps", message: SKILL_DRAFT_REFUSALS.too_many_steps };
  }
  if (rawSteps.some((step) => step.length > MAX_TAUGHT_STEP_CHARS)) {
    return { ok: false, reason: "step_too_long", message: SKILL_DRAFT_REFUSALS.step_too_long };
  }
  const steps = rawSteps.map((step) => step.replace(/^\d+[.)]\s+/, ""));

  const tools: string[] = [];
  const dropped: string[] = [];
  for (const raw of Array.isArray(args.tools) ? args.tools.slice(0, 16) : []) {
    const text = oneLine(raw);
    if (!text) continue;
    const id = teachableToolId(text);
    if (id) {
      if (!tools.includes(id)) tools.push(id);
    } else if (!dropped.includes(text)) {
      dropped.push(clipWords(text, 40));
    }
  }
  const { apps, missing } = matchApps(args.apps, ctx.connectors);

  const draft: ClientSkillDraft = {
    version: 1,
    key: ctx.key,
    name,
    slug: skillSlugFromName(name),
    whenToUse: clipWords(oneLine(args.whenToUse ?? args.description), MAX_TAUGHT_WHEN_CHARS),
    steps,
    inputs: readInputs(args.inputs),
    doneWhen: clipWords(oneLine(args.doneWhen), MAX_TAUGHT_DONE_CHARS),
    rules: lines(args.rules, MAX_TAUGHT_RULES),
    questions: lines(args.questions, MAX_TAUGHT_QUESTIONS),
    tools,
    apps,
    missingApps: missing,
    dropped,
    observed: {
      tools: [...new Set(ctx.observed?.tools ?? [])].filter((id) => TOOL_BY_ID.has(id)),
      apps: [...new Set(ctx.observed?.apps ?? [])],
    },
    source: { via: "conversation", conversationId: ctx.conversationId },
    fromOutsideContent: ctx.untrusted,
    scan: { status: "clear", findings: [] },
    createdAt: ctx.now.toISOString(),
  };

  const scan = scanTaughtSkill(formFromDraft(draft));
  if (scan.status === "blocked") return { ok: false, reason: "unsafe", message: SKILL_DRAFT_REFUSALS.unsafe };
  draft.scan = { status: scan.status, findings: scan.findings.map((f) => ({ code: f.code, message: f.message })) };
  return { ok: true, draft };
}

/** The draft key for the n-th draft answering one user message. */
export function skillDraftKey(userMessageId: string, index: number): string {
  return `skill-draft:${userMessageId}:${index}`;
}

// ---------------------------------------------------------------------------
// The form: what the person edits on the Teach page
// ---------------------------------------------------------------------------

/**
 * Everything a taught skill is made of, as the person edits it. Rendering this
 * to instructions and reading instructions back to this are inverse for any
 * form `renderTaughtInstructions` produced.
 */
export interface TaughtSkillForm {
  name: string;
  whenToUse: string;
  steps: string[];
  inputs: TaughtInput[];
  doneWhen: string;
  rules: string[];
  /** Answers the person gave to the drafter's questions, kept as notes. */
  notes: string[];
  /** Questions nobody answered: the skill asks the person at run time. */
  questions: string[];
  tools: string[];
  connectors: string[];
  domains: string[];
}

export function emptyTaughtForm(): TaughtSkillForm {
  return {
    name: "",
    whenToUse: "",
    steps: [""],
    inputs: [],
    doneWhen: "",
    rules: [],
    notes: [],
    questions: [],
    tools: [],
    connectors: [],
    domains: [],
  };
}

export function formFromDraft(draft: ClientSkillDraft): TaughtSkillForm {
  return {
    name: draft.name,
    whenToUse: draft.whenToUse,
    steps: [...draft.steps],
    inputs: draft.inputs.map((input) => ({ ...input })),
    doneWhen: draft.doneWhen,
    rules: [...draft.rules],
    notes: [],
    questions: [...draft.questions],
    tools: [...draft.tools],
    connectors: draft.apps.map((app) => app.id),
    domains: [],
  };
}

const HEADINGS = {
  when: "When to use",
  inputs: "Ask for",
  steps: "Steps",
  done: "Done when",
  rules: "Rules",
  notes: "Notes",
  questions: "Check with the person first",
} as const;

const cleanText = (value: string) => value.replace(/\s+/g, " ").trim();
const cleanList = (values: readonly string[]) => values.map(cleanText).filter(Boolean);

/**
 * The instructions a taught skill is saved as: plain markdown, in sections the
 * model reads as a method and the Teach page reads back as fields. Empty
 * sections are left out. Steps are numbered in order.
 */
export function renderTaughtInstructions(form: TaughtSkillForm): string {
  const parts: string[] = [];
  const when = cleanText(form.whenToUse);
  if (when) parts.push(`## ${HEADINGS.when}\n${when}`);
  const inputs = form.inputs.filter((input) => cleanText(input.name));
  if (inputs.length > 0) {
    parts.push(
      `## ${HEADINGS.inputs}\n${inputs
        .map((input) => {
          const label = `**${cleanText(input.name)}**${input.required ? "" : " (optional)"}`;
          const description = cleanText(input.description);
          return `- ${label}${description ? `: ${description}` : ""}`;
        })
        .join("\n")}`
    );
  }
  const steps = cleanList(form.steps);
  if (steps.length > 0) parts.push(`## ${HEADINGS.steps}\n${steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`);
  const done = cleanText(form.doneWhen);
  if (done) parts.push(`## ${HEADINGS.done}\n${done}`);
  const list = (heading: string, values: readonly string[]) => {
    const cleaned = cleanList(values);
    if (cleaned.length > 0) parts.push(`## ${heading}\n${cleaned.map((value) => `- ${value}`).join("\n")}`);
  };
  list(HEADINGS.rules, form.rules);
  list(HEADINGS.notes, form.notes);
  list(HEADINGS.questions, form.questions);
  return parts.join("\n\n");
}

/**
 * Reads instructions back into the editable fields, or null when they are not
 * in the taught shape (no `## Steps` section with at least one numbered step).
 *
 * Tolerant of the edits a person makes by hand on the skill page: `1)` as well
 * as `1.`, `*` as well as `-`, headings in any case, a wrapped line folded into
 * the step above it. Anything outside the known sections makes the text
 * free-form, and the caller shows it as text rather than dropping it.
 */
export function parseTaughtInstructions(
  instructions: string
): Omit<TaughtSkillForm, "name" | "tools" | "connectors" | "domains"> | null {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  let preamble = false;
  for (const raw of instructions.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const title = heading[1].trim().toLowerCase();
      const known = (Object.values(HEADINGS) as string[]).find((h) => h.toLowerCase() === title);
      if (!known) return null;
      current = known;
      if (!sections.has(known)) sections.set(known, []);
      continue;
    }
    if (current === null) {
      if (raw.trim()) preamble = true;
      continue;
    }
    sections.get(current)!.push(raw);
  }
  if (preamble) return null;

  const items = (body: readonly string[], marker: RegExp): string[] => {
    const out: string[] = [];
    for (const line of body) {
      const match = marker.exec(line);
      if (match) out.push(match[1].trim());
      else if (line.trim() && out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
      else if (line.trim()) out.push(line.trim());
    }
    return out.map(cleanText).filter(Boolean);
  };
  const paragraph = (body: readonly string[] | undefined) => cleanText((body ?? []).join(" "));
  const bullets = (heading: string) => items(sections.get(heading) ?? [], /^\s*[-*•]\s+(.*)$/);

  const stepLines = sections.get(HEADINGS.steps) ?? [];
  const stepMarker = /^\s*\d+[.)]\s+(.*)$/;
  // Steps are numbered or they are not steps: a Steps section of plain prose
  // is free-form text a person wrote, and is shown as text.
  if (!stepLines.some((line) => stepMarker.test(line))) return null;
  const steps = items(stepLines, stepMarker);

  const inputs = bullets(HEADINGS.inputs).map((line): TaughtInput => {
    const match = /^\*\*(.+?)\*\*(\s*\(optional\))?(?::\s*(.*))?$/i.exec(line);
    if (match) return { name: match[1].trim(), description: (match[3] ?? "").trim(), required: !match[2] };
    const [name, ...rest] = line.split(":");
    return { name: name.trim(), description: rest.join(":").trim(), required: true };
  });

  return {
    whenToUse: paragraph(sections.get(HEADINGS.when)),
    steps,
    inputs: inputs.filter((input) => input.name),
    doneWhen: paragraph(sections.get(HEADINGS.done)),
    rules: bullets(HEADINGS.rules),
    notes: bullets(HEADINGS.notes),
    questions: bullets(HEADINGS.questions),
  };
}

/** The one-line description a taught skill carries (what the planner reads to pick it). */
export function taughtDescription(form: Pick<TaughtSkillForm, "whenToUse" | "name">): string {
  const when = cleanText(form.whenToUse);
  return (when || cleanText(form.name)).slice(0, MAX_SKILL_DESCRIPTION_CHARS);
}

/** How an input is matched across a re-teach: its name as the Teach page shows it. */
function shownInputKey(name: string): string {
  return cleanText(name).slice(0, MAX_INPUT_NAME_CHARS).toLowerCase();
}

/**
 * Contract inputs, as the skill contract stores fields.
 *
 * Re-teaching passes the version being replaced (`base`): an input the person
 * kept, matched by name as the page showed it, keeps the kind it had (a
 * `number` or a `url` stays one), because the editor only shows a name, a
 * description and whether it is needed, and saving a typed input back as text
 * would quietly change what the skill accepts. The page shortens a name over
 * 60 characters and a description over 200 (`taughtInputsFromContract`), so a
 * kept input is matched on the shortened name, and a name or description sent
 * back exactly as it was shown keeps its full text. A new input is text.
 */
export function taughtContractInputs(
  inputs: readonly TaughtInput[],
  base: readonly WorkSkillField[] = []
): WorkSkillField[] {
  const before = new Map<string, WorkSkillField>();
  for (const field of base) {
    const key = shownInputKey(field.name);
    if (key && !before.has(key)) before.set(key, field);
  }
  return inputs
    .filter((input) => cleanText(input.name))
    .slice(0, MAX_TAUGHT_INPUTS)
    .map((input) => {
      const name = cleanText(input.name).slice(0, MAX_INPUT_NAME_CHARS);
      const description = cleanText(input.description).slice(0, MAX_INPUT_DESCRIPTION_CHARS);
      const kept = before.get(name.toLowerCase());
      const shown = kept ? taughtInputsFromContract([kept])[0] : undefined;
      return {
        name: kept && shown && name === shown.name ? cleanText(kept.name) : name,
        kind: kept?.kind ?? SKILL_FIELD_KINDS[0],
        required: input.required,
        description: kept && shown && description === shown.description ? cleanText(kept.description) : description,
      };
    });
}

/** A stored contract field as the editor shows an input: the first eight, long text shortened. */
export function taughtInputsFromContract(fields: readonly WorkSkillField[]): TaughtInput[] {
  return fields
    .filter((field) => cleanText(field.name))
    .slice(0, MAX_TAUGHT_INPUTS)
    .map((field) => ({
      name: cleanText(field.name).slice(0, MAX_INPUT_NAME_CHARS),
      description: cleanText(field.description).slice(0, MAX_INPUT_DESCRIPTION_CHARS),
      required: field.required,
    }));
}

/**
 * The contract inputs the Teach page cannot show: past the first
 * `MAX_TAUGHT_INPUTS`. A skill authored elsewhere can ask for up to 32 things;
 * the page shows eight, and a re-teach keeps the rest as they are, because the
 * person never saw them and so could not have removed them.
 */
export function inputsPastTheTeachPage(fields: readonly WorkSkillField[]): WorkSkillField[] {
  return fields.filter((field) => cleanText(field.name)).slice(MAX_TAUGHT_INPUTS);
}

/**
 * What the re-teach page says about the inputs it cannot show exactly, or
 * null when it shows every one as it is. Said on the page so nobody learns of
 * it only by reading the saved contract.
 */
export function reteachInputsNotice(fields: readonly WorkSkillField[]): string | null {
  const named = fields.filter((field) => cleanText(field.name));
  const past = inputsPastTheTeachPage(named).length;
  const shortened = named
    .slice(0, MAX_TAUGHT_INPUTS)
    .some(
      (field) =>
        cleanText(field.name).length > MAX_INPUT_NAME_CHARS ||
        cleanText(field.description).length > MAX_INPUT_DESCRIPTION_CHARS
    );
  const parts: string[] = [];
  if (past > 0) {
    parts.push(
      `It asks for ${named.length} things each time. This page shows the first ${MAX_TAUGHT_INPUTS}, and saving keeps ${
        past === 1 ? "the last one as it is" : `the other ${past} as they are`
      }.`
    );
  }
  if (shortened) {
    parts.push(
      `Names over ${MAX_INPUT_NAME_CHARS} characters and descriptions over ${MAX_INPUT_DESCRIPTION_CHARS} are shown shortened. One you leave as it is keeps its full text.`
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * The inputs a re-taught version's contract keeps.
 *
 * From the form, with kinds carried over by name (`taughtContractInputs`),
 * then every input past the ones the page shows (`inputsPastTheTeachPage`),
 * unchanged, unless the form now has one by that name. One exception:
 * instructions that were free-form, re-taught by a client that sends no
 * inputs at all, keep the inputs they had. The Teach page shows a free-form
 * skill's inputs and sends them back, so this only catches a client that
 * never showed them; a taught-shaped skill whose inputs the person removed on
 * the page loses them, as asked.
 */
export function reteachContractInputs(input: {
  form: readonly TaughtInput[];
  base: readonly WorkSkillField[];
  baseWasFreeform: boolean;
}): WorkSkillField[] {
  if (input.baseWasFreeform && input.form.filter((i) => cleanText(i.name)).length === 0) {
    return input.base.map((field) => ({ ...field }));
  }
  const fromForm = taughtContractInputs(input.form, input.base);
  const taken = new Set(fromForm.map((field) => shownInputKey(field.name)));
  const unseen = inputsPastTheTeachPage(input.base).filter((field) => !taken.has(shownInputKey(field.name)));
  return [...fromForm, ...unseen.map((field) => ({ ...field }))];
}

/** Whether a version's contract says it was taught (Teach Juno wrote its provenance). */
export function isTaughtContract(contract: Pick<WorkSkillContract, "provenance"> | null | undefined): boolean {
  return taughtOrigin(contract?.provenance) !== null;
}

/**
 * The permission surface a form asks for, as the scanner and the consent check
 * fingerprint it. The same function on both sides of the wire is what makes an
 * acknowledgement checkable: the page fingerprints what it showed, the server
 * fingerprints what it is about to save, and the two must be equal for the
 * save to switch anything on.
 */
export function taughtPermissionFingerprint(
  form: Pick<TaughtSkillForm, "tools" | "connectors" | "domains">,
  base: WorkSkillContract = emptySkillContract()
): string {
  return permissionFingerprint(
    permissionSurfaceOf({
      requestedTools: form.tools,
      contract: { ...base, requestedConnectors: form.connectors, requestedDomains: form.domains },
    })
  );
}

/** The scanner's verdict on a form, exactly as the save will scan it. */
export function scanTaughtSkill(
  form: TaughtSkillForm,
  base: WorkSkillContract = emptySkillContract()
): { status: SkillSecurityStatus; findings: SkillSecurityFinding[] } {
  const scan = scanSkillVersion({
    name: cleanText(form.name),
    description: taughtDescription(form),
    instructions: renderTaughtInstructions(form),
    requestedTools: form.tools,
    contract: { ...base, requestedConnectors: form.connectors, requestedDomains: form.domains },
  });
  return { status: scan.status, findings: scan.findings };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

const line = (max: number) => z.string().max(max * 2).transform((value) => clipWords(oneLine(value), max));
const nameSchema = z.string().trim().regex(SKILL_CAPABILITY_NAME_PATTERN);

export const taughtSkillSaveSchema = z.object({
  /** A chat draft's key: a second save of the same draft lands on the first skill. */
  key: z.string().trim().min(1).max(MAX_KEY_CHARS).optional(),
  /** Refining an existing skill: the save mints its next version. */
  skillId: z.string().trim().min(1).max(MAX_ID_CHARS).optional(),
  /** Asked for explicitly; derived from the name when absent. */
  slug: z.string().trim().min(1).max(64).optional(),
  name: line(MAX_TAUGHT_NAME_CHARS).pipe(z.string().min(1)),
  whenToUse: line(MAX_TAUGHT_WHEN_CHARS).default(""),
  steps: z
    .array(z.string().max(MAX_TAUGHT_STEP_CHARS * 2))
    .max(MAX_TAUGHT_STEPS * 2)
    .transform((steps) => steps.map(oneLine).filter(Boolean))
    .pipe(
      z
        .array(z.string().max(MAX_TAUGHT_STEP_CHARS))
        .min(1)
        .max(MAX_TAUGHT_STEPS)
    ),
  inputs: z
    .array(
      z.object({
        name: line(MAX_INPUT_NAME_CHARS),
        description: line(MAX_INPUT_DESCRIPTION_CHARS).default(""),
        required: z.boolean().default(true),
      })
    )
    .max(MAX_TAUGHT_INPUTS)
    .default([]),
  doneWhen: line(MAX_TAUGHT_DONE_CHARS).default(""),
  rules: z.array(line(MAX_LIST_ITEM_CHARS)).max(MAX_TAUGHT_RULES).default([]),
  notes: z.array(line(MAX_LIST_ITEM_CHARS)).max(MAX_TAUGHT_SAVED_NOTES).default([]),
  questions: z.array(line(MAX_LIST_ITEM_CHARS)).max(MAX_TAUGHT_QUESTIONS).default([]),
  tools: z.array(nameSchema).max(MAX_TAUGHT_TOOLS).default([]),
  connectors: z.array(z.string().trim().regex(SKILL_CONNECTOR_NAME_PATTERN)).max(MAX_APPS).default([]),
  domains: z.array(z.string().trim().min(1).max(253)).max(MAX_DOMAINS).default([]),
  /** Where it applies: null is everywhere. Checked against the caller's projects. */
  projectId: z.string().trim().min(1).max(MAX_ID_CHARS).nullable().default(null),
  source: z
    .object({
      via: z.enum(["conversation", "walkthrough"]),
      conversationId: z.string().trim().min(1).max(MAX_ID_CHARS).nullable().default(null),
    })
    .default({ via: "walkthrough", conversationId: null }),
  /** The state the person asked for once saved. */
  enable: z.boolean().default(false),
  /** The permission fingerprint the page showed when the person ticked "I've reviewed". */
  acknowledged: z.string().max(MAX_ACKNOWLEDGED_CHARS).nullable().default(null),
});

export type TaughtSkillSave = z.infer<typeof taughtSkillSaveSchema>;

/**
 * The sentence a refused save body gets, by the first field that failed.
 *
 * Every refusal ends "Nothing was saved." so the person knows the page still
 * holds their edits. `field` is the top-level key, for a client that wants to
 * point at it; it is never shown on its own.
 */
export function taughtSaveRefusal(
  issues: readonly { path: readonly PropertyKey[]; code?: string }[]
): { field: string | null; message: string } {
  const first = issues[0];
  const field = first && typeof first.path[0] === "string" ? first.path[0] : null;
  const nested = first ? first.path.length > 1 : false;
  const end = " Nothing was saved.";
  switch (field) {
    case "name":
      return { field, message: `Give it a name of up to ${MAX_TAUGHT_NAME_CHARS} characters.${end}` };
    case "whenToUse":
      return { field, message: `Keep “when to use it” under ${MAX_TAUGHT_WHEN_CHARS} characters.${end}` };
    case "steps":
      return {
        field,
        message: `A skill needs 1 to ${MAX_TAUGHT_STEPS} steps, each under ${MAX_TAUGHT_STEP_CHARS} characters.${end}`,
      };
    case "inputs":
      return {
        field,
        message: nested
          ? `Each thing it asks for needs a name of up to ${MAX_INPUT_NAME_CHARS} characters.${end}`
          : `A skill can ask for at most ${MAX_TAUGHT_INPUTS} things each time.${end}`,
      };
    case "doneWhen":
      return { field, message: `Keep “done when” under ${MAX_TAUGHT_DONE_CHARS} characters.${end}` };
    case "rules":
      return { field, message: `A skill can have at most ${MAX_TAUGHT_RULES} rules, each under ${MAX_LIST_ITEM_CHARS} characters.${end}` };
    case "notes":
      return {
        field,
        message: `A skill keeps at most ${MAX_TAUGHT_SAVED_NOTES} notes, and each answered question becomes one.${end}`,
      };
    case "questions":
      return { field, message: `A skill can keep at most ${MAX_TAUGHT_QUESTIONS} open questions.${end}` };
    case "tools":
      return {
        field,
        message: nested
          ? `One of the tools isn’t a name a skill can ask for.${end}`
          : `A skill can ask for at most ${MAX_TAUGHT_TOOLS} tools.${end}`,
      };
    case "connectors":
      return {
        field,
        message: nested
          ? `One of the apps isn’t a name a skill can ask for.${end}`
          : `A skill can use at most ${MAX_TAUGHT_APPS} apps.${end}`,
      };
    case "domains":
      return {
        field,
        message: nested
          ? `One of the websites isn’t a valid address.${end}`
          : `A skill can list at most ${MAX_TAUGHT_DOMAINS} websites.${end}`,
      };
    case "projectId":
      return { field, message: `That project couldn’t be read.${end}` };
    case "acknowledged":
      return {
        field,
        message: `The review confirmation couldn’t be checked. Tick “I’ve reviewed it” again, or save it switched off.${end}`,
      };
    case "key":
    case "skillId":
    case "slug":
    case "source":
    case "enable":
      return { field, message: `This page sent something the server couldn’t read. Reload the page and try again.${end}` };
    default:
      return { field, message: `Something in this skill isn’t valid.${end}` };
  }
}

/** The form half of a save, for rendering and fingerprinting. */
export function formFromSave(save: TaughtSkillSave): TaughtSkillForm {
  return {
    name: save.name,
    whenToUse: save.whenToUse,
    steps: save.steps,
    inputs: save.inputs.filter((input) => input.name),
    doneWhen: save.doneWhen,
    rules: save.rules.filter(Boolean),
    notes: save.notes.filter(Boolean),
    questions: save.questions.filter(Boolean),
    tools: [...new Set(save.tools)],
    connectors: [...new Set(save.connectors)],
    domains: [...new Set(save.domains)],
  };
}

/**
 * Tools a save may ask for: the teachable list, plus — when refining — names
 * the version being replaced already asked for (an imported skill being
 * re-taught keeps what it had until the person removes it; it never gains a
 * name this list does not know).
 */
export function disallowedTaughtTools(tools: readonly string[], previous: readonly string[] = []): string[] {
  const allowed = new Set([...TEACHABLE_TOOL_IDS, ...previous]);
  return tools.filter((tool) => !allowed.has(tool));
}

/** The provenance a taught version records. Display only; part of no permission surface. */
export function taughtProvenance(input: {
  source: TaughtSource;
  key?: string | null;
  now: Date;
  previous?: Record<string, string>;
}): Record<string, string> {
  const out: Record<string, string> = { ...(input.previous ?? {}) };
  out["taught.via"] = input.source.via;
  out["taught.at"] = input.now.toISOString();
  if (input.source.conversationId) out["taught.conversationId"] = input.source.conversationId;
  if (input.key) out["taught.key"] = input.key;
  return out;
}

/** What a stored provenance map says about how a skill was taught, or null. */
export function taughtOrigin(
  provenance: Record<string, string> | null | undefined
): { via: "conversation" | "walkthrough"; conversationId: string | null; at: string | null } | null {
  const via = provenance?.["taught.via"];
  if (via !== "conversation" && via !== "walkthrough") return null;
  return {
    via,
    conversationId: provenance?.["taught.conversationId"] || null,
    at: provenance?.["taught.at"] || null,
  };
}

/** The slug a save uses: the one asked for when valid, else the name's. */
export function taughtSlug(save: Pick<TaughtSkillSave, "slug" | "name">): string | null {
  return (save.slug ? normalizeSkillSlug(save.slug) : null) ?? skillSlugFromName(save.name);
}

/** Whether rendered instructions fit a skill. */
export function taughtInstructionsFit(instructions: string): boolean {
  return instructions.length > 0 && instructions.length <= MAX_SKILL_INSTRUCTIONS_CHARS;
}

export type TeachEnableReason =
  | "kept_off"
  | "not_acknowledged"
  | "permissions_changed"
  | "blocked"
  | "scripts_unreviewed";

/**
 * Whether a save may leave the skill switched on, and whether it settles the
 * consent a widened permission surface waits for.
 *
 * On only when the person asked for on, the scanner did not block it, nothing
 * waits on scripts (those are reviewed file by file on the skill's page), and
 * the fingerprint they acknowledged is the fingerprint being saved. A stale
 * page — the draft edited in another tab, a tool removed after the box was
 * ticked — saves the skill switched off and says why, rather than switching on
 * a surface nobody looked at.
 */
export function teachEnableDecision(input: {
  wantsEnable: boolean;
  acknowledged: string | null;
  fingerprint: string;
  scanStatus: string;
  consentFor?: readonly string[];
}): { enabled: boolean; settleConsent: boolean; reason: TeachEnableReason | null } {
  if (input.scanStatus === "blocked") return { enabled: false, settleConsent: false, reason: "blocked" };
  if (!input.wantsEnable) return { enabled: false, settleConsent: false, reason: "kept_off" };
  if (!input.acknowledged) return { enabled: false, settleConsent: false, reason: "not_acknowledged" };
  if (input.acknowledged !== input.fingerprint) return { enabled: false, settleConsent: false, reason: "permissions_changed" };
  if ((input.consentFor ?? []).includes("scripts")) return { enabled: false, settleConsent: false, reason: "scripts_unreviewed" };
  return { enabled: true, settleConsent: (input.consentFor ?? []).includes("permissions"), reason: null };
}

export const TEACH_ENABLE_MESSAGES: Record<TeachEnableReason, string> = {
  kept_off: "Saved and kept off. It won’t run until you switch it on.",
  not_acknowledged: "Saved and kept off: switching it on needs you to confirm you’ve reviewed it.",
  permissions_changed:
    "Saved and kept off: what it may use changed after you reviewed it. Review it again to switch it on.",
  blocked: "Saved and kept off: the safety check refused one of its instructions.",
  scripts_unreviewed: "Saved and kept off: it has scripts that need reviewing on the skill’s page first.",
};

// ---------------------------------------------------------------------------
// What the routes answer
// ---------------------------------------------------------------------------

/** A saved taught skill, as the Teach page and the chat card read it back. */
export interface ClientTaughtSkill {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  currentVersion: number;
  projectId: string | null;
  securityStatus: string;
}

/** `POST /api/skills/teach`'s answer. */
export interface TaughtSkillSaved {
  outcome: "created" | "replayed" | "versioned";
  skill: ClientTaughtSkill;
  version: number;
  /** Why it is off when the person asked for on, or null. */
  reason: TeachEnableReason | null;
  message: string | null;
  /** The saved version still waits for a consent this page could not give (scripts). */
  requiresConsent: boolean;
}

/** `GET /api/skills/teach/[id]`: a skill to re-teach, with its steps when they read as steps. */
export interface TaughtSkillForEdit {
  skill: ClientTaughtSkill & { description: string; trust: string; sourceId: string | null };
  version: {
    version: number;
    instructions: string;
    requestedTools: string[];
    contract: WorkSkillContract;
    requiresConsent: boolean;
    consentFor: string[];
  } | null;
  /** The editable fields, or null when the instructions are free-form. */
  form: TaughtSkillForm | null;
  origin: ReturnType<typeof taughtOrigin>;
}

// ---------------------------------------------------------------------------
// Reading a draft back
// ---------------------------------------------------------------------------

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function stringList(raw: unknown, max: number): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string").slice(0, max) : [];
}

/**
 * A persisted draft, field by field, or nothing. The message serializer is a
 * whitelist, and a row that does not match is dropped here rather than handed
 * to a card that trusts it.
 */
export function readSkillDraft(raw: unknown): ClientSkillDraft | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const key = text(r, "key");
  const name = text(r, "name");
  const steps = stringList(r.steps, MAX_TAUGHT_STEPS);
  if (!key || !name || steps.length === 0) return undefined;
  const source = r.source && typeof r.source === "object" && !Array.isArray(r.source) ? (r.source as Record<string, unknown>) : {};
  const observed = r.observed && typeof r.observed === "object" && !Array.isArray(r.observed) ? (r.observed as Record<string, unknown>) : {};
  const scan = r.scan && typeof r.scan === "object" && !Array.isArray(r.scan) ? (r.scan as Record<string, unknown>) : {};
  const apps = Array.isArray(r.apps)
    ? r.apps.flatMap((app) => {
        if (!app || typeof app !== "object" || Array.isArray(app)) return [];
        const a = app as Record<string, unknown>;
        return typeof a.id === "string" && typeof a.label === "string" ? [{ id: a.id, label: a.label }] : [];
      })
    : [];
  return {
    version: 1,
    key,
    name,
    slug: text(r, "slug"),
    whenToUse: text(r, "whenToUse") ?? "",
    steps,
    inputs: readInputs(r.inputs),
    doneWhen: text(r, "doneWhen") ?? "",
    rules: stringList(r.rules, MAX_TAUGHT_RULES),
    questions: stringList(r.questions, MAX_TAUGHT_QUESTIONS),
    tools: stringList(r.tools, 16).filter((id) => TOOL_BY_ID.has(id)),
    apps: apps.slice(0, MAX_APPS),
    missingApps: stringList(r.missingApps, MAX_APPS),
    dropped: stringList(r.dropped, 16),
    observed: { tools: stringList(observed.tools, 16), apps: stringList(observed.apps, MAX_APPS) },
    source: {
      via: source.via === "walkthrough" ? "walkthrough" : "conversation",
      conversationId: typeof source.conversationId === "string" ? source.conversationId : null,
    },
    fromOutsideContent: r.fromOutsideContent === true,
    scan: {
      status: scan.status === "warning" ? "warning" : "clear",
      findings: Array.isArray(scan.findings)
        ? scan.findings.flatMap((finding) => {
            if (!finding || typeof finding !== "object") return [];
            const f = finding as Record<string, unknown>;
            return typeof f.code === "string" && typeof f.message === "string" ? [{ code: f.code, message: f.message }] : [];
          })
        : [],
    },
    createdAt: text(r, "createdAt") ?? new Date(0).toISOString(),
  };
}
