/**
 * Work as an internal runtime: noticing, in an ordinary chat message, that
 * the person is asking for a long job with several deliverables, so the turn
 * can offer or start background work in the same conversation instead of the
 * person having to choose "Chat or Work" first (BRIEF §28).
 *
 * Deterministic and cheap: it reads the message for deliverables (a report, a
 * spreadsheet, a deck…), scale ("40 competitors", "every page"), multi-step
 * verbs joined by "and then", and ongoing work ("until the build passes"). It
 * never starts anything itself. Its only effect is a short line in that turn's
 * prompt telling the model what it noticed; `start_task` and its gates (plan,
 * usage window, run cap, approval card) remain the only way work starts, and
 * the model still answers in chat when the request is really a question.
 *
 * A RECURRING REQUEST IS NOT BACKGROUND WORK. "Every morning, summarise my
 * inbox" used to count as "continues over time" and pushed the model towards
 * `start_task`, which runs once: the person was told something recurring was
 * set up and nothing ran again. It is its own verdict now, and its hint points
 * at `propose_routine` (src/lib/chat/routine-tool.ts) when the turn has it.
 *
 * Pure and client-safe.
 */

export type BackgroundWorkVerdict =
  | { kind: "chat" }
  /** The message asks for something on a schedule: a routine, never a task. */
  | { kind: "recurring" }
  | {
      kind: "background";
      /** A specialist team fits: the job spans research, building and design. */
      team: boolean;
      deliverables: string[];
      reasons: string[];
    };

const DELIVERABLES: readonly [string, RegExp][] = [
  ["report", /\b(report|brief(ing)?|write-?up|memo|white ?paper|analysis document)\b/i],
  ["spreadsheet", /\b(spreadsheet|xlsx|excel|google sheet|csv|table of)\b/i],
  ["deck", /\b(deck|slides?|presentation|pptx|keynote)\b/i],
  ["document", /\b(docx|word document|proposal|plan document|pdf)\b/i],
  ["site", /\b(website|landing page|microsite)\b/i],
];

const SCALE = /\b(\d{2,})\s+(competitors?|companies|vendors|sources|pages|files|records|products|papers|accounts|leads|emails|tickets)\b|\b(all|every|each)\s+(of\s+)?(the\s+)?(competitors?|pages|files|records|vendors|products|emails|tickets|sources)\b/i;
const MULTI_STEP = /\b(research|compare|analy[sz]e|collect|gather|audit|review|benchmark)\b[^.?!]{0,120}\b(then|and (?:then )?(?:build|create|make|write|draft|produce|put together|turn))\b/i;
const ONGOING = /\b(keep an eye on|until (it|the build) (passes|is done)|monitor)\b/i;
/**
 * A schedule: "every morning", "each Monday", "every 2 hours", "on weekdays",
 * "daily at 8". A bare "daily" is not enough ("our daily standup notes").
 */
const RECURRING = /\b(?:every|each)\s+(?:single\s+)?(?:morning|evening|night|afternoon|day|weekday|workday|week|month|year|hour|\d+\s+hours?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?\b|\bon weekdays\b|\b(?:daily|weekly|monthly|hourly|nightly)\s+(?:at|on|basis)\b/i;
const QUESTION_ONLY = /^\s*(what|why|how|who|when|where|is|are|can|could|should|does|do)\b[^.]*\?\s*$/i;

const TEAM_RESEARCH = /\b(research|market|competitor|sources|benchmark|evidence)\b/i;
const TEAM_BUILD = /\b(build|code|implement|spreadsheet|model|data|prototype|calculat)/i;
const TEAM_DESIGN = /\b(design|ux|onboarding|deck|slides|experience|visual)\b/i;

/** Whether this message reads as a long, multi-deliverable job, or as a schedule. */
export function detectBackgroundWork(message: string | null | undefined): BackgroundWorkVerdict {
  const text = (message ?? "").trim();
  if (text.length < 24 || QUESTION_ONLY.test(text)) return { kind: "chat" };
  if (RECURRING.test(text)) return { kind: "recurring" };
  const deliverables = DELIVERABLES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const reasons: string[] = [];
  if (deliverables.length >= 2) reasons.push(`asks for ${deliverables.length} deliverables (${deliverables.join(", ")})`);
  if (SCALE.test(text)) reasons.push("covers many items");
  if (MULTI_STEP.test(text)) reasons.push("chains research into building something");
  if (ONGOING.test(text)) reasons.push("keeps going until something happens");
  // One signal is not enough: "write a report" is a chat answer. Two are a job.
  const strong = deliverables.length >= 2 || (deliverables.length === 1 && (SCALE.test(text) || MULTI_STEP.test(text)));
  if (!strong && reasons.length < 2) return { kind: "chat" };
  const spans = [TEAM_RESEARCH, TEAM_BUILD, TEAM_DESIGN].filter((pattern) => pattern.test(text)).length;
  return { kind: "background", team: spans >= 2 && (deliverables.length >= 2 || SCALE.test(text)), deliverables, reasons };
}

/** The line the turn's prompt gets when the message reads as a job; null for chat. */
export function backgroundWorkHint(verdict: BackgroundWorkVerdict): string | null {
  if (verdict.kind !== "background") return null;
  const lines = [
    `# This message looks like background work`,
    `It ${verdict.reasons.join(", ")}. Unless it is really a question or something you can finish well in this reply, start it with start_task now rather than doing a thin version in chat, then say in one sentence what you started. If one detail it cannot do without is missing, ask for that first.`,
  ];
  if (verdict.team) {
    lines.push("It spans research, building and design: pass team with the specialists it needs (researcher, engineer, designer) so a small team works on it in parallel, with a critic and a final synthesis.");
  }
  return lines.join("\n");
}

/**
 * The line a turn that can propose a routine gets when the message asks for
 * something on a schedule; null otherwise. Without `propose_routine` the turn
 * gets nothing here: the system prompt's Routines line already says a task is
 * the wrong answer and where routines are made.
 */
export function recurringWorkHint(verdict: BackgroundWorkVerdict, routineToolOn: boolean): string | null {
  if (verdict.kind !== "recurring" || !routineToolOn) return null;
  return [
    "# This message asks for something on a schedule",
    "Propose it with propose_routine for the user to confirm, rather than starting a task, which runs once. If when it should run, or what it should cover, is unclear, ask one short question first.",
  ].join("\n");
}
