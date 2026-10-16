/** Opt in with MCP_CONFIG_TEST_DATABASE_URL on a migrated disposable database. */
import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const url = process.env.MCP_CONFIG_TEST_DATABASE_URL;
test("MCP config unification: migration, identity, ownership, token custody and removal", { skip: !url }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
  assert.match(target.pathname, /^\/juno_codex_.*_test$/);
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET = "mcp-config-test-only-key";
  const modules = Module as unknown as { _load: (name: string, parent: unknown, main: boolean) => unknown };
  const original = modules._load;
  const owner = `mcp_test_${randomUUID()}`, other = `mcp_test_${randomUUID()}`;
  modules._load = function (name, parent, main) {
    if (name === "server-only") return {};
    if (name === "@/lib/session") return { getCurrentUser: async () => ({ id: owner }) };
    return original.call(this, name, parent, main);
  };
  const req = createRequire(import.meta.url);
  const { prisma } = req("../src/lib/prisma") as typeof import("@/lib/prisma");
  const { oauthMcpConfigs } = req("../src/lib/mcp-config-store") as typeof import("@/lib/mcp-config-store");
  const { encryptSecret } = req("../src/lib/crypto") as typeof import("@/lib/crypto");
  const { getActiveConnectors } = req("../src/lib/mcp") as typeof import("@/lib/mcp");
  const { GET: listDirectory } = req("../src/app/api/connectors/route") as typeof import("@/app/api/connectors/route");
  const { GET: listHeaderServers } = req("../src/app/api/mcp/servers/route") as typeof import("@/app/api/mcp/servers/route");
  modules._load = original;
  await prisma.user.createMany({ data: [{ id: owner, email: `${owner}@example.invalid` }, { id: other, email: `${other}@example.invalid` }] });
  t.after(async () => { await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } }); await prisma.$disconnect(); });

  await t.test("upgrade preserves colliding names, old IDs, tool blocks and header ciphertext", async () => {
    const schema = `codex_mcp_${randomUUID().replace(/-/g, "")}`;
    const migration = readdirSync("prisma/migrations").find((p) => p.endsWith("_unify_mcp_configs"))!;
    const sql = readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe(`CREATE TABLE "UserMcpServer" ("id" TEXT PRIMARY KEY,"userId" TEXT NOT NULL,"name" TEXT NOT NULL,"url" TEXT NOT NULL,"authHeader" TEXT,"enabled" BOOLEAN DEFAULT true,"status" TEXT DEFAULT 'untested',"toolCount" INTEGER DEFAULT 0,"tools" TEXT[] DEFAULT ARRAY[]::TEXT[],"createdAt" TIMESTAMP DEFAULT now(),"updatedAt" TIMESTAMP DEFAULT now(), UNIQUE("userId","name"))`);
      await tx.$executeRawUnsafe(`CREATE TABLE "CustomConnector" ("id" TEXT PRIMARY KEY,"userId" TEXT NOT NULL,"name" TEXT NOT NULL,"url" TEXT NOT NULL,"description" TEXT,"serverName" TEXT,"disabledTools" TEXT[] DEFAULT ARRAY[]::TEXT[],"tools" JSONB,"toolsCheckedAt" TIMESTAMP,"createdAt" TIMESTAMP DEFAULT now(),"updatedAt" TIMESTAMP DEFAULT now())`);
      await tx.$executeRaw`INSERT INTO "UserMcpServer" ("id","userId","name","url","authHeader") VALUES ('header','owner','Same name','https://header.example/mcp','sealed-header-fixture')`;
      await tx.$executeRaw`INSERT INTO "CustomConnector" ("id","userId","name","url","disabledTools","tools") VALUES ('mcp:1111111111','owner','Same name','https://oauth1.example/mcp',ARRAY['send'], '[{"name":"send"}]'::jsonb), ('mcp:2222222222','owner','Same name','https://oauth2.example/mcp',ARRAY[]::text[],NULL)`;
      // PostgreSQL prepared statements admit one command. Keep the DO block
      // intact while executing the additive ALTER and index separately.
      const start = sql.indexOf("DO $$"), end = sql.indexOf("END $$;") + "END $$;".length;
      await tx.$executeRawUnsafe(sql.slice(0, start));
      await tx.$executeRawUnsafe(sql.slice(start, end));
      await tx.$executeRawUnsafe(sql.slice(end));
      const rows = await tx.$queryRaw<Array<{ id: string; name: string; authHeader: string | null; authMode: string; disabledTools: string[] }>>`SELECT "id","name","authHeader","authMode","disabledTools" FROM "UserMcpServer" ORDER BY "id"`;
      assert.equal(rows.length, 3);
      assert.equal(new Set(rows.map((r) => r.name)).size, 3);
      assert.equal(rows[0].authHeader, "sealed-header-fixture");
      assert.equal(rows[0].authMode, "header");
      assert.equal(rows[1].id, "mcp:1111111111");
      assert.deepEqual(rows[1].disabledTools, ["send"]);
      await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }, { timeout: 20_000 });
  });

  const staticServer = await prisma.userMcpServer.create({ data: { userId: owner, name: "Static server", url: "https://header.example/mcp", authHeader: encryptSecret("Bearer private-header") } });
  const oauth = await oauthMcpConfigs.create({ data: { userId: owner, id: "mcp:3333333333", name: "OAuth server", url: "https://oauth.example/mcp" } });
  await prisma.connection.create({ data: { userId: owner, provider: oauth.id, accessToken: encryptSecret("private-oauth-token") } });
  await t.test("new OAuth configurations live in the same table as header configurations", async () => {
    assert.equal(await prisma.userMcpServer.count({ where: { userId: owner } }), 2);
    assert.equal(await prisma.customConnector.count({ where: { userId: owner } }), 0);
    assert.equal((await oauthMcpConfigs.findMany({ where: { userId: owner } })).length, 1);
    assert.equal((await oauthMcpConfigs.findMany({ where: { userId: other } })).length, 0);
    await assert.rejects(oauthMcpConfigs.update({ where: { userId: other, id: oauth.id }, data: { name: "hijacked" } }), /not found/);
  });
  await t.test("concurrent adds of the same OAuth URL keep one identity", async () => {
    const results = await Promise.all(["mcp:4444444444", "mcp:5555555555"].map((id) => oauthMcpConfigs.create({ data: { userId: owner, id, name: "Duplicate", url: oauth.url } })));
    assert.deepEqual(results.map((r) => r.id), [oauth.id, oauth.id]);
    assert.equal(await oauthMcpConfigs.count({ where: { userId: owner } }), 1);
  });
  await t.test("directory lists each config once and never returns its credentials", async () => {
    const response = await listDirectory();
    const body = await response.json();
    assert.equal(body.connectors.filter((c: { id: string }) => [oauth.id, `user_mcp:${staticServer.id}`].includes(c.id)).length, 2);
    const headers = await (await listHeaderServers()).json();
    assert.equal(headers.servers.length, 1);
    assert.equal(headers.servers[0].id, staticServer.id);
    assert.doesNotMatch(JSON.stringify(body), /private-header|private-oauth-token/);
    assert.doesNotMatch(JSON.stringify(headers), /private-header|private-oauth-token/);
  });
  await t.test("runtime preserves connector IDs, OAuth custody and disabled tools", async () => {
    await oauthMcpConfigs.update({ where: { userId: owner, id: oauth.id }, data: { disabledTools: ["send"], tools: [{ name: "send" }] } });
    const active = await getActiveConnectors(owner, [oauth.id, `user_mcp:${staticServer.id}`, `user_mcp:${oauth.id}`]);
    assert.equal(active.length, 2);
    const linked = active.find((c) => c.id === oauth.id)!;
    assert.equal(linked.headers.Authorization, "Bearer private-oauth-token");
    assert.deepEqual(linked.custom?.disabledTools, ["send"]);
    assert.equal(active.find((c) => c.id === `user_mcp:${staticServer.id}`)?.headers.Authorization, "Bearer private-header");
    assert.equal((await getActiveConnectors(other, [oauth.id, `user_mcp:${staticServer.id}`])).length, 0);
  });
  await t.test("removing a migrated config deletes the canonical row, old snapshot and OAuth token", async () => {
    await prisma.customConnector.create({ data: { userId: owner, id: oauth.id, name: "old snapshot", url: oauth.url } });
    await oauthMcpConfigs.delete({ where: { userId: owner, id: oauth.id } });
    assert.equal(await prisma.userMcpServer.count({ where: { userId: owner } }), 1);
    assert.equal(await prisma.customConnector.count({ where: { userId: owner } }), 0);
    assert.equal(await prisma.connection.count({ where: { userId: owner, provider: oauth.id } }), 0);
  });
});
