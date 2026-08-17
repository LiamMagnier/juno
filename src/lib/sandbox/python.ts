/**
 * Juno First-Class Python & Data Analysis Sandbox
 *
 * Provides safe, isolated, per-conversation Python execution for data analysis,
 * calculations, simulations, file conversions, and chart generation.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { ToolDefinition, AgentExecutionContext, ToolExecutionResult, AgentOutputArtifact } from "@/lib/agent/types";

export interface PythonExecutionOptions {
  code: string;
  timeoutMs?: number;
  workingDirectory?: string;
  env?: Record<string, string>;
  inputFiles?: Array<{ name: string; content: Buffer | string }>;
}

export interface StructuredDataFrame {
  columns: string[];
  data: Array<Record<string, unknown>>;
  rowCount: number;
  columnCount: number;
  dtypes?: Record<string, string>;
}

export interface PythonExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  tables?: StructuredDataFrame[];
  charts?: Array<{ format: "svg" | "png"; data: string; title?: string }>;
  generatedFiles?: Array<{ name: string; path: string; sizeBytes: number; mimeType?: string }>;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Runner wrapper script injected to intercept matplotlib figures and pandas DataFrames
 */
const PYTHON_HARNESS = `
import sys
import os
import json
import io
import base64

_juno_tables = []
_juno_charts = []

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    def _juno_save_figures():
        for i in plt.get_fignums():
            fig = plt.figure(i)
            buf = io.BytesIO()
            fig.savefig(buf, format='png', bbox_inches='tight', dpi=150)
            buf.seek(0)
            b64 = base64.b64encode(buf.read()).decode('utf-8')
            _juno_charts.append({'format': 'png', 'data': b64})
            plt.close(fig)
except ImportError:
    def _juno_save_figures():
        pass

def juno_display_table(df, name=None):
    try:
        import pandas as pd
        if isinstance(df, pd.DataFrame):
            records = df.head(100).to_dict(orient='records')
            dtypes = {col: str(dtype) for col, dtype in df.dtypes.items()}
            _juno_tables.append({
                'columns': list(df.columns),
                'data': records,
                'rowCount': len(df),
                'columnCount': len(df.columns),
                'dtypes': dtypes,
                'name': name
            })
    except Exception as e:
        sys.stderr.write(f"Error extracting table: {e}\\n")

# Execute user code
_juno_user_globals = {
    'display_table': juno_display_table,
    'juno_tables': _juno_tables,
    'juno_charts': _juno_charts,
}

`;

/**
 * Execute Python code in an isolated temporary session workspace
 */
