/**
 * Type errors after each edit: the agent learns what its change broke in the
 * file it just wrote, without spending a turn on a full `tsc`.
 *
 * Claude Code gets this from its language-server plugins, Cursor from the
 * editor. Here a TypeScript language service runs in a worker thread, one
 * service per tsconfig, kept warm for the session, so the second and later
 * checks of a project take milliseconds. The main loop never blocks on it:
 * a check that is not back within its budget (a large project's first load)
 * is skipped for that call, and the warm service answers the next one.
 *
 * It uses the repository's own `typescript` when it has one, so the errors
 * match the project's `tsc`; otherwise the engine's. Only errors are reported,
 * at most `MAX_PER_FILE` per file, and a file whose errors are the same as
 * the last report says so in one line instead of repeating them.
 *
 * Off with `ALEVR_DIAGNOSTICS=0` or the session option `diagnostics: false`.
 * It reads files only; it never writes, runs project code or follows a path
 * out of the workspace (the edit tools have contained the paths already).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

export const DIAGNOSTIC_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
export const MAX_PER_FILE = 10;
/** How long one after-edit check may take before it is skipped for that call. */
export const DEFAULT_BUDGET_MS = 8_000;

export interface FileDiagnostic {
  line: number;
  column: number;
  code: number;
  message: string;
}

interface WorkerReply {
  id: number;
  results?: Array<{ file: string; diagnostics: FileDiagnostic[]; skipped?: string }>;
  error?: string;
}

/** Nearest tsconfig.json from `file` up to `root`; null when there is none. */
export function nearestTsconfig(file: string, root: string): string | null {
  let dir = path.dirname(path.resolve(file));
  const top = path.resolve(root);
  for (;;) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === top) return null;
    const parent = path.dirname(dir);
    if (parent === dir || path.relative(top, parent).startsWith('..')) return null;
    dir = parent;
  }
}

/** The `typescript` module path to load: the project's, else the engine's. Null when neither resolves. */
export function resolveTypeScript(root: string): string | null {
  for (const base of [path.join(root, 'package.json'), import.meta.url]) {
    try {
      return createRequire(base).resolve('typescript');
    } catch {
      // try the next
    }
  }
  return null;
}

/**
 * The worker, as source, so it survives being bundled into one file (the
 * Mac's env-server bundle has no separate worker file to point at).
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const ts = require(workerData.typescript);
const services = new Map();

function serviceFor(configPath) {
  let entry = services.get(configPath);
  if (entry) return entry;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config || {}, ts.sys, path.dirname(configPath));
  const options = { ...parsed.options, noEmit: true };
  const names = new Set(parsed.fileNames);
  const version = (file) => {
    try { const st = fs.statSync(file); return st.mtimeMs + ':' + st.size; } catch { return '0'; }
  };
  const host = {
    getScriptFileNames: () => [...names],
    getScriptVersion: (file) => version(file),
    getScriptSnapshot: (file) => {
      if (!fs.existsSync(file)) return undefined;
      return ts.ScriptSnapshot.fromString(fs.readFileSync(file, 'utf8'));
    },
    getCurrentDirectory: () => path.dirname(configPath),
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  entry = { service: ts.createLanguageService(host, ts.createDocumentRegistry()), names };
  services.set(configPath, entry);
  return entry;
}

parentPort.on('message', (msg) => {
  try {
    const results = [];
    for (const item of msg.files) {
      const entry = serviceFor(item.tsconfig);
      if (!entry.names.has(item.file)) {
        // A new file the config's include globs cover is added; one outside them is not this project's.
        const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(item.tsconfig, ts.sys.readFile).config || {}, ts.sys, path.dirname(item.tsconfig));
        for (const name of parsed.fileNames) entry.names.add(name);
        if (!entry.names.has(item.file)) { results.push({ file: item.file, diagnostics: [], skipped: 'not in tsconfig' }); continue; }
      }
      const all = [...entry.service.getSyntacticDiagnostics(item.file), ...entry.service.getSemanticDiagnostics(item.file)];
      const diagnostics = [];
      for (const d of all) {
        if (d.category !== ts.DiagnosticCategory.Error) continue;
        const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
        diagnostics.push({ line: pos.line + 1, column: pos.character + 1, code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 400) });
      }
      results.push({ file: item.file, diagnostics });
    }
    parentPort.postMessage({ id: msg.id, results });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: String(err && err.message || err) });
  }
});
`;

export interface DiagnosticsOptions {
  budgetMs?: number;
  /** Tests: the typescript module path, instead of resolving one. */
  typescriptPath?: string;
}

