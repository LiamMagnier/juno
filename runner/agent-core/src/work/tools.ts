/**
 * The tools a Juno Work run can actually reach, in the shape the session
 * demands of them.
 *
 * `WorkToolDefinition` asks six questions of every tool — which rung of the
 * hierarchy it sits on, which intent this call serves, what the action is
 * called, how risky it is, where its output came from, and whether it is
 * working — and `WorkAgentSession.executeToolCall` acts on every answer. The
 * provenance answer is the load-bearing one: a tool that declares
 * `trust: 'untrusted'` has its output scanned and enveloped before the model
 * sees it, and a tool that declares `trusted` does not. Getting that wrong on
 * one tool is not a smaller version of getting it wrong on all of them; it is
 * a hole in exactly one channel, which is the kind nobody notices.
 *
 * WHY THE EFFECTS ARE INJECTED
 *
 * Everything here is either pure or takes its side effects as arguments. That
 * is not a testing convenience, it is the only thing that makes these tools
 * expressible at all: this package is vendored, built standalone with the rest
 * of the repository absent from the image, and cannot import `@/lib/storage`,
 * `@/lib/work/deliverables` or a Prisma client. So the runtime owns the
 * *shape* of a tool — the part the security machinery reads — and the cloud
 * executor in scripts/work-runner.ts supplies the *effect*. A shape defined
 * next to its effect in the executor would put the tier, the risk and the
 * provenance of every tool outside the package whose session enforces them.
 *
 * WHAT IS NOT HERE
 *
 * No browser, accessibility or screen-control tool. Those are the Mac's rungs
 * and a cloud run has none of them, which is why every tier refusal a cloud
 * run can produce today is a refusal against `shell`. The rungs are still
 * declared truthfully rather than flattened, because the moment a local host
 * joins a run the lattice has to already be right — a tier assigned when the
 * competitor appears is a tier assigned after the mistake.
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../tools/types.js';
import { bashTool } from '../tools/bash.js';
import { editFileTool, globTool, grepTool, readFileTool, writeFileTool } from '../tools/fs.js';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from './injection.js';
import type {
  WorkArtifactRef,
  WorkCitation,
  WorkProvenance,
  WorkRiskLevel,
  WorkToolDefinition,
  WorkToolTierId,
} from './types.js';

// ---------------------------------------------------------------------------
// Lifting a Code-shell tool into a Work one
// ---------------------------------------------------------------------------

/** Everything a Work run has to know that `ToolDefinition` does not carry. */
export interface WorkToolShape {
  tier: WorkToolTierId;
  intents: readonly string[];
  intentFor(input: Record<string, unknown>): string;
  actionFor(input: Record<string, unknown>): string;
  riskFor(input: Record<string, unknown>): WorkRiskLevel;
  provenanceFor(input: Record<string, unknown>): WorkProvenance;
  isHealthy?(): boolean;
}

/**
 * Wraps an existing `ToolDefinition` without reimplementing it.
 *
 * The fs and bash tools are the ones the Code shell has been running against
 * real repositories for months, including the process-group kill that stops a
 * timed-out command leaving children behind. Rewriting them Work-shaped would
 * mean two implementations of `bash` whose containment behaviour drifts, and
 * the half that drifts is always the one nobody is looking at.
 */
export function asWorkTool(base: ToolDefinition, shape: WorkToolShape): WorkToolDefinition {
  return {
    ...base,
    tier: shape.tier,
    intents: shape.intents,
    intentFor: shape.intentFor,
    actionFor: shape.actionFor,
    riskFor: shape.riskFor,
    provenanceFor: shape.provenanceFor,
    ...(shape.isHealthy ? { isHealthy: shape.isHealthy } : {}),
  };
}

/**
 * A path as it may appear in an event.
 *
 * `WorkProvenance.source` reaches a phone, and the comment on that field says
 * in as many words that it is never an absolute local path. The cloud
 * executor's cwd is a scratch directory whose name means nothing to a reader
 * and everything to anyone mapping the fleet, so an absolute path is reduced
 * to its last segment rather than passed through.
 */
