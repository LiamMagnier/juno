/*
 * THE GALAXY CAP (spec D9, §4.5 rule 8, law 4): at most three galaxies
 * animate per document. Every mark that would like to animate registers here;
 * the registry grants the three slots in priority order:
 *
 *   1. live   the TurnStatus live line
 *   2. focus  a row the pointer is over, or that holds focus
 *   3. other  everything else, in the order it asked
 *
 * A mark is only a candidate while it wants to animate (real work behind it,
 * motion allowed), is on screen (IntersectionObserver) and its tab is visible.
 * Every other mark draws its static SVG still frame and holds no canvas.
 *
 * DOM-free, synchronous and deterministic, so the cap is tested without a
 * browser; galaxy-mark.tsx feeds it.
 */

import { SHELL } from "@/lib/design/tokens.generated";

export type GalaxyPriority = "live" | "focus" | "other";

const RANK: Record<GalaxyPriority, number> = { live: 0, focus: 1, other: 2 };

export interface GalaxyCandidate {
  /** Wants to animate: real work, motion allowed. */
  wants: boolean;
  /** On screen and in a visible tab. */
  visible: boolean;
  priority: GalaxyPriority;
}

export interface GalaxyEntry {
  /** Update this mark's state; the registry re-grants at once. */
  update(next: Partial<GalaxyCandidate>): void;
  /** Whether this mark holds a slot now. */
  granted(): boolean;
  /** Leave the registry (unmount). */
  release(): void;
}

export interface GalaxyRegistry {
  register(initial: GalaxyCandidate, onGrant: (granted: boolean) => void): GalaxyEntry;
  /** How many marks hold a slot. */
  animating(): number;
  readonly cap: number;
}

export function createGalaxyRegistry(cap: number = SHELL.galaxyMaxAnimating): GalaxyRegistry {
  interface Slot {
    seq: number;
    state: GalaxyCandidate;
    granted: boolean;
    onGrant: (granted: boolean) => void;
  }
  const slots = new Set<Slot>();
  let seq = 0;

  const regrant = () => {
    const ranked = [...slots]
      .filter((s) => s.state.wants && s.state.visible)
      .sort((a, b) => RANK[a.state.priority] - RANK[b.state.priority] || a.seq - b.seq);
    const winners = new Set(ranked.slice(0, cap));
    const changes: Slot[] = [];
    for (const slot of slots) {
      const next = winners.has(slot);
      if (next !== slot.granted) {
        slot.granted = next;
        changes.push(slot);
      }
    }
    // Revocations first, so a slot is free before its new holder starts drawing.
    changes.sort((a, b) => Number(a.granted) - Number(b.granted));
    for (const slot of changes) slot.onGrant(slot.granted);
  };

  return {
    cap,
    register(initial, onGrant) {
      const slot: Slot = { seq: seq++, state: { ...initial }, granted: false, onGrant };
      slots.add(slot);
      regrant();
      return {
        update(next) {
          const before = slot.state;
          slot.state = { ...before, ...next };
          if (before.wants !== slot.state.wants || before.visible !== slot.state.visible || before.priority !== slot.state.priority) regrant();
        },
        granted: () => slot.granted,
        release() {
          if (!slots.delete(slot)) return;
          slot.granted = false;
          regrant();
        },
      };
    },
    animating: () => [...slots].filter((s) => s.granted).length,
  };
}

/** The document's registry. */
export const galaxyRegistry: GalaxyRegistry = createGalaxyRegistry();
