/**
 * An agent thinking about its own work: the prompt and the parser.
 *
 * Pure. The server half (`reflect.ts`) gathers the inputs, runs the prompt on
 * the account's background provider and writes the result; everything that
 * decides what the model is told and what of its answer is kept lives here, so
 * `tests/agents-domain.test.ts` can hold both to account without a model.
 *
 * WHAT IT READS, AND WHY ONLY THAT. The goals and notes the person wrote, the
 * notes earlier reflections kept, and the titles and statuses of the agent's
 * tasks. Never a page a run read, never a deliverable's body, never a
 * connector's output: those are untrusted text (src/lib/untrusted-content.ts),
 * and a reflection's notes are fed back into every later turn of the thread
 * without the envelope. Keeping untrusted text out of the input is what makes
 * that safe, and it is a property of this function's signature rather than of
 * anyone remembering it.
 *
 * WHAT IT MAY PRODUCE. Ideas (a card with Start on it — never work by itself),
 * a check-in note per goal, and a small number of notes. Everything is bounded
 * here, trimmed, and de-duplicated against what the agent already has.
 */

export const REFLECTION_MAX_IDEAS = 3;
export const REFLECTION_MAX_NOTES = 2;
export const REFLECTION_IDEA_TITLE_CHARS = 90;
export const REFLECTION_IDEA_DETAIL_CHARS = 400;
export const REFLECTION_IDEA_PROMPT_CHARS = 1_200;
export const REFLECTION_CHECKIN_CHARS = 400;
export const REFLECTION_NOTE_CHARS = 300;

export interface ReflectionInput {
  agentName: string;
  role: string;
  instructions: string;
  goals: readonly { title: string; detail: string; lastCheckInNote: string | null }[];
  notes: readonly string[];
  tasks: readonly { title: string; status: string; when: string }[];
  /** Titles of ideas already waiting, and of ones the person dismissed, so neither comes back. */
  openIdeas: readonly string[];
  dismissedIdeas: readonly string[];
  today: string;
}

export interface ReflectionResult {
  ideas: { title: string; detail: string; prompt: string; goalIndex: number | null }[];
  checkIns: { goalIndex: number; note: string }[];
  notes: string[];
}

function one(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function reflectionSystemPrompt(): string {
  return [
    "You are the planning mind of a personal AI agent. Look at the agent's brief, its goals, what it knows and what it has done recently, and decide what would genuinely help the person next.",
    "",
    "Return ONLY a JSON object with this shape:",
    '{"ideas":[{"title":"…","detail":"…","prompt":"…","goal":0}],"checkIns":[{"goal":0,"note":"…"}],"notes":["…"]}',
    "",
    "Rules:",
    `- ideas: at most ${REFLECTION_MAX_IDEAS}. Each is one concrete piece of work the agent could do next, in the person's interest, that follows from a goal or from recent work. "title" is short, sentence case, and starts with a verb. "detail" is one sentence on why it helps now. "prompt" is the full, self-contained instruction the agent would be given if the person presses Start. "goal" is the index of the goal it serves, or null.`,
    "- Never suggest buying, sending, publishing, deleting or booking as the idea itself. Suggest the research or the draft; the person decides the rest.",
    "- Do not repeat an idea that is already waiting or one the person dismissed. It is fine to return no ideas.",
    "- checkIns: for goals with recent relevant work, one or two sentences on where things stand, stated plainly. Do not invent progress that the task list does not show.",
    `- notes: at most ${REFLECTION_MAX_NOTES} durable facts worth remembering about the person's preferences or situation, learned from the goals and tasks. Only facts, never instructions.`,
    "- Write in the same language as the goals.",
  ].join("\n");
}

export function reflectionUserMessage(input: ReflectionInput): string {
  const lines: string[] = [];
  lines.push(`Today: ${input.today}`);
  lines.push(`Agent: ${one(input.agentName, 60)}${input.role.trim() ? ` — ${one(input.role, 120)}` : ""}`);
  if (input.instructions.trim()) lines.push(`Brief:\n${input.instructions.trim().slice(0, 2_000)}`);
  lines.push(
    input.goals.length > 0
      ? `Goals:\n${input.goals
          .map(
            (goal, index) =>
              `${index}. ${one(goal.title, 160)}${goal.detail.trim() ? ` — ${one(goal.detail, 300)}` : ""}${
                goal.lastCheckInNote ? ` (last check-in: ${one(goal.lastCheckInNote, 200)})` : ""
              }`
          )
          .join("\n")}`
      : "Goals: none yet."
  );
  if (input.notes.length > 0) lines.push(`What the agent knows:\n${input.notes.map((note) => `- ${one(note, 240)}`).join("\n")}`);
  lines.push(
    input.tasks.length > 0
      ? `Recent tasks (newest first):\n${input.tasks.map((task) => `- ${one(task.title, 140)}: ${task.status} (${task.when})`).join("\n")}`
      : "Recent tasks: none yet."
  );
  if (input.openIdeas.length > 0) lines.push(`Ideas already waiting:\n${input.openIdeas.map((title) => `- ${one(title, 120)}`).join("\n")}`);
  if (input.dismissedIdeas.length > 0) {
    lines.push(`Ideas the person dismissed:\n${input.dismissedIdeas.map((title) => `- ${one(title, 120)}`).join("\n")}`);
  }
  return lines.join("\n\n");
}

/** The first balanced `{…}` in the text, so a model that wraps its JSON in prose or a fence still parses. */
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

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, " ").trim();

