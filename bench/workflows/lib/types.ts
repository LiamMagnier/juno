/**
 * The real-product workflow benchmark (LEDGER P1-7, master brief Part 14).
 *
 * The eval suite next door (`src/lib/eval/suite.ts`) grades one model call per
 * category. This benchmark grades WORKFLOWS: a fixed request, frozen input
 * files, a declared set of tools, and a deliverable that an independent
 * validator opens and checks. Any product can be run against it — Alevr
 * automatically, a competitor by a person who then imports the outputs — and
 * every product is graded by the same validators.
 *
 * Five states, and nothing else counts as a result:
 *
 *   passed       an executor produced the deliverable, every automated check
 *                passed, and — where the workflow needs human judgement — an
 *                independent reviewer (never the executor) scored it above the
 *                bar against the exact bytes that were checked.
 *   failed       the executor ran and the product errored, timed out, or a
 *                validator rejected the deliverable.
 *   unverified   the deliverable exists but some check could not run here
 *                (no LibreOffice, no network for a liveness check) or the human
 *                review it needs has not happened. Never rounded up to passed.
 *   unsupported  the product does not offer the capability, with dated
 *                evidence. A missing account is not_run, not unsupported.
 *   not_run      nothing ran, and the record says precisely why.
 *
 * Two scopes, reported separately and never added together:
 *
 *   end_to_end        the real product, from the prompt to the deliverable,
 *                     with the model choosing what to do.
 *   offline_pipeline  Alevr's own deterministic code (renderers, extractors,
 *                     the tool dispatcher, the resumable stream, the MCP
 *                     client) driven by a FIXED plan that stands in for the
 *                     model. It proves the product pipeline and the validator
 *                     on real bytes; it says nothing about model quality.
 */

export const BENCH_VERSION = "workflow-bench/1.0.0";

export const BENCH_CATEGORIES = [
  "everyday_chat",
  "reasoning",
  "writing",
  "coding",
  "research",
  "file_analysis",
  "documents",
  "spreadsheets",
  "presentations",
  "connected_tools",
  "agent_execution",
  "failure_recovery",
  "cross_device",
  "multilingual",
] as const;
export type BenchCategory = (typeof BENCH_CATEGORIES)[number];

