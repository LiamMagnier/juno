/**
 * The Preview for env-server sessions: `open_preview`, on the Alevr MCP server
 * (Claude, Codex, ACP) and as a native tool for Alevr's own engine.
 *
 * A static site (an `index.html` the agent wrote, at the project root or in a
 * subfolder) needs no launch file and no server of the project's own: the
 * env server serves the folder on 127.0.0.1 and the tool answers with the
 * address, so the agent can look at it (computer use, curl). A project with a
 * dev server is started by the agent in the background first; the tool then
 * takes its loopback `url`.
 *
 * Either way the thread gets a `system_notice` with code `preview_opened`
 * carrying the address and the folder, and the Mac app opens its Preview tab
 * on it (serving the same folder with its own static server).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { SystemNoticeItem } from "../contracts/code-v2.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { newId, nowIso } from "../util.js";
import { text, type AlevrMcpServer, type McpScope, type McpToolResult } from "./alevr-mcp.js";

export const PREVIEW_TOOL_NAME = "open_preview";
export const PREVIEW_NOTICE_CODE = "preview_opened";

const PREVIEW_DESCRIPTION =
  "Open the user's Preview tab in Alevr on a web page this session built, and get its address. " +
  "Static site (index.html, no build step): pass path, the folder or the .html file, relative to the project; without path Alevr picks the newest index.html in the project. " +
  "Dev server (package.json dev script, Vite, Next, Django, ...): start it in the background first, then pass url, its loopback address (http://localhost:5173). " +
  "Use it after building or changing a page, and whenever the user asks to see or preview it.";

export const PREVIEW_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string", description: "The static site's folder or .html file, relative to the project folder." },
    url: { type: "string", description: "A dev server's loopback address the session started, e.g. http://localhost:5173." },
  },
  additionalProperties: false,
};

/** Folders never searched for a site: dependencies, VCS data and build caches. */
const IGNORED = new Set([
  ".git", ".hg", ".svn", ".next", ".nuxt", ".turbo", ".cache", "node_modules", "vendor", "Pods",
  "DerivedData", "coverage", ".venv", "venv", "__pycache__", "target",
]);
/** Where a site usually lives, checked before the newest-index search. */
const KNOWN_FOLDERS = [".", "public", "site", "docs"];
const MAX_DEPTH = 3;
const MAX_VISITED = 2000;

export type SiteDetection =
  | { kind: "static"; folder: string; entry: string }
  | { kind: "dev"; scripts: string[] }
  | { kind: "none"; reason: string };

const inside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Every index.html under `root` (depth ≤ 3), newest first. */
export function indexFiles(root: string): string[] {
  const found: { file: string; mtime: number }[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || visited > MAX_VISITED) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited++;
      if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase() === "index.html") {
        try {
          found.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.file);
}

/** Dev-server scripts in the root package.json (dev, start, serve, preview). */
function devScripts(root: string): string[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return Object.keys(pkg.scripts ?? {}).filter((s) => /^(dev|start|serve|preview)(:|$)/.test(s));
  } catch {
    return [];
  }
}

/**
 * The site to preview in `cwd`: the folder `hint` names (a folder with an
 * index.html, or an .html file), else index.html at the root or in a usual
 * folder, else the newest index.html anywhere below; a project with a dev
 * server script and no built page says so.
 */
