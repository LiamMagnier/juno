import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
const join = path.join;
import test from "node:test";
import {
  EMAIL_VERIFICATION_TTL_MS,
  RECOVERY_CODE_COUNT,
  constantTimeEquals,
  hashRecoveryCode,
} from "@/lib/account-security";

/*
 * Account security: the rules that must not quietly regress.
 *
 * Half of these are ordinary unit tests. The other half read the source,
 * because what they are protecting is an ORDER or an ABSENCE — the second
 * factor checked after the password and not before, a refusal that returns
 * before any quota is spent, a guard with no way round it — and those are
 * invisible to a test that only calls the function and looks at the answer.
 * tests/admin-security.test.ts established the idiom here.
 */

const ROOT = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

// ----------------------------------------------------------------------------
// Recovery codes
// ----------------------------------------------------------------------------

test("recovery code hashing ignores the formatting a human types", () => {
  const canonical = hashRecoveryCode("ABCDE-FGHIJ");
  assert.equal(hashRecoveryCode("abcde-fghij"), canonical, "case");
  assert.equal(hashRecoveryCode("ABCDEFGHIJ"), canonical, "no separator");
  assert.equal(hashRecoveryCode(" abcde fghij "), canonical, "spaces");
  assert.match(canonical, /^[a-f0-9]{64}$/);
  // The digest must not be the code, or storing it would be storing the code.
  assert.notEqual(canonical, "ABCDE-FGHIJ");
  assert.notEqual(hashRecoveryCode("ABCDE-FGHIK"), canonical, "different codes collide");
});

test("ten recovery codes, and a 24-hour verification link", () => {
  assert.equal(RECOVERY_CODE_COUNT, 10);
  assert.equal(EMAIL_VERIFICATION_TTL_MS, 24 * 60 * 60 * 1000);
});

test("constantTimeEquals compares unequal lengths without throwing", () => {
  assert.equal(constantTimeEquals("abc", "abc"), true);
  assert.equal(constantTimeEquals("abc", "abcd"), false);
  assert.equal(constantTimeEquals("", ""), true);
  assert.equal(constantTimeEquals("a", ""), false);
});

// ----------------------------------------------------------------------------
// Secrets at rest
// ----------------------------------------------------------------------------

