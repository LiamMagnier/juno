/**
 * What a subagent is called: a name made from the work it was given, never a
 * roll call. "Worker 2" says nothing a person can act on; "Reset form checker"
 * says which agent to open when the reset form looks wrong.
 *
 * Pure and deterministic (no model call): the same title or task always gives
 * the same name, on every surface. The Swift twin is
 * native/Packages/JunoCode/Sources/JunoCodeCore/CodeV2/CodeV2AgentNames.swift;
 * tests/code-v2-agent-names.test.ts pins the cases both must agree on.
 *
 * The rule, in order:
 *  1. A label the engine chose on purpose ("Hook audit", "Candidate B",
 *     "Architect", "Verifier") is kept. Only a role word with an optional
 *     number ("Worker 2", "Builder", "Explorer") is replaced.
 *  2. The title, else the task's first line, read as an instruction:
 *     "Map the auth middleware" → "Auth middleware mapper".
 *  3. Else read as the thing being made: "Cart total regression suite" →
 *     "Regression suite writer".
 *  4. Else the role, in words ("Explorer", "Builder").
 * Two agents that land on the same name are told apart by a number after the
 * first: "Route builder", "Route builder 2".
 */
import type { AgentRole, SubagentItem, TeamPhase } from "./contracts";

export interface AgentNameSource {
  label?: string;
  title?: string;
  task?: string;
  role: AgentRole;
  phase?: TeamPhase;
}

/** The longest name a row shows before it drops to the head noun alone. */
export const AGENT_NAME_MAX_CHARS = 26;

const GENERIC_LABEL = /^(?:worker|builder|agent|sub-?agent|helper|explorer|task|job)\s*#?\s*\d*$/i;

/** A label that is only a role and a number, which the work itself names better. */
export function isGenericAgentLabel(label: string | undefined): boolean {
  return !label || !label.trim() || GENERIC_LABEL.test(label.trim());
}

/**
 * Instruction verbs and the agent noun each makes. Keyed by the base form;
 * `verbBase` reads "redesigning", "checks" and "mapped" as their base.
 */
export const AGENT_VERB_NOUNS: Readonly<Record<string, string>> = {
  add: "builder", build: "builder", create: "builder", implement: "builder", make: "builder", scaffold: "builder", wire: "builder", support: "builder",
  fix: "fixer", repair: "fixer", patch: "fixer", resolve: "fixer", debug: "debugger",
  redesign: "redesigner", design: "designer", restyle: "stylist", style: "stylist", theme: "stylist", polish: "polisher",
  map: "mapper", trace: "tracer", find: "finder", locate: "finder", search: "searcher", explore: "explorer", scan: "scanner", list: "lister",
  check: "checker", verify: "verifier", validate: "validator", confirm: "checker", test: "tester",
  review: "reviewer", audit: "auditor", inspect: "inspector", analyze: "analyst", analyse: "analyst", investigate: "investigator", research: "researcher", read: "reader", study: "researcher",
  write: "writer", draft: "writer", document: "writer", summarize: "summarizer", summarise: "summarizer", explain: "explainer", plan: "planner", outline: "planner",
  refactor: "refactorer", clean: "cleaner", tidy: "cleaner", simplify: "simplifier", migrate: "migrator", port: "porter", convert: "converter", translate: "translator", localize: "localizer",
  update: "updater", upgrade: "upgrader", bump: "upgrader", replace: "updater", swap: "updater", change: "updater", edit: "editor", rewrite: "rewriter",
  remove: "remover", delete: "remover", drop: "remover", rename: "renamer", move: "mover", extract: "extractor", split: "splitter", merge: "merger",
  optimize: "optimizer", optimise: "optimizer", speed: "optimizer", profile: "profiler", benchmark: "benchmarker", measure: "measurer",
  lint: "linter", format: "formatter", deploy: "shipper", ship: "shipper", release: "shipper", configure: "configurer", setup: "configurer", set: "configurer", install: "configurer",
  integrate: "integrator", connect: "integrator", reproduce: "reproducer", compare: "comparer", prototype: "prototyper", generate: "generator",
  collect: "collector", gather: "collector", harden: "hardener", secure: "hardener", monitor: "watcher", sort: "sorter", tag: "tagger", label: "tagger",
};

/** Words that end the object of an instruction: what follows says how or where, not what. */
const BREAK_WORDS = new Set([
  "for", "to", "in", "into", "on", "onto", "with", "without", "by", "from", "so", "that", "which", "and", "or", "then", "before", "after",
  "using", "via", "across", "against", "under", "over", "at", "of", "while", "when", "because", "if", "but", "as", "than", "per", "through",
  "is", "are", "was", "were", "should", "must", "can", "will", "does", "do", "don't", "keep", "keeping",
]);

