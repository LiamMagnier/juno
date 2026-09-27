# Pending migration: UserMcpServer

Adds the `UserMcpServer` table for custom remote MCP servers (URL + optional
Authorization header) that users register themselves.

## Why pending

Do NOT run this against prod from a developer machine. Generate and apply with
the project's usual flow once reviewed:

```bash
npx prisma migrate dev --name user_mcp_server   # local
npx prisma migrate deploy                      # prod, from the deploy path
```

`npx prisma migrate dev` will diff `schema.prisma` and emit the SQL. Until the
migration exists, `npx prisma generate` is enough for typecheck and local `db push`.

## Shape

- Table `UserMcpServer`
- Columns: `id`, `userId`, `name`, `url`, `authHeader` (nullable, encrypted at
  rest in app code), `enabled`, `status`, `lastCheckedAt`, `toolCount`, `tools`
  (text[]), `accountLabel`, `createdAt`, `updatedAt`
- Unique `(userId, name)`
- Index `(userId, enabled)`
- FK `userId` → `User.id` ON DELETE CASCADE

`tools` is slightly beyond the original field list; it stores the tool names
from the last successful test so pickers and the directory can show them
without opening a connection on every request. `toolCount` stays denormalized
for the list view.