export const RUN_STATES = ["passed", "failed", "unverified", "unsupported", "not_run"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const SCOPES = ["end_to_end", "offline_pipeline"] as const;
export type BenchScope = (typeof SCOPES)[number];

/** What a workflow needs that this machine may not have. */
export const REQUIREMENTS = [
  "provider_key",
  "network",
  "alevr_deployment",
  "database",
  "connected_account",
  "physical_iphone",
  "mac_host",
  "human_reviewer",
] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

/**
 * A text matcher that survives JSON: a plain string is a case-insensitive
 * substring, `{ regex }` is a JavaScript regular expression.
 */
export type Pattern = string | { regex: string; flags?: string };

export interface ArtifactSpec {
  /** Path under the run's outputs directory. */
  name: string;
  kind: "docx" | "xlsx" | "pptx" | "pdf" | "html" | "markdown" | "json" | "text" | "project";
  /** Accept any one of these names instead (a PDF where HTML was asked, say). */
  alternatives?: string[];
}

export interface RubricCriterion {
  id: string;
  description: string;
  /** Scored 1 (poor) to 5 (excellent); the criterion passes at or above this. */
  passAt: number;
}

// ---------------------------------------------------------------------------
// Validators (data only: implementations live in validators/, and never import
// product code — tests/workflow-bench-validators.test.ts enforces that)
// ---------------------------------------------------------------------------

interface ValidatorBase {
  /** Restrict to one scope. Absent = both. */
  appliesTo?: BenchScope[];
}

export type ValidatorSpec = ValidatorBase &
  (
    | { kind: "artifact"; file: string; minBytes?: number; maxBytes?: number }
    | {
        kind: "text";
        file: string;
        wordCount?: { min?: number; max?: number };
        requireAll?: Pattern[];
        /** Each inner list: at least one must match. */
        requireAny?: Pattern[][];
        forbid?: Pattern[];
        language?: "en" | "fr" | "es" | "de" | "ja";
        /** A script that must appear (e.g. Japanese kana/kanji). */
        scripts?: Array<"japanese" | "arabic" | "latin">;
        bullets?: { min?: number; max?: number };
        firstLineMaxWords?: number;
        finalAnswer?: { regex: string; equals: number | string; tolerance?: number };
      }
    | { kind: "facts"; file: string; expect: Record<string, number | string | boolean>; tolerance?: number }
    | {
        kind: "docx";
        file: string;
        requiredHeadings?: string[];
        requiredText?: Pattern[];
        forbiddenText?: Pattern[];
        minTables?: number;
        minParagraphs?: number;
        /** Exact Unicode strings that must survive (multilingual round-trips). */
        exactText?: string[];
      }
    | {
        kind: "xlsx";
        file: string;
        /** A formula cell whose value (cached, and after recalculation when available) equals this. */
        formulaValues?: Array<{ value: number; tolerance?: number }>;
        /** A row where one cell matches the label and another numeric cell equals the value. */
        labelValues?: Array<{ label: Pattern; value: number; tolerance?: number }>;
        /** Each appears at least once in the workbook and at most once per sheet. */
        uniqueTexts?: string[];
        /** Numeric-looking text cells (outside headers) are a failure. */
        numbersNotText?: boolean;
        requireChart?: boolean;
        exactText?: string[];
      }
    | {
        kind: "pptx";
        file: string;
        slides?: { min?: number; max?: number };
        requiredText?: Pattern[];
        exactText?: string[];
        maxWordsPerSlide?: number;
        requireChart?: boolean;
        requireTable?: boolean;
      }
    | { kind: "pdf"; file: string; pages?: { min?: number; max?: number }; requiredText?: Pattern[] }
    | {
        kind: "html";
        file: string;
        requiredHeadings?: string[];
        requiredText?: Pattern[];
        forbid?: Pattern[];
        /** Literal escaped forms that must appear (proves hostile input was escaped). */
        requireEscaped?: string[];
        printStylesheet?: boolean;
      }
    | {
        kind: "office_reopen";
        file: string;
        format: "docx" | "xlsx" | "pptx";
        /** Pages of the rendered PDF (docx/pptx). */
        pages?: { min?: number; max?: number };
        /** Values that must be present after LibreOffice recalculates every formula (xlsx). */
        recalcValues?: number[];
      }
    | {
        kind: "citations";
        file: string;
        /** Fixture paths a citation may name; the bracketed name is the basename. */
        sources: string[];
        minCitations: number;
        /** Distinct sources that must be cited at least once. */
        minDistinctSources?: number;
        /** Quoted spans ("…") followed by a citation must appear verbatim in that source. */
        verifyQuotes?: boolean;
        minVerifiedQuotes?: number;
      }
    | {
        kind: "web_citations";
        file: string;
        minUrls: number;
        allowedDomains: string[];
        requireAccessDate?: boolean;
        /** HEAD/GET each URL. Needs network; not_run (so unverified) offline. */
        checkLiveness?: boolean;
      }
    | {
        kind: "code_tests";
        /** Directory under outputs holding the final project tree. */
        projectDir: string;
        /** Fixture directory the project started from (for protected-file checks). */
        fixtureProject: string;
        /** Held-out test file under bench/workflows/hidden/, copied in at validation time. */
        hiddenTests: string;
        /** Files that must be byte-identical to the fixture (no weakening the visible tests). */
        protectedFiles: string[];
        timeoutMs?: number;
      }
    | { kind: "extraction"; file: string; expect: Array<{ text: string; sheet?: string; cellRange?: string; page?: number; heading?: string }> }
    | { kind: "constraints"; file: string; puzzle: "meetings-v1" }
    | { kind: "trace"; file: string; checker: TraceChecker; params?: Record<string, unknown> }
    | { kind: "wire_contract"; file: string; schema: string; def: string }
    | { kind: "rubric"; criteria: RubricCriterion[] }
    | { kind: "one_of"; label: string; options: ValidatorSpec[][] }
  );

export type ValidatorKind = ValidatorSpec["kind"];

export const TRACE_CHECKERS = [
  "mcp-tool-call",
  "ssrf-refusal",
  "tool-batch-authorization",
  "stop-mid-tool",
  "stream-resume",
  "second-device",
  "stall-detect",
  "injection-envelope",
  "calc-exact",
] as const;
export type TraceChecker = (typeof TRACE_CHECKERS)[number];

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export interface WorkflowSpec {
  /** Stable id: `<category-prefix>-NN`. */
  id: string;
  category: BenchCategory;
  title: string;
  /** The exact request every product is given. */
  prompt: string;
  /** Frozen input files, paths under bench/workflows/fixtures/. */
  inputs: string[];
  /** The tool vocabulary the product may use (see PERMITTED_TOOLS). */
  permittedTools: string[];
  requiredArtifacts: ArtifactSpec[];
  limits: { timeMinutes: number; budgetUsd: number };
  validators: ValidatorSpec[];
  /** What end-to-end execution needs beyond this harness. */
  requires: Requirement[];
  /**
   * Present when Alevr has a deterministic product path this harness can drive
   * with a fixed plan. The description says exactly what is exercised and what
   * the fixed plan stands in for.
   */
  offline?: {
    plan: string;
    exercises: string;
    standsInFor: string;
    /** What the offline plan delivers (its own artifacts, e.g. a trace instead of an answer). */
    deliverables: string[];
  };
}

export const PERMITTED_TOOLS = {
  none: "No tools: answer from the prompt alone.",
  file_read: "Read the attached input files.",
  file_write: "Create the requested output files.",
  web_search: "Search the public web.",
  web_fetch: "Fetch public web pages.",
  code_execution: "Run code in the product's sandbox.",
  calculator: "Exact arithmetic tool.",
  document_export: "Export Word/Excel/PowerPoint/PDF files.",
  connector: "Call a connected app or MCP server the run was granted.",
  background_task: "Run as a background/agent task.",
  remote_device: "Act on a paired device (phone to Mac).",
} as const;
export type PermittedTool = keyof typeof PERMITTED_TOOLS;

// ---------------------------------------------------------------------------
// Validation results
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "not_run";

export interface CheckResult {
  /** `<validator kind>:<what>` — stable across runs so reports can diff. */
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface ReviewRecord {
  reviewer: string;
  reviewedAt: string;
  /** The executor identity the reviewer declares they are not. */
  executorIdentity: string;
  /** SHA-256 of every artifact the reviewer opened, by name. */
  artifactHashes: Record<string, string>;
  scores: Record<string, number>;
  notes?: string;
  /** Product/model labels hidden from the reviewer. */
  blind?: boolean;
}

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

export interface ProductInfo {
  /** "alevr", "chatgpt", "claude", "gemini", "perplexity", "grok", … */
  id: string;
  name: string;
  /** Product build: for Alevr the package version plus git commit. */
  version: string | null;
  /** Where it ran: "offline-harness", "web", "mac", "ios", "api". */
  surface: string;
}

export type CostSource =
  | "measured_usage"
  | "reported_by_executor"
  | "offline_no_provider_calls"
  | "unobserved";

export interface AttemptRecord {
  n: number;
  startedAt: string;
  durationMs: number;
  /** What the executor said happened, before validation. */
  outcome: "completed" | "errored" | "timeout";
  /** Final state of this attempt after validation. */
  state: RunState;
  error?: string;
}

export interface ArtifactRecord {
  name: string;
  bytes: number;
  sha256: string;
}

export interface RunRecord {
  runId: string;
  workflowId: string;
  category: BenchCategory;
  scope: BenchScope;
  product: ProductInfo;
  model: string | null;
  settings: Record<string, unknown>;
  executor: { id: string; identity: string; kind: "automated" | "human" };
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  cost: { usd: number | null; source: CostSource; inputTokens?: number | null; outputTokens?: number | null };
  attempts: AttemptRecord[];
  state: RunState;
  /** One sentence a person can act on. Always set for anything but passed. */
  reason: string;
  /** True only when attempt 1 itself passed. Null when nothing was attempted. */
  firstAttemptPassed: boolean | null;
  artifacts: ArtifactRecord[];
  checks: CheckResult[];
  review: ReviewRecord | null;
  /** For unsupported: the dated evidence. */
  unsupportedEvidence?: { source: string; accessedAt: string; note: string } | null;
  /** Where the run's files are, relative to the results file. */
  runDir: string | null;
}

export interface BenchEnvironment {
  node: string;
  platform: string;
  /** Configured provider ids (names only, never keys). */
  providersConfigured: string[];
  libreoffice: string | null;
  network: boolean;
  gitCommit: string | null;
  gitDirty: boolean | null;
  fixturesDigest: string;
}

export interface BenchResults {
  benchVersion: string;
  runId: string;
  createdAt: string;
  environment: BenchEnvironment;
  workflowCount: number;
  records: RunRecord[];
}
