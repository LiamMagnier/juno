import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCsrf } from "../src/lib/csrf.js";

test("CSRF: Safe HTTP methods (GET, HEAD, OPTIONS) pass unconditionally", () => {
  const getResult = evaluateCsrf({
    method: "GET",
    pathname: "/api/chat",
    host: "app.juno.ai",
    origin: null,
    hasSessionCookie: true,
    hasBearerToken: false,
  });
  assert.equal(getResult.allowed, true);
  assert.equal(getResult.status, 200);
});

test("CSRF: Cookie-authenticated mutating request with valid Origin passes", () => {
  const result = evaluateCsrf({
    method: "POST",
    pathname: "/api/chat",
    host: "app.juno.ai",
    origin: "https://app.juno.ai",
    hasSessionCookie: true,
    hasBearerToken: false,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.status, 200);
});

test("CSRF: Cookie-authenticated mutating request from cross-origin origin is rejected", () => {
  const result = evaluateCsrf({
    method: "POST",
    pathname: "/api/chat",
    host: "app.juno.ai",
    origin: "https://evil-attacker.com",
    hasSessionCookie: true,
    hasBearerToken: false,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 403);
  assert.ok(result.reason?.includes("Cross-origin request rejected"));
});

test("CSRF: Cookie-authenticated mutating request missing Origin without Sec-Fetch-Site is rejected", () => {
  const result = evaluateCsrf({
    method: "POST",
    pathname: "/api/chat",
    host: "app.juno.ai",
    origin: null,
    secFetchSite: null,
    hasSessionCookie: true,
    hasBearerToken: false,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 403);
  assert.ok(result.reason?.includes("Missing Origin header"));
});

test("CSRF: Bearer-authenticated native app / API requests pass without Origin", () => {
  const result = evaluateCsrf({
    method: "POST",
    pathname: "/api/v1/chat",
    host: "app.juno.ai",
    origin: null,
    hasSessionCookie: false,
    hasBearerToken: true,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.status, 200);
});

test("CSRF: Exempt webhooks and auth handlers pass without Origin", () => {
  const webhookResult = evaluateCsrf({
    method: "POST",
    pathname: "/api/stripe/webhook",
    host: "app.juno.ai",
    origin: null,
    hasSessionCookie: false,
    hasBearerToken: false,
  });
  assert.equal(webhookResult.allowed, true);
});
