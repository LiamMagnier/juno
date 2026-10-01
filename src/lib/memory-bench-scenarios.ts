import type { BenchScenario } from "@/lib/memory-bench";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The recall benchmark's histories.
 *
 * Each scenario is a person's chats over months, with what is TRUE of them at
 * the end: what Juno should believe now, what it should have stopped
 * believing, what the person asked it to forget — and questions a later chat
 * might ask, with the facts each one needs in context.
 *
 * Every user message carries the facts a model that follows the extraction
 * prompt would pull from it, third person, the way the real extractor writes
 * them. Offline, those recordings stand in for the model, so a run measures
 * everything downstream of it — what the prompt tells the model it already
 * knows, how facts are judged against each other, what expires, what is
 * retrieved — and gives the same answer every time. With `--live` the
 * recordings are ignored and a real model reads the messages instead.
 *
 * The histories are ordinary on purpose: moving city, changing jobs, a trip,
 * a thesis and a side project, a correction of taste. Several things in them
 * are things Juno's rules do NOT get right, and they are left in: a benchmark
 * that only contains what the code already handles measures nothing.
 */

export const MEMORY_BENCH_SCENARIOS: BenchScenario[] = [
  {
    id: "year-of-changes",
    title: "A year of changes",
    description:
      "A designer changes employer, moves city, takes a short trip and changes how they like answers. Tests whether memory follows the person or the order chats happened to be read in.",
    now: "2026-09-22T12:00:00Z",
    conversations: [
      {
        id: "yc-1",
        title: "Portfolio feedback",
        projectId: null,
        at: "2025-10-06T09:00:00Z",
        turns: [
          {
            text: "I'm a product designer at Acme in Lisbon — can you look at my portfolio case study?",
            facts: ["The user is a product designer.", "The user works at Acme.", "The user lives in Lisbon."],
          },
          { text: "Keep the feedback short and give examples.", facts: ["The user prefers short answers with examples."] },
        ],
      },
      {
        id: "yc-2",
        title: "Figma plugin idea",
        projectId: null,
        at: "2026-01-12T18:30:00Z",
        turns: [
          { text: "I spend most of my day in Figma and FigJam.", facts: ["The user uses Figma daily."] },
          {
            text: "I want to learn to build Figma plugins this year.",
            facts: ["The user wants to learn to build Figma plugins."],
          },
        ],
      },
      {
        id: "yc-3",
        title: "Offer letter",
        projectId: null,
        at: "2026-04-02T11:00:00Z",
        turns: [
          { text: "I accepted an offer — I work at Globex from May!", facts: ["The user works at Globex."] },
          { text: "Help me write a goodbye note to my team.", facts: [] },
        ],
      },
      {
        id: "yc-4",
        title: "Moving checklist",
        projectId: null,
        at: "2026-06-15T08:00:00Z",
        turns: [
          { text: "We finally moved, I live in Porto now.", facts: ["The user lives in Porto."] },
          { text: "What do I need to update after changing address?", facts: [] },
        ],
      },
      {
        id: "yc-5",
        title: "Workshop trip",
        projectId: null,
        at: "2026-08-10T07:15:00Z",
        turns: [
          {
            text: "I'm flying to Berlin this week for a design workshop.",
            facts: ["The user is flying to Berlin this week."],
          },
        ],
      },
      {
        id: "yc-6",
        title: "Style guide review",
        projectId: null,
        at: "2026-09-14T15:00:00Z",
        turns: [
          {
            // Juno's rules miss this one: the stored fact carries no
            // correction marker and "answer style" is not a single-valued
            // slot, so both preferences stay believed. Left in on purpose.
            text: "Actually, I prefer detailed answers now, with sources.",
            facts: ["The user prefers detailed answers with sources."],
          },
        ],
      },
      {
        id: "yc-7",
        title: "Weekend plans",
        projectId: null,
        at: "2026-09-20T10:00:00Z",
        turns: [{ text: "I've started learning Portuguese properly.", facts: ["The user is learning Portuguese."] }],
      },
    ],
    truth: {
      current: [
        { projectId: null, fact: "The user is a product designer." },
        { projectId: null, fact: "The user works at Globex." },
        { projectId: null, fact: "The user lives in Porto." },
        { projectId: null, fact: "The user uses Figma daily." },
        { projectId: null, fact: "The user wants to learn to build Figma plugins." },
        { projectId: null, fact: "The user prefers detailed answers with sources." },
        { projectId: null, fact: "The user is learning Portuguese." },
      ],
      stale: [
        { projectId: null, fact: "The user works at Acme." },
        { projectId: null, fact: "The user lives in Lisbon." },
        { projectId: null, fact: "The user prefers short answers with examples." },
        { projectId: null, fact: "The user is flying to Berlin this week." },
      ],
    },
    probes: [
      {
        id: "where-live",
        projectId: null,
        query: "Which city do I live in? I need it for a form.",
        expect: ["The user lives in Porto."],
        mustNot: ["The user lives in Lisbon."],
      },
      {
        id: "intro-email",
        projectId: null,
        query: "Draft an intro email to my colleagues at work about my role.",
        expect: ["The user works at Globex.", "The user is a product designer."],
        mustNot: ["The user works at Acme."],
      },
      {
        id: "daily-tools",
        projectId: null,
        query: "Which tools do I use daily?",
        expect: ["The user uses Figma daily."],
      },
      {
        id: "answer-style",
        projectId: null,
        query: "How do I like my answers?",
        expect: ["The user prefers detailed answers with sources."],
        mustNot: ["The user prefers short answers with examples."],
      },
      {
        id: "travel",
        projectId: null,
        query: "Am I flying anywhere this week?",
        expect: [],
        mustNot: ["The user is flying to Berlin this week."],
      },
    ],
  },

  {
    id: "two-projects",
    title: "A thesis and a side project",
    description:
      "Two projects and ordinary chats, with one habit (pnpm) mentioned in all three. Tests that each scope learns what it was told and nothing crosses between them.",
    now: "2026-09-22T12:00:00Z",
    conversations: [
      {
        id: "tp-1",
        title: "Thesis outline",
        projectId: "thesis",
        at: "2026-05-04T14:00:00Z",
        turns: [
          {
            text: "My master's thesis is about urban heat islands.",
            facts: ["The user's thesis is about urban heat islands."],
          },
          { text: "My department requires APA citations.", facts: ["The user's thesis uses APA citations."] },
        ],
      },
      {
        id: "tp-2",
        title: "Pantry schema",
        projectId: "pantry",
        at: "2026-06-20T20:00:00Z",
        turns: [
          {
            text: "Pantry is my side project, a meal-planning app built with Next.js and Postgres.",
            facts: ["The user is building a meal-planning app called Pantry.", "Pantry is built with Next.js and Postgres."],
          },
          { text: "I use pnpm for my JavaScript projects.", facts: ["The user uses pnpm."] },
        ],
      },
      {
        id: "tp-3",
        title: "Analysis scripts",
        projectId: "thesis",
        at: "2026-07-30T09:30:00Z",
        turns: [
          {
            text: "For the thesis analysis I write Python in Jupyter.",
            facts: ["The user writes the thesis analysis in Python with Jupyter."],
          },
          {
            // Heard first in Pantry. A reader shown every scope's facts as
            // "already known" skips it here, and the thesis never learns it.
            text: "I use pnpm to build the thesis website too.",
            facts: ["The user uses pnpm."],
          },
        ],
      },
      {
        id: "tp-4",
        title: "New laptop",
        projectId: null,
        at: "2026-08-15T12:00:00Z",
        turns: [
          { text: "I use a MacBook Pro for everything.", facts: ["The user uses a MacBook Pro."] },
          { text: "And pnpm, always.", facts: ["The user uses pnpm."] },
        ],
      },
      {
        id: "tp-5",
        title: "Defense prep",
        projectId: "thesis",
        at: "2026-09-10T16:00:00Z",
        turns: [
          {
            text: "My thesis defense is scheduled for December.",
            facts: ["The user's thesis defense is in December."],
          },
        ],
      },
    ],
    truth: {
      current: [
        { projectId: "thesis", fact: "The user's thesis is about urban heat islands." },
        { projectId: "thesis", fact: "The user's thesis uses APA citations." },
        { projectId: "thesis", fact: "The user writes the thesis analysis in Python with Jupyter." },
        { projectId: "thesis", fact: "The user uses pnpm." },
        { projectId: "thesis", fact: "The user's thesis defense is in December." },
        { projectId: "pantry", fact: "The user is building a meal-planning app called Pantry." },
        { projectId: "pantry", fact: "Pantry is built with Next.js and Postgres." },
        { projectId: "pantry", fact: "The user uses pnpm." },
        { projectId: null, fact: "The user uses a MacBook Pro." },
        { projectId: null, fact: "The user uses pnpm." },
      ],
      stale: [],
    },
    probes: [
      {
        id: "thesis-citations",
        projectId: "thesis",
        query: "Which citation style does my thesis need?",
        expect: ["The user's thesis uses APA citations."],
        mustNot: ["Pantry is built with Next.js and Postgres."],
      },
      {
        id: "thesis-build",
        projectId: "thesis",
        query: "Which package manager should the thesis website build use?",
        expect: ["The user uses pnpm."],
      },
      {
        id: "pantry-database",
        projectId: "pantry",
        query: "Which database does Pantry use?",
        expect: ["Pantry is built with Next.js and Postgres."],
        mustNot: ["The user's thesis uses APA citations."],
      },
      {
        id: "account-package-manager",
        projectId: null,
        query: "Which package manager do I use?",
        expect: ["The user uses pnpm."],
      },
      {
        id: "account-thesis",
        projectId: null,
        query: "What is my thesis about?",
        expect: [],
        mustNot: ["The user's thesis is about urban heat islands."],
      },
    ],
  },

  {
    id: "forget-and-move-on",
    title: "Forgotten, then a new job",
    description:
      `Someone asks ${PRODUCT_NAME} to forget their employer, interviews elsewhere and takes the job. Tests that a forget survives history being read again, and that an interview in March is not upcoming in September.`,
    now: "2026-09-22T12:00:00Z",
    forgets: [{ at: "2026-03-01T09:00:00Z", statement: "The user works at Initech." }],
    conversations: [
      {
        id: "fm-1",
        title: "Job search",
        projectId: null,
        at: "2026-02-01T19:00:00Z",
        turns: [
          {
            text: "I work at Initech but I'm looking around for something new.",
            facts: ["The user works at Initech.", "The user is looking for a new job."],
          },
        ],
      },
      {
        id: "fm-2",
        title: "Interview prep",
        projectId: null,
        at: "2026-03-15T08:00:00Z",
        turns: [
          {
            text: "I have an interview at Hooli next week, help me prepare.",
            facts: ["The user has a job interview at Hooli next week."],
          },
        ],
      },
      {
        id: "fm-3",
        title: "First week",
        projectId: null,
        at: "2026-06-01T18:00:00Z",
        turns: [
          {
            text: "I joined Hooli as a data analyst!",
            facts: ["The user works at Hooli.", "The user is a data analyst."],
          },
        ],
      },
    ],
    truth: {
      current: [
        { projectId: null, fact: "The user works at Hooli." },
        { projectId: null, fact: "The user is a data analyst." },
      ],
      stale: [
        // No rule connects "joined Hooli" to "looking for a new job". Left in:
        // this is the kind of belief only a reader of the whole history retires.
        { projectId: null, fact: "The user is looking for a new job." },
        { projectId: null, fact: "The user has a job interview at Hooli next week." },
      ],
      forgotten: ["The user works at Initech."],
    },
    probes: [
      {
        id: "employer",
        projectId: null,
        query: "Where do I work these days?",
        expect: ["The user works at Hooli."],
        mustNot: ["The user works at Initech."],
      },
      {
        id: "interviews",
        projectId: null,
        query: "Do I have any job interview coming up?",
        expect: [],
        mustNot: ["The user has a job interview at Hooli next week."],
      },
    ],
  },

  {
    id: "moving-back",
    title: "A year away, then home",
    description:
      "Madrid, a year in Valencia, then back to Madrid. Tests that saying something again, later, makes it true again — whichever order the chats are read in.",
    now: "2026-09-22T12:00:00Z",
    conversations: [
      {
        id: "mb-1",
        title: "Apartment hunting",
        projectId: null,
        at: "2025-12-01T10:00:00Z",
        turns: [{ text: "I live in Madrid, in Lavapiés.", facts: ["The user lives in Madrid."] }],
      },
      {
        id: "mb-2",
        title: "Year abroad",
        projectId: null,
        at: "2026-03-01T10:00:00Z",
        turns: [{ text: "Update: I live in Valencia now, for a year.", facts: ["The user lives in Valencia."] }],
      },
      {
        id: "mb-3",
        title: "Home again",
        projectId: null,
        at: "2026-09-01T10:00:00Z",
        turns: [{ text: "Back home — I live in Madrid again.", facts: ["The user lives in Madrid."] }],
      },
    ],
    truth: {
      current: [{ projectId: null, fact: "The user lives in Madrid." }],
      stale: [{ projectId: null, fact: "The user lives in Valencia." }],
    },
    probes: [
      {
        id: "cafe",
        projectId: null,
        query: "Recommend a café near where I live.",
        expect: ["The user lives in Madrid."],
        mustNot: ["The user lives in Valencia."],
      },
    ],
  },

  {
    id: "crowded-memory",
    title: "A long-time user",
    description:
      "Sixty facts from a year of chats, more than one chat's memory budget holds. Tests whether the fact a question needs is among the ones selected — including two questions that share no words with their answer, which lexical ranking cannot find.",
    now: "2026-09-22T12:00:00Z",
    conversations: [
      crowd("cm-1", "2025-11-02T09:00:00Z", "Getting to know you", [
        "The user is a backend engineer at a logistics company.",
        "The user has been programming professionally for nine years.",
        "The user's first language is Dutch.",
        "The user also speaks English and German.",
        "The user lives in Rotterdam with their partner.",
        "The user's partner is a nurse working night shifts.",
        "The user has a cat named Miso.",
        "The user cycles to work every day.",
        "The user is vegetarian.",
        "The user drinks oat milk flat whites.",
      ]),
      crowd("cm-2", "2026-01-20T09:00:00Z", "Work stack", [
        "The user writes services in Go.",
        "The user's team deploys with Kubernetes on AWS.",
        "The user uses PostgreSQL and Redis at work.",
        "The user prefers table-driven tests.",
        "The user reviews code in GitHub pull requests.",
        "The user's team runs two-week sprints.",
        "The user is on call one week a month.",
        "The user uses Neovim as their editor.",
        "The user prefers dark themes in every app.",
        "The user uses a split mechanical keyboard.",
      ]),
      crowd("cm-3", "2026-03-11T09:00:00Z", "Side projects", [
        "The user maintains an open-source Go library for rate limiting.",
        "The user is writing a blog about distributed systems.",
        "The user publishes the blog with Hugo.",
        "The user wants to give a talk at GopherCon.",
        "The user is learning Rust in the evenings.",
        "The user built a home server on a Raspberry Pi.",
        "The user runs Home Assistant for home automation.",
        "The user uses Obsidian for notes.",
        "The user plans their week every Sunday evening.",
        "The user reads about one book a month.",
      ]),
      crowd("cm-4", "2026-05-06T09:00:00Z", "Preferences", [
        "The user prefers answers with code examples.",
        "The user prefers metric units.",
        "The user prefers British English spelling.",
        "The user dislikes long introductions in answers.",
        "The user likes explanations that start from first principles.",
        "The user prefers bullet points for comparisons.",
        "The user wants trade-offs spelled out explicitly.",
        "The user prefers async communication over meetings.",
        "The user uses 24-hour time.",
        "The user's week starts on Monday.",
      ]),
      crowd("cm-5", "2026-07-14T09:00:00Z", "Life admin", [
        "The user is saving for a house.",
        "The user uses YNAB for budgeting.",
        "The user's bank is ING.",
        "The user files taxes in the Netherlands.",
        "The user is training for a half marathon in October.",
        "The user runs three times a week.",
        "The user plays five-a-side football on Thursdays.",
        "The user's sister lives in Utrecht.",
        "The user visits their parents in Groningen monthly.",
        "The user sings in a choir on Saturdays.",
      ]),
      crowd("cm-6", "2026-09-01T09:00:00Z", "Recent", [
        "The user is migrating the team's services to Go 1.25.",
        "The user is mentoring a junior engineer.",
        "The user wants to move into a staff engineer role.",
        "The user is reading Designing Data-Intensive Applications again.",
        "The user is planning a trip to Japan next spring.",
        "The user is learning Japanese with an app.",
        "The user bought an electric cargo bike.",
        "The user is building a shed in the garden.",
        "The user started using Zed alongside Neovim.",
        "The user is evaluating OpenTelemetry for tracing.",
      ]),
    ],
    truth: {
      current: [], // filled from the conversations below — every fact here is current
      stale: [],
    },
    probes: [
      { id: "editor", projectId: null, query: "Which editor do I use?", expect: ["The user uses Neovim as their editor."] },
      {
        id: "deploys",
        projectId: null,
        query: "How does my team deploy services?",
        expect: ["The user's team deploys with Kubernetes on AWS."],
      },
      {
        id: "tests",
        projectId: null,
        query: "Write tests for this Go function the way I like them.",
        expect: ["The user prefers table-driven tests.", "The user writes services in Go."],
      },
      {
        id: "units",
        projectId: null,
        query: "Convert this recipe — which units do I prefer?",
        expect: ["The user prefers metric units."],
      },
      {
        id: "blog",
        projectId: null,
        query: "Help me outline my next blog post.",
        expect: ["The user is writing a blog about distributed systems."],
      },
      {
        id: "marathon",
        projectId: null,
        query: "Make me a training plan for my half marathon.",
        expect: ["The user is training for a half marathon in October."],
      },
      {
        id: "career",
        projectId: null,
        query: "What should I focus on to become a staff engineer?",
        expect: ["The user wants to move into a staff engineer role."],
      },
      {
        id: "tracing",
        projectId: null,
        query: "Compare tracing options for our services.",
        expect: ["The user is evaluating OpenTelemetry for tracing."],
      },
      {
        // No shared words with the answer. Lexical ranking cannot find it;
        // a semantic match could.
        id: "pet",
        projectId: null,
        query: "What food should I buy for my pet?",
        expect: ["The user has a cat named Miso."],
      },
      {
        // No shared words either.
        id: "dinner",
        projectId: null,
        query: "Suggest something for dinner tonight.",
        expect: ["The user is vegetarian."],
      },
    ],
  },
];

