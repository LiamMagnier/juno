import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, createHmac } from "crypto";
import { env } from "@/lib/env";

/*
 * Small AES-256-GCM helper for encrypting OAuth tokens at rest. The key is
 * derived from AUTH_SECRET (already required in every deployment), so no extra
 * key management is needed. Format: base64(iv).base64(tag).base64(ciphertext).
 */

function key(): Buffer {
  return createHash("sha256").update(`juno:connector:${env.authSecret}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** Sign a short-lived OAuth state token: base64url(payload).hmac. */
export function signState(payload: string): string {
  const body = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", env.authSecret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** Verify + decode a signed state token; returns null if tampered/invalid. */
export function verifyState(token: string): string | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", env.authSecret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(body, "base64url").toString("utf8");
}
