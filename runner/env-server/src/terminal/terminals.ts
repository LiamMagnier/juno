/**
 * In-app terminals (install / sign-in flows and the Code workspace's
 * terminal panel). A real PTY through node-pty when it loads; otherwise a
 * pipe-backed shell that still runs commands but has no job control or
 * line editing — the client is told which one it got through the first
 * output line only when it is the fallback.
 *
 * Each terminal keeps a bounded scrollback so a client that reconnects (or a
 * second window) can repaint it: `terminal.open` with an existing id returns
 * the scrollback as one `terminal.output`.
 *
 * A setup `command` is typed into the shell but NOT submitted: the user sees
 * exactly what will run and presses Return themselves.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { newId, type Logger, describeError } from "../util.js";
import { spawnPath } from "../providers/detect.js";

export const SCROLLBACK_BYTES = 256 * 1024;

interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode?: number }) => void): void;
}

interface Terminal {
  id: string;
  pty: PtyLike;
  scrollback: string;
  exited: boolean;
  exitCode?: number;
  kind: "pty" | "pipe";
}

export interface TerminalEvents {
  output(terminalId: string, data: string): void;
  exited(terminalId: string, exitCode?: number): void;
}

type NodePty = { spawn(file: string, args: string[], opts: Record<string, unknown>): PtyLike & { onData: (cb: (d: string) => void) => unknown; onExit: (cb: (e: { exitCode: number }) => void) => unknown } };

let ptyModule: NodePty | null | undefined;

function loadPty(logger: Logger): NodePty | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    const require = createRequire(import.meta.url);
    const mod = require("node-pty") as NodePty;
    // npm may skip node-pty's postinstall, leaving the prebuilt spawn-helper without +x.
    try {
      const base = path.dirname(require.resolve("node-pty/package.json"));
      for (const arch of ["darwin-arm64", "darwin-x64"]) {
        const helper = path.join(base, "prebuilds", arch, "spawn-helper");
        if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
      }
    } catch {
      /* best effort */
    }
    ptyModule = mod;
  } catch (error) {
    logger.info(`node-pty unavailable, terminals use pipes: ${describeError(error)}`);
    ptyModule = null;
  }
  return ptyModule;
}

function pipeShell(shell: string, cwd: string, env: NodeJS.ProcessEnv): PtyLike {
  // `-i` keeps a prompt; stderr is merged into the same stream the client renders.
  const child: ChildProcessWithoutNullStreams = spawn(shell, ["-i"], { cwd, env: { ...env, TERM: "dumb" }, stdio: ["pipe", "pipe", "pipe"], shell: false });
  const dataCbs: ((d: string) => void)[] = [];
  const exitCbs: ((e: { exitCode?: number }) => void)[] = [];
  child.stdout.on("data", (b: Buffer) => dataCbs.forEach((cb) => cb(b.toString("utf8"))));
  child.stderr.on("data", (b: Buffer) => dataCbs.forEach((cb) => cb(b.toString("utf8"))));
  child.on("close", (code) => exitCbs.forEach((cb) => cb({ exitCode: code ?? undefined })));
  child.on("error", (e) => dataCbs.forEach((cb) => cb(`\r\n${String(e)}\r\n`)));
  return {
    write: (data) => {
      // A pipe has no line discipline: translate Return into newline.
      if (child.stdin.writable) child.stdin.write(data.replace(/\r(?!\n)/g, "\n"));
    },
    resize: () => {},
    kill: (signal) => child.kill((signal as NodeJS.Signals) ?? "SIGHUP"),
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
  };
}

export class TerminalManager {
  #terminals = new Map<string, Terminal>();

  constructor(
    private readonly events: TerminalEvents,
    private readonly logger: Logger,
    private readonly options: { forcePipe?: boolean; shell?: string } = {},
  ) {}

  open(params: { terminalId?: string; cwd: string; cols: number; rows: number; command?: string }): { terminalId: string; reattached: boolean } {
    if (params.terminalId) {
      const existing = this.#terminals.get(params.terminalId);
      if (existing) {
        if (!existing.exited) existing.pty.resize(params.cols, params.rows);
        if (existing.scrollback) this.events.output(existing.id, existing.scrollback);
        if (params.command && !existing.exited) existing.pty.write(params.command);
        return { terminalId: existing.id, reattached: true };
      }
    }
    const id = params.terminalId && /^[A-Za-z0-9_.-]{1,64}$/.test(params.terminalId) ? params.terminalId : newId("term");
    const cwd = fs.existsSync(params.cwd) ? params.cwd : os.homedir();
    const shell = this.options.shell ?? process.env.SHELL ?? "/bin/zsh";
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: spawnPath(undefined), TERM: "xterm-256color", COLORTERM: "truecolor", ALEVR_TERMINAL: "1" };
    for (const key of Object.keys(env)) if (key.startsWith("ALEVR_ENV_")) delete env[key];
    const pty = this.options.forcePipe ? null : loadPty(this.logger);
    let handle: PtyLike;
    let kind: Terminal["kind"] = "pty";
    if (pty) {
      try {
        handle = pty.spawn(shell, ["-l"], { name: "xterm-256color", cols: params.cols, rows: params.rows, cwd, env });
      } catch (error) {
        this.logger.warn(`pty spawn failed, using a pipe: ${describeError(error)}`);
        handle = pipeShell(shell, cwd, env);
        kind = "pipe";
      }
    } else {
      handle = pipeShell(shell, cwd, env);
      kind = "pipe";
    }
    const terminal: Terminal = { id, pty: handle, scrollback: "", exited: false, kind };
    this.#terminals.set(id, terminal);
    handle.onData((data) => {
      terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_BYTES);
      this.events.output(id, data);
    });
    handle.onExit(({ exitCode }) => {
      terminal.exited = true;
      terminal.exitCode = exitCode;
      this.events.exited(id, exitCode);
    });
    if (kind === "pipe") {
      const note = "Alevr: this terminal has no full-screen support on this Mac; commands still run.\r\n";
      terminal.scrollback += note;
      this.events.output(id, note);
    }
    if (params.command) {
      // Typed, not submitted: the user reads it and presses Return.
      const command = params.command;
      setTimeout(() => {
        if (!terminal.exited) handle.write(command);
      }, kind === "pty" ? 250 : 50).unref?.();
    }
    return { terminalId: id, reattached: false };
  }

  write(terminalId: string, data: string): void {
    const t = this.#require(terminalId);
    if (!t.exited) t.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const t = this.#require(terminalId);
    if (!t.exited) t.pty.resize(cols, rows);
  }

  close(terminalId: string): void {
    const t = this.#terminals.get(terminalId);
    if (!t) return;
    if (!t.exited) {
      try {
        t.pty.kill();
      } catch {
        /* gone */
      }
    }
    this.#terminals.delete(terminalId);
  }

  closeAll(): void {
    for (const id of [...this.#terminals.keys()]) this.close(id);
  }

  kindOf(terminalId: string): "pty" | "pipe" | undefined {
    return this.#terminals.get(terminalId)?.kind;
  }

  #require(terminalId: string): Terminal {
    const t = this.#terminals.get(terminalId);
    if (!t) throw Object.assign(new Error(`No terminal ${terminalId}.`), { wireCode: "not_found" });
    return t;
  }
}
