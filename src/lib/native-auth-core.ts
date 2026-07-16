import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, errors as joseErrors, jwtVerify } from "jose";

export const NATIVE_REDIRECT_URI = "juno://auth/callback";
export const NATIVE_ACCESS_AUDIENCE = "juno-native";
export const NATIVE_ACCESS_TTL_SECONDS = 10 * 60;
export const NATIVE_AUTH_CODE_TTL_MS = 2 * 60 * 1000;
export const NATIVE_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    input.redirectUri === NATIVE_REDIRECT_URI &&
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
