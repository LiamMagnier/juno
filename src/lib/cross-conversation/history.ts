/**
 * Where messages from the person's other conversations sit in a Chat's model
 * history (src/lib/cross-conversation). Pure, so the placement rules are tests.
 *
 * - Each message is a user-side turn holding the fenced text from
 *   frameCrossMessage (or the idle notice), placed by time. The fence and its
 *   closing sentence say it is not the person speaking; every provider still
 *   needs it on the user side of the alternation.
 * - Only messages inside the window are placed: one older than the window's
 *   first message is already behind the rolling summary, and placing it would
 *   move the cached prefix. When the window holds the whole conversation
 *   (`fromStart`), an older message is the conversation's opening and leads.
 * - Next to the person's own message (or another such message) it joins that
 *   turn rather than making two user turns in a row, which some providers
 *   refuse. The person's own words keep their row id, so anything keyed on it
 *   (the hidden clarification content) still finds them.
 */
export interface HistoryRow {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

export interface CrossHistoryEntry {
  id: string;
  createdAt: Date;
  content: string;
}

export function mergeCrossHistory<T extends HistoryRow>(
  history: readonly T[],
  entries: readonly CrossHistoryEntry[],
  options: { fromStart?: boolean } = {},
): T[] {
  if (entries.length === 0 || history.length === 0) return [...history];
  const start = history[0].createdAt.getTime();
  const placed = options.fromStart ? [...entries] : entries.filter((entry) => entry.createdAt.getTime() >= start);
  if (placed.length === 0) return [...history];
  const template = history[0];
  type Item = { at: number; order: number; row: T; cross: boolean };
  const items: Item[] = [
    ...history.map((row, order) => ({ at: row.createdAt.getTime(), order, row, cross: false })),
    ...placed.map((entry, i) => ({
      at: entry.createdAt.getTime(),
      order: history.length + i,
      cross: true,
      row: { ...template, id: entry.id, role: "USER", content: entry.content, createdAt: entry.createdAt, attachments: [] } as unknown as T,
    })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);

  const out: T[] = [];
  let lastCross = false;
  for (const item of items) {
    const previous = out[out.length - 1];
    if (previous && previous.role === "USER" && item.row.role === "USER" && (item.cross || lastCross)) {
      // Keep the person's own row (and its id) as the carrier.
      const carrier = lastCross && !item.cross ? item.row : previous;
      const joined = lastCross && !item.cross ? `${previous.content}\n\n${item.row.content}` : `${previous.content}\n\n${item.row.content}`;
      out[out.length - 1] = { ...carrier, content: joined };
      lastCross = lastCross && item.cross;
      continue;
    }
    out.push(item.row);
    lastCross = item.cross;
  }
  return out;
}
