/** The web's pairing code field (docs/code-v2/REMOTE-CONTROL.md): the same alphabet the backend mints from. */
export const PAIRING_CODE_INPUT_LENGTH = 8;

/** "k7qm4mzp" → "K7QM-4MZP" while typing; anything outside the code's alphabet is dropped. */
export function formatCodeInput(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^23456789ABCDEFGHJKMNPQRSTVWXYZ]/g, "").slice(0, PAIRING_CODE_INPUT_LENGTH);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
