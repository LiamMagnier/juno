import { PublicState } from "@/components/public/public-frame";
import { PublicAction } from "@/components/public/public-motion";
import { MODELS_FLOOR } from "@/components/landing/lab-marquee";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { PLANS } from "@/lib/plans";
import { displayPrice } from "@/lib/price-display";

/**
 * The page a referral link opens (`/r/<code>` or `?ref=<code>`).
 *
 * Copy and layout only. The billing lane owns the route, the code lookup, the
 * cookie that carries the code through sign-up and the credit itself; it
 * mounts this component once it has resolved a valid code, for example:
 *
 *   export default async function ReferralPage({ params }) {
 *     const { code } = await params;
 *     const referral = await resolveReferral(code); // billing
 *     if (!referral) notFound();
 *     return <ReferralLanding code={code} rewardEur={2} />;
 *   }
 *
 * It renders on the same recovery/status frame as the 404 and offline pages
 * (PublicState): the construction behind one message and one action, which is
 * all an invitation needs. The reward is a prop so the page cannot drift from
 * what billing actually grants.
 */
export function ReferralLanding({
  code,
  rewardEur = 2,
  signUpHref,
}: {
  code: string;
  /** The usage credit each side receives, in euros. */
  rewardEur?: number;
  /** Defaults to /sign-up?ref=<code>. */
  signUpHref?: string;
}) {
  const reward = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", minimumFractionDigits: Number.isInteger(rewardEur) ? 0 : 2 }).format(rewardEur);
  const from = displayPrice(PLANS.LITE.price, "en").monthly;
  const href = signUpHref ?? `/sign-up?ref=${encodeURIComponent(code)}`;
  return (
    <PublicState
      title="A friend invited you."
      description={`${PRODUCT_NAME} puts Claude, GPT, Gemini and ${MODELS_FLOOR}+ models in one workspace, hosted in France. You both get ${reward} of usage when you subscribe. Plans start at ${from} a month incl. VAT.`}
    >
      <PublicAction href={href}>Accept the invitation</PublicAction>
      <PublicAction href="/#pricing" secondary>See plans</PublicAction>
    </PublicState>
  );
}
