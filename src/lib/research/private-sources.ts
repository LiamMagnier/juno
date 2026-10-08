/**
 * Deep Research's own-sources vocabulary: which of the person's private
 * sources a run may read, how a private source is addressed, and what is
 * allowed to leave the building as a web query.
 *
 * Pure and client-safe on purpose. The scope card, the report reader, the
 * engine and the native contract all need the same answers to "is this a
 * private source?", "what kind?" and "was it enabled?", and two copies of the
 * rule would drift exactly where a drift is a privacy bug.
 *
 * ## Addressing
 *
 * A private source is a `ResearchSource` row like any web page — snapshot,
 * passages, findings and the citation audit all work unchanged — whose URL is
 * `https://private.invalid/<kind>/<id>[?at=<locator>]`.
 *
 * Why an https URL on a reserved host rather than a scheme of our own: the
 * chat wire's `ClientSource.url` reaches native clients that are already
 * shipped, and their decoder refuses (throws on) any source that is not
 * http(s) with a host — one `private:` source would fail the whole stream.
 * `.invalid` is reserved (RFC 6761) and never resolves, so an older client
 * shows "private.invalid" under the title and an accidental open goes
 * nowhere. Every current renderer asks `isPrivateSourceUrl` first and draws
 * the kind's glyph with no link, and no fetcher in the run will request it
 * (the engine refuses it explicitly at the fetch gate).
 * The locator rides in the query string rather than the fragment because
 * `canonicalUrl` drops fragments, and page 3 and page 9 of one PDF are two
 * different citations.
 *
 * ## The gate
 *
 * The run records the options it OFFERED (computed server-side from what the
 * person actually has: files in this chat, a project, a library, connected
 * connectors) and the keys that are ENABLED. Enabling is only ever an
 * intersection with the offered list, so a crafted request can switch off
 * what was offered but never switch on something that was not.
 */

/** The kinds of private source a run can read. Additive: new kinds go on the end. */
export const PRIVATE_SOURCE_KINDS = [
  /** Files attached to this conversation. */
  "file",
  /** Files and knowledge of the conversation's project. */
  "project",
  /** The person's library (saved files and artifacts). */
  "library",
  /** Saved memories. Off by default. */
  "memory",
  /** A calendar connector (Apple Calendar, Google Calendar…). */
  "calendar",
  /** A mail connector (Apple Mail, Gmail…). */
  "mail",
  /** Any other read-capable connector (MCP, Composio, Drive…). */
  "connector",
] as const;

export type PrivateSourceKind = (typeof PRIVATE_SOURCE_KINDS)[number];

export function isPrivateSourceKind(value: unknown): value is PrivateSourceKind {
  return typeof value === "string" && (PRIVATE_SOURCE_KINDS as readonly string[]).includes(value);
}

/** The reserved host a private source's URL is written on. */
export const PRIVATE_SOURCE_HOST = "private.invalid";
const PRIVATE_PREFIX = `https://${PRIVATE_SOURCE_HOST}/`;

/** Whether a URL addresses one of the person's own sources rather than the web. */
export function isPrivateSourceUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.trim().toLowerCase().startsWith(PRIVATE_PREFIX);
}

export interface PrivateSourceAddress {
  kind: PrivateSourceKind;
  /** The record's id inside its store (attachment id, event id, message id…). */
  id: string;
  /** Where in the record: "p. 3", "§2", a chunk ordinal. Absent for a whole record. */
  locator?: string;
}

const MAX_ID_CHARS = 200;
const MAX_LOCATOR_CHARS = 60;

/** `https://private.invalid/<kind>/<id>[?at=<locator>]`. */
export function privateSourceUrl(address: PrivateSourceAddress): string {
  const id = encodeURIComponent(address.id.slice(0, MAX_ID_CHARS));
  const locator = address.locator?.trim().slice(0, MAX_LOCATOR_CHARS);
  return `${PRIVATE_PREFIX}${address.kind}/${id}${locator ? `?at=${encodeURIComponent(locator)}` : ""}`;
}

