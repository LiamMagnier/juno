import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleCloudFileAttach, handleCloudFileList, type CloudFilesDeps } from "@/lib/cloud-files/api";
import { CLOUD_IMPORT_ORIGIN, type CloudFileProvider } from "@/lib/cloud-files/shared";
import type { ClientAttachment } from "@/types/chat";

/*
 * The picker routes' decisions, with a fake database and a fake drive: who
 * may ask, whose connection and token are used, what is refused before the
 * drive is called, and how a picked file reaches the attachment pipeline.
 */

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

class QuotaError extends Error {}

interface Harness {
  deps: CloudFilesDeps;
  /** Every userId any dependency was asked about. */
  userIds: string[];
  tokenRequests: Array<[string, CloudFileProvider]>;
  driveCalls: URL[];
  persisted: Parameters<CloudFilesDeps["persist"]>[0][];
  rateKeys: string[];
}

function harness(options: {
  user?: { id: string; email?: string | null } | null;
  connected?: boolean;
  token?: string | null;
  policy?: { lockdown: boolean; blocked: boolean };
  configured?: boolean;
  storage?: boolean;
  maxUploadMb?: number;
  ownConversations?: string[];
  rateLimited?: (key: string) => boolean;
  drive?: (url: URL) => Response | unknown;
  persistError?: (input: Parameters<CloudFilesDeps["persist"]>[0]) => Error | null;
} = {}): Harness {
  const h: Harness = { deps: undefined as unknown as CloudFilesDeps, userIds: [], tokenRequests: [], driveCalls: [], persisted: [], rateKeys: [] };
  const seen = (userId: string) => h.userIds.push(userId);
  h.deps = {
    currentUser: async () => (options.user === undefined ? { id: "user-a", email: "a@example.com" } : options.user),
    connectorConfigured: () => options.configured ?? true,
    hasConnection: async (userId) => (seen(userId), options.connected ?? true),
    accessToken: async (userId, provider) => {
      seen(userId);
      h.tokenRequests.push([userId, provider]);
      return options.token === undefined ? `token-for-${userId}` : options.token;
    },
    appPolicy: async (userId) => (seen(userId), options.policy ?? { lockdown: false, blocked: false }),
    rateLimit: async (key) => {
      h.rateKeys.push(key);
      return !(options.rateLimited?.(key) ?? false);
    },
    isOwner: () => false,
    fetcher: async (url, init) => {
      const parsed = new URL(String(url));
      h.driveCalls.push(parsed);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token-for-user-a", "the session user's own token");
      const reply = options.drive?.(parsed) ?? { files: [] };
      return reply instanceof Response ? reply : Response.json(reply);
    },
    uploadLimit: async (userId) => (seen(userId), { plan: "PRO", maxUploadMb: options.maxUploadMb ?? 5 }),
    storageAvailable: () => options.storage ?? true,
    conversationOwned: async (userId, conversationId) => (seen(userId), (options.ownConversations ?? ["chat-a"]).includes(conversationId)),
    persist: async (input) => {
      seen(input.userId);
      const error = options.persistError?.(input);
      if (error) throw error;
      h.persisted.push(input);
      return {
        id: `att-${h.persisted.length}`,
        kind: input.planned.kind,
        fileName: input.planned.fileName,
        mimeType: input.planned.storedMime,
        size: input.bytes.byteLength,
      } as ClientAttachment;
    },
    isQuotaError: (error) => error instanceof QuotaError,
  };
  return h;
}

/** A Google Drive that knows two files: a Doc and a PNG (whose bytes may lie). */
function googleDrive(pngBytes: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])) {
  return (url: URL): Response | unknown => {
    // The download shares the metadata's path; `alt=media` is what asks for the bytes.
    if (url.pathname === "/drive/v3/files/img1" && url.searchParams.get("alt") === "media") return new Response(pngBytes);
    if (url.pathname === "/drive/v3/files/doc1") return { id: "doc1", name: "Q3 plan", mimeType: "application/vnd.google-apps.document" };
    if (url.pathname === "/drive/v3/files/doc1/export") return new Response(ZIP);
    if (url.pathname === "/drive/v3/files/img1") return { id: "img1", name: "Chart.png", mimeType: "image/png", size: String(pngBytes.byteLength) };
    if (url.pathname === "/drive/v3/files") return { files: [{ id: "doc1", name: "Q3 plan", mimeType: "application/vnd.google-apps.document" }] };
    return new Response(null, { status: 404 });
  };
}

