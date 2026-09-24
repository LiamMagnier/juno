import { normalizeDesignArtifactWithNotes } from "@/lib/design/authoring";
import type { ParsedArtifact } from "@/lib/message-content";

/** One bounded pass is intentional: an artifact check must never become a
 * hidden second generation loop or spend forever trying to make malformed
 * source look valid. */
export const CHAT_ARTIFACT_REPAIR_ATTEMPTS = 1;
export const CHAT_ARTIFACT_MAX_CHARS = 200_000;

export type ChatArtifactProblemCode =
  | "incomplete"
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

/**
 * Something verification changed without it being a problem: today only a
 * picture in a compact design that became a placeholder rectangle, because the
 * compact form cannot carry one (d04065c6). The person should hear about it,
 * on the card, rather than find a grey box and assume Juno broke the design.
 *
 * `detail` quotes the layer's name, which the owner wrote, so a note goes only
 * into the encrypted activity log (Message.activity) and never into a server
 * log line. Mirrors `ClientArtifactVerificationNote` in types/chat.ts.
 */
export interface ChatArtifactNote {
  identifier: string;
  code: "image_placeholder";
  detail: string;
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
  /**
   * Optional so a report persisted before notes existed still decodes. A note
   * never moves `status`: a placeholder is a change the person can undo in the
   * editor, not a failure, and the design is saved either way.
   */
  notes?: ChatArtifactNote[];
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

/**
 * Check one artifact. `notes`, when given, collects what a DESIGN's expansion
 * changed instead of refusing, from the same expansion the size check runs, so
 * the note and the stored body cannot disagree.
 */
function validateArtifact(artifact: ParsedArtifact, notes?: ChatArtifactNote[]): ChatArtifactProblem[] {
  // First, and on its own: an unfinished body is refused whatever it holds.
  // It can pass every check below (a half-written React page is still valid
  // text), and it used to, which is how a stopped revision was saved as
  // current and labelled "verified" (X-07). It is not repairable either:
  // nothing here can write the part that never arrived, and closing the tag
  // for it would only make the loss look finished.
  if (artifact.incomplete) {
    return [
      problem(artifact, "incomplete", "The reply ended before this artifact's closing tag, so it is unfinished.", false),
    ];
  }
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
      // The limit applies to what is stored, and a compact design is stored
      // expanded — five to eleven times larger. Checking only the compact form
      // let a ~40k-character design through as a 260k-character row that every
      // later edit refuses and that installed Mac and iPhone builds cannot load.
      const stored = normalizeDesignArtifactWithNotes(content, artifact.identifier);
      // Every note authoring writes today is an image placeholder
      // (`imagePlaceholder` in design/authoring.ts). A new kind of note needs
      // its own code here before it is counted as a picture.
      for (const detail of stored.notes) {
        notes?.push({ identifier: artifact.identifier, code: "image_placeholder", detail });
      }
      if (stored.content.length > CHAT_ARTIFACT_MAX_CHARS) {
        return [
          problem(
            artifact,
            "too_large",
            `The design expands to ${stored.content.length.toLocaleString()} characters when stored, above the ${CHAT_ARTIFACT_MAX_CHARS.toLocaleString()}-character limit.`,
            false
          ),
        ];
      }
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
    // The same expansion is the storage boundary (artifacts-store.ts).
    // Applying it here makes the presented body and the stored body identical,
    // including for a compact model-authored design that needs expansion. Its
    // notes were already taken on the first pass, from the unexpanded body.
    content = normalizeDesignArtifactWithNotes(content, artifact.identifier).content;
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
        notes: [],
      },
    };
  }

  // Notes come from the first pass, on the bodies as the model wrote them: a
  // repaired DESIGN is already expanded, and a full document has nothing left
  // to note, so the second pass would lose them.
  const initialNotes: ChatArtifactNote[] = [];
  const initialProblems = parsed.flatMap((artifact) => validateArtifact(artifact, initialNotes));
  // Repair is decided per artifact: one whose every problem has a safe fix is
  // repaired, whatever is wrong with the others. It was all or nothing, which
  // cost little while unrepairable problems were rare; a Stop inside the
  // second artifact of a reply now refuses that one as unfinished, and must
  // not also cost the finished first one its missing `</svg>`.
  const repairTargets = new Set(initialProblems.filter((item) => item.repairable).map((item) => item.identifier));
  for (const item of initialProblems) if (!item.repairable) repairTargets.delete(item.identifier);
  let attempts = 0;
  let current = parsed;
  let finalProblems = initialProblems;

  if (repairTargets.size > 0) {
    attempts = 1;
    current = parsed.map((artifact) => {
      if (!repairTargets.has(artifact.identifier)) return artifact;
      return repairArtifact(
        artifact,
        initialProblems.filter((item) => item.identifier === artifact.identifier)
      );
    });
    finalProblems = current.flatMap((artifact) => validateArtifact(artifact));
  }

  const refused = [...new Set(finalProblems.map((item) => item.identifier))];
  const accepted = current.filter((artifact) => !refused.includes(artifact.identifier));
  // What the one pass actually fixed, kept even when another artifact in the
  // same reply was refused, so the receipt says both.
  const repairs = initialProblems.filter(
    (item) => repairTargets.has(item.identifier) && !refused.includes(item.identifier)
  );
  const status = refused.length > 0 ? "refused" : repairs.length > 0 ? "repaired" : "verified";

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
      repairs,
      // Only what was kept: a refused artifact is not saved, so nothing of it
      // became a placeholder.
      notes: initialNotes.filter((note) => !refused.includes(note.identifier)),
    },
  };
}

