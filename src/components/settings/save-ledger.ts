/**
 * The bookkeeping behind every optimistic settings write: which write owns
 * each field, and what the server last accepted for it. Kept free of React,
 * fetch and the app provider so the sequencing rules are unit-testable
 * (tests/settings-save-ledger.test.ts).
 *
 *   latest     the newest write per key. Only that write may roll the key
 *              back; a slow failure of an older write must not undo a newer
 *              change the server already has.
 *   confirmed  the value per key the server last accepted, which is what a
 *              rollback restores. Restoring the value the control showed just
 *              before the write is wrong as soon as two writes overlap: that
 *              value was itself optimistic, so when both fail the control
 *              would keep the first change the server never stored.
 *   pending    writes in flight per key, so `confirmed` is only seeded from
 *              the shown value while nothing is in flight for it.
 *
 * Writes are expected to settle in the order they began (the callers put
 * them on one queue), which is what lets a success simply become the new
 * confirmed value.
 */
export interface SaveLedger<K extends string> {
  /**
   * Record a write of `keys`. `shown(key)` is the value on screen before this
   * write's optimistic change, taken as the confirmed value when nothing else
   * is in flight for that key. Returns the write's ticket.
   */
  begin(keys: readonly K[], shown: (key: K) => unknown): number;
  /**
   * Settle a write. On success the written values become the confirmed ones
   * and the result is null. On failure the result holds the confirmed value
   * of every key this write still owns (the ones no newer write has touched
   * since), or null when a newer write owns them all and nothing may move.
   */
  settle(
    ticket: number,
    keys: readonly K[],
    outcome: { ok: true; written: Partial<Record<K, unknown>> } | { ok: false }
  ): Partial<Record<K, unknown>> | null;
}

export function createSaveLedger<K extends string>(): SaveLedger<K> {
  let sequence = 0;
  const latest = new Map<K, number>();
  const confirmed = new Map<K, unknown>();
  const pending = new Map<K, number>();

  return {
    begin(keys, shown) {
      const ticket = ++sequence;
      for (const key of keys) {
        if (!pending.get(key)) confirmed.set(key, shown(key));
        pending.set(key, (pending.get(key) ?? 0) + 1);
        latest.set(key, ticket);
      }
      return ticket;
    },

    settle(ticket, keys, outcome) {
      for (const key of keys) pending.set(key, Math.max(0, (pending.get(key) ?? 1) - 1));
      if (outcome.ok) {
        for (const key of keys) confirmed.set(key, outcome.written[key]);
        return null;
      }
      const rollback: Partial<Record<K, unknown>> = {};
      let owned = false;
      for (const key of keys) {
        if (latest.get(key) !== ticket) continue;
        rollback[key] = confirmed.get(key);
        owned = true;
      }
      return owned ? rollback : null;
    },
  };
}
