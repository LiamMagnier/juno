/*
 * THE HOME'S STARTERS (G34): a row of capability chips under the composer,
 * each opening a short list of starter prompts. Picking a prompt PREFILLS the
 * composer and arms the right mode; nothing is ever sent from here.
 *
 *   [ Write ] [ Research ] [ Create image ] [ Code ] [ Plan ]
 *
 * Pure: the catalogue, the order and the personalisation rules, so they are
 * checked without a DOM. The component is components/chat/home-starters.tsx.
 *
 * PERSONALISED FROM RECENT USE, NEVER INVENTED. The order follows what this
 * person actually does: the chips they picked on this device, and the kinds
 * of conversation they had in the last month (Code sessions, image models).
 * A new account sees the fixed order. The one personalised prompt names the
 * Code project they worked in last, read from their own conversation list.
 * Nothing here reads memory or sends anything anywhere.
 */

export type StarterId = "write" | "research" | "image" | "code" | "plan" | "learn";

/** What picking a prompt does to the composer. */
export type StarterAction =
  /** Prefill the text. */
  | "seed"
  /** Prefill and arm Deep Field for the one send (the plan gate still runs). */
  | "research"
  /** Prefill and switch the composer to an image model. */
  | "image"
  /** Open Code with the task written in its composer (/code?prompt=). */
  | "code";

/** The order a new account sees. */
export const STARTER_ORDER: readonly StarterId[] = ["write", "research", "image", "code", "plan", "learn"];

export const STARTER_ACTION: Readonly<Record<StarterId, StarterAction>> = {
  write: "seed",
  research: "research",
  image: "image",
  code: "code",
  plan: "seed",
  learn: "seed",
};

/** One row of chips, never two: five fit a 720px column with room to breathe. */
export const MAX_STARTER_CHIPS = 5;

/**
 * Every word the starters show. Complete, specific requests that are worth
 * sending as written and easy to edit first. Named `…_COPY` so the i18n
 * extractor harvests every string in it; nothing but copy goes in here.
 */
export const HOME_STARTER_COPY = {
  groupLabel: "Ways to start",
  promptsLabel: "Starter prompts",
  chips: {
    write: {
      label: "Write",
      prompts: [
        "Help me write a warm, short thank-you note to a colleague",
        "Tighten this paragraph without changing what it says",
        "Draft a cover letter for a role I’ll describe",
        "Turn my rough notes into a clear one-page summary",
      ],
    },
    research: {
      label: "Research",
      prompts: [
        "Compare the best options for a decision I’m making, with sources",
        "What does the latest evidence say about intermittent fasting?",
        "Build a market overview of a sector I’ll name, with the main players",
      ],
    },
    image: {
      label: "Create image",
      prompts: [
        "A quiet watercolour of a harbour at dawn",
        "A clean product shot of a ceramic mug on linen, soft daylight",
        "An isometric illustration of a small, tidy home office",
      ],
    },
    code: {
      label: "Code",
      prompts: [
        "Find and fix the failing tests in my repository",
        "Add a small feature I’ll describe, with tests",
        "Review the latest changes and point out risks",
      ],
    },
    plan: {
      label: "Plan",
      prompts: [
        "Plan my week around three priorities I’ll list",
        "Break a project into clear steps with rough timings",
        "Make a packing checklist for a long weekend away",
      ],
    },
    learn: {
      label: "Learn",
      prompts: [
        "Explain how vaccines train the immune system, simply",
        "Teach me the basics of personal budgeting in ten minutes",
        "Quiz me on a topic I’m studying, one question at a time",
      ],
    },
  },
  /** Followed by the name of the Code project they worked in last. */
  continueIn: "Pick up where I left off in",
} as const;

/** What this person can actually start here; a chip for something they cannot use is not drawn. */
export interface StarterAvailability {
  research: boolean;
  image: boolean;
  code: boolean;
}

export interface StarterSignals {
  /** Conversations of each kind in the recent window. */
  recent: Partial<Record<StarterId, number>>;
  /** Chips this person picked on this device, recently. */
  picks: Partial<Record<StarterId, number>>;
}

/** A pick on this device counts this many conversations: it is the stronger, explicit signal. */
const PICK_WEIGHT = 3;

/**
 * The chips to draw, in order. Unavailable ones drop out; the rest follow
 * recent use, and ties keep the fixed order, so a new account sees exactly
 * STARTER_ORDER.
 */