/** The refused artifacts that were refused only for being unfinished. */
function unfinishedIdentifiers(report: ChatArtifactVerificationReport): string[] {
  return report.refused.filter((identifier) =>
    report.problems.some((item) => item.identifier === identifier && item.code === "incomplete")
  );
}

/**
 * The activity row's title. A stopped or cut-off artifact is not "refused" in
 * any sense a reader would recognise: nothing was wrong with it except that it
 * never finished, and the word reads as the model having made something bad.
 */
export function artifactVerificationTitle(report: ChatArtifactVerificationReport): string {
  if (report.status === "verified") return "Artifact verified";
  if (report.status === "repaired") return "Artifact repaired and verified";
  return unfinishedIdentifiers(report).length === report.refused.length ? "Artifact not saved" : "Artifact refused";
}

/**
 * The line that stands in a message where a refused artifact's block was. An
 * unfinished one says so, rather than "verification failed": the reader
 * pressed Stop, or the reply reached its length limit, and should not be told
 * the model produced something broken.
 */
export function artifactRefusalNotice(report: ChatArtifactVerificationReport, identifier: string): string {
  return unfinishedIdentifiers(report).includes(identifier)
    ? "Artifact not saved: it stopped before it was finished."
    : "Artifact unavailable: verification failed, so it was not saved or presented.";
}

/** " 1 picture became a placeholder." / " 3 pictures became placeholders.", or "". */
function placeholderSentence(report: ChatArtifactVerificationReport): string {
  const count = (report.notes ?? []).filter((note) => note.code === "image_placeholder").length;
  if (count === 0) return "";
  return count === 1 ? " 1 picture became a placeholder." : ` ${count} pictures became placeholders.`;
}

export function artifactVerificationDetail(report: ChatArtifactVerificationReport): string {
  return `${verificationSentence(report)}${placeholderSentence(report)}`;
}

function verificationSentence(report: ChatArtifactVerificationReport): string {
  if (report.status === "verified") return `${report.checked} artifact${report.checked === 1 ? "" : "s"} opened and verified.`;
  if (report.status === "repaired") {
    return `${report.checked} artifact${report.checked === 1 ? "" : "s"} verified after one bounded repair pass.`;
  }
  const unfinished = unfinishedIdentifiers(report).length;
  const otherwise = report.refused.length - unfinished;
  const parts: string[] = [];
  if (unfinished > 0) {
    parts.push(
      unfinished === 1
        ? "1 artifact stopped before it was finished, so it was not saved"
        : `${unfinished} artifacts stopped before they were finished, so they were not saved`
    );
  }
  if (otherwise > 0) {
    parts.push(
      `${otherwise} artifact${otherwise === 1 ? "" : "s"} refused after ${report.attempts} repair attempt${report.attempts === 1 ? "" : "s"}`
    );
  }
  return `${parts.join("; ")}.`;
}