export class EditDiagnostics {
  private worker: Worker | null = null;
  private broken = false;
  private nextId = 1;
  private readonly pending = new Map<number, (reply: WorkerReply) => void>();
  /** The last report per file, so an unchanged set is one line, not a repeat. */
  private readonly lastReport = new Map<string, string>();
  private readonly budgetMs: number;

  constructor(
    private readonly root: string,
    private readonly options: DiagnosticsOptions = {},
  ) {
    // Edit tools return canonical paths. Match them to a workspace opened
    // through an alias, including macOS's /var -> /private/var mapping.
    this.root = fs.realpathSync(root);
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  }

  private ensureWorker(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    const typescript = this.options.typescriptPath ?? resolveTypeScript(this.root);
    if (!typescript) {
      this.broken = true;
      return null;
    }
    try {
      const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { typescript } });
      worker.unref();
      worker.on('message', (reply: WorkerReply) => {
        const resolve = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        resolve?.(reply);
      });
      const fail = () => {
        this.broken = true;
        this.worker = null;
        for (const [id, resolve] of this.pending) resolve({ id, error: 'diagnostics worker stopped' });
        this.pending.clear();
      };
      worker.on('error', fail);
      worker.on('exit', fail);
      this.worker = worker;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }

  /**
   * The note to append to an edit's result for `paths` (absolute), or null
   * when there is nothing to say: no TypeScript/JavaScript file, no tsconfig,
   * no errors and nothing reported before, or the check ran past its budget.
   */
  async afterEdit(paths: readonly string[]): Promise<string | null> {
    const files = paths
      .map((p) => path.resolve(p))
      .filter((p) => DIAGNOSTIC_EXTENSIONS.has(path.extname(p)) && fs.existsSync(p))
      .map((p) => fs.realpathSync(p))
      .map((file) => ({ file, tsconfig: nearestTsconfig(file, this.root) }))
      .filter((item): item is { file: string; tsconfig: string } => item.tsconfig !== null);
    if (files.length === 0) return null;
    const worker = this.ensureWorker();
    if (!worker) return null;
    const id = this.nextId++;
    const reply = await new Promise<WorkerReply | null>((resolve) => {
      const timer = setTimeout(() => {
        // Keep the worker: it is warming up and answers the next check.
        this.pending.set(id, () => {});
        resolve(null);
      }, this.budgetMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      worker.postMessage({ id, files });
    });
    if (!reply || reply.error || !reply.results) return null;
    const sections: string[] = [];
    for (const result of reply.results) {
      if (result.skipped) continue;
      const rel = path.relative(this.root, result.file) || path.basename(result.file);
      const lines = result.diagnostics
        .slice(0, MAX_PER_FILE)
        .map((d) => `${rel}:${d.line}:${d.column} - error TS${d.code}: ${d.message}`);
      const more = result.diagnostics.length > MAX_PER_FILE ? `\n…and ${result.diagnostics.length - MAX_PER_FILE} more` : '';
      const report = lines.join('\n') + more;
      const previous = this.lastReport.get(result.file);
      this.lastReport.set(result.file, report);
      if (result.diagnostics.length === 0) {
        if (previous) sections.push(`${rel}: no type errors now.`);
        continue;
      }
      if (previous === report) {
        sections.push(`${rel}: the same ${result.diagnostics.length} type error(s) as before remain.`);
        continue;
      }
      sections.push(report);
    }
    if (sections.length === 0) return null;
    return `<diagnostics source="typescript">\n${sections.join('\n')}\n</diagnostics>\nFix errors your edit introduced before moving on; leave ones that were already there unless the task is about them.`;
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    this.broken = true;
    void worker?.terminate();
  }
}

/** Whether after-edit diagnostics are on for this environment. */
export function diagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ALEVR_DIAGNOSTICS ?? env.JUNO_DIAGNOSTICS;
  return flag !== '0' && flag !== 'false';
}
