/**
 * Deterministic randomness for crew identity.
 *
 * Pure (no Math.random, no DOM), so the server render, the client render and
 * the Swift port all derive the same member from the same seed. Both
 * functions are a few lines in Swift (see RATIONALE.md, "Native").
 */

/** 32-bit FNV-1a. Stable across JS engines and trivially ported to Swift. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny, well-distributed PRNG seeded by the hash. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
