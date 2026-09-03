/**
 * Server-Side Sandboxed Code Interpreter Adapter
 *
 * Provides isolated, high-performance execution of data science scripts,
 * simulations, and heavy Python workloads beyond the browser's Pyodide WASM runtime.
 *
 * Supports both containerized/microVM execution (E2B / Firecracker / remote sandbox)
 * and hardened local isolated subprocess execution with resource caps and figure interception.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "@/lib/agent/types";
import { executePythonSandbox, type PythonExecutionResult } from "@/lib/sandbox/python";

export type CodeInterpreterLanguage = "python" | "bash" | "javascript" | "r";

export interface CodeInterpreterInputFile {
  name: string;
  content: Buffer | string;
  mimeType?: string;
}

export interface CodeInterpreterGeneratedFile {
  name: string;
  dataBase64: string;
  sizeBytes: number;
  mimeType: string;
}

export interface CodeInterpreterChart {
  format: "png" | "svg";
  data: string; // Base64 PNG or SVG XML
  title?: string;
}

export interface CodeInterpreterTable {
  name?: string;
  columns: string[];
  data: Array<Record<string, unknown>>;
  rowCount: number;
  columnCount: number;
  dtypes?: Record<string, string>;
}

export interface CodeInterpreterResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  backend: "microvm" | "container" | "local_isolated";
  tables: CodeInterpreterTable[];
  charts: CodeInterpreterChart[];
  generatedFiles: CodeInterpreterGeneratedFile[];
  error?: string;
}

export interface CodeInterpreterOptions {
  code: string;
  language?: CodeInterpreterLanguage;
  timeoutMs?: number;
  memoryLimitMb?: number;
  cpuCores?: number;
  env?: Record<string, string>;
  inputFiles?: CodeInterpreterInputFile[];
  userId?: string;
  sessionId?: string;
  preferredBackend?: "auto" | "microvm" | "container" | "local_isolated";
}

export interface CodeInterpreterBackend {
  readonly name: "microvm" | "container" | "local_isolated";
  isAvailable(): Promise<boolean>;
  execute(options: CodeInterpreterOptions): Promise<CodeInterpreterResult>;
}

/**
 * Hardened local isolated execution backend.
 * Runs in scrubbed subprocess with process-level isolation and figure interception.
 */
export class LocalIsolatedSandboxAdapter implements CodeInterpreterBackend {
  readonly name = "local_isolated" as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(options: CodeInterpreterOptions): Promise<CodeInterpreterResult> {
    const startTime = Date.now();
    const sessionId = options.sessionId || `session_${Date.now()}`;
    const userScope = options.userId?.replace(/[^a-zA-Z0-9_-]/g, "") || "local-user";
    const workspaceDir = path.join(os.tmpdir(), "juno-sandbox-workspaces", userScope, sessionId);

    await fs.mkdir(workspaceDir, { recursive: true });

    try {
      const pythonResult: PythonExecutionResult = await executePythonSandbox({
        code: options.code,
        userId: options.userId,
        sessionId,
        timeoutMs: options.timeoutMs ?? 60_000,
        workingDirectory: workspaceDir,
        env: options.env,
        inputFiles: options.inputFiles?.map((f) => ({
          name: f.name,
          content: f.content,
        })),
      });

      // Discover any new output files created in the workspace (excluding script files and provided inputs)
      const inputNames = new Set(options.inputFiles?.map((f) => f.name) ?? []);
      const generatedFiles: CodeInterpreterGeneratedFile[] = [];
      try {
        const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.isFile() &&
            !entry.name.startsWith("run_") &&
            !entry.name.endsWith(".py") &&
            !inputNames.has(entry.name)
          ) {
            const filePath = path.join(workspaceDir, entry.name);
            const stat = await fs.stat(filePath);
            if (stat.size <= 25 * 1024 * 1024) {
              const fileData = await fs.readFile(filePath);
              generatedFiles.push({
                name: entry.name,
                dataBase64: fileData.toString("base64"),
                sizeBytes: stat.size,
                mimeType: guessMimeType(entry.name),
              });
            }
          }
        }
      } catch (err) {
        console.warn("[code-interpreter] error scanning workspace files:", err);
      }

      return {
        success: pythonResult.success,
        stdout: pythonResult.stdout,
        stderr: pythonResult.stderr,
        exitCode: pythonResult.exitCode,
        durationMs: pythonResult.durationMs,
        backend: "local_isolated",
        tables: (pythonResult.tables || []).map((t) => ({
          columns: t.columns,
          data: t.data,
          rowCount: t.rowCount,
          columnCount: t.columnCount,
          dtypes: t.dtypes,
        })),
        charts: (pythonResult.charts || []).map((c) => ({
          format: c.format,
          data: c.data,
          title: c.title,
        })),
        generatedFiles,
        error: pythonResult.error,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        stdout: "",
        stderr: errorMsg,
        exitCode: 1,
        durationMs,
        backend: "local_isolated",
        tables: [],
        charts: [],
        generatedFiles: [],
        error: errorMsg,
      };
    }
  }
}

