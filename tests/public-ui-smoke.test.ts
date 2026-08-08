import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  checkPublicUi,
  checkPublicUiMatrix,
  PUBLIC_ROUTES,
} from "../scripts/public-ui-smoke.mjs";
import { UI_PROFILES } from "../scripts/public-ui-matrix.mjs";
import {
  EXPECTED_UI_STATE_IDS,
  UI_SHARED_PREFERENCE_CONTRACT,
  UI_STATE_FIXTURES,
} from "./fixtures/public-ui-state-matrix";

const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
};

function bodyFor(route: string): string {
  if (route === "/") return "<main><h1>Every frontier model</h1></main>";
  if (route === "/sign-in") return '<main><h1>Welcome back</h1><input id="email"><input id="password"></main>';
  if (route === "/sign-up") return '<main><h1>Create your account</h1><input id="email"><input id="password"></main>';
  if (route === "/forgot-password") return '<main><h1>Reset your password</h1><input placeholder="you@example.com"></main>';
  return "<main>legal</main>";
}

type SeenRequest = {
  path: string;
  viewportWidth?: string;
  mobile?: string;
  colorScheme?: string;
  reducedMotion?: string;
};

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function startServer(
  omitHeaderFor?: string,
  seen: SeenRequest[] = [],
): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    seen.push({
      path: request.url ?? "/",
      viewportWidth: firstHeader(request.headers, "viewport-width"),
      mobile: firstHeader(request.headers, "sec-ch-ua-mobile"),
      colorScheme: firstHeader(request.headers, "sec-ch-prefers-color-scheme"),
      reducedMotion: firstHeader(request.headers, "x-juno-test-reduced-motion"),
    });
    if (request.url === "/chat") {
      response.writeHead(307, { ...SECURITY_HEADERS, location: "/sign-in" });
      response.end();
      return;
    }
    const headers: Record<string, string> = { ...SECURITY_HEADERS };
    if (request.url === omitHeaderFor) delete headers["x-frame-options"];
    response.writeHead(200, headers);
    response.end(bodyFor(request.url ?? "/"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test("public UI smoke checks public routes and the private auth boundary", async () => {
  const { server, origin } = await startServer();
  try {
    await checkPublicUi(origin);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("public UI smoke fails when a security header disappears", async () => {
  const { server, origin } = await startServer("/sign-in");
  try {
    await assert.rejects(() => checkPublicUi(origin), /sign-in is missing x-frame-options/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("public UI matrix carries every viewport and preference profile through every route", async () => {
  const seen: SeenRequest[] = [];
  const { server, origin } = await startServer(undefined, seen);
  try {
    await checkPublicUiMatrix(origin);
    const expectedPaths = [...PUBLIC_ROUTES.map((route) => route.path), "/chat"];
    assert.equal(seen.length, UI_PROFILES.length * expectedPaths.length);
    for (const profile of UI_PROFILES) {
      for (const route of expectedPaths) {
        const requests = seen.filter(
          (request) =>
            request.path === route &&
            request.viewportWidth === String(profile.width) &&
            request.colorScheme === profile.colorScheme &&
            request.reducedMotion === (profile.reducedMotion ? "1" : "0"),
        );
        assert.equal(requests.length, 1, `${profile.id} should request ${route} exactly once`);
        assert.equal(requests[0]?.mobile, profile.id.startsWith("phone-") ? "?1" : "?0");
        assert.equal(requests[0]?.colorScheme, profile.colorScheme);
        assert.equal(requests[0]?.reducedMotion, profile.reducedMotion ? "1" : "0");
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("UI state fixtures keep their semantic, responsive, and preference contracts", () => {
  assert.deepEqual(
    UI_STATE_FIXTURES.map((fixture) => fixture.id),
    EXPECTED_UI_STATE_IDS,
  );
  for (const fixture of UI_STATE_FIXTURES) {
    const source = fixture.sources
      .map((relativePath) => readFileSync(path.join(process.cwd(), relativePath), "utf8"))
      .join("\n");
    for (const marker of fixture.required) assert.match(source, marker, `${fixture.id} lost ${marker}`);
    for (const marker of fixture.responsive) assert.match(source, marker, `${fixture.id} lost ${marker}`);
  }

  const preferenceSource = readFileSync(path.join(process.cwd(), UI_SHARED_PREFERENCE_CONTRACT.source), "utf8");
  for (const marker of UI_SHARED_PREFERENCE_CONTRACT.required) assert.match(preferenceSource, marker);
});
