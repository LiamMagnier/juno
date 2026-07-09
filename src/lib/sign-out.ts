"use client";

import { signOut } from "next-auth/react";

/** Sign out, then navigate to /sign-in with a relative client-side redirect.
 * Auth.js computes its redirect URL from the request origin, which behind the
 * production nginx proxy is the internal http://localhost:3000 — so we never
 * let the server pick the destination. */
export async function signOutToSignIn() {
  await signOut({ redirect: false });
  window.location.href = "/sign-in";
}
