import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Shared key store: ~/.juno/credentials.json, one entry per provider:
 *   { "anthropic": {"apiKey": "…"}, "zhipu": {"apiKey": "…"} }
 * Env vars win so CI/shell usage stays conventional; the file covers
 * GUI-launched engines that inherit no shell environment.
 */
export function readCredentials(): Record<string, { apiKey?: string }> {
  try {
    const raw = fs.readFileSync(
      path.join(process.env.JUNO_HOME ?? path.join(os.homedir(), '.juno'), 'credentials.json'),
      'utf8',
    );
    return JSON.parse(raw) as Record<string, { apiKey?: string }>;
  } catch {
    return {};
  }
}

export function resolveKey(providerId: string, envVar: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env[envVar]) return process.env[envVar];
  return readCredentials()[providerId]?.apiKey || undefined;
}
