import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentEvent, ChatMessage, PermissionMode, SessionMeta } from './types.js';

export function junoHome(): string {
  return process.env.JUNO_HOME ?? path.join(os.homedir(), '.juno');
}

export function sessionsDir(): string {
  return path.join(junoHome(), 'sessions');
}

/**
 * Durable per-session storage: meta.json (index card), messages.json (full
 * provider-neutral transcript for resume), events.jsonl (append-only audit log).
 */
export class SessionStore {
  readonly id: string;
  readonly dir: string;
  meta: SessionMeta;

  private constructor(id: string, meta: SessionMeta) {
    this.id = id;
    this.dir = path.join(sessionsDir(), id);
    this.meta = meta;
  }

  static create(opts: {
    cwd: string;
    provider: string;
    model: string;
    mode: PermissionMode;
  }): SessionStore {
    const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    const meta: SessionMeta = {
      id,
      title: '(new session)',
      cwd: opts.cwd,
      provider: opts.provider,
      model: opts.model,
      mode: opts.mode,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 0,
    };
    const store = new SessionStore(id, meta);
    fs.mkdirSync(store.dir, { recursive: true });
    store.saveMeta();
    store.saveMessages([]);
    return store;
  }

  static open(id: string): SessionStore {
    const dir = path.join(sessionsDir(), id);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as SessionMeta;
    return new SessionStore(id, meta);
  }

  static list(): SessionMeta[] {
    const root = sessionsDir();
    if (!fs.existsSync(root)) return [];
    const metas: SessionMeta[] = [];
    for (const entry of fs.readdirSync(root)) {
      try {
        metas.push(
          JSON.parse(fs.readFileSync(path.join(root, entry, 'meta.json'), 'utf8')) as SessionMeta,
        );
      } catch {
        // skip corrupt/partial sessions
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  saveMeta(): void {
    this.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2));
  }

  /** Permanently delete a stored session (transcript, checkpoints, events). */
  static delete(id: string): void {
    if (!id) return;
    const dir = path.join(sessionsDir(), id);
    // Guard against path escapes: the resolved dir must sit under sessionsDir.
    if (path.dirname(dir) !== sessionsDir()) return;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Rename a session's title in place, preserving its sort order (updatedAt). */
  static rename(id: string, title: string): void {
    const metaPath = path.join(sessionsDir(), id, 'meta.json');
    if (!fs.existsSync(metaPath)) return;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as SessionMeta;
    meta.title = title.trim().slice(0, 200) || meta.title;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  loadMessages(): ChatMessage[] {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.dir, 'messages.json'), 'utf8'),
      ) as ChatMessage[];
    } catch {
      return [];
    }
  }

  saveMessages(messages: ChatMessage[]): void {
    fs.writeFileSync(path.join(this.dir, 'messages.json'), JSON.stringify(messages, null, 2));
    this.saveMeta();
  }

  appendEvent(event: AgentEvent): void {
    fs.appendFileSync(
      path.join(this.dir, 'events.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n',
    );
  }
}
