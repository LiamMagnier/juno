/**
 * Display types for the old in-chat Python blocks (`components/chat/
 * python-execution-block.tsx`, `data-table-block.tsx`), nothing else.
 *
 * The host child-process Python executor that lived here is retired, with the
 * `code-interpreter.ts` wrapper that could fall back to it. Model-written code
 * runs only on the remote execution host now (src/lib/exec,
 * deploy/exec-host); there is no code path that runs it on this machine.
 */

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
