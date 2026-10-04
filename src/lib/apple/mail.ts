import "server-only";
import { ImapFlow, type MessageStructureObject, type SearchObject } from "imapflow";

/*
 * Minimal iCloud Mail (IMAP) client over imapflow. Read-only: list mailboxes,
 * search, read a message, unread counts. Every call opens its own connection
 * and closes it in a finally — serverless-friendly, no pooling.
 */

export interface MailCredentials {
  appleId: string;
  appPassword: string;
}

export interface MailboxInfo {
  path: string;
  name: string;
  specialUse?: string;
}

export interface MailSummary {
  uid: number;
  date?: string;
  from?: string;
  subject: string;
  seen: boolean;
}

export interface MailMessage {
  uid: number;
  date?: string;
  from?: string;
  to?: string;
  subject: string;
  text: string;
}

/** Thrown when iCloud rejects the IMAP login. */
export class MailAuthError extends Error {
  constructor() {
    super("iCloud rejected the Apple ID or app-specific password");
    this.name = "MailAuthError";
  }
}

async function withImap<T>(creds: MailCredentials, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user: creds.appleId, pass: creds.appPassword },
    logger: false,
  });
  try {
    await client.connect();
  } catch (err) {
    if ((err as { authenticationFailed?: boolean })?.authenticationFailed) throw new MailAuthError();
    throw err;
  }
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Cheap live check used when the user first submits credentials. */
export async function validateMailCredentials(creds: MailCredentials): Promise<void> {
  await withImap(creds, async () => undefined);
}

export async function listMailboxes(creds: MailCredentials): Promise<MailboxInfo[]> {
  return withImap(creds, async (client) => {
    const boxes = await client.list();
    return boxes.map((b) => ({ path: b.path, name: b.name, specialUse: b.specialUse || undefined }));
  });
}

function addressLine(addrs?: Array<{ name?: string; address?: string }>): string | undefined {
  if (!addrs || addrs.length === 0) return undefined;
  return addrs
    .map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : a.address || a.name || ""))
    .filter(Boolean)
    .join(", ");
}

/** Special-use flags a person (or a model) names in words. */
const SPECIAL_USE_ALIASES: Record<string, string> = {
  sent: "\\Sent",
  "sent messages": "\\Sent",
  "sent mail": "\\Sent",
  archive: "\\Archive",
  archives: "\\Archive",
  trash: "\\Trash",
  bin: "\\Trash",
  "deleted messages": "\\Trash",
  junk: "\\Junk",
  spam: "\\Junk",
  drafts: "\\Drafts",
  draft: "\\Drafts",
};

/**
 * The real path of the mailbox a caller named. iCloud calls its sent folder
 * "Sent Messages" and its bin "Deleted Messages"; a model asks for "Sent" and
 * "Trash", and IMAP answers an unknown path with a bare "Command failed".
 * Exported for tests: exact path, then case-insensitive path or name, then
 * special-use role.
 */
export function resolveMailboxPath(boxes: MailboxInfo[], requested: string): string | null {
  const want = requested.trim();
  if (!want) return null;
  const lower = want.toLowerCase();
  if (lower === "inbox") return "INBOX";
  const exact = boxes.find((b) => b.path === want);
  if (exact) return exact.path;
  const loose = boxes.find((b) => b.path.toLowerCase() === lower || b.name.toLowerCase() === lower);
  if (loose) return loose.path;
  const role = SPECIAL_USE_ALIASES[lower] ?? (want.startsWith("\\") ? want : undefined);
  const byRole = role ? boxes.find((b) => b.specialUse?.toLowerCase() === role.toLowerCase()) : undefined;
  return byRole?.path ?? null;
}

/** Mailboxes an "everywhere" search reads: everything but trash, junk and drafts. */
export function searchableMailboxes(boxes: MailboxInfo[]): string[] {
  const skip = new Set(["\\trash", "\\junk", "\\drafts", "\\all", "\\flagged"]);
  return boxes
    .filter((b) => !(b.specialUse && skip.has(b.specialUse.toLowerCase())))
    .filter((b) => !/^(?:\[gmail\])$/i.test(b.path))
    .map((b) => b.path);
}

export interface MailSearchResult {
  messages: Array<MailSummary & { mailbox: string }>;
  /** The mailbox paths actually searched. */
  searched: string[];
  /** Every mailbox on the account, for an honest empty answer. */
  available: string[];
  /** Matches found before the limit cut the list. */
  total: number;
}

