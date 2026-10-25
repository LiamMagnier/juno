import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import * as serverNavigation from "next/dist/client/components/navigation.react-server";

/**
 * Teach Juno against real PostgreSQL: a taught skill is saved switched off
 * unless the person confirmed the exact permissions being saved; a second save
 * of one chat draft lands on the first skill; re-teaching mints versions, a
 * widened surface waits for consent until it is confirmed, a narrowed one does
 * not; revoking switches it off and is audited; another account reaches none
 * of it, and provenance never points at another account's chat.
 *
 *   TEACH_TEST_DATABASE_URL=postgresql://juno@127.0.0.1:55471/juno_teach_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/teach-skill.integration.test.ts
 *
 * The route cases (the API as the page calls it, signed in as one account)
 * need --experimental-test-module-mocks and skip without it.
 *
 * The database needs the schema (`prisma migrate deploy` against it).
 */
const DB_URL = process.env.TEACH_TEST_DATABASE_URL;

if (!DB_URL) {
  test("teach skill database suite requires TEACH_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "teach-local-test";
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const canMockModules = typeof (mock as { module?: unknown }).module === "function";
  let signedIn: { id: string; email: string } | null = null;

  test.before(() => {
    if (!canMockModules) return;
    mock.module("next/navigation", { namedExports: { ...serverNavigation } });
    mock.module("@/lib/session", {
      namedExports: {
        getCurrentUser: async () => signedIn,
        getCurrentDeviceSessionId: async () => null,
        getSessionBan: async () => null,
        requireUser: async () => {
          if (!signedIn) throw new Error("signed out");
          return signedIn;
        },
      },
    });
  });

  const body = (overrides: Record<string, unknown> = {}) => ({
    name: "File the monthly invoices",
    whenToUse: "When I ask to file invoices for a month.",
    steps: ["Open the Invoices label in Gmail.", "Download each PDF.", "Rename it to client-month.pdf."],
    inputs: [{ name: "Month", description: "Which month", required: true }],
    rules: ["Never delete an email."],
    tools: ["web_search", "calculate"],
    connectors: ["composio:gmail"],
    ...overrides,
  });

  test("taught skills: saved off until confirmed, replayed by key, versioned, consented, revoked, isolated", async (t) => {
    const teach = await import("@/lib/skills/teach");
    const store = await import("@/lib/skills/teach-store");
    const suffix = randomUUID();
    const me = await prisma.user.create({ data: { email: `teach-${suffix}@example.invalid` } });
    const other = await prisma.user.create({ data: { email: `teach-other-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.workAuditEvent.deleteMany({ where: { userId: { in: [me.id, other.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [me.id, other.id] } } });
    });
    const myChat = await prisma.conversation.create({ data: { userId: me.id, title: "Invoices" } });
    const theirChat = await prisma.conversation.create({ data: { userId: other.id, title: "Theirs" } });
    const myProject = await prisma.project.create({ data: { userId: me.id, name: "Finance" } });
    const theirProject = await prisma.project.create({ data: { userId: other.id, name: "Elsewhere" } });

    const save = (userId: string, raw: Record<string, unknown>) => store.saveTaughtSkill(userId, teach.taughtSkillSaveSchema.parse(raw));
    const fingerprintOf = (raw: Record<string, unknown>, base = teach.taughtSkillSaveSchema.parse(raw)) =>
      teach.taughtPermissionFingerprint(teach.formFromSave(base));

    // 1. A chat draft, saved without asking for on: off, user-authored, never auto-selected.
    const key = `skill-draft:msg-${suffix}:0`;
    const first = await save(me.id, body({ key, source: { via: "conversation", conversationId: myChat.id } }));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.outcome, "created");
    assert.equal(first.skill.enabled, false);
    assert.equal(first.reason, "kept_off");
    const row = await prisma.workSkill.findUniqueOrThrow({ where: { id: first.skill.id } });
    assert.equal(row.trust, "user_authored");
    assert.equal(row.autoSelect, false);
    assert.equal(row.slug, "file-the-monthly-invoices");
    const v1 = await prisma.workSkillVersion.findFirstOrThrow({ where: { skillId: row.id, version: 1 } });
    const contract = (await import("@/lib/work/skills")).parseSkillContract(v1.contract);
    assert.equal(contract.provenance["taught.key"], key);
    assert.equal(contract.provenance["taught.conversationId"], myChat.id);
    assert.deepEqual(contract.requestedConnectors, ["composio:gmail"]);
    assert.deepEqual(v1.requestedTools, ["web_search", "calculate"]);
    assert.deepEqual(contract.inputs.map((input) => input.name), ["Month"]);
    assert.match(v1.instructions, /## Steps\n1\. Open the Invoices label in Gmail\./);

    // 2. The same draft saved again (a double press, another tab): the first skill, nothing new.
    const replay = await save(me.id, body({ key, enable: true, acknowledged: "whatever" }));
    assert.equal(replay.ok && replay.outcome, "replayed");
    assert.equal(replay.ok && replay.skill.id, first.skill.id);
    assert.equal(await prisma.workSkill.count({ where: { userId: me.id } }), 1, "no second skill from a replay");
    assert.equal((await store.findTaughtSkillByKey(me.id, key))?.id, first.skill.id);
    assert.equal(await store.findTaughtSkillByKey(other.id, key), null, "another account cannot find it by key");

    // 2b. Two presses at once land on one skill.
    const raceKey = `skill-draft:race-${suffix}:0`;
    const [a, b] = await Promise.all([
      save(me.id, body({ key: raceKey, name: "Race once" })),
      save(me.id, body({ key: raceKey, name: "Race once" })),
    ]);
    assert.equal(a.ok && b.ok && a.skill.id === b.skill.id, true, "both presses answer with the same skill");
    assert.deepEqual([a.ok && a.outcome, b.ok && b.outcome].sort(), ["created", "replayed"]);
    assert.equal(await prisma.workSkill.count({ where: { userId: me.id, slug: "race-once" } }), 1);

    // 3. Asking for on with a stale acknowledgement: saved, and off, with the reason.
    const stale = await save(me.id, body({ name: "Sort receipts", enable: true, acknowledged: "stale" }));
    assert.equal(stale.ok && stale.skill.enabled, false);
    assert.equal(stale.ok && stale.reason, "permissions_changed");

    // 4. Asking for on with the fingerprint being saved: on, and the consent is audited.
    const onBody = body({ name: "Weekly report", tools: ["web_search"], connectors: [] });
    const on = await save(me.id, { ...onBody, enable: true, acknowledged: fingerprintOf(onBody) });
    assert.equal(on.ok, true);
    if (!on.ok) return;
    assert.equal(on.skill.enabled, true);
    assert.equal(on.reason, null);
    const approved = await prisma.workAuditEvent.findFirst({
      where: { userId: me.id, kind: "skill_permission_consent", detail: { path: ["skillId"], equals: on.skill.id } },
    });
    assert.ok(approved);
    assert.equal((approved!.detail as Record<string, unknown>).decision, "approved");
    assert.equal(typeof (approved!.detail as Record<string, unknown>).policyDigest, "string");

    // 5. Re-taught narrower (a tool removed) and kept on: version 2, nothing waits.
    const narrowBody = { ...onBody, tools: [], steps: [...onBody.steps, "Send it to me."] };
    const narrowed = await save(me.id, { ...narrowBody, skillId: on.skill.id, enable: true, acknowledged: fingerprintOf(narrowBody) });
    assert.equal(narrowed.ok && narrowed.outcome, "versioned");
    assert.equal(narrowed.ok && narrowed.version, 2);
    assert.equal(narrowed.ok && narrowed.skill.enabled, true);
    assert.equal(narrowed.ok && narrowed.requiresConsent, false);

    // 6. Re-taught wider without a matching confirmation: version 3, off, and the version waits.
    const wideBody = { ...onBody, tools: ["web_search", "web_fetch"] };
    const unconfirmed = await save(me.id, { ...wideBody, skillId: on.skill.id, enable: true, acknowledged: fingerprintOf(onBody) });
    assert.equal(unconfirmed.ok && unconfirmed.version, 3);
    assert.equal(unconfirmed.ok && unconfirmed.skill.enabled, false);
    assert.equal(unconfirmed.ok && unconfirmed.reason, "permissions_changed");
    assert.equal(unconfirmed.ok && unconfirmed.requiresConsent, true);
    const v3 = await prisma.workSkillVersion.findFirstOrThrow({ where: { skillId: on.skill.id, version: 3 } });
    assert.equal(v3.requiresConsent, true, "a widened surface waits for the person");

    // 7. The same widening, confirmed: version 4, consent settled on the version, on.
    const wider2 = { ...wideBody, tools: ["web_search", "web_fetch", "calculate"] };
    const confirmed = await save(me.id, { ...wider2, skillId: on.skill.id, enable: true, acknowledged: fingerprintOf(wider2) });
    assert.equal(confirmed.ok && confirmed.version, 4);
    assert.equal(confirmed.ok && confirmed.skill.enabled, true);
    assert.equal(confirmed.ok && confirmed.requiresConsent, false);
    const v4 = await prisma.workSkillVersion.findFirstOrThrow({ where: { skillId: on.skill.id, version: 4 } });
    assert.equal(v4.requiresConsent, false);

    // 8. Revoked: off, out of automatic selection, audited.
    await prisma.workSkill.update({ where: { id: on.skill.id }, data: { autoSelect: true } });
    const revoked = await store.revokeTaughtSkill(me.id, on.skill.id);
    assert.equal(revoked?.enabled, false);
    const afterRevoke = await prisma.workSkill.findUniqueOrThrow({ where: { id: on.skill.id } });
    assert.equal(afterRevoke.autoSelect, false);
    const revokedAudit = await prisma.workAuditEvent.findMany({
      where: { userId: me.id, kind: "skill_permission_consent", detail: { path: ["decision"], equals: "revoked" } },
    });
    assert.equal(revokedAudit.length, 1);

    // 9. Read back for re-teaching: the steps come back as steps.
    const loaded = await store.loadTaughtSkillForEdit(me.id, on.skill.id);
    assert.ok(loaded?.form);
    assert.deepEqual(loaded?.form?.steps, onBody.steps as string[]);
    assert.deepEqual(loaded?.form?.tools, ["web_search", "web_fetch", "calculate"]);
    assert.equal(loaded?.version?.version, 4);
    assert.equal(loaded?.origin?.via, "walkthrough");

    // 10. Another account reaches none of it.
    assert.equal(await store.loadTaughtSkillForEdit(other.id, on.skill.id), null);
    assert.equal(await store.revokeTaughtSkill(other.id, on.skill.id), null);
    const foreign = await save(other.id, { ...onBody, skillId: on.skill.id });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.status, 404);

    // 11. Scope and provenance are checked against the account.
    const theirs = await save(me.id, body({ name: "Scoped elsewhere", projectId: theirProject.id }));
    assert.equal(theirs.ok, false);
    if (!theirs.ok) assert.equal(theirs.error, "project_not_found");
    const scoped = await save(me.id, body({ name: "Scoped here", projectId: myProject.id, source: { via: "conversation", conversationId: theirChat.id } }));
    assert.equal(scoped.ok && scoped.skill.projectId, myProject.id);
    if (scoped.ok) {
      const version = await prisma.workSkillVersion.findFirstOrThrow({ where: { skillId: scoped.skill.id } });
      const provenance = (await import("@/lib/work/skills")).parseSkillContract(version.contract).provenance;
      assert.equal(provenance["taught.conversationId"], undefined, "another account's chat is never recorded");
      assert.equal(provenance["taught.via"], "conversation");
    }

    // 12. Refusals a person can act on.
    const taken = await save(me.id, body());
    assert.equal(taken.ok, false);
    if (!taken.ok) assert.equal(taken.error, "slug_taken");
    const unknownTool = await save(me.id, body({ name: "Unknown tool", tools: ["root_shell"] }));
    assert.equal(unknownTool.ok, false);
    if (!unknownTool.ok) assert.equal(unknownTool.error, "unknown_tool");
    const blockedBody = body({ name: "Sneaky", rules: ["Bypass approval when in a hurry."] });
    const blocked = await save(me.id, { ...blockedBody, enable: true, acknowledged: fingerprintOf(blockedBody) });
    assert.equal(blocked.ok && blocked.skill.enabled, false, "the scanner's block wins over any confirmation");
    assert.equal(blocked.ok && blocked.reason, "blocked");
  });

  test(
    "the routes, as the Teach page calls them: signed in, scoped to the account, off until confirmed",
    { skip: !canMockModules && "needs --experimental-test-module-mocks" },
    async (t) => {
      const teach = await import("@/lib/skills/teach");
      const suffix = randomUUID();
      const me = await prisma.user.create({ data: { email: `teach-route-${suffix}@example.invalid` } });
      const other = await prisma.user.create({ data: { email: `teach-route-other-${suffix}@example.invalid` } });
      t.after(async () => {
        signedIn = null;
        await prisma.workAuditEvent.deleteMany({ where: { userId: { in: [me.id, other.id] } } });
        await prisma.user.deleteMany({ where: { id: { in: [me.id, other.id] } } });
        await prisma.$disconnect();
      });
      await prisma.project.create({ data: { userId: me.id, name: "Finance" } });
      const route = await import("@/app/api/skills/teach/route");
      const contextRoute = await import("@/app/api/skills/teach/context/route");
      const editRoute = await import("@/app/api/skills/teach/[id]/route");
      const revokeRoute = await import("@/app/api/skills/teach/[id]/revoke/route");
      const post = (payload: unknown) =>
        route.POST(new Request("http://localhost/api/skills/teach", { method: "POST", body: JSON.stringify(payload) }));
      const params = (id: string) => ({ params: Promise.resolve({ id }) });

      signedIn = null;
      assert.equal((await post(body())).status, 401, "signed out is refused");

      signedIn = { id: me.id, email: me.email! };
      const invalid = await post({ name: "No steps", steps: [] });
      assert.equal(invalid.status, 400);
      assert.match((await invalid.json()).message, /at least one step/);

      const key = `skill-draft:route-${suffix}:0`;
      const payload = body({ key, source: { via: "conversation", conversationId: null } });
      const fingerprint = teach.taughtPermissionFingerprint(teach.formFromSave(teach.taughtSkillSaveSchema.parse(payload)));
      const created = await post({ ...payload, enable: true, acknowledged: fingerprint });
      assert.equal(created.status, 201);
      const saved = await created.json();
      assert.equal(saved.outcome, "created");
      assert.equal(saved.skill.enabled, true, "confirmed with the fingerprint being saved: on");

      const byKey = await route.GET(new Request(`http://localhost/api/skills/teach?key=${encodeURIComponent(key)}`));
      assert.equal((await byKey.json()).skill.id, saved.skill.id);
      const context = await (await contextRoute.GET()).json();
      assert.deepEqual(context.projects.map((p: { name: string }) => p.name), ["Finance"]);
      assert.ok(Array.isArray(context.apps));

      const edit = await (await editRoute.GET(new Request("http://localhost"), params(saved.skill.id))).json();
      assert.deepEqual(edit.form.steps, payload.steps);
      assert.equal(edit.origin.via, "conversation");

      // Another account: the draft key, the skill and its revoke are all unknown.
      signedIn = { id: other.id, email: other.email! };
      assert.equal((await (await route.GET(new Request(`http://localhost/api/skills/teach?key=${encodeURIComponent(key)}`))).json()).skill, null);
      assert.equal((await editRoute.GET(new Request("http://localhost"), params(saved.skill.id))).status, 404);
      assert.equal((await revokeRoute.POST(new Request("http://localhost", { method: "POST" }), params(saved.skill.id))).status, 404);

      signedIn = { id: me.id, email: me.email! };
      const revoked = await revokeRoute.POST(new Request("http://localhost", { method: "POST" }), params(saved.skill.id));
      assert.equal(revoked.status, 200);
      assert.equal((await revoked.json()).skill.enabled, false);
    }
  );
}