export async function executePythonSandbox(
  options: PythonExecutionOptions
): Promise<PythonExecutionResult> {
  const startTime = Date.now();
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sessionId = crypto.randomUUID();
  const tempDir = options.workingDirectory ?? path.join(os.tmpdir(), `juno-py-${sessionId}`);

  await fs.mkdir(tempDir, { recursive: true });

  try {
    // Write input files if provided
    if (options.inputFiles && options.inputFiles.length > 0) {
      for (const file of options.inputFiles) {
        const filePath = path.join(tempDir, file.name);
        await fs.writeFile(filePath, file.content);
      }
    }

    // Build the script file
    const runnerScript = `
${PYTHON_HARNESS}

# --- USER SCRIPT START ---
${options.code}
# --- USER SCRIPT END ---

_juno_save_figures()

# Output metadata marker
print("__JUNO_DATA_START__")
print(json.dumps({
    "tables": _juno_tables,
    "charts": _juno_charts
}))
print("__JUNO_DATA_END__")
`;

    const scriptPath = path.join(tempDir, `run_${sessionId}.py`);
    await fs.writeFile(scriptPath, runnerScript, "utf8");

    // Execute with python3
    const pythonBin = process.env.PYTHON_PATH || "python3";
    
    return await new Promise<PythonExecutionResult>((resolve) => {
      const child = spawn(pythonBin, [scriptPath], {
        cwd: tempDir,
        env: {
          ...process.env,
          ...options.env,
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONUNBUFFERED: "1",
        },
        timeout,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalStdoutBytes = 0;
      let totalStderrBytes = 0;
      let killed = false;

      child.stdout.on("data", (chunk: Buffer) => {
        if (totalStdoutBytes < MAX_OUTPUT_BYTES) {
          stdoutChunks.push(chunk);
          totalStdoutBytes += chunk.length;
        } else if (!killed) {
          child.kill("SIGTERM");
          killed = true;
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (totalStderrBytes < MAX_OUTPUT_BYTES) {
          stderrChunks.push(chunk);
          totalStderrBytes += chunk.length;
        }
      });

      const timer = setTimeout(() => {
        if (!killed) {
          child.kill("SIGKILL");
          killed = true;
        }
      }, timeout);

      child.on("error", (err) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        resolve({
          success: false,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: `Failed to execute python: ${err.message}`,
          exitCode: 1,
          durationMs,
          error: err.message,
        });
      });

      child.on("close", async (exitCode) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
        const rawStderr = Buffer.concat(stderrChunks).toString("utf8");

        let cleanStdout = rawStdout;
        let tables: StructuredDataFrame[] = [];
        let charts: Array<{ format: "svg" | "png"; data: string; title?: string }> = [];

        const markerStart = rawStdout.indexOf("__JUNO_DATA_START__\n");
        const markerEnd = rawStdout.indexOf("\n__JUNO_DATA_END__");

        if (markerStart !== -1 && markerEnd !== -1) {
          cleanStdout = rawStdout.slice(0, markerStart) + rawStdout.slice(markerEnd + "\n__JUNO_DATA_END__".length);
          const dataJson = rawStdout.slice(markerStart + "__JUNO_DATA_START__\n".length, markerEnd);
          try {
            const parsed = JSON.parse(dataJson);
            if (Array.isArray(parsed.tables)) tables = parsed.tables;
            if (Array.isArray(parsed.charts)) charts = parsed.charts;
          } catch {
            // Ignore parse errors from metadata
          }
        }

        // Identify generated output files in the directory
        const generatedFiles: Array<{ name: string; path: string; sizeBytes: number; mimeType?: string }> = [];
        try {
          const entries = await fs.readdir(tempDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && !entry.name.startsWith("run_") && !entry.name.endsWith(".py")) {
              const filePath = path.join(tempDir, entry.name);
              const stats = await fs.stat(filePath);
              generatedFiles.push({
                name: entry.name,
                path: filePath,
                sizeBytes: stats.size,
                mimeType: getMimeType(entry.name),
              });
            }
          }
        } catch {
          // ignore scan error
        }

        resolve({
          success: exitCode === 0,
          stdout: cleanStdout.trim(),
          stderr: rawStderr.trim(),
          exitCode: exitCode ?? 0,
          durationMs,
          tables,
          charts,
          generatedFiles,
          error: exitCode !== 0 ? (rawStderr.trim() || `Process exited with code ${exitCode}`) : undefined,
        });
      });
    });
  } finally {
    // If not custom working directory, schedule cleanup
    if (!options.workingDirectory) {
      setTimeout(async () => {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }, 60000);
    }
  }
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".csv": return "text/csv";
    case ".json": return "application/json";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

/**
 * Standard Python Tool definition for the Unified Agent Runtime
 */
export const pythonTool: ToolDefinition<{ code: string; reason?: string }, PythonExecutionResult> = {
  id: "python_interpreter",
  name: "Python Data Analysis Sandbox",
  category: "python",
  description:
    "Execute Python code in a secure sandbox for data analysis, calculations, data transformations, charts (matplotlib), spreadsheets (pandas/openpyxl), and statistics.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "The complete Python code to execute. Can use pandas, numpy, matplotlib.pyplot, scipy, openpyxl, sqlite3, json, math, etc.",
      },
      reason: {
        type: "string",
        description: "Brief rationale of what is being computed or analyzed.",
      },
    },
    required: ["code"],
  },
  riskClass: "read_only", // Sandbox execution is self-contained with no external system mutation
  formatPreview: (params) => ({
    title: "Python Data Analysis",
    detail: params.reason || "Executing Python script",
    sensitive: false,
  }),
  execute: async (params, context: AgentExecutionContext): Promise<ToolExecutionResult<PythonExecutionResult>> => {
    if (context.onEvent) {
      await context.onEvent({
        id: crypto.randomUUID(),
        type: "python_execution",
        timestamp: Date.now(),
        title: "Executing Python",
        detail: params.reason || "Running data analysis code in sandbox",
        status: "running",
        source: "python_interpreter",
        data: { code: params.code },
      });
    }

    const result = await executePythonSandbox({
      code: params.code,
      workingDirectory: context.workingDirectory,
      env: context.env,
    });

    const artifacts: AgentOutputArtifact[] = [];

    // Convert charts to output artifacts
    if (result.charts) {
      for (let i = 0; i < result.charts.length; i++) {
        const chart = result.charts[i];
        artifacts.push({
          id: `chart-${Date.now()}-${i}`,
          type: "chart",
          title: chart.title || `Figure ${i + 1}`,
          mimeType: chart.format === "svg" ? "image/svg+xml" : "image/png",
          content: chart.data,
          metadata: { format: chart.format },
        });
      }
    }

    // Convert tables to output artifacts
    if (result.tables) {
      for (let i = 0; i < result.tables.length; i++) {
        const table = result.tables[i];
        artifacts.push({
          id: `table-${Date.now()}-${i}`,
          type: "table",
          title: `Data Table (${table.rowCount} rows)`,
          data: table,
        });
      }
    }

    // Convert generated files
    if (result.generatedFiles) {
      for (const file of result.generatedFiles) {
        artifacts.push({
          id: `file-${Date.now()}-${file.name}`,
          type: "file",
          title: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          downloadUrl: `/api/files/sandbox/${file.name}`,
        });
      }
    }

    const summary = result.success
      ? `Python executed successfully in ${result.durationMs}ms.`
      : `Python execution failed: ${result.error || result.stderr}`;

    if (context.onEvent) {
      await context.onEvent({
        id: crypto.randomUUID(),
        type: "python_execution",
        timestamp: Date.now(),
        title: result.success ? "Python Complete" : "Python Failed",
        detail: summary,
        status: result.success ? "completed" : "failed",
        source: "python_interpreter",
        data: {
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        },
        artifacts,
      });
    }

    return {
      success: result.success,
      data: result,
      error: result.error,
      summary,
      artifacts,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  },
};
