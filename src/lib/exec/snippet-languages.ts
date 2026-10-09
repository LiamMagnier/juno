/**
 * Which languages a chat code block can run, and where (owner, 2026-10-09:
 * "every language"). Pure, so the browser decides which button to show and the
 * server builds the program from the same table (src/lib/exec/snippets.ts).
 */

/** Languages the reader's browser runs itself, in the sandbox frame. */
const BROWSER_LANGUAGES: Record<string, string> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  ts: "typescript",
  typescript: "typescript",
  py: "python",
  python: "python",
  python3: "python",
  sql: "sql",
  plsql: "sql",
  pgsql: "sql",
  mysql: "sql",
  sqlite: "sql",
};

export type RunTarget = { where: "browser"; language: string; label: string } | { where: "server"; language: string; label: string };

const BROWSER_LABELS: Record<string, string> = { javascript: "JavaScript", typescript: "TypeScript", python: "Python", sql: "SQL" };

export function runTargetFor(lang: string): RunTarget | null {
  const key = lang.trim().toLowerCase();
  const browser = BROWSER_LANGUAGES[key];
  if (browser) return { where: "browser", language: browser, label: BROWSER_LABELS[browser] };
  const server = serverSnippetLanguage(key);
  return server ? { where: "server", language: server, label: snippetLabel(server) } : null;
}

export interface SnippetLanguage {
  label: string;
  file: string;
  /** Shell lines run in /tmp/snippet after the source is written. */
  run: string;
}

export const SNIPPET_LANGUAGES: Record<string, SnippetLanguage> = {
  c: { label: "C", file: "main.c", run: "gcc -O2 -std=c17 -Wall main.c -o main -lm && ./main" },
  cpp: { label: "C++", file: "main.cpp", run: "g++ -O2 -std=c++20 -Wall main.cpp -o main && ./main" },
  java: { label: "Java", file: "Main.java", run: "java Main.java" },
  go: { label: "Go", file: "main.go", run: "GOCACHE=/tmp/.cache/go GOPATH=/tmp/go GO111MODULE=off go run main.go" },
  rust: { label: "Rust", file: "main.rs", run: "rustc -O --edition 2021 main.rs -o main && ./main" },
  ruby: { label: "Ruby", file: "main.rb", run: "ruby main.rb" },
  php: { label: "PHP", file: "main.php", run: "php main.php" },
  lua: { label: "Lua", file: "main.lua", run: "lua5.4 main.lua" },
  perl: { label: "Perl", file: "main.pl", run: "perl main.pl" },
  bash: { label: "Bash", file: "main.sh", run: "bash main.sh" },
};

/** Fence names people and models write, mapped to one language. */
const ALIASES: Record<string, string> = {
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "c",
  golang: "go",
  rs: "rust",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  pl: "perl",
};

/** The canonical server language for a fence name, or null when the server does not run it. */
export function serverSnippetLanguage(lang: string): string | null {
  const key = lang.trim().toLowerCase();
  const canonical = ALIASES[key] ?? key;
  return SNIPPET_LANGUAGES[canonical] ? canonical : null;
}

export function snippetLabel(language: string): string {
  return SNIPPET_LANGUAGES[language]?.label ?? language;
}