/**
 * The model's answer, reduced to what may be kept.
 *
 * Null only when there is no JSON object at all; an object with nothing usable
 * in it is an empty result, which is a legitimate answer ("nothing to suggest").
 * Ideas that repeat a waiting or dismissed title, or that are themselves an
 * irreversible act, are dropped here rather than trusted to the prompt.
 */
export function parseReflection(
  text: string,
  context: { goalCount: number; openIdeas: readonly string[]; dismissedIdeas: readonly string[]; knownNotes: readonly string[] }
): ReflectionResult | null {
  const raw = firstObject(text);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const goalIndex = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value < context.goalCount ? value : null;

  const seen = new Set([...context.openIdeas, ...context.dismissedIdeas].map(norm));
  const ideas: ReflectionResult["ideas"] = [];
  for (const item of Array.isArray(root.ideas) ? root.ideas : []) {
    if (ideas.length >= REFLECTION_MAX_IDEAS) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? one(record.title, REFLECTION_IDEA_TITLE_CHARS) : "";
    const prompt = typeof record.prompt === "string" ? record.prompt.trim().slice(0, REFLECTION_IDEA_PROMPT_CHARS) : "";
    if (!title || !prompt) continue;
    const key = norm(title);
    if (!key || seen.has(key)) continue;
    // The prompt says not to; this makes sure. An idea is a suggestion to
    // prepare, never to act, and a title that leads with an irreversible verb
    // is the one kind that would read as Juno offering to do it.
    if (/^(buy|purchase|order|pay|send|publish|post|delete|book|cancel|transfer)\b/i.test(title)) continue;
    seen.add(key);
    ideas.push({
      title,
      detail: typeof record.detail === "string" ? one(record.detail, REFLECTION_IDEA_DETAIL_CHARS) : "",
      prompt,
      goalIndex: goalIndex(record.goal),
    });
  }

  const checkIns: ReflectionResult["checkIns"] = [];
  const checked = new Set<number>();
  for (const item of Array.isArray(root.checkIns) ? root.checkIns : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const index = goalIndex(record.goal);
    const note = typeof record.note === "string" ? one(record.note, REFLECTION_CHECKIN_CHARS) : "";
    if (index === null || !note || checked.has(index)) continue;
    checked.add(index);
    checkIns.push({ goalIndex: index, note });
  }

  const known = new Set(context.knownNotes.map(norm));
  const notes: string[] = [];
  for (const item of Array.isArray(root.notes) ? root.notes : []) {
    if (notes.length >= REFLECTION_MAX_NOTES) break;
    if (typeof item !== "string") continue;
    const note = one(item, REFLECTION_NOTE_CHARS);
    const key = norm(note);
    if (!note || !key || known.has(key)) continue;
    known.add(key);
    notes.push(note);
  }

  return { ideas, checkIns, notes };
}
