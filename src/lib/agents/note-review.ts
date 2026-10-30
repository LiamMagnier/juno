/**
 * What an agent may keep from its own tasks, as pure rules.
 *
 * A Work run can save a short note for its agent (the `remember` tool,
 * runner/agent-core/src/work/tools.ts, saved by src/lib/agents/run-notes.ts).
 * Two decisions are made before anything is stored, and both are here so the
 * tests read the rule that runs.
 *
 * **Whether it waits for the person.** Always, for a note a task saves, under
 * every "What it may remember about you" setting. The task that wrote it may
 * have read a web page, an email or a connector's answer nobody vetted, or
 * been started by a trigger whose words came from outside, and nothing in the
 * run can prove a note's words are the person's. A kept note is part of what
 * the agent knows in its chat and voice prompt (`buildAgentPromptBlock`,
 * "## What you know"), outside any untrusted envelope, and a chat turn with no
 * untrusted content in it may change the agent's brief without a card. So
 * the person's Keep is the one gate between a task's words and the agent's
 * standing instructions. (Until 2026-10-30 "Everything you share with chats"
 * kept a task's note at once; a review showed a page could plant a standing
 * order that way.) A note on a sensitive topic (health, money trouble, …:
 * `sensitiveTopicOf`, the same gate memory uses) is logged as such. Nothing
 * reads a pending note.
 *
 * **What it may contain.** Never a secret, as far as a rule can tell one:
 *
 *   - a value beside a word that names a secret is refused: a password,
 *     passcode, PIN, one-time or verification code, a door, gate or alarm
 *     code, an API key or token, in English, French, German, Spanish,
 *     Portuguese, Italian or Dutch ("pw: …", "mot de passe : …", "Kennwort
 *     ist …", "door code is 4821");
 *   - a login given as a pair ("login is jdoe with S3cret-Pass99",
 *     "credentials are jdoe / Winter2026!") is refused;
 *   - a note that repeats a credential-shaped word the person typed into this
 *     task (its request, an answer, an instruction or an approval's reason),
 *     or any word of an answer to a question that asked for a secret, is
 *     refused (`personSecretValues`, fed by src/lib/agents/run-notes.ts):
 *     that is the literal case of "a secret the person typed";
 *   - card numbers that pass the Luhn check, spaced or not, and keys and
 *     tokens (`scanAndRedact` in src/lib/security/dlp.ts, the redaction
 *     shared transcripts use) are masked before the note is stored.
 *
 * These are rules over words, so a secret phrased in a way none of them
 * knows can still get through; the review above is the backstop for a task's
 * notes, and Forget removes any note from every later turn. A note that is
 * nothing but a mask after redaction is refused: it would be a note about
 * nothing.
 *
 * Pure and client-safe.
 */

import { sensitiveTopicOf } from "@/lib/memory-sensitive";
import { scanAndRedact } from "@/lib/security/dlp";

export const AGENT_NOTE_STATUSES = ["kept", "pending"] as const;
export type AgentNoteStatus = (typeof AGENT_NOTE_STATUSES)[number];

/** A stored status read back; anything unknown is `pending`, never quietly kept. */
export function agentNoteStatusOf(value: unknown): AgentNoteStatus {
  return value === "kept" ? "kept" : "pending";
}

/**
 * The default most notes one run may save (`AGENT_RUN_NOTES_PER_RUN` in env,
 * read by src/lib/agents/orbit-limits.ts). A run that wants more is
 * narrating, not learning.
 */
export const MAX_RUN_NOTES_PER_RUN = 3;
/** The default length of one note a task saves (`AGENT_RUN_NOTE_MAX_CHARS`): a fact, not a transcript. */
export const MAX_RUN_NOTE_CHARS = 500;

export type RunNoteReview = { status: "pending"; reason: "needs_review" | "sensitive" };

/**
 * A note a task saved always waits for the person (see the note at the top
 * of this file); the reason says whether it also touches a sensitive topic.
 */
