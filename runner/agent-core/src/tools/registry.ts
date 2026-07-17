import type { ToolDefinition } from './types.js';
import { editFileTool, globTool, grepTool, readFileTool, writeFileTool } from './fs.js';
import { bashTool } from './bash.js';

export function defaultTools(): ToolDefinition[] {
  return [readFileTool, globTool, grepTool, editFileTool, writeFileTool, bashTool];
}
