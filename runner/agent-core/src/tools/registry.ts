import type { ToolDefinition } from './types.js';
import { editFileTool, globTool, grepTool, readFileTool, writeFileTool } from './fs.js';
import { bashTool } from './bash.js';
import { repositoryTools } from './repository.js';

export function defaultTools(): ToolDefinition[] {
  return [readFileTool, globTool, grepTool, ...repositoryTools(), editFileTool, writeFileTool, bashTool];
}
