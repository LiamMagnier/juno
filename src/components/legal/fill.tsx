/**
 * A fact on a legal page that only the owner can supply.
 *
 * Renders the value when src/lib/legal/seller.ts has it, and otherwise a
 * visible "[À COMPLÉTER : …]" marker naming what is missing — never a guess,
 * never an empty string. Plain bold text, no badge: it reads as what it is,
 * an unfinished sentence in a contract.
 */
export function Fill({ value, what }: { value: string | null | undefined; what: string }) {
  if (value && value.trim()) return <strong>{value}</strong>;
  return <strong data-legal-placeholder="">{`[À COMPLÉTER : ${what}]`}</strong>;
}