const listUrl = (query = "") => new URL(`https://alevr.example/api/connectors/google-drive/files${query}`);

test("signed out, an unknown app or an unconfigured one are refused before any lookup", async () => {
  const out = harness({ user: null });
  assert.equal((await handleCloudFileList(out.deps, "google-drive", listUrl())).status, 401);
  assert.equal((await handleCloudFileAttach(out.deps, "google-drive", { files: [{ id: "doc1" }] })).status, 401);
  for (const id of ["github", "gmail", "outlook", "../google-drive"]) {
    const h = harness();
    assert.equal((await handleCloudFileList(h.deps, id, listUrl())).status, 404, id);
    assert.deepEqual(h.userIds, [], `${id}: no connection is looked up for an app the picker does not serve`);
  }
  const unconfigured = harness({ configured: false });
  assert.equal((await handleCloudFileList(unconfigured.deps, "microsoft-365", listUrl())).status, 404);
});

test("a missing connector is its own error, distinct from one that needs reconnecting", async () => {
  const missing = harness({ connected: false });
  const result = await handleCloudFileList(missing.deps, "google-drive", listUrl());
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "Connect Google Drive in Apps first.", code: "connector_not_connected", provider: "google-drive" });
  assert.deepEqual(missing.tokenRequests, [], "no token is minted for a connection that does not exist");
  assert.equal(missing.driveCalls.length, 0);

  const attach = await handleCloudFileAttach(harness({ connected: false }).deps, "microsoft-365", { files: [{ id: "x" }] });
  assert.equal(attach.status, 409);
  assert.equal((attach.body as { error: string }).error, "Connect OneDrive in Apps first.");

  const stale = await handleCloudFileList(harness({ token: null }).deps, "google-drive", listUrl());
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { code: string }).code, "connector_reconnect");
});

test("Lockdown and a blocked app refuse reading, before a token is refreshed", async () => {
  for (const policy of [{ lockdown: true, blocked: false }, { lockdown: false, blocked: true }]) {
    const h = harness({ policy });
    const result = await handleCloudFileList(h.deps, "google-drive", listUrl());
    assert.equal(result.status, 403);
    assert.equal((result.body as { code: string }).code, "connector_blocked");
    assert.deepEqual(h.tokenRequests, []);
    assert.equal(h.driveCalls.length, 0);
  }
});

test("the picker is owner-scoped: every lookup is the session user's, with their own token", async () => {
  const h = harness({ drive: googleDrive() });
  const result = await handleCloudFileList(h.deps, "google-drive", listUrl("?q=plan"));
  assert.equal(result.status, 200);
  assert.deepEqual(new Set(h.userIds), new Set(["user-a"]));
  assert.deepEqual(h.tokenRequests, [["user-a", "google-drive"]]);
  assert.deepEqual(h.rateKeys, ["cloud-files:user-a"]);
  const body = result.body as { files: Array<{ id: string; attachName: string }>; maxBytes: number; nextCursor: string | null };
  assert.deepEqual(body.files.map((f) => [f.id, f.attachName]), [["doc1", "Q3 plan.docx"]]);
  assert.equal(body.maxBytes, 5 * 1024 * 1024);
  assert.equal(body.nextCursor, null);

  // The request cannot name an account: an extra field is refused, not ignored.
  const smuggled = await handleCloudFileAttach(h.deps, "google-drive", { files: [{ id: "doc1" }], userId: "user-b" });
  assert.equal(smuggled.status, 400);
  // Another account's conversation is the same 404 as a missing one.
  const theirs = await handleCloudFileAttach(h.deps, "google-drive", { files: [{ id: "doc1" }], conversationId: "chat-b" });
  assert.equal(theirs.status, 404);
  assert.equal(h.persisted.length, 0);
});

