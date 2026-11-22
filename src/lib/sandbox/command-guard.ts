/**
 * The command guard: what Alevr refuses to run, whoever asked and wherever it
 * would run, checked on the server before a command reaches a sandbox.
 *
 * Two places run model-written commands for a chat:
 *  - `cloud-sandbox`: `run_code` on the hosted execution host (website and
 *    iPhone). A fresh container, no network, a read-only root. The guard is
 *    defence in depth there: it refuses what only an attack on the sandbox
 *    itself would need (escapes, miners, reverse shells, fork bombs).
 *  - `mac-folder`: `folder_run_command` on the user's own Mac, inside the
 *    folder they shared. The Mac's kernel sandbox and its approval card are
 *    the first two lines; the guard is the third, and it runs before the
 *    person is asked, so a dangerous command never reaches the card at all.
 *    (The Mac checks again with Alevr Code's CommandClassifier, and refuses
 *    to run anything it cannot sandbox.)
 *
 * Three verdicts:
 *  - `block`: never runs. The model reads why and is told not to rephrase it.
 *  - `caution`: may run; on the Mac the approval card says why to look twice.
 *  - `allow`: nothing in the command needs a second look.
 *
 * Pure and synchronous; the rules are data (COMMAND_RULES) so a new one is a
 * line plus a test in tests/command-guard.test.ts.
 */

export type CommandPlace = "cloud-sandbox" | "mac-folder";
export type CommandRisk = "allow" | "caution" | "block";

export interface CommandVerdict {
  risk: CommandRisk;
  /** The rule that decided it, for logs and tests. */
  rule?: string;
  /** One sentence a person can read, starting with "It". */
  reason?: string;
}

/** One shell command: its program (basename, lower case), its words after the program, and its redirect targets. */
export interface CommandSegment {
  program: string;
  args: string[];
  redirects: string[];
  /** The segment as written, for pattern rules that need the shape of the words. */
  text: string;
}

export interface CommandRule {
  id: string;
  risk: Exclude<CommandRisk, "allow">;
  /** Where it applies; every place when absent. */
  places?: readonly CommandPlace[];
  reason: string;
  /** A match anywhere in the command line (pipelines included). */
  pattern?: RegExp;
  /** A match on one segment. */
  test?: (segment: CommandSegment) => boolean;
}

const OK: CommandVerdict = { risk: "allow" };

/** How deep `$(…)`, backticks and `sh -c "…"` are opened before the guard gives up and refuses. */
const MAX_DEPTH = 4;
/** Longer than any command a chat needs; long enough to hide something in. */
export const MAX_COMMAND_CHARS = 16_384;

// ── Words ──────────────────────────────────────────────────────────────────

const has = (args: readonly string[], ...flags: string[]) => args.some((a) => flags.includes(a));
/** `-rf`, `-fr`, `-Rf`, `--recursive`: a short-flag bundle containing the letter, or the long flag. */
const flag = (args: readonly string[], letter: string, long?: string) =>
  args.some((a) => (/^-[A-Za-z]+$/.test(a) && a.includes(letter)) || (long !== undefined && a === long));
const sub = (args: readonly string[]) => args.find((a) => !a.startsWith("-"));

const HOME_OR_ROOT = /^(?:\/+\*?|~\/?\*?|\$\{?HOME\}?\/?\*?|\/(?:System|usr|bin|sbin|etc|var|private|Library|Applications|Users|home|root|boot|opt|dev|proc|sys)(?:\/\*?)?)$/;
const DEVICE = /^\/dev\/(?:r?disk\d|sd[a-z]|hd[a-z]|nvme\d|xvd[a-z]|mmcblk\d|mem|kmem|port)/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);
const DOWNLOADERS = "(?:curl|wget|fetch|aria2c|http|https|xh)";
const INTERPRETERS = "(?:(?:ba|z|da|k|c|tc|fi)?sh|python[0-9.]*|node|deno|bun|perl|ruby|php|osascript|lua)";
/** An interpreter at the end of a pipe that reads its PROGRAM from the pipe: `| sh`, `| bash -s --`, `| python3 -`. `| python3 -m json.tool` reads data, and passes. */
const RUNS_PIPE = String.raw`\|\s*(?:sudo\s+)?(?:env\s+)?${INTERPRETERS}(?:\s+-{1,2}[A-Za-z]*)*\s*(?:$|[;&|)\n]|--?(?:\s|$))`;

