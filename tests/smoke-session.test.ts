import assert from "node:assert/strict";
import test from "node:test";
import { encode } from "@auth/core/jwt";
import { readSessionCookieClaims, sessionTokenFromCookieHeader } from "../src/lib/smoke-session";

const secret = "smoke-session-test-secret-with-enough-entropy";

test("an expired Auth.js session cookie still names its account, and only for the right secret", async () => {
  const name = "__Secure-authjs.session-token";
  const token = await encode({ token: { sub: "user_smoke", email: "smoke@juno.test" }, secret, salt: name, maxAge: -60 });
  const header = `other=1; ${name}=${encodeURIComponent(token)}; theme=dark`;
  assert.equal(sessionTokenFromCookieHeader(header)?.token, token);
  const claims = await readSessionCookieClaims({ cookieHeader: header, secret });
  assert.equal(claims?.userId, "user_smoke");
  assert.equal(claims?.email, "smoke@juno.test");
  assert.equal(claims?.expired, true);
  await assert.rejects(readSessionCookieClaims({ cookieHeader: header, secret: "a-different-secret-entirely-1234567890" }));
  assert.equal(await readSessionCookieClaims({ cookieHeader: "theme=dark", secret }), null);
});

test("a chunked session cookie is reassembled", async () => {
  const name = "authjs.session-token";
  const token = await encode({ token: { sub: "user_chunks" }, secret, salt: name, maxAge: 60 });
  const half = Math.ceil(token.length / 2);
  const header = `${name}.0=${token.slice(0, half)}; ${name}.1=${token.slice(half)}`;
  const claims = await readSessionCookieClaims({ cookieHeader: header, secret });
  assert.equal(claims?.userId, "user_chunks");
  assert.equal(claims?.expired, false);
});