export function displayPath(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) return 'a file';
  if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) return value;
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? value;
}

/**
 * The run's own scratch workspace, as tools.
 *
 * Reads are untrusted and writes are not, and the asymmetry is the whole
 * design. The output of `write_file` is a sentence this process composed
 * ("Wrote 412 chars to …"), so enveloping it would teach the model to
 * distrust its own bookkeeping. The output of `read_file` is whatever is in
 * the file, which in a Work run is routinely something the run downloaded a
 * step earlier — so it is scanned and enveloped even though the run wrote it,
 * because "the run wrote it" and "the run composed it" are not the same claim.
 */
export function workspaceTools(): WorkToolDefinition[] {
  const fileProvenance = (input: Record<string, unknown>, trust: WorkProvenance['trust']): WorkProvenance => ({
    source: displayPath(input.path ?? input.pattern),
    sourceKind: 'file',
    action: trust === 'untrusted' ? 'work.file.read' : 'work.file.write',
    trust,
  });

  return [
    asWorkTool(readFileTool, {
      tier: 'structured_file',
      intents: ['workspace.read'],
      intentFor: () => 'workspace.read',
      actionFor: () => 'work.file.read',
      riskFor: () => 'safe',
      provenanceFor: (input) => fileProvenance(input, 'untrusted'),
    }),
    asWorkTool(globTool, {
      tier: 'structured_file',
      intents: ['workspace.find'],
      intentFor: () => 'workspace.find',
      actionFor: () => 'work.file.list',
      riskFor: () => 'safe',
      // A list of file names the run itself created is bookkeeping, not
      // content: there is nothing in it a third party wrote.
      provenanceFor: () => ({
        source: 'the run workspace',
        sourceKind: 'file',
        action: 'work.file.list',
        trust: 'trusted',
      }),
    }),
    asWorkTool(grepTool, {
      tier: 'structured_file',
      intents: ['workspace.search'],
      intentFor: () => 'workspace.search',
      actionFor: () => 'work.file.read',
      riskFor: () => 'safe',
      // Matching lines are file contents with the surrounding lines removed,
      // which makes them file contents.
      provenanceFor: (input) => fileProvenance(input, 'untrusted'),
    }),
    asWorkTool(writeFileTool, {
      tier: 'structured_file',
      intents: ['workspace.write'],
      intentFor: () => 'workspace.write',
      actionFor: () => 'work.file.write',
      riskFor: () => 'edit',
      provenanceFor: (input) => fileProvenance(input, 'trusted'),
    }),
    asWorkTool(editFileTool, {
      tier: 'structured_file',
      intents: ['workspace.write'],
      intentFor: () => 'workspace.write',
      actionFor: () => 'work.file.write',
      riskFor: () => 'edit',
      provenanceFor: (input) => fileProvenance(input, 'trusted'),
    }),
    asWorkTool(bashTool, {
      tier: 'shell',
      // Deliberately its own intent rather than `workspace.read` and
      // `workspace.write` together. Declaring those would make every bash call
      // a tier-6 tool competing with a tier-2 one, and `evaluateTier` would
      // refuse the lot — including `npm test`, which no file tool can do. The
      // input is one opaque command string and nothing can tell from it which
      // of the two a given call is, so the honest declaration is neither.
      intents: ['shell.run'],
      intentFor: () => 'shell.run',
      actionFor: () => 'work.shell.run',
      riskFor: () => 'command',
      provenanceFor: () => ({
        source: 'a shell command',
        sourceKind: 'local_app',
        action: 'work.shell.run',
        // Command output is whatever the command printed, which includes
        // whatever it downloaded. There is no version of this that is trusted.
        trust: 'untrusted',
      }),
    }),
  ];
}

/**
 * Removes the tools that operate on the executor's local checkout.
 *
 * Cloud Work is not allowed to inherit the worker's cwd: on the production
 * VM that cwd is the Juno application checkout, which contains deployment
 * files and secrets alongside the source tree. Keep this as a derived filter
 * over `workspaceTools()` rather than a second hand-maintained name list, so a
 * new local file or shell tool cannot silently become cloud-reachable.
 */
