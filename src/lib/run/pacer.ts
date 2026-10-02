/**
 * Pacing the phase label (SPEC §7.3): nothing before 150 ms, no label before
 * 400 ms, a shown label stays 600 ms, changes 700 ms apart, and the newest
 * phase always wins. Shared by the chat line and Research rows.
 *
 * WS0 lands the signature; WS5 implements it. The constants live in
 * `src/lib/motion.ts`.
 */

import { RUN_PACING } from "@/lib/motion";
import type { PhaseState } from "@/lib/run/types";

export { RUN_PACING };

export function createPhasePacer(
  _show: (p: PhaseState) => void,
  _opts?: Partial<typeof RUN_PACING>,
): { push(p: PhaseState): void; dispose(): void } {
  throw new Error("not implemented: WS5");
}