export function detectSite(cwd: string, hint?: string): SiteDetection {
  const root = path.resolve(cwd);
  if (hint && hint.trim()) {
    const target = path.resolve(root, hint.trim());
    if (!inside(root, target)) return { kind: "none", reason: `${hint} is outside the project folder.` };
    if (isFile(target)) {
      if (!/\.html?$/i.test(target)) return { kind: "none", reason: `${hint} is not an HTML file.` };
      return { kind: "static", folder: path.dirname(target), entry: path.basename(target) };
    }
    if (isDir(target)) {
      if (isFile(path.join(target, "index.html"))) return { kind: "static", folder: target, entry: "index.html" };
      const below = indexFiles(target)[0];
      if (below) return { kind: "static", folder: path.dirname(below), entry: "index.html" };
      return { kind: "none", reason: `There is no index.html in ${hint}.` };
    }
    return { kind: "none", reason: `${hint} does not exist.` };
  }
  const scripts = devScripts(root);
  for (const folder of KNOWN_FOLDERS) {
    const dir = path.join(root, folder);
    if (isFile(path.join(dir, "index.html")) && !(folder === "." && scripts.length)) {
      return { kind: "static", folder: dir, entry: "index.html" };
    }
  }
  if (scripts.length) return { kind: "dev", scripts };
  const newest = indexFiles(root)[0];
  if (newest) return { kind: "static", folder: path.dirname(newest), entry: "index.html" };
  return { kind: "none", reason: "There is no index.html or dev server script in the project yet." };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".wasm": "application/wasm",
  ".map": "application/json",
};

interface Served {
  server: http.Server;
  url: string;
  owners: Set<string>;
}

/** Loopback static servers, one per folder, shared by the sessions that opened it. */
export class StaticSiteServers {
  #servers = new Map<string, Served>();

