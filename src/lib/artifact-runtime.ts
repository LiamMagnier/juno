import type { ArtifactType } from "@/lib/message-content";

/**
 * How a given artifact can be executed in the browser sandbox.
 *  - "web"     → rendered live in an iframe (HTML/CSS/SVG/Mermaid/React/JSX).
 *  - "console" → executed headlessly; stdout/stderr/console stream to a terminal
 *                panel (JavaScript, TypeScript, Python via Pyodide).
 *  - "none"    → no in-browser runtime; the code is shown, not run.
 */
export type RunMode = "web" | "console" | "none";

export interface RuntimeInfo {
  mode: RunMode;
  /** Canonical language key (e.g. "tsx", "python", "css"). */
  lang: string;
  /** Human label for chrome ("React", "Python", "TypeScript", "Go"). */
  label: string;
  /** console sub-runtime, when mode === "console". */
  engine?: "js" | "python" | "unsupported";
  /** Verb shown on the action button: "Preview" for web, "Run" for console. */
  runVerb: "Preview" | "Run";
}

// Alias table → canonical language key.
const ALIASES: Record<string, string> = {
  js: "javascript", javascript: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", typescript: "typescript",
  jsx: "jsx", tsx: "tsx", react: "tsx",
  py: "python", python: "python", python3: "python",
  html: "html", htm: "html",
  svg: "svg",
  css: "css",
  mermaid: "mermaid", mmd: "mermaid",
  md: "markdown", markdown: "markdown",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash",
  sql: "sql",
  go: "go", golang: "go",
  rust: "rust", rs: "rust",
  c: "c", "c++": "cpp", cpp: "cpp", cc: "cpp", cxx: "cpp",
  "c#": "csharp", cs: "csharp", csharp: "csharp",
  java: "java", kotlin: "kotlin", kt: "kotlin", swift: "swift",
  ruby: "ruby", rb: "ruby", php: "php", perl: "perl",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
  dockerfile: "dockerfile", makefile: "makefile", ini: "ini", graphql: "graphql",
  vue: "vue", svelte: "svelte", dart: "dart", r: "r", lua: "lua", scala: "scala", elixir: "elixir", haskell: "haskell",
};

const LABELS: Record<string, string> = {
  javascript: "JavaScript", typescript: "TypeScript", jsx: "React", tsx: "React",
  python: "Python", html: "HTML", svg: "SVG", css: "CSS", mermaid: "Mermaid", markdown: "Markdown",
  bash: "Shell", sql: "SQL", go: "Go", rust: "Rust", c: "C", cpp: "C++", csharp: "C#",
  java: "Java", kotlin: "Kotlin", swift: "Swift", ruby: "Ruby", php: "PHP", perl: "Perl",
  json: "JSON", yaml: "YAML", toml: "TOML", xml: "XML", dockerfile: "Dockerfile", makefile: "Makefile",
  ini: "INI", graphql: "GraphQL", vue: "Vue", svelte: "Svelte", dart: "Dart", r: "R", lua: "Lua",
  scala: "Scala", elixir: "Elixir", haskell: "Haskell", plaintext: "Text",
};

export function canonicalLang(raw?: string | null): string {
  const key = (raw ?? "").trim().toLowerCase().replace(/^\.+/, "");
  return ALIASES[key] ?? key ?? "";
}

export function langLabel(lang: string): string {
  return LABELS[lang] ?? (lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : "Text");
}

/**
 * Decide how to run an artifact from its registry type + author-declared
 * language. The `type` is coarse (HTML/REACT/CODE/…); `language` is the fine
 * hint the model attaches to CODE artifacts.
 */
export function runtimeFor(type: ArtifactType, language?: string | null): RuntimeInfo {
  const lang = canonicalLang(language);

  // Registry types with a fixed meaning win first.
  if (type === "REACT") return { mode: "web", lang: "tsx", label: "React", runVerb: "Preview" };
  if (type === "HTML") return { mode: "web", lang: "html", label: "HTML", runVerb: "Preview" };
  if (type === "SVG") return { mode: "web", lang: "svg", label: "SVG", runVerb: "Preview" };
  if (type === "MERMAID") return { mode: "web", lang: "mermaid", label: "Mermaid", runVerb: "Preview" };
  if (type === "MARKDOWN") return { mode: "web", lang: "markdown", label: "Markdown", runVerb: "Preview" };

  // CODE artifacts route by language.
  switch (lang) {
    case "jsx":
    case "tsx":
      return { mode: "web", lang, label: "React", runVerb: "Preview" };
    case "html":
      return { mode: "web", lang, label: "HTML", runVerb: "Preview" };
    case "svg":
      return { mode: "web", lang, label: "SVG", runVerb: "Preview" };
    case "css":
      return { mode: "web", lang, label: "CSS", runVerb: "Preview" };
    case "mermaid":
      return { mode: "web", lang, label: "Mermaid", runVerb: "Preview" };
    case "javascript":
      return { mode: "console", engine: "js", lang, label: "JavaScript", runVerb: "Run" };
    case "typescript":
      return { mode: "console", engine: "js", lang, label: "TypeScript", runVerb: "Run" };
    case "python":
      return { mode: "console", engine: "python", lang, label: "Python", runVerb: "Run" };
    default:
      return { mode: "console", engine: "unsupported", lang: lang || "plaintext", label: langLabel(lang), runVerb: "Run" };
  }
}

export function isRunnable(type: ArtifactType, language?: string | null): boolean {
  return runtimeFor(type, language).mode !== "none";
}