export function withoutHostWorkspaceTools(
  tools: readonly WorkToolDefinition[],
): WorkToolDefinition[] {
  const hostWorkspaceNames = new Set(workspaceTools().map((tool) => tool.spec.name));
  return tools.filter((tool) => !hostWorkspaceNames.has(tool.spec.name));
}

// ---------------------------------------------------------------------------
// The web
// ---------------------------------------------------------------------------

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchDeps {
  /** Runs the query. Returning an empty list is a real answer, not a failure. */
  search(query: string, maxResults: number): Promise<WebSearchHit[]>;
  /** False when no search provider is configured. Consulted per call. */
  configured(): boolean;
  /** Where a cited source is recorded. Absent means nothing is cited. */
  onCitation?(citation: WorkCitation): void;
}

export interface WebFetchDeps {
  /** Returns the page, or an explanation. Never throws for a 404. */
  fetchPage(url: string): Promise<{ ok: true; contentType: string; body: string } | { ok: false; message: string }>;
  onCitation?(citation: WorkCitation): void;
  now?(): Date;
}

const MAX_SEARCH_RESULTS = 8;
const MAX_FETCH_CHARS = 40_000;

/**
 * Hosts a Work run must not fetch, whatever the model asks for.
 *
 * The cloud executor sits inside a private network with a link-local metadata
 * endpoint on it, so "fetch this URL the research turned up" is one hop from
 * "read the instance's credentials and put them in the transcript". Blocking
 * the literals is cheap and it closes the case that actually happens: a page
 * that says, inside the untrusted envelope, to fetch 169.254.169.254.
 *
 * The caller must apply it to every redirect hop as well as to the URL it was
 * given, and the executor does. Checking only the first is the same as not
 * checking: a page under an attacker's control answers 302 to the metadata
 * endpoint and the platform's own redirect handling never asks again.
 *
 * It is emphatically not a containment boundary. A hostname that resolves to a
 * private address passes this and is refused by nothing, because the process
 * that would refuse it — the egress proxy `tools/egress-policy.ts` is written
 * for — has not been built. That gap is stated in docs/native/WORK.md and this
 * function is not the place it gets closed; a check that claimed to be one
 * would stop anybody closing it.
 */
export function blockedFetchTarget(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'that is not a URL Juno can parse.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `${url.protocol} is not a protocol Juno will fetch; use http or https.`;
  }
  if (url.username || url.password) {
    return 'the URL carries credentials, which Juno will not send.';
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return 'that address is on the machine Juno is running on, not on the web.';
  }
  // IPv4 literals in the ranges RFC 1918 and RFC 3927 reserve, plus the
  // loopback block. 169.254.169.254 is the one that matters and it is the one
  // a page will name.
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host)) {
    return 'that address is inside Juno\'s own network, not on the web.';
  }
  // IPv6 unique-local and link-local.
  if (/^(fc|fd|fe8|fe9|fea|feb)/.test(host) && host.includes(':')) {
    return 'that address is inside Juno\'s own network, not on the web.';
  }
  return null;
}

/**
 * HTML reduced to the text a reader would see.
 *
 * Script and style bodies go first and as whole elements, because stripping
 * tags alone leaves their contents behind as prose — a page's JavaScript then
 * arrives in the model's context looking like the article.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    // Opening tags become spaces and closing block tags become newlines, so
    // every line of a stripped document starts with the space its own opening
    // tag left behind. Harmless to read and noise in a citation quote.
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The page title, when the document declares one. Used for the citation. */
export function htmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = htmlToText(match[1]);
  return title.length > 0 ? title : null;
}

