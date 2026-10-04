/**
 * The Alevr evaluation suite (BRIEF §53): one task per category, each with a
 * deterministic grader and an authored mock response.
 *
 * Three run modes, always labelled on every record:
 *
 *   mock     — the grader runs on the AUTHORED response below. Proves the
 *              harness, the graders and the router's choices; says nothing
 *              about any model's quality. Latency is the router's estimate,
 *              cost is the routed model's price for the mock's token counts.
 *   live     — a real provider call through `streamChat` (src/lib/llm.ts),
 *              only when the routed model's provider key exists and
 *              EVAL_LIVE=1. Latency, tokens and cost are measured.
 *   not_run  — the category needs infrastructure a single model call does not
 *              exercise (database persistence, a browser, a VM, the research
 *              engine). Recorded with the reason and the harness that does
 *              cover it, never as a pass.
 *
 * Graders check observable output only: word counts, a parsed CSV, executed
 * code (a separate Node process under `--permission`, with a timeout),
 * headings, citations.
 */

import { spawnSync } from "node:child_process";
import type { ClientSource } from "@/types/chat";

export const EVAL_CATEGORIES = [
  "everyday_chat",
  "reasoning",
  "coding",
  "tool_use",
  "search",
  "deep_research",
  "memory",
  "long_context",
  "agent_persistence",
  "browser_tasks",
  "computer_use",
  "artifacts",
  "documents",
  "spreadsheets",
  "slides",
  "multilingual",
  "instruction_following",
] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export interface EvalOutput {
  text: string;
  sources?: ClientSource[];
  /** Client tool calls the model made (live: counted from the stream). */
  toolCalls?: number;
}

export interface GradeResult {
  success: boolean;
  notes: string;
  /** 0..1 for tasks that should cite; null when citations do not apply. */
  citationQuality: number | null;
}

export interface MockResponse extends EvalOutput {
  inputTokens: number;
  outputTokens: number;
}

export interface EvalTaskSpec {
  id: string;
  category: EvalCategory;
  prompt: string;
  /** What the router is told about the request. */
  route: { wantsWebSearch?: boolean; toolsOffered?: number; contextTokens?: number };
  /** Live mode needs the probe tools (tool_use) — see runner. */
  needsProbeTools?: boolean;
  grade: (output: EvalOutput) => GradeResult;
  mock: MockResponse;
  /** Set for categories a single model call cannot exercise. */
  notRunnable?: { reason: string; coveredBy: string | null };
  /** Long or expensive in live mode; only with EVAL_LIVE_EXPENSIVE=1. */
  expensive?: boolean;
}

const ok = (success: boolean, notes: string, citationQuality: number | null = null): GradeResult => ({
  success,
  notes,
  citationQuality,
});

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/** Fraction of sources that look citable: an https URL and a non-empty title. */
export function citationQuality(sources: readonly ClientSource[] | undefined): number | null {
  if (!sources || sources.length === 0) return 0;
  const good = sources.filter((s) => /^https:\/\/[^\s/]+\.[^\s/]+/.test(s.url) && s.title.trim().length > 0).length;
  return Math.round((good / sources.length) * 100) / 100;
}

/** Pull the first fenced code block (or the whole text). */
function codeFrom(text: string): string {
  const fence = text.match(/```(?:[a-z]*)\n([\s\S]*?)```/i);
  return fence ? fence[1] : text;
}

/**
 * Run model-written code against the cases in a SEPARATE Node process under
 * the permission model (`--permission`: no file system, no child processes, no
 * workers, no addons) with a ten-second timeout. `node:vm` alone is not a
 * security boundary, and in live mode this is code a model wrote.
 */
const EVAL_CODE_TIMEOUT_MS = 10_000;