test("a picked Google Doc is exported, then stored through the upload gate as an ordinary attachment", async () => {
  const h = harness({ drive: googleDrive() });
  const result = await handleCloudFileAttach(h.deps, "google-drive", { files: [{ id: "doc1" }, { id: "doc1" }], conversationId: "chat-a" });
  assert.equal(result.status, 201);
  const body = result.body as { attachments: ClientAttachment[]; failed: unknown[] };
  assert.equal(body.attachments.length, 1, "a file picked twice is attached once");
  assert.deepEqual(body.failed, []);
  const [stored] = h.persisted;
  assert.equal(stored.userId, "user-a");
  assert.equal(stored.conversationId, "chat-a");
  assert.equal(stored.origin, CLOUD_IMPORT_ORIGIN);
  assert.equal(stored.plan, "PRO");
  // planAttachmentUpload's verdict: an Office file is stored neutrally, served as a download.
  assert.equal(stored.planned.fileName, "Q3 plan.docx");
  assert.equal(stored.planned.kind, "FILE");
  assert.equal(stored.planned.storedMime, DOCX);
  assert.equal(stored.planned.storedContentType, "application/octet-stream");
  assert.match(stored.planned.contentDisposition ?? "", /^attachment;/);
  assert.equal(stored.planned.extractedText, null, "a ZIP is never decoded as text");
  assert.deepEqual(h.rateKeys, ["upload:user-a"], "each file spends from the hourly upload allowance");
});

test("type-checked by the bytes: a real PNG is an image, a PNG that is not one is refused by the upload gate", async () => {
  const real = harness({ drive: googleDrive() });
  assert.equal((await handleCloudFileAttach(real.deps, "google-drive", { files: [{ id: "img1" }] })).status, 201);
  assert.equal(real.persisted[0].planned.kind, "IMAGE");
  assert.equal(real.persisted[0].planned.storedContentType, "image/png", "stored under the sniffed type");
  assert.equal(real.persisted[0].planned.contentDisposition, undefined, "only a verified image may render inline");

  const h = harness({ drive: googleDrive(new TextEncoder().encode("<script>alert(1)</script>")) });
  const result = await handleCloudFileAttach(h.deps, "google-drive", { files: [{ id: "img1" }] });
  assert.equal(result.status, 415);
  assert.equal((result.body as { error: string }).error, "That file isn't a valid image.");
  assert.ok(h.driveCalls.some((url) => url.searchParams.get("alt") === "media"), "refused on the bytes, after the download");
  assert.equal(h.persisted.length, 0);
});

test("the size cap is the plan's, and never over the import ceiling", async () => {
  const big = new Uint8Array(6 * 1024 * 1024);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const small = harness({ maxUploadMb: 5, drive: googleDrive(big) });
  const refused = await handleCloudFileAttach(small.deps, "google-drive", { files: [{ id: "img1" }] });
  assert.equal(refused.status, 413);
  assert.equal((refused.body as { error: string }).error, "File is too large. Your plan allows up to 5 MB.");
  assert.equal(small.persisted.length, 0);

  const generous = harness({
    maxUploadMb: 200,
    drive: (url) => (url.pathname === "/drive/v3/files/huge" ? { id: "huge", name: "Raw.pdf", mimeType: "application/pdf", size: String(40 * 1024 * 1024) } : null),
  });
  const ceiling = await handleCloudFileAttach(generous.deps, "google-drive", { files: [{ id: "huge" }] });
  assert.equal(ceiling.status, 413);
  assert.equal((ceiling.body as { error: string }).error, "Files from Google Drive can be up to 32 MB. Download this one and upload it instead.");
  const listing = await handleCloudFileList(generous.deps, "google-drive", listUrl());
  assert.equal((listing.body as { maxBytes: number }).maxBytes, 32 * 1024 * 1024);
});

