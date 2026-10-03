/**
 * Announcement media, end to end through the code that can run without a
 * server: the request-body ceiling, the sniffers, the upload route and the
 * /api/files route that serves what it stored.
 *
 * The bug this pins (2026-10-03): "when I send a video it doesn't work".
 *  1. src/middleware.ts runs on /api/*, and Next 15 hands a route handler only
 *     the first 10 MB of a body the middleware saw (middlewareClientMaxBodySize).
 *     Every real video was truncated, `formData()` threw, and the route said
 *     "No file provided." Reproduced against `next dev`: 4 MB parsed, 14 MB
 *     "Failed to parse body as FormData"; with the config raised, 14 MB and
 *     90 MB both parse.
 *  2. A freshly uploaded file 404'd from /api/files until the announcement was
 *     saved (no row named it yet), so the admin preview was an empty box.
 *  3. A .mov was served as `video/quicktime`, which Firefox refuses unread.
 *  4. An AVIF/HEIC photo sniffed as `video/mp4` (same ftyp container).
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  isHeifImage,
  playbackVideoMime,
  sniffAvifMime,
  sniffImageMime,
  sniffVideoMime,
} from "@/lib/uploads";
import { ANNOUNCEMENT_MAX_BYTES, announcementMediaKey, isAnnouncementMediaKeyOf } from "@/lib/announcement-media";

function ftyp(brand: string, size = 16): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  b.set([0, 0, 0, 0x18]);
  b.set([...Buffer.from("ftyp")], 4);
  b.set([...Buffer.from(brand)], 8);
  return b;
}

function parseBytes(value: string | number): number {
  if (typeof value === "number") return value;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(value.trim());
  assert.ok(m, `unparseable size ${value}`);
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2].toLowerCase() as "b"];
  return Number(m[1]) * unit;
}

test("middleware body ceiling admits the largest announcement upload", async () => {
  const silence = mock.method(console, "log", () => {});
  const { default: config } = await import("../next.config.mjs");
  silence.mock.restore();
  const limit = config.experimental?.middlewareClientMaxBodySize;
  assert.ok(limit !== undefined, "next.config.mjs must set experimental.middlewareClientMaxBodySize (Next's default truncates bodies at 10 MB)");
  assert.ok(parseBytes(limit) >= ANNOUNCEMENT_MAX_BYTES + 64 * 1024, `ceiling ${limit} is below the 100 MB announcement limit`);
});

test("video sniffing: mp4, QuickTime (ftyp and legacy atoms), WebM", () => {
  assert.equal(sniffVideoMime(ftyp("isom")), "video/mp4");
  assert.equal(sniffVideoMime(ftyp("mp42")), "video/mp4");
  assert.equal(sniffVideoMime(ftyp("M4V ")), "video/mp4");
  assert.equal(sniffVideoMime(ftyp("qt  ")), "video/quicktime");
  const wide = new Uint8Array([0, 0, 0, 8, ...Buffer.from("wide"), 0, 0, 0, 0, ...Buffer.from("mdat")]);
  assert.equal(sniffVideoMime(wide), "video/quicktime");
  assert.equal(sniffVideoMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), "video/webm");
  // A text file that happens to read "free" at bytes 4-7 is not a movie.
  assert.equal(sniffVideoMime(new Uint8Array(Buffer.from("abcdfree text file"))), null);
});

test("HEIF-family stills are images, not videos", () => {
  assert.equal(sniffVideoMime(ftyp("avif")), null);
  assert.equal(sniffAvifMime(ftyp("avif")), "image/avif");
  assert.equal(sniffVideoMime(ftyp("heic")), null);
  assert.equal(isHeifImage(ftyp("heic")), true);
  assert.equal(isHeifImage(ftyp("isom")), false);
  assert.equal(sniffImageMime(ftyp("avif")), null, "the shared image sniffer is unchanged");
});

test("QuickTime is served with a type every browser will try", () => {
  assert.equal(playbackVideoMime("video/quicktime"), "video/mp4");
  assert.equal(playbackVideoMime("video/webm"), "video/webm");
});

test("announcement keys are scoped to their uploader", () => {
  const key = announcementMediaKey("owner1", "Launch film.mov");
  assert.match(key, /^uploads\/owner1\/announcements\/[0-9a-f-]{36}-Launch_film\.mov$/);
  assert.equal(isAnnouncementMediaKeyOf("owner1", key), true);
  assert.equal(isAnnouncementMediaKeyOf("someone", key), false);
  assert.equal(isAnnouncementMediaKeyOf("owner1", "uploads/owner1/chat.png"), false);
  assert.equal(isAnnouncementMediaKeyOf("owner1", "uploads/owner1/announcements/../x"), false);
  assert.equal(isAnnouncementMediaKeyOf("owner1", "uploads/owner1/announcements/"), false);
});

// ---- Route handlers, with storage, session and database mocked. ----

const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const routeTest = canMockModules ? test : test.skip;

let currentUser: { id: string; email: string } | null = { id: "owner1", email: "o@example.com" };
const stored = new Map<string, { bytes: Uint8Array; contentType: string }>();

if (canMockModules) {
  const none = { findFirst: async () => null };
  mock.module("@/lib/prisma", {
    namedExports: { prismaUnguarded: { attachment: none, user: none, announcement: none }, prisma: {} },
  });
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => currentUser } });
  mock.module("@/lib/admin", {
    namedExports: { getOwnerUser: async () => (currentUser?.id === "owner1" ? currentUser : null) },
  });
  mock.module("@/lib/env", { namedExports: { isStorageAvailable: () => true } });
  mock.module("@/lib/storage", {
    namedExports: {
      putObject: async (key: string, bytes: Uint8Array, contentType: string) => {
        stored.set(key, { bytes, contentType });
      },
      getViewUrl: async (key: string) => `/api/files/${key}`,
      headObject: async (key: string, n: number) => {
        const o = stored.get(key);
        if (!o) throw new Error("NoSuchKey");
        return { size: o.bytes.byteLength, prefix: o.bytes.slice(0, n) };
      },
      openObjectStream: async (key: string, slice?: { start: number; end: number }) => {
        const o = stored.get(key)!;
        const part = slice ? o.bytes.slice(slice.start, slice.end + 1) : o.bytes;
        return new Blob([new Uint8Array(part)]).stream();
      },
    },
  });
}

function movBytes(size = 4096): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  b.set(ftyp("qt  "));
  return b;
}

async function upload(file: File, kind?: string) {
  const { POST } = await import("@/app/api/admin/announcements/upload/route");
  const fd = new FormData();
  fd.append("file", file);
  if (kind) fd.append("kind", kind);
  return POST(new Request("http://test/api/admin/announcements/upload", { method: "POST", body: fd }));
}

async function getFile(url: string, headers: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/files/[...key]/route");
  const key = url.replace(/^\/api\/files\//, "").split("/");
  return GET(new Request(`http://test${url}`, { headers }), { params: Promise.resolve({ key }) });
}

routeTest("a .mov uploads as a video and the owner can preview it before saving", async () => {
  currentUser = { id: "owner1", email: "o@example.com" };
  const res = await upload(new File([movBytes()], "Screen Recording.mov", { type: "video/quicktime" }), "video");
  assert.equal(res.status, 201);
  const body = (await res.json()) as { url: string; kind: string };
  assert.equal(body.kind, "video");
  assert.match(body.url, /^\/api\/files\/uploads\/owner1\/announcements\//);

  // No announcement row names it yet — this used to 404.
  const full = await getFile(body.url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("accept-ranges"), "bytes");

  // Safari's opening probe.
  const probe = await getFile(body.url, { range: "bytes=0-1" });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get("content-range"), "bytes 0-1/4096");
  assert.equal((await probe.arrayBuffer()).byteLength, 2);

  // Anyone else still gets nothing until it is published on an announcement.
  currentUser = { id: "someone", email: "s@example.com" };
  assert.equal((await getFile(body.url)).status, 404);
});

routeTest("a file dropped in the wrong field is refused with a sentence", async () => {
  currentUser = { id: "owner1", email: "o@example.com" };
  const res = await upload(new File([movBytes()], "clip.mov", { type: "video/quicktime" }), "image");
  assert.equal(res.status, 415);
  assert.match(((await res.json()) as { error: string }).error, /video/i);

  const heic = await upload(new File([ftyp("heic", 64)], "IMG_0001.HEIC", { type: "image/heic" }), "image");
  assert.equal(heic.status, 415);
  assert.match(((await heic.json()) as { error: string }).error, /HEIC/);
});

routeTest("a body cut short in transit says so instead of 'No file provided'", async () => {
  currentUser = { id: "owner1", email: "o@example.com" };
  const { POST } = await import("@/app/api/admin/announcements/upload/route");
  const truncated = new Request("http://test/api/admin/announcements/upload", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=----x" },
    body: '------x\r\nContent-Disposition: form-data; name="file"; filename="a.mp4"\r\n\r\nABC',
  });
  const res = await POST(truncated);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /incomplete/);
});
