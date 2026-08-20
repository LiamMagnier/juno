import { normalizeDesignArtifact } from "@/lib/design/authoring";
import type { ParsedArtifact } from "@/lib/message-content";

/** One bounded pass is intentional: an artifact check must never become a
 * hidden second generation loop or spend forever trying to make malformed
 * source look valid. */
export const CHAT_ARTIFACT_REPAIR_ATTEMPTS = 1;
export const CHAT_ARTIFACT_MAX_CHARS = 200_000;

export type ChatArtifactProblemCode =
  | "empty"
  | "too_large"
  | "svg_root_missing"
  | "svg_close_missing"
  | "mermaid_diagram_missing"
  | "design_invalid";

export interface ChatArtifactProblem {
  identifier: string;
  code: ChatArtifactProblemCode;
  detail: string;
  repairable: boolean;
}

export interface ChatArtifactVerificationReport {
  version: 1;
  status: "verified" | "repaired" | "refused";
  attempts: number;
  checked: number;
  accepted: string[];
  refused: string[];
  problems: ChatArtifactProblem[];
  repairs: ChatArtifactProblem[];
}

export interface ChatArtifactVerificationResult {
  artifacts: ParsedArtifact[];
  report: ChatArtifactVerificationReport;
}

export class ChatArtifactVerificationError extends Error {
  readonly report: ChatArtifactVerificationReport;

  constructor(report: ChatArtifactVerificationReport) {
    super("The generated canvas failed verification and was not saved.");
    this.name = "ChatArtifactVerificationError";
    this.report = report;
  }
}

function problem(
  artifact: ParsedArtifact,
  code: ChatArtifactProblemCode,
  detail: string,
  repairable: boolean
): ChatArtifactProblem {
  return { identifier: artifact.identifier, code, detail, repairable };
}

function validateArtifact(artifact: ParsedArtifact): ChatArtifactProblem[] {
  const content = artifact.content.trim();
  if (!content) return [problem(artifact, "empty", "The artifact has no content.", false)];
  if (content.length > CHAT_ARTIFACT_MAX_CHARS) {
    return [
      problem(
        artifact,
        "too_large",
        `The artifact is ${content.length.toLocaleString()} characters, above the ${CHAT_ARTIFACT_MAX_CHARS.toLocaleString()}-character limit.`,
        false
      ),
    ];
  }

  if (artifact.type === "SVG") {
    if (!/<svg\b/i.test(content)) {
      return [problem(artifact, "svg_root_missing", "SVG content has no <svg> root element.", false)];
    }
    if (!/<\/svg>\s*$/i.test(content)) {
      return [problem(artifact, "svg_close_missing", "SVG content is missing its closing </svg> element.", true)];
    }
  }

  if (artifact.type === "MERMAID") {
    const withoutInit = content.replace(/^\s*%%\{[\s\S]*?\}%%\s*/i, "");
    if (!/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph)\b/i.test(withoutInit)) {
      return [problem(artifact, "mermaid_diagram_missing", "Mermaid content has no recognized diagram declaration.", false)];
    }
  }

  if (artifact.type === "DESIGN") {
    try {
      normalizeDesignArtifact(content, artifact.identifier);
    } catch (error) {
      return [
        problem(
          artifact,
          "design_invalid",
          error instanceof Error ? error.message : "The design could not be parsed.",
          false
        ),
      ];
    }
  }

  return [];
}

function repairArtifact(artifact: ParsedArtifact, problems: ChatArtifactProblem[]): ParsedArtifact {
  let content = artifact.content.trim();
  if (artifact.type === "SVG" && problems.some((item) => item.code === "svg_close_missing")) {
    content = `${content}</svg>`;
  }
  if (artifact.type === "DESIGN") {
    // normalizeDesignArtifact is also the storage boundary. Applying it here
    // makes the presented body and the stored body identical, including for a
    // compact model-authored design that needs expansion.
    content = normalizeDesignArtifact(content, artifact.identifier);
  }
  return { ...artifact, content };
}

/**
 * Parse/validate every chat artifact, then run exactly one deterministic repair
 * pass for the small set of failures with an unambiguous safe fix. Unrepairable
 * artifacts are returned as refused so callers can remove them from the
 * presented message while retaining the report in the activity receipt.
 */
export function verifyAndRepairChatArtifacts(parsed: ParsedArtifact[]): ChatArtifactVerificationResult {
  if (parsed.length === 0) {
    return {
      artifacts: [],
      report: {
        version: 1,
        status: "verified",
        attempts: 0,
        checked: 0,
        accepted: [],
        refused: [],
        problems: [],
        repairs: [],
      },
    };
  }

  const initialProblems = parsed.flatMap(validateArtifact);
  const repairable = initialProblems.filter((item) => item.repairable);
  const unrepairable = initialProblems.filter((item) => !item.repairable);
  let attempts = 0;
  let current = parsed;
  let finalProblems = initialProblems;

  if (repairable.length > 0 && unrepairable.length === 0) {
    attempts = 1;
    current = parsed.map((artifact) => {
      const ownProblems = repairable.filter((item) => item.identifier === artifact.identifier);
      return ownProblems.length ? repairArtifact(artifact, ownProblems) : artifact;
    });
    finalProblems = current.flatMap(validateArtifact);
  }

  const refused = [...new Set(finalProblems.map((item) => item.identifier))];
  const accepted = current.filter((artifact) => !refused.includes(artifact.identifier));
  const repaired = attempts > 0 && finalProblems.length === 0;
  const status = refused.length > 0 ? "refused" : repaired ? "repaired" : "verified";

  return {
    artifacts: accepted,
    report: {
      version: 1,
      status,
      attempts,
      checked: parsed.length,
      accepted: [...new Set(accepted.map((artifact) => artifact.identifier))],
      refused,
      problems: finalProblems.length ? finalProblems : initialProblems,
      repairs: repaired ? initialProblems : [],
    },
  };
}

export function artifactVerificationDetail(report: ChatArtifactVerificationReport): string {
  if (report.status === "verified") return `${report.checked} artifact${report.checked === 1 ? "" : "s"} opened and verified.`;
  if (report.status === "repaired") {
    return `${report.checked} artifact${report.checked === 1 ? "" : "s"} verified after one bounded repair pass.`;
  }
  return `${report.refused.length} artifact${report.refused.length === 1 ? "" : "s"} refused after ${report.attempts} repair attempt${report.attempts === 1 ? "" : "s"}.`;
}