function runIsPalindrome(code: string): { ok: boolean; detail: string } {
  const cases: [string, boolean][] = [
    ["A man, a plan, a canal: Panama", true],
    ["racecar", true],
    ["hello", false],
    ["", true],
    ["No 'x' in Nixon", true],
  ];
  const harness = `
    let src = ""; process.stdin.on("data", (d) => (src += d)); process.stdin.on("end", () => {
      let f; try { f = new Function(src + "\\n;return typeof isPalindrome === 'function' ? isPalindrome : undefined;")(); }
      catch (e) { console.log(JSON.stringify({ ok: false, detail: "does not compile" })); return; }
      if (typeof f !== "function") { console.log(JSON.stringify({ ok: false, detail: "no isPalindrome function" })); return; }
      for (const [input, expected] of ${JSON.stringify(cases)}) {
        let got; try { got = f(input); } catch { got = "threw"; }
        if (got !== expected) { console.log(JSON.stringify({ ok: false, detail: "isPalindrome(" + JSON.stringify(input) + ") = " + got })); return; }
      }
      console.log(JSON.stringify({ ok: true, detail: "5/5 cases" }));
    });`;
  // `/proc/.reset` is the one file Docker Desktop's Rosetta shim preloads into
  // every Node process in an emulated amd64 container (the release build runs
  // there); refused, the child dies before it runs a line. It is the only read
  // allowed, and it does not exist on a real machine.
  const run = spawnSync(process.execPath, ["--permission", "--allow-fs-read=/proc/.reset", "-e", harness], {
    input: code,
    // Bounds a runaway loop, not the cases (they take milliseconds); generous
    // for a cold Node start under emulation. The permission model is the
    // security boundary.
    timeout: EVAL_CODE_TIMEOUT_MS,
    encoding: "utf8",
    env: { NODE_ENV: "production" } as NodeJS.ProcessEnv,
  });
  if (run.error || run.status !== 0) return { ok: false, detail: run.signal ? "timed out" : "crashed" };
  try {
    return JSON.parse(run.stdout.trim().split("\n").pop() ?? "") as { ok: boolean; detail: string };
  } catch {
    return { ok: false, detail: "no verdict" };
  }
}

/** A 130k-token haystack with one needle, built deterministically. */
export function longContextPrompt(): string {
  const filler =
    "The quarterly logistics report notes routine shipments, standard customs paperwork, and no exceptions. ";
  const paragraphs: string[] = [];
  for (let i = 0; i < 5_000; i++) {
    paragraphs.push(`§${i}. ${filler}`);
    if (i === 3_217) paragraphs.push("§3217b. The vault access code for the Lisbon office is HERON-4471. ");
  }
  return `${paragraphs.join("\n")}\n\nQuestion: what is the vault access code for the Lisbon office? Reply with the code only.`;
}

const NOT_RUN = (reason: string, coveredBy: string | null) => ({ reason, coveredBy });

