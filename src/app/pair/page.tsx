import Link from "next/link";
import type { Metadata } from "next";
import { PublicState } from "@/components/public/public-frame";
import { Button } from "@/components/ui/button";
import { RemotePairBrowser } from "@/components/code/remote-pair-browser";
import { getCurrentUser } from "@/lib/session";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Pair with your Mac · ${PRODUCT_NAME}`,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** The iPhone app's link for a scanned offer (it opens the approve screen; nothing is approved until the person taps Approve). */
const APP_PAIR_URL = (token: string) => `com.liammagnier.juno://juno/pair?t=${encodeURIComponent(token)}`;

/**
 * `/pair`: where a Mac's "Control this Mac remotely" sheet points
 * (docs/code-v2/REMOTE-CONTROL.md).
 *
 * - `?t=<token>`: the Phone tab's QR, opened by the Camera instead of the
 *   app. A phone offer only pairs from the Alevr app, so this page hands it
 *   over and explains; it never consumes the offer.
 * - no token: the Computer tab. A signed-in browser types the code its Mac
 *   shows and approves; signed out, it signs in first and comes back here.
 */
export default async function PairPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  if (typeof t === "string" && t.startsWith("rcp1.") && t.length <= 1024) {
    return (
      <PublicState
        title="Open this in Alevr on your iPhone"
        description="This code lets your iPhone control Alevr on your Mac. Open it in the Alevr app, or scan it from Code › Pair a Mac."
      >
        <Button asChild size="lg">
          <a href={APP_PAIR_URL(t)}>Open in Alevr</a>
        </Button>
        <Button asChild size="lg" variant="ghost">
          <Link href="/download">Get the app</Link>
        </Button>
      </PublicState>
    );
  }
  const user = await getCurrentUser().catch(() => null);
  if (!user) {
    return (
      <PublicState
        title="Sign in to pair this browser"
        description="Use the same Alevr account as your Mac. You will come back here to enter the code your Mac shows."
      >
        <Button asChild size="lg">
          <Link href={`/sign-in?callbackUrl=${encodeURIComponent("/pair")}`}>Sign in</Link>
        </Button>
      </PublicState>
    );
  }
  return <RemotePairBrowser />;
}
