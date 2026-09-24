/**
 * The file name a download was sent with, read back off its header.
 *
 * Fetching a download as a blob drops the name the server gave it, so a client
 * that saves the blob itself has to read `Content-Disposition` again. The
 * UTF-8 form (`filename*=UTF-8''…`, RFC 5987) comes first: it carries the real
 * name in any script, and every route that sends a name a person chose sends
 * both forms, because a raw non-Latin name in a header is a TypeError on the
 * server (X-23). The quoted `filename=` is the plain-ASCII fallback — "登录.svg"
 * arrives there as "design.svg" — so reading only that one saved every
 * non-Latin design under the wrong name.
 *
 * No imports, so a client component can use it without pulling in anything
 * that builds the file.
 */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      // Malformed encoding: fall back to the ASCII name below.
    }
  }
  const ascii = /filename="([^"]+)"/i.exec(header);
  return ascii?.[1] ?? null;
}