/** The address back out of a private URL, or null for anything else (web URLs included). */
export function parsePrivateSourceUrl(url: string | null | undefined): PrivateSourceAddress | null {
  if (!isPrivateSourceUrl(url)) return null;
  const match = /^https:\/\/private\.invalid\/([a-z_]+)\/([^?#/]+)(?:\?at=([^#&]*))?/i.exec((url as string).trim());
  if (!match) return null;
  const kind = match[1].toLowerCase();
  if (!isPrivateSourceKind(kind)) return null;
  let id: string;
  let locator: string | undefined;
  try {
    id = decodeURIComponent(match[2]);
    locator = match[3] ? decodeURIComponent(match[3]) : undefined;
  } catch {
    return null;
  }
  if (!id) return null;
  return { kind, id, ...(locator ? { locator } : {}) };
}

/** English names for a kind: model-facing prompts and the server's fallbacks. The UI uses its own phrases. */
export const PRIVATE_SOURCE_KIND_NAME: Record<PrivateSourceKind, string> = {
  file: "File in this chat",
  project: "Project file",
  library: "Library item",
  memory: "Saved memory",
  calendar: "Calendar event",
  mail: "Email",
  connector: "Connected app",
};

/** What a citation shows in place of a website's domain: whose it is, and what kind. */
export const PRIVATE_SOURCE_LABEL: Record<PrivateSourceKind, string> = {
  file: "Your files",
  project: "Your project",
  library: "Your library",
  memory: "Your memories",
  calendar: "Your calendar",
  mail: "Your mail",
  connector: "Your apps",
};

// ---------------------------------------------------------------------------
// The scope gate
// ---------------------------------------------------------------------------

/** One private source the run can offer the person at the gate. */
export interface PrivateSourceOption {
  /** Stable key: the kind for the built-in sources, `kind:connectorId` for a connector. */
  key: string;
  kind: PrivateSourceKind;
  /** The connector's own name ("Apple Calendar", "Gmail"), or the project's name. Display only. */
  label?: string;
  /** How many records it holds, when that is cheap to know ("3 files"). */
  count?: number;
  /** The connector that backs it, for `calendar`, `mail` and `connector`. */
  connectorId?: string;
  /** Whether it starts switched on. Web, this chat's files and the current project do. */
  defaultOn: boolean;
}

/**
 * Which sources a run reads, as frozen on `plan.sources`.
 *
 * `options` is what the server offered; `enabled` is always a subset of
 * its keys. `web: false` is allowed only while at least one private source
 * is enabled — a run with nothing to read is not a run.
 */
export interface ResearchSourceSelection {
  v: 1;
  web: boolean;
  enabled: string[];
  options: PrivateSourceOption[];
  /** Questions already run against the private sources, so a follow-up pass searches only new ones. */
  issued?: string[];
}

export const MAX_PRIVATE_OPTIONS = 12;
const MAX_KEY_CHARS = 120;
const MAX_LABEL_CHARS = 80;
const MAX_ISSUED = 48;

/** The kinds that are on by default when offered (owner's rule: web + attached files + current project). */
export const DEFAULT_ON_KINDS: ReadonlySet<PrivateSourceKind> = new Set(["file", "project"]);

function cleanOption(value: unknown): PrivateSourceOption | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isPrivateSourceKind(raw.kind)) return null;
  const key = typeof raw.key === "string" ? raw.key.trim().slice(0, MAX_KEY_CHARS) : "";
  if (!key) return null;
  const label = typeof raw.label === "string" ? raw.label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS) : "";
  const count = typeof raw.count === "number" && Number.isFinite(raw.count) && raw.count >= 0 ? Math.floor(raw.count) : null;
  const connectorId = typeof raw.connectorId === "string" ? raw.connectorId.trim().slice(0, MAX_KEY_CHARS) : "";
  return {
    key,
    kind: raw.kind,
    ...(label ? { label } : {}),
    ...(count !== null ? { count } : {}),
    ...(connectorId ? { connectorId } : {}),
    defaultOn: raw.defaultOn === true,
  };
}

/** The selection back off a stored plan, tolerant of anything; undefined when absent or unusable. */
export function parseSourceSelection(value: unknown): ResearchSourceSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const options: PrivateSourceOption[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.options) ? raw.options : []) {
    const option = cleanOption(item);
    if (!option || seen.has(option.key)) continue;
    seen.add(option.key);
    options.push(option);
    if (options.length >= MAX_PRIVATE_OPTIONS) break;
  }
  const enabled = Array.isArray(raw.enabled)
    ? [...new Set(raw.enabled.filter((key): key is string => typeof key === "string" && seen.has(key)))]
    : [];
  const issued = Array.isArray(raw.issued)
    ? raw.issued.filter((q): q is string => typeof q === "string" && !!q.trim()).slice(-MAX_ISSUED).map((q) => q.slice(0, 400))
    : undefined;
  const web = raw.web === false && enabled.length > 0 ? false : true;
  return { v: 1, web, enabled, options, ...(issued ? { issued } : {}) };
}

/** The selection a run starts with: the web, plus every offered option that is on by default. */
export function defaultSourceSelection(options: readonly PrivateSourceOption[]): ResearchSourceSelection {
  const clean = parseSourceSelection({ options, enabled: [] })?.options ?? [];
  return { v: 1, web: true, enabled: clean.filter((option) => option.defaultOn).map((option) => option.key), options: clean };
}

