/**
 * Deep-research reports are prompted to end with a "## Sources" section listing
 * every citation as "[n] Title — URL" (see buildResearchContext). Once the same
 * list renders as the sources pill, that tail is a duplicate wall of naked URLs
 * — so drop it from the RENDERED markdown. Copy still yields the full text.
 *
 * Conservative on purpose: only the last such heading, only when every line
 * under it is a citation entry (a "Sources" section the model wrote prose into
 * is the model saying something, not a list we already render), and only when
 * the heading isn't inside a code fence.
 *
 * Shared by the transcript (message-item.tsx) and the conversation export
 * (conversation-export.ts), which prints the same list from `sources` itself.
 */
export function stripTrailingSourcesSection(content: string): string {
  const lines = content.split("\n");
  let start = -1;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(lines[i])) fenced = !fenced;
    else if (!fenced && /^#{1,6}\s+sources\s*$/i.test(lines[i])) start = i;
  }
  if (start === -1) return content;
  const isEntry = (line: string) => line.trim() === "" || /^\s*(?:[-*]\s+)?\[\d{1,3}\]/.test(line);
  if (!lines.slice(start + 1).every(isEntry)) return content;
  return lines.slice(0, start).join("\n").trimEnd();
}
