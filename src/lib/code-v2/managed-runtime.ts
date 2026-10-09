/**
 * Runtimes Alevr installs and signs in itself through the env server on the
 * user's Mac (Antigravity, runtime lane: `provider.install`, `provider.auth`),
 * as the Connections row reads them. Pure.
 *
 * Sign-in is the vendor's own browser flow with a loopback redirect to
 * 127.0.0.1 on the Mac. A browser on that Mac finishes by itself; from any
 * other device the reader opens the vendor's page, signs in, and pastes the
 * address the browser ends on (a localhost URL that cannot load there), which
 * the Mac hands to its loopback listener. Alevr never stores what is in it.
 */
import type { ProviderInstance } from "./contracts";
import type { ProviderAuthState, ProviderInstallState, RuntimeLaneInstance } from "./runtime-lane";

export type ManagedStep =
  | { kind: "install"; busy: boolean; pct?: number; sentence: string; operationId?: string }
  | { kind: "sign-in"; busy: boolean; waiting: boolean; authorizationUrl?: string; flowId?: string; expiresAt?: string; sentence: string; method: string };

const INSTALL_BUSY = new Set<ProviderInstallState["phase"]>(["downloading", "extracting", "verifying"]);
const AUTH_BUSY = new Set<ProviderAuthState["phase"]>(["starting", "waiting", "verifying"]);

/** Whether the env server installs / signs in this instance itself (else the terminal setup applies). */
export function isManaged(instance: ProviderInstance): boolean {
  const i = instance as RuntimeLaneInstance;
  return !!i.install || !!i.auth;
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/**
 * What a managed row offers now, given the instance and the latest state the
 * row saw from its own command (events can lag a relay round trip). Null when
 * nothing is pending: the row falls back to Re-check / Manage.
 */
export function managedStep(instance: ProviderInstance, seen: { install?: ProviderInstallState; auth?: ProviderAuthState } = {}): ManagedStep | null {
  const i = instance as RuntimeLaneInstance;
  // The instance's own state wins once it moved; until then, what the row's command returned.
  const install = i.install && i.install.phase !== "idle" ? i.install : (seen.install ?? i.install);
  const auth = i.auth && i.auth.phase !== "idle" ? i.auth : (seen.auth ?? i.auth);

  if (install && (instance.status === "not-installed" || INSTALL_BUSY.has(install.phase))) {
    const busy = INSTALL_BUSY.has(install.phase);
    const pct = install.totalBytes && install.downloadedBytes !== undefined ? Math.min(100, (install.downloadedBytes / install.totalBytes) * 100) : undefined;
    const sentence =
      install.phase === "downloading"
        ? `Downloading${install.totalBytes ? ` ${mb(install.downloadedBytes ?? 0)} of ${mb(install.totalBytes)}` : ""} from the vendor.`
        : install.phase === "extracting"
          ? "Unpacking."
          : install.phase === "verifying"
            ? "Checking the download against its published checksum."
            : install.phase === "failed"
              ? (install.message ?? "The download did not finish. Try again.")
              : `Not installed. Alevr downloads the vendor's own release${install.version ? ` (${install.version})` : ""} and checks it before it runs.`;
    return { kind: "install", busy, pct, sentence, operationId: install.operationId };
  }

  if (auth && (instance.status === "signed-out" || AUTH_BUSY.has(auth.phase))) {
    const method = auth.method ?? "Google account";
    const waiting = auth.phase === "waiting";
    const busy = AUTH_BUSY.has(auth.phase);
    const sentence =
      auth.phase === "starting"
        ? "Starting sign-in on your Mac."
        : waiting
          ? `Sign in with your ${method} to finish.`
          : auth.phase === "verifying"
            ? "Checking your sign-in."
            : auth.phase === "failed"
              ? (auth.message ?? "Sign-in did not finish. Try again.")
              : auth.phase === "cancelled"
                ? "Sign-in cancelled."
                : `Signs in with your ${method}.`;
    return { kind: "sign-in", busy, waiting, authorizationUrl: waiting ? auth.authorizationUrl : undefined, flowId: auth.flowId, expiresAt: auth.expiresAt, sentence, method };
  }
  return null;
}

/**
 * The vendor's sign-in page, only if it is an https URL (it is opened in a new
 * tab from a relayed message, so nothing else is followed).
 */
export function safeAuthorizationUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Checks a pasted redirect address before it goes to the Mac: it must be the
 * loopback redirect (http://localhost or 127.0.0.1 with a port) and carry the
 * vendor's answer (`code` or `error`). Returns the URL to send, or a sentence.
 */
export function checkPastedRedirect(text: string): { ok: true; url: string } | { ok: false; message: string } {
  const raw = text.trim();
  if (!raw) return { ok: false, message: "Paste the address from your browser's address bar." };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, message: "That is not a web address. Copy the whole address from the address bar." };
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "http:" || !loopback || !u.port) {
    return { ok: false, message: "That is not the sign-in address. After signing in, your browser ends on a page starting with http://localhost. Paste that one." };
  }
  if (!u.searchParams.has("code") && !u.searchParams.has("error")) {
    return { ok: false, message: "That address has no sign-in answer in it. Finish signing in first, then copy the address." };
  }
  return { ok: true, url: u.toString() };
}
