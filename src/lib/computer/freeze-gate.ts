/**
 * A take over's freeze holds this process's own launches into that computer
 * until it settles. The freeze stops every agent-uid task and rescans until
 * none runs (agent-exec freeze, here or on the computer host); a launch that
 * lands during that scan is one more task to stop, and a steady stream of them
 * kept the scan from ever coming up empty, so the take over told the person the
 * agent could not be paused. Held, a launch runs once the freeze has returned,
 * and the launcher refuses it on the frozen marker (75).
 *
 * Per process, like the calls it orders: another process's launch still only
 * ever delays the scan by its own short life. Keyed by the computer's name.
 */

const freezing = new Map<string, Promise<void>>();

/** Runs a freeze with this process's launches into that computer held until it settles. */
export async function holdingLaunches<T>(computer: string, freeze: () => Promise<T>): Promise<T> {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const previous = freezing.get(computer);
  freezing.set(computer, settled);
  try {
    if (previous) await previous;
    return await freeze();
  } finally {
    if (freezing.get(computer) === settled) freezing.delete(computer);
    settle();
  }
}

/** Waits for a freeze of that computer in flight in this process, if any. */
export async function afterFreeze(computer: string | null): Promise<void> {
  const pending = computer ? freezing.get(computer) : undefined;
  if (pending) await pending;
}