/**
 * MicroVM / Container execution backend.
 * Interacts with remote microVM service (E2B / Modal / Firecracker container daemon)
 * when configured via CODE_INTERPRETER_URL and CODE_INTERPRETER_TOKEN.
 */
export class MicroVMSandboxAdapter implements CodeInterpreterBackend {
  readonly name = "microvm" as const;

  private endpoint: string | null;
  private token: string | null;

  constructor(endpoint?: string, token?: string) {
    this.endpoint = endpoint ?? process.env.CODE_INTERPRETER_URL ?? null;
    this.token = token ?? process.env.CODE_INTERPRETER_TOKEN ?? process.env.E2B_API_KEY ?? null;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.endpoint || !this.token) return false;
    try {
      const res = await fetch(`${this.endpoint}/health`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async execute(options: CodeInterpreterOptions): Promise<CodeInterpreterResult> {
    if (!this.endpoint || !this.token) {
      throw new Error("MicroVM backend is not configured (missing CODE_INTERPRETER_URL / TOKEN).");
    }

    const startTime = Date.now();
    const payload = {
      code: options.code,
      language: options.language || "python",
      timeoutMs: options.timeoutMs ?? 120_000,
      memoryLimitMb: options.memoryLimitMb ?? 2048,
      env: options.env,
      files: options.inputFiles?.map((f) => ({
        name: f.name,
        contentBase64: Buffer.isBuffer(f.content)
          ? f.content.toString("base64")
          : Buffer.from(f.content).toString("base64"),
      })),
    };

    const res = await fetch(`${this.endpoint}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout((options.timeoutMs ?? 120_000) + 10_000),
    });

    if (!res.ok) {
      throw new Error(`MicroVM runner returned HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      success: boolean;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      durationMs?: number;
      tables?: CodeInterpreterTable[];
      charts?: CodeInterpreterChart[];
      files?: Array<{ name: string; contentBase64: string; sizeBytes?: number; mimeType?: string }>;
      error?: string;
    };

    return {
      success: data.success ?? false,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      exitCode: data.exitCode ?? (data.success ? 0 : 1),
      durationMs: data.durationMs ?? (Date.now() - startTime),
      backend: "microvm",
      tables: data.tables ?? [],
      charts: data.charts ?? [],
      generatedFiles: (data.files || []).map((f) => ({
        name: f.name,
        dataBase64: f.contentBase64,
        sizeBytes: f.sizeBytes ?? Buffer.from(f.contentBase64, "base64").length,
        mimeType: f.mimeType ?? guessMimeType(f.name),
      })),
      error: data.error,
    };
  }
}

/**
 * Unified Code Interpreter Adapter with automatic routing and resilient fallback.
 */
export class UnifiedCodeInterpreter {
  private localAdapter = new LocalIsolatedSandboxAdapter();
  private microvmAdapter = new MicroVMSandboxAdapter();

  async execute(options: CodeInterpreterOptions): Promise<CodeInterpreterResult> {
    const preference = options.preferredBackend || "auto";

    if (preference === "microvm" || (preference === "auto" && (await this.microvmAdapter.isAvailable()))) {
      try {
        return await this.microvmAdapter.execute(options);
      } catch (err) {
        console.warn("[code-interpreter] microVM execution failed, falling back to local sandbox:", err);
      }
    }

    return await this.localAdapter.execute(options);
  }
}

export const codeInterpreter = new UnifiedCodeInterpreter();

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".txt":
    default:
      return "text/plain";
  }
}

export const codeInterpreterTool: ToolDefinition = {
  id: "code_interpreter",
  name: "code_interpreter",
  category: "python",
  description:
    "Executes Python code in a secure, isolated sandbox or microVM container. Supports pandas, numpy, matplotlib, data analytics, chart generation, and file manipulation.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "The Python code snippet to execute in the isolated sandbox.",
      },
      reason: {
        type: "string",
        description: "The intended analysis or calculation purpose.",
      },
    },
    required: ["code"],
  },
  riskClass: "destructive_or_sensitive",
  formatPreview: (params) => ({
    title: "Code Interpreter",
    detail: (params.reason as string) || "Executing isolated Python analysis",
    sensitive: false,
  }),
  execute: async (params, context) => {
    const result = await codeInterpreter.execute({
      code: String(params.code || ""),
      userId: context.userId,
      sessionId: context.conversationId || context.sessionId,
      env: context.env,
    });

    const summary = result.success
      ? `Python code executed successfully in ${result.durationMs}ms.`
      : `Execution failed: ${result.error || result.stderr}`;

    return {
      success: result.success,
      output: result.stdout || result.stderr || summary,
      result,
    };
  },
};

