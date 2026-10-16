import "server-only";
import { Prisma, type CustomConnector } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** OAuth and header servers share UserMcpServer. Connection still owns tokens.
 * Legacy custom IDs stay unchanged so saved chats, blocklists and receipts keep
 * their identity. The old CustomConnector table is a migration snapshot only. */
type Where = { userId: string; id?: string | { in: string[] }; url?: string };
type Find = { where: Where; orderBy?: { createdAt: "asc" | "desc" }; select?: Record<string, boolean> };
type Patch = Partial<Pick<CustomConnector, "name" | "description" | "serverName" | "disabledTools" | "toolsCheckedAt">> & { tools?: object };
const columns = Prisma.sql`"id", "userId", "name", "url", "description", "serverName", "disabledTools", "toolCatalog" AS "tools", "toolsCheckedAt", "createdAt", "updatedAt"`;
function scoped(where: Where) {
  if (!where.userId) throw new Error("An MCP config query needs its owner");
  const filters = [Prisma.sql`"userId"=${where.userId}`, Prisma.sql`"authMode"='oauth'`];
  if (typeof where.id === "string") filters.push(Prisma.sql`"id"=${where.id}`);
  else if (where.id) filters.push(Prisma.sql`"id"=ANY(${where.id.in}::text[])`);
  if (where.url !== undefined) filters.push(Prisma.sql`"url"=${where.url}`);
  return Prisma.join(filters, " AND ");
}
async function findMany(input: Find): Promise<CustomConnector[]> {
  return prisma.$queryRaw<CustomConnector[]>(Prisma.sql`SELECT ${columns} FROM "UserMcpServer" WHERE ${scoped(input.where)} ORDER BY "createdAt" ${input.orderBy?.createdAt === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`}`);
}
async function findFirst(input: Find) { return (await findMany(input))[0] ?? null; }
async function findFirstOrThrow(input: Find) {
  const row = await findFirst(input);
  if (!row) throw new Error("MCP server not found");
  return row;
}
async function create(input: { data: { id: string; userId: string; name: string; url: string } }): Promise<CustomConnector> {
  const { id, userId, name, url } = input.data;
  if (!userId || !/^mcp:[a-z0-9]{10}$/.test(id)) throw new Error("Invalid MCP config identity");
  return prisma.$transaction(async (tx) => {
    // One per-owner lock also serializes the duplicate-name decision with
    // creates through this OAuth path. A conflicting header create still hits
    // the table's unique constraint rather than overwriting either server.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-config:${userId}`},0))::text`;
    const existing = await tx.$queryRaw<CustomConnector[]>(Prisma.sql`SELECT ${columns} FROM "UserMcpServer" WHERE ${scoped({ userId, url })}`);
    if (existing[0]) return existing[0];
    const duplicate = await tx.userMcpServer.findUnique({ where: { userId_name: { userId, name } }, select: { id: true } });
    const label = duplicate ? `${name} (${id})` : name;
    const rows = await tx.$queryRaw<CustomConnector[]>(Prisma.sql`INSERT INTO "UserMcpServer" ("id","userId","name","url","authMode","enabled","status","tools","disabledTools","createdAt","updatedAt") VALUES (${id},${userId},${label},${url},'oauth',true,'untested',ARRAY[]::text[],ARRAY[]::text[],now(),now()) RETURNING ${columns}`);
    return rows[0];
  });
}
async function update(input: { where: Where & { id: string }; data: Patch }): Promise<CustomConnector> {
  const parts: Prisma.Sql[] = [Prisma.sql`"updatedAt"=now()`];
  const d = input.data;
  if (d.name !== undefined) parts.push(Prisma.sql`"name"=${d.name}`);
  if (d.description !== undefined) parts.push(Prisma.sql`"description"=${d.description}`);
  if (d.serverName !== undefined) parts.push(Prisma.sql`"serverName"=${d.serverName}`);
  if (d.disabledTools !== undefined) parts.push(Prisma.sql`"disabledTools"=${d.disabledTools}::text[]`);
  if (d.toolsCheckedAt !== undefined) parts.push(Prisma.sql`"toolsCheckedAt"=${d.toolsCheckedAt}`);
  if (d.tools !== undefined) parts.push(Prisma.sql`"toolCatalog"=${JSON.stringify(d.tools)}::jsonb`);
  const rows = await prisma.$queryRaw<CustomConnector[]>(Prisma.sql`UPDATE "UserMcpServer" SET ${Prisma.join(parts, ", ")} WHERE ${scoped(input.where)} RETURNING ${columns}`);
  if (!rows[0]) throw new Error("MCP server not found");
  return rows[0];
}
async function remove(input: { where: Where & { id: string } }) {
  return prisma.$transaction(async (tx) => {
    // Delete config and OAuth token together, scoped to the same owner.
    const deleted = await tx.$executeRaw(Prisma.sql`DELETE FROM "UserMcpServer" WHERE ${scoped(input.where)}`);
    if (deleted !== 1) throw new Error("MCP server not found");
    await tx.connection.deleteMany({ where: { userId: input.where.userId, provider: input.where.id } });
    // A migration snapshot must not retain a server the person removed.
    await tx.customConnector.deleteMany({ where: { userId: input.where.userId, id: input.where.id } });
  });
}
export const oauthMcpConfigs = { findMany, findFirst, findFirstOrThrow, create, update, delete: remove, count: async (input: { where: Where }) => {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) FROM "UserMcpServer" WHERE ${scoped(input.where)}`);
  return Number(rows[0].count);
} };
