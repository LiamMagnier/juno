/** Small formatters. Kept together so number formatting is consistent everywhere. */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return '—';
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** `/Users/x/proj/src/a.ts` relative to `/Users/x/proj` -> `src/a.ts`. */
export function relativeTo(root: string, path: string): string {
  if (!root) return path;
  const normalized = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(normalized) ? path.slice(normalized.length) : path;
}

/** First non-empty line, trimmed — for one-line previews of tool output. */
export function firstLine(text: string, max = 160): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
