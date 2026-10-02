/**
 * The tool runtime coverage record: which model has PROVEN which tool
 * capability, and which surface has shown a real run from which runtime.
 *
 * TOOL_RUNTIME_DESIGN.md §6.11. The record is
 * `contracts/capabilities/tool-runtime-coverage.json`, reviewed in Git, with
 * no secrets in it. Every current chat model gets a verdict per capability;
 * every surface × runtime cell gets a verdict. A cell nobody has exercised
 * says `untested`, and no model is `compatible` until a live round trip AND a
 * real `run_code` round trip are both `verified`. A catalog flag
 * (`agenticTools`) is a guess and never counts as evidence.
 *
 * Pure: the catalog is passed in, so the probe (tool-contract lane), the
 * acceptance suite and the generator all build, merge and check the same way.
 * `scripts/generate-tool-runtime-coverage.ts` writes the JSON and the tables in
 * docs/rework/TOOL_RUNTIME_COVERAGE.md; the test suite runs the check.
 */

export const COVERAGE_VERSION = 1;
/** The tool round-trip probe version whose evidence counts (§6.11: version 2). */
export const COVERAGE_PROBE_VERSION = 2;

export const COVERAGE_VERDICTS = ["verified", "failed", "untested", "unsupported", "not_applicable"] as const;
export type CoverageVerdict = (typeof COVERAGE_VERDICTS)[number];

export const MODEL_CAPABILITIES = [
  {
    key: "roundTrip",
    summary: "Calls one function with valid JSON arguments, receives the result and states it (probe: multiply(a, b)).",
  },
  { key: "parallel", summary: "Makes two independent calls in one response and handles both results." },
  {
    key: "toolImages",
    summary: "Reads an image returned inside a tool result. Not applicable to a model without vision.",
  },
  {
    key: "runCodeE2E",
    summary: "Runs real Python through run_code in the sandbox, reads the output and answers from it (V1/V2).",
  },
  {
    key: "skillE2E",
    summary: "Finds a skill through use_skill, reads its reference, runs its script and attaches the artifact (V3).",
  },
] as const;
export type ModelCapabilityKey = (typeof MODEL_CAPABILITIES)[number]["key"];

export const COVERAGE_SURFACES = [
  { key: "chat_web", label: "Web chat" },
  { key: "orbit_thread", label: "Orbit agent thread" },
  { key: "orbit_task", label: "Orbit agent task (Work run)" },
  { key: "code_web", label: "Web Code activity" },
  { key: "voice_mode", label: "Voice-mode chat turn" },
  { key: "voice_realtime", label: "Realtime voice call (relay)" },
  { key: "native_macos", label: "macOS ChatKit" },
  { key: "native_ios", label: "iOS ChatKit" },
] as const;
export type CoverageSurface = (typeof COVERAGE_SURFACES)[number]["key"];

export const COVERAGE_RUNTIMES = [
  { key: "hosted_sandbox", label: "Alevr's sandbox (juno-exec)" },
  { key: "agent_computer", label: "An agent's computer" },
  { key: "task_container", label: "The task's container (Cloud Code)" },
  { key: "local_host", label: "Your Mac" },
] as const;
export type CoverageRuntime = (typeof COVERAGE_RUNTIMES)[number]["key"];

/** How far the surface's presentation of a run has been checked, apart from any real run. */
export type PresentationState = "fixture_tested" | "not_built" | "not_applicable";

export interface CoverageCell {
  verdict: CoverageVerdict;
  /** YYYY-MM-DD the verdict was recorded. Required for verified and failed. */
  date?: string;
  /** Probe version that produced it (model cells). */
  probeVersion?: number;
  /** A test name, a probe run id or a ToolRun id. Required for verified, failed and unsupported. */
  evidence?: string;
  note?: string;
}

export interface CoverageModel {
  id: string;
  provider: string;
  adapter: string;
  vision: boolean;
  /** The catalog's guess, shown for context only. Never evidence. */
  catalogAgenticTools: boolean;
  compatible: boolean;
  verdicts: Record<ModelCapabilityKey, CoverageCell>;
}

export interface CoverageMatrixCell extends CoverageCell {
  surface: CoverageSurface;
  runtime: CoverageRuntime;
  presentation: PresentationState;
  presentationEvidence?: string;
}

export interface ToolRuntimeCoverage {
  $comment: string;
  version: number;
  probeVersion: number;
  verdicts: readonly CoverageVerdict[];
  capabilities: { key: ModelCapabilityKey; summary: string }[];
  compatibility: string;
  models: CoverageModel[];
  surfaces: { key: CoverageSurface; label: string }[];
  runtimes: { key: CoverageRuntime; label: string }[];
  matrix: CoverageMatrixCell[];
}

