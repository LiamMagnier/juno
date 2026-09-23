import crypto from "node:crypto";
import type { ToolDefinition, ToolExecutionResult } from "@/lib/agent/types";
import { matchAttachment, nameList } from "@/lib/agent/attachment-match";
import type { ToolResultImage } from "@/lib/mcp";
import { wrapUntrusted } from "@/lib/untrusted-content";

/*
 * NO `server-only` AND NO STATIC SANDBOX IMPORT — see the note in
 * `document.ts`. The agent registry builds every tool at module load, so the
 * interpreter, storage and Prisma are all reached through `await import()`
 * inside `execute`.
 */

/**
 * Juno Code Interpreter — the model writes a program against the file.
 *
 * WHY THIS IS THE RIGHT SHAPE, and what it replaces. Juno used to read every
 * upload the moment it arrived: one extractor, chosen by file type, run before
 * anybody had asked anything, whose verdict then stuck for the life of the
 * file. That is the wrong layer for the decision. The question "what is in
 * this file" has no single answer — a spreadsheet wants summing, a scan wants
 * looking at, a log wants grepping, a PDF wants the page the question is
 * about — and none of it can be known before the question exists.
 *
 * So the model gets a Python process and the file, which is what ChatGPT's
 * sandbox and Claude's code execution both do, and it decides. It can open a
 * PDF with pypdf, crop a region with Pillow and look at the result, load a
 * workbook with pandas and compute, or write ten lines of throwaway parsing
 * for a format nobody anticipated. The product stops needing an extractor per
 * format and starts needing a runtime.
 *
 * ── THE SAFETY RULE, WHICH IS NOT NEGOTIABLE ────────────────────────────────
 *
 * This tool runs ONLY against a remote sandbox (`CODE_INTERPRETER_URL` plus a
 * token). `UnifiedCodeInterpreter` will silently fall back to
 * `sandbox/python.ts` — a child process on this host — and `agent/runtime.ts`
 * says of that path, in its own words, that it "is not a tenant isolation
 * boundary and must never be exposed by the hosted toolset". It is right. The
 * code executed here is written by a model reading documents supplied by
 * strangers; running it beside the provider keys, the database credentials and
 * every other tenant's files would turn a prompt injection in a PDF into
 * arbitrary execution on the production VM.
 *
 * So the backend is pinned to `microvm`, and when none is configured the tool
 * is not offered at all (`isCodeInterpreterConfigured`). A missing sandbox
 * costs the model a capability; it never costs it a boundary.
 */

export interface RunCodeParams {
  code: string;
  /** Which attached files to place in the working directory. */
  files?: string[];
  reason?: string;
}

/** Wall clock for one execution. Long enough to parse a big PDF, not a job. */
const TIMEOUT_MS = 120_000;

/** Per-file ceiling on what is copied into the sandbox. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Output that goes back to the model, before it stops being readable. */
const MAX_OUTPUT_CHARS = 30_000;

/**
 * Whether a sandbox exists to run in.
 *
 * Read from the environment rather than probed, because this is called to
 * decide whether to ATTACH the tool — on every turn, before any model has
 * asked for it — and a health check per turn would put a network round trip in
 * front of every message. A configured-but-unreachable sandbox surfaces as a
 * failed call with a real reason, which is the honest place for it.
 */
export function isCodeInterpreterConfigured(): boolean {
  const endpoint = process.env.CODE_INTERPRETER_URL?.trim();
  const token = (process.env.CODE_INTERPRETER_TOKEN || process.env.E2B_API_KEY)?.trim();
  return Boolean(endpoint && token);
}

/**
 * Whether `run_code` may be attached at all (SPEC §3.6 `sandboxConfigured`): a
 * remote sandbox exists AND it is confirmed to have no network egress. The
 * second half is what the tool's `read` classification rests on (DECISIONS
 * §4b), so without it the tool is not offered, never offered-but-asking.
 */
export async function runCodeSandboxReady(): Promise<boolean> {
  if (!isCodeInterpreterConfigured()) return false;
  const { sandboxEgressIsolated } = await import("@/lib/code-interpreter");
  return sandboxEgressIsolated();
}

