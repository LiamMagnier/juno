import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { AppAuthHandoff } from "./handoff";

/**
 * Native-app sign-in handoff. The macOS/iOS app opens this URL inside an
 * ASWebAuthenticationSession. If the visitor isn't signed in yet we bounce them
 * through the normal web sign-in (credentials OR Google), which returns here via
 * `callbackUrl`. Once signed in we read the session-token cookie and hand it to
 * the app through a `juno://` deep link the auth session captures.
 */
export const dynamic = "force-dynamic";

export default async function AppAuthPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in?callbackUrl=/app-auth");
  }

  const store = await cookies();
  const token =
    store.get("authjs.session-token")?.value ??
    store.get("__Secure-authjs.session-token")?.value ??
    "";

  return <AppAuthHandoff token={token} />;
}
