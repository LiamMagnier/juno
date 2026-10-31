/**
 * What a share with specific people shows to anyone it cannot be shown to
 * (src/lib/share-people-core.ts): signed out, an unconfirmed address, or an
 * account it was not shared with — including someone the owner removed.
 *
 * Like `<ShareGone />`, it renders nothing from the share: not its title, not
 * its owner, not who is on it. The only thing a token proves to a stranger is
 * that it names a share with specific people. The viewer's own address is the
 * one fact it repeats back, so they can tell which account they are in.
 *
 * Every way out comes back to this page: sign in, create an account, or sign
 * out and in as someone else, each with this page as the place to return to.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PublicState } from "@/components/public/public-frame";
import { ShareSwitchAccount } from "@/components/share/share-switch-account";
import { PRODUCT_NAME } from "@/lib/brand/names";

export type ShareRestrictedState = "sign-in" | "verify" | "denied";

export const SHARE_RESTRICTED_COPY = {
  "sign-in": {
    title: "Sign in to open this",
    description: () => "It was shared with specific people. Sign in with the email address it was sent to, or create an account with that address.",
  },
  verify: {
    title: "Confirm your email to open this",
    description: (email: string | null) =>
      `Only the people it was shared with can open it, so ${PRODUCT_NAME} needs to know ${email ? email : "your address"} is yours. Open the confirmation email we sent, then come back to this link.`,
  },
  denied: {
    title: "You don’t have access to this",
    description: (email: string | null) =>
      `It was shared with specific people${email ? `, and not with ${email}` : ""}. Sign in with the address it was sent to, or ask whoever shared it to add you.`,
  },
} as const;

export function ShareRestricted({ state, token, email = null }: { state: ShareRestrictedState; token: string; email?: string | null }) {
  const here = `/share/${encodeURIComponent(token)}`;
  const back = encodeURIComponent(here);
  const copy = SHARE_RESTRICTED_COPY[state];
  return (
    <PublicState title={copy.title} description={copy.description(email)}>
      {state === "sign-in" ? (
        <>
          <Button asChild><Link href={`/sign-in?callbackUrl=${back}`}>Sign in</Link></Button>
          <Button asChild variant="secondary"><Link href={`/sign-up?callbackUrl=${back}`}>Create account</Link></Button>
        </>
      ) : state === "verify" ? (
        <>
          <Button asChild><Link href="/chat">{`Open ${PRODUCT_NAME}`}</Link></Button>
          <ShareSwitchAccount returnTo={here} variant="secondary" />
        </>
      ) : (
        <>
          <ShareSwitchAccount returnTo={here} />
          <Button asChild variant="secondary"><Link href="/chat">{`Open ${PRODUCT_NAME}`}</Link></Button>
        </>
      )}
    </PublicState>
  );
}
