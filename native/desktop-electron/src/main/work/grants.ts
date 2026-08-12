/**
 * Grant tokens: the renderer holds a handle, main holds the path.
 *
 * `work:choose-grant` opens a native picker in main and returns a
 * `WorkGrantCandidate` whose `token` is **opaque** — 32 bytes of randomness with
 * no relationship to the path it stands for. That is the same rule
 * `workspace:choose` follows and it is the reason the grant prompt means
 * anything: a renderer cannot name an arbitrary path and have it granted, so a
 * compromised renderer cannot widen its own access by asking nicely.
 *
 * The vault is in-memory and dies with the process. A token that outlived a
 * restart would be a path this app kept a claim on after the user had every
 * reason to think the claim was gone.
 *
 * Nothing here logs a path. `redactString` in `logger.ts` would rewrite the home
 * directory, but a grant is precisely the case where the rest of the path is the
 * sensitive part.
 */

import { randomBytes } from 'node:crypto';
import type { WorkAccessMode, WorkGrantKind } from '../../shared/contracts/work-vocabulary.js';

export interface GrantRecord {
  readonly token: string;
  readonly kind: Extract<WorkGrantKind, 'local_folder' | 'local_file'>;
  readonly accessMode: WorkAccessMode;
  /** Never crosses IPC and never reaches a log. */
  readonly path: string;
  /** The basename, which is what a person recognises and all the UI needs. */
  readonly label: string;
  readonly createdAt: number;
}

/** A grant nobody used is not kept forever. Long enough to compose a task. */
const GRANT_TTL_MS = 60 * 60_000;
const MAX_GRANTS = 64;

export class GrantVault {
  readonly #records = new Map<string, GrantRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Mint a token for a path the user just picked.
   *
   * `wgt_` plus 32 random bytes. Not a hash of the path: a hash is a guessable
   * oracle for whether a given path was granted, and a token that carries no
   * information about its subject cannot be one.
   */
  mint(input: Omit<GrantRecord, 'token' | 'createdAt'>): GrantRecord {
    this.#evict();
    const record: GrantRecord = {
      ...input,
      token: `wgt_${randomBytes(32).toString('hex')}`,
      createdAt: this.#now(),
    };
    this.#records.set(record.token, record);
    return record;
  }

  /** The record for a token, or null. Expired tokens resolve to null. */
  resolve(token: string): GrantRecord | null {
    const record = this.#records.get(token);
    if (record === undefined) return null;
    if (this.#now() - record.createdAt > GRANT_TTL_MS) {
      this.#records.delete(token);
      return null;
    }
    return record;
  }

  /** Resolve many, reporting which tokens were not ours rather than skipping them. */
  resolveAll(tokens: readonly string[]): { records: GrantRecord[]; unknown: string[] } {
    const records: GrantRecord[] = [];
    const missing: string[] = [];
    for (const token of tokens) {
      const record = this.resolve(token);
      if (record === null) missing.push(token);
      else records.push(record);
    }
    return { records, unknown: missing };
  }

  clear(): void {
    this.#records.clear();
  }

  get size(): number {
    return this.#records.size;
  }

  #evict(): void {
    const cutoff = this.#now() - GRANT_TTL_MS;
    for (const [token, record] of this.#records) {
      if (record.createdAt < cutoff) this.#records.delete(token);
    }
    while (this.#records.size >= MAX_GRANTS) {
      const oldest = this.#records.keys().next();
      if (oldest.done === true) break;
      this.#records.delete(oldest.value);
    }
  }
}
