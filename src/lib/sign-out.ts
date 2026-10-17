"use client";

import { signOut } from "next-auth/react";
import { browserStorage, clearAllLocalCanvasDrafts } from "@/lib/canvas-draft";

/** Sign out, then navigate to /sign-in with a relative client-side redirect.
 * Auth.js computes its redirect URL from the request origin, which behind the
 * production nginx proxy is the internal http://localhost:3000 — so we never
 * let the server pick the destination. */
export async function signOutToSignIn() {
  await signOut({ redirect: false });
  // The canvas's device copies of unsaved edits hold artifact source. They
  // must not outlive the session in a browser somebody else may use next;
  // an edit the server received is still offered back on the next sign-in
  // (src/lib/canvas-draft.ts).
  clearAllLocalCanvasDrafts(browserStorage());
  window.location.href = "/sign-in";
}
