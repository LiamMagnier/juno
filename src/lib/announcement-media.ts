/**
 * Announcement media: where an upload is stored, and who may read it before an
 * announcement row points at it.
 *
 * Shared by the upload route (which builds the key) and /api/files (which
 * authorises it), so the two cannot drift apart.
 */

const SEGMENT = "announcements";

/** `uploads/<ownerId>/announcements/<uuid>-<name>` */
export function announcementMediaKey(ownerId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80) || "media";
  return `uploads/${ownerId}/${SEGMENT}/${crypto.randomUUID()}-${safe}`;
}

/** True when `key` is announcement media uploaded by `userId`. */
export function isAnnouncementMediaKeyOf(userId: string, key: string): boolean {
  if (!userId || key.includes("..")) return false;
  const prefix = `uploads/${userId}/${SEGMENT}/`;
  return key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes("/");
}

export type AnnouncementMediaKind = "image" | "video";

/**
 * What the admin dropzones accept. Extensions ride alongside the MIME types
 * because macOS reports .m4v as `video/x-m4v` and some systems report nothing
 * at all for .webm/.mkv — the server sniffs the bytes either way.
 */
export const ANNOUNCEMENT_ACCEPT: Record<AnnouncementMediaKind, string> = {
  image: "image/png,image/jpeg,image/gif,image/webp,image/avif,.png,.jpg,.jpeg,.gif,.webp,.avif",
  video: "video/mp4,video/webm,video/quicktime,video/x-m4v,.mp4,.m4v,.mov,.webm",
};

/** Owner-only ceiling for one announcement file. */
export const ANNOUNCEMENT_MAX_BYTES = 100 * 1024 * 1024;