export function webSearchTool(deps: WebSearchDeps): WorkToolDefinition {
  return {
    kind: 'read',
    tier: 'browser_dom',
    intents: ['web.search'],
    intentFor: () => 'web.search',
    actionFor: () => 'work.web.search',
    riskFor: () => 'safe',
    provenanceFor: () => ({
      source: 'a web search',
      sourceKind: 'web',
      action: 'work.web.search',
      // Result titles and snippets are attacker-authored the moment anyone
      // can rank for a query, and ranking for a query the run will make is
      // not a hard attack.
      trust: 'untrusted',
    }),
    isHealthy: () => deps.configured(),
    spec: {
      name: 'web_search',
      description:
        'Search the public web and get back titles, URLs and snippets. Use it to find sources; use web_fetch to read one. Snippets are short and often stale — do not state a fact from a snippet alone if the task turns on it.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for, in words.' },
          max_results: {
            type: 'number',
            description: `How many results to return (default 5, max ${MAX_SEARCH_RESULTS}).`,
          },
        },
        required: ['query'],
      },
    },
    summarize: (input) => `Search the web for "${String(input.query ?? '').slice(0, 120)}"`,
    async execute(input): Promise<ToolResult> {
      const query = String(input.query ?? '').trim();
      if (!query) return { output: 'A query is required.', isError: true };
      if (!deps.configured()) {
        return {
          output:
            'Web search is not configured on this Juno deployment, so nothing was searched. Say so in your answer rather than working from memory.',
          isError: true,
        };
      }
      const requested = Number(input.max_results ?? 5);
      const limit = Math.min(Math.max(Number.isFinite(requested) ? Math.floor(requested) : 5, 1), MAX_SEARCH_RESULTS);

      const hits = await deps.search(query, limit);
      if (hits.length === 0) return { output: `No results for "${query}".` };

      return {
        output: hits
          .map((hit, index) => `[${index + 1}] ${hit.title}\n${hit.url}\n${hit.snippet}`)
          .join('\n\n'),
      };
    },
  };
}

export function webFetchTool(deps: WebFetchDeps): WorkToolDefinition {
  const now = deps.now ?? (() => new Date());
  return {
    kind: 'read',
    tier: 'browser_dom',
    intents: ['web.fetch'],
    intentFor: () => 'web.fetch',
    actionFor: () => 'work.web.fetch',
    riskFor: () => 'safe',
    provenanceFor: (input) => ({
      // The URL as asked for, so the event and the citation name the same
      // thing the user can go and check.
      source: String(input.url ?? 'a web page'),
      sourceKind: 'web',
      action: 'work.web.fetch',
      trust: 'untrusted',
    }),
    spec: {
      name: 'web_fetch',
      description:
        'Fetch one web page and read it as text. Returns up to 40,000 characters of the page body. Cite the URL for anything you take from it.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'An http or https URL.' },
        },
        required: ['url'],
      },
    },
    summarize: (input) => `Read ${String(input.url ?? '').slice(0, 200)}`,
    async execute(input): Promise<ToolResult> {
      const url = String(input.url ?? '').trim();
      if (!url) return { output: 'A URL is required.', isError: true };

      const blocked = blockedFetchTarget(url);
      if (blocked) return { output: `Juno will not fetch that: ${blocked}`, isError: true };

      const page = await deps.fetchPage(url);
      if (!page.ok) return { output: page.message, isError: true };

      const isHtml = page.contentType.includes('html');
      const text = isHtml ? htmlToText(page.body) : page.body;
      const title = (isHtml ? htmlTitle(page.body) : null) ?? url;

      deps.onCitation?.({ title, source: url, retrievedAt: now().toISOString() });

      if (text.length > MAX_FETCH_CHARS) {
        return {
          output:
            `${text.slice(0, MAX_FETCH_CHARS)}\n\n[Cut off here. This page is ${text.length} characters long and only the first ` +
            `${MAX_FETCH_CHARS} are above. Do not describe the rest as though you have read it.]`,
        };
      }
      return { output: text.length > 0 ? text : 'The page was fetched but had no readable text in it.' };
    },
  };
}

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

export type DeliverableOutcome =
  | { ok: true; artifact: WorkArtifactRef; detail: string }
  | { ok: false; message: string };

