/**
 * The Teach page's editor, as data: what the person is editing, every edit as
 * a pure function of the state before it, and what Save sends.
 *
 * Kept apart from the components so each rule — Enter after a step adds the
 * next one, an empty step is never saved, an answered question becomes a note
 * and an unanswered one is asked at run time, the fingerprint the review box
 * acknowledges is exactly the one the server will compare — has a test that
 * needs no DOM (tests/teach-skill.test.ts).
 */

import {
  MAX_TAUGHT_INPUTS,
  MAX_TAUGHT_NOTES,
  MAX_TAUGHT_RULES,
  MAX_TAUGHT_SAVED_NOTES,
  MAX_TAUGHT_STEP_CHARS,
  MAX_TAUGHT_STEPS,
  emptyTaughtForm,
  formFromDraft,
  scanTaughtSkill,
  taughtPermissionFingerprint,
  teachableTool,
  type ClientSkillDraft,
  type TaughtApp,
  type TaughtSkillForm,
} from "@/lib/skills/teach";
import { skillSlugFromName, type WorkSkillContract } from "@/lib/work/skills";

export interface TeachItem {
  id: string;
  text: string;
}

export interface TeachInputItem {
  id: string;
  name: string;
  description: string;
  required: boolean;
}

export interface TeachQuestionItem {
  id: string;
  question: string;
  answer: string;
}

export interface TeachEditorState {
  name: string;
  whenToUse: string;
  steps: TeachItem[];
  inputs: TeachInputItem[];
  doneWhen: string;
  rules: TeachItem[];
  notes: TeachItem[];
  questions: TeachQuestionItem[];
  tools: string[];
  connectors: string[];
  domains: string[];
  /** Where it applies: null is everywhere. */
  projectId: string | null;
}

