import "server-only";
import { SignJWT, importPKCS8 } from "jose";
import { env } from "@/lib/env";

/*
 * Apple Music developer tokens: an ES256 JWT signed with the MusicKit .p8 key
 * (Apple Developer → Keys). Minted at runtime with a ~12h life and cached in
 * memory; MusicKit JS in the browser and api.music.apple.com both accept it.
 */

const TOKEN_TTL_SEC = 12 * 60 * 60;

let cached: { token: string; expMs: number } | null = null;

export function isAppleMusicConfigured(): boolean {
  const m = env.connectors.appleMusic;
  return Boolean(m.teamId && m.keyId && m.privateKey);
}

export async function appleMusicDeveloperToken(): Promise<string> {
  const { teamId, keyId, privateKey } = env.connectors.appleMusic;
  if (!teamId || !keyId || !privateKey) throw new Error("Apple Music developer credentials are not configured");
  if (cached && cached.expMs > Date.now() + 5 * 60_000) return cached.token;

  const key = await importPKCS8(privateKey, "ES256");
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SEC)
    .sign(key);
  cached = { token, expMs: (now + TOKEN_TTL_SEC) * 1000 };
  return token;
}
