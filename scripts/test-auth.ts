import assert from "node:assert/strict";
import {
  createPasswordResetToken,
  hashPasswordResetToken,
  PASSWORD_RESET_TTL_MS,
  passwordResetIdentifier,
  userIdFromPasswordResetIdentifier,
} from "../src/lib/password-reset";
import { directionOf, localeFromAcceptLanguage, normalizeWebLocale } from "../src/lib/i18n";

const tokens = new Set(Array.from({ length: 100 }, createPasswordResetToken));
assert.equal(tokens.size, 100, "reset tokens must be unique");
for (const token of tokens) {
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(hashPasswordResetToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashPasswordResetToken(token), token);
}

const identifier = passwordResetIdentifier("user_123");
assert.equal(userIdFromPasswordResetIdentifier(identifier), "user_123");
assert.equal(userIdFromPasswordResetIdentifier("other:user_123"), null);
assert.equal(PASSWORD_RESET_TTL_MS, 60 * 60 * 1000);

assert.equal(localeFromAcceptLanguage("fr-FR, fr;q=0.9, en;q=0.8"), "fr-FR");
assert.equal(localeFromAcceptLanguage("xx, ar-SA;q=0.8"), "ar-SA");
assert.equal(normalizeWebLocale("pt_BR"), "pt-BR");
assert.equal(normalizeWebLocale("not-a-locale"), null);
assert.equal(directionOf("ar-SA"), "rtl");
assert.equal(directionOf("fr-FR"), "ltr");

console.log("Auth and locale helper tests passed.");
