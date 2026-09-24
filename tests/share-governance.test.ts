import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SHARE_REPORT_REASONS,
  parseShareToken,
  shareIsServable,
  shareStatus,
} from "@/lib/share-policy";
import { shareReportSchema, shareTakedownSchema } from "@/lib/share-schemas";

/**
 * GOVERNANCE FOR PUBLIC LINKS (audit X-31, §12.8).
 *
 * Fixing X-01 lets a shared page's scripts run again, so a public link needs to
 * be removable: a ban takes an account's links down, an admin can take one
 * down, a visitor can report one. These are the rules that decide it; the
 * database half lives in src/lib/share.ts and src/lib/share-moderation.ts
 * (server-only, so read here as source where the wiring is the point).
 */

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const t = new Date("2026-09-23T12:00:00Z");

test("a link is served only while nobody has pulled it", () => {
  assert.equal(shareIsServable({ revokedAt: null, takenDownAt: null, ownerBannedAt: null }), true);
  assert.equal(shareIsServable({ revokedAt: t, takenDownAt: null, ownerBannedAt: null }), false, "revoked by its owner");
  assert.equal(shareIsServable({ revokedAt: null, takenDownAt: t, ownerBannedAt: null }), false, "taken down by Juno");
  assert.equal(shareIsServable({ revokedAt: null, takenDownAt: null, ownerBannedAt: t }), false, "owner banned");
});

test("a ban is a suspension, a takedown is not", () => {
  // Lifting the ban brings a live link back: the lookup reads the ban, it does
  // not copy it onto the link.
  const link = { revokedAt: null, takenDownAt: null };
  assert.equal(shareIsServable({ ...link, ownerBannedAt: t }), false);
  assert.equal(shareIsServable({ ...link, ownerBannedAt: null }), true);
  // A takedown outlasts an unban.
  assert.equal(shareIsServable({ revokedAt: null, takenDownAt: t, ownerBannedAt: null }), false);
  assert.equal(shareStatus({ revokedAt: t, takenDownAt: t, ownerBannedAt: t }), "taken-down");
  assert.equal(shareStatus({ revokedAt: t, takenDownAt: null, ownerBannedAt: t }), "owner-banned");
});

test("the public lookup reads the owner's ban and the takedown on every request", () => {
  const source = readFileSync(new URL("../src/lib/share.ts", import.meta.url), "utf8");
  const lookup = source.slice(source.indexOf("const findActiveShare"), source.indexOf("export async function peekPublicShare"));
  assert.match(lookup, /bannedAt: true/, "the lookup no longer selects the owner's ban");
  assert.match(lookup, /shareIsServable\(/, "the lookup no longer applies the servability rule");
  // The owner's own list and a re-share both know about takedowns.
  assert.match(source, /listShares[\s\S]*?takenDownAt: null/);
  assert.match(source, /assertNotTakenDown\(\{ userId, conversationId: targetId \}\)/);
  assert.match(source, /assertNotTakenDown\(\{ userId, artifactId: targetId \}\)/);
});

test("a takedown tells the owner which link and why", () => {
  const source = readFileSync(new URL("../src/lib/share-moderation.ts", import.meta.url), "utf8");
  const takedown = source.slice(source.indexOf("export async function takeDownShare"), source.indexOf("export async function restoreShare"));
  assert.match(takedown, /createNotification\(/);
  assert.match(takedown, /Reason: \$\{why\}/);
  // Reports on the link are closed as actioned, and the flag names the link.
  assert.match(takedown, /status: "actioned"/);
  assert.match(takedown, /shareId: share\.id/);
});

test("an admin can paste a share URL or a bare token", () => {
  assert.equal(parseShareToken(TOKEN), TOKEN);
  assert.equal(parseShareToken(`https://juno.example.test/share/${TOKEN}`), TOKEN);
  assert.equal(parseShareToken(`https://juno.example.test/share/${TOKEN}/?utm=x`), TOKEN);
  assert.equal(parseShareToken(`juno.example.test/share/${TOKEN}`), TOKEN);
  assert.equal(parseShareToken(`  ${TOKEN}\n`), TOKEN);
  assert.equal(parseShareToken("https://juno.example.test/chat/abc"), null);
  assert.equal(parseShareToken("someone@example.test"), null);
  assert.equal(parseShareToken(""), null);
});

test("a report needs a reason; details and an address are optional", () => {
  assert.equal(shareReportSchema.safeParse({ token: TOKEN, reason: "phishing" }).success, true);
  assert.equal(shareReportSchema.safeParse({ token: TOKEN }).success, false, "no reason");
  assert.equal(shareReportSchema.safeParse({ token: TOKEN, reason: "boring" }).success, false, "unknown reason");
  assert.equal(shareReportSchema.safeParse({ token: "short", reason: "other" }).success, false, "not a token");

  const blankContact = shareReportSchema.safeParse({ token: TOKEN, reason: "other", contact: "  " });
  assert.equal(blankContact.success, true);
  assert.equal(blankContact.success && blankContact.data.contact, undefined);
  assert.equal(shareReportSchema.safeParse({ token: TOKEN, reason: "other", contact: "not an address" }).success, false);
  assert.equal(shareReportSchema.safeParse({ token: TOKEN, reason: "other", detail: "x".repeat(2001) }).success, false);

  // Every reason the form offers is one the server accepts.
  for (const { id } of SHARE_REPORT_REASONS) {
    assert.equal(shareReportSchema.safeParse({ token: TOKEN, reason: id }).success, true, id);
  }
});

test("a takedown needs a reason an admin can stand behind", () => {
  assert.equal(shareTakedownSchema.safeParse({ reason: "ok" }).success, false);
  const parsed = shareTakedownSchema.safeParse({ reason: "Phishing page imitating a bank" });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.banOwner, false, "banning is opt-in");
});

test("reports are rate-limited and keyed on the share token, not a session", () => {
  const route = readFileSync(new URL("../src/app/api/share/report/route.ts", import.meta.url), "utf8");
  assert.match(route, /rateLimit\(\{ key: `share-report:\$\{ipFromHeaders/);
  assert.match(route, /shareReportSchema\.safeParse/);
  assert.doesNotMatch(route, /getCurrentUser/);
});

test("every admin link route is behind the owner gate", () => {
  for (const file of [
    "../src/app/api/admin/shares/route.ts",
    "../src/app/api/admin/shares/[id]/takedown/route.ts",
    "../src/app/api/admin/shares/[id]/restore/route.ts",
    "../src/app/api/admin/shares/reports/route.ts",
    "../src/app/api/admin/shares/reports/[id]/route.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /const owner = await getOwnerUser\(\);\s*if \(!owner\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\);/, file);
  }
});