export function rankStarters(available: StarterAvailability, signals: StarterSignals = { recent: {}, picks: {} }): StarterId[] {
  const usable = STARTER_ORDER.filter((id) => {
    if (id === "research") return available.research;
    if (id === "image") return available.image;
    if (id === "code") return available.code;
    return true;
  });
  const score = (id: StarterId) => (signals.picks[id] ?? 0) * PICK_WEIGHT + (signals.recent[id] ?? 0);
  return usable
    .map((id, index) => ({ id, index, score: score(id) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_STARTER_CHIPS)
    .map((entry) => entry.id);
}

/* ——— Recent use, from the conversation list the shell already holds ——— */

/** How far back a conversation counts towards the order. */
export const RECENT_WINDOW_DAYS = 30;
/** Only the newest conversations are read: the order is a hint, not an audit. */
const RECENT_LIMIT = 60;

export interface ConversationSignal {
  kind: "chat" | "code";
  model: string;
  lastMessageAt: string;
  codeWorkspaceName?: string | null;
  archivedAt?: string | null;
}

export interface RecentUse {
  recent: Partial<Record<StarterId, number>>;
  /** The Code project worked in most recently, by name. */
  lastCodeProject: string | null;
  /** The image model used most recently, so "Create image" opens on it. */
  lastImageModel: string | null;
}

export function recentUse(
  conversations: readonly ConversationSignal[],
  modalityOf: (modelId: string) => string | undefined,
  now: number = Date.now(),
): RecentUse {
  const since = now - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentOnes = conversations
    .filter((c) => !c.archivedAt)
    .map((c) => ({ c, at: Date.parse(c.lastMessageAt) }))
    .filter(({ at }) => Number.isFinite(at) && at >= since && at <= now + 60_000)
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_LIMIT)
    .map(({ c }) => c);

  const recent: Partial<Record<StarterId, number>> = {};
  let lastCodeProject: string | null = null;
  let lastImageModel: string | null = null;
  for (const c of recentOnes) {
    if (c.kind === "code") {
      recent.code = (recent.code ?? 0) + 1;
      const name = c.codeWorkspaceName?.trim();
      if (!lastCodeProject && name) lastCodeProject = name;
      continue;
    }
    const modality = modalityOf(c.model);
    if (modality === "image" || modality === "video") {
      recent.image = (recent.image ?? 0) + 1;
      if (!lastImageModel && modality === "image") lastImageModel = c.model;
    }
  }
  return { recent, lastCodeProject, lastImageModel };
}

/* ——— Picks remembered on this device ——————————————————————————————————— */

export const STARTER_PICKS_KEY = "alevr:home-starters:v1";
/** A pick older than this no longer reorders anything. */
const PICK_MEMORY_DAYS = 60;

type PickLedger = Partial<Record<StarterId, { n: number; at: number }>>;

/** The stored ledger, cleaned: unknown ids, bad numbers and stale picks drop out. */
export function parsePicks(raw: string | null, now: number = Date.now()): Partial<Record<StarterId, number>> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const since = now - PICK_MEMORY_DAYS * 24 * 60 * 60 * 1000;
  const out: Partial<Record<StarterId, number>> = {};
  for (const id of STARTER_ORDER) {
    const entry = (parsed as Record<string, unknown>)[id] as { n?: unknown; at?: unknown } | undefined;
    if (!entry || typeof entry.n !== "number" || typeof entry.at !== "number") continue;
    if (entry.at < since || entry.n <= 0) continue;
    out[id] = Math.min(Math.floor(entry.n), 50);
  }
  return out;
}

/** The ledger with one more pick of `id`, serialised for storage. */
export function recordPick(raw: string | null, id: StarterId, now: number = Date.now()): string {
  const counts = parsePicks(raw, now);
  let previous: PickLedger = {};
  try {
    previous = raw ? (JSON.parse(raw) as PickLedger) : {};
  } catch {
    previous = {};
  }
  const next: PickLedger = {};
  for (const key of STARTER_ORDER) {
    if (counts[key]) next[key] = { n: counts[key]!, at: previous[key]?.at ?? now };
  }
  next[id] = { n: Math.min((counts[id] ?? 0) + 1, 50), at: now };
  return JSON.stringify(next);
}

/* ——— The prompts a chip offers ——————————————————————————————————————— */

export interface StarterPrompt {
  /** The fixed, translatable phrase. */
  phrase: string;
  /** A name that rides after the phrase untranslated (the Code project). */
  argument?: string;
}

export function promptsFor(id: StarterId, use: Pick<RecentUse, "lastCodeProject">): StarterPrompt[] {
  const fixed = HOME_STARTER_COPY.chips[id].prompts.map((phrase) => ({ phrase }));
  if (id === "code" && use.lastCodeProject) {
    return [{ phrase: HOME_STARTER_COPY.continueIn, argument: use.lastCodeProject }, ...fixed.slice(0, 2)];
  }
  return fixed;
}

/** The text a prompt puts in the composer, given the phrase in the reader's language. */
export function promptText(prompt: StarterPrompt, translatedPhrase: string = prompt.phrase): string {
  return prompt.argument ? `${translatedPhrase} ${prompt.argument}` : translatedPhrase;
}

/** `/code` prefilled with the task: it fills the composer and waits (src/lib/code-prefill.ts). */
export function codeHandoffHref(text: string): string {
  return `/code?prompt=${encodeURIComponent(text)}`;
}
