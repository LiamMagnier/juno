/**
 * The pieces of Antigravity's Google sign-in that Alevr owns (approach from
 * T3 Code's antigravityAuthSupport / antigravityCallback, MIT, re-implemented):
 *
 * - **A private profile per instance.** GEMINI_HOME points at
 *   `<dataDir>/providers/antigravity/<sha256(instance id)>`, with file-based
 *   token storage (AGY_ACP_FORCE_FILE_STORAGE) so each Alevr account keeps its
 *   own Google sign-in and nothing lands in the shared keychain. Alevr never
 *   reads the token file; it only checks that one exists.
 * - **No ambient Google credentials.** GEMINI_API_KEY, GOOGLE_* and gcloud
 *   project variables from the user's shell never reach the runtime; the
 *   instance's own method is the only one it sees.
 * - **No surprise browser.** BROWSER is a one-line Node helper that prints the
 *   URL the runtime wanted to open, so the client shows Google's page itself
 *   (and a remote web client can show it too).
 * - **The loopback callback.** Google returns to http://127.0.0.1:<port>/ on
 *   the runtime. A browser on this Mac finishes there directly; from another
 *   device the user pastes the redirect URL, which is validated against this
 *   flow's state and forwarded once, with no proxy and no redirects.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

export const AUTH_STDOUT_PREFIX = "Open the following link to authenticate the ACP server: ";
export const AUTH_BROWSER_MARKER = "__ALEVR_ANTIGRAVITY_AUTH_URL__";
export const SIGN_IN_REQUIRED = "Sign in to Antigravity with Google in Connections first.";
const MAX_URL = 16_384;

/** Variables the runtime must never inherit from the user's shell or an instance override. */
export const STRIPPED_ENV = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
]);

export interface AntigravityProfile {
  /** GEMINI_HOME. */
  geminiHome: string;
  acpDirectory: string;
  /** Where the runtime keeps this instance's Google token. Stat only. */
  tokenPath: string;
  /** Parent of the runtime's per-launch unpack directory (it unpacks ~1 GB per launch). */
  tempDirectory: string;
  browserCommand: string;
}

/** Per-instance directories; the id is hashed so case-only differences stay apart on APFS. */
export function profileDirectories(dataDir: string, instanceId: string): { profile: string; temp: string } {
  const key = crypto.createHash("sha256").update(instanceId).digest("hex");
  return {
    profile: path.join(dataDir, "providers", "antigravity", key),
    temp: path.join(dataDir, "antigravity-tmp", key.slice(0, 12)),
  };
}

