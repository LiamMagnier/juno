#!/usr/bin/env node

/**
 * Read-only public UI smoke gate.
 *
 * This is deliberately HTTP-level rather than browser automation: it proves
 * that the public entry points render real HTML, keep the security headers,
 * and protect an authenticated route after a deploy. Browser and visual
 * journeys remain a separate, credentialed release gate.
 */

import { UI_PROFILES, headersForUiProfile } from "./public-ui-matrix.mjs";

const baseUrl = (process.env.JUNO_PUBLIC_UI_BASE_URL ?? process.env.JUNO_SMOKE_BASE_URL ?? "").replace(/\/$/, "");
const timeoutMs = Number(process.env.JUNO_PUBLIC_UI_TIMEOUT_MS ?? 20_000);

const SECURITY_HEADERS = [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "sameorigin"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["strict-transport-security", "max-age="],
];

export const PUBLIC_ROUTES = [
  { path: "/", markers: [/<main\b/i, /<h1\b/i, /Every frontier model/i] },
  { path: "/sign-in", markers: [/<main\b/i, /Welcome back/i, /id=["']email["']/i, /id=["']password["']/i] },
  { path: "/sign-up", markers: [/<main\b/i, /Create your account/i, /id=["']email["']/i, /id=["']password["']/i] },
  { path: "/forgot-password", markers: [/<main\b/i, /Reset your password/i, /you@example\.com/i] },
  { path: "/legal/confidentialite", markers: [/<main\b/i] },
  { path: "/legal/cgu", markers: [/<main\b/i] },
  { path: "/legal/mentions-legales", markers: [/<main\b/i] },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchWithTimeout(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "manual",
      headers: { Accept: "text/html", ...extraHeaders },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function checkSecurityHeaders(response, route) {
  for (const [name, expected] of SECURITY_HEADERS) {
    const value = response.headers.get(name)?.toLowerCase() ?? "";
    assert(value.includes(expected), `${route} is missing ${name}: ${value || "absent"}`);
  }
}

export async function checkPublicUi(origin = baseUrl, { profile } = {}) {
  assert(origin, "JUNO_PUBLIC_UI_BASE_URL or JUNO_SMOKE_BASE_URL is required");
  const requestHeaders = profile ? headersForUiProfile(profile) : {};

  for (const route of PUBLIC_ROUTES) {
    const response = await fetchWithTimeout(`${origin}${route.path}`, requestHeaders);
    assert(response.ok, `${route.path} returned HTTP ${response.status}`);
    assert(
      response.headers.get("content-type")?.toLowerCase().includes("text/html"),
      `${route.path} did not return HTML`,
    );
    checkSecurityHeaders(response, route.path);
    const body = await response.text();
    assert(!/Application error|Internal Server Error|NEXT_NOT_FOUND/i.test(body), `${route.path} rendered an application error`);
    for (const marker of route.markers) {
      assert(marker.test(body), `${route.path} is missing its required UI marker ${marker}`);
    }
    console.log(`PASS public UI ${route.path}`);
  }

  const privateResponse = await fetchWithTimeout(`${origin}/chat`, requestHeaders);
  assert(
    [301, 302, 303, 307, 308].includes(privateResponse.status),
    `/chat returned HTTP ${privateResponse.status} instead of an auth redirect`,
  );
  const location = privateResponse.headers.get("location") ?? "";
  assert(/\/sign-in(?:[/?]|$)/.test(location), `/chat redirect does not target sign-in: ${location || "absent"}`);
  checkSecurityHeaders(privateResponse, "/chat");
  console.log("PASS auth boundary /chat");
}

/**
 * Runs the existing public smoke against every request profile.
 *
 * This remains opt-in rather than changing the post-deploy command's request
 * volume. The local matrix test uses it to prove that the smoke helper carries
 * all profiles through every public route and the auth boundary.
 */
export async function checkPublicUiMatrix(origin = baseUrl) {
  assert(origin, "JUNO_PUBLIC_UI_BASE_URL or JUNO_SMOKE_BASE_URL is required");
  for (const profile of UI_PROFILES) {
    await checkPublicUi(origin, { profile });
  }
}

const invokedAsScript = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (invokedAsScript) {
  checkPublicUi().catch((error) => {
    console.error(`FAIL public UI smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