test("the TOTP secret is sealed with the message keyring, never written raw", () => {
  const lib = source("src/lib/account-security.ts");
  assert.match(lib, /encryptMessageText/, "seal path");
  assert.match(lib, /decryptMessageText/, "open path");
  assert.match(lib, /totpSecret: sealSecret\(secret\)/, "enrolment must store the sealed value");
  // A raw assignment would be the one-character version of this bug.
  assert.doesNotMatch(lib, /totpSecret:\s*secret\b/);

  const schema = source("prisma/schema.prisma");
  assert.match(schema, /totpSecret\s+String\?/);
  assert.match(schema, /totpEnabledAt\s+DateTime\?/);
  assert.match(schema, /model MfaRecoveryCode \{/);
  assert.match(schema, /codeHash\s+String\s+@unique/);
});

test("no route ever returns or logs the stored secret", () => {
  for (const file of [
    "src/app/api/account/mfa/route.ts",
    "src/app/api/account/mfa/confirm/route.ts",
    "src/app/api/account/mfa/disable/route.ts",
    "src/app/api/auth/mfa/challenge/route.ts",
  ]) {
    assert.doesNotMatch(source(file), /totpSecret/, file);
  }
});

// ----------------------------------------------------------------------------
// Sign-in
// ----------------------------------------------------------------------------

test("the second factor is checked after the password, never before", () => {
  const auth = source("src/lib/auth.ts");
  const passwordCheck = auth.indexOf("if (!ok) return null;");
  const factorCheck = auth.indexOf("await verifySecondFactor(");
  assert.ok(passwordCheck > 0 && factorCheck > passwordCheck, "order: password, then second factor");
  // Enforcement keys off the enabled timestamp, so a pending (unconfirmed)
  // enrolment cannot lock anyone out of their own account.
  assert.match(auth, /if \(user\.totpEnabledAt\) \{/);
  assert.match(auth, /if \(!code\) return null;/);
});

test("the MFA pre-flight spends the sign-in rate limit and answers uniformly", () => {
  const route = source("src/app/api/auth/mfa/challenge/route.ts");
  // The SAME buckets as src/lib/auth.ts: a pre-flight must not be a free
  // tranche of password guesses against two-step accounts.
  assert.match(route, /signin:pair:\$\{ip\}:\$\{email\}/);
  assert.match(route, /signin:ip:\$\{ip\}/);
  assert.match(route, /verifyPasswordConstantTime/, "always hashes, even with no account");
  assert.match(route, /equalizeResponseTime/, "response-time floor");
  // Exactly one place says true, and it is after every check has passed.
  const trues = route.match(/mfaRequired: true/g) ?? [];
  assert.equal(trues.length, 1);
  assert.ok(
    route.indexOf("mfaRequired: true") > route.lastIndexOf("if (!user?.hashedPassword"),
    "true is only reachable past the password check"
  );
  // No branch distinguishes an unknown account from a wrong password.
  assert.doesNotMatch(route, /status: 40[0-9]/);
});

test("the sign-in form renders a provider button only behind its own flag", () => {
  const form = source("src/components/auth/auth-form.tsx");
  assert.match(form, /googleEnabled && \(/);
  assert.match(form, /appleEnabled && \(/);
  assert.match(form, /emailLinkEnabled && \(/);
  // The flags come from the server, never from a client-side env guess.
  assert.doesNotMatch(form, /process\.env/);

  for (const page of ["src/app/(auth)/sign-in/page.tsx", "src/app/(auth)/sign-up/page.tsx"]) {
    const src = source(page);
    assert.match(src, /googleEnabled=\{isGoogleConfigured\(\)\}/, page);
    assert.match(src, /appleEnabled=\{isAppleConfigured\(\)\}/, page);
    assert.match(src, /emailLinkEnabled=\{isEmailLinkConfigured\(\)\}/, page);
  }

  const auth = source("src/lib/auth.ts");
  assert.match(auth, /AUTH_APPLE_ID && process\.env\.AUTH_APPLE_SECRET/);
  assert.match(auth, /RESEND_API_KEY && process\.env\.EMAIL_FROM/);
  assert.match(auth, /if \(isAppleConfigured\(\)\) \{/);
  assert.match(auth, /if \(isEmailLinkConfigured\(\)\) \{/);
});

// ----------------------------------------------------------------------------
// Sessions
// ----------------------------------------------------------------------------

test("a stale sessionVersion is rejected, and both paths that bump it do so", () => {
  const auth = source("src/lib/auth.ts");
  assert.match(auth, /token\.sessionVersion = account\?\.sessionVersion \?\? 0/, "issued into the JWT");
  assert.match(auth, /if \(u\.sessionVersion !== issuedVersion\)/, "re-checked on every session read");

  assert.match(
    source("src/lib/account-security.ts"),
    /sessionVersion: \{ increment: 1 \}/,
    "sign out everywhere"
  );
  assert.match(
    source("src/app/api/account/password/route.ts"),
    /sessionVersion: \{ increment: 1 \}/,
    "password change"
  );
  assert.match(source("src/app/api/account/sessions/revoke/route.ts"), /revokeAllSessions\(user\.id\)/);
});

// ----------------------------------------------------------------------------
// Email verification
// ----------------------------------------------------------------------------

test("the migration backfills emailVerified for every existing account", () => {
  const migration = source("prisma/migrations/20260912130000_account_security/migration.sql");
  assert.match(
    migration,
    /UPDATE "User" SET "emailVerified" = "createdAt" WHERE "emailVerified" IS NULL;/,
    "without this, the spend gate locks out every account that already exists"
  );
  assert.match(migration, /ADD COLUMN "totpSecret" TEXT/);
  assert.match(migration, /CREATE TABLE "MfaRecoveryCode"/);
  assert.match(migration, /ON DELETE CASCADE/, "recovery codes die with the account");
});

test("consumeMessage refuses an unverified address before spending anything", () => {
  const usage = source("src/lib/usage.ts");
  const gate = usage.indexOf('reason: "email_unverified"');
  const increment = usage.indexOf("messageCount: { increment: 1 }");
  assert.ok(gate > 0, "the refusal exists");
  assert.ok(gate < increment, "and returns before any increment");
  assert.match(usage, /export type ConsumeRefusal = "quota_exceeded" \| "email_unverified"/);
  assert.match(usage, /select: \{ emailVerified: true \}/);
});

test("registration verifies immediately when mail is not configured", () => {
  const register = source("src/app/api/auth/register/route.ts");
  assert.match(register, /if \(isEmailEnabled\(\)\) \{/);
  assert.match(register, /sendEmailVerification/);
  assert.match(register, /markEmailVerified\(user\.id\)/, "a fresh checkout must still be able to spend");
  assert.match(register, /console\.warn\(/, "and must say so");

  // Google / Apple / magic-link sign-ups are verified as the account is made.
  assert.match(
    source("src/lib/auth.ts"),
    /updateMany\(\{ where: \{ id: user\.id, emailVerified: null \}, data: \{ emailVerified: new Date\(\) \} \}\)/
  );
});

// ----------------------------------------------------------------------------
// Owner + admin
// ----------------------------------------------------------------------------

test("the owner guard fails closed until two-step is enrolled", () => {
  const admin = source("src/lib/admin.ts");
  assert.match(admin, /if \(!account\?\.totpEnabledAt\) return \{ ok: false, reason: "mfa_required", user \}/);
  // getOwnerUser keeps its shape, so every /api/admin route fails closed
  // without being touched; requireOwnerApi is what names the reason.
  assert.match(admin, /return access\.ok \? access\.user : null;/);
  assert.match(admin, /error: "mfa_required"/);
  assert.match(admin, /export async function requireOwnerPage/);

  const layout = source("src/app/(app)/admin/layout.tsx");
  assert.match(layout, /if \(mfaRequired\) return <AdminMfaRequired \/>;/);
  // The prompt replaces children — it is not drawn above a working panel.
  assert.ok(layout.indexOf("AdminMfaRequired") < layout.indexOf("return children"));
});

// ----------------------------------------------------------------------------
// Endpoint hygiene
// ----------------------------------------------------------------------------

test("every new account/auth endpoint is rate-limited and scoped to its caller", () => {
  const authenticated = [
    "src/app/api/account/mfa/route.ts",
    "src/app/api/account/mfa/start/route.ts",
    "src/app/api/account/mfa/confirm/route.ts",
    "src/app/api/account/mfa/disable/route.ts",
    "src/app/api/account/password/route.ts",
    "src/app/api/account/email/route.ts",
    "src/app/api/account/verification/route.ts",
    "src/app/api/account/sessions/revoke/route.ts",
  ];
  for (const file of authenticated) {
    const route = source(file);
    assert.match(route, /rateLimit\(\{/, `${file} must be rate-limited`);
    assert.match(route, /const user = await getCurrentUser\(\)/, `${file} must resolve the caller`);
    assert.match(
      route,
      /if \(!user\) return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\)/,
      `${file} must refuse an anonymous caller`
    );
    // Every write names the session's own user id — never an id from the body.
    assert.doesNotMatch(route, /userId: parsed\.data/, file);
  }

  for (const file of ["src/app/api/auth/mfa/challenge/route.ts", "src/app/api/auth/verify-email/route.ts"]) {
    assert.match(source(file), /rateLimit\(\{/, `${file} must be rate-limited`);
  }
});

test("the change-email flow writes nothing until the new address is proved", () => {
  const route = source("src/app/api/account/email/route.ts");
  // The only user write in this route would be a bug: the address is adopted
  // by consumeEmailToken when the link is opened, and nowhere else.
  assert.doesNotMatch(route, /prisma\.user\.update/);
  assert.match(route, /issueEmailToken\("change", user\.id, email\)/);
  assert.match(route, /verifyPasswordConstantTime/, "a stolen session must not move the address");

  const lib = source("src/lib/account-security.ts");
  assert.match(lib, /data: \{ email: parsed\.email, emailVerified: new Date\(\) \}/);
  assert.match(lib, /EMAIL_TOKEN_ALREADY_CONSUMED/, "single use");
});

/*
 * The native app must not be a way around two-step verification.
 *
 * Enrolment happens on the web, so before this the phone was the hole: the
 * same email and password that the browser would now challenge still bought a
 * bearer token from /api/v1/auth/password, and that token is a full session.
 * These are source assertions rather than a live sign-in because the route's
 * dependencies (Prisma, the password module, the keyring) are the whole
 * server; what matters is the ORDER of the checks, which is what a reader
 * would get wrong.
 */
test("native password sign-in enforces the second factor after the password", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/native-auth.ts"),
    "utf8",
  );

  assert.match(source, /totpEnabledAt: true/, "the query must select totpEnabledAt");
  assert.match(
    source,
    /verifySecondFactor\(user\.id, input\.code \?\? ""\)/,
    "it must verify the submitted code against the account",
  );
  assert.match(source, /"mfa_required"/, "it must answer mfa_required, not a generic invalid_grant");

  // A wrong password must never reach the second factor: recovery codes are
  // single-use, so checking them first would let an attacker burn all ten
  // without ever knowing the password.
  const passwordCheck = source.indexOf("if (!ok) throw invalid();");
  const factorCheck = source.indexOf("if (user.totpEnabledAt)");
  assert.ok(passwordCheck > 0 && factorCheck > passwordCheck,
    "the second factor must be checked after the password");

  // And a banned account must still be refused before either.
  const banCheck = source.indexOf("if (user.bannedAt) throw invalid();");
  assert.ok(banCheck > 0 && factorCheck > banCheck,
    "a banned account must be refused before the second factor runs");
});

test("the native contract carries the optional code field", () => {
  const contract = readFileSync(
    join(process.cwd(), "contracts/openapi/juno-native-v1.yaml"),
    "utf8",
  );
  const schema = contract.slice(contract.indexOf("PasswordSignInRequest:"));
  const body = schema.slice(0, schema.indexOf("RefreshResponse:"));
  assert.match(body, /code: \{ type: string/, "the request schema must accept a code");
  assert.doesNotMatch(
    body,
    /required: \[[^\]]*code/,
    "code must stay optional so a shipped client that never sends it keeps working",
  );
});

test("a refused turn says which refusal it was", () => {
  const usage = readFileSync(join(process.cwd(), "src/lib/usage.ts"), "utf8");
  assert.match(usage, /export function consumeRefusalBody/);
  assert.match(usage, /EMAIL_UNVERIFIED/);

  // Every route that spends a message must use it, or an unverified user is
  // told to buy a bigger plan to fix a problem money cannot fix.
  for (const route of [
    "src/app/api/chat/route.ts",
    "src/app/api/generate/route.ts",
    "src/app/api/design/[artifactId]/edit/route.ts",
  ]) {
    const source = readFileSync(join(process.cwd(), route), "utf8");
    assert.match(source, /consumeRefusalBody/, `${route} must use the shared refusal body`);
    assert.doesNotMatch(
      source,
      /error: "You've reached your monthly/,
      `${route} must not hand-roll the refusal sentence`,
    );
  }
});