/** Files that hold passwords, keys, tokens or shell history. */
const SECRET_PATH = new RegExp(
  [
    String.raw`(?:^|[\s"'=:/])~?\/?\.ssh(?:\/|\b)`,
    String.raw`\bid_(?:rsa|dsa|ecdsa|ed25519)\b`,
    String.raw`\.aws\/credentials`,
    String.raw`\.config\/gcloud`,
    String.raw`\.netrc\b`,
    String.raw`\.git-credentials`,
    String.raw`\.docker\/config\.json`,
    String.raw`\.kube\/config`,
    String.raw`\.gnupg`,
    String.raw`Library\/Keychains`,
    String.raw`\.keychain(?:-db)?\b`,
    String.raw`\/Login Data\b`,
    String.raw`Cookies\.binarycookies`,
    String.raw`\/(?:Google\/Chrome|Firefox|BraveSoftware|Microsoft Edge)\/[^\s]*\/(?:Cookies|Login Data)`,
    String.raw`\.(?:zsh|bash|sh|python|node_repl|psql|mysql)_history\b`,
  ].join("|"),
);

/** What runs at every login or every new shell. */
const STARTUP_PATH = /(?:^|[\s"'=:/])~?\/?\.(?:zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|bash_login|profile)\b|Library\/Launch(?:Agents|Daemons)|\/etc\/(?:cron|rc\.|profile|launchd)|\.config\/fish\/config\.fish/;

// ── The rules ──────────────────────────────────────────────────────────────

export const COMMAND_RULES: readonly CommandRule[] = [
  // Never, anywhere.
  { id: "privilege", risk: "block", reason: "It asks for administrator rights, and nothing here runs as root.", test: (s) => ["sudo", "su", "doas", "pkexec", "runas", "sudoedit"].includes(s.program) },
  { id: "setuid", risk: "block", reason: "It would make a program run with its owner's rights (setuid).", test: (s) => s.program === "chmod" && s.args.some((a) => /^(?:[ugoa]*\+[rwx]*s|[2-7][0-7]{3})$/.test(a)) },
  {
    id: "wipe",
    risk: "block",
    reason: "It would delete the whole disk, your home folder or a system folder.",
    test: (s) =>
      (s.program === "rm" && (flag(s.args, "r", "--recursive") || flag(s.args, "R")) && (s.args.some((a) => HOME_OR_ROOT.test(a)) || has(s.args, "--no-preserve-root"))) ||
      (s.program === "find" && HOME_OR_ROOT.test(s.args[0] ?? "") && (has(s.args, "-delete") || s.args.includes("rm"))) ||
      (s.program === "rsync" && has(s.args, "--delete") && s.args.some((a) => HOME_OR_ROOT.test(a))),
  },
  {
    id: "disk",
    risk: "block",
    reason: "It would erase or repartition a disk.",
    test: (s) =>
      /^(?:mkfs(?:\..+)?|newfs(?:_.+)?|fdisk|sfdisk|gdisk|parted|wipefs|mke2fs)$/.test(s.program) ||
      (s.program === "diskutil" && /^(?:erase.*|zeroDisk|randomDisk|secureErase|partitionDisk|reformat|apfs)$/i.test(sub(s.args) ?? "")) ||
      (s.program === "dd" && s.args.some((a) => /^of=\/dev\//.test(a))) ||
      s.redirects.some((r) => DEVICE.test(r)) ||
      (s.program === "shred" && s.args.some((a) => DEVICE.test(a))),
  },
  { id: "power", risk: "block", reason: "It would shut down or restart the machine.", test: (s) => ["shutdown", "reboot", "halt", "poweroff", "pmset"].includes(s.program) || (s.program === "systemctl" && /^(?:poweroff|reboot|halt|suspend|hibernate)$/.test(sub(s.args) ?? "")) || (s.program === "init" && /^[06]$/.test(s.args[0] ?? "")) },
  {
    id: "system-settings",
    risk: "block",
    reason: "It changes how the operating system protects itself or starts up.",
    test: (s) =>
      ["csrutil", "nvram", "spctl", "systemsetup", "tccutil", "kextload", "kextunload", "kmutil", "bless", "fdesetup", "dscl", "scutil", "networksetup", "dscacheutil", "visudo", "passwd", "chpasswd", "useradd", "usermod", "userdel"].includes(s.program) ||
      (s.program === "sysctl" && s.args.some((a) => a === "-w" || a.includes("="))) ||
      (s.program === "launchctl" && !/^(?:list|print|help|version)$/.test(sub(s.args) ?? "")) ||
      (s.program === "crontab" && !has(s.args, "-l")) ||
      s.program === "at" || s.program === "batch",
  },
  { id: "fork-bomb", risk: "block", reason: "It would start copies of itself until the machine stops responding.", pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&|\b(\w+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&|while\s*\(?\s*(?:true|1|True)\s*\)?\s*[:;{]?[\s\S]{0,80}?\bfork\s*\(/ },
  { id: "remote-script", risk: "block", reason: "It would download a script and run it without anyone reading it first.", pattern: new RegExp(String.raw`\b${DOWNLOADERS}\b[^|;&\n]*${RUNS_PIPE}|\b${INTERPRETERS}\s+<\(\s*${DOWNLOADERS}\b|\b${INTERPRETERS}\s+-c\s+["']?\$\(\s*${DOWNLOADERS}\b`, "m") },
  { id: "obfuscated", risk: "block", reason: "It decodes hidden text and runs it as a program.", pattern: new RegExp(String.raw`\b(?:base64\s+(?:-d|--decode|-D)|xxd\s+-r|openssl\s+(?:enc\s+)?-d)\b[^;&\n]*${RUNS_PIPE}|\beval\s+["']?\$\([^)]*\bbase64\b`, "m") },
  { id: "reverse-shell", risk: "block", reason: "It would open a remote shell into this machine.", pattern: /\/dev\/(?:tcp|udp)\/|\bn(?:c|cat|etcat)\b[^|;&\n]*\s-[A-Za-z]*[ec]\b|\bsocat\b[^;&\n]*\b(?:exec|system):|\b(?:ba|z)?sh\s+-i\s*[<>]&|\bmkfifo\b[^\n]*\bn(?:c|cat)\b|pty\.spawn\(\s*["'][^"']*sh["']/ },
  { id: "kill-everything", risk: "block", reason: "It would stop every program running.", test: (s) => (s.program === "kill" && s.args.some((a) => a === "-1" || a === "1")) || (s.program === "killall" && has(s.args, "-u")) || (s.program === "pkill" && (has(s.args, "-u") || has(s.args, "-U"))) },
  { id: "miner", risk: "block", reason: "Cryptocurrency mining is not allowed.", pattern: /\bstratum\+(?:tcp|ssl):\/\/|\b(?:xmrig|minerd|cpuminer|ethminer|nbminer|lolminer|phoenixminer|nanominer|xmr-stak)\b/ },
  { id: "secrets", risk: "block", reason: "It would read passwords, keys, tokens or shell history.", pattern: SECRET_PATH, test: (s) => s.program === "security" && /^(?:find-(?:generic|internet)-password|dump-keychain|export|unlock-keychain|show-keychain-info|delete-.*|add-.*-password)$/.test(sub(s.args) ?? "") },
  {
    id: "sandbox-escape",
    risk: "block",
    reason: "It tries to reach outside the sandbox.",
    pattern: /\/var\/run\/docker\.sock|\/run\/containerd|\/proc\/sysrq-trigger|\/proc\/1\/(?:root|environ|ns)|\/proc\/kcore|\/sys\/kernel|release_agent/,
    test: (s) => ["nsenter", "chroot", "unshare", "capsh", "setcap", "mount", "umount", "insmod", "modprobe", "rmmod", "kexec", "docker", "podman", "kubectl", "crictl", "ctr", "lxc", "runc"].includes(s.program),
  },

  // On the Mac: the folder tool works in one folder, not on the rest of the computer.
  { id: "startup-files", risk: "block", places: ["mac-folder"], reason: "It touches the files that run when you log in or open a terminal, which can also hold keys.", pattern: STARTUP_PATH },
  { id: "control-apps", risk: "block", places: ["mac-folder"], reason: "It would control other apps or change system settings, which a folder command is not for.", test: (s) => ["osascript", "automator", "shortcuts", "screencapture", "pbpaste", "defaults", "plutil", "sqlite3"].includes(s.program) && (s.program !== "plutil" || s.args.some((a) => a.includes("Library/Preferences"))) && (s.program !== "sqlite3" || s.args.some((a) => a.includes("Library/"))) },

  // Allowed, with a second look.
  { id: "recursive-delete", risk: "caution", reason: "It deletes files and folders, and that cannot be undone.", test: (s) => (s.program === "rm" && (flag(s.args, "r", "--recursive") || flag(s.args, "R") || s.args.some((a) => a.includes("*")))) || (s.program === "find" && (has(s.args, "-delete") || s.args.some((a) => a === "rm"))) || s.program === "shred" || (s.program === "git" && sub(s.args) === "clean") },
  { id: "git-rewrite", risk: "caution", reason: "It rewrites or throws away git history or uncommitted work.", test: (s) => s.program === "git" && ((sub(s.args) === "push" && (flag(s.args, "f", "--force") || s.args.some((a) => a.startsWith("--force")))) || (sub(s.args) === "reset" && has(s.args, "--hard")) || /^(?:rebase|filter-branch|filter-repo)$/.test(sub(s.args) ?? "") || (sub(s.args) === "branch" && flag(s.args, "D")) || ((sub(s.args) === "checkout" || sub(s.args) === "restore") && has(s.args, "."))) },
  { id: "install", risk: "caution", reason: "It installs packages, and installers run their own scripts.", test: (s) => (/^(?:npm|pnpm|yarn|bun)$/.test(s.program) && /^(?:i|install|add|ci)$/.test(sub(s.args) ?? "")) || (/^(?:pip|pip3|gem|cargo|go|brew|apt|apt-get|yum|dnf|apk|port|conda|uv)$/.test(s.program) && has(s.args, "install", "add")) },
  { id: "network", risk: "caution", places: ["mac-folder"], reason: "It reaches the network, which this folder's sandbox does not allow, so it will likely fail.", test: (s) => ["curl", "wget", "ssh", "scp", "sftp", "ftp", "telnet", "nc", "ncat", "rsync", "git"].includes(s.program) && (s.program !== "git" || /^(?:push|pull|fetch|clone)$/.test(sub(s.args) ?? "")) && (s.program !== "rsync" || s.args.some((a) => /^[^/]+:/.test(a))) },
  { id: "permissions", risk: "caution", reason: "It changes who can read or change files.", test: (s) => ["chown", "chgrp", "chflags", "xattr"].includes(s.program) || (s.program === "chmod" && flag(s.args, "R")) },
  { id: "processes", risk: "caution", reason: "It stops other programs.", test: (s) => ["kill", "pkill", "killall"].includes(s.program) },
  { id: "environment", risk: "caution", places: ["mac-folder"], reason: "It prints environment variables, which can hold keys.", test: (s) => (s.program === "env" || s.program === "printenv" || s.program === "set" || s.program === "export") && s.args.length === 0 },
  { id: "open-outside", risk: "caution", places: ["mac-folder"], reason: "It opens something outside the shared folder.", test: (s) => s.program === "open" },
];

// ── Reading a command line ─────────────────────────────────────────────────

/** Shell words that come before the command they govern (`if rm …`, `{ rm …; }`, `! grep …`). */
const LEADING_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "coproc", "time"]);
/** Shell words that start a header, not a command (`for x in a b`, `case $x in`, `fi`, `done`). */
const HEADER_KEYWORDS = new Set(["for", "select", "case", "esac", "fi", "done", "function", "in"]);

/** Wrappers that run the next word as the program. */
const WRAPPERS = new Set(["env", "nohup", "nice", "time", "command", "builtin", "exec", "stdbuf", "caffeinate", "ionice", "chronic", "unbuffer"]);

interface Split {
  segments: string[][];
  redirects: string[][];
  /** The text of every `$(…)`, `` `…` `` and `<(…)` inside, to check on its own. */
  nested: string[];
  ok: boolean;
}

/**
 * Splits a command line into simple commands with shell quoting rules:
 * `;`, `&`, `&&`, `||`, `|`, newlines and parentheses separate them; quotes
 * and backslashes keep words whole; redirect targets are kept apart from the
 * words. An unterminated quote or substitution is `ok: false`, which the
 * guard refuses: what it cannot read, it does not run.
 */
export function splitCommand(line: string): Split {
  const segments: string[][] = [];
  const redirects: string[][] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let targets: string[] = [];
  let word = "";
  let inWord = false;
  let redirectNext = false;
  const endWord = () => {
    if (!inWord) return;
    if (redirectNext) targets.push(word);
    else words.push(word);
    redirectNext = false;
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length || targets.length) {
      segments.push(words);
      redirects.push(targets);
    }
    words = [];
    targets = [];
  };
  /** The text from `start` to its matching close, or -1. */
  const closing = (from: number, open: string, close: string): number => {
    let depth = 1;
    for (let j = from; j < line.length; j++) {
      const c = line[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "'" ) {
        const end = line.indexOf("'", j + 1);
        if (end < 0) return -1;
        j = end;
        continue;
      }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j;
    }
    return -1;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const next = line[i + 1];
    if (c === "\\") {
      word += next ?? "";
      inWord = true;
      i++;
      continue;
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return { segments, redirects, nested, ok: false };
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = "";
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\" && j + 1 < line.length) {
          text += line[++j];
          continue;
        }
        if (line[j] === "$" && line[j + 1] === "(") {
          const end = closing(j + 2, "(", ")");
          if (end < 0) return { segments, redirects, nested, ok: false };
          nested.push(line.slice(j + 2, end));
          text += line.slice(j, end + 1);
          j = end;
          continue;
        }
        if (line[j] === "`") {
          const end = line.indexOf("`", j + 1);
          if (end < 0) return { segments, redirects, nested, ok: false };
          nested.push(line.slice(j + 1, end));
          text += line.slice(j, end + 1);
          j = end;
          continue;
        }
        text += line[j];
      }
      if (j >= line.length) return { segments, redirects, nested, ok: false };
      word += text;
      inWord = true;
      i = j;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && next === "(") {
      const end = closing(i + 2, "(", ")");
      if (end < 0) return { segments, redirects, nested, ok: false };
      nested.push(line.slice(i + 2, end));
      word += line.slice(i, end + 1);
      inWord = true;
      i = end;
      continue;
    }
    if (c === "`") {
      const end = line.indexOf("`", i + 1);
      if (end < 0) return { segments, redirects, nested, ok: false };
      nested.push(line.slice(i + 1, end));
      word += line.slice(i, end + 1);
      inWord = true;
      i = end;
      continue;
    }
    if (c === "&" && next === ">") {
      // `&>file`, `&>>file`: both streams to a file.
      endWord();
      i++;
      if (line[i + 1] === ">") i++;
      redirectNext = true;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "(" || c === ")" || c === "&") {
      endSegment();
      if ((c === "|" || c === "&") && next === c) i++;
      continue;
    }
    if (c === ">" || (c === "<" && next !== "<")) {
      // `2>&1`, `>&2`: a descriptor, not a file.
      const descriptor = /^\d+$/.test(word);
      if (descriptor) {
        word = "";
        inWord = false;
      } else endWord();
      if (next === ">" || next === "|") i++;
      if (line[i + 1] === "&") {
        i++;
        while (i + 1 < line.length && /\d|-/.test(line[i + 1]!)) i++;
        continue;
      }
      if (c === ">") redirectNext = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  endSegment();
  return { segments, redirects, nested, ok: true };
}

function basename(word: string): string {
  return (word.split("/").pop() ?? word).toLowerCase();
}

/** The program a simple command runs, past `NAME=value` assignments and wrappers like `env` or `nohup`. */
export function segmentOf(words: readonly string[], redirects: readonly string[]): CommandSegment | null {
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    const w = words[i];
    if (w === undefined) return null;
    if (LEADING_KEYWORDS.has(w)) {
      i++;
      continue;
    }
    if (HEADER_KEYWORDS.has(w)) return null;
    const name = basename(w);
    if (WRAPPERS.has(name)) {
      i++;
      // Their own flags (`env -i`, `nice -n 5`, `timeout 10`) are not the program.
      while (i < words.length && (words[i]!.startsWith("-") || /^\d+[smhd]?$/.test(words[i]!))) i++;
      continue;
    }
    if (name === "timeout" || name === "xargs") {
      i++;
      while (i < words.length && (words[i]!.startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(words[i]!))) i++;
      continue;
    }
    return { program: name, args: words.slice(i + 1), redirects: [...redirects], text: words.join(" ") };
  }
}

const rank: Record<CommandRisk, number> = { allow: 0, caution: 1, block: 2 };
const worse = (a: CommandVerdict, b: CommandVerdict) => (rank[b.risk] > rank[a.risk] ? b : a);

function applies(rule: CommandRule, place: CommandPlace): boolean {
  return !rule.places || rule.places.includes(place);
}

function judge(rule: CommandRule): CommandVerdict {
  return { risk: rule.risk, rule: rule.id, reason: rule.reason };
}

interface Heredoc {
  body: string;
  /** How the body is used: run as shell commands, run by another interpreter, or written as data. */
  runs: "shell" | "program" | "data";
  language?: string;
}

const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
const SHELL_PROGRAM = /^(?:(?:ba|z|da|k)?sh|source|\.)$/;
const OTHER_INTERPRETER: Record<string, string> = { python: "python", python3: "python", node: "javascript", deno: "javascript", bun: "javascript", perl: "perl", ruby: "ruby", php: "php" };

/**
 * Takes heredoc bodies out of a command line, so source written to a file is
 * not read as commands, and says how each body is used: fed to a shell (or
 * written to a file a shell then runs), fed to another interpreter, or data.
 */
export function liftHeredocs(text: string): { line: string; heredocs: Heredoc[] } {
  if (!text.includes("<<")) return { line: text, heredocs: [] };
  const lines = text.split("\n");
  const out: string[] = [];
  const heredocs: Heredoc[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!;
    out.push(header);
    const markers = [...header.matchAll(HEREDOC)].filter((m) => !/<<</.test(header.slice(Math.max(0, m.index! - 1), m.index! + 3)));
    for (const marker of markers) {
      const strip = marker[1] === "-";
      const delimiter = marker[3]!;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const candidate = strip ? lines[j]!.replace(/^\t+/, "") : lines[j]!;
        if (candidate === delimiter) break;
        body.push(lines[j]!);
      }
      i = Math.min(j, lines.length - 1);
      const head = header.slice(0, marker.index).trim();
      const first = basename(head.split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "");
      const piped = header.slice(marker.index! + marker[0].length).match(/\|\s*(?:sudo\s+)?([\w./-]+)/)?.[1];
      const target = header.match(/>\s*([\w./-]+)/)?.[1];
      const rest = lines.slice(j + 1).join("\n");
      const runner =
        [first, piped ? basename(piped) : ""].find((w) => SHELL_PROGRAM.test(w) || OTHER_INTERPRETER[w.replace(/[0-9.]+$/, "")]) ??
        (target ? rest.match(new RegExp(String.raw`(?:^|[\s;&|])((?:ba|z|da|k)?sh|source|\.|python[0-9.]*|node|deno|bun|perl|ruby|php)\s+(?:\./)?${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`))?.[1] : undefined);
      const lang = runner ? OTHER_INTERPRETER[runner.replace(/[0-9.]+$/, "")] : undefined;
      heredocs.push({ body: body.join("\n"), runs: runner ? (lang ? "program" : "shell") : "data", ...(lang ? { language: lang } : {}) });
    }
  }
  return { line: out.join("\n"), heredocs };
}

function guard(text: string, place: CommandPlace, depth: number, rules: readonly CommandRule[]): CommandVerdict {
  if (depth > MAX_DEPTH) return { risk: "block", rule: "unreadable", reason: "It nests commands too deeply to check." };
  let verdict = OK;
  const { line, heredocs } = liftHeredocs(text);
  for (const doc of heredocs) {
    verdict = worse(verdict, doc.runs === "shell" ? guard(doc.body, place, depth + 1, rules) : guardSource(doc.body, place, rules));
    if (verdict.risk === "block") return verdict;
  }
  for (const rule of rules) {
    if (rule.pattern && applies(rule, place) && rule.pattern.test(line)) {
      verdict = worse(verdict, judge(rule));
      if (verdict.risk === "block") return verdict;
    }
  }
  const split = splitCommand(line);
  if (!split.ok) return { risk: "block", rule: "unreadable", reason: "It could not be read safely (an unclosed quote or bracket)." };
  for (const inner of split.nested) {
    verdict = worse(verdict, guard(inner, place, depth + 1, rules));
    if (verdict.risk === "block") return verdict;
  }
  for (let k = 0; k < split.segments.length; k++) {
    const segment = segmentOf(split.segments[k]!, split.redirects[k]!);
    if (!segment) continue;
    for (const rule of rules) {
      if (rule.test && applies(rule, place) && rule.test(segment)) {
        verdict = worse(verdict, judge(rule));
        if (verdict.risk === "block") return verdict;
      }
    }
    // `sh -c "…"`, `bash -lc '…'`, `eval …`: the string is a command line of its own.
    const shellString =
      SHELLS.has(segment.program) && segment.args.some((a) => /^-[a-z]*c[a-z]*$/.test(a))
        ? segment.args[segment.args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a)) + 1]
        : segment.program === "eval"
          ? segment.args.join(" ")
          : undefined;
    if (shellString) {
      verdict = worse(verdict, guard(shellString, place, depth + 1, rules));
      if (verdict.risk === "block") return verdict;
    }
  }
  return verdict;
}

/** The verdict on one command line, before it runs. */
export function guardCommand(command: string, place: CommandPlace, rules: readonly CommandRule[] = COMMAND_RULES): CommandVerdict {
  const line = command.trim();
  if (!line) return OK;
  if (line.length > MAX_COMMAND_CHARS) return { risk: "block", rule: "too-long", reason: "It is longer than any command this needs." };
  if (/[\u0000\u001b]/.test(line)) return { risk: "block", rule: "unreadable", reason: "It contains control characters." };
  return guard(line, place, 0, rules);
}

/** Calls in Python and JavaScript that hand a string to a shell. */
const SHELL_OUT = /\b(?:os\.(?:system|popen|exec[lv]p?e?|spawn[lv]p?e?)|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)|commands\.getoutput|pty\.spawn|(?:child_process\.)?(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)|Bun\.spawn|Deno\.(?:run|Command)|system|popen|shell_exec|passthru|proc_open|IO\.popen|Runtime\.getRuntime\(\)\.exec|exec\.Command|Command::new)\s*\(\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

function literal(text: string): string {
  if (text.startsWith("[")) {
    return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1] ?? m[2] ?? "").join(" ");
  }
  return text.slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * The verdict on a whole program for `run_code`. Bash is a command line; for
 * Python and JavaScript, every string handed to a shell (`subprocess.run`,
 * `os.system`, `execSync`, C's `system`, Go's `exec.Command`…) is checked as
 * one, and the pattern rules run over
 * the source itself, so a reverse shell or a miner written without a shell
 * is refused all the same.
 */
