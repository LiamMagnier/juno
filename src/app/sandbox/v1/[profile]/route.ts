import { isSandboxProfile, sandboxOrigin } from "@/lib/sandbox-policy";
import { sandboxShellResponse } from "@/lib/sandbox-shell";

/*
 * The artifact preview shell. Not a page of the app: the middleware leaves this
 * path without the app's nonce policy (documentPolicyFor in
 * src/lib/sandbox-policy.ts), and the response below brings its own. See
 * src/lib/sandbox-shell.ts for the exchange with the framing page.
 */

export const runtime = "nodejs";

function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ profile: string }> }) {
  const { profile } = await params;
  if (!isSandboxProfile(profile)) return new Response("Not found", { status: 404 });
  return sandboxShellResponse({
    profile,
    appOrigin: originOf(process.env.NEXT_PUBLIC_APP_URL),
    separateOrigin: sandboxOrigin() !== null,
  });
}
