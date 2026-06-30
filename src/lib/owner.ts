/**
 * Owner accounts: email addresses listed in OWNER_EMAILS get the special OWNER
 * plan — unlimited everything, all models, and no rate limits. This is resolved
 * from the env at request time, so no Stripe/DB state is needed.
 */
export function isOwnerEmail(email?: string | null): boolean {
  if (!email) return false;
  const list = (process.env.OWNER_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}