export function guardProgram(language: string, code: string, place: CommandPlace = "cloud-sandbox"): CommandVerdict {
  if (language === "bash" || language === "sh" || language === "shell") return guardCommand(code, place);
  if (code.length > 512 * 1024) return { risk: "block", rule: "too-long", reason: "It is longer than any program this needs." };
  return guardSource(code, place, COMMAND_RULES);
}

/** Source that is not a command line: the pattern rules over all of it, and every string it hands to a shell as a command line. */
function guardSource(code: string, place: CommandPlace, rules: readonly CommandRule[]): CommandVerdict {
  let verdict = OK;
  for (const rule of rules) {
    if (rule.pattern && applies(rule, place) && rule.pattern.test(code)) {
      verdict = worse(verdict, judge(rule));
      if (verdict.risk === "block") return verdict;
    }
  }
  for (const match of code.matchAll(SHELL_OUT)) {
    verdict = worse(verdict, guardCommand(literal(match[1]!), place, rules));
    if (verdict.risk === "block") return verdict;
  }
  return verdict;
}

/** What the model reads when the guard refuses: what happened, and not to look for a way round it. */
export function blockedText(verdict: CommandVerdict, where: string): string {
  return `Alevr's command safety check blocked this before it ran ${where}: ${verdict.reason ?? "it could harm the computer."} Nothing ran. Tell the user what you were trying to do and why it was refused. Do not rewrite the command to get around the check.`;
}

/** What a person reads when the guard refuses (the Run button's output, the activity panel). */
export function blockedNotice(verdict: CommandVerdict): string {
  return `Blocked by Alevr's safety check. ${verdict.reason ?? "It could harm the computer."} Nothing ran.`;
}
