import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * Re-teaching a skill that is on, against real PostgreSQL: the skill is
 * switched off BEFORE its next version is minted, so a failure between the
 * mint and the write that sets the final switch leaves it off rather than
 * running the new version under an acknowledgement given for the old one; and
 * when nothing was minted (a version conflict, a throw) the switch goes back
 * to what it was.
 *
 *   TEACH_TEST_DATABASE_URL=postgresql://juno@127.0.0.1:55471/juno_teach_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/teach-skill-reteach.integration.test.ts
 *
 * A file of its own because it replaces `mintSkillVersion` with a spy, which
 * has to happen before `teach-store` is first imported.
 */
const DB_URL = process.env.TEACH_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!DB_URL) {
  test("teach re-teach suite requires TEACH_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "teach-local-test";
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  test(
    "a skill that is on is off while its next version is minted, and back on when nothing was minted",
    { skip: !canMockModules && "needs --experimental-test-module-mocks" },
    async (t) => {
      const real = await import("@/lib/skills/store");
      type MintInput = Parameters<typeof real.mintSkillVersion>[0];
      const onDuringMint: boolean[] = [];
      let fail: "conflict" | "throw" | null = null;
      mock.module("@/lib/skills/store", {
        namedExports: {
          ...real,
          mintSkillVersion: async (input: MintInput) => {
            const head = await prisma.workSkill.findUniqueOrThrow({ where: { id: input.skill.id } });
            onDuringMint.push(head.enabled);
            if (fail === "conflict") return { ok: false, reason: "version_conflict" } as const;
            if (fail === "throw") throw new Error("storage is down");
            return real.mintSkillVersion(input);
          },
        },
      });
      const teach = await import("@/lib/skills/teach");
      const store = await import("@/lib/skills/teach-store");

      const suffix = randomUUID();
      const me = await prisma.user.create({ data: { email: `teach-reteach-${suffix}@example.invalid` } });
      t.after(async () => {
        await prisma.workAuditEvent.deleteMany({ where: { userId: me.id } });
        await prisma.user.deleteMany({ where: { id: me.id } });
        await prisma.$disconnect();
      });

      const raw = {
        name: "Weekly report",
        steps: ["Collect the numbers.", "Write the summary."],
        tools: ["web_search"],
      };
      const confirmed = (extra: Record<string, unknown> = {}) => {
        const body = { ...raw, ...extra };
        const fingerprint = teach.taughtPermissionFingerprint(teach.formFromSave(teach.taughtSkillSaveSchema.parse(body)));
        return teach.taughtSkillSaveSchema.parse({ ...body, enable: true, acknowledged: fingerprint });
      };

      const created = await store.saveTaughtSkill(me.id, confirmed());
      assert.equal(created.ok && created.skill.enabled, true);
      if (!created.ok) return;
      const skillId = created.skill.id;
      const enabled = async () => (await prisma.workSkill.findUniqueOrThrow({ where: { id: skillId } })).enabled;

      // Minted and confirmed: off while minting, on after.
      const next = await store.saveTaughtSkill(me.id, confirmed({ skillId, steps: [...raw.steps, "Send it to me."] }));
      assert.equal(next.ok && next.version, 2);
      assert.deepEqual(onDuringMint, [false], "off while the new version is written");
      assert.equal(await enabled(), true);

      // A version conflict mints nothing: refused, and the switch is restored.
      fail = "conflict";
      const conflict = await store.saveTaughtSkill(me.id, confirmed({ skillId, steps: [...raw.steps, "Again."] }));
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.error, "version_conflict");
      assert.deepEqual(onDuringMint, [false, false]);
      assert.equal(await enabled(), true, "nothing new was written, so it is on again");
      assert.equal((await prisma.workSkill.findUniqueOrThrow({ where: { id: skillId } })).currentVersion, 2);

      // A throw mints nothing either: the error surfaces, and the switch is restored.
      fail = "throw";
      await assert.rejects(store.saveTaughtSkill(me.id, confirmed({ skillId, steps: [...raw.steps, "Once more."] })), /storage is down/);
      assert.equal(await enabled(), true);

      // A skill that was off is not touched on the way in, and stays off.
      fail = null;
      await store.revokeTaughtSkill(me.id, skillId);
      const kept = await store.saveTaughtSkill(me.id, teach.taughtSkillSaveSchema.parse({ ...raw, skillId }));
      assert.equal(kept.ok && kept.skill.enabled, false);
      assert.equal(onDuringMint.at(-1), false);
      assert.equal(await enabled(), false);
    }
  );
}
