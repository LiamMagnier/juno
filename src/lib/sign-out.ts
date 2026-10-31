"use client";

import { signOut } from "next-auth/react";
import { browserStorage, clearAllLocalCanvasDrafts } from "@/lib/canvas-draft";

/** Sign out, then navigate to /sign-in with a relative client-side redirect.
 * Auth.js computes its redirect URL from the request origin, which behind the
 * production nginx proxy is the internal http://localhost:3000 — so we never
 * let the server pick the destination. `next` is a same-site path to return
 * to after signing in again (a share page asking for a different account);
 * the sign-in form re-checks it before following it. */
export async function signOutToSignIn(next?: string) {
  await signOut({ redirect: false });
  // The canvas's device copies of unsaved edits hold artifact source. They
  // must not outlive the session in a browser somebody else may use next;
  // an edit the server received is still offered back on the next sign-in
  // (src/lib/canvas-draft.ts).
  clearAllLocalCanvasDrafts(browserStorage());
  const sameSite = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
  window.location.href = sameSite ? `/sign-in?callbackUrl=${encodeURIComponent(sameSite)}` : "/sign-in";
}