/**
 * The person's choice at the gate applied to what was offered.
 *
 * `enabled` is intersected with the offered keys — a key the server did not
 * offer is dropped, never added — and the web cannot be switched off unless
 * something private is left on.
 */
export function applySourceChoice(
  selection: ResearchSourceSelection,
  choice: { web?: boolean; enabled?: readonly string[] } | null | undefined
): ResearchSourceSelection {
  if (!choice) return selection;
  const offered = new Set(selection.options.map((option) => option.key));
  const enabled = choice.enabled ? [...new Set(choice.enabled.filter((key) => offered.has(key)))] : selection.enabled;
  const web = choice.web === false && enabled.length > 0 ? false : choice.web === undefined ? selection.web || enabled.length === 0 : true;
  return { ...selection, web, enabled };
}

/** The options a selection actually reads. */
export function enabledOptions(selection: ResearchSourceSelection | undefined | null): PrivateSourceOption[] {
  if (!selection) return [];
  const on = new Set(selection.enabled);
  return selection.options.filter((option) => on.has(option.key));
}

/** Whether a run may search the public web. A run planned before this existed always could. */
export function webEnabled(selection: ResearchSourceSelection | undefined | null): boolean {
  return selection ? selection.web : true;
}

/** Display name for an option in model-facing text: "Apple Calendar (Calendar event)". */
export function privateOptionName(option: PrivateSourceOption): string {
  const kind = PRIVATE_SOURCE_KIND_NAME[option.kind];
  return option.label ? `${option.label} (${kind.toLowerCase()})` : kind;
}

// ---------------------------------------------------------------------------
// What may leave as a web query
// ---------------------------------------------------------------------------

/**
 * A fingerprint of the run's private text: the things that must never reach a
 * search engine. Built from the private sources' titles and bodies.
 *
 * - `shingles`: every run of three consecutive normalised words in the
 *   private text. A query that reproduces three words in a row from someone's
 *   email or file is quoting it, whatever the intent.
 * - `titles`: private titles (file names, subjects, event names) as phrases.
 * - `terms`: distinctive identifiers that appear in private text and leak
 *   alone: e-mail addresses, long numbers, and the words of capitalised
 *   names ("Jane Hollingsworth", "Acme Widgets") — except words the person's
 *   own research question already uses, which are public by their choice
 *   (a private memo about "GitHub Copilot" must not stop the run searching
 *   for Copilot).
 */
export interface PrivateFingerprint {
  shingles: Set<string>;
  titles: string[];
  terms: Set<string>;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
/** Phone numbers, account numbers, IBANs, card-like runs: six or more digits, optionally separated. */
const LONG_NUMBER = /(?:\+?\d[\d\s().-]{4,}\d)/g;
const PRIVATE_LINK = /https?:\/\/private\.invalid\S*/gi;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
/** Two or more capitalised words in a row: people, companies, places, products named in private text. */
const NAME = /\p{Lu}[\p{L}'’-]+(?:[ \t]+\p{Lu}[\p{L}'’-]+)+/gu;

/** Words common enough that a shared run of them proves nothing. */
const COMMON = new Set(
  "the a an and or of to in on for with at by from as is are was were be been it this that these those your you our we they their i me my not no but if then than so do does did have has had will would can could should about into over under after before more most less per via vs".split(
    " "
  )
);