/** What the generator needs from the model catalog. */
export interface CatalogModel {
  id: string;
  provider: string;
  adapter: string;
  vision: boolean;
  agenticTools: boolean;
}

const COMMENT =
  "Tool runtime coverage (TOOL_RUNTIME_DESIGN.md §6.11). Generated and checked by scripts/generate-tool-runtime-coverage.ts from the model catalog; verdict cells are evidence and are carried over between regenerations. untested means nobody has exercised it. No model is compatible until roundTrip and runCodeE2E are both verified by a live run. No secrets.";

const COMPATIBILITY =
  "compatible = roundTrip verified AND runCodeE2E verified (probe version 2 or later). Nothing else, including the catalog's agenticTools flag, makes a model compatible.";

const PRESENTATION_EVIDENCE: Partial<Record<CoverageSurface, string>> = {
  chat_web: "tests/tool-run-presentation.test.ts; /dev/tool-runs (chat rows, run strip, Thought process)",
  orbit_thread: "tests/tool-run-presentation.test.ts (threads use the chat transcript); /dev/tool-runs",
  orbit_task: "tests/tool-run-work-events.test.ts; /dev/tool-runs (Orbit task feed)",
  code_web: "/dev/tool-runs (web Code activity); tests/tool-run-presentation.test.ts",
  voice_mode: "tests/tool-run-speech.test.ts",
  native_macos: "JunoChatKitTests.NativeToolRunTests (decoding, words, snapshots)",
  native_ios: "JunoChatKitTests.NativeToolRunTests (decoding, words, compact snapshots)",
};

/**
 * Which cells exist at all. A surface that never reaches a runtime is
 * `not_applicable`; the realtime relay has no tools and is `unsupported`
 * everywhere, with the test that proves it says so.
 */
function defaultMatrixCell(surface: CoverageSurface, runtime: CoverageRuntime): CoverageMatrixCell {
  const cell = (verdict: CoverageVerdict, presentation: PresentationState, extra: Partial<CoverageMatrixCell> = {}): CoverageMatrixCell => ({
    surface,
    runtime,
    verdict,
    presentation,
    ...(presentation === "fixture_tested" && PRESENTATION_EVIDENCE[surface] ? { presentationEvidence: PRESENTATION_EVIDENCE[surface] } : {}),
    ...extra,
  });
  if (surface === "voice_realtime") {
    return cell("unsupported", "not_applicable", {
      evidence: "relay/tests/voice-tool-limit.test.ts",
      note: "The relay has no tool calls; every call says it cannot run code and that it can be done in the chat.",
    });
  }
  switch (runtime) {
    case "hosted_sandbox":
      if (surface === "code_web") return cell("not_applicable", "not_applicable");
      return cell("untested", "fixture_tested", {
        note: "No execution host or sandbox is configured anywhere yet, so no real run has been shown.",
      });
    case "agent_computer":
      // Computer tools exist only in the Work runner; a thread is a chat turn.
      if (surface === "orbit_task") {
        return cell("untested", "fixture_tested", {
          note: "Agent computers are disabled in production and their broker is not installed.",
        });
      }
      return cell("not_applicable", "not_applicable");
    case "task_container":
      if (surface === "code_web") {
        return cell("untested", "fixture_tested", {
          note: "Cloud Code runs commands in its pinned container; no run_code acceptance run has been recorded here.",
        });
      }
      return cell("not_applicable", "not_applicable");
    case "local_host":
      if (surface === "orbit_task" || surface === "code_web" || surface === "native_macos") {
        return cell("untested", surface === "native_macos" ? "not_built" : "fixture_tested", {
          note: "A local context only; a hosted run never implies access to the Mac.",
        });
      }
      return cell("not_applicable", "not_applicable");
  }
}

function untested(): CoverageCell {
  return { verdict: "untested" };
}

function defaultModelVerdicts(model: CatalogModel): Record<ModelCapabilityKey, CoverageCell> {
  return {
    roundTrip: untested(),
    parallel: untested(),
    toolImages: model.vision ? untested() : { verdict: "not_applicable", note: "No vision." },
    runCodeE2E: untested(),
    skillE2E: untested(),
  };
}

function isCell(value: unknown): value is CoverageCell {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as CoverageCell).verdict === "string" &&
    (COVERAGE_VERDICTS as readonly string[]).includes((value as CoverageCell).verdict)
  );
}

/**
 * The rule, as code: both live round trips verified, each stamped with the
 * probe version that produced it. A verified cell with no version is not
 * evidence of the current probe (an older record, or a hand edit) and does
 * not count: a missing field must never be the thing that makes a model
 * compatible.
 */
