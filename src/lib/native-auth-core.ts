import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, errors as joseErrors, jwtVerify } from "jose";

export const NATIVE_REDIRECT_URI = "com.liammagnier.juno://auth/callback";
export const LEGACY_NATIVE_REDIRECT_URI = "juno://auth/callback";
const NATIVE_REDIRECT_URIS = new Set([NATIVE_REDIRECT_URI, LEGACY_NATIVE_REDIRECT_URI]);
export const NATIVE_ACCESS_AUDIENCE = "juno-native";
export const NATIVE_ACCESS_TTL_SECONDS = 10 * 60;
export const NATIVE_AUTH_CODE_TTL_MS = 2 * 60 * 1000;
export const NATIVE_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long after a refresh token is consumed a replay of it is still treated as
 * the same rotation rather than as an attack.
 *
 * Rotation is only durable on the client *after* the response arrives, so every
 * rotation has a window in which the server has consumed the old token and the
 * client still holds it: quit the app, lose the response, drop the connection,
 * and the device wakes up holding a token the server has already marked used.
 * With no grace that replay revoked the whole family, and the only way back was
 * signing in again — which is exactly what it felt like, because quitting the
 * app is the most reliable way to cancel an in-flight refresh.
 *
 * The window is only half the rule; see `rotateNativeRefreshToken`, which also
 * requires that the successor was never used. A replay whose successor the
 * client demonstrably received is still reuse, whenever it arrives.
 */
export const NATIVE_REFRESH_REPLAY_GRACE_MS = 60 * 1000;

const BASE64URL_256 = /^[A-Za-z0-9_-]{43,256}$/;
const INSTALLATION_ID = /^[A-Za-z0-9._:-]{16,200}$/;

export type NativeAccessClaims = {
  userId: string;
  deviceSessionId: string;
  sessionVersion: number;
  expiresAt: Date;
};

export class NativeTokenError extends Error {
  constructor(public readonly code: "invalid" | "expired", message: string) {
    super(message);
    this.name = "NativeTokenError";
  }
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function pkceChallenge(verifier: string): string {
  return hashSecret(verifier);
}

export function isValidBrowserAuthorization(input: {
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  installationId: string;
}): boolean {
  return (
    BASE64URL_256.test(input.state) &&
    BASE64URL_256.test(input.nonce) &&
    BASE64URL_256.test(input.codeChallenge) &&
    input.codeChallengeMethod === "S256" &&
    NATIVE_REDIRECT_URIS.has(input.redirectUri) &&
    INSTALLATION_ID.test(input.installationId)
  );
}

export function isValidCodeVerifier(value: string): boolean {
  return BASE64URL_256.test(value);
}

export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function accessKey(secret: string): Uint8Array {
  return createHash("sha256").update(`juno-native-access-v1\0${secret}`).digest();
}

export async function signNativeAccessToken(input: {
  authSecret: string;
  issuer: string;
  userId: string;
  deviceSessionId: string;
  sessionVersion: number;
  now?: Date;
}): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = new Date((issuedAt + NATIVE_ACCESS_TTL_SECONDS) * 1000);
  const token = await new SignJWT({
    sid: input.deviceSessionId,
    sv: input.sessionVersion,
    typ: "native_access",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(input.issuer)
    .setAudience(NATIVE_ACCESS_AUDIENCE)
    .setSubject(input.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(accessKey(input.authSecret));
  return { token, expiresAt };
}

export async function verifyNativeAccessToken(input: {
  token: string;
  authSecret: string;
  issuer: string;
  now?: Date;
}): Promise<NativeAccessClaims> {
  try {
    const { payload } = await jwtVerify(input.token, accessKey(input.authSecret), {
      issuer: input.issuer,
      audience: NATIVE_ACCESS_AUDIENCE,
      currentDate: input.now,
      algorithms: ["HS256"],
    });
    if (
      payload.typ !== "native_access" ||
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.sv !== "number" ||
      typeof payload.exp !== "number"
    ) {
      throw new NativeTokenError("invalid", "Invalid native access-token claims.");
    }
    return {
      userId: payload.sub,
      deviceSessionId: payload.sid,
      sessionVersion: payload.sv,
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch (error) {
    if (error instanceof NativeTokenError) throw error;
    if (error instanceof joseErrors.JWTExpired) {
      throw new NativeTokenError("expired", "The native access token has expired.");
    }
    throw new NativeTokenError("invalid", "The native access token is invalid.");
  }
}