  /** Serves `folder` (once) for `owner`; resolves to its origin with a trailing slash. */
  async serve(folder: string, owner: string): Promise<string> {
    const root = fs.realpathSync(path.resolve(folder));
    const existing = this.#servers.get(root);
    if (existing) {
      existing.owners.add(owner);
      return existing.url;
    }
    const server = http.createServer((req, res) => handle(root, req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    this.#servers.set(root, { server, url, owners: new Set([owner]) });
    return url;
  }

  /** Stops the servers no other session still uses. */
  async release(owner: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [root, served] of this.#servers) {
      served.owners.delete(owner);
      if (served.owners.size === 0) {
        this.#servers.delete(root);
        closing.push(new Promise((resolve) => served.server.close(() => resolve())));
        served.server.closeAllConnections?.();
      }
    }
    await Promise.all(closing);
  }

  async closeAll(): Promise<void> {
    const all = [...this.#servers.values()];
    this.#servers.clear();
    await Promise.all(all.map((s) => new Promise<void>((resolve) => { s.server.close(() => resolve()); s.server.closeAllConnections?.(); })));
  }

  /** Folders being served (tests, diagnostics). */
  folders(): string[] {
    return [...this.#servers.keys()];
  }
}

function handle(root: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.resolve(root, `.${pathname}`);
  const candidates = [file];
  if (pathname.endsWith("/")) candidates.unshift(path.join(file, "index.html"));
  else if (!path.extname(file)) candidates.push(`${file}.html`, path.join(file, "index.html"));
  file = "";
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (inside(root, real) && fs.statSync(real).isFile()) {
        file = real;
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/** A loopback http(s) address, normalized; undefined for anything else. */
export function loopbackUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!LOOPBACK.has(url.hostname)) return undefined;
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    return url;
  } catch {
    return undefined;
  }
}

async function answers(url: URL, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await res.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export interface PreviewOpened {
  url: string;
  /** Absolute folder of a static site; absent for a dev server. */
  folder?: string;
  message: string;
  isError?: boolean;
}

export interface PreviewToolDeps {
  servers: StaticSiteServers;
  /** The session's folder. */
  cwd(sessionId: string): string | undefined;
  /** Adds the `preview_opened` notice to the thread the user watches. */
  notify(sessionId: string, opened: { url: string; folder?: string }): void;
}

/** Opens the preview for one session: serves or checks, then notifies. */
export async function openPreview(sessionId: string, args: Record<string, unknown>, deps: PreviewToolDeps): Promise<PreviewOpened> {
  const cwd = deps.cwd(sessionId);
  if (!cwd) return { url: "", message: "This session has no project folder to preview.", isError: true };
  const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
  if (rawUrl) {
    const url = loopbackUrl(rawUrl);
    if (!url) return { url: "", message: `${rawUrl} is not a loopback address. Pass the dev server's http://localhost:<port> address.`, isError: true };
    if (!(await answers(url))) {
      return { url: "", message: `Nothing answers at ${url.href} yet. Start the dev server in the background, wait until it prints its address, then call open_preview again.`, isError: true };
    }
    deps.notify(sessionId, { url: url.href });
    return { url: url.href, message: `The Preview tab shows ${url.href}.` };
  }
  const site = detectSite(cwd, typeof args.path === "string" ? args.path : undefined);
  if (site.kind === "dev") {
    return {
      url: "",
      message: `This project starts with a dev server (${site.scripts.map((s) => `npm run ${s}`).join(", ")}). Start it in the background, wait for its http://localhost address, then call open_preview with url.`,
      isError: true,
    };
  }
  if (site.kind === "none") return { url: "", message: site.reason, isError: true };
  const origin = await deps.servers.serve(site.folder, sessionId);
  const url = site.entry.toLowerCase() === "index.html" ? origin : `${origin}${encodeURIComponent(site.entry)}`;
  deps.notify(sessionId, { url, folder: site.folder });
  const rel = path.relative(cwd, site.folder) || ".";
  return {
    url,
    folder: site.folder,
    message: `The Preview tab shows ${rel === "." ? "the project" : `${rel}/`} at ${url}. Alevr serves the folder itself; edits show on reload.`,
  };
}

/** The parent thread a scope's notices belong to (a child's go to its lead's thread). */
function threadOf(sessions: SessionManager, sessionId: string): string {
  try {
    return sessions.log(sessionId).meta.parentSessionId ?? sessionId;
  } catch {
    return sessionId;
  }
}

/** The tool's deps over a SessionManager. */
export function sessionPreviewDeps(sessions: SessionManager, servers: StaticSiteServers): PreviewToolDeps {
  return {
    servers,
    cwd: (id) => (sessions.has(id) ? sessions.log(id).meta.cwd : undefined),
    notify(id, opened) {
      const thread = threadOf(sessions, id);
      if (!sessions.has(thread)) return;
      const turnId = sessions.activeTurnId(thread);
      const item: SystemNoticeItem = {
        id: newId("pv"),
        kind: "system_notice",
        createdAt: nowIso(),
        ...(turnId ? { turnId } : {}),
        level: "info",
        text: `Opened the preview at ${opened.url}`,
        code: PREVIEW_NOTICE_CODE,
        url: opened.url,
        ...(opened.folder ? { path: opened.folder } : {}),
      };
      try {
        sessions.upsertItem(thread, item);
      } catch {
        /* the session closed */
      }
    },
  };
}

const toResult = (opened: PreviewOpened): McpToolResult => text(opened.message, opened.isError === true);

/** Registers open_preview on the Alevr MCP server. Returns the unregister function. */
export function registerPreviewTools(mcp: AlevrMcpServer, deps: PreviewToolDeps): () => void {
  return mcp.registerTool({
    name: PREVIEW_TOOL_NAME,
    title: "Open the preview",
    description: PREVIEW_DESCRIPTION,
    inputSchema: PREVIEW_INPUT_SCHEMA,
    annotations: { title: "Open the preview", readOnlyHint: true, openWorldHint: false },
    availableTo: (scope: McpScope) => deps.cwd(scope.sessionId) !== undefined,
    handler: async (args, scope) => toResult(await openPreview(scope.sessionId, args, deps)),
  });
}

/** The same tool for Alevr's own engine (agent-core ToolDefinition shape). */
export function previewEngineTools(sessionId: string, deps: PreviewToolDeps): unknown[] {
  return [
    {
      spec: { name: PREVIEW_TOOL_NAME, description: PREVIEW_DESCRIPTION, inputSchema: PREVIEW_INPUT_SCHEMA },
      kind: "read",
      summarize: (input: Record<string, unknown>) => `Open the preview${typeof input.path === "string" && input.path ? ` of ${input.path}` : ""}`,
      async execute(input: Record<string, unknown>) {
        const opened = await openPreview(sessionId, input, deps);
        return { output: opened.message, isError: opened.isError === true };
      },
    },
  ];
}
