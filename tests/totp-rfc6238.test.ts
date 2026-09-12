import assert from "node:assert/strict";
import test from "node:test";
import {
  base32Decode,
  base32Encode,
  generateSecret,
  hotp,
  otpauthUrl,
  totp,
  totpCounter,
  verifyTotp,
  type TotpAlgorithm,
} from "../src/lib/totp";

/*
 * The published vectors, and nothing hand-rolled.
 *
 * Two-step verification is the one feature whose bugs are invisible until they
 * lock someone out of their own account: a truncation offset read from the
 * wrong byte, or a counter packed little-endian, still produces six plausible
 * digits that simply never match. RFC 4226 §5.3 (dynamic truncation) and the
 * 8-byte big-endian counter are exactly the two things the SHA-256 and SHA-512
 * rows below pin down — SHA-1 alone can pass with a wrong HMAC key length.
 */

/** Base32 of an ASCII seed, which is how the RFCs state their keys. */
function seed(ascii: string): string {
  return base32Encode(Buffer.from(ascii, "ascii"));
}

const SHA1_SEED = seed("12345678901234567890");
const SHA256_SEED = seed("12345678901234567890123456789012");
const SHA512_SEED = seed("1234567890123456789012345678901234567890123456789012345678901234");

test("RFC 4648 §10 base32 test vectors round-trip", () => {
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["f", "MY======"],
    ["fo", "MZXQ===="],
    ["foo", "MZXW6==="],
    ["foob", "MZXW6YQ="],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI======"],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain, "ascii")), encoded, plain);
    assert.equal(base32Decode(encoded).toString("ascii"), plain, encoded);
  }
  // Unpadded and lowercase are what people actually paste out of a password
  // manager; both must decode to the same bytes as the canonical form.
  assert.equal(base32Decode("mzxw6ytboi").toString("ascii"), "foobar");
  assert.equal(base32Decode("MZXW 6YTB OI").toString("ascii"), "foobar");
  assert.throws(() => base32Decode("MZXW6YTB1"), /Invalid base32/);
});

test("RFC 4226 Appendix D HOTP vectors", () => {
  const expected = [
    "755224", "287082", "359152", "969429", "338314",
    "254676", "287922", "162583", "399871", "520489",
  ];
  const key = base32Decode(SHA1_SEED);
  expected.forEach((code, counter) => {
    assert.equal(hotp(key, counter), code, `counter ${counter}`);
  });
});

test("RFC 6238 Appendix B TOTP vectors (SHA-1, SHA-256, SHA-512)", () => {
  // [T in seconds, SHA-1, SHA-256, SHA-512], 8 digits, 30-second step, T0 = 0.
  const vectors: Array<[number, string, string, string]> = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  const byAlgorithm: Array<[TotpAlgorithm, string, number]> = [
    ["sha1", SHA1_SEED, 1],
    ["sha256", SHA256_SEED, 2],
    ["sha512", SHA512_SEED, 3],
  ];

  for (const [seconds, ...codes] of vectors) {
    for (const [algorithm, secret, column] of byAlgorithm) {
      assert.equal(
        // The RFC states T in seconds; this module takes milliseconds.
        totp(secret, seconds * 1000, { algorithm, digits: 8 }),
        codes[column - 1],
        `${algorithm} @ T=${seconds}`
      );
    }
  }
});

test("the production profile is 6 digits on a 30-second step", () => {
  // T = 59 is inside the very first 30-second step after the epoch; T = 60 is
  // the step after it. If the counter were computed from milliseconds, or the
  // division rounded the wrong way, these two would collide.
  assert.equal(totpCounter(59_000), 1);
  assert.equal(totpCounter(60_000), 2);
  assert.equal(totp(SHA1_SEED, 59_000), "287082");
  assert.match(totp(generateSecret()), /^\d{6}$/);
});

test("verifyTotp accepts one step of drift either side and nothing beyond", () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  assert.equal(verifyTotp(secret, totp(secret, now), { atMs: now }), true);
  assert.equal(verifyTotp(secret, totp(secret, now - 30_000), { atMs: now }), true, "previous step");
  assert.equal(verifyTotp(secret, totp(secret, now + 30_000), { atMs: now }), true, "next step");
  assert.equal(verifyTotp(secret, totp(secret, now - 60_000), { atMs: now }), false, "two steps back");
  assert.equal(verifyTotp(secret, totp(secret, now + 60_000), { atMs: now }), false, "two steps on");
  // window: 0 is the strict setting a re-authentication prompt could use.
  assert.equal(verifyTotp(secret, totp(secret, now - 30_000), { atMs: now, window: 0 }), false);
});

test("verifyTotp rejects malformed input without throwing", () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5", "000000 "]) {
    assert.equal(verifyTotp(secret, bad, { atMs: now }), false, JSON.stringify(bad));
  }
  // Spaces inside a well-formed code are what an authenticator app displays.
  const code = totp(secret, now);
  assert.equal(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { atMs: now }), true);
  // A corrupt stored secret must fail closed, not throw into the sign-in path.
  assert.equal(verifyTotp("!!!not-base32!!!", code, { atMs: now }), false);
});

test("otpauthUrl carries the issuer in both places apps read it from", () => {
  const url = new URL(otpauthUrl({ secret: "JBSWY3DPEHPK3PXP", account: "a b@example.com", issuer: "Juno" }));
  assert.equal(url.protocol, "otpauth:");
  assert.equal(url.host, "totp");
  assert.equal(decodeURIComponent(url.pathname), "/Juno:a b@example.com");
  assert.equal(url.searchParams.get("issuer"), "Juno");
  assert.equal(url.searchParams.get("secret"), "JBSWY3DPEHPK3PXP");
  assert.equal(url.searchParams.get("digits"), "6");
  assert.equal(url.searchParams.get("period"), "30");
  assert.equal(url.searchParams.get("algorithm"), "SHA1");
  // Padding is stripped: several apps treat "=" as part of the secret.
  assert.equal(
    new URL(otpauthUrl({ secret: "MY======", account: "a@b.co", issuer: "Juno" })).searchParams.get("secret"),
    "MY"
  );
});

test("generateSecret is 160 bits of fresh randomness", () => {
  const secrets = new Set(Array.from({ length: 200 }, () => generateSecret()));
  assert.equal(secrets.size, 200, "secrets must not repeat");
  for (const secret of secrets) {
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(base32Decode(secret).length, 20);
  }
});