/** Words that carry no subject of their own. */
const SKIP_WORDS = new Set([
  "the", "a", "an", "every", "each", "all", "any", "some", "our", "my", "your", "its", "their", "this", "that", "these", "those", "it", "them",
  "new", "existing", "current", "remaining", "last", "other", "more", "few", "up", "out", "down", "back", "away", "off", "missing", "broken",
  "api", "src", "lib", "app", "components", "get", "post", "put", "patch", "delete", "head", "options",
]);

/** Heads that say what kind of thing, not which one: dropped first when a name is too long. */
const GENERIC_HEADS = new Set([
  "service", "services", "page", "pages", "form", "flow", "module", "modules", "component", "components", "screen", "view", "file", "files",
  "function", "class", "code", "logic", "layer", "system", "feature", "route", "routes", "endpoint", "handler", "helper", "util", "utils", "script",
]);

/** Nouns of things a worker writes rather than builds. */
const WRITTEN_THINGS = new Set(["test", "tests", "suite", "spec", "specs", "coverage", "docs", "doc", "readme", "guide", "changelog", "notes", "comments", "copy", "report", "summary"]);

/** The lexicon's own entries only: "constructor" or "toString" must not reach Object.prototype. */
const nounFor = (verb: string): string | undefined => (Object.prototype.hasOwnProperty.call(AGENT_VERB_NOUNS, verb) ? AGENT_VERB_NOUNS[verb] : undefined);

/** A verb's base form, or null when no form of it is in the lexicon. */
export function verbBase(word: string): string | null {
  const w = word.toLowerCase();
  if (nounFor(w)) return w;
  const tries: string[] = [];
  if (w.endsWith("ing")) tries.push(w.slice(0, -3), `${w.slice(0, -3)}e`, w.slice(0, -4));
  if (w.endsWith("ies")) tries.push(`${w.slice(0, -3)}y`);
  if (w.endsWith("es")) tries.push(w.slice(0, -2));
  if (w.endsWith("s")) tries.push(w.slice(0, -1));
  if (w.endsWith("ed")) tries.push(w.slice(0, -2), w.slice(0, -1), w.slice(0, -3));
  return tries.find((t) => nounFor(t)) ?? null;
}