function words(text: string): string[] {
  return (text.normalize("NFKC").toLowerCase().match(WORD) ?? []).map((w) => w.replace(/['’]/g, ""));
}

const MAX_FINGERPRINT_SHINGLES = 200_000;

export function buildPrivateFingerprint(
  sources: ReadonlyArray<{ title?: string | null; text?: string | null }>,
  /** The person's own question and plan: words in it are public by their choice. */
  publicText = ""
): PrivateFingerprint {
  const shingles = new Set<string>();
  const titles: string[] = [];
  const terms = new Set<string>();
  const publicWords = new Set(words(publicText));
  for (const source of sources) {
    const title = (source.title ?? "").replace(/\s+/g, " ").trim();
    // The title's subject part: "Q3 board pack.pdf · p. 3" → "q3 board pack".
    const subject = title.split(/\s+[·—–|]\s+/)[0]?.replace(/\.[a-z0-9]{1,5}$/i, "") ?? "";
    const titleWords = words(subject);
    if (titleWords.filter((w) => !COMMON.has(w)).length >= 2) titles.push(titleWords.join(" "));
    const body = `${title}\n${source.text ?? ""}`;
    for (const match of body.match(EMAIL) ?? []) terms.add(match.toLowerCase());
    for (const match of body.match(LONG_NUMBER) ?? []) {
      const digits = match.replace(/\D/g, "");
      if (digits.length >= 6) terms.add(digits);
    }
    for (const match of body.match(NAME) ?? []) {
      for (const word of words(match)) if (!COMMON.has(word) && !publicWords.has(word) && word.length > 1) terms.add(word);
    }
    const list = words(body);
    for (let i = 0; i + 2 < list.length && shingles.size < MAX_FINGERPRINT_SHINGLES; i += 1) {
      const window = list.slice(i, i + 3);
      // A run of filler words is shared with every page on the web.
      if (window.every((w) => COMMON.has(w))) continue;
      shingles.add(window.join(" "));
    }
  }
  return { shingles, titles, terms };
}

export interface SanitisedQuery {
  /** The query that may be sent, or null when nothing safe is left of it. */
  query: string | null;
  /** Whether anything was removed. */
  changed: boolean;
}

/** A query must keep at least this many meaningful words to be worth sending. */
const MIN_QUERY_WORDS = 2;

/**
 * What of a web query may be sent to a search engine.
 *
 * Always strips e-mail addresses, long digit runs and private links. Against
 * a fingerprint it also removes every word that is part of a three-word run
 * quoted from the private text, any private title the query contains, and
 * any distinctive private term (a name or identifier that appears in the
 * private sources). What is left is the public part of the question; when
 * something was removed and fewer than two meaningful words are left, the
 * query is withheld entirely.
 *
 * The workers are told the same rule, but a prompt is a request and this is
 * the guarantee: every web search the engine makes goes through here.
 */
export function sanitiseWebQuery(query: string, fingerprint: PrivateFingerprint | null): SanitisedQuery {
  let text = query.replace(PRIVATE_LINK, " ").replace(EMAIL, " ");
  text = text.replace(LONG_NUMBER, (match) => (match.replace(/\D/g, "").length >= 6 ? " " : match));
  const tokens = text.split(/\s+/).filter(Boolean);
  const keep = tokens.map(() => true);
  if (fingerprint) {
    const norm = tokens.map((token) => words(token).join(" "));
    // Three-word runs quoted from private text.
    for (let i = 0; i + 2 < norm.length; i += 1) {
      const window = norm.slice(i, i + 3);
      if (window.some((w) => !w)) continue;
      if (fingerprint.shingles.has(window.join(" "))) keep[i] = keep[i + 1] = keep[i + 2] = false;
    }
    // Private titles, as phrases.
    const joined = norm.join(" ");
    for (const title of fingerprint.titles) {
      if (!title || !joined.includes(title)) continue;
      const parts = title.split(" ");
      for (let i = 0; i + parts.length <= norm.length; i += 1) {
        if (parts.every((part, j) => norm[i + j] === part)) for (let j = 0; j < parts.length; j += 1) keep[i + j] = false;
      }
    }
    // Distinctive private terms, alone.
    norm.forEach((w, i) => {
      if (w && fingerprint.terms.has(w)) keep[i] = false;
    });
  }
  const kept = tokens.filter((_, i) => keep[i]).join(" ").replace(/\s+/g, " ").trim();
  const meaningful = words(kept).filter((w) => !COMMON.has(w)).length;
  const changed = kept !== query.replace(/\s+/g, " ").trim();
  // A query nothing was taken from goes out as written, however short; one
  // that lost words is sent only if a meaningful public question is left.
  if (!changed) return { query: kept || query, changed: false };
  if (meaningful < MIN_QUERY_WORDS) return { query: null, changed: true };
  return { query: kept, changed };
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

const DATE_FMT = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The title a private source is cited by: the file and page, the subject and
 * date, the event and when. These are the person's own records, so the
 * title is what lets them find it again.
 */
export function privateSourceTitle(input: {
  kind: PrivateSourceKind;
  name: string;
  locator?: string | null;
  date?: Date | null;
}): string {
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 160) || PRIVATE_SOURCE_KIND_NAME[input.kind];
  const date = input.date instanceof Date && Number.isFinite(input.date.getTime()) ? DATE_FMT(input.date) : null;
  switch (input.kind) {
    case "mail":
    case "calendar":
      return date ? `${name} — ${date}` : name;
    default:
      return input.locator ? `${name} · ${input.locator}` : name;
  }
}

/** One line of OUR metadata above a private source in the writer's corpus. */
export function privateSourceMetaLine(url: string, publishedAt?: Date | null): string | null {
  const address = parsePrivateSourceUrl(url);
  if (!address) return null;
  const date =
    publishedAt instanceof Date && Number.isFinite(publishedAt.getTime()) ? `dated ${DATE_FMT(publishedAt)}` : "undated";
  return `(PRIVATE — the person's own ${PRIVATE_SOURCE_KIND_NAME[address.kind].toLowerCase()}${address.locator ? `, ${address.locator}` : ""} · ${date})`;
}