export interface DeliverableToolDeps {
  /**
   * Generates, stores and versions one deliverable, and returns the reference
   * the run should record. Everything this needs — the spec union, the
   * generators, object storage, the artifact tables — lives in the app.
   */
  create(request: {
    identifier: string;
    spec: Record<string, unknown>;
  }): Promise<DeliverableOutcome>;
}

/**
 * A description of the five specs, in the tool's own description.
 *
 * Written out rather than expressed as a JSON schema because the real schema
 * is a five-way discriminated union whose document branch alone has seven
 * block types, and a JSON schema of that size costs more context on every
 * single turn than it saves on the one turn a deliverable is produced. The
 * spec is validated by the same zod union the HTTP route uses, and a rejection
 * comes back as the message zod wrote, so a wrong shape costs one retry with a
 * sentence saying exactly which field was wrong.
 */
const DELIVERABLE_SPEC_GUIDE = [
  'The spec is one of five shapes, chosen by `kind`:',
  '',
  '- document (.docx) — { kind, title, subtitle?, blocks[] }',
  '- report (.md) — { kind, title, subtitle?, summary?, blocks[] }',
  '- spreadsheet (.xlsx) — { kind, title, sheets: [{ name, columns: [{ header, format?, width? }], rows: [[cell,…]], freezeHeader? }] }',
  '  cell is a string, number, boolean, null or { date: "<ISO 8601>" }; format is text|number|integer|currency|percent|date.',
  '- presentation (.pptx) — { kind, title, slides[] }, each slide one of:',
  '  { layout: "title", title, subtitle?, notes? } | { layout: "section", title, notes? } |',
  '  { layout: "bullets", title, bullets: [{ text, level? }], notes? } |',
  '  { layout: "body", title, paragraphs: [string], notes? } |',
  '  { layout: "table", title, header: [string], rows: [[string]], notes? }',
  '- site (.zip) — { kind, title, description?, theme?, pages: [{ path, title, summary?, blocks[] }] }; one page must be index.html.',
  '',
  'A block (document, report and site pages) is one of:',
  '  { type: "heading", level: 1-6, text } | { type: "paragraph", text } |',
  '  { type: "list", ordered: bool, items: [text] } | { type: "quote", text } |',
  '  { type: "code", language?, lines: [string] } |',
  '  { type: "table", caption?, header: [text], rows: [[text]] }',
  'where `text` is a plain string, or an array of { text, bold?, italic?, code? } when something is styled.',
  'Every table row must have exactly as many cells as the header: rows are not padded.',
].join('\n');