export const EVAL_SUITE: EvalTaskSpec[] = [
  {
    id: "chat-names",
    category: "everyday_chat",
    prompt: "Suggest exactly three names for a grey cat, as a numbered list, nothing else.",
    route: {},
    grade: ({ text }) => {
      const items = text.split("\n").filter((l) => /^\s*\d+[.)]\s+\S/.test(l));
      return ok(items.length === 3, `${items.length} numbered items`);
    },
    mock: { text: "1. Ash\n2. Pebble\n3. Smoke", inputTokens: 1_240, outputTokens: 14 },
  },
  {
    id: "reason-bat-ball",
    category: "reasoning",
    prompt:
      "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Think it through, then give the final answer on the last line as 'Answer: $X.XX'.",
    route: {},
    grade: ({ text }) => {
      const last = text.trim().split("\n").pop() ?? "";
      return ok(/Answer:\s*\$0?\.05\b/.test(last), `last line: ${last.slice(0, 40)}`);
    },
    mock: {
      text: "If the ball is x, the bat is x + 1.00, so 2x + 1.00 = 1.10 and x = 0.05.\nAnswer: $0.05",
      inputTokens: 1_290,
      outputTokens: 40,
    },
  },
  {
    id: "code-palindrome",
    category: "coding",
    prompt:
      "Write a JavaScript function isPalindrome(s) that ignores case, spaces and punctuation and returns true for palindromes. Reply with one ```js code block only.",
    route: {},
    grade: ({ text }) => {
      const r = runIsPalindrome(codeFrom(text));
      return ok(r.ok, r.detail);
    },
    mock: {
      text: "```js\nfunction isPalindrome(s) {\n  const t = s.toLowerCase().replace(/[^a-z0-9]/g, \"\");\n  return t === [...t].reverse().join(\"\");\n}\n```",
      inputTokens: 1_300,
      outputTokens: 60,
    },
  },
  {
    id: "tool-multiply",
    category: "tool_use",
    prompt: "Use the multiply tool to compute 1234 times 5678, then reply with only the result.",
    route: { toolsOffered: 1 },
    needsProbeTools: true,
    grade: ({ text, toolCalls }) => {
      const right = /7,?006,?652/.test(text);
      return ok(right && (toolCalls ?? 0) >= 1, `answer ${right ? "right" : "wrong"}, ${toolCalls ?? 0} tool call(s)`);
    },
    mock: { text: "7006652", toolCalls: 1, inputTokens: 1_420, outputTokens: 30 },
  },
  {
    id: "search-cited",
    category: "search",
    prompt: "What is the latest stable version of Node.js? Answer in one sentence and cite your sources.",
    route: { wantsWebSearch: true },
    grade: ({ text, sources }) => {
      const q = citationQuality(sources);
      return ok((sources?.length ?? 0) > 0 && (q ?? 0) >= 0.5 && text.trim().length > 0, `${sources?.length ?? 0} sources`, q);
    },
    mock: {
      text: "The latest stable Node.js release is listed on the official release page [1].",
      sources: [{ title: "Node.js — Previous Releases", url: "https://nodejs.org/en/about/previous-releases", snippet: "" }],
      inputTokens: 2_900,
      outputTokens: 40,
    },
  },
  {
    id: "deep-research",
    category: "deep_research",
    prompt: "(research run)",
    route: { wantsWebSearch: true },
    grade: () => ok(false, "not run"),
    mock: { text: "", inputTokens: 0, outputTokens: 0 },
    notRunnable: NOT_RUN(
      "Needs the research engine (plan, parallel evidence, audit) with a database and search providers.",
      "tests/research-*.test.ts (engine units); no provider-backed acceptance run exists yet"
    ),
  },
  {
    id: "memory-recall",
    category: "memory",
    prompt: "(learn → correct → recall → forget)",
    route: {},
    grade: () => ok(false, "not run"),
    mock: { text: "", inputTokens: 0, outputTokens: 0 },
    notRunnable: NOT_RUN("Needs persistence across turns (memory lifecycle in Postgres).", "scripts/memory-bench.ts"),
  },
  {
    id: "long-needle",
    category: "long_context",
    prompt: "(130k-token haystack, built at run time)",
    route: { contextTokens: 131_000 },
    expensive: true,
    grade: ({ text }) => ok(/HERON-4471/.test(text), text.trim().slice(0, 40)),
    mock: { text: "HERON-4471", inputTokens: 131_000, outputTokens: 8 },
  },
  {
    id: "agent-persistence",
    category: "agent_persistence",
    prompt: "(an Orbit agent resumes a goal after restart)",
    route: { toolsOffered: 3 },
    grade: () => ok(false, "not run"),
    mock: { text: "", inputTokens: 0, outputTokens: 0 },
    notRunnable: NOT_RUN("Needs the Work runner, scheduler and database.", "tests/crew-foundations.integration.test.ts (state, not quality)"),
  },
  {
    id: "browser-task",
    category: "browser_tasks",
    prompt: "(open a page, find a fact, report it)",
    route: { toolsOffered: 1 },
    grade: () => ok(false, "not run"),
    mock: { text: "", inputTokens: 0, outputTokens: 0 },
    notRunnable: NOT_RUN("Needs a browser runtime.", null),
  },
  {
    id: "computer-use",
    category: "computer_use",
    prompt: "(operate a desktop app)",
    route: { toolsOffered: 1 },
    grade: () => ok(false, "not run"),
    mock: { text: "", inputTokens: 0, outputTokens: 0 },
    notRunnable: NOT_RUN("Needs an agent computer (VM) and the computer-use runtime.", null),
  },
  {
    id: "artifact-counter",
    category: "artifacts",
    prompt:
      "Create a self-contained HTML page with a button labelled 'Add' that increments a visible counter starting at 0. One ```html block only.",
    route: {},
    grade: ({ text }) => {
      const html = codeFrom(text);
      const pass = /<button[^>]*>\s*Add\s*<\/button>/i.test(html) && /<script[\s>]/i.test(html) && /\b0\b/.test(html);
      return ok(pass, pass ? "button, script and initial 0 present" : "missing button/script/initial value");
    },
    mock: {
      text: "```html\n<!doctype html><p id=\"n\">0</p><button id=\"b\">Add</button><script>let n=0;b.onclick=()=>{document.getElementById('n').textContent=++n}</script>\n```",
      inputTokens: 1_310,
      outputTokens: 70,
    },
  },
  {
    id: "doc-memo",
    category: "documents",
    prompt: "Write a short internal memo about moving standup to 10:00 with exactly these markdown headings: ## Purpose, ## Background, ## Recommendation.",
    route: {},
    grade: ({ text }) => {
      const heads = ["Purpose", "Background", "Recommendation"].filter((h) => new RegExp(`^##\\s+${h}\\s*$`, "m").test(text));
      return ok(heads.length === 3, `${heads.length}/3 headings`);
    },
    mock: {
      text: "## Purpose\nMove standup to 10:00.\n\n## Background\nHalf the team starts later.\n\n## Recommendation\nTrial 10:00 for two weeks.",
      inputTokens: 1_300,
      outputTokens: 45,
    },
  },
  {
    id: "sheet-csv",
    category: "spreadsheets",
    prompt: "Return a CSV (no prose, no code fence) with header name,qty,price and exactly 3 rows of office supplies.",
    route: {},
    grade: ({ text }) => {
      const lines = codeFrom(text).trim().split("\n").map((l) => l.trim()).filter(Boolean);
      const header = lines[0]?.toLowerCase().replace(/\s/g, "") === "name,qty,price";
      const rows = lines.slice(1).filter((l) => {
        const c = l.split(",");
        return c.length === 3 && Number.isFinite(Number(c[1])) && Number.isFinite(Number(c[2]));
      });
      return ok(header && rows.length === 3 && lines.length === 4, `header ${header ? "ok" : "wrong"}, ${rows.length} valid rows`);
    },
    mock: { text: "name,qty,price\nStapler,2,7.50\nPens,10,0.80\nNotebook,5,2.40", inputTokens: 1_280, outputTokens: 30 },
  },
  {
    id: "slides-outline",
    category: "slides",
    prompt: "Outline a 5-slide deck on onboarding a new engineer. Use exactly one line per slide formatted '## Slide N: Title'.",
    route: {},
    grade: ({ text }) => {
      const n = (text.match(/^##\s+Slide\s+\d+:\s+\S/gm) ?? []).length;
      return ok(n === 5, `${n} slides`);
    },
    mock: {
      text: "## Slide 1: Welcome\n## Slide 2: Your first week\n## Slide 3: Tools and access\n## Slide 4: How we ship\n## Slide 5: Who to ask",
      inputTokens: 1_290,
      outputTokens: 40,
    },
  },
  {
    id: "multilingual-fr",
    category: "multilingual",
    prompt: "Réponds en français, en une phrase : quelle est la capitale de l'Australie ?",
    route: {},
    grade: ({ text }) => {
      const right = /Canberra/.test(text);
      const french = /\b(la|est|capitale|de l)\b/i.test(text);
      return ok(right && french, `${right ? "Canberra" : "wrong city"}, ${french ? "French" : "not French"}`);
    },
    mock: { text: "La capitale de l'Australie est Canberra.", inputTokens: 1_260, outputTokens: 14 },
  },
  {
    id: "instruct-three-words",
    category: "instruction_following",
    prompt: "Describe the sea in exactly three words, all lowercase, no punctuation.",
    route: {},
    grade: ({ text }) => {
      const w = words(text);
      const pass = w.length === 3 && text === text.toLowerCase() && !/[.,!?;:]/.test(text);
      return ok(pass, `${w.length} words`);
    },
    mock: { text: "vast restless blue", inputTokens: 1_250, outputTokens: 5 },
  },
];
