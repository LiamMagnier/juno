import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { getCurrentUser } from "@/lib/session";
import { getConnector, isConnectorConfigured, buildAuthorizeUrl } from "@/lib/connectors";
import { signState } from "@/lib/crypto";

export const runtime = "nodejs";

// Kick off the OAuth flow: set a signed, single-use state cookie and redirect
// the user to the provider's consent screen.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", req.url));

  const { id } = await params;
  const def = getConnector(id);
  if (!def) return NextResponse.redirect(new URL("/connections?error=unknown", req.url));
  if (!isConnectorConfigured(def)) return NextResponse.redirect(new URL("/connections?error=not_configured", req.url));

  const nonce = randomBytes(16).toString("hex");
  // State binds the flow to this user + connector + nonce, signed so the
  // callback can trust it without a server-side store.
  const state = signState(JSON.stringify({ u: user.id, c: def.id, n: nonce }));

  const jar = await cookies();
  jar.set(`oauth_nonce_${def.id}`, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(buildAuthorizeUrl(def, state));
}