export function deliverableTool(deps: DeliverableToolDeps): WorkToolDefinition {
  return {
    kind: 'edit',
    tier: 'structured_file',
    intents: ['deliverable.create'],
    intentFor: () => 'deliverable.create',
    actionFor: () => 'work.deliverable.create',
    // `edit` rather than `safe`: this produces a file the user will send to
    // somebody. It is not `sensitive`, because nothing is sent by making one
    // and a run that had to ask before writing each draft would ask five times.
    riskFor: () => 'edit',
    provenanceFor: () => ({
      source: 'this run',
      sourceKind: 'model',
      action: 'work.deliverable.create',
      // The only text coming back is the artifact's own identity and the
      // validator's verdict, both composed here.
      trust: 'trusted',
    }),
    spec: {
      name: 'create_deliverable',
      description:
        'Produce a real file — a Word document, an Excel workbook, a PowerPoint deck, a markdown report or a static site — from a typed spec, and attach it to this task as an artifact. ' +
        'Call it again with the same identifier to publish a new version; version history is kept. ' +
        'The file is re-opened by a validator after it is written, and you are told if it did not open.\n\n' +
        DELIVERABLE_SPEC_GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          identifier: {
            type: 'string',
            description:
              'A short stable slug naming this deliverable within the task, e.g. "q3-summary". Letters, digits, dot, dash and underscore. Reuse it to publish a new version.',
          },
          spec: {
            type: 'object',
            description: 'The deliverable spec. See the tool description for the five shapes.',
          },
        },
        required: ['identifier', 'spec'],
      },
    },
    summarize: (input) => {
      const spec = input.spec as { kind?: unknown; title?: unknown } | undefined;
      const kind = typeof spec?.kind === 'string' ? spec.kind : 'deliverable';
      const title = typeof spec?.title === 'string' ? spec.title : String(input.identifier ?? '');
      return `Produce the ${kind} "${title.slice(0, 120)}"`;
    },
    async execute(input): Promise<ToolResult> {
      const identifier = String(input.identifier ?? '').trim();
      if (!identifier) return { output: 'An identifier is required.', isError: true };
      const spec = input.spec;
      if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
        return { output: 'The spec must be an object.', isError: true };
      }

      const outcome = await deps.create({ identifier, spec: spec as Record<string, unknown> });
      return outcome.ok ? { output: outcome.detail } : { output: outcome.message, isError: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Cloud files
// ---------------------------------------------------------------------------

export type CloudFileOperation = 'list' | 'read' | 'write';

export interface CloudFileToolDeps {
  list(): Promise<Array<{ name: string; byteSize: number; updatedAt: string }>>;
  read(name: string): Promise<{ ok: true; text: string } | { ok: false; message: string }>;
  write(name: string, text: string): Promise<{ ok: true; detail: string } | { ok: false; message: string }>;
}

/** The operation a call is making, defaulting to the harmless one. */
function cloudOperation(input: Record<string, unknown>): CloudFileOperation {
  const raw = String(input.operation ?? 'list');
  return raw === 'read' || raw === 'write' ? raw : 'list';
}

export function cloudFilesTool(deps: CloudFileToolDeps): WorkToolDefinition {
  return {
    kind: 'edit',
    tier: 'structured_file',
    intents: ['cloud_file.list', 'cloud_file.read', 'cloud_file.write'],
    intentFor: (input) => `cloud_file.${cloudOperation(input)}`,
    actionFor: (input) => `work.cloud_file.${cloudOperation(input)}`,
    riskFor: (input) => (cloudOperation(input) === 'write' ? 'edit' : 'safe'),
    provenanceFor: (input) => {
      const operation = cloudOperation(input);
      return {
        source: operation === 'list' ? "this task's cloud files" : String(input.name ?? 'a cloud file'),
        sourceKind: 'file',
        action: `work.cloud_file.${operation}`,
        // A read returns bytes somebody else put in the bucket — an upload, or
        // a file an earlier run wrote from a web page. A list and a write
        // return this process's own bookkeeping.
        trust: operation === 'read' ? 'untrusted' : 'trusted',
      };
    },
    spec: {
      name: 'cloud_files',
      description:
        "Read and write text files kept with this task in Juno's cloud storage. They persist between runs of the same task and are not on anybody's computer. Use it to park intermediate work — extracted tables, notes, a draft — that would otherwise have to be carried in the conversation.",
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['list', 'read', 'write'],
            description: 'What to do. Defaults to list.',
          },
          name: {
            type: 'string',
            description:
              'The file name, for read and write. Letters, digits, dot, dash and underscore; no directories.',
          },
          content: { type: 'string', description: 'The text to write, for write.' },
        },
        required: ['operation'],
      },
    },
    summarize: (input) => {
      const operation = cloudOperation(input);
      if (operation === 'list') return 'List the cloud files kept with this task';
      return `${operation === 'read' ? 'Read' : 'Write'} the cloud file ${String(input.name ?? '')}`;
    },
    async execute(input): Promise<ToolResult> {
      const operation = cloudOperation(input);

      if (operation === 'list') {
        const files = await deps.list();
        if (files.length === 0) return { output: 'No files are kept with this task yet.' };
        return {
          output: files
            .map((file) => `${file.name}\t${file.byteSize} bytes\tlast written ${file.updatedAt}`)
            .join('\n'),
        };
      }

      const name = String(input.name ?? '').trim();
      if (!name) return { output: 'A name is required.', isError: true };

      if (operation === 'read') {
        const result = await deps.read(name);
        return result.ok ? { output: result.text } : { output: result.message, isError: true };
      }

      if (typeof input.content !== 'string') {
        return { output: 'Content is required when writing.', isError: true };
      }
      const result = await deps.write(name, input.content);
      return result.ok ? { output: result.detail } : { output: result.message, isError: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/**
 * Takes one untrusted envelope off a string that already has one.
 *
 * The counterpart to `wrapUntrusted`, and it exists because three layers want
 * to wrap a connector result and only one may. Juno's MCP chokepoint wraps
 * every result it returns; the admission gate wraps unless the content is
 * already wrapped; and `WorkAgentSession` wraps everything whose provenance
 * says `untrusted`, which a connector result always does. Two of those firing
 * produces a nested envelope whose inner markers the outer wrap then defangs —
 * so the delimiters the system-prompt rule names no longer appear where the
 * rule says they will, which is the one property the whole mechanism rests on.
 *
 * The defanging applied on the way in is not undone and cannot be: a result
 * that genuinely contained the sentinel keeps the zero-width space. That is a
 * cosmetic loss in text nobody in the conversation wrote, and the alternative
 * is restoring the marker that hostile text would use to close its own block.
 */
export function stripUntrustedEnvelope(text: string): string {
  if (!text.startsWith(UNTRUSTED_OPEN)) return text;
  const bodyStart = text.indexOf('\n');
  const bodyEnd = text.lastIndexOf(UNTRUSTED_CLOSE);
  if (bodyStart === -1 || bodyEnd <= bodyStart) return text;
  return text.slice(bodyStart + 1, bodyEnd).replace(/\n$/, '');
}

/** Read, write, or neither the server nor the tool name says. */
export type ConnectorAccess = 'read' | 'write' | 'unknown';

/**
 * The action identifier a connector call is approved and audited under.
 *
 * The four names in the middle are members of `ALWAYS_CONFIRM_ACTIONS`, which
 * is what makes this function matter: it is the only place a connector tool's
 * name is turned into one of them, so a tool called `gmail_send_message`
 * acquires a confirmation the user cannot be talked out of by a page telling
 * the model it is fine.
 *
 * An `unknown` access is treated as a write throughout, for the reason
 * `planConnectorFirst` gives: an unannotated server whose tool name carries no
 * verb classifies as unknown, and `notion_pages` is a real tool that really
 * updates pages.
 */
export function connectorActionFor(toolName: string, access: ConnectorAccess): string {
  if (access === 'read') return 'work.connector.read';
  const name = toolName.toLowerCase();
  if (/(^|[._-])(send|reply|email|message|dm|notify)/.test(name)) return 'work.connector.send_message';
  if (/(^|[._-])(publish|post|share|tweet|comment)/.test(name)) return 'work.connector.publish';
  if (/(^|[._-])(delete|remove|destroy|trash|archive|purge)/.test(name)) return 'work.connector.delete';
  if (/(^|[._-])(pay|charge|invoice|refund|purchase|order)/.test(name)) return 'work.connector.payment';
  return 'work.connector.write';
}

/** One connector tool, as the executor resolved it from the MCP server. */
export interface ConnectorToolDescriptor {
  connectorId: string;
  /** The connector's display label. Shown to the user, never an id. */
  label: string;
  /** The bare tool name as the connector knows it. */
  toolName: string;
  /** The namespaced name the model calls, e.g. `github__list_issues`. */
  functionName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  access: ConnectorAccess;
}

export interface ConnectorToolDeps {
  /**
   * Makes the call. The executor is responsible for redeeming a broker handle
   * for the credential, putting the result through `admitConnectorResult`, and
   * writing the audit and IO rows that come back with it.
   *
   * What comes back here is the connector's answer WITHOUT the untrusted
   * envelope. The session envelopes and scans every result whose provenance
   * says `untrusted`, and `admitConnectorResult` envelopes too — so returning
   * an already-enveloped string produces a nested envelope whose inner markers
   * the outer wrap then defangs, which is precisely the state
   * src/lib/work/connectors.ts warns about on its own `envelope()`. One
   * envelope, applied by the session, is the whole of the arrangement.
   */
  call(
    descriptor: ConnectorToolDescriptor,
    args: Record<string, unknown>
  ): Promise<{ output: string; isError: boolean }>;
  /** False once the connector's handle is revoked or its credential fails. */
  healthy(connectorId: string): boolean;
}

/**
 * A connector's tool, on rung one.
 *
 * The intent is namespaced per connector and per tool rather than mapped onto
 * a shared vocabulary like `email.archive`. That mapping is the thing that
 * would make the lattice bite for connectors — a browser refused because Gmail
 * can archive a thread — and it needs a taxonomy that says which MCP tool
 * serves which intent. Nothing in this codebase has one, and inventing one
 * here would mean every connector Juno ever adds needs an entry in a table in
 * the runner or it silently stops being preferred. Declared honestly instead:
 * this tool serves this intent, nothing else claims it, and the refusal that
 * matters today is `shell` and `browser_dom` losing to nothing at all.
 */
export function connectorTool(
  descriptor: ConnectorToolDescriptor,
  deps: ConnectorToolDeps
): WorkToolDefinition {
  const intent = `connector.${descriptor.connectorId}.${descriptor.toolName}`;
  const action = connectorActionFor(descriptor.toolName, descriptor.access);
  return {
    kind: descriptor.access === 'read' ? 'read' : 'edit',
    tier: 'connector',
    intents: [intent],
    intentFor: () => intent,
    actionFor: () => action,
    // A read is safe and everything else is sensitive. `requiresExplicitApproval`
    // turns `sensitive` into a prompt the user has to answer, and turns off the
    // standing grant for it — which is right for a call that changes something
    // in an account Juno does not own.
    riskFor: () => (descriptor.access === 'read' ? 'safe' : 'sensitive'),
    provenanceFor: () => ({
      source: descriptor.connectorId,
      sourceKind: 'connector',
      action,
      // An inbox, an issue body, a calendar invite: the canonical case of text
      // an attacker can put in front of the model without touching Juno.
      trust: 'untrusted',
    }),
    isHealthy: () => deps.healthy(descriptor.connectorId),
    spec: {
      name: descriptor.functionName,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
    },
    summarize: () => `${descriptor.label}: ${descriptor.toolName}`,
    async execute(input): Promise<ToolResult> {
      const result = await deps.call(descriptor, input);
      return { output: result.output, isError: result.isError };
    },
  };
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/**
 * The tools a skill may use, as the intersection of what it asked for and what
 * the run already had.
 *
 * Filtering the run's tools by the resolved list, rather than building a list
 * from the skill's request, is the direction that cannot go wrong: a name in
 * the request that matches nothing here produces no tool, where a lookup keyed
 * on the request would need somewhere to get the tool from and that somewhere
 * would be a second toolset the grant layers never saw.
 *
 * An empty `permitted` list returns nothing, which is `resolveSkillPermissions`'
 * own reading of an empty request and is why the caller must decide whether a
 * skill is in force before calling this — a run with no skill has no request to
 * intersect against and keeps its full toolset.
 */
export function narrowToPermittedTools(
  tools: readonly WorkToolDefinition[],
  permitted: readonly string[]
): WorkToolDefinition[] {
  const allowed = new Set(permitted);
  return tools.filter((tool) => allowed.has(tool.spec.name));
}

/** Every tool name a run is carrying. The grant layer a skill is measured against. */
export function toolNames(tools: readonly WorkToolDefinition[]): string[] {
  return tools.map((tool) => tool.spec.name);
}

/**
 * Re-exported so a caller assembling a toolset needs one import path rather
 * than three. `WorkToolDefinition` is the type every function here returns, and
 * having to reach into ./types.js for it is the kind of friction that ends in
 * somebody declaring their own structurally-similar interface.
 */
export type { ToolContext, ToolResult, WorkToolDefinition };
