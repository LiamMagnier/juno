import type { ToolDefinition } from './types.js';
import { editFileTool, globTool, grepTool, readFileTool, writeFileTool } from './fs.js';
import { bashTool } from './bash.js';
import { editFilesTool } from './edit-files.js';
import { repositoryTools } from './repository.js';
import { todoWriteTool } from './todo.js';

export function defaultTools(): ToolDefinition[] {
  return [readFileTool, globTool, grepTool, ...repositoryTools(), editFileTool, editFilesTool, writeFileTool, bashTool, todoWriteTool];
}
