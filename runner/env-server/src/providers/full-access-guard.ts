/**
 * Full access, as the owner chose it (2026-10-10): never ask about commands,
 * edits, git, tests, MCP tools or media inside the thread's project folder,
 * and still ask about the few things that reach past it: running as
 * administrator (sudo, su, doas), acting on another machine (ssh, scp, sftp,
 * rsync, nc, telnet), and deleting or writing outside the folder. A `cd`
 * earlier in the same command moves where relative paths land; copying from
 * outside into the project is a read, not a write outside. A few
 * whole-machine actions ask wherever they run (a download piped into a shell,
 * a disk change, a shutdown, the keychain, a credentials folder, a force push).
 * Alevr's own engine sends its "sensitive" asks through the same guard
 * (providers/alevr.ts), so `rm -rf dist` inside the project no longer asks.
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
/** Programs that change every path they are given (mv also removes its source). */
const MOVE_PROGRAMS = new Set(["mv", "chmod", "chown", "chgrp", "truncate"]);
/** Programs that write only their last operand (or `-t DIR`); the sources are only read. */
const COPY_PROGRAMS = new Set(["cp", "ln", "install", "ditto"]);
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

/**
 * Whether `target` lands outside `cwd`, after `~`, `$HOME` and `..` are
 * resolved. A relative target resolves against `from` (the folder an earlier
 * `cd` in the same command moved to), the project folder by default.
 */
export function isOutside(target: string, cwd: string, from: string = cwd): boolean {
  if (!target) return false;
  if (target.startsWith("~") || target.includes("$HOME") || target.includes("${HOME}")) return true;
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, from, target);
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

/**
 * Whole-machine actions that never belong to one project: they ask under Full
 * access whatever folder they run in (the floor Alevr's own engine also keeps).
 */
const MACHINE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /(curl|wget)[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/, why: "pipes a download into a shell" },
  { re: /\b(mkfs(\.\w+)?|diskutil\s+(erase\w*|partition\w*|zero\w*)|fdisk)\b/i, why: "changes a disk" },
  { re: /(^|[\s;&|(])(shutdown|reboot|halt)\b/, why: "turns the Mac off or restarts it" },
  { re: /\bsecurity\s+(find|dump|delete)-[a-z-]*(keychain|password|certificate)/i, why: "reads the keychain" },
  { re: /(^|[\s"'=/])(~\/|\$HOME\/|\/Users\/[^/\s]+\/)?\.(ssh|aws|gnupg)(\/|\b)/, why: "touches a credentials folder" },
  { re: /\bgit\s+push\b[^;&|]*(--force\b|--force-with-lease\b|\s-f\b|\s\+\S)/, why: "rewrites history on the remote" },
];

/** The shell half of the guard, for adapters that only see a command line. */
export function commandGuardReason(command: string, cwd: string): string | undefined {
  for (const match of command.matchAll(/(?:^|[^<>&\d])\d?>>?\s*([^\s;&|]+)/g)) {
    const target = match[1].replace(/^["']|["']$/g, "");
    if (!target.startsWith("/dev/") && !target.startsWith("&") && isOutside(target, cwd)) {
      return `Full access still asks: this writes ${target}, outside the project folder.`;
    }
  }
  // Where the shell is when each program runs: `cd ../other && rm -rf build`
  // deletes outside the project even though `build` reads as inside.
  let here = path.resolve(cwd);
  for (const words of segments(command)) {
    const { program, args } = programOf(words);
    if (program === "cd" || program === "pushd") {
      const to = args.find((a) => !a.startsWith("-"));
      // `cd`, `cd ~` or `cd $HOME`: somewhere the guard cannot place inside the project.
      here = !to || to.startsWith("~") || to.includes("$") ? "/" : path.resolve(here, to);
      continue;
    }
    const outsideHere = (target: string) => isOutside(target, cwd, here);
    if (ADMIN_PROGRAMS.has(program)) return `Full access still asks: '${program}' runs as administrator, outside the project.`;
    if (REMOTE_PROGRAMS.has(program)) return `Full access still asks: '${program}' acts on another machine.`;
    const operands = args.filter((a) => !a.startsWith("-"));
    if (DELETE_PROGRAMS.has(program)) {
      const outside = operands.find(outsideHere);
      if (outside) return `Full access still asks: this deletes ${outside}, outside the project folder.`;
    }
    if (MOVE_PROGRAMS.has(program)) {
      const outside = operands.find(outsideHere);
      if (outside) return `Full access still asks: this changes ${outside}, outside the project folder.`;
    }
    if (COPY_PROGRAMS.has(program)) {
      const t = args.findIndex((a) => a === "-t" || a === "--target-directory");
      const dest = t >= 0 ? args[t + 1] : operands.length > 1 ? operands[operands.length - 1] : undefined;
      if (dest && outsideHere(dest)) return `Full access still asks: this writes ${dest}, outside the project folder.`;
    }
    if (program === "dd") {
      const target = args.find((a) => a.startsWith("of="))?.slice(3);
      if (target && target !== "/dev/null" && outsideHere(target)) return `Full access still asks: this writes ${target}, outside the project folder.`;
    }
    if (program === "git" && args.includes("clean") && [".", ...operands.filter((a) => a !== "clean")].some(outsideHere)) {
      return "Full access still asks: this deletes files outside the project folder.";
    }
  }
  for (const { re, why } of MACHINE_PATTERNS) {
    if (re.test(command)) return `Full access still asks: this ${why}, outside the project.`;
  }
  return undefined;
}
