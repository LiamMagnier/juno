/**
 * Text a page ships as data rather than markup: JSON-LD, and the state a
 * client-rendered app hydrates from.
 *
 * A Next.js, Nuxt, Remix or Vite page served to a plain HTTP client is often
 * an empty `<div id="__next">` plus the whole page as JSON in a script tag
 * (`__NEXT_DATA__`, `application/json` islands, `window.__INITIAL_STATE__ =
 * {…}`). The extractor dropped every script, so those pages came back as
 * `empty_document` — the vendor pricing pages and status histories the
 * research protocol names as primary records among them — and a run either
 * skipped them or, on the deployments that opted in, paid for a headless
 * browser to render what was already in the bytes. JSON-LD is the same story
 * for products, offers, FAQs and news articles (with their publication date
 * and author, which the page's `<meta>` tags often lack).
 *
 * Everything here is page content and stays untrusted: the caller appends it
 * to the page text, which travels inside the same untrusted envelope. It is
 * bounded on every axis — bytes parsed per blob and in total, nodes visited,
 * depth, characters out — and never throws.
 */

import { cellText } from "@/lib/web/html-table";

/** One blob found in a `<script>`, before parsing. */
export interface ScriptBlob {
  kind: "ld" | "state";
  body: string;
  /** The blob's id or variable name, for picking the right subtree. */
  name?: string;
}

/** The most one blob may be; a page with more state than this is not shipping text in it. */
export const MAX_BLOB_CHARS = 1_500_000;
/** The most all of a page's blobs may add up to. */
export const MAX_BLOBS_CHARS = 3_000_000;
export const MAX_BLOBS = 24;
const MAX_NODES = 30_000;
const MAX_DEPTH = 14;
const MAX_OUTPUT_CHARS = 40_000;
const MAX_TABLE_ITEMS = 60;

/** Script types and ids that carry a page's state as pure JSON. */
const STATE_IDS = /^(?:__NEXT_DATA__|__NUXT_DATA__|__APOLLO_STATE__|__REMIX_CONTEXT__|__INITIAL_STATE__|__PRELOADED_STATE__|__SERVER_DATA__|__DATA__)$/;

/**
 * Whether a `<script>` with these attributes carries JSON a reader can use.
 * `type` and `id` are the parsed attribute values.
 */
export function scriptBlobKind(type: string | undefined, id: string | undefined): ScriptBlob["kind"] | null {
  const t = (type ?? "").trim().toLowerCase();
  if (t === "application/ld+json") return "ld";
  if (t === "application/json" || (id && STATE_IDS.test(id))) return "state";
  return null;
}

/** `window.__STATE__ = {…};` style assignments: the JSON literal and the variable's name, or null. */
export function assignedState(body: string): { json: string; name: string } | null {
  const trimmed = body.trim();
  if (trimmed.length > MAX_BLOB_CHARS) return null;
  // Bounded, anchored, no nested quantifiers: linear on any input.
  const head = /^(?:(?:window|self|globalThis)\.)?(__[A-Za-z0-9_]{1,40}__|__[A-Z][A-Z0-9_]{1,40})\s{0,8}=\s{0,8}/.exec(trimmed);
  if (!head) return null;
  const start = head[0].length;
  if (trimmed[start] !== "{" && trimmed[start] !== "[") return null;
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (end <= start) return null;
  // Only one statement: what follows the literal may be a semicolon and nothing else.
  if (trimmed.slice(end + 1).replace(/[;\s]/g, "")) return null;
  return { json: trimmed.slice(start, end + 1), name: head[1]! };
}

