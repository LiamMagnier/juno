/**
 * Which phase a chat run is in, from its view and the stream's live state
 * (SPEC §7.3). Chat only: Research's phase comes from the server DTO.
 *
 * WS0 lands the signature; WS5 implements the derivation.
 */

import type { PhaseInputs, PhaseState, RunView } from "@/lib/run/types";

export type { PhaseInputs, PhaseState, RunPhase } from "@/lib/run/types";

export function derivePhase(_view: RunView, _live: PhaseInputs): PhaseState {
  throw new Error("not implemented: WS5");
}