// The crowded scenario's truth is every fact it records.
const crowded = MEMORY_BENCH_SCENARIOS.find((scenario) => scenario.id === "crowded-memory")!;
crowded.truth.current = crowded.conversations.flatMap((conversation) =>
  conversation.turns.flatMap((turn) => turn.facts.map((fact) => ({ projectId: null, fact })))
);

/** One chat of ten messages, each stating one fact — the crowded scenario's shape. */
function crowd(id: string, at: string, title: string, facts: string[]): BenchScenario["conversations"][number] {
  return {
    id,
    title,
    projectId: null,
    at,
    // The message is the fact in the user's own voice — what a live model
    // reads; the recording is what it should keep.
    turns: facts.map((fact) => ({ text: firstPerson(fact), facts: [fact] })),
  };
}

/** "The user uses Neovim." → "I use Neovim." — enough grammar for these sixty sentences. */
function firstPerson(fact: string): string {
  if (fact.startsWith("The user's ")) return `My ${fact.slice("The user's ".length)}`;
  const rest = fact.replace(/^The user /, "");
  const [first, ...tail] = rest.split(" ");
  const adverb = first === "also" ? "also " : "";
  const verb = adverb ? tail.shift() ?? "" : first;
  const conjugated =
    verb === "is" ? "am" : verb === "has" ? "have" : /(?:sh|ch|x)es$/.test(verb) ? verb.slice(0, -2) : /[^s]s$/.test(verb) ? verb.slice(0, -1) : verb;
  return `I ${adverb}${[conjugated, ...tail].join(" ")}`;
}