export function runNoteReview(input: { content: string }): RunNoteReview {
  return { status: "pending", reason: sensitiveTopicOf(input.content) !== null ? "sensitive" : "needs_review" };
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** Word boundaries that know accented letters (`\b` is ASCII-only). */
const B_START = "(?<![\\p{L}\\p{N}_])";
const B_END = "(?![\\p{L}\\p{N}_])";
/** A backtick, for the character classes below (a literal one would close their template strings). */
const BT = String.fromCharCode(96);

/**
 * The words that name a secret: English, French, German, Spanish,
 * Portuguese, Italian and Dutch. A door, gate or alarm code is a secret like
 * a password. Words that are also everyday words ("key", "code", "clave")
 * are only labels in a phrase that makes them one ("door code", "clave de
 * acceso").
 */
const SECRET_LABEL = `(?:${[
  "pass(?:word|code|phrase)s?",
  "passwd",
  "pwd",
  "pw",
  "pin(?:[-\\s]*code)?",
  "one[-\\s]?time\\s+(?:code|password)",
  "otp",
  "(?:2fa|mfa)\\s+code",
  "(?:verification|security|login|backup|recovery|sign[-\\s]?in)\\s+code",
  "recovery\\s+(?:key|phrase)",
  "seed\\s+phrase",
  "cvv2?",
  "cvc",
  "api[-\\s]?key",
  "secret(?:\\s+key)?",
  "access\\s+token",
  "auth(?:entication)?\\s+token",
  "(?:door|gate|alarm|garage|access|entry|lock|safe|keypad|building|lockbox|key\\s*box|wi-?fi)\\s+(?:code|key)",
  "mot\\s+de\\s+passe",
  "mdp",
  "digicode",
  "code\\s+(?:secret|pin|confidentiel|d['’]\\s*acc[eè]s|d['’]\\s*entr[ée]e|de\\s+(?:la\\s+|l['’]\\s*)?(?:porte|portail|alarme|garage|immeuble|s[ée]curit[ée]|v[ée]rification|coffre))",
  "passwort",
  "kennwort",
  "zugangscode",
  "t[üu]rcode",
  "geheimzahl",
  "contrase[ñn]a",
  "clave\\s+de\\s+acceso",
  "c[óo]digo\\s+(?:de\\s+(?:acceso|seguridad|la\\s+puerta)|secreto)",
  "senha",
  "palavra[-\\s]passe",
  "parola\\s+d['’]\\s*ordine",
  "codice\\s+(?:di\\s+accesso|segreto)",
  "wachtwoord",
  "toegangscode",
].join("|")})`;

/** "is", "est", "ist", "es", "é": what joins a label to its value, in the same languages. */
const COPULA = `${B_START}(?:is|was|are|were|est|était|etait|ist|war|lautet|sind|sont|es|era|é|è|vaut)${B_END}`;

const LABEL = new RegExp(`${B_START}${SECRET_LABEL}${B_END}`, "giu");
const VALUE_AFTER = new RegExp(`(?:${COPULA}|=|:)\\s*["'${BT}«“]?\\s*([^\\s"'${BT},;.«»“”]{3,})`, "giu");
const DIGITS_AFTER = /^\s*(?:#|n[°o]\.?|:)?\s*(\d{4,})(?![\p{L}\p{N}])/u;

/** Words that may follow a secret's label without being its value ("the password is required"). */
const NOT_A_VALUE = new RegExp(
  `^(?:${[
    // English
    "required|needed|missing|wrong|incorrect|expired|stored|saved|reset|changed|in|on|at|for|the|a|an|to|from|with|by|of|and|or|not|set|kept|managed|shared|unknown|correct|valid|invalid|same|different|long|short|weak|strong|case|sent|emailed|texted|written|listed|available|hidden|private|unchanged|temporary|optional|rotated|locked|blocked|printed|attached|below|above|here|there|it|this|that|still|now|also|only|being|been|asked|requested",
    // French
    "requis|requise|obligatoire|nécessaire|necessaire|oublié|oubliée|oublie|changé|changée|change|perdu|perdue|expiré|expire|dans|sur|pour|le|la|les|un|une|des|du|de|en|au|aux|chez|ici|toujours|encore|incorrect|faux|stocké|stockée|enregistré|enregistrée",
    // German
    "erforderlich|nötig|notig|falsch|geändert|geandert|abgelaufen|gespeichert|im|der|die|das|ein|eine|bei|auf|für|fur|noch|hier|unbekannt",
    // Spanish, Portuguese, Italian, Dutch
    "requerido|requerida|necesario|necesaria|obligatorio|obligatoria|el|los|las|una|uno|del|obrigatório|obrigatoria|necessário|necessario|na|no|uma|um|il|lo|gli|nel|nella|vereist|nodig|het|een|op",
  ].join("|")})$`,
  "iu"
);

/** The values the text puts beside a secret's label, within a short phrase of it. */
function labelledValues(text: string): string[] {
  const out: string[] = [];
  for (const label of text.matchAll(LABEL)) {
    const start = (label.index ?? 0) + label[0].length;
    // The phrase after the label: up to a sentence's end, a line or a semicolon.
    const window = (text.slice(start, start + 60).split(/\n|;|\.(?:\s|$)/u)[0] ?? "").trimEnd();
    for (const match of window.matchAll(VALUE_AFTER)) {
      // Only a value joined to the label within a short gap: "the password is
      // required on Fridays and the office is closed" is not "closed".
      if ((match.index ?? 0) > 30) break;
      const value = match[1] ?? "";
      if (!NOT_A_VALUE.test(value)) out.push(value);
    }
    const digits = DIGITS_AFTER.exec(window);
    if (digits) out.push(digits[1]!);
  }
  return out;
}

/** Symbols a password has and an order number or a version rarely does. */
const SYMBOL = /[!$%^*?~+=_|<>@]/;

/** An email address or a link: a token the person typed that is not a secret. */
function isAddress(token: string): boolean {
  return /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(token) || /:\/\/|^www\./iu.test(token);
}

/** A login given as a pair: "login is jdoe with S3cret-Pass99", "credentials: jdoe / Winter2026!". */
const LOGIN_LABEL = new RegExp(
  `${B_START}(?:log[-\\s]?in|sign[-\\s]?in|credentials?|identifiants?|zugangsdaten|anmeldedaten|credenciales|credenziali|credenciais|inloggegevens)${B_END}`,
  "giu"
);
const LOGIN_PAIR = new RegExp(
  `^[^\\n;]{0,40}?(?:${COPULA}|=|:)\\s*(\\S{2,})\\s*(?:\\/|,|&|\\+|${B_START}(?:and|with|plus|et|avec|und|mit|y|con|e|en|met)${B_END})\\s*["'${BT}]?([^\\s"'${BT},;]{4,})`,
  "iu"
);

function loginValues(text: string): string[] {
  const out: string[] = [];
  for (const label of text.matchAll(LOGIN_LABEL)) {
    const start = (label.index ?? 0) + label[0].length;
    const pair = LOGIN_PAIR.exec(text.slice(start, start + 120));
    const value = (pair?.[2] ?? "").replace(/\.+$/u, "");
    // The second half of a pair is a password when it has a digit or a
    // symbol in it; "login is admin and the dashboard…" is not a pair.
    if (value.length >= 4 && !NOT_A_VALUE.test(value) && !isAddress(value) && (/\d/.test(value) || SYMBOL.test(value))) {
      out.push(value);
    }
  }
  return out;
}

/**
 * Whether a token looks like a password rather than a word, a code name or an
 * order number: six characters or more, a digit, a letter, and either both
 * cases or a symbol ("Hunter2!", "Tr0ub4dor", "Soleil2024"). "Q3-2026",
 * "INV-20431" and "v2.3.1" are not.
 */
export function credentialShaped(token: string): boolean {
  if (token.length < 6 || isAddress(token)) return false;
  const lower = /\p{Ll}/u.test(token);
  const upper = /\p{Lu}/u.test(token);
  const digit = /\d/.test(token);
  return digit && (lower || upper) && ((lower && upper) || SYMBOL.test(token));
}

/** Whether the text names a secret together with its value. */
export function namesASecretValue(text: string): boolean {
  return labelledValues(text).length > 0 || loginValues(text).length > 0;
}

const LABEL_ANYWHERE = new RegExp(`${B_START}${SECRET_LABEL}${B_END}`, "iu");
const LOGIN_ANYWHERE = new RegExp(LOGIN_LABEL.source, "iu");

/** Whether the text names a secret or a login at all ("What is the door code?"). */
export function asksForASecret(text: string): boolean {
  return LABEL_ANYWHERE.test(text) || LOGIN_ANYWHERE.test(text);
}

/** Something the person typed into a task, and the question it answers when it is an answer. */
export interface PersonWords {
  text: string;
  question?: string | null;
}

/** A token as typed, without the quotes or the sentence's punctuation around it. */
function bareToken(token: string): string {
  return token.replace(new RegExp(`^["'${BT}«“(\\[]+`, "u"), "").replace(new RegExp(`["'${BT}»”)\\],;:.]+$`, "u"), "");
}

/**
 * The values a note must never repeat, from what the person typed into the
 * task: anything they put beside a secret's label or gave as a login pair;
 * every credential-shaped token (`credentialShaped`); and, for an answer to a
 * question that asked for a secret, the answer itself when it is one word and
 * every word in it with a digit or a symbol ("4821", "It's 4821").
 *
 * Not every word of six letters: "invoices" and "Monday" are what notes are
 * made of, and a note may well repeat them.
 */
export function personSecretValues(words: readonly PersonWords[]): string[] {
  const values = new Set<string>();
  for (const { text, question } of words) {
    if (typeof text !== "string" || !text.trim()) continue;
    for (const value of labelledValues(text)) values.add(value);
    for (const value of loginValues(text)) values.add(value);
    const tokens = text.trim().split(/\s+/u).map(bareToken).filter((token) => token.length > 0);
    for (const token of tokens) if (credentialShaped(token)) values.add(token);
    if (typeof question === "string" && asksForASecret(question)) {
      if (tokens.length === 1 && tokens[0]!.length >= 3) values.add(tokens[0]!);
      for (const token of tokens) {
        if (token.length >= 3 && !isAddress(token) && (/\d/.test(token) || SYMBOL.test(token))) values.add(token);
      }
    }
  }
  return [...values].filter((value) => value.length >= 3);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether the note repeats one of `values` as a whole word, in any case. */
export function repeatsPersonSecret(note: string, values: readonly string[]): boolean {
  return values.some(
    (value) => value.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, "iu").test(note)
  );
}

/** A run of 13 to 19 digits, spaced, dashed or not: a card number when it passes the Luhn check. */
const CARD_RUN = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The text with every card number masked as the shared redaction masks one, and how many there were. */
function maskCards(text: string): { text: string; count: number } {
  let count = 0;
  const masked = text.replace(CARD_RUN, (run) => {
    const digits = run.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return run;
    count++;
    return `[REDACTED_CARD_ending_in_${digits.slice(-4)}]`;
  });
  return { text: masked, count };
}

export type ScreenedNote =
  | { ok: true; content: string; redacted: number }
  | { ok: false; reason: "empty" | "too_long" | "secret"; message: string };

const SECRET_REFUSAL =
  "That note names a password, code, key or login with its value, and notes never keep secrets. Nothing was saved. Remember where the secret lives instead, never the secret.";
const PERSON_SECRET_REFUSAL =
  "That note repeats something the person typed into this task that looks like a password, code or login, and notes never keep secrets. Nothing was saved. Remember where it is kept instead, never the value.";

/**
 * The note as it may be stored, or why it may not be. `maxChars` is a task's
 * bound by default; a note the person or their chat writes has the profile's
 * longer one (`MAX_AGENT_NOTE_CHARS`), and the same secret rules.
 * `personSecrets` are the values from `personSecretValues`, for a note a
 * task saves.
 */
export function screenAgentNote(
  raw: unknown,
  options: { maxChars?: number; personSecrets?: readonly string[] } = {}
): ScreenedNote {
  const maxChars = options.maxChars ?? MAX_RUN_NOTE_CHARS;
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!text) return { ok: false, reason: "empty", message: "Say the fact to remember in a sentence." };
  if (text.length > maxChars) {
    return {
      ok: false,
      reason: "too_long",
      message: `That is ${text.length} characters; a note is at most ${maxChars}. Keep only the fact worth remembering.`,
    };
  }
  if (namesASecretValue(text)) return { ok: false, reason: "secret", message: SECRET_REFUSAL };
  if (options.personSecrets && repeatsPersonSecret(text, options.personSecrets)) {
    return { ok: false, reason: "secret", message: PERSON_SECRET_REFUSAL };
  }
  const cards = maskCards(text);
  const scan = scanAndRedact(cards.text);
  const content = scan.sanitizedText.trim();
  const redacted = cards.count + scan.redactedCount;
  // Only masks left: a note about nothing.
  if (redacted > 0 && content.replace(/\[REDACTED[^\]]*\]/g, "").replace(/[\s\p{P}]/gu, "").length < 8) {
    return {
      ok: false,
      reason: "secret",
      message: "That note was only a key, a token or a card number, and notes never keep secrets. Nothing was saved.",
    };
  }
  return { ok: true, content, redacted };
}
