import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/session";
import { isValidBrowserAuthorization } from "@/lib/native-auth-core";
import { issueNativeAuthorizationCode } from "@/lib/native-auth";
import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { AppAuthHandoff, LegacyAppAuthHandoff } from "./handoff";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => typeof value === "string" ? value : "";

export default async function AppAuthPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const authorization = {
    state: one(params.state),
    nonce: one(params.nonce),
    codeChallenge: one(params.code_challenge),
    codeChallengeMethod: one(params.code_challenge_method),
    redirectUri: one(params.redirect_uri),
    installationId: one(params.installation_id),
  };

  // Stable-lineage apps (build ≤30) open /app-auth with NO parameters and
  // expect the session token over the juno:// deep link. Only requests that
  // carry v3 parameters but fail validation are actually invalid.
  const isLegacyRequest =
    !authorization.state && !authorization.nonce && !authorization.codeChallenge &&
    !authorization.redirectUri && !authorization.installationId;
  if (isLegacyRequest) {
    const user = await getCurrentUser();
    if (!user) redirect("/sign-in?callbackUrl=/app-auth");
    const store = await cookies();
    const token =
      store.get("authjs.session-token")?.value ??
      store.get("__Secure-authjs.session-token")?.value ??
      "";
    return <LegacyAppAuthHandoff token={token} />;
  }

  if (!isValidBrowserAuthorization(authorization)) {
    return <AuthFailure message={`This sign-in request is invalid or came from an unsupported version of ${PRODUCT_NAME}.`} />;
  }

  const callback = `/app-auth?${new URLSearchParams({
    state: authorization.state,
    nonce: authorization.nonce,
    code_challenge: authorization.codeChallenge,
    code_challenge_method: authorization.codeChallengeMethod,
    redirect_uri: authorization.redirectUri,
    installation_id: authorization.installationId,
  })}`;
  const user = await getCurrentUser();
  if (!user) redirect(`/sign-in?callbackUrl=${encodeURIComponent(callback)}`);

  const code = await issueNativeAuthorizationCode({
    userId: user.id,
    codeChallenge: authorization.codeChallenge,
    redirectUri: authorization.redirectUri,
    nonce: authorization.nonce,
    installationId: authorization.installationId,
  });
  return <AppAuthHandoff code={code} state={authorization.state} nonce={authorization.nonce} redirectUri={authorization.redirectUri} />;
}

function AuthFailure({ message }: { message: string }) {
  return (
    // The same centred `surface-raised-lg` panel as the handoff card, with the
    // failure named in the destructive ramp rather than left to the copy alone.
    <main className="alevr-public flex min-h-dvh items-center justify-center bg-background px-4 py-12 text-foreground">
      <div
        role="alert"
        className="w-full max-w-md p-6 text-center motion-safe:animate-rise-in sm:p-7"
      >
        <AlevrLockup height={28} className="mx-auto" />
        <h1 className="mt-8 text-balance font-serif text-display">{`${PRODUCT_NAME} couldn’t start sign-in`}</h1>
        <p className="mt-3 text-body text-muted-foreground">{message}</p>
      </div>
    </main>
  );
}