/**
 * What a run measured, for the tool record (SPEC §3.8.5): files it produced,
 * its exit code, the sandbox's own wall time (the metered quantity) and, for a
 * failed program, the exception class it died with.
 */
export interface RunCodeData {
  files: number;
  exitCode: number;
  /** Sandbox wall time. Absent when the sandbox never ran, which is also when nothing is billed. */
  sandboxMs?: number;
  errorName?: string;
}

/** `ValueError`, `ZeroDivisionError`… from the last traceback line, when there is one. */
export function pythonErrorName(stderr: string | undefined): string | undefined {
  const lines = (stderr ?? "").trim().split("\n").reverse();
  for (const line of lines) {
    const match = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning))\b/.exec(line.trim());
    if (match) return match[1].split(".").pop();
  }
  return undefined;
}

function failure(message: string): ToolExecutionResult<never> {
  return { success: false, error: message, summary: message, stdout: message };
}

export const runCodeTool: ToolDefinition<RunCodeParams, unknown> = {
  // `run_code` since the chat rework; `code_interpreter` is its stored alias
  // (`tools/aliases.ts`, INV-23).
  id: "run_code",
  name: "Run code",
  category: "python",
  description:
    "Run Python in an isolated sandbox, with the files attached to this conversation placed in the working directory under their own names. This is the general way to examine a file: open a PDF with pypdf or pdfplumber and read the pages you need, crop or magnify part of an image with Pillow, load a spreadsheet or CSV with pandas and compute over it, or parse a format nothing else here understands. Anything you print is returned to you, and any image you save — a crop, a chart, a rendered page — is shown back to you so you can read it yourself. Prefer this over guessing at a file's contents.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "The Python to run. Print what you want to see; save images to the working directory to have them shown back to you.",
      },
      files: {
        type: "array",
        items: { type: "string", description: "An attached file's name." },
        description:
          "Attached files to place in the working directory. Omit to include every file attached to this conversation.",
      },
      reason: { type: "string", description: "What you are trying to find out, in a few words." },
    },
    required: ["code"],
  },
  // A read (DECISIONS §4b): a remote sandbox with no network, running on the
  // user's own files. That rests on the isolation being confirmed, which
  // `execute` checks before anything runs and chat checks before attaching it.
  riskClass: "read_only",
  formatPreview: (params) => ({
    title: "Run code",
    detail: params.reason || "Analysing an attached file",
    sensitive: false,
  }),
  execute: async (params, context): Promise<ToolExecutionResult<unknown>> => {
    const code = String(params.code ?? "").trim();
    if (!code) return failure("No code was supplied to run.");
    if (!isCodeInterpreterConfigured()) {
      return failure(
        "The code sandbox is not configured on this server, so Python cannot be run. Use read_document to read an attached file, or inspect_image to look at one.",
      );
    }
    // Checked here as well as at attach time: whatever path reached this tool,
    // model-written code never runs where it could reach the internet.
    const { sandboxEgressIsolated } = await import("@/lib/code-interpreter");
    if (!(await sandboxEgressIsolated())) {
      return failure(
        "The code sandbox's network isolation could not be confirmed, so Python was not run. Use read_document to read an attached file, or inspect_image to look at one.",
      );
    }

    const { conversationAttachments } = await import("@/lib/agent/attachments");
    const attachments = await conversationAttachments({
      userId: context.userId,
      conversationId: context.conversationId,
      projectId: context.projectId,
    });

    // Named files, or all of them. A name that matches nothing is an error
    // rather than a silent omission: code written against a file that is not
    // there fails in a way the model will misread as the file being empty.
    let wanted = attachments;
    if (params.files?.length) {
      wanted = [];
      for (const reference of params.files) {
        const { match, ambiguous } = matchAttachment(attachments, reference);
        if (!match) {
          return failure(
            ambiguous.length > 1
              ? `"${reference}" matches more than one attachment (${nameList(ambiguous)}). Name it exactly.`
              : `No attachment matches "${reference}". Attached: ${nameList(attachments)}.`,
          );
        }
        wanted.push(match);
      }
    }

    const { getObjectBytes } = await import("@/lib/storage");
    const inputFiles: { name: string; content: Buffer }[] = [];
    for (const attachment of wanted.slice(0, 10)) {
      if (attachment.size > MAX_FILE_BYTES) continue;
      try {
        const { bytes } = await getObjectBytes(attachment.storageKey);
        inputFiles.push({ name: attachment.fileName, content: Buffer.from(bytes) });
      } catch {
        // One unreadable object is one missing file, not a failed run.
      }
    }

    if (context.onEvent) {
      await context.onEvent({
        id: crypto.randomUUID(),
        type: "python_execution",
        timestamp: Date.now(),
        title: "Running code",
        detail: params.reason || `${inputFiles.length} file(s) in the working directory`,
        status: "running",
        source: "run_code",
      });
    }

    const { MicroVMSandboxAdapter } = await import("@/lib/code-interpreter");
    let result;
    try {
      // The microVM adapter DIRECTLY, never `UnifiedCodeInterpreter`: that
      // wrapper falls back to a child process on this host, which is the one
      // outcome this tool must never have. See the header.
      result = await new MicroVMSandboxAdapter().execute({
        code,
        language: "python",
        timeoutMs: TIMEOUT_MS,
        inputFiles,
        userId: context.userId,
        sessionId: context.conversationId || context.sessionId,
        signal: context.abortSignal,
      });
    } catch (error) {
      return failure(
        `The code sandbox could not run this: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    /*
     * Images come back as images. A run that crops a region or plots a chart
     * has produced something to LOOK at, and returning a description of it
     * would be this tool answering the question on the model's behalf — the
     * same reason `inspect_image` hands back pixels.
     */
    const images: ToolResultImage[] = [
      ...result.charts.map((chart) => ({
        mimeType: chart.format === "svg" ? "image/svg+xml" : "image/png",
        base64: chart.data,
        label: chart.title || "chart",
      })),
      ...result.generatedFiles
        .filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.mimeType))
        .map((file) => ({ mimeType: file.mimeType, base64: file.dataBase64, label: file.name })),
    ].slice(0, 4);

    const output = [
      result.stdout?.trim() ? result.stdout.trim().slice(0, MAX_OUTPUT_CHARS) : "",
      result.stderr?.trim() ? `stderr:\n${result.stderr.trim().slice(0, 4_000)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    /*
     * What the program printed is enveloped whenever it had attached files to
     * read: the model wrote the code, but a program that prints a document's
     * text prints a stranger's words, and "ignore your instructions" survives
     * a round trip through pandas. Juno's own lines stay outside the envelope.
     */
    const printed = output && inputFiles.length > 0 ? wrapUntrusted("program output", output) : output;
    const body = [
      printed,
      result.success ? "" : `The program exited with ${result.exitCode}. ${result.error ?? ""}`.trim(),
      images.length ? `[${images.length} image(s) from this run follow.]` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const data: RunCodeData = {
      files: result.generatedFiles.length,
      exitCode: result.exitCode,
      sandboxMs: result.durationMs,
      ...(result.success ? {} : { errorName: pythonErrorName(result.stderr) ?? pythonErrorName(result.error) }),
    };

    if (context.onEvent) {
      await context.onEvent({
        id: crypto.randomUUID(),
        type: "python_execution",
        timestamp: Date.now(),
        title: result.success ? "Code finished" : "Code failed",
        detail: `${result.durationMs}ms`,
        status: result.success ? "completed" : "failed",
        source: "run_code",
      });
    }

    return {
      success: result.success,
      summary: result.success
        ? `Ran Python over ${inputFiles.length} file(s) in ${result.durationMs}ms.`
        : `The program failed: ${result.error || result.stderr || "no output"}`,
      stdout: body || "The program produced no output.",
      ...(images.length ? { images } : {}),
      durationMs: result.durationMs,
      data,
    };
  },
};

/** Registry id, so the allowlist and the registration cannot drift apart. */
export const CODE_INTERPRETER_TOOL_ID = runCodeTool.id;
