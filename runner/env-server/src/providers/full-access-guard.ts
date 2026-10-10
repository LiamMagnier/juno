/**
 * Full access, as the owner chose it (2026-10-10): never ask about commands,
 * edits, git, tests, MCP tools or media inside the thread's project folder,
 * and still ask about the few things that reach past it: running as
 * administrator (sudo, su, doas), acting on another machine (ssh, scp, sftp,
 * rsync, nc, telnet), and deleting or writing outside the folder.
 *
 * Every vendor adapter asks this one question before it lets a call through
 * under Full access, so Claude, Codex and ACP agents draw the line in the same
 * place as Alevr's own engine. It reads the call, never runs anything, and
 * errs towards asking: a path it cannot place counts as outside.
 */
import path from "node:path";

const ADMIN_PROGRAMS = new Set(["sudo", "su", "doas"]);
const REMOTE_PROGRAMS = new Set(["ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet"]);
const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash"]);
const MOVE_PROGRAMS = new Set(["mv", "cp", "ln", "chmod", "chown", "truncate", "dd"]);
/** Tools that write a file named in their input. */
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Words of one shell command line, split on the separators that start a new program. */
function segments(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|&\n]|\$\(|`/)
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/^["']|["']$/g, ""))
        .filter(Boolean),
    )
    .filter((words) => words.length > 0);
}

/** The program a segment runs, past `env VAR=x`, `command`, `exec`, `nohup` and `time`. */
function programOf(words: string[]): { program: string; args: string[] } {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || ["env", "command", "exec", "nohup", "time", "builtin"].includes(w)) {
      i++;
      continue;
    }
    break;
  }
  const program = path.basename(words[i] ?? "");
  return { program, args: words.slice(i + 1) };
}

/** Whether `target` lands outside `cwd`, after `~`, `$HOME` and `..` are resolved. */
export function isOutside(target: string, cwd: string): boolean {
  if (!target) return false;
  if (target.startsWith("~") || target.includes("$HOME") || target.includes("${HOME}")) return true;
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, target);
  return resolved !== root && !resolved.startsWith(root + path.sep);
}

/**
 * Why a call must still ask under Full access, or undefined when it may run
 * without asking. The reason is shown on the prompt.
 */
export function fullAccessGuardReason(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : undefined;
    if (file && isOutside(file, cwd)) return `Full access still asks: this writes ${file}, outside the project folder.`;
    return undefined;
  }
  const command = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : undefined;
  if (command === undefined) return undefined;
  return commandGuardReason(command, cwd);
}

/** The shell half of the guard, for adapters that only see a command line. */
export function commandGuardReason(command: string, cwd: string): string | undefined {
  for (const match of command.matchAll(/(?:^|[^<>&\d])\d?>>?\s*([^\s;&|]+)/g)) {
    const target = match[1].replace(/^["']|["']$/g, "");
    if (!target.startsWith("/dev/") && !target.startsWith("&") && isOutside(target, cwd)) {
      return `Full access still asks: this writes ${target}, outside the project folder.`;
    }
  }
  for (const words of segments(command)) {
    const { program, args } = programOf(words);
    if (ADMIN_PROGRAMS.has(program)) return `Full access still asks: '${program}' runs as administrator, outside the project.`;
    if (REMOTE_PROGRAMS.has(program)) return `Full access still asks: '${program}' acts on another machine.`;
    const operands = args.filter((a) => !a.startsWith("-"));
    if (DELETE_PROGRAMS.has(program)) {
      const outside = operands.find((a) => isOutside(a, cwd));
      if (outside) return `Full access still asks: this deletes ${outside}, outside the project folder.`;
    }
    if (MOVE_PROGRAMS.has(program)) {
      const outside = operands.find((a) => isOutside(a, cwd));
      if (outside) return `Full access still asks: this changes ${outside}, outside the project folder.`;
    }
    if (program === "git" && args.includes("clean") && operands.some((a) => isOutside(a, cwd))) {
      return "Full access still asks: this deletes files outside the project folder.";
    }
  }
  return undefined;
}