export function isCompatible(verdicts: Record<ModelCapabilityKey, CoverageCell>): boolean {
  const ok = (cell: CoverageCell | undefined) =>
    cell?.verdict === "verified" && typeof cell.probeVersion === "number" && cell.probeVersion >= COVERAGE_PROBE_VERSION;
  return ok(verdicts.roundTrip) && ok(verdicts.runCodeE2E);
}

/**
 * Build the record for the current catalog, carrying every recorded verdict
 * over from `previous`. A model that left the catalog leaves the record; a new
 * one arrives untested. Evidence is never invented here.
 */
export function buildCoverage(catalog: readonly CatalogModel[], previous?: ToolRuntimeCoverage | null): ToolRuntimeCoverage {
  const prevModels = new Map((previous?.models ?? []).map((m) => [m.id, m]));
  const models: CoverageModel[] = catalog.map((model) => {
    const prior = prevModels.get(model.id);
    const verdicts = defaultModelVerdicts(model);
    for (const { key } of MODEL_CAPABILITIES) {
      const cell = prior?.verdicts?.[key];
      if (isCell(cell)) {
        // A non-vision model cannot be verified for tool images, whatever an
        // older record said.
        verdicts[key] = key === "toolImages" && !model.vision ? verdicts[key] : cell;
      }
    }
    return {
      id: model.id,
      provider: model.provider,
      adapter: model.adapter,
      vision: model.vision,
      catalogAgenticTools: model.agenticTools,
      compatible: isCompatible(verdicts),
      verdicts,
    };
  });

  const prevMatrix = new Map((previous?.matrix ?? []).map((c) => [`${c.surface}|${c.runtime}`, c]));
  const matrix: CoverageMatrixCell[] = [];
  for (const { key: surface } of COVERAGE_SURFACES) {
    for (const { key: runtime } of COVERAGE_RUNTIMES) {
      const base = defaultMatrixCell(surface, runtime);
      const prior = prevMatrix.get(`${surface}|${runtime}`);
      // A recorded real-run verdict survives regeneration; the structural
      // cells (not applicable, the relay) are always recomputed.
      if (prior && isCell(prior) && base.verdict === "untested" && prior.verdict !== "not_applicable" && prior.verdict !== "unsupported") {
        matrix.push({
          ...base,
          verdict: prior.verdict,
          ...(prior.date ? { date: prior.date } : {}),
          ...(prior.evidence ? { evidence: prior.evidence } : {}),
          ...(prior.note && prior.verdict !== "untested" ? { note: prior.note } : {}),
        });
      } else {
        matrix.push(base);
      }
    }
  }

  return {
    $comment: COMMENT,
    version: COVERAGE_VERSION,
    probeVersion: COVERAGE_PROBE_VERSION,
    verdicts: COVERAGE_VERDICTS,
    capabilities: MODEL_CAPABILITIES.map((c) => ({ key: c.key, summary: c.summary })),
    compatibility: COMPATIBILITY,
    models,
    surfaces: COVERAGE_SURFACES.map((s) => ({ ...s })),
    runtimes: COVERAGE_RUNTIMES.map((r) => ({ ...r })),
    matrix,
  };
}

/**
 * Record one model verdict (the probe and the acceptance suite call this).
 * Verified and failed cells must carry a date and evidence.
 */
export function recordModelVerdict(
  coverage: ToolRuntimeCoverage,
  modelId: string,
  capability: ModelCapabilityKey,
  cell: CoverageCell,
): ToolRuntimeCoverage {
  if ((cell.verdict === "verified" || cell.verdict === "failed") && (!cell.date || !cell.evidence)) {
    throw new Error(`A ${cell.verdict} verdict needs a date and evidence (${modelId} ${capability}).`);
  }
  return {
    ...coverage,
    models: coverage.models.map((model) => {
      if (model.id !== modelId) return model;
      const verdicts = { ...model.verdicts, [capability]: cell };
      return { ...model, verdicts, compatible: isCompatible(verdicts) };
    }),
  };
}