export async function searchMessages(
  creds: MailCredentials,
  opts: { mailbox?: string; query?: string; from?: string; since?: Date; limit?: number }
): Promise<MailSearchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
  return withImap(creds, async (client) => {
    const boxes = (await client.list()).map((b) => ({ path: b.path, name: b.name, specialUse: b.specialUse || undefined }));
    const available = boxes.map((b) => b.path);
    const requested = opts.mailbox?.trim();
    let paths: string[];
    if (!requested) paths = ["INBOX"];
    else if (/^(?:all|\*|everywhere|all mail)$/i.test(requested)) paths = searchableMailboxes(boxes);
    else {
      const path = resolveMailboxPath(boxes, requested);
      if (!path) throw new Error(`No mailbox named “${requested}”. Available: ${available.join(", ")}.`);
      paths = [path];
    }

    const criteria: SearchObject = {};
    if (opts.query) criteria.or = [{ subject: opts.query }, { body: opts.query }];
    if (opts.from) criteria.from = opts.from;
    // IMAP SINCE is a whole date (no time, server's zone): it selects a superset,
    // and the exact instant is applied to each message's received time below.
    if (opts.since) criteria.since = opts.since;
    if (!opts.query && !opts.from && !opts.since) criteria.all = true;

    const found: Array<MailSummary & { mailbox: string; received: number }> = [];
    let total = 0;
    for (const mailbox of paths) {
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox, { readOnly: true });
      } catch {
        continue; // a \Noselect parent folder in an "all" search
      }
      try {
        const uids = await client.search(criteria, { uid: true });
        if (!uids || uids.length === 0) continue;
        const newest = [...uids].sort((a, b) => a - b).slice(-limit * 2);
        for await (const msg of client.fetch(
          newest.join(","),
          { uid: true, envelope: true, flags: true, internalDate: true },
          { uid: true }
        )) {
          const internal = msg.internalDate ? new Date(msg.internalDate) : undefined;
          const received = internal?.getTime() ?? msg.envelope?.date?.getTime() ?? 0;
          if (opts.since && received && received < opts.since.getTime()) continue;
          total++;
          found.push({
            mailbox,
            uid: msg.uid,
            date: (internal ?? msg.envelope?.date)?.toISOString(),
            from: addressLine(msg.envelope?.from),
            subject: msg.envelope?.subject ?? "(no subject)",
            seen: msg.flags?.has("\\Seen") ?? false,
            received,
          });
        }
        // Matches beyond the fetched window still count toward the total.
        if (uids.length > newest.length) total += uids.length - newest.length;
      } finally {
        lock.release();
      }
    }
    found.sort((a, b) => b.received - a.received);
    return {
      messages: found.slice(0, limit).map(({ received: _received, ...m }) => m),
      searched: paths,
      available,
      total,
    };
  });
}

function findPart(node: MessageStructureObject | undefined, mime: string): string | null {
  if (!node) return null;
  if (node.type?.toLowerCase() === mime) return node.part ?? "1";
  for (const child of node.childNodes ?? []) {
    const p = findPart(child, mime);
    if (p) return p;
  }
  return null;
}

async function streamToString(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Best-effort plain text from HTML: drop style/script, keep line structure, strip tags. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function readMessage(creds: MailCredentials, mailbox: string, uid: number): Promise<MailMessage | null> {
  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true }, { uid: true });
      if (!msg) return null;

      let text = "";
      const plainPart = findPart(msg.bodyStructure, "text/plain");
      const htmlPart = plainPart ? null : findPart(msg.bodyStructure, "text/html");
      const part = plainPart ?? htmlPart;
      if (part) {
        const dl = await client.download(String(uid), part, { uid: true, maxBytes: 256 * 1024 });
        const raw = await streamToString(dl.content);
        text = htmlPart ? stripHtml(raw) : raw.trim();
      }

      return {
        uid,
        date: msg.envelope?.date?.toISOString(),
        from: addressLine(msg.envelope?.from),
        to: addressLine(msg.envelope?.to),
        subject: msg.envelope?.subject ?? "(no subject)",
        text,
      };
    } finally {
      lock.release();
    }
  });
}

export async function unreadCount(creds: MailCredentials, mailbox = "INBOX"): Promise<number> {
  return withImap(creds, async (client) => {
    const status = await client.status(mailbox, { unseen: true });
    return status.unseen ?? 0;
  });
}
