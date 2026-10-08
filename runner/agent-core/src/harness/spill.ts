/**
 * Output spill (SPEC §3.5): a tool result over 12.5k tokens is written whole
 * to a file and the model gets its head, its tail and the path, so one noisy
 * build log cannot eat a fifth of the context window. The model can read the
 * file in ranges if it needs the middle.
 */

import fs from 'node:fs';
import path from 'node:path';

/** 12.5k tokens at the engine's four-characters-a-token estimate. */
export const SPILL_THRESHOLD_CHARS = 50_000;
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 4_000;

export interface SpillResult {
  content: string;
  spilledTo?: string;
}

function safeName(callId: string): string {
  return callId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'output';
}

/**
 * The content to hand the model. `dir` is where full outputs are kept (the
 * session's spill directory); it is created on first use.
 */
export function spillIfLarge(
  output: string,
  options: { dir: string; callId: string; toolName: string; thresholdChars?: number },
): SpillResult {
  const threshold = options.thresholdChars ?? SPILL_THRESHOLD_CHARS;
  if (output.length <= threshold) return { content: output };
  let file: string | undefined;
  try {
    fs.mkdirSync(options.dir, { recursive: true });
    file = path.join(options.dir, `${safeName(options.callId)}.txt`);
    fs.writeFileSync(file, output, 'utf8');
  } catch {
    file = undefined;
  }
  const omitted = output.length - HEAD_CHARS - TAIL_CHARS;
  const where = file
    ? `The full output (${output.length.toLocaleString('en-US')} characters) is saved at ${file}; read it with read_file using offset/limit if you need the middle.`
    : 'The full output could not be saved.';
  return {
    content: `${output.slice(0, HEAD_CHARS)}\n\n…[${omitted.toLocaleString('en-US')} characters of ${options.toolName} output omitted. ${where}]…\n\n${output.slice(-TAIL_CHARS)}`,
    ...(file ? { spilledTo: file } : {}),
  };
}