/** Every way the record can be wrong, as sentences. Empty means it holds. */
export function validateCoverage(coverage: ToolRuntimeCoverage, catalog: readonly CatalogModel[]): string[] {
  const problems: string[] = [];
  const ids = new Set(catalog.map((m) => m.id));
  const seen = new Set<string>();
  for (const model of coverage.models) {
    if (!ids.has(model.id)) problems.push(`${model.id} is not a current chat model.`);
    if (seen.has(model.id)) problems.push(`${model.id} appears twice.`);
    seen.add(model.id);
    for (const { key } of MODEL_CAPABILITIES) {
      const cell = model.verdicts?.[key];
      if (!isCell(cell)) {
        problems.push(`${model.id} has no verdict for ${key}.`);
        continue;
      }
      if ((cell.verdict === "verified" || cell.verdict === "failed") && (!cell.date || !cell.evidence)) {
        problems.push(`${model.id} ${key} is ${cell.verdict} without a date and evidence.`);
      }
      if (key === "toolImages" && !model.vision && cell.verdict !== "not_applicable") {
        problems.push(`${model.id} has no vision, so toolImages must be not_applicable.`);
      }
      if (cell.verdict === "unsupported" && !cell.evidence) problems.push(`${model.id} ${key} is unsupported without evidence.`);
      if ((key === "roundTrip" || key === "runCodeE2E") && cell.verdict === "verified" && typeof cell.probeVersion !== "number") {
        problems.push(`${model.id} ${key} is verified without the probe version that produced it.`);
      }
    }
    if (model.compatible !== isCompatible(model.verdicts)) {
      problems.push(
        model.compatible
          ? `${model.id} is marked compatible without verified roundTrip and runCodeE2E evidence.`
          : `${model.id} has the evidence to be compatible but is not marked so.`,
      );
    }
  }
  for (const id of ids) if (!seen.has(id)) problems.push(`${id} is a current chat model with no coverage row.`);

  const cells = new Set<string>();
  for (const cell of coverage.matrix) {
    const where = `${cell.surface} × ${cell.runtime}`;
    cells.add(`${cell.surface}|${cell.runtime}`);
    if (!isCell(cell)) {
      problems.push(`${where} has no verdict.`);
      continue;
    }
    if ((cell.verdict === "verified" || cell.verdict === "failed") && (!cell.date || !cell.evidence)) {
      problems.push(`${where} is ${cell.verdict} without a date and evidence.`);
    }
  }
  for (const { key: surface } of COVERAGE_SURFACES) {
    for (const { key: runtime } of COVERAGE_RUNTIMES) {
      if (!cells.has(`${surface}|${runtime}`)) problems.push(`${surface} × ${runtime} is missing.`);
    }
  }
  return problems;
}

/* ── The Markdown tables ────────────────────────────────────────────────── */

const SHORT: Record<CoverageVerdict, string> = {
  verified: "verified",
  failed: "failed",
  untested: "untested",
  unsupported: "unsupported",
  not_applicable: "n/a",
};

/** The two generated tables for docs/rework/TOOL_RUNTIME_COVERAGE.md. */
export function renderCoverageTables(coverage: ToolRuntimeCoverage): { models: string; matrix: string } {
  const head = `| Model | Adapter | ${MODEL_CAPABILITIES.map((c) => c.key).join(" | ")} | Compatible |`;
  const rule = `|${" --- |".repeat(MODEL_CAPABILITIES.length + 3)}`;
  const rows = coverage.models.map(
    (m) =>
      `| \`${m.id}\` | ${m.adapter} | ${MODEL_CAPABILITIES.map((c) => SHORT[m.verdicts[c.key].verdict]).join(" | ")} | ${m.compatible ? "yes" : "no"} |`,
  );
  const verified = coverage.models.filter((m) => m.compatible).length;
  const summary = `${coverage.models.length} current chat models; ${verified} compatible. Every other cell is untested until a live probe or acceptance run records evidence.`;

  const mHead = `| Surface | ${COVERAGE_RUNTIMES.map((r) => r.label).join(" | ")} |`;
  const mRule = `|${" --- |".repeat(COVERAGE_RUNTIMES.length + 1)}`;
  const mRows = COVERAGE_SURFACES.map((s) => {
    const cells = COVERAGE_RUNTIMES.map((r) => {
      const cell = coverage.matrix.find((c) => c.surface === s.key && c.runtime === r.key);
      if (!cell) return "missing";
      if (cell.verdict === "not_applicable") return "n/a";
      const presentation = cell.presentation === "fixture_tested" ? " (presentation fixture-tested)" : cell.presentation === "not_built" ? " (presentation not built)" : "";
      return `${SHORT[cell.verdict]}${presentation}`;
    });
    return `| ${s.label} | ${cells.join(" | ")} |`;
  });
  return {
    models: [summary, "", head, rule, ...rows].join("\n"),
    matrix: [mHead, mRule, ...mRows].join("\n"),
  };
}

/** Replace the text between `<!-- coverage:NAME:start -->` and `<!-- coverage:NAME:end -->`. */
export function spliceGenerated(doc: string, name: string, body: string): string {
  const start = `<!-- coverage:${name}:start -->`;
  const end = `<!-- coverage:${name}:end -->`;
  const i = doc.indexOf(start);
  const j = doc.indexOf(end);
  if (i === -1 || j === -1 || j < i) throw new Error(`Markers for ${name} are missing in the coverage doc.`);
  return `${doc.slice(0, i + start.length)}\n${body}\n${doc.slice(j)}`;
}
