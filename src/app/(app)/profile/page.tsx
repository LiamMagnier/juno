import { redirect } from "next/navigation";

/**
 * /profile is Settings → Account.
 *
 * The page that stood here drew the same data the account section draws —
 * the year of activity, the model mix, the lifetime ledger — with its own
 * heatmap (max-fraction levels, local-date keys) beside the account
 * section's (quantile levels, UTC keys), so one account had two different
 * pictures of one history, plus a verbatim copy of the avatar upload and a
 * hardcoded "Member since Aug 2026" fallback. One usage surface now, and the
 * `profile` alias in settings-sections.ts already pointed here.
 *
 * A server redirect rather than a client one, so the old URL costs a reader
 * nothing but the round trip; links inside the product go to /settings directly.
 */
export default function ProfilePage() {
  redirect("/settings?section=account");
}