let sequence = 0;
/** A stable key for a row while it is being edited. Never saved. */
export function teachItemId(): string {
  sequence += 1;
  return `t${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const item = (text: string): TeachItem => ({ id: teachItemId(), text });

export function stateFromForm(form: TaughtSkillForm, projectId: string | null = null): TeachEditorState {
  return {
    name: form.name,
    whenToUse: form.whenToUse,
    steps: (form.steps.length > 0 ? form.steps : [""]).map(item),
    inputs: form.inputs.map((input) => ({ id: teachItemId(), ...input })),
    doneWhen: form.doneWhen,
    rules: form.rules.map(item),
    notes: form.notes.map(item),
    questions: form.questions.map((question) => ({ id: teachItemId(), question, answer: "" })),
    tools: [...form.tools],
    connectors: [...form.connectors],
    domains: [...form.domains],
    projectId,
  };
}

export function stateFromDraft(draft: ClientSkillDraft): TeachEditorState {
  return stateFromForm(formFromDraft(draft));
}

export function emptyTeachState(): TeachEditorState {
  return stateFromForm(emptyTaughtForm());
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/** An answered question, as the note the skill keeps. */
export function answeredNote(question: string, answer: string): string {
  const q = clean(question).replace(/[?？]*$/, "?");
  return `${q} ${clean(answer)}`;
}

/**
 * The form a state saves as: empty rows dropped, answered questions moved to
 * notes (the person's answer is now part of the method), unanswered ones kept
 * as questions the skill asks before it starts.
 */
export function formFromState(state: TeachEditorState): TaughtSkillForm {
  const answered = state.questions.filter((q) => clean(q.answer));
  return {
    name: clean(state.name),
    whenToUse: clean(state.whenToUse),
    steps: state.steps.map((s) => clean(s.text)).filter(Boolean),
    inputs: state.inputs
      .filter((input) => clean(input.name))
      .map((input) => ({ name: clean(input.name), description: clean(input.description), required: input.required })),
    doneWhen: clean(state.doneWhen),
    rules: state.rules.map((r) => clean(r.text)).filter(Boolean),
    notes: [...state.notes.map((n) => clean(n.text)).filter(Boolean), ...answered.map((q) => answeredNote(q.question, q.answer))],
    questions: state.questions.filter((q) => !clean(q.answer)).map((q) => clean(q.question)).filter(Boolean),
    tools: [...state.tools],
    connectors: [...state.connectors],
    domains: [...state.domains],
  };
}

// ---------------------------------------------------------------------------
// Editing a list of rows
// ---------------------------------------------------------------------------

export type TeachListAction =
  | { type: "insert"; after: number; id?: string; text?: string }
  | { type: "update"; id: string; text: string }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; by: -1 | 1 }
  | { type: "reorder"; ids: readonly string[] };

/**
 * One edit to a list of rows. Insert after index -1 puts a row first; a move
 * past either end is a no-op; a reorder that does not name exactly the rows
 * there are (a stale drag) is ignored rather than losing one.
 */
export function applyListAction(items: readonly TeachItem[], action: TeachListAction, max = MAX_TAUGHT_STEPS): TeachItem[] {
  switch (action.type) {
    case "insert": {
      if (items.length >= max) return [...items];
      const at = Math.max(0, Math.min(items.length, action.after + 1));
      const next = [...items];
      next.splice(at, 0, { id: action.id ?? teachItemId(), text: action.text ?? "" });
      return next;
    }
    case "update":
      return items.map((row) => (row.id === action.id ? { ...row, text: action.text } : row));
    case "remove":
      return items.filter((row) => row.id !== action.id);
    case "move": {
      const from = items.findIndex((row) => row.id === action.id);
      const to = from + action.by;
      if (from < 0 || to < 0 || to >= items.length) return [...items];
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    }
    case "reorder": {
      if (action.ids.length !== items.length) return [...items];
      const byId = new Map(items.map((row) => [row.id, row]));
      const next = action.ids.map((id) => byId.get(id));
      return next.every((row): row is TeachItem => row !== undefined) && new Set(action.ids).size === items.length
        ? next
        : [...items];
    }
  }
}

export const LIST_LIMITS = {
  steps: MAX_TAUGHT_STEPS,
  rules: MAX_TAUGHT_RULES,
  notes: MAX_TAUGHT_NOTES,
  inputs: MAX_TAUGHT_INPUTS,
} as const;

// ---------------------------------------------------------------------------
// Reading the state back to the person
// ---------------------------------------------------------------------------

export interface TeachProblem {
  field: "name" | "steps" | "notes";
  message: string;
}

/** What stops a save, in the order the page shows them. */
export function teachProblems(state: TeachEditorState): TeachProblem[] {
  const problems: TeachProblem[] = [];
  const name = clean(state.name);
  if (!name) problems.push({ field: "name", message: "Give it a name." });
  else if (!skillSlugFromName(name)) problems.push({ field: "name", message: "Use at least one letter or number in the name." });
  const steps = state.steps.map((s) => clean(s.text)).filter(Boolean);
  if (steps.length === 0) problems.push({ field: "steps", message: "Add at least one step." });
  if (steps.length > MAX_TAUGHT_STEPS) problems.push({ field: "steps", message: `A skill can have at most ${MAX_TAUGHT_STEPS} steps.` });
  if (steps.some((s) => s.length > MAX_TAUGHT_STEP_CHARS)) {
    problems.push({ field: "steps", message: `Keep each step under ${MAX_TAUGHT_STEP_CHARS} characters; split a long one in two.` });
  }
  // Every answered question is saved as a note (`formFromState`), so the
  // limit the server holds is on the two together, not on typed notes alone.
  if (formFromState(state).notes.length > MAX_TAUGHT_SAVED_NOTES) {
    problems.push({
      field: "notes",
      message: `A skill keeps at most ${MAX_TAUGHT_SAVED_NOTES} notes, and each answered question becomes one. Remove a note, or clear an answer so it asks you each time.`,
    });
  }
  return problems;
}

/** "Search the web, Gmail and Run code", or "" when it lists nothing. */
export function listPhrase(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function toolLabel(id: string): string {
  return teachableTool(id)?.label ?? id;
}

export function appLabel(id: string, apps: readonly TaughtApp[]): string {
  return apps.find((app) => app.id === id)?.label ?? id;
}

/** One line the review reads back: "/file-invoices · 4 steps · uses Gmail and Search the web · everywhere". */
export function teachSummary(
  state: TeachEditorState,
  ctx: { apps: readonly TaughtApp[]; projects: readonly { id: string; name: string }[] }
): string {
  const form = formFromState(state);
  const slug = skillSlugFromName(form.name);
  const uses = [...form.tools.map(toolLabel), ...form.connectors.map((id) => appLabel(id, ctx.apps))];
  const project = state.projectId ? ctx.projects.find((p) => p.id === state.projectId)?.name ?? "one project" : null;
  return [
    slug ? `/${slug}` : null,
    `${form.steps.length} step${form.steps.length === 1 ? "" : "s"}`,
    uses.length > 0 ? `uses ${listPhrase(uses)}` : "no specific tools",
    project ? `only in ${project}` : "everywhere",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The fingerprint the review box acknowledges: the one the server recomputes on save. */
export function acknowledgementFingerprint(state: TeachEditorState, base?: WorkSkillContract): string {
  return taughtPermissionFingerprint(formFromState(state), base);
}

/** The scanner's verdict, live, by the function the save runs. */
export function teachScan(state: TeachEditorState, base?: WorkSkillContract) {
  return scanTaughtSkill(formFromState(state), base);
}

/** What Save sends (`taughtSkillSaveSchema`). */
export function teachSavePayload(
  state: TeachEditorState,
  opts: {
    key?: string | null;
    skillId?: string | null;
    source: { via: "conversation" | "walkthrough"; conversationId: string | null };
    enable: boolean;
    acknowledged: string | null;
  }
): Record<string, unknown> {
  const form = formFromState(state);
  return {
    ...(opts.key ? { key: opts.key } : {}),
    ...(opts.skillId ? { skillId: opts.skillId } : {}),
    name: form.name,
    whenToUse: form.whenToUse,
    steps: form.steps,
    inputs: form.inputs,
    doneWhen: form.doneWhen,
    rules: form.rules,
    notes: form.notes,
    questions: form.questions,
    tools: form.tools,
    connectors: form.connectors,
    domains: form.domains,
    projectId: state.projectId,
    source: opts.source,
    enable: opts.enable,
    acknowledged: opts.enable ? opts.acknowledged : null,
  };
}

/** A comparable snapshot, for "you have unsaved changes". */
export function teachSnapshot(state: TeachEditorState): string {
  return JSON.stringify({ ...formFromState(state), projectId: state.projectId });
}

/** What a permission row shows. */
export interface TeachPermissionRow {
  kind: "tool" | "app" | "domain";
  id: string;
  label: string;
  description: string;
  /** This conversation used it: evidence, not a grant. */
  observed: boolean;
  /** An app the account has connected (always true for tools and domains). */
  connected: boolean;
  sensitive: boolean;
}

export function permissionRows(
  state: Pick<TeachEditorState, "tools" | "connectors" | "domains">,
  ctx: { apps: readonly TaughtApp[]; observed?: { tools: readonly string[]; apps: readonly string[] } }
): TeachPermissionRow[] {
  const tools = state.tools.map((id): TeachPermissionRow => {
    const known = teachableTool(id);
    return {
      kind: "tool",
      id,
      label: known?.label ?? id,
      description: known?.description ?? "Kept from an earlier version of this skill.",
      observed: ctx.observed?.tools.includes(id) ?? false,
      connected: true,
      sensitive: known?.sensitive ?? true,
    };
  });
  const apps = state.connectors.map((id): TeachPermissionRow => {
    const app = ctx.apps.find((candidate) => candidate.id === id);
    return {
      kind: "app",
      id,
      label: app?.label ?? id,
      description: app ? "Use this connected app, asking you first before anything it can’t undo." : "Not connected right now.",
      observed: ctx.observed?.apps.includes(id) ?? false,
      connected: Boolean(app),
      sensitive: false,
    };
  });
  const domains = state.domains.map((id): TeachPermissionRow => ({
    kind: "domain",
    id,
    label: id,
    // Recorded, never enforced: chat search has no per-site allowlist to keep
    // a skill to (`chatSkillGrantLayer`), so the row says so.
    description: "A website an earlier version asked to reach. Kept as a record; a chat can’t limit search to it.",
    observed: false,
    connected: true,
    sensitive: true,
  }));
  return [...tools, ...apps, ...domains];
}
