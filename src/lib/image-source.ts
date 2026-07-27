/**
 * Whether an image URL can only be fetched with the viewer's session cookie.
 *
 * Uploaded media (avatars, chat/library attachments, announcement media) is
 * served by `src/app/api/files/[...key]/route.ts`, which 401s anyone who is not
 * signed in. Next's image optimizer resolves `<Image src>` by making its **own**
 * server-side request to that URL, and that request carries no cookies — so it
 * gets the 401, has nothing to optimize, and the browser is handed a broken
 * image. In the server log it reads:
 *
 *   ⨯ The requested resource isn't a valid image for /api/files/uploads/… received null
 *   [Error: The requested resource isn't a valid image.] { statusCode: 400 }
 *
 * There is no way to forward the caller's cookie into that internal fetch, so
 * these URLs must skip the optimizer and be loaded directly by the browser,
 * which does send the cookie. Pass the result as `unoptimized` on `<Image>`.
 *
 * Deliberately narrow: it matches only the credentialed route, so when S3 is
 * configured (`S3_PUBLIC_URL`, absolute and anonymously readable) optimization
 * still applies. `getViewUrl` in `src/lib/storage.ts` decides which form a given
 * deployment produces.
 */
export function requiresViewerCredentials(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith("/api/files/");
}