/** "useCartTotal" → ["use","cart","total"]; "/api/cart/total" → ["api","cart","total"]; "x.tsx" → ["x"]. */
function splitToken(raw: string): string[] {
  const token = raw.replace(/^[`'"([{<]+|[`'")\]}>.,:;!?]+$/g, "");
  if (!token) return [];
  if (token.includes("/")) {
    const parts = token.split("/").filter(Boolean).map((p) => p.replace(/\.[a-z0-9]{1,5}$/i, ""));
    return parts.slice(-2).flatMap(splitToken);
  }
  const bare = token.replace(/\.[a-z0-9]{1,5}$/i, "");
  // A hyphenated word ("client-side") stays one word; camelCase and snake_case come apart.
  if (/[a-z][A-Z]/.test(bare) || bare.includes("_")) {
    const words = bare.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/).filter(Boolean);
    // A React hook's "use" is not part of what it is about.
    return (words[0]?.toLowerCase() === "use" && words.length > 1 ? words.slice(1) : words).map((p) => p.toLowerCase());
  }
  return [bare];
}

/** Keep short all-caps words (API, UI, CSS) as written; lower everything else. */
function caseWord(word: string): string {
  return /^[A-Z]{2,6}s?$/.test(word) ? word : word.toLowerCase();
}

/** The object of a phrase: content words up to the first break, at most the last two (where English keeps its head noun). */
function subjectOf(words: readonly string[]): string[] {
  return contentWords(words).slice(-2);
}

/** Every content word of a phrase, up to the first break. */
function contentWords(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of words) {
    const lower = raw.toLowerCase().replace(/[.,:;!?]+$/, "");
    if (out.length && (BREAK_WORDS.has(lower) || (lower.endsWith("ing") && lower.length > 5))) break;
    if (!out.length && BREAK_WORDS.has(lower)) continue;
    for (const part of splitToken(raw)) {
      const p = part.toLowerCase();
      if (!p || SKIP_WORDS.has(p) || !/[a-z]/.test(p)) continue;
      out.push(caseWord(part));
    }
    if (raw.trim().endsWith(".") || raw.trim().endsWith(":")) break;
  }
  return out;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function compose(subject: string[], noun: string): string | null {
  if (!subject.length) return null;
  // The thing and the doer can be the same word ("tests" + "tester"): say it once.
  const head = subject[subject.length - 1]!.toLowerCase();
  if (head === noun || `${head}er` === noun || `${head}r` === noun) subject = subject.slice(0, -1);
  if (!subject.length) return null;
  // Too long for a row: keep the two words nearest the noun, then, if still
  // too long, the one that tells this agent apart ("reconciliation", not "service").
  const fits = (words: string[]) => `${words.join(" ")} ${noun}`.length <= AGENT_NAME_MAX_CHARS;
  while (subject.length > 2 && !fits(subject)) subject = subject.slice(1);
  if (subject.length === 2 && !fits(subject)) subject = GENERIC_HEADS.has(subject[1]!.toLowerCase()) ? [subject[0]!] : [subject[1]!];
  return capitalize(`${subject.join(" ")} ${noun}`);
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

function words(text: string): string[] {
  return text.replace(/^[-*•\d.)\s]+/, "").split(/\s+/).filter(Boolean);
}

/** "Map the auth middleware" → "Auth middleware mapper"; null when it does not open with a known verb. */
export function nameFromInstruction(text: string): string | null {
  const w = words(firstLine(text));
  // "Please", "Then" and "Also" open many tasks without being the instruction.
  while (w.length && /^(please|then|also|now|next|first|finally)[,:]?$/i.test(w[0]!)) w.shift();
  const base = w[0] ? verbBase(w[0].replace(/[,:]$/, "")) : null;
  if (!base) return null;
  let rest = w.slice(1);
  // "Set up the CI" / "Clean up the logs": the particle belongs to the verb.
  if (rest[0] && /^(up|out|over|through|into)$/i.test(rest[0])) rest = rest.slice(1);
  const noun = nounFor(base)!;
  // "Investigate why the webhook retries": the subject is the first thing named after the question word.
  if (rest[0] && /^(why|how|what|where|whether|when|which|who)$/i.test(rest[0])) return compose(contentWords(rest.slice(1)).slice(0, 1), noun);
  // "Write tests for the reset form": the subject is what the tests are for.
  const object = subjectOf(rest);
  if (object.length && WRITTEN_THINGS.has(object[object.length - 1]!.toLowerCase()) && /^(write|add|create|draft|document)$/.test(base)) {
    const target = rest.findIndex((x) => /^(for|of|on)$/i.test(x));
    const about = target >= 0 ? subjectOf(rest.slice(target + 1)) : [];
    return compose([...about, object[object.length - 1]!.toLowerCase().replace(/s$/, "")], "writer") ?? compose(object, "writer");
  }
  return compose(object, noun);
}

/** "Cart total regression suite" → "Regression suite writer"; a deliverable read as a noun phrase. */
export function nameFromThing(text: string, role: AgentRole, phase?: TeamPhase): string | null {
  const subject = subjectOf(words(firstLine(text)));
  if (!subject.length) return null;
  const head = subject[subject.length - 1]!.toLowerCase();
  const noun = WRITTEN_THINGS.has(head)
    ? "writer"
    : role === "explorer"
      ? "explorer"
      : role === "reviewer" || phase === "verify"
        ? "reviewer"
        : role === "architect" || phase === "plan"
          ? "planner"
          : "builder";
  return compose(subject, noun);
}

const ROLE_WORD: Record<AgentRole, string> = {
  orchestrator: "Lead",
  worker: "Builder",
  explorer: "Explorer",
  reviewer: "Reviewer",
  compaction: "Compaction",
  architect: "Architect",
};

/** One agent's name, before its run is checked for repeats. */
export function agentDisplayName(source: AgentNameSource): string {
  if (!isGenericAgentLabel(source.label)) return source.label!.trim();
  const title = firstLine(source.title);
  const task = firstLine(source.task);
  return (
    (title && nameFromInstruction(title)) ||
    (task && nameFromInstruction(task)) ||
    (title && nameFromThing(title, source.role, source.phase)) ||
    (task && nameFromThing(task, source.role, source.phase)) ||
    (source.role === "worker" && source.phase === "verify" ? "Verifier" : ROLE_WORD[source.role])
  );
}

/**
 * Every agent's name in a run, keyed by agent id, in the order given: the
 * first "Route builder" keeps the name, the next is "Route builder 2".
 */
export function agentDisplayNames(agents: readonly Pick<SubagentItem, "agentId" | "label" | "title" | "task" | "role" | "phase">[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const agent of agents) {
    if (out.has(agent.agentId)) continue;
    const name = agentDisplayName(agent);
    const key = name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    out.set(agent.agentId, count === 1 ? name : `${name} ${count}`);
  }
  return out;
}
