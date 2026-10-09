/**
 * Layered, cache-aware context management (SPEC §3.5).
 *
 * The loop used to have one move: fold the older steps into a model-written
 * summary. That costs a model call and rewrites the whole prefix. Most long
 * runs are long because of a few huge tool results and screenshots, so the
 * cheaper layers go first:
 *
 *   1. prune — a tool result over 8,192 characters outside the protected tail
 *      keeps its head (4,096) and tail (1,024);
 *   2. offload — images outside the protected tail are written to disk and
 *      replaced by their path;
 *   3. summarize — the oldest balanced span is folded into a summary written
 *      by a request that replays the exact prefix (cache hit), keeping the
 *      newest steps that fit in 16 % of the window.
 *
 * Each layer runs only while the context is still above the target. The
 * trigger is floor(min(0.8·W, W − O − 65,536)) for window W and output
 * reservation O — but never below half the window, so a small-window model is
 * not compacting every other step.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../types.js';
import { estimateTokens } from '../compaction.js';

export const PRUNE_MIN_CHARS = 8_192;
export const PRUNE_HEAD_CHARS = 4_096;
export const PRUNE_TAIL_CHARS = 1_024;
/** The newest share of the window that is never pruned, offloaded or folded. */
export const KEEP_RECENT_SHARE = 0.16;
/** Reserved headroom the trigger leaves under the window. */
export const TRIGGER_HEADROOM_TOKENS = 65_536;
/** What a layer must get the context under to stop the next layer running. */
export const LAYER_TARGET_SHARE = 0.85;

export function compactionTriggerTokens(contextWindow: number, outputReserve = 8_192): number {
  const formula = Math.floor(Math.min(0.8 * contextWindow, contextWindow - outputReserve - TRIGGER_HEADROOM_TOKENS));
  return Math.max(formula, Math.floor(contextWindow * 0.5));
}

/**
 * Index of the first message in the protected tail: the newest messages whose
 * estimated size stays within `share` of the window (at least the last one).
 */
export function protectedTailStart(messages: readonly ChatMessage[], contextWindow: number, share = KEEP_RECENT_SHARE): number {
  const budget = Math.max(1, Math.floor(contextWindow * share));
  let used = 0;
  let index = messages.length;
  while (index > 0) {
    const size = estimateTokens({ messages: [messages[index - 1]!] });
    if (index < messages.length && used + size > budget) break;
    used += size;
    index -= 1;
  }
  return index;
}

/**
 * How many trailing steps (assistant messages that start a step) the newest
 * `share` of the window holds — what `planCompaction` keeps whole.
 */
export function recentStepsWithin(messages: readonly ChatMessage[], contextWindow: number, share = KEEP_RECENT_SHARE): number {
  const start = protectedTailStart(messages, contextWindow, share);
  let steps = 0;
  for (let index = Math.max(start, 1); index < messages.length; index++) {
    if (messages[index]!.role === 'assistant' && messages[index - 1]?.role === 'user') steps += 1;
  }
  return Math.max(1, steps);
}

export const PRUNED_MARKER = 'characters of this tool result were pruned to save context';

/** Layer 1. Mutates `messages`; returns the characters removed. */
export function pruneToolResults(messages: ChatMessage[], beforeIndex: number): number {
  let removed = 0;
  for (let m = 0; m < Math.min(beforeIndex, messages.length); m++) {
    const message = messages[m]!;
    if (message.role !== 'user') continue;
    for (let p = 0; p < message.content.length; p++) {
      const part = message.content[p]!;
      if (part.type !== 'tool_result' || part.content.length <= PRUNE_MIN_CHARS) continue;
      if (part.content.includes(PRUNED_MARKER)) continue;
      const cut = part.content.length - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS;
      const content = `${part.content.slice(0, PRUNE_HEAD_CHARS)}\n…[${cut.toLocaleString('en-US')} ${PRUNED_MARKER}]…\n${part.content.slice(-PRUNE_TAIL_CHARS)}`;
      removed += part.content.length - content.length;
      message.content[p] = { ...part, content };
    }
  }
  return removed;
}

/**
 * Layer 2. Writes each image before `beforeIndex` to `dir` (when given) and
 * replaces it with a marker naming the file. Returns how many were offloaded.
 */
export function offloadImages(messages: ChatMessage[], beforeIndex: number, dir?: string): number {
  let count = 0;
  for (let m = 0; m < Math.min(beforeIndex, messages.length); m++) {
    const message = messages[m]!;
    if (message.role !== 'user') continue;
    for (let p = 0; p < message.content.length; p++) {
      const part = message.content[p]!;
      if (part.type !== 'image') continue;
      let where = 'it was not kept';
      if (dir) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          const extension = part.mediaType.split('/')[1] ?? 'png';
          const file = path.join(dir, `image-${Date.now()}-${m}-${p}.${extension}`);
          fs.writeFileSync(file, Buffer.from(part.data, 'base64'));
          where = `saved at ${file}`;
        } catch {
          // Keep going: the marker still frees the context.
        }
      }
      message.content[p] = { type: 'text', text: `[Image offloaded to save context; ${where}]` };
      count += 1;
    }
  }
  return count;
}
