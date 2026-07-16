import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { isValidBrowserAuthorization } from "@/lib/native-auth-core";
import { issueNativeAuthorizationCode } from "@/lib/native-auth";
import { AppAuthHandoff } from "./handoff";

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

  if (!isValidBrowserAuthorization(authorization)) {
    return <AuthFailure message="This sign-in request is invalid or came from an unsupported version of Juno." />;
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
    <main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-lg font-semibold">Juno couldn’t start sign-in</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </main>
  );
}