// Python's webbrowser splits BROWSER on the path separator before it parses
// quotes, so the helper has no colon or semicolon anywhere. EPIPE exits 0 so
// Python never falls back to the system browser.
const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(` + `"${AUTH_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",` + `()=>process.exit(0))`;

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function browserCommand(nodePath: string): string {
  if (/[:;\r\n\0]|%s/.test(nodePath)) throw new Error("The Node path cannot be used for Antigravity's sign-in helper.");
  return [nodePath, "-e", browserHelperSource, "--", "%s"].map(quote).join(" ");
}

/** Creates the profile (0700) and its settings.json. Never reads or copies a credential. */
export function prepareProfile(dataDir: string, instanceId: string, nodePath = process.execPath): AntigravityProfile {
  const dirs = profileDirectories(dataDir, instanceId);
  const geminiHome = path.resolve(dirs.profile);
  const acpDirectory = path.join(geminiHome, "antigravity-acp");
  const tempDirectory = dirs.temp;
  for (const dir of [geminiHome, acpDirectory, tempDirectory]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  // auth.type names the method so the runtime's own logout clears only it.
  fs.writeFileSync(path.join(acpDirectory, "settings.json"), `${JSON.stringify({ auth: { type: "oauth-personal" } })}\n`, { mode: 0o600 });
  return { geminiHome, acpDirectory, tokenPath: path.join(acpDirectory, "acp_token.json"), tempDirectory, browserCommand: browserCommand(nodePath) };
}

/** Whether this instance has a saved Google sign-in (file present; never opened). */
export function hasSavedSignIn(dataDir: string, instanceId: string): boolean {
  const { profile } = profileDirectories(dataDir, instanceId);
  try {
    return fs.statSync(path.join(profile, "antigravity-acp", "acp_token.json")).isFile();
  } catch {
    return false;
  }
}

/** Removes a leftover unpack directory (a force-killed runtime leaves ~1 GB behind). */
export function cleanRuntimeTemp(dataDir: string, instanceId: string): void {
  const { temp } = profileDirectories(dataDir, instanceId);
  try {
    for (const entry of fs.readdirSync(temp)) fs.rmSync(path.join(temp, entry), { recursive: true, force: true });
  } catch {
    /* nothing to clean */
  }
}

/** The variables Alevr sets for the runtime, on top of the ACP client's allowlisted environment. */
export function runtimeEnv(profile: AntigravityProfile, harnessPath: string, overrides: Record<string, string> = {}): Record<string, string> {
  const own: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) if (!STRIPPED_ENV.has(k.toUpperCase())) own[k] = v;
  return {
    ...own,
    GEMINI_HOME: profile.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    ANTIGRAVITY_HARNESS_PATH: harnessPath,
    BROWSER: profile.browserCommand,
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
    TMPDIR: profile.tempDirectory,
  };
}

/** Checks the helper really prints instead of opening a browser (5 s). */
export async function verifyBrowserHelper(profile: AntigravityProfile, nodePath = process.execPath): Promise<void> {
  const probe = "https://example.invalid/alevr-antigravity-browser-check";
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(nodePath, ["-e", browserHelperSource, "--", probe], { env: { PATH: process.env.PATH ?? "", ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8").slice(0, 4096)));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8").slice(0, 4096)));
    child.on("error", () => resolve({ code: -1, stdout, stderr }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  if (output.code !== 0 || output.stdout !== "" || output.stderr !== `${AUTH_BROWSER_MARKER}${JSON.stringify(probe)}\n`) {
    throw new Error("Antigravity's sign-in helper could not be checked.");
  }
  void profile;
}

export interface AuthorizationRequest {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
}

/** Accepts only Google's own authorization endpoint with a 127.0.0.1 redirect (a port ≥ 1024). */
export function parseAuthorizationUrl(raw: string): AuthorizationRequest | null {
  if (raw.length > MAX_URL || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const state = url.searchParams.get("state");
  const redirectUri = url.searchParams.get("redirect_uri");
  if (
    url.origin !== "https://accounts.google.com" ||
    url.pathname !== "/o/oauth2/v2/auth" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.get("response_type") !== "code" ||
    !state ||
    state.length > 512 ||
    !redirectUri ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
  ) {
    return null;
  }
  const port = Number(new URL(redirectUri).port);
  if (port < 1024 || port > 65535) return null;
  return { authorizationUrl: raw, redirectUri, state };
}

/** The URL in one line of the runtime's stdout (its own prompt) or stderr (Alevr's browser helper), if any. */
export function authorizationUrlFromLine(line: string): string | undefined {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (text.length > MAX_URL + 128) return undefined;
  if (text.startsWith(AUTH_STDOUT_PREFIX)) return text.slice(AUTH_STDOUT_PREFIX.length).trim();
  if (text.startsWith(AUTH_BROWSER_MARKER)) {
    try {
      const value = JSON.parse(text.slice(AUTH_BROWSER_MARKER.length)) as unknown;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class CallbackError extends Error {}

/** Only this flow's own redirect may be forwarded: same origin and path, one state, one code (or one error), Google as issuer. */
export function validateCallbackUrl(pending: Pick<AuthorizationRequest, "redirectUri" | "state">, callbackUrl: string): URL {
  if (callbackUrl.length > MAX_URL) throw new CallbackError("The sign-in response URL is too long.");
  let callback: URL;
  try {
    callback = new URL(callbackUrl.trim());
  } catch {
    throw new CallbackError("Paste the complete address from the page Google sent you to.");
  }
  const expected = new URL(pending.redirectUri);
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash
  ) {
    throw new CallbackError("This address does not belong to the current sign-in.");
  }
  const states = callback.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== pending.state) throw new CallbackError("This address does not belong to the current sign-in.");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  if (!((codes.length === 1 && codes[0] && errors.length === 0) || (errors.length === 1 && errors[0] && codes.length === 0))) {
    throw new CallbackError("The address must hold exactly one Google sign-in response.");
  }
  const issuers = callback.searchParams.getAll("iss");
  if (issuers.length > 1 || (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")) {
    throw new CallbackError("This address is not a Google sign-in response.");
  }
  return callback;
}

/** One GET to the runtime's loopback listener: no proxy, no redirects, nothing logged. */
export function forwardCallback(callback: URL, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new CallbackError("Could not deliver the sign-in response. Start sign-in again."));
    const request = http.request(
      { protocol: "http:", hostname: callback.hostname, port: callback.port, path: `${callback.pathname}${callback.search}`, method: "GET", agent: false },
      (response) => {
        response.once("error", failed);
        response.once("end", () => {
          clearTimeout(timer);
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 400) resolve();
          else failed();
        });
        response.resume();
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      reject(new CallbackError("The sign-in response timed out. Start sign-in again."));
    }, timeoutMs);
    request.once("error", () => {
      clearTimeout(timer);
      failed();
    });
    request.end();
  });
}