function parse(body: string): unknown {
  if (body.length > MAX_BLOB_CHARS) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Keys whose values are plumbing, never page text. */
const NOISE_KEY =
  /^(?:id|_id|key|uuid|slug|guid|sku|hash|token|csrf\w*|nonce|build\w*|locale|locales|lang|query|asPath|page|route|router|isFallback|gsp|gssp|scriptLoader|runtimeConfig|__\w+|className|class|style|styles|css|theme|color|colou?rs?|icon\w*|image\w*|img|logo|avatar|thumbnail|src|srcSet|href|url|link|path|canonical|width|height|size|alt|variant|component|type|typename|template|layout|tracking\w*|analytics\w*|experiment\w*|flags?|featureFlags|sentry\w*|dsn|env|config|apiKey|key\w*|cursor|etag|version|release|revision|timestamp|createdAt|ts)$/i;
/** Values that are identifiers, hashes, paths or markup rather than words. */
function isNoiseValue(value: string): boolean {
  if (!value.trim()) return true;
  if (/^(?:https?:)?\/\//i.test(value) || /^[./#]/.test(value)) return true;
  if (/^[A-Za-z0-9_+/=-]{20,}$/.test(value) && !/\s/.test(value)) return true;
  if (/^[0-9a-f-]{16,}$/i.test(value)) return true;
  if (/<\/?[a-z][^>]{0,80}>/i.test(value)) return true;
  if (/^(?:true|false|null|undefined)$/i.test(value)) return true;
  return false;
}

/** "requestsPerMinute" → "Requests per minute". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Prose: words and spaces, not an identifier. */
function isProse(value: string): boolean {
  return /\p{L}/u.test(value) && /\s/.test(value.trim()) && !isNoiseValue(value);
}

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

interface Walk {
  lines: string[];
  chars: number;
  nodes: number;
}

function push(walk: Walk, line: string): void {
  if (walk.chars >= MAX_OUTPUT_CHARS) return;
  walk.lines.push(line);
  walk.chars += line.length + 1;
}

/** Scalar keys a table of these objects would show: present in most items, not plumbing. */
function tableColumns(items: ReadonlyArray<Record<string, unknown>>): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (NOISE_KEY.test(key) || !isScalar(value) || typeof value === "boolean") continue;
      if (typeof value === "string" && isNoiseValue(value)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n >= Math.max(2, Math.ceil(items.length / 2))).map(([key]) => key).slice(0, 8);
}

function walkValue(value: unknown, key: string, depth: number, walk: Walk): void {
  if (walk.nodes++ > MAX_NODES || depth > MAX_DEPTH || walk.chars >= MAX_OUTPUT_CHARS) return;
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text || isNoiseValue(text) || (key && NOISE_KEY.test(key))) return;
    if (isProse(text)) push(walk, key && !/^(?:text|body|content|description|summary|answer|a|value|title|name|label|heading|subtitle)$/i.test(key) ? `${humanizeKey(key)}: ${text}` : text);
    else if (key && text.length <= 80) push(walk, `${humanizeKey(key)}: ${text}`);
    return;
  }
  if (typeof value === "number") {
    if (key && !NOISE_KEY.test(key) && Number.isFinite(value)) push(walk, `${humanizeKey(key)}: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    const objects = value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
    if (objects.length >= 2 && objects.length === value.length) {
      const columns = tableColumns(objects);
      // A list of like records with short fields is a table (plans, tiers,
      // incidents); with long prose fields it reads better as paragraphs.
      const long = objects.some((item) => columns.some((column) => String(item[column] ?? "").length > 160));
      if (columns.length >= 2 && !long) {
        if (key) push(walk, `\n${humanizeKey(key)}:`);
        push(walk, `| ${columns.map(humanizeKey).join(" | ")} |`);
        push(walk, `|${" --- |".repeat(columns.length)}`);
        for (const item of objects.slice(0, MAX_TABLE_ITEMS)) {
          push(walk, `| ${columns.map((column) => cellText(item[column] === undefined ? "" : String(item[column]))).join(" | ")} |`);
          walk.nodes += columns.length;
        }
        push(walk, "");
        // Nested non-scalar fields of each record (an FAQ's answer object, a plan's feature list).
        for (const item of objects.slice(0, MAX_TABLE_ITEMS)) {
          for (const [childKey, child] of Object.entries(item)) {
            if (!isScalar(child) && child !== null) walkValue(child, childKey, depth + 1, walk);
            else if (typeof child === "string" && !columns.includes(childKey) && isProse(child) && !NOISE_KEY.test(childKey)) walkValue(child, childKey, depth + 1, walk);
          }
        }
        return;
      }
    }
    for (const item of value) walkValue(item, isScalar(item) ? key : "", depth + 1, walk);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (NOISE_KEY.test(childKey) && (isScalar(child) || child === null)) continue;
      walkValue(child, childKey, depth + 1, walk);
    }
  }
}

/** Where a framework keeps the page itself inside its state object. */
function pageSubtree(value: unknown, name: string | undefined): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (name === "__NEXT_DATA__" || ("props" in record && "buildId" in record)) {
    const props = record.props as Record<string, unknown> | undefined;
    return props?.pageProps ?? props ?? value;
  }
  return value;
}

/** A client app's state as readable lines: prose, labelled figures, and lists of records as tables. */
export function stateToText(blobs: readonly ScriptBlob[]): string {
  const walk: Walk = { lines: [], chars: 0, nodes: 0 };
  let total = 0;
  for (const blob of blobs.slice(0, MAX_BLOBS)) {
    if (blob.kind !== "state") continue;
    total += blob.body.length;
    if (total > MAX_BLOBS_CHARS) break;
    const parsed = parse(blob.body);
    if (parsed === undefined) continue;
    walkValue(pageSubtree(parsed, blob.name), "", 0, walk);
  }
  return dedupeLines(walk.lines).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function dedupeLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.trim().toLowerCase();
    if (key && !key.startsWith("|") && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

export interface LinkedData {
  /** Readable lines for the types worth reading (product, offers, FAQ, article body, event, dataset). */
  text: string;
  publishedAt?: Date;
  author?: string;
  /** The article body when the markup carries one (often the only copy on a client-rendered page). */
  articleBody?: string;
}

type Node = Record<string, unknown>;

function nodesOf(value: unknown, out: Node[], depth = 0): void {
  if (depth > 6 || out.length > 200) return;
  if (Array.isArray(value)) {
    for (const item of value) nodesOf(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Node;
  if ("@graph" in node) nodesOf(node["@graph"], out, depth + 1);
  if ("@type" in node) out.push(node);
}

function typesOf(node: Node): string[] {
  const raw = node["@type"];
  return (Array.isArray(raw) ? raw : [raw]).filter((t): t is string => typeof t === "string");
}

function str(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "name" in value) return str((value as Node).name);
  return "";
}

function nameList(value: unknown): string {
  const items = Array.isArray(value) ? value : [value];
  return items.map(str).filter(Boolean).slice(0, 6).join(", ");
}

function offerRows(offers: unknown): string[][] {
  const list = (Array.isArray(offers) ? offers : [offers]).filter((o): o is Node => !!o && typeof o === "object");
  const rows: string[][] = [];
  for (const offer of list.slice(0, MAX_TABLE_ITEMS)) {
    if (typesOf(offer).includes("AggregateOffer")) {
      rows.push([
        str(offer.name) || "All offers",
        [str(offer.lowPrice), str(offer.highPrice)].filter(Boolean).join(" – ") || str(offer.price),
        str(offer.priceCurrency),
        str(offer.availability).replace(/^https?:\/\/schema\.org\//, ""),
      ]);
      if (offer.offers) rows.push(...offerRows(offer.offers));
      continue;
    }
    const spec = offer.priceSpecification as Node | undefined;
    rows.push([
      str(offer.name) || str(offer.category) || "Offer",
      str(offer.price) || str(spec?.price),
      str(offer.priceCurrency) || str(spec?.priceCurrency),
      str(offer.availability).replace(/^https?:\/\/schema\.org\//, ""),
    ]);
  }
  return rows.filter((row) => row[1]);
}

function dateOf(value: unknown): Date | undefined {
  const raw = str(value);
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

/** The JSON-LD on a page, as the lines a reader needs and the dates and authors it states. */
export function linkedDataToText(blobs: readonly ScriptBlob[]): LinkedData {
  const nodes: Node[] = [];
  let total = 0;
  for (const blob of blobs.slice(0, MAX_BLOBS)) {
    if (blob.kind !== "ld") continue;
    total += blob.body.length;
    if (total > MAX_BLOBS_CHARS) break;
    nodesOf(parse(blob.body), nodes);
  }
  const lines: string[] = [];
  let publishedAt: Date | undefined;
  let author: string | undefined;
  let articleBody: string | undefined;
  for (const node of nodes) {
    const types = typesOf(node);
    if (types.some((t) => /Article|BlogPosting|Report|NewsArticle/.test(t))) {
      publishedAt ??= dateOf(node.datePublished) ?? dateOf(node.dateModified);
      author ??= nameList(node.author) || undefined;
      const body = str(node.articleBody);
      if (body && !articleBody) articleBody = body.slice(0, MAX_OUTPUT_CHARS);
      const headline = str(node.headline);
      if (headline) lines.push(`Headline: ${headline}`);
      continue;
    }
    if (types.some((t) => /Product|SoftwareApplication|Service|Offer/.test(t))) {
      const name = str(node.name);
      lines.push(`${types[0]}: ${name || "(unnamed)"}`);
      const brand = str(node.brand);
      if (brand) lines.push(`Brand: ${brand}`);
      const description = str(node.description);
      if (description) lines.push(description);
      for (const key of ["operatingSystem", "applicationCategory", "model", "gtin13", "releaseDate"]) {
        const value = str(node[key]);
        if (value) lines.push(`${humanizeKey(key)}: ${value}`);
      }
      const rows = offerRows(node.offers ?? (types.includes("Offer") ? node : undefined));
      if (rows.length) {
        lines.push("| Offer | Price | Currency | Availability |", "| --- | --- | --- | --- |");
        for (const row of rows) lines.push(`| ${row.map(cellText).join(" | ")} |`);
      }
      const rating = node.aggregateRating as Node | undefined;
      if (rating && typeof rating === "object") {
        const value = str(rating.ratingValue);
        if (value) lines.push(`Rating: ${value}${str(rating.bestRating) ? ` of ${str(rating.bestRating)}` : ""} from ${str(rating.reviewCount) || str(rating.ratingCount) || "?"} reviews`);
      }
      lines.push("");
      continue;
    }
    if (types.includes("FAQPage")) {
      const entities = Array.isArray(node.mainEntity) ? node.mainEntity : [node.mainEntity];
      for (const question of entities.filter((q): q is Node => !!q && typeof q === "object").slice(0, 40)) {
        const answer = question.acceptedAnswer as Node | undefined;
        const q = str(question.name);
        const a = str(answer?.text).replace(/<[^>]{0,200}>/g, " ").replace(/\s+/g, " ").trim();
        if (q && a) lines.push(`Q: ${q}`, `A: ${a}`, "");
      }
      continue;
    }
    if (types.some((t) => /Event|Dataset|JobPosting|Course|Recipe/.test(t))) {
      const name = str(node.name);
      if (name) lines.push(`${types[0]}: ${name}`);
      for (const key of ["description", "startDate", "endDate", "location", "temporalCoverage", "license", "baseSalary", "datePosted"]) {
        const value = str(node[key]);
        if (value) lines.push(`${humanizeKey(key)}: ${value}`);
      }
      lines.push("");
    }
  }
  return {
    text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_OUTPUT_CHARS),
    ...(publishedAt ? { publishedAt } : {}),
    ...(author ? { author } : {}),
    ...(articleBody ? { articleBody } : {}),
  };
}
