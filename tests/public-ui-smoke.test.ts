import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { checkPublicUi } from "../scripts/public-ui-smoke.mjs";

const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
};

function bodyFor(route: string): string {
  if (route === "/") return "<main><h1>Every frontier model</h1></main>";
  if (route === "/sign-in") return '<h1>Welcome back</h1><input id="email"><input id="password">';
  if (route === "/sign-up") return '<h1>Create your account</h1><input id="email"><input id="password">';
  if (route === "/forgot-password") return '<h1>Reset your password</h1><input placeholder="you@example.com">';
  return "<main>legal</main>";
}

async function startServer(omitHeaderFor?: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
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
