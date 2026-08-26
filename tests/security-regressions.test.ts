import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

test("owner email addresses cannot be claimed through public credential registration", () => {
  const registration = source("src/app/api/auth/register/route.ts");
  assert.match(registration, /existing \|\| isOwnerEmail\(email\)/);
  assert.match(registration, /status: 201/);
  assert.doesNotMatch(registration, /account with this email already exists/i);
});

test("credential sign-in uses caller-account tuple limits and constant-time password work", () => {
  for (const file of ["src/lib/auth.ts", "src/lib/native-auth.ts"]) {
    const auth = source(file);
    assert.match(auth, /signin:pair:/);
    assert.match(auth, /verifyPasswordConstantTime/);
    assert.doesNotMatch(auth, /signin:email:/);
  }
});

test("native refresh-token reuse cannot mint a replacement token", () => {
  const nativeAuth = source("src/lib/native-auth.ts");
  assert.match(nativeAuth, /if \(current\.usedAt \|\| current\.revokedAt\)/);
  assert.doesNotMatch(nativeAuth, /withinGrace|NATIVE_REFRESH_REPLAY_GRACE_MS/);
});

test("production backend binds to loopback and the deployment guide does not expose port 3000", () => {
  const pkg = JSON.parse(source("package.json")) as { scripts: { start: string } };
  assert.equal(pkg.scripts.start, "next start -H 127.0.0.1");
  assert.doesNotMatch(source("deploy/VM_SETUP_GUIDE.md"), /--dport 3000/);
});

test("private object view URLs always use the authenticated application route", () => {
  const storage = source("src/lib/storage.ts");
  assert.match(storage, /return `\/api\/files\/\$\{key\}`/);
  assert.doesNotMatch(storage, /env\.s3\.publicUrl\.replace/);
});

test("security headers enforce CSP and suppress framework/proxy version banners", () => {
  const next = source("next.config.mjs");
  const middleware = source("src/middleware.ts");
  const nginx = source("deploy/nginx.conf.template");
  assert.match(next, /poweredByHeader:\s*false/);
  assert.match(middleware, /res\.headers\.set\("Content-Security-Policy", csp\)/);
  assert.doesNotMatch(middleware, /headers\.set\("Content-Security-Policy-Report-Only"/);
  assert.match(nginx, /server_tokens off/);
  assert.match(nginx, /proxy_hide_header X-Powered-By/);
});