test("some files added, some not: the added ones arrive and each refusal says why", async () => {
  const h = harness({ drive: googleDrive() });
  const result = await handleCloudFileAttach(h.deps, "google-drive", { files: [{ id: "doc1" }, { id: "gone" }] });
  assert.equal(result.status, 201);
  const body = result.body as { attachments: ClientAttachment[]; failed: Array<{ id: string; error: string }> };
  assert.equal(body.attachments.length, 1);
  assert.deepEqual(body.failed, [{ id: "gone", name: null, error: "That file is no longer in your Google Drive." }]);
});

test("the upload limit and the library quota stop the files not yet started", async () => {
  const limited = harness({ drive: googleDrive(), rateLimited: (key) => key.startsWith("upload:") });
  const result = await handleCloudFileAttach(limited.deps, "google-drive", { files: [{ id: "doc1" }] });
  assert.equal(result.status, 429);
  assert.equal(limited.driveCalls.length, 0, "nothing is downloaded past the limit");

  const full = harness({ drive: googleDrive(), persistError: () => new QuotaError() });
  const quota = await handleCloudFileAttach(full.deps, "google-drive", { files: [{ id: "doc1" }] });
  assert.equal(quota.status, 413);
  assert.equal((quota.body as { code: string }).code, "LIBRARY_QUOTA_EXCEEDED");

  // A storage failure on one file is that file's failure; the one already stored still arrives.
  const flaky = harness({ drive: googleDrive(), persistError: (input) => (input.planned.kind === "IMAGE" ? new Error("bucket unavailable") : null) });
  const partial = await handleCloudFileAttach(flaky.deps, "google-drive", { files: [{ id: "doc1" }, { id: "img1" }] });
  assert.equal(partial.status, 201);
  const body = partial.body as { attachments: ClientAttachment[]; failed: Array<{ error: string }> };
  assert.equal(body.attachments.length, 1);
  assert.deepEqual(body.failed.map((f) => f.error), ["Couldn’t save “Chart.png”. Try again."]);
});

test("no storage, no import; a malformed pick is refused before the drive is called", async () => {
  const h = harness({ storage: false });
  assert.equal((await handleCloudFileAttach(h.deps, "google-drive", { files: [{ id: "doc1" }] })).status, 503);
  for (const body of [null, {}, { files: [] }, { files: [{ id: "a/b" }] }, { files: Array.from({ length: 11 }, (_, i) => ({ id: `f${i}` })) }]) {
    const fresh = harness();
    assert.equal((await handleCloudFileAttach(fresh.deps, "google-drive", body)).status, 400, JSON.stringify(body)?.slice(0, 40));
    assert.equal(fresh.driveCalls.length, 0);
  }
  const longSearch = await handleCloudFileList(harness().deps, "google-drive", listUrl(`?q=${"x".repeat(201)}`));
  assert.equal(longSearch.status, 400);
});

test("the routes are thin: they wire the real dependencies and nothing else", () => {
  const list = readFileSync(new URL("../src/app/api/connectors/[id]/files/route.ts", import.meta.url), "utf8");
  const attach = readFileSync(new URL("../src/app/api/connectors/[id]/files/attach/route.ts", import.meta.url), "utf8");
  assert.match(list, /handleCloudFileList\(cloudFilesDeps\(\), id, new URL\(req\.url\), req\.signal\)/);
  assert.match(attach, /handleCloudFileAttach\(cloudFilesDeps\(\), id, body, req\.signal\)/);
  const server = readFileSync(new URL("../src/lib/cloud-files/server.ts", import.meta.url), "utf8");
  // Ownership in the real wiring: the connection and the conversation are read by the user's id.
  assert.match(server, /prisma\.connection\.findFirst\(\{ where: \{ userId, provider \}/);
  assert.match(server, /prisma\.conversation\.findFirst\(\{ where: \{ id: conversationId, userId \}/);
  assert.match(server, /accessToken: firstPartyAccessToken/);
  assert.match(server, /resolveActionPolicy\(/);
});
